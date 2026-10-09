// Pruebas de las acciones de la notificación (Hecho / Posponer) y del cableado del service worker.
// Ejecutar con: npm run test:client
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const SW = require("../../public/sw-actions.js");

const NOW = Date.UTC(2026, 9, 9, 22, 0, 0);
const PID = "demo", KEY = "API-KEY";
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body ?? "") });

// Registro de usuario como lo guarda Firebase Auth. `expires` en ms desde NOW.
const record = (expires = 3_600_000, base = NOW) => ({ uid: "u1", stsTokenManager: { refreshToken: "REFRESH", accessToken: "CACHED", expirationTime: base + expires } });
// Los objetos creados dentro del contexto simulado del service worker tienen otro prototipo: se comparan como datos planos.
const plain = (x) => JSON.parse(JSON.stringify(x));

// fetch simulado: registra las llamadas y responde según la ruta.
function makeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method, headers: init.headers || {}, body: init.body });
    if (url.startsWith("https://securetoken.googleapis.com/")) return (routes.token || (() => resp(200, { id_token: "FRESH" })))(url, init);
    if (url.endsWith(":runQuery")) return (routes.query || (() => resp(200, [{}])))(url, init);
    if (url.endsWith(":commit")) return (routes.commit || (() => resp(200, {})))(url, init);
    return (routes[method] || (() => resp(200, {})))(url, init);
  };
  fn.calls = calls;
  return fn;
}
const deps = (over = {}) => ({ projectId: PID, apiKey: KEY, readAuthRecord: async () => record(), fetch: makeFetch(), now: () => NOW, ...over });
const fieldsOf = (call) => JSON.parse(call.body).fields;

/* ---------- Opciones de la notificación ---------- */
test("snoozeMinutes: solo acepta 5, 10, 15, 30 y 60; lo demás cae a 10", () => {
  for (const ok of [5, 10, 15, 30, 60, "30"]) assert.equal(SW.snoozeMinutes(ok), Number(ok));
  for (const bad of [0, 7, 120, -5, "x", null, undefined, NaN]) assert.equal(SW.snoozeMinutes(bad), 10);
});

test("etiquetas y botones: 'Posponer 10 min', 'Posponer 1 h'", () => {
  assert.equal(SW.snoozeLabel(10), "10 min");
  assert.equal(SW.snoozeLabel(60), "1 h");
  assert.deepEqual(SW.actionButtons(30), [{ action: "done", title: "✓ Hecho" }, { action: "snooze", title: "Posponer 30 min" }]);
  assert.equal(SW.actionButtons(60)[1].title, "Posponer 1 h");
  assert.equal(SW.actionButtons(undefined)[1].title, "Posponer 10 min");
});

test("notificationOptions: con tarea lleva botones, etiqueta única y datos; sin tarea es un aviso simple", () => {
  const o = SW.notificationOptions({ title: "⏰ Dentista", body: "Ahora · 17:00", taskId: "t1", snoozeMin: "15" });
  assert.equal(o.body, "Ahora · 17:00");
  assert.equal(o.tag, "t1");
  assert.equal(o.renotify, true);                         // renotify exige tag; las insistencias reemplazan y vuelven a sonar
  assert.equal(o.requireInteraction, true);
  assert.deepEqual(o.actions.map((a) => a.action), ["done", "snooze"]);
  assert.equal(o.actions[1].title, "Posponer 15 min");
  assert.deepEqual(o.data, { taskId: "t1", snoozeMin: 15, title: "⏰ Dentista" });

  const simple = SW.notificationOptions({ title: "x", body: "y" });
  assert.equal(simple.tag, undefined);
  assert.equal(simple.renotify, undefined);               // renotify sin tag lanzaría un error en el navegador
  assert.equal(simple.actions, undefined);
});

/* ---------- Token ---------- */
test("getIdToken: usa el token guardado si aún sirve (sin llamar a la red)", async () => {
  const f = makeFetch();
  assert.equal(await SW.getIdToken(record(3_600_000), { fetch: f, now: () => NOW, apiKey: KEY }), "CACHED");
  assert.equal(f.calls.length, 0);
});

