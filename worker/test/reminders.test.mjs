// Pruebas de la lógica de recordatorios con un reloj virtual y un Firestore/FCM simulados en memoria.
// Ejecutar con: npm run test:worker
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { processReminders, formatTime, CONFIG } from "../src/reminders.mjs";

const clientFormat = createRequire(import.meta.url)("../../public/format.js");

const PID = "demo";
const ENV = { SERVICE_ACCOUNT: JSON.stringify({ project_id: PID, client_email: "w@demo.iam", private_key: "no-se-usa" }) };
const T0 = Date.UTC(2026, 9, 8, 16, 30, 0) + 51_000;   // el cron corre al segundo :51

const val = (v) => (typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? { integerValue: String(v) } : { stringValue: v });

function makeWorld(start = T0) {
  let t = start;
  const timers = [];
  let version = 1;
  const tasks = new Map(), tokens = new Map(), users = new Map();
  let userReads = 0, failUserReads = false;
  const sends = [], logs = [], deletedTokens = [];
  const fcmReply = new Map();   // token -> { status, body }

  const stamp = () => String(version++);
  const docName = (coll, id) => `projects/${PID}/databases/(default)/documents/${coll}/${id}`;
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  const asDoc = (coll, id, d) => ({ name: docName(coll, id), fields: d.fields, updateTime: d.updateTime });

  const fieldVal = (f) => f.booleanValue ?? (f.integerValue !== undefined ? Number(f.integerValue) : f.stringValue);
  const matches = (d, filter) => {
    if (filter.compositeFilter) return filter.compositeFilter.filters.every((x) => matches(d, x));
    const { field, op, value } = filter.fieldFilter;
    const a = d.fields[field.fieldPath] ? fieldVal(d.fields[field.fieldPath]) : undefined, b = fieldVal(value);
    return op === "EQUAL" ? a === b : op === "LESS_THAN_OR_EQUAL" ? a <= b : op === "GREATER_THAN_OR_EQUAL" ? a >= b : false;
  };

  async function fetchFn(url, init = {}) {
    const u = new URL(url), method = init.method || "GET";
    if (u.pathname.endsWith(":runQuery")) {
      const q = JSON.parse(init.body).structuredQuery;
      const coll = q.from[0].collectionId, store = coll === "tasks" ? tasks : tokens;
      let rows = [...store].filter(([, d]) => !q.where || matches(d, q.where));
      if (q.orderBy) rows.sort((x, y) => fieldVal(x[1].fields.remindAt) - fieldVal(y[1].fields.remindAt));
      if (q.limit) rows = rows.slice(0, q.limit);
      return json(200, rows.length ? rows.map(([id, d]) => ({ document: asDoc(coll, id, d) })) : [{}]);
    }
    if (u.hostname === "fcm.googleapis.com") {
      const m = JSON.parse(init.body).message;
      sends.push({ at: t, token: m.token, title: m.notification.title, body: m.notification.body });
      const r = fcmReply.get(m.token) || { status: 200, body: "{}" };
      return new Response(r.body ?? "{}", { status: r.status });
    }
    const m = u.pathname.match(/\/documents\/(tasks|tokens|users)\/(.+)$/);
    if (!m) throw new Error("URL inesperada: " + url);
    const coll = m[1], id = decodeURIComponent(m[2]), store = coll === "tasks" ? tasks : coll === "tokens" ? tokens : users;
    if (coll === "users") {
      userReads++;
      if (failUserReads === "throw") throw new Error("red caída");
      if (failUserReads) return json(500, { error: { status: "INTERNAL" } });
    }
    if (method === "DELETE") { store.delete(id); deletedTokens.push(id); return json(200, {}); }
    const d = store.get(id);
    if (method === "GET") return d ? json(200, asDoc(coll, id, d)) : json(404, { error: { status: "NOT_FOUND" } });
    if (method === "PATCH") {
      const pre = u.searchParams.get("currentDocument.updateTime");
      if (!d) return json(404, { error: { status: "NOT_FOUND" } });
      if (pre && pre !== d.updateTime) return json(400, { error: { status: "FAILED_PRECONDITION" } });
      for (const [k, v] of Object.entries(JSON.parse(init.body).fields)) d.fields[k] = v;
      d.updateTime = stamp();
      return json(200, asDoc(coll, id, d));
    }
    throw new Error("método inesperado: " + method);
  }

  const schedule = (at, fn) => timers.push({ at, fn });
  const world = {
    sends, logs, deletedTokens, fcmReply, tasks,
    get userReads() { return userReads; },
    failUserReads: (v = true) => { failUserReads = v; },
    addUser(uid, timeFormat) { users.set(uid, { updateTime: stamp(), fields: { timeFormat: val(timeFormat) } }); },
    now: () => t,
    setNow: (v) => { t = v; },
    at: (ms, fn) => schedule(t + ms, fn),                   // ejecuta algo (p. ej. "el usuario borra la tarea") en un instante
    deps: {
      fetch: fetchFn,
      now: () => t,
      sleep: (ms) => new Promise((res) => schedule(t + ms, res)),
      log: (...a) => logs.push(a.join(" ")),
      getAccessToken: async () => "token",
    },
    addTask(id, { due, uid = "u1", title = "Reunión", time = "10:30", remindMin = 0, notified = false, done = false }) {
      tasks.set(id, { updateTime: stamp(), fields: {
        uid: val(uid), title: val(title), time: val(time), remindMin: val(remindMin), remindAt: val(due),
        notified: val(notified), done: val(done),
      } });
    },
    addToken(token, uid = "u1") { tokens.set(token, { updateTime: stamp(), fields: { uid: val(uid) } }); },
    notified: (id) => tasks.get(id).fields.notified.booleanValue,
    // Avanza el reloj virtual hasta que termine la promesa.
    async run(promise) {
      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      for (let guard = 0; guard < 5000 && !settled; guard++) {
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));   // deja avanzar las respuestas simuladas
        if (settled) break;
        if (!timers.length) continue;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.fn();
      }
      assert.ok(settled, "la ejecución se quedó esperando");
      return promise;
    },
  };
  return world;
}

