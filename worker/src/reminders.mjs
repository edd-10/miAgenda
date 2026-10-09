// Lógica de recordatorios. El cron de Cloudflare no corre al segundo :00 (en este proyecto corre al :51), así que en
// vez de enviar lo que "ya venció" se atiende lo que vence en los próximos LOOKAHEAD_MS: se reserva cada tarea, se
// espera hasta un instante antes de su hora exacta y entonces se envía.
//
// Insistencia: si el pendiente tiene nagMin > 0, tras el primer aviso se programa nagAt (la siguiente insistencia) y
// cada una repite el aviso hasta que se marque como hecho, se borre/edite, o se alcance el máximo de repeticiones.

import { getAccessToken as defaultGetAccessToken } from "./google-auth.mjs";

export const CONFIG = {
  WINDOW_MS: 24 * 60 * 60 * 1000, // recordatorios atrasados hasta 1 día se siguen enviando
  LOOKAHEAD_MS: 75_000,           // se atiende lo que vence antes de la siguiente ejecución (60 s + margen por desfases)
  LEAD_MS: 1200,                  // se envía esto antes de la hora exacta: FCM tarda ~1 s en llegar al dispositivo
  RECHECK_MS: 800,                // se vuelve a leer la tarea esto antes del envío (por si se borró o cambió)
  BATCH_LIMIT: 12,                // máx. de avisos + insistencias por ejecución (el plan gratuito limita las subpeticiones)
  NAG_MAX_DEFAULT: 5,             // repeticiones máximas si la cuenta no ha elegido otra (users/{uid}.nagMax)
  SNOOZE_DEFAULT: 10,             // minutos que pospone el botón "Posponer" si la cuenta no eligió otro (users/{uid}.snoozeMin)
  TTL_REMINDER_S: 86_400,         // cuánto guarda el servicio push un aviso si el dispositivo está apagado (1 día)
  TTL_NAG_MAX_S: 3_600,           // una insistencia caduca antes de que llegue la siguiente (y nunca más de 1 h)
  DIGEST_BATCH: 10,               // máx. de usuarios con resumen por ejecución
  DIGEST_STALE_MS: 30 * 60_000,   // un resumen que llega con más de 30 min de retraso se descarta (un "buenos días" a media tarde estorba)
  DIGEST_LISTED: 3,               // cuántos pendientes se nombran en el texto del resumen
  DIGEST_MAX_TASKS: 50,           // máx. de pendientes que se leen para contar
  DIGEST_TTL_S: 3_600,            // un resumen caduca en 1 h si el dispositivo está apagado
};
const SNOOZE_OPTIONS = [5, 10, 15, 30, 60];

export const fsBase = (pid) => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
export const str = (f) => f?.stringValue;
export const int = (f) => (f?.integerValue !== undefined ? Number(f.integerValue) : f?.doubleValue);
export const idOf = (doc) => doc.name.split("/").pop();

// Valores de campo de la API REST de Firestore.
export const FV = {
  bool: (v) => ({ booleanValue: v }),
  int: (v) => ({ integerValue: String(v) }),
  nul: () => ({ nullValue: null }),
};