test("getIdToken: si vence en menos de un minuto o ya venció, pide uno nuevo con el token de refresco", async () => {
  for (const expires of [30_000, -1000]) {
    const f = makeFetch();
    assert.equal(await SW.getIdToken(record(expires), { fetch: f, now: () => NOW, apiKey: KEY }), "FRESH");
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].url, /securetoken\.googleapis\.com\/v1\/token\?key=API-KEY$/);
    assert.equal(f.calls[0].method, "POST");
    assert.equal(new URLSearchParams(f.calls[0].body).get("grant_type"), "refresh_token");
    assert.equal(new URLSearchParams(f.calls[0].body).get("refresh_token"), "REFRESH");
  }
});

test("getIdToken: errores claros (sin sesión, renovación rechazada, respuesta vacía)", async () => {
  const d = { fetch: makeFetch(), now: () => NOW, apiKey: KEY };
  await assert.rejects(SW.getIdToken(null, d), /sin-sesion/);
  await assert.rejects(SW.getIdToken({ stsTokenManager: {} }, d), /sin-sesion/);
  await assert.rejects(SW.getIdToken(record(-1), { ...d, fetch: makeFetch({ token: () => resp(400, {}) }) }), /token-400/);
  await assert.rejects(SW.getIdToken(record(-1), { ...d, fetch: makeFetch({ token: () => resp(200, {}) }) }), /token-vacio/);
});

/* ---------- Hecho ---------- */
test("Hecho: marca done y corta la cadena de insistencias, con el token del usuario", async () => {
  const f = makeFetch();
  assert.equal(await SW.run("done", { taskId: "t1" }, deps({ fetch: f })), "done");
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.method, "PATCH");
  assert.match(c.url, /\/projects\/demo\/databases\/\(default\)\/documents\/tasks\/t1\?/);
  assert.match(c.url, /updateMask\.fieldPaths=done/);
  assert.match(c.url, /updateMask\.fieldPaths=nagAt/);
  assert.match(c.url, /currentDocument\.exists=true/);           // no recrea una tarea borrada
  assert.equal(c.headers.authorization, "Bearer CACHED");
  assert.deepEqual(fieldsOf(c), { done: { booleanValue: true }, nagAt: { nullValue: null } });
});

test("Hecho: si el token guardado venció, renueva antes de escribir", async () => {
  const f = makeFetch();
  await SW.run("done", { taskId: "t1" }, deps({ fetch: f, readAuthRecord: async () => record(-5000) }));
  assert.deepEqual(f.calls.map((c) => c.method), ["POST", "PATCH"]);
  assert.equal(f.calls[1].headers.authorization, "Bearer FRESH");
});

test("Hecho: el pendiente ya no existe → 'gone' sin error; otros fallos sí lanzan", async () => {
  assert.equal(await SW.run("done", { taskId: "t1" }, deps({ fetch: makeFetch({ PATCH: () => resp(404, {}) }) })), "gone");
  await assert.rejects(SW.run("done", { taskId: "t1" }, deps({ fetch: makeFetch({ PATCH: () => resp(403, {}) }) })), /patch-403/);
  await assert.rejects(SW.run("done", { taskId: "t1" }, deps({ fetch: makeFetch({ PATCH: () => resp(500, {}) }) })), /patch-500/);
});

test("el id de la tarea se codifica en la URL", async () => {
  const f = makeFetch();
  await SW.run("done", { taskId: "a/b c" }, deps({ fetch: f }));
  assert.match(f.calls[0].url, /tasks\/a%2Fb%20c\?/);
});

/* ---------- Posponer ---------- */
test("Posponer: lee la tarea, reprograma el aviso a ahora + N minutos y reinicia las insistencias", async () => {
  const f = makeFetch({ GET: () => resp(200, { fields: { done: { booleanValue: false } } }) });
  assert.equal(await SW.run("snooze", { taskId: "t1", snoozeMin: 30 }, deps({ fetch: f })), "snoozed");
  assert.deepEqual(f.calls.map((c) => c.method), ["GET", "PATCH"]);
  assert.equal(f.calls[0].headers.authorization, "Bearer CACHED");
  assert.deepEqual(fieldsOf(f.calls[1]), {
    remindAt: { integerValue: String(NOW + 30 * 60_000) },
    notified: { booleanValue: false },
    nagAt: { nullValue: null },
    nagCount: { integerValue: "0" },
  });
  for (const f2 of ["remindAt", "notified", "nagAt", "nagCount"]) assert.match(f.calls[1].url, new RegExp(`updateMask\\.fieldPaths=${f2}`));
});

