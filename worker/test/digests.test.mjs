// Pruebas del resumen de la mañana y el cierre del día (reloj virtual, Firestore/FCM simulados).
// Ejecutar con: npm run test:worker
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { processDigests, digestMessage } from "../src/digests.mjs";
import { CONFIG } from "../src/reminders.mjs";
import { ENV, makeWorld } from "./world.mjs";

const Digest = createRequire(import.meta.url)("../../public/digest.js");

const MX = "America/Mexico_City";                       // UTC-6, sin horario de verano
const MIN = 60_000;
const utc = (y, m, d, hh = 0, mm = 0, ss = 0) => Date.UTC(y, m - 1, d, hh, mm, ss);
const go = (w, config) => w.run(processDigests(ENV, { ...w.deps, config }));

// Mundo con un usuario con resúmenes. `due` = instante del primer resumen; el reloj arranca `lead` ms antes (como un cron al :51).
function setup({ tz = MX, morning = null, evening = null, timeFormat = "24", lead = 9_000, due } = {}) {
  const dueAt = due ?? Digest.nextDigestAt({ tz, morning, evening }, utc(2026, 10, 9, 6, 0));   // 00:00 en CDMX del día 9
  const w = makeWorld(dueAt - lead);
  w.addDigestUser("u1", { tz, morning, evening, nextDigestAt: dueAt, timeFormat });
  w.addToken("tokA", "u1");
  return { w, dueAt };
}
const today = (extra = {}) => ({ date: "2026-10-09", ...extra });        // el 9 de octubre, fecha local de Ciudad de México

/* ---------- Resumen de la mañana ---------- */
test("mañana: avisa a las 8:00 locales con cuántos pendientes hay y cuáles", async () => {
  const { w, dueAt } = setup({ morning: "08:00" });
  assert.equal(dueAt, utc(2026, 10, 9, 14, 0));                           // 08:00 CDMX = 14:00 UTC
  w.addTask("a", today({ time: "13:30", title: "Comer con Ana" }));
  w.addTask("b", today({ time: "09:00", title: "Reunión" }));
  w.addTask("c", today({ time: "18:00", title: "Gimnasio" }));
  assert.deepEqual(await go(w), ["sent"]);
  assert.equal(w.sends.length, 1);
  assert.equal(w.sends[0].at, dueAt - CONFIG.LEAD_MS);                    // a la hora exacta, como los avisos
  assert.deepEqual(w.sends[0].data, {
    title: "☀️ Hoy tienes 3 pendientes", body: "09:00 Reunión · 13:30 Comer con Ana · 18:00 Gimnasio",
    kind: "digest-morning", date: "2026-10-09", count: "3",
  });
  assert.equal(w.sends[0].message.notification, undefined);               // solo datos: el service worker arma la notificación
  assert.equal(w.sends[0].ttl, "3600");
});

test("mañana: cuenta solo los pendientes sin hacer de ese día y de ese usuario", async () => {
  const { w } = setup({ morning: "08:00" });
  w.addTask("a", today({ title: "Sí 1", time: "09:00" }));
  w.addTask("hecho", today({ title: "Ya hecho", done: true }));
  w.addTask("ayer", { date: "2026-10-08", title: "De ayer" });
  w.addTask("manana", { date: "2026-10-10", title: "De mañana" });
  w.addTask("ajeno", today({ title: "Ajeno", uid: "u2" }));
  await go(w);
  assert.equal(w.sends[0].data.count, "1");
  assert.equal(w.sends[0].title, "☀️ Hoy tienes 1 pendiente");
  assert.equal(w.sends[0].body, "09:00 Sí 1");
});

test("mañana: con más de tres pendientes nombra tres y dice cuántos más", async () => {
  const { w } = setup({ morning: "08:00" });
  for (let i = 1; i <= 5; i++) w.addTask(`t${i}`, today({ time: `0${i}:00`, title: `Tarea ${i}` }));
  await go(w);
  assert.equal(w.sends[0].data.count, "5");
  assert.equal(w.sends[0].body, "01:00 Tarea 1 · 02:00 Tarea 2 · 03:00 Tarea 3 · y 2 más");
});

