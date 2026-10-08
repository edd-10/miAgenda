// Lógica de recordatorios. El cron de Cloudflare no corre al segundo :00 (en este proyecto corre al :51), así que en
// vez de enviar lo que "ya venció" se atiende lo que vence en los próximos LOOKAHEAD_MS: se reserva cada tarea, se
// espera hasta un instante antes de su hora exacta y entonces se envía.

import { getAccessToken as defaultGetAccessToken } from "./google-auth.mjs";

export const CONFIG = {
  WINDOW_MS: 24 * 60 * 60 * 1000, // recordatorios atrasados hasta 1 día se siguen enviando
  LOOKAHEAD_MS: 75_000,           // se atiende lo que vence antes de la siguiente ejecución (60 s + margen por desfases)
  LEAD_MS: 1200,                  // se envía esto antes de la hora exacta: FCM tarda ~1 s en llegar al dispositivo
  RECHECK_MS: 800,                // se vuelve a leer la tarea esto antes del envío (por si se borró o cambió)
  BATCH_LIMIT: 12,                // máx. de pendientes por ejecución (el plan gratuito de Workers limita las subpeticiones)
};

const fsBase = (pid) => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
const str = (f) => f?.stringValue;
const int = (f) => (f?.integerValue !== undefined ? Number(f.integerValue) : f?.doubleValue);
const idOf = (doc) => doc.name.split("/").pop();

function makeCtx(env, deps) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  return {
    sa,
    pid: sa.project_id,
    token: null,
    fetch: deps.fetch || ((...a) => globalThis.fetch(...a)),
    now: deps.now || (() => Date.now()),
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    log: deps.log || console.log,
    getAccessToken: deps.getAccessToken || defaultGetAccessToken,
    config: { ...CONFIG, ...deps.config },
  };
}

const headers = (c, extra = {}) => ({ authorization: `Bearer ${c.token}`, ...extra });
const sleepUntil = async (c, at) => { const ms = at - c.now(); if (ms > 0) await c.sleep(ms); };

/* ---------- Firestore (REST) ---------- */
async function runQuery(c, structuredQuery) {
  const res = await c.fetch(`${fsBase(c.pid)}:runQuery`, {
    method: "POST",
    headers: headers(c, { "content-type": "application/json" }),
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error("runQuery: " + res.status + " " + (await res.text()));
  return (await res.json()).filter((r) => r.document).map((r) => r.document);
}

const patchNotified = (c, id, value, updateTime) =>
  c.fetch(`${fsBase(c.pid)}/tasks/${id}?updateMask.fieldPaths=notified&currentDocument.updateTime=${encodeURIComponent(updateTime)}`, {
    method: "PATCH",
    headers: headers(c, { "content-type": "application/json" }),
    body: JSON.stringify({ fields: { notified: { booleanValue: value } } }),
  });

// Reserva la tarea marcándola como avisada con la condición de que no haya cambiado desde que se leyó: si dos
// ejecuciones coinciden, solo una lo consigue. Devuelve el updateTime nuevo, o null si no se pudo.
async function claimTask(c, doc) {
  const res = await patchNotified(c, idOf(doc), true, doc.updateTime);
  if (res.ok) return (await res.json()).updateTime;
  if (![400, 404, 409].includes(res.status)) c.log("No se pudo reservar el aviso:", res.status, await res.text());
  return null; // otra ejecución la tomó, el usuario la editó o la borró
}

// Devuelve el aviso a "pendiente" (solo si la tarea sigue como la dejamos).
async function releaseTask(c, id, updateTime) {
  const res = await patchNotified(c, id, false, updateTime);
  if (!res.ok && ![400, 404, 409].includes(res.status)) c.log("No se pudo liberar el aviso:", res.status, await res.text());
}

// null = la tarea ya no existe; undefined = no se pudo leer (se sigue con lo que ya se tenía).
async function readTask(c, id) {
  const res = await c.fetch(`${fsBase(c.pid)}/tasks/${id}`, { headers: headers(c) });
  if (res.status === 404) return null;
  if (!res.ok) return undefined;
  return res.json();
}

/* ---------- Envío (FCM) ---------- */
// Devuelve "ok", "gone" (token inválido, ya borrado), "retry" (fallo temporal) o "failed" (permanente).
async function sendToDevice(c, deviceToken, task) {
  const res = await c.fetch(`https://fcm.googleapis.com/v1/projects/${c.pid}/messages:send`, {
    method: "POST",
    headers: headers(c, { "content-type": "application/json" }),
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: {
          title: `⏰ ${task.title}`,
          body: task.remindMin > 0 ? `Es a las ${task.time}` : `Ahora · ${task.time}`,
        },
        webpush: { fcm_options: { link: `https://${c.pid}.web.app/` }, headers: { Urgency: "high" } },
      },
    }),
  });
  if (res.ok) return "ok";

  const errText = await res.text();
  if (res.status === 404 || errText.includes("UNREGISTERED")) {
    // El dispositivo ya no existe: limpiamos su token.
    await c.fetch(`${fsBase(c.pid)}/tokens/${encodeURIComponent(deviceToken)}`, { method: "DELETE", headers: headers(c) });
    return "gone";
  }
  c.log("FCM error:", res.status, errText);
  // 5xx/429 son temporales; 401/403 son de configuración/credenciales (nada se entregó): se reintenta.
  return res.status >= 500 || [401, 403, 429].includes(res.status) ? "retry" : "failed";
}