test("Posponer: con una duración inválida usa 10 minutos", async () => {
  const f = makeFetch({ GET: () => resp(200, { fields: {} }) });
  await SW.run("snooze", { taskId: "t1", snoozeMin: 999 }, deps({ fetch: f }));
  assert.equal(fieldsOf(f.calls[1]).remindAt.integerValue, String(NOW + 10 * 60_000));
});

test("Posponer: si ya estaba hecho o ya no existe, no escribe nada", async () => {
  const done = makeFetch({ GET: () => resp(200, { fields: { done: { booleanValue: true } } }) });
  assert.equal(await SW.run("snooze", { taskId: "t1" }, deps({ fetch: done })), "already-done");
  assert.deepEqual(done.calls.map((c) => c.method), ["GET"]);

  const gone = makeFetch({ GET: () => resp(404, {}) });
  assert.equal(await SW.run("snooze", { taskId: "t1" }, deps({ fetch: gone })), "gone");
  assert.deepEqual(gone.calls.map((c) => c.method), ["GET"]);

  const goneOnPatch = makeFetch({ GET: () => resp(200, { fields: {} }), PATCH: () => resp(404, {}) });
  assert.equal(await SW.run("snooze", { taskId: "t1" }, deps({ fetch: goneOnPatch })), "gone");
});

test("Posponer: errores de lectura o escritura lanzan", async () => {
  await assert.rejects(SW.run("snooze", { taskId: "t1" }, deps({ fetch: makeFetch({ GET: () => resp(500, {}) }) })), /get-500/);
  await assert.rejects(SW.run("snooze", { taskId: "t1" }, deps({ fetch: makeFetch({ GET: () => resp(200, { fields: {} }), PATCH: () => resp(403, {}) }) })), /patch-403/);
});

/* ---------- Entradas inválidas ---------- */
test("sin sesión, sin tarea o con una acción desconocida: lanza y no llama a Firestore", async () => {
  const f = makeFetch();
  await assert.rejects(SW.run("done", { taskId: "t1" }, deps({ fetch: f, readAuthRecord: async () => null })), /sin-sesion/);
  await assert.rejects(SW.run("done", {}, deps({ fetch: f })), /sin-tarea/);
  await assert.rejects(SW.run("done", null, deps({ fetch: f })), /sin-tarea/);
  await assert.rejects(SW.run("borrar", { taskId: "t1" }, deps({ fetch: f })), /accion-desconocida/);
  assert.equal(f.calls.length, 0);
});

/* ---------- Lectura de la sesión en IndexedDB ---------- */
// Simulación mínima de la API de IndexedDB (open → onsuccess → transaction → get → onsuccess).
function fakeIdb({ store = true, value = { uid: "u1" }, empty = false, openError = false, missingDb = false } = {}) {
  const seen = { key: null, closed: 0 };
  const db = {
    objectStoreNames: { contains: (n) => store && n === "firebaseLocalStorage" },
    transaction: () => ({ objectStore: () => ({ get: (k) => { seen.key = k; const r = {}; setTimeout(() => { r.result = empty ? undefined : { fbase_key: k, value }; r.onsuccess(); }); return r; } }) }),
    close: () => { seen.closed++; },
  };
  return {
    seen,
    open: (name) => {
      seen.name = name; const r = {};
      setTimeout(() => {
        if (missingDb) {                    // la base no existía: el navegador intenta crearla y avisa con onupgradeneeded
          r.onupgradeneeded({ target: { transaction: { abort() { seen.aborted = true; } } } });
          r.error = new Error("AbortError"); r.onerror();
        } else if (openError) { r.error = new Error("idb"); r.onerror(); }
        else { r.result = db; r.onsuccess(); }
      });
      return r;
    },
  };
}

test("readAuthRecordFromIndexedDB: lee el registro de Firebase Auth con su clave", async () => {
  const idb = fakeIdb({ value: { uid: "u1", stsTokenManager: { refreshToken: "R" } } });
  const rec = await SW.readAuthRecordFromIndexedDB(KEY, idb);
  assert.equal(rec.stsTokenManager.refreshToken, "R");
  assert.equal(idb.seen.name, "firebaseLocalStorageDb");
  assert.equal(idb.seen.key, "firebase:authUser:API-KEY:[DEFAULT]");
  assert.equal(idb.seen.closed, 1);
});