test("mañana: con formato de 12 horas las horas llevan a. m./p. m.", async () => {
  const { w } = setup({ morning: "08:00", timeFormat: "12" });
  w.addTask("a", today({ time: "09:00", title: "Reunión" }));
  w.addTask("b", today({ time: "18:30", title: "Gimnasio" }));
  await go(w);
  assert.equal(w.sends[0].body, "9:00 a. m. Reunión · 6:30 p. m. Gimnasio");
});

test("mañana: sin pendientes ese día no se manda nada (pero sí se programa el siguiente)", async () => {
  const { w, dueAt } = setup({ morning: "08:00" });
  w.addTask("hecho", today({ done: true }));
  assert.deepEqual(await go(w), ["empty"]);
  assert.equal(w.sends.length, 0);
  assert.equal(w.userField("u1", "nextDigestAt"), dueAt + 24 * 60 * MIN);
});

/* ---------- Cierre del día ---------- */
test("cierre: a las 21:00 locales, con lo que quedó sin hacer", async () => {
  const { w, dueAt } = setup({ evening: "21:00" });
  assert.equal(dueAt, utc(2026, 10, 10, 3, 0));                           // 21:00 CDMX del 9 = 03:00 UTC del 10
  w.addTask("a", today({ time: "09:00", title: "Reunión" }));
  w.addTask("b", today({ time: "18:00", title: "Gimnasio" }));
  w.addTask("c", today({ time: "10:00", title: "Hecha", done: true }));
  assert.deepEqual(await go(w), ["sent"]);
  assert.deepEqual(w.sends[0].data, {
    title: "🌙 Cierre del día", body: "Te quedaron 2 sin hacer: Reunión, Gimnasio",
    kind: "digest-evening", date: "2026-10-09", count: "2",
  });
});

test("cierre: singular, y más de tres", async () => {
  const one = setup({ evening: "21:00" });
  one.w.addTask("a", today({ title: "Llamar a mamá" }));
  await go(one.w);
  assert.equal(one.w.sends[0].body, "Te quedó 1 sin hacer: Llamar a mamá");

  const many = setup({ evening: "21:00" });
  for (let i = 1; i <= 6; i++) many.w.addTask(`t${i}`, today({ time: `0${i}:00`, title: `Tarea ${i}` }));
  await go(many.w);
  assert.equal(many.w.sends[0].body, "Te quedaron 6 sin hacer: Tarea 1, Tarea 2, Tarea 3 y 3 más");
});

test("cierre: si todo se hizo, no se molesta", async () => {
  const { w } = setup({ evening: "21:00" });
  w.addTask("a", today({ done: true }));
  assert.deepEqual(await go(w), ["empty"]);
  assert.equal(w.sends.length, 0);
});

test("la fecha del resumen es la local del usuario, no la de UTC (Tokio: las 08:00 del día 9 son las 23:00 UTC del 8)", async () => {
  const tz = "Asia/Tokyo";
  const { w, dueAt } = setup({ tz, morning: "08:00", due: utc(2026, 10, 8, 23, 0) });
  assert.equal(Digest.localParts(dueAt, tz).ymd, "2026-10-09");
  w.addTask("hoy", today({ title: "De hoy en Tokio" }));
  w.addTask("utc", { date: "2026-10-08", title: "Fecha UTC, no local" });
  await go(w);
  assert.equal(w.sends[0].data.count, "1");
  assert.match(w.sends[0].body, /De hoy en Tokio/);
});

