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
function loadServiceWorker({ fetchImpl, signedIn = true } = {}) {
  const listeners = {}, shown = [], pending = [], opened = [], skipped = { n: 0 }, claimed = { n: 0 };
  let background;
  const fetchFn = fetchImpl || makeFetch({ GET: () => resp(200, { fields: {} }) });
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    URLSearchParams, JSON, Date, Promise, setTimeout, encodeURIComponent, Error,
    firebase: { initializeApp() {}, messaging: () => ({ onBackgroundMessage: (cb) => { background = cb; } }) },
    registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); } },
    clients: { matchAll: async () => [], openWindow: async (u) => { opened.push(u); }, claim: async () => { claimed.n++; } },
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