/* ---------- Una tarea ---------- */
// Resultados: "sent" | "no-devices" | "dropped" | "retry" | "skipped" | "deleted" | "done" | "rescheduled"
async function processTask(c, doc, tokensFor) {
  const { LEAD_MS, RECHECK_MS } = c.config;
  const id = idOf(doc);
  const dueAt = int(doc.fields.remindAt);

  const claimedAt = await claimTask(c, doc);
  if (!claimedAt) return "skipped";

  // Mientras se espera, ya se van consultando los tokens del usuario.
  const tokensPromise = tokensFor(str(doc.fields.uid));
  tokensPromise.catch(() => {});

  await sleepUntil(c, dueAt - LEAD_MS - RECHECK_MS);

  // Última comprobación: durante la espera pudo borrarse, completarse o reprogramarse.
  const fresh = await readTask(c, id);
  if (fresh === null) return "deleted";
  let current = doc, updateTime = claimedAt;
  if (fresh) {
    if (fresh.fields.done?.booleanValue === true) return "done";
    if (int(fresh.fields.remindAt) !== dueAt) {
      await releaseTask(c, id, fresh.updateTime);   // que el nuevo horario se atienda en su momento
      return "rescheduled";
    }
    current = fresh; updateTime = fresh.updateTime;
  }
  const f = current.fields;
  const info = { title: str(f.title) || "Pendiente", time: str(f.time) || "", remindMin: int(f.remindMin) || 0 };
  const deviceTokens = await tokensPromise;

  await sleepUntil(c, dueAt - LEAD_MS);
  const sentAt = c.now();
  const results = await Promise.all(deviceTokens.map((t) => sendToDevice(c, t, info)));
  const delivered = results.includes("ok");

  // Fallo temporal sin entregar nada: se libera para que la siguiente ejecución lo reintente.
  if (!delivered && results.includes("retry")) { await releaseTask(c, id, updateTime); return "retry"; }
  c.log(`Aviso ${id}: enviado ${sentAt - dueAt} ms respecto a la hora (dispositivos: ${deviceTokens.length}, entregados: ${results.filter((r) => r === "ok").length})`);
  if (delivered) return "sent";
  if (results.includes("failed")) { c.log("Recordatorio descartado por error permanente de FCM:", id); return "dropped"; }
  return "no-devices";
}

/* ---------- Ejecución completa ---------- */
export async function processReminders(env, deps = {}) {
  const c = makeCtx(env, deps);
  c.token = await c.getAccessToken(c.sa, { fetch: c.fetch, now: c.now });
  const now = c.now();

  // Requiere el índice compuesto (notified, done, remindAt) de firestore.indexes.json.
  const pending = await runQuery(c, {
    from: [{ collectionId: "tasks" }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          { fieldFilter: { field: { fieldPath: "notified" }, op: "EQUAL", value: { booleanValue: false } } },
          { fieldFilter: { field: { fieldPath: "done" }, op: "EQUAL", value: { booleanValue: false } } },
          { fieldFilter: { field: { fieldPath: "remindAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now + c.config.LOOKAHEAD_MS) } } },
          { fieldFilter: { field: { fieldPath: "remindAt" }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: String(now - c.config.WINDOW_MS) } } },
        ],
      },
    },
    orderBy: [{ field: { fieldPath: "remindAt" }, direction: "ASCENDING" }],
    limit: c.config.BATCH_LIMIT,
  });
  c.log(`Pendientes por avisar: ${pending.length}`);

  // Una sola consulta de tokens por usuario en cada ejecución.
  const tokenCache = new Map();
  const tokensFor = (uid) => {
    if (!tokenCache.has(uid)) {
      tokenCache.set(uid, runQuery(c, {
        from: [{ collectionId: "tokens" }],
        where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
      }).then((docs) => docs.map(idOf)));
    }
    return tokenCache.get(uid);
  };

  // Todas a la vez: cada una espera su propia hora, así que no pueden ir por turnos.
  const results = await Promise.allSettled(pending.map((doc) => processTask(c, doc, tokensFor)));
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    c.log("Error procesando pendiente:", r.reason);
    return "error";
  });
}