test("readAuthRecordFromIndexedDB: sin base, sin tabla o sin usuario devuelve null; un error de IndexedDB se propaga", async () => {
  assert.equal(await SW.readAuthRecordFromIndexedDB(KEY, null), null);
  assert.equal(await SW.readAuthRecordFromIndexedDB(KEY, fakeIdb({ store: false })), null);
  assert.equal(await SW.readAuthRecordFromIndexedDB(KEY, fakeIdb({ empty: true })), null);
  await assert.rejects(SW.readAuthRecordFromIndexedDB(KEY, fakeIdb({ openError: true })), /idb/);
});

test("readAuthRecordFromIndexedDB: si la base no existía NO la crea (aborta) y devuelve null", async () => {
  const idb = fakeIdb({ missingDb: true });
  assert.equal(await SW.readAuthRecordFromIndexedDB(KEY, idb), null);
  assert.equal(idb.seen.aborted, true);
});

/* ---------- El service worker real, cargado en un contexto simulado ---------- */
function loadServiceWorker({ fetchImpl, signedIn = true, windows = [] } = {}) {
  const listeners = {}, shown = [], pending = [], opened = [], skipped = { n: 0 }, claimed = { n: 0 };
  let background;
  const fetchFn = fetchImpl || makeFetch({ GET: () => resp(200, { fields: {} }) });
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    URLSearchParams, JSON, Date, Promise, setTimeout, encodeURIComponent, Error,
    firebase: { initializeApp() {}, messaging: () => ({ onBackgroundMessage: (cb) => { background = cb; } }) },
    registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); } },
    clients: { matchAll: async () => windows, openWindow: async (u) => { opened.push(u); }, claim: async () => { claimed.n++; } },
    skipWaiting: () => { skipped.n++; },
    fetch: fetchFn,
    indexedDB: fakeIdb({ value: record(-5000, Date.now()), empty: !signedIn }),   // el SW usa el reloj real: el token guardado ya venció
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...urls) => { for (const u of urls) if (u.startsWith("/")) vm.runInContext(fs.readFileSync(path.join("public", u), "utf8"), ctx); };
  vm.runInContext(fs.readFileSync("public/firebase-messaging-sw.js", "utf8"), ctx);

  // Dispara un clic en la notificación y espera a que termine lo que el SW dejó pendiente.
  async function click(action, data = { taskId: "t1", snoozeMin: 10, title: "⏰ Dentista" }) {
    const state = { closed: false };
    const event = { action, notification: { data, close() { state.closed = true; } }, waitUntil: (p) => pending.push(p) };
    listeners.notificationclick(event);
    await Promise.all(pending.splice(0));
    return state;
  }
  return { shown, opened, skipped, claimed, pending, fetch: fetchFn, background: (p) => background(p), click, listeners };
}

test("service worker: un aviso en segundo plano se muestra con botones y etiqueta", async () => {
  const sw = loadServiceWorker();
  await sw.background({ data: { title: "⏰ Dentista", body: "Ahora · 17:00", taskId: "t1", snoozeMin: "30" } });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "⏰ Dentista");
  assert.equal(sw.shown[0].opts.tag, "t1");
  assert.deepEqual(plain(sw.shown[0].opts.actions.map((a) => a.title)), ["✓ Hecho", "Posponer 30 min"]);
});

test("service worker: un mensaje sin título no muestra nada", async () => {
  const sw = loadServiceWorker();
  await sw.background({ data: {} });
  await sw.background({});
  assert.equal(sw.shown.length, 0);
});

test("service worker: el botón Hecho escribe en Firestore con la sesión del usuario y cierra la notificación", async () => {
  const sw = loadServiceWorker();
  const st = await sw.click("done");
  assert.equal(st.closed, true);
  assert.deepEqual(sw.fetch.calls.map((c) => c.method), ["POST", "PATCH"]);       // renueva el token (el guardado estaba vencido) y escribe
  assert.equal(sw.fetch.calls[1].headers.authorization, "Bearer FRESH");
  assert.deepEqual(fieldsOf(sw.fetch.calls[1]), { done: { booleanValue: true }, nagAt: { nullValue: null } });
  assert.equal(sw.shown.length, 0);                                                // sin errores: no se muestra nada más
});