// "21:30" → "21:30" (24 h) o "9:30 p. m." (12 h). Debe dar lo mismo que public/format.js (una prueba lo comprueba).
export function formatTime(hhmm, fmt) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m || fmt !== "12") return hhmm || "";
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "a. m." : "p. m."}`;
}

export function makeCtx(env, deps) {
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

export const headers = (c, extra = {}) => ({ authorization: `Bearer ${c.token}`, ...extra });
export const sleepUntil = async (c, at) => { const ms = at - c.now(); if (ms > 0) await c.sleep(ms); };

/* ---------- Firestore (REST) ---------- */
export async function runQuery(c, structuredQuery) {
  const res = await c.fetch(`${fsBase(c.pid)}:runQuery`, {
    method: "POST",
    headers: headers(c, { "content-type": "application/json" }),
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error("runQuery: " + res.status + " " + (await res.text()));
  return (await res.json()).filter((r) => r.document).map((r) => r.document);
}

// Escribe `fields` en un documento solo si no ha cambiado desde `updateTime` (condición atómica).
export const patchDoc = (c, collection, id, fields, updateTime) => {
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join("&");
  return c.fetch(`${fsBase(c.pid)}/${collection}/${encodeURIComponent(id)}?${mask}&currentDocument.updateTime=${encodeURIComponent(updateTime)}`, {
    method: "PATCH",
    headers: headers(c, { "content-type": "application/json" }),
    body: JSON.stringify({ fields }),
  });
};
const patchTask = (c, id, fields, updateTime) => patchDoc(c, "tasks", id, fields, updateTime);

// Reserva el documento escribiendo `fields` con la condición de que no haya cambiado desde que se leyó: si dos
// ejecuciones coinciden, solo una lo consigue. Devuelve el updateTime nuevo, o null si no se pudo.
export async function claimDoc(c, collection, doc, fields) {
  const res = await patchDoc(c, collection, idOf(doc), fields, doc.updateTime);
  if (res.ok) return (await res.json()).updateTime;
  if (![400, 404, 409].includes(res.status)) c.log("No se pudo reservar el aviso:", res.status, await res.text());
  return null; // otra ejecución lo tomó, el usuario lo editó o lo borró
}
const claimTask = (c, doc, fields) => claimDoc(c, "tasks", doc, fields);

// Deshace la reserva (solo si la tarea sigue como la dejamos).
async function releaseTask(c, id, fields, updateTime) {
  const res = await patchTask(c, id, fields, updateTime);
  if (!res.ok && ![400, 404, 409].includes(res.status)) c.log("No se pudo liberar el aviso:", res.status, await res.text());
}

// null = la tarea ya no existe; undefined = no se pudo leer (se sigue con lo que ya se tenía).
async function readTask(c, id) {
  const res = await c.fetch(`${fsBase(c.pid)}/tasks/${id}`, { headers: headers(c) });
  if (res.status === 404) return null;
  if (!res.ok) return undefined;
  return res.json();
}

// Preferencias de la cuenta (users/{uid}): formato de hora, máximo de insistencias y duración de "Posponer". Cualquier fallo o ausencia →
// valores por defecto: nunca impide el aviso.
async function readPrefs(c, uid) {
  const defaults = { timeFormat: "24", nagMax: c.config.NAG_MAX_DEFAULT, snoozeMin: c.config.SNOOZE_DEFAULT };
  try {
    const res = await c.fetch(`${fsBase(c.pid)}/users/${encodeURIComponent(uid)}`, { headers: headers(c) });
    if (res.status === 404) return defaults;
    if (!res.ok) { c.log("No se pudieron leer las preferencias:", res.status); return defaults; }
    const f = (await res.json()).fields || {};
    const nagMax = int(f.nagMax), snoozeMin = int(f.snoozeMin);
    return {
      timeFormat: str(f.timeFormat) === "12" ? "12" : "24",
      nagMax: Number.isInteger(nagMax) && nagMax >= 1 && nagMax <= 50 ? nagMax : defaults.nagMax,
      snoozeMin: SNOOZE_OPTIONS.includes(snoozeMin) ? snoozeMin : defaults.snoozeMin,
    };
  } catch (e) {
    c.log("No se pudieron leer las preferencias:", String(e));
    return defaults;
  }
}

/* ---------- Envío (FCM) ---------- */
// Manda un mensaje solo de datos a un dispositivo (sin "notification": el service worker arma la notificación, con sus botones).
// Devuelve "ok", "gone" (token inválido, ya borrado), "retry" (fallo temporal) o "failed" (permanente).
export async function sendData(c, deviceToken, data, ttl) {
  const res = await c.fetch(`https://fcm.googleapis.com/v1/projects/${c.pid}/messages:send`, {
    method: "POST",
    headers: headers(c, { "content-type": "application/json" }),
    body: JSON.stringify({
      message: { token: deviceToken, data, webpush: { headers: { Urgency: "high", TTL: String(ttl) } } },
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

// Envía a todos los dispositivos. Devuelve { results, delivered, retry } (retry: fallo temporal y nada llegó).
export async function deliver(c, deviceTokens, data, ttl) {
  const results = await Promise.all(deviceTokens.map((t) => sendData(c, t, data, ttl)));
  const delivered = results.includes("ok");
  return { results, delivered, retry: !delivered && results.includes("retry") };
}

// Mensaje de un aviso o de una insistencia de un pendiente.
function reminderMessage(c, task) {
  const t = formatTime(task.time, task.timeFormat);
  const body = task.repeat ? `Sigue pendiente (${task.repeat.n} de ${task.repeat.max}) · ${t}`
    : task.remindMin > 0 ? `Es a las ${t}` : `Ahora · ${t}`;
  // Una insistencia caduca antes de que llegue la siguiente, para que un teléfono apagado no reciba un montón al encender.
  const ttl = task.repeat
    ? Math.min(c.config.TTL_NAG_MAX_S, Math.max(60, Math.round(task.repeat.stepMs / 1000)))
    : c.config.TTL_REMINDER_S;
  const data = { title: `⏰ ${task.title}`, body, taskId: task.id, snoozeMin: String(task.snoozeMin), kind: task.repeat ? "nag" : "reminder" };
  return { data, ttl };
}
const sendAll = (c, deviceTokens, info) => { const { data, ttl } = reminderMessage(c, info); return deliver(c, deviceTokens, data, ttl); };

// Tokens de los dispositivos de un usuario.
export async function listTokens(c, uid) {
  const docs = await runQuery(c, {
    from: [{ collectionId: "tokens" }],
    where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
  });
  return docs.map(idOf);
}

const infoOf = (id, fields, prefs, repeat) => ({
  id,
  snoozeMin: prefs.snoozeMin,
  title: str(fields.title) || "Pendiente",
  time: str(fields.time) || "",
  remindMin: int(fields.remindMin) || 0,
  timeFormat: prefs.timeFormat,
  repeat,
});

function outcome(c, id, label, { results, delivered }) {
  if (delivered) return "sent";
  if (results.includes("failed")) { c.log(`${label} descartado por error permanente de FCM:`, id); return "dropped"; }
  return "no-devices";   // sin dispositivos registrados, o todos dados de baja
}

/* ---------- Un aviso (la primera vez) ---------- */
// Resultados: "sent" | "no-devices" | "dropped" | "retry" | "skipped" | "deleted" | "done" | "rescheduled"
async function processReminder(c, doc, tokensFor, prefsFor) {
  const { LEAD_MS, RECHECK_MS } = c.config;
  const id = idOf(doc), uid = str(doc.fields.uid), dueAt = int(doc.fields.remindAt);
  const nagMin = int(doc.fields.nagMin) || 0;

  // Reserva: se marca como avisada y, si el pendiente insiste, se programa la primera insistencia.
  const claim = { notified: FV.bool(true) };
  const undo = { notified: FV.bool(false) };
  if (nagMin > 0) {
    claim.nagAt = FV.int(Math.max(dueAt, c.now()) + nagMin * 60_000);
    claim.nagCount = FV.int(0);
    undo.nagAt = FV.nul();
    undo.nagCount = FV.int(0);
  }
  const claimedAt = await claimTask(c, doc, claim);
  if (!claimedAt) return "skipped";

  // Mientras se espera, ya se van consultando los tokens y las preferencias del usuario.
  const tokensPromise = tokensFor(uid);
  tokensPromise.catch(() => {});
  const prefsPromise = prefsFor(uid);

  await sleepUntil(c, dueAt - LEAD_MS - RECHECK_MS);

  // Última comprobación: durante la espera pudo borrarse, completarse o reprogramarse.
  const fresh = await readTask(c, id);
  if (fresh === null) return "deleted";
  let current = doc, updateTime = claimedAt;
  if (fresh) {
    if (fresh.fields.done?.booleanValue === true) return "done";
    if (int(fresh.fields.remindAt) !== dueAt) {
      await releaseTask(c, id, undo, fresh.updateTime);   // que el nuevo horario se atienda en su momento
      return "rescheduled";
    }
    current = fresh; updateTime = fresh.updateTime;
  }
  const info = infoOf(id, current.fields, await prefsPromise);
  const deviceTokens = await tokensPromise;

  await sleepUntil(c, dueAt - LEAD_MS);
  const sentAt = c.now();
  const sent = await sendAll(c, deviceTokens, info);

  // Fallo temporal sin entregar nada: se libera para que la siguiente ejecución lo reintente.
  if (sent.retry) { await releaseTask(c, id, undo, updateTime); return "retry"; }
  c.log(`Aviso ${id}: enviado ${sentAt - dueAt} ms respecto a la hora (dispositivos: ${deviceTokens.length}, entregados: ${sent.results.filter((r) => r === "ok").length})`);
  return outcome(c, id, "Recordatorio", sent);
}

/* ---------- Una insistencia (repetir el aviso mientras siga pendiente) ---------- */
// Resultados: los de processReminder, más "nag-stopped" (se cortó la cadena sin enviar) y "reset" (se editó durante la espera).
async function processNag(c, doc, tokensFor, prefsFor) {
  const { LEAD_MS, RECHECK_MS } = c.config;
  const id = idOf(doc), uid = str(doc.fields.uid), f = doc.fields;
  const dueAt = int(f.nagAt);
  const step = (int(f.nagMin) || 0) * 60_000;
  const count = int(f.nagCount) || 0;     // insistencias ya enviadas
  const n = count + 1;                    // la que toca ahora
  const prefs = await prefsFor(uid);

  // Si se apagó la insistencia o se bajó el máximo, se corta la cadena sin enviar.
  if (!(step > 0) || n > prefs.nagMax) {
    await claimTask(c, doc, { nagAt: FV.nul() });
    return "nag-stopped";
  }

  // La siguiente se ancla a la hora programada, pero nunca en el pasado: tras una caída del Worker no se envían en ráfaga.
  const nextAt = n < prefs.nagMax ? Math.max(dueAt, c.now()) + step : null;
  const claim = { nagAt: nextAt === null ? FV.nul() : FV.int(nextAt), nagCount: FV.int(n) };
  const undo = { nagAt: FV.int(dueAt), nagCount: FV.int(count) };
  const claimedAt = await claimTask(c, doc, claim);
  if (!claimedAt) return "skipped";

  const tokensPromise = tokensFor(uid);
  tokensPromise.catch(() => {});

  await sleepUntil(c, dueAt - LEAD_MS - RECHECK_MS);

  const fresh = await readTask(c, id);
  if (fresh === null) return "deleted";
  let current = doc, updateTime = claimedAt;
  if (fresh) {
    if (fresh.fields.done?.booleanValue === true) return "done";
    if ((int(fresh.fields.nagCount) || 0) !== n) return "reset";   // el usuario la editó o la reprogramó: la cadena se reinició
    current = fresh; updateTime = fresh.updateTime;
  }
  const info = infoOf(id, current.fields, prefs, { n, max: prefs.nagMax, stepMs: step });
  const deviceTokens = await tokensPromise;

  await sleepUntil(c, dueAt - LEAD_MS);
  const sentAt = c.now();
  const sent = await sendAll(c, deviceTokens, info);

  if (sent.retry) { await releaseTask(c, id, undo, updateTime); return "retry"; }
  c.log(`Insistencia ${n}/${prefs.nagMax} ${id}: enviada ${sentAt - dueAt} ms respecto a la hora (dispositivos: ${deviceTokens.length})`);
  return outcome(c, id, "Insistencia", sent);
}

/* ---------- Ejecución completa ---------- */
const range = (field, lo, hi) => [
  { fieldFilter: { field: { fieldPath: field }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(hi) } } },
  { fieldFilter: { field: { fieldPath: field }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: String(lo) } } },
];
const eqBool = (field, v) => ({ fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { booleanValue: v } } });