const go = (w, config) => w.run(processReminders(ENV, { ...w.deps, config }));

/* ---------- Puntualidad ---------- */
test("envía justo antes de la hora exacta, sin esperar al siguiente ciclo del cron", async () => {
  const w = makeWorld(), due = T0 + 9_000;                 // vence 9 s después de que arranca el cron
  w.addTask("a", { due }); w.addToken("tokA");
  assert.deepEqual(await go(w), ["sent"]);
  assert.equal(w.sends.length, 1);
  assert.equal(w.sends[0].at, due - CONFIG.LEAD_MS);       // exactamente LEAD_MS antes de la hora
  assert.equal(w.notified("a"), true);
});

test("el envío no depende del segundo en que caiga el cron (:00, :30, :51…)", async () => {
  for (const second of [0, 30, 51, 59]) {
    const start = Date.UTC(2026, 9, 8, 16, 30, second), due = Date.UTC(2026, 9, 8, 16, 31, 0);
    const w = makeWorld(start);
    w.addTask("a", { due }); w.addToken("tokA");
    assert.deepEqual(await go(w), ["sent"], `cron al segundo ${second}`);
    // Si el cron cae a menos de LEAD_MS de la hora, ya no hay margen para esperar: se envía de inmediato.
    assert.equal(w.sends[0].at, Math.max(start, due - CONFIG.LEAD_MS), `cron al segundo ${second}`);
  }
});

test("varios pendientes en la misma ejecución se envían cada uno en su hora", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 5_000, title: "Primero" }); w.addTask("b", { due: T0 + 20_000, title: "Segundo" });
  w.addToken("tokA");
  assert.deepEqual((await go(w)).sort(), ["sent", "sent"]);
  assert.deepEqual(w.sends.map((s) => [s.title, s.at]), [["⏰ Primero", T0 + 5_000 - CONFIG.LEAD_MS], ["⏰ Segundo", T0 + 20_000 - CONFIG.LEAD_MS]]);
});

test("un pendiente atrasado se envía de inmediato", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 - 5_000 }); w.addToken("tokA");
  assert.deepEqual(await go(w), ["sent"]);
  assert.equal(w.sends[0].at, T0);
});

/* ---------- Qué se atiende y qué no ---------- */
test("no toca lo que vence más allá de la ventana de anticipación", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + CONFIG.LOOKAHEAD_MS + 5_000 }); w.addToken("tokA");
  assert.deepEqual(await go(w), []);
  assert.equal(w.sends.length, 0);
  assert.equal(w.notified("a"), false);
});

test("descarta lo atrasado más de 24 h, lo ya avisado y lo completado", async () => {
  const w = makeWorld();
  w.addTask("viejo", { due: T0 - CONFIG.WINDOW_MS - 1_000 });
  w.addTask("avisado", { due: T0 - 1_000, notified: true });
  w.addTask("hecho", { due: T0 - 1_000, done: true });
  w.addToken("tokA");
  assert.deepEqual(await go(w), []);
  assert.equal(w.sends.length, 0);
});