test("service worker: el botón Posponer lee, reprograma y no abre la app", async () => {
  const sw = loadServiceWorker();
  await sw.click("snooze", { taskId: "t1", snoozeMin: 15, title: "⏰ Dentista" });
  assert.deepEqual(sw.fetch.calls.map((c) => c.method), ["POST", "GET", "PATCH"]);
  assert.equal(fieldsOf(sw.fetch.calls[2]).notified.booleanValue, false);
  assert.deepEqual(plain(sw.opened), []);
  assert.equal(sw.shown.length, 0);
});

test("service worker: si la acción falla se avisa para hacerlo desde la app", async () => {
  const sw = loadServiceWorker({ fetchImpl: makeFetch({ PATCH: () => resp(403, {}) }) });
  await sw.click("done");
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "No se pudo completar la acción");
  assert.match(sw.shown[0].opts.body, /Dentista/);
  assert.equal(sw.shown[0].opts.tag, "err-t1");
});

test("service worker: sin sesión guardada, la acción falla con aviso (no se pierde en silencio)", async () => {
  const sw = loadServiceWorker({ signedIn: false });
  await sw.click("done");
  assert.equal(sw.shown[0].title, "No se pudo completar la acción");
  assert.equal(sw.fetch.calls.length, 0);
});

test("service worker: tocar la notificación (sin botón) abre la app y no escribe nada", async () => {
  const sw = loadServiceWorker();
  const st = await sw.click("");
  assert.equal(st.closed, true);
  assert.deepEqual(plain(sw.opened), ["/"]);
  assert.equal(sw.fetch.calls.length, 0);
});

test("service worker: una versión nueva se instala y toma el control de inmediato", async () => {
  const sw = loadServiceWorker();
  sw.listeners.install({});
  assert.equal(sw.skipped.n, 1);
  sw.listeners.activate({ waitUntil: (p) => sw.pending.push(p) });
  await Promise.all(sw.pending.splice(0));
  assert.equal(sw.claimed.n, 1);
});

/* ---------- Resúmenes: notificación y "Mover a mañana" ---------- */
const NAME = (id) => `projects/${PID}/databases/(default)/documents/tasks/${id}`;
const taskDoc = (id, { time = "09:00", remindMin = 0 } = {}) => ({ document: { name: NAME(id), fields: { time: { stringValue: time }, remindMin: { integerValue: String(remindMin) }, done: { booleanValue: false } } } });
const withUid = (uid = "u1") => async () => ({ uid, stsTokenManager: { refreshToken: "REFRESH", accessToken: "CACHED", expirationTime: NOW + 3_600_000 } });
const localMs = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();

test("notificationOptions: el resumen de la mañana no lleva botones; el cierre del día lleva 'Mover a mañana'", () => {
  const am = SW.notificationOptions({ kind: "digest-morning", title: "☀️ Hoy tienes 3 pendientes", body: "…", date: "2026-10-09" });
  assert.equal(am.tag, "digest-morning");
  assert.equal(am.actions, undefined);
  assert.equal(am.renotify, true);
  assert.deepEqual(am.data, { kind: "digest-morning", date: "2026-10-09", title: "☀️ Hoy tienes 3 pendientes" });

  const pm = SW.notificationOptions({ kind: "digest-evening", title: "🌙 Cierre del día", body: "…", date: "2026-10-09" });
  assert.equal(pm.tag, "digest-evening");
  assert.deepEqual(pm.actions, [{ action: "move", title: "Mover a mañana" }]);
  assert.equal(pm.data.date, "2026-10-09");
});

test("notificationOptions: sin una fecha válida el cierre del día no ofrece mover (no se puede saber qué mover)", () => {
  for (const date of [undefined, "", "mañana", "2026-10-9"]) assert.equal(SW.notificationOptions({ kind: "digest-evening", title: "x", date }).actions, undefined, String(date));
});