export async function processReminders(env, deps = {}) {
  const c = makeCtx(env, deps);
  c.token = await c.getAccessToken(c.sa, { fetch: c.fetch, now: c.now });
  const now = c.now();
  const lo = now - c.config.WINDOW_MS, hi = now + c.config.LOOKAHEAD_MS;

  // Primeros avisos. Requiere el índice compuesto (notified, done, remindAt) de firestore.indexes.json.
  const pending = await runQuery(c, {
    from: [{ collectionId: "tasks" }],
    where: { compositeFilter: { op: "AND", filters: [eqBool("notified", false), eqBool("done", false), ...range("remindAt", lo, hi)] } },
    orderBy: [{ field: { fieldPath: "remindAt" }, direction: "ASCENDING" }],
    limit: c.config.BATCH_LIMIT,
  });

  // Insistencias, con el espacio que quede del lote. Requiere el índice compuesto (done, nagAt).
  const room = c.config.BATCH_LIMIT - pending.length;
  const nags = room <= 0 ? [] : await runQuery(c, {
    from: [{ collectionId: "tasks" }],
    where: { compositeFilter: { op: "AND", filters: [eqBool("done", false), ...range("nagAt", lo, hi)] } },
    orderBy: [{ field: { fieldPath: "nagAt" }, direction: "ASCENDING" }],
    limit: room,
  });
  c.log(`Pendientes por avisar: ${pending.length}${nags.length ? ` (insistencias: ${nags.length})` : ""}`);

  // Una sola consulta de tokens por usuario en cada ejecución.
  const tokenCache = new Map();
  const tokensFor = (uid) => {
    if (!tokenCache.has(uid)) tokenCache.set(uid, listTokens(c, uid));
    return tokenCache.get(uid);
  };

  // Una sola lectura de preferencias por usuario en cada ejecución.
  const prefCache = new Map();
  const prefsFor = (uid) => {
    if (!prefCache.has(uid)) prefCache.set(uid, readPrefs(c, uid));
    return prefCache.get(uid);
  };

  // Todas a la vez: cada una espera su propia hora, así que no pueden ir por turnos.
  const results = await Promise.allSettled([
    ...pending.map((doc) => processReminder(c, doc, tokensFor, prefsFor)),
    ...nags.map((doc) => processNag(c, doc, tokensFor, prefsFor)),
  ]);
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    c.log("Error procesando pendiente:", r.reason);
    return "error";
  });
}