/* ---------- Programación ---------- */
test("con los dos activos, tras la mañana viene el cierre del mismo día; tras el cierre, la mañana siguiente", async () => {
  const { w, dueAt } = setup({ morning: "08:00", evening: "21:00" });
  w.addTask("a", today({ title: "X" }));
  await go(w);                                                            // resumen de la mañana
  assert.equal(w.userField("u1", "nextDigestAt"), utc(2026, 10, 10, 3, 0));   // 21:00 CDMX del 9
  w.setNow(utc(2026, 10, 10, 3, 0) - 9_000);
  await go(w);                                                            // cierre del día
  assert.equal(w.userField("u1", "nextDigestAt"), utc(2026, 10, 10, 14, 0));  // 08:00 CDMX del 10
  assert.equal(w.sends.length, 2);
  assert.deepEqual(w.sends.map((s) => s.data.kind), ["digest-morning", "digest-evening"]);
  assert.ok(dueAt < utc(2026, 10, 10, 3, 0));
});

test("lo que aún no toca (más allá de la ventana) no se procesa ni se modifica", async () => {
  const { w, dueAt } = setup({ morning: "08:00", lead: 10 * 60 * MIN });
  w.addTask("a", today({ title: "X" }));
  assert.deepEqual(await go(w), []);
  assert.equal(w.sends.length, 0);
  assert.equal(w.userField("u1", "nextDigestAt"), dueAt);
});

test("un usuario sin resúmenes (nextDigestAt null) nunca se consulta", async () => {
  const w = makeWorld(utc(2026, 10, 9, 14, 0));
  w.addDigestUser("u1", { morning: null, evening: null, nextDigestAt: null });
  assert.deepEqual(await go(w), []);
});

test("se manda a todos los dispositivos del usuario y solo a los suyos", async () => {
  const { w } = setup({ morning: "08:00" });
  w.addToken("tokB", "u1"); w.addToken("ajeno", "u2");
  w.addTask("a", today({ title: "X" }));
  await go(w);
  assert.deepEqual(w.sends.map((s) => s.token).sort(), ["tokA", "tokB"]);
});

/* ---------- Robustez ---------- */
test("dos ejecuciones simultáneas no duplican el resumen", async () => {
  const { w } = setup({ morning: "08:00" });
  w.addTask("a", today({ title: "X" }));
  const out = await w.run(Promise.all([processDigests(ENV, w.deps), processDigests(ENV, w.deps)]));
  assert.equal(w.sends.length, 1);
  assert.deepEqual(out.flat().sort(), ["sent", "skipped"]);
});

test("si el Worker estuvo caído, un resumen con más de 30 minutos de retraso se descarta (y se reprograma a futuro)", async () => {
  const { w, dueAt } = setup({ morning: "08:00" });
  w.addTask("a", today({ title: "X" }));
  w.setNow(dueAt + 2 * 60 * MIN);                                         // 10:00: ya no es "buenos días"
  assert.deepEqual(await go(w), ["stale"]);
  assert.equal(w.sends.length, 0);
  assert.ok(w.userField("u1", "nextDigestAt") > w.now(), "debe quedar programado hacia adelante");
});

test("tras una caída de varios días no se envían resúmenes atrasados uno por día: se reprograma desde ahora", async () => {
  const { w, dueAt } = setup({ morning: "08:00" });
  w.addTask("a", today({ title: "X" }));
  w.setNow(dueAt + 3 * 24 * 60 * MIN + 3_600_000);                        // tres días después
  assert.deepEqual(await go(w), ["stale"]);
  assert.equal(w.userField("u1", "nextDigestAt"), Digest.nextOccurrence(MX, "08:00", w.now()));
  w.setNow(w.now() + MIN);
  assert.deepEqual(await go(w), []);                                      // la siguiente ejecución ya no encuentra nada vencido
});

test("un retraso corto (dentro de 30 minutos) sí se envía", async () => {
  const { w, dueAt } = setup({ morning: "08:00" });
  w.addTask("a", today({ title: "X" }));
  w.setNow(dueAt + 10 * MIN);
  assert.deepEqual(await go(w), ["sent"]);
});

test("si se cambian los ajustes después de programar, el resumen viejo no se manda y se reprograma", async () => {
  const { w, dueAt } = setup({ morning: "08:00" });
  w.addTask("a", today({ title: "X" }));
  w.editUser("u1", { digestMorning: null, digestEvening: "21:00" });      // dejó la mañana y pasó al cierre
  assert.deepEqual(await go(w), ["advanced"]);
  assert.equal(w.sends.length, 0);
  assert.equal(w.userField("u1", "nextDigestAt"), Digest.nextOccurrence(MX, "21:00", dueAt));
});