test("Mover a mañana: consulta los pendientes sin hacer de ese día del usuario y los pasa al día siguiente en una sola escritura", async () => {
  const f = makeFetch({
    query: () => resp(200, [taskDoc("a", { time: "09:00", remindMin: 15 }), taskDoc("b", { time: "18:30", remindMin: 0 }), { readTime: "x" }]),
  });
  assert.equal(await SW.run("move", { date: "2026-10-09" }, deps({ fetch: f, readAuthRecord: withUid("u1") })), "moved:2");
  assert.deepEqual(f.calls.map((c) => c.method), ["POST", "POST"]);                       // consulta + commit
  const q = JSON.parse(f.calls[0].body).structuredQuery;
  const filters = q.where.compositeFilter.filters.map((x) => [x.fieldFilter.field.fieldPath, Object.values(x.fieldFilter.value)[0]]);
  assert.deepEqual(filters, [["uid", "u1"], ["date", "2026-10-09"], ["done", false]]);
  assert.equal(f.calls[0].headers.authorization, "Bearer CACHED");

  assert.match(f.calls[1].url, /documents:commit$/);
  const { writes } = JSON.parse(f.calls[1].body);
  assert.equal(writes.length, 2);
  const [a, b] = writes;
  assert.equal(a.update.name, NAME("a"));
  assert.deepEqual(a.currentDocument, { exists: true });                                    // no recrea nada borrado
  assert.equal(a.update.fields.date.stringValue, "2026-10-10");
  assert.equal(a.update.fields.remindAt.integerValue, String(localMs(2026, 10, 10, 9, 0) - 15 * 60_000));   // misma hora, menos la anticipación
  assert.equal(b.update.fields.remindAt.integerValue, String(localMs(2026, 10, 10, 18, 30)));
  for (const w of writes) {
    assert.equal(w.update.fields.notified.booleanValue, false);
    assert.deepEqual(w.update.fields.nagAt, { nullValue: null });
    assert.equal(w.update.fields.nagCount.integerValue, "0");
    assert.deepEqual(w.updateMask.fieldPaths.sort(), ["date", "nagAt", "nagCount", "notified", "remindAt"]);
  }
});

test("Mover a mañana: un pendiente sin aviso (remindMin -1) solo cambia de fecha", async () => {
  const f = makeFetch({ query: () => resp(200, [taskDoc("a", { time: "09:00", remindMin: -1 })]) });
  await SW.run("move", { date: "2026-10-09" }, deps({ fetch: f, readAuthRecord: withUid() }));
  const w = JSON.parse(f.calls[1].body).writes[0];
  assert.deepEqual(w.update.fields, { date: { stringValue: "2026-10-10" }, remindAt: { nullValue: null } });
  assert.deepEqual(w.updateMask.fieldPaths.sort(), ["date", "remindAt"]);
});

test("Mover a mañana: pasa bien de fin de mes, de fin de año y por febrero bisiesto", async () => {
  for (const [from, to] of [["2026-10-31", "2026-11-01"], ["2026-12-31", "2027-01-01"], ["2028-02-28", "2028-02-29"], ["2028-02-29", "2028-03-01"], ["2027-02-28", "2027-03-01"], ["2026-04-30", "2026-05-01"]]) {
    const f = makeFetch({ query: () => resp(200, [taskDoc("a", { time: "23:30", remindMin: 0 })]) });
    await SW.run("move", { date: from }, deps({ fetch: f, readAuthRecord: withUid() }));
    const w = JSON.parse(f.calls[1].body).writes[0];
    assert.equal(w.update.fields.date.stringValue, to, `${from} → ${to}`);
    const [y, m, d] = to.split("-").map(Number);
    assert.equal(w.update.fields.remindAt.integerValue, String(localMs(y, m, d, 23, 30)), `remindAt de ${to}`);
  }
});

test("Mover a mañana: sin pendientes no escribe nada", async () => {
  const f = makeFetch({ query: () => resp(200, [{ readTime: "x" }]) });
  assert.equal(await SW.run("move", { date: "2026-10-09" }, deps({ fetch: f, readAuthRecord: withUid() })), "moved:0");
  assert.deepEqual(f.calls.map((c) => c.method), ["POST"]);                                  // solo la consulta
});

test("Mover a mañana: errores de consulta o de escritura lanzan; sin sesión o sin fecha también", async () => {
  await assert.rejects(SW.run("move", { date: "2026-10-09" }, deps({ readAuthRecord: withUid(), fetch: makeFetch({ query: () => resp(403, {}) }) })), /query-403/);
  await assert.rejects(SW.run("move", { date: "2026-10-09" }, deps({ readAuthRecord: withUid(), fetch: makeFetch({ query: () => resp(200, [taskDoc("a")]), commit: () => resp(500, {}) }) })), /commit-500/);
  await assert.rejects(SW.run("move", { date: "2026-10-09" }, deps({ readAuthRecord: async () => null })), /sin-sesion/);
  await assert.rejects(SW.run("move", { date: "2026-10-09" }, deps({ readAuthRecord: async () => ({ stsTokenManager: { refreshToken: "R", accessToken: "A", expirationTime: NOW + 3_600_000 } }) })), /sin-sesion/);   // sin uid
  for (const date of [undefined, "", "mañana", "2026-10-9", "10/09/2026"]) await assert.rejects(SW.run("move", { date }, deps({ readAuthRecord: withUid() })), /fecha-invalida/, String(date));
  await assert.rejects(SW.run("move", null, deps()), /fecha-invalida/);
});