test("respeta BATCH_LIMIT; el resto queda pendiente para la siguiente ejecución", async () => {
  const w = makeWorld();
  for (const id of ["a", "b", "c"]) w.addTask(id, { due: T0 + 2_000 }); w.addToken("tokA");
  const out = await go(w, { BATCH_LIMIT: 2 });
  assert.equal(out.length, 2);
  assert.equal(w.notified("c"), false);
});

/* ---------- Ejecuciones solapadas ---------- */
test("dos ejecuciones simultáneas no duplican el aviso", async () => {
  const w = makeWorld(), due = T0 + 10_000;
  w.addTask("a", { due }); w.addToken("tokA");
  const out = await w.run(Promise.all([processReminders(ENV, w.deps), processReminders(ENV, w.deps)]));
  assert.equal(w.sends.length, 1);
  assert.deepEqual(out.flat().sort(), ["sent", "skipped"]);
});

test("una ejecución que arranca mientras otra espera no vuelve a enviar", async () => {
  const w = makeWorld(), due = T0 + 70_000;                // la segunda ejecución llega 60 s después, con la 1ª aún esperando
  w.addTask("a", { due }); w.addToken("tokA");
  const first = processReminders(ENV, w.deps);
  w.at(60_000, () => { second = processReminders(ENV, w.deps); });
  let second;
  await w.run(first);
  await w.run(second ?? Promise.resolve([]));
  assert.equal(w.sends.length, 1);
});

/* ---------- Cambios durante la espera ---------- */
test("si se borra el pendiente mientras se espera, no se envía", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 9_000 }); w.addToken("tokA");
  w.at(3_000, () => w.tasks.delete("a"));
  assert.deepEqual(await go(w), ["deleted"]);
  assert.equal(w.sends.length, 0);
});

test("si se completa mientras se espera, no se envía", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 9_000 }); w.addToken("tokA");
  w.at(3_000, () => { w.tasks.get("a").fields.done = val(true); w.tasks.get("a").updateTime = "x1"; });
  assert.deepEqual(await go(w), ["done"]);
  assert.equal(w.sends.length, 0);
});

test("si se reprograma mientras se espera, no avisa a la hora vieja y queda listo para la nueva", async () => {
  const w = makeWorld(), newDue = T0 + 10 * 60_000;
  w.addTask("a", { due: T0 + 9_000 }); w.addToken("tokA");
  w.at(3_000, () => { const d = w.tasks.get("a"); d.fields.remindAt = val(newDue); d.updateTime = "x2"; });
  assert.deepEqual(await go(w), ["rescheduled"]);
  assert.equal(w.sends.length, 0);
  assert.equal(w.notified("a"), false);                    // liberada: el aviso nuevo se atenderá a su hora
  w.setNow(newDue - 20_000);
  assert.deepEqual(await go(w), ["sent"]);
  assert.equal(w.sends[0].at, newDue - CONFIG.LEAD_MS);
});

test("usa el título más reciente si se editó mientras se esperaba", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 9_000, title: "Viejo" }); w.addToken("tokA");
  w.at(3_000, () => { const d = w.tasks.get("a"); d.fields.title = val("Nuevo"); d.updateTime = "x3"; });
  await go(w);
  assert.equal(w.sends[0].title, "⏰ Nuevo");
});

/* ---------- Fallos de FCM ---------- */
test("fallo temporal sin entregar: se libera y la siguiente ejecución lo reintenta", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 5_000 }); w.addToken("tokA");
  w.fcmReply.set("tokA", { status: 503, body: "caído" });
  assert.deepEqual(await go(w), ["retry"]);
  assert.equal(w.notified("a"), false);
  w.fcmReply.delete("tokA");
  assert.deepEqual(await go(w), ["sent"]);
  assert.equal(w.notified("a"), true);
});

test("error permanente: se descarta (queda marcado) para no ocupar el lote", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 5_000 }); w.addToken("tokA");
  w.fcmReply.set("tokA", { status: 400, body: "INVALID_ARGUMENT" });
  assert.deepEqual(await go(w), ["dropped"]);
  assert.equal(w.notified("a"), true);
  assert.ok(w.logs.some((l) => l.includes("descartado")));
});

test("si llega a un dispositivo y otro falla temporalmente, se da por enviado", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 5_000 }); w.addToken("tokA"); w.addToken("tokB");
  w.fcmReply.set("tokB", { status: 503, body: "caído" });
  assert.deepEqual(await go(w), ["sent"]);
  assert.equal(w.notified("a"), true);
});