test("si desactiva los dos, nextDigestAt queda en null y deja de consultarse", async () => {
  const { w } = setup({ morning: "08:00" });
  w.editUser("u1", { digestMorning: null });
  assert.deepEqual(await go(w), ["advanced"]);
  assert.equal(w.userField("u1", "nextDigestAt"), null);
});

test("si desactiva el resumen mientras se espera, no se manda", async () => {
  const { w } = setup({ morning: "08:00", lead: 20_000 });
  w.addTask("a", today({ title: "X" }));
  w.at(5_000, () => w.editUser("u1", { digestMorning: null }));
  assert.deepEqual(await go(w), ["disabled"]);
  assert.equal(w.sends.length, 0);
});

test("fallo temporal sin entregar: se deja programado para reintentar y el reintento sí llega", async () => {
  const { w, dueAt } = setup({ morning: "08:00" });
  w.addTask("a", today({ title: "X" }));
  w.fcmReply.set("tokA", { status: 503, body: "caído" });
  assert.deepEqual(await go(w), ["retry"]);
  assert.equal(w.userField("u1", "nextDigestAt"), dueAt);
  w.fcmReply.delete("tokA");
  w.setNow(dueAt + MIN);
  assert.deepEqual(await go(w), ["sent"]);
});

test("error permanente de FCM: se descarta; sin dispositivos: tampoco falla", async () => {
  const bad = setup({ morning: "08:00" });
  bad.w.addTask("a", today({ title: "X" }));
  bad.w.fcmReply.set("tokA", { status: 400, body: "INVALID_ARGUMENT" });
  assert.deepEqual(await go(bad.w), ["dropped"]);

  const none = makeWorld(utc(2026, 10, 9, 14, 0) - 9_000);
  none.addDigestUser("u1", { morning: "08:00", nextDigestAt: utc(2026, 10, 9, 14, 0) });
  none.addTask("a", today({ title: "X" }));
  assert.deepEqual(await go(none), ["no-devices"]);
});

test("zona horaria inválida: no falla y se usa UTC", async () => {
  const w = makeWorld(utc(2026, 10, 9, 8, 0) - 9_000);
  w.addDigestUser("u1", { tz: "Marte/Olympus", morning: "08:00", nextDigestAt: utc(2026, 10, 9, 8, 0) });
  w.addToken("tokA", "u1");
  w.addTask("a", { date: "2026-10-09", title: "X" });                     // en UTC "hoy" es el 9
  assert.deepEqual(await go(w), ["sent"]);
});

test("respeta el límite de usuarios por ejecución", async () => {
  const w = makeWorld(utc(2026, 10, 9, 14, 0) - 9_000);
  for (const u of ["u1", "u2", "u3"]) { w.addDigestUser(u, { morning: "08:00", nextDigestAt: utc(2026, 10, 9, 14, 0) }); w.addToken("t" + u, u); w.addTask("a" + u, { date: "2026-10-09", uid: u }); }
  const out = await go(w, { DIGEST_BATCH: 2 });
  assert.equal(out.length, 2);
});

/* ---------- El texto ---------- */
test("digestMessage: los títulos largos se recortan y el plural es correcto", () => {
  const long = "x".repeat(60);
  const m = digestMessage("morning", [{ time: "09:00", title: long }], { date: "2026-10-09" });
  assert.equal(m.title, "☀️ Hoy tienes 1 pendiente");
  assert.equal(m.body, `09:00 ${"x".repeat(39)}…`);
  assert.equal(digestMessage("evening", [{ time: "09:00", title: "a" }, { time: "10:00", title: "b" }], { date: "d" }).title, "🌙 Cierre del día");
  assert.equal(digestMessage("morning", [{ time: "09:00", title: "a" }, { time: "10:00", title: "b" }], { date: "d" }).title, "☀️ Hoy tienes 2 pendientes");
});