/* ---------- El service worker real con los resúmenes ---------- */
test("service worker: el cierre del día se muestra con el botón y el resumen de la mañana sin botones", async () => {
  const sw = loadServiceWorker();
  await sw.background({ data: { kind: "digest-evening", title: "🌙 Cierre del día", body: "Te quedaron 2 sin hacer: A, B", date: "2026-10-09", count: "2" } });
  await sw.background({ data: { kind: "digest-morning", title: "☀️ Hoy tienes 3 pendientes", body: "…", date: "2026-10-09", count: "3" } });
  assert.deepEqual(plain(sw.shown[0].opts.actions), [{ action: "move", title: "Mover a mañana" }]);
  assert.equal(sw.shown[1].opts.actions, undefined);
});

test("service worker: 'Mover a mañana' escribe y confirma con una notificación", async () => {
  const fetchImpl = makeFetch({ query: () => resp(200, [taskDoc("a"), taskDoc("b"), taskDoc("c")]) });
  const sw = loadServiceWorker({ fetchImpl });
  await sw.click("move", { kind: "digest-evening", date: "2026-10-09", title: "🌙 Cierre del día" });
  assert.deepEqual(sw.fetch.calls.map((c) => c.method), ["POST", "POST", "POST"]);          // renovar token + consulta + commit
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "Movidos a mañana");
  assert.match(sw.shown[0].opts.body, /3 pendientes pasaron a mañana/);
  assert.equal(sw.shown[0].opts.tag, "digest-evening");
});

test("service worker: 'Mover a mañana' con un solo pendiente y sin ninguno", async () => {
  const one = loadServiceWorker({ fetchImpl: makeFetch({ query: () => resp(200, [taskDoc("a")]) }) });
  await one.click("move", { kind: "digest-evening", date: "2026-10-09" });
  assert.match(one.shown[0].opts.body, /1 pendiente pasó a mañana/);
  const none = loadServiceWorker({ fetchImpl: makeFetch({ query: () => resp(200, [{}]) }) });
  await none.click("move", { kind: "digest-evening", date: "2026-10-09" });
  assert.equal(none.shown[0].title, "No había pendientes que mover");
});

test("service worker: si 'Mover a mañana' falla se avisa para hacerlo desde la app", async () => {
  const sw = loadServiceWorker({ fetchImpl: makeFetch({ query: () => resp(200, [taskDoc("a")]), commit: () => resp(403, {}) }) });
  await sw.click("move", { kind: "digest-evening", date: "2026-10-09" });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "No se pudo completar la acción");
  assert.match(sw.shown[0].opts.body, /mueve los pendientes desde la app/);
});

test("service worker: tocar un resumen abre la vista Hoy (y si ya hay una ventana, la lleva allí)", async () => {
  const sw = loadServiceWorker();
  await sw.click("", { kind: "digest-morning", date: "2026-10-09" });
  assert.deepEqual(plain(sw.opened), ["/?view=today"]);
  assert.equal(sw.fetch.calls.length, 0);

  const withWindow = loadServiceWorker({ windows: [{ focus: async () => {}, navigate: async function (u) { navigated.push(u); return this; } }] });
  const navigated = [];
  await withWindow.click("", { kind: "digest-evening", date: "2026-10-09" });
  assert.deepEqual(navigated, ["/?view=today"]);
  assert.deepEqual(plain(withWindow.opened), []);
});

test("service worker: tocar un aviso normal con una ventana abierta solo la enfoca (no recarga lo que estás haciendo)", async () => {
  let focused = 0, navigated = 0;
  const sw = loadServiceWorker({ windows: [{ focus: async () => { focused++; }, navigate: async () => { navigated++; } }] });
  await sw.click("", { taskId: "t1", title: "⏰ X" });
  assert.equal(focused, 1);
  assert.equal(navigated, 0);
});