test("token dado de baja: se borra y la tarea queda procesada", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 5_000 }); w.addToken("tokA");
  w.fcmReply.set("tokA", { status: 404, body: '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}' });
  assert.deepEqual(await go(w), ["no-devices"]);
  assert.deepEqual(w.deletedTokens, ["tokA"]);
  assert.equal(w.notified("a"), true);
});

test("sin dispositivos registrados: se marca como procesada", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 5_000 });
  assert.deepEqual(await go(w), ["no-devices"]);
  assert.equal(w.sends.length, 0);
  assert.equal(w.notified("a"), true);
});

test("solo avisa a los dispositivos del dueño", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 5_000, uid: "u1" }); w.addToken("mio", "u1"); w.addToken("ajeno", "u2");
  await go(w);
  assert.deepEqual(w.sends.map((s) => s.token), ["mio"]);
});

/* ---------- Formato de hora de la cuenta ---------- */
test("sin preferencia guardada, el texto del aviso usa 24 h", async () => {
  const w = makeWorld();
  w.addTask("a", { due: T0 + 5_000, time: "21:30" }); w.addToken("tokA");
  await go(w);
  assert.equal(w.sends[0].body, "Ahora · 21:30");
});

test("con formato de 12 h, el texto del aviso usa a. m./p. m. (a la hora y con anticipación)", async () => {
  const w = makeWorld();
  w.addUser("u1", "12");
  w.addTask("a", { due: T0 + 5_000, time: "21:30", remindMin: 0 });
  w.addTask("b", { due: T0 + 6_000, time: "09:05", remindMin: 15 });
  w.addToken("tokA");
  await go(w);
  assert.deepEqual(w.sends.map((x) => x.body).sort(), ["Ahora · 9:30 p. m.", "Es a las 9:05 a. m."]);
});

test("con formato de 24 h guardado, el texto sigue en 24 h", async () => {
  const w = makeWorld();
  w.addUser("u1", "24");
  w.addTask("a", { due: T0 + 5_000, time: "21:30", remindMin: 5 }); w.addToken("tokA");
  await go(w);
  assert.equal(w.sends[0].body, "Es a las 21:30");
});

test("el formato se aplica según el dueño de cada pendiente", async () => {
  const w = makeWorld();
  w.addUser("u1", "12");
  w.addTask("a", { due: T0 + 5_000, uid: "u1", time: "18:00" }); w.addToken("t1", "u1");
  w.addTask("b", { due: T0 + 6_000, uid: "u2", time: "18:00" }); w.addToken("t2", "u2");
  await go(w);
  const byToken = Object.fromEntries(w.sends.map((x) => [x.token, x.body]));
  assert.equal(byToken.t1, "Ahora · 6:00 p. m.");
  assert.equal(byToken.t2, "Ahora · 18:00");
});

test("si falla la lectura de preferencias, el aviso se envía igual en 24 h", async () => {
  const w = makeWorld();
  w.addUser("u1", "12"); w.failUserReads();
  w.addTask("a", { due: T0 + 5_000, time: "21:30" }); w.addToken("tokA");
  assert.deepEqual(await go(w), ["sent"]);
  assert.equal(w.sends[0].body, "Ahora · 21:30");
  assert.ok(w.logs.some((l) => l.includes("preferencias")));
});

test("si la lectura de preferencias lanza un error de red, el aviso se envía igual en 24 h", async () => {
  const w = makeWorld();
  w.addUser("u1", "12"); w.failUserReads("throw");
  w.addTask("a", { due: T0 + 5_000, time: "21:30" }); w.addToken("tokA");
  assert.deepEqual(await go(w), ["sent"]);
  assert.equal(w.sends[0].body, "Ahora · 21:30");
});

test("se lee una sola vez la preferencia de cada usuario por ejecución", async () => {
  const w = makeWorld();
  w.addUser("u1", "12");
  w.addTask("a", { due: T0 + 5_000 }); w.addTask("b", { due: T0 + 7_000 }); w.addTask("c", { due: T0 + 9_000 });
  w.addToken("tokA");
  await go(w);
  assert.equal(w.userReads, 1);
});

test("formatTime del Worker da lo mismo que el del cliente en los 1440 minutos del día, en ambos formatos", () => {
  for (const fmt of ["12", "24"]) for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) {
    const hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    assert.equal(formatTime(hhmm, fmt), clientFormat.formatTime(hhmm, fmt), `${hhmm} (${fmt} h)`);
  }
  for (const bad of ["", "9:30", "abc", null, undefined]) {
    assert.equal(formatTime(bad, "12"), clientFormat.formatTime(bad, "12"));
  }
});
