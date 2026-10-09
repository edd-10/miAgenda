// Resumen de la mañana y cierre del día: un aviso a la hora que cada persona elige, en SU zona horaria.
// users/{uid} guarda tz, digestMorning, digestEvening ("HH:MM" o null) y nextDigestAt (el próximo instante, en ms UTC).
// Cada ejecución atiende a quien tenga nextDigestAt dentro de los próximos ~75 s: reserva (adelanta nextDigestAt a la
// siguiente hora con una condición atómica, así dos ejecuciones no duplican), espera la hora exacta, cuenta los
// pendientes sin hacer de ese día y manda un mensaje solo de datos que el service worker convierte en notificación.

import Digest from "../../public/digest.js";
import { makeCtx, runQuery, claimDoc, patchDoc, deliver, listTokens, formatTime, idOf, str, int, FV, headers, fsBase, sleepUntil } from "./reminders.mjs";

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const plural = (n, one, many) => (n === 1 ? one : many);

// Texto del resumen. `rows`: [{ time, title }] de los pendientes sin hacer, en cualquier orden.
export function digestMessage(kind, rows, { timeFormat = "24", date, listed = 3 } = {}) {
  const sorted = [...rows].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const n = sorted.length, shown = sorted.slice(0, listed), more = n - shown.length;
  if (kind === "morning") {
    const list = shown.map((r) => `${formatTime(r.time, timeFormat)} ${clip(r.title, 40)}`).join(" · ");
    return {
      title: `☀️ Hoy tienes ${n} ${plural(n, "pendiente", "pendientes")}`,
      body: more > 0 ? `${list} · y ${more} más` : list,
      kind: "digest-morning", date, count: String(n),
    };
  }
  const list = shown.map((r) => clip(r.title, 40)).join(", ");
  return {
    title: "🌙 Cierre del día",
    body: `${n === 1 ? "Te quedó 1 sin hacer" : `Te quedaron ${n} sin hacer`}: ${list}${more > 0 ? ` y ${more} más` : ""}`,
    kind: "digest-evening", date, count: String(n),
  };
}

// Pendientes sin hacer de `ymd` (la fecha local del usuario).
async function pendingFor(c, uid, ymd) {
  const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value } });
  const docs = await runQuery(c, {
    from: [{ collectionId: "tasks" }],
    where: { compositeFilter: { op: "AND", filters: [eq("uid", { stringValue: uid }), eq("date", { stringValue: ymd }), eq("done", { booleanValue: false })] } },
    limit: c.config.DIGEST_MAX_TASKS,
  });
  return docs.map((d) => ({ time: str(d.fields.time) || "", title: str(d.fields.title) || "Pendiente" }));
}

// Resultados: "sent" | "empty" | "disabled" | "stale" | "advanced" | "skipped" | "retry" | "dropped" | "no-devices"
async function processDigest(c, doc) {
  const uid = idOf(doc), f = doc.fields;
  const dueAt = int(f.nextDigestAt);
  if (!Number.isFinite(dueAt)) return "skipped";
  const morning = str(f.digestMorning) || null, evening = str(f.digestEvening) || null;
  const tz = Digest.isValidTimeZone(str(f.tz)) ? str(f.tz) : "UTC";

  // Qué resúmenes tocan en este instante (si cambió la configuración desde que se programó, puede que ninguno).
  const due = [];
  if (morning && Digest.nextOccurrence(tz, morning, dueAt - 1) === dueAt) due.push("morning");
  if (evening && Digest.nextOccurrence(tz, evening, dueAt - 1) === dueAt) due.push("evening");

  // Reserva: adelanta nextDigestAt a la siguiente hora (o null si ya no queda ningún resumen activo). Se cuenta desde ahora si ya
  // vencía: tras una caída larga del Worker no se manda un resumen atrasado por cada día perdido.
  const next = Digest.nextDigestAt({ tz, morning, evening }, Math.max(dueAt, c.now()));
  const claimedAt = await claimDoc(c, "users", doc, { nextDigestAt: next === null ? FV.nul() : FV.int(next) });
  if (!claimedAt) return "skipped";
  if (!due.length) return "advanced";
  if (c.now() - dueAt > c.config.DIGEST_STALE_MS) return "stale";

  await sleepUntil(c, dueAt - c.config.LEAD_MS);

  // Última comprobación: pudo desactivarse el resumen mientras se esperaba.
  const res = await c.fetch(`${fsBase(c.pid)}/users/${encodeURIComponent(uid)}`, { headers: headers(c) });
  const fresh = res.ok ? (await res.json()).fields || {} : f;
  const timeFormat = str(fresh.timeFormat) === "12" ? "12" : "24";
  const ymd = Digest.localParts(dueAt, tz).ymd;

  const outcomes = [];
  for (const kind of due) {
    if (!str(fresh[kind === "morning" ? "digestMorning" : "digestEvening"])) { outcomes.push("disabled"); continue; }
    const rows = await pendingFor(c, uid, ymd);
    if (!rows.length) { outcomes.push("empty"); continue; }          // nada que contar: no se molesta
    const deviceTokens = await listTokens(c, uid);
    const data = digestMessage(kind, rows, { timeFormat, date: ymd, listed: c.config.DIGEST_LISTED });
    const sent = await deliver(c, deviceTokens, data, c.config.DIGEST_TTL_S);
    if (sent.retry) {                                                  // fallo temporal sin entregar nada: se reintenta en la siguiente ejecución
      await patchDoc(c, "users", uid, { nextDigestAt: FV.int(dueAt) }, claimedAt);
      outcomes.push("retry"); continue;
    }
    c.log(`Resumen ${kind} de ${uid}: ${rows.length} pendientes (dispositivos: ${deviceTokens.length})`);
    outcomes.push(sent.delivered ? "sent" : sent.results.includes("failed") ? "dropped" : "no-devices");
  }
  return outcomes.length === 1 ? outcomes[0] : outcomes.join("+");
}

export async function processDigests(env, deps = {}) {
  const c = makeCtx(env, deps);
  c.token = await c.getAccessToken(c.sa, { fetch: c.fetch, now: c.now });
  const hi = c.now() + c.config.LOOKAHEAD_MS;
  const users = await runQuery(c, {
    from: [{ collectionId: "users" }],
    where: { fieldFilter: { field: { fieldPath: "nextDigestAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(hi) } } },
    orderBy: [{ field: { fieldPath: "nextDigestAt" }, direction: "ASCENDING" }],
    limit: c.config.DIGEST_BATCH,
  });
  if (users.length) c.log(`Resúmenes por enviar: ${users.length}`);
  const results = await Promise.allSettled(users.map((doc) => processDigest(c, doc)));
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    c.log("Error procesando resumen:", r.reason);
    return "error";
  });
}
