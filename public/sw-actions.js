// Acciones de la notificación ("Hecho" y "Posponer") que se ejecutan en el service worker, con la app cerrada.
// En vez de un endpoint público, usa la sesión que Firebase Auth ya guarda en IndexedDB: obtiene un token con el token
// de refresco y escribe en Firestore con las mismas reglas de seguridad que la app (no puede hacer nada que tu sesión no pueda).
// Se carga con importScripts en firebase-messaging-sw.js y también como módulo de Node (tests/client/sw-actions.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SWActions = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const SNOOZE_OPTIONS = [5, 10, 15, 30, 60];
  const DEFAULT_SNOOZE = 10;

  const snoozeMinutes = (v) => (SNOOZE_OPTIONS.includes(Number(v)) ? Number(v) : DEFAULT_SNOOZE);
  const snoozeLabel = (min) => (min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`);

  function actionButtons(snoozeMin) {
    return [
      { action: "done", title: "✓ Hecho" },
      { action: "snooze", title: `Posponer ${snoozeLabel(snoozeMinutes(snoozeMin))}` },
    ];
  }

  // Opciones de showNotification a partir de los datos que manda el Worker.
  function notificationOptions(d) {
    const opts = { body: d.body || "", icon: "/icon-192.png", requireInteraction: true };
    // Resúmenes: una sola notificación de cada tipo (la de hoy reemplaza a la de ayer si sigue ahí).
    if (d.kind === "digest-morning" || d.kind === "digest-evening") {
      opts.tag = d.kind;
      opts.renotify = true;
      opts.data = { kind: d.kind, date: d.date, title: d.title };
      if (d.kind === "digest-evening" && /^\d{4}-\d{2}-\d{2}$/.test(d.date || "")) opts.actions = [{ action: "move", title: "Mover a mañana" }];
      return opts;
    }
    if (d.taskId) {
      opts.tag = d.taskId;            // una insistencia reemplaza a la anterior del mismo pendiente
      opts.renotify = true;           // pero vuelve a sonar/vibrar
      opts.actions = actionButtons(d.snoozeMin);
      opts.data = { taskId: d.taskId, snoozeMin: snoozeMinutes(d.snoozeMin), title: d.title };
    }
    return opts;
  }

  /* ---------- Sesión de Firebase Auth (IndexedDB) ---------- */
  // Lee el registro del usuario que guarda Firebase Auth: { stsTokenManager: { refreshToken, accessToken, expirationTime }, ... }
  function readAuthRecordFromIndexedDB(apiKey, idb) {
    idb = idb || (typeof indexedDB !== "undefined" ? indexedDB : null);
    return new Promise((resolve, reject) => {
      if (!idb) return resolve(null);
      const open = idb.open("firebaseLocalStorageDb");
      // Si la base no existía, abrirla la crearía vacía y le rompería la persistencia a Firebase Auth: se aborta la creación.
      let missing = false;
      open.onupgradeneeded = (e) => { missing = true; try { e.target.transaction.abort(); } catch (_) { /* nada */ } };
      open.onerror = () => (missing ? resolve(null) : reject(open.error));
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("firebaseLocalStorage")) { db.close(); return resolve(null); }
        const req = db.transaction("firebaseLocalStorage", "readonly").objectStore("firebaseLocalStorage").get(`firebase:authUser:${apiKey}:[DEFAULT]`);
        req.onerror = () => { db.close(); reject(req.error); };
        req.onsuccess = () => { db.close(); resolve(req.result ? req.result.value : null); };
      };
    });
  }

  // Token de acceso vigente: el guardado si aún sirve; si no, uno nuevo con el token de refresco.
  async function getIdToken(record, deps) {
    const stm = record && record.stsTokenManager;
    if (!stm || !stm.refreshToken) throw new Error("sin-sesion");
    if (stm.accessToken && Number(stm.expirationTime) - deps.now() > 60_000) return stm.accessToken;
    const res = await deps.fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(deps.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stm.refreshToken }).toString(),
    });
    if (!res.ok) throw new Error(`token-${res.status}`);
    const j = await res.json();
    if (!j.id_token) throw new Error("token-vacio");
    return j.id_token;
  }

  /* ---------- Acciones ---------- */
  const nul = () => ({ nullValue: null });
  const FS = (pid) => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;

  // Mueve a mañana todos los pendientes sin hacer de `data.date` (el cierre del día): nueva fecha, el aviso se reprograma a la misma
  // hora de mañana, y la cadena de insistencias se reinicia. Una sola escritura atómica (commit), con las reglas del usuario.
  async function moveToTomorrow(data, deps) {
    const date = data && data.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("fecha-invalida");
    const record = await (deps.readAuthRecord ? deps.readAuthRecord(deps.apiKey) : readAuthRecordFromIndexedDB(deps.apiKey));
    const token = await getIdToken(record, deps);
    if (!record.uid) throw new Error("sin-sesion");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const base = FS(deps.projectId);

    const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value } });
    const q = await deps.fetch(`${base}:runQuery`, {
      method: "POST", headers,
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: "tasks" }],
        where: { compositeFilter: { op: "AND", filters: [eq("uid", { stringValue: record.uid }), eq("date", { stringValue: date }), eq("done", { booleanValue: false })] } },
        limit: 200,
      } }),
    });
    if (!q.ok) throw new Error(`query-${q.status}`);
    const docs = (await q.json()).filter((r) => r.document).map((r) => r.document);
    if (!docs.length) return "moved:0";

    const [y, m, d] = date.split("-").map(Number);
    const t = new Date(y, m - 1, d + 1);                               // el día siguiente en el calendario
    const pad = (n) => String(n).padStart(2, "0");
    const tomorrow = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;

    const writes = docs.map((doc) => {
      const f = doc.fields || {};
      const [hh, mm] = String(f.time && f.time.stringValue || "00:00").split(":").map(Number);
      const remindMin = Number(f.remindMin && f.remindMin.integerValue);
      const remindAt = remindMin >= 0 ? new Date(t.getFullYear(), t.getMonth(), t.getDate(), hh, mm).getTime() - remindMin * 60_000 : null;
      const fields = { date: { stringValue: tomorrow }, remindAt: remindAt === null ? nul() : { integerValue: String(remindAt) } };
      if (remindAt !== null) Object.assign(fields, { notified: { booleanValue: false }, nagAt: nul(), nagCount: { integerValue: "0" } });
      return { update: { name: doc.name, fields }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { exists: true } };
    });
    const res = await deps.fetch(`${base}:commit`, { method: "POST", headers, body: JSON.stringify({ writes }) });
    if (!res.ok) throw new Error(`commit-${res.status}`);
    return `moved:${writes.length}`;
  }

  // Devuelve "done" | "snoozed" | "already-done" | "gone" | "moved:N"; lanza error si no se pudo.
  async function run(action, data, deps) {
    if (action === "move") return moveToTomorrow(data, deps);
    if (!data || !data.taskId) throw new Error("sin-tarea");
    if (action !== "done" && action !== "snooze") throw new Error("accion-desconocida");

    const record = await (deps.readAuthRecord ? deps.readAuthRecord(deps.apiKey) : readAuthRecordFromIndexedDB(deps.apiKey));
    const token = await getIdToken(record, deps);
    const headers = { authorization: `Bearer ${token}` };
    const url = `${FS(deps.projectId)}/tasks/${encodeURIComponent(data.taskId)}`;

    const patch = async (fields) => {
      const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join("&");
      const res = await deps.fetch(`${url}?${mask}&currentDocument.exists=true`, {
        method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ fields }),
      });
      if (res.status === 404) return "gone";          // el pendiente ya no existe
      if (!res.ok) throw new Error(`patch-${res.status}`);
      return "ok";
    };

    if (action === "done") {
      // Igual que la casilla de la app: marca hecho y corta la cadena de insistencias.
      const r = await patch({ done: { booleanValue: true }, nagAt: nul() });
      return r === "gone" ? "gone" : "done";
    }

    // Posponer: se lee antes por si ya se completó o se borró mientras tanto.
    const cur = await deps.fetch(url, { headers });
    if (cur.status === 404) return "gone";
    if (!cur.ok) throw new Error(`get-${cur.status}`);
    if ((await cur.json()).fields?.done?.booleanValue === true) return "already-done";

    const minutes = snoozeMinutes(data.snoozeMin);
    // Reprograma el aviso (como cambiar la hora desde la app): vuelve a armarlo y reinicia las insistencias.
    const r = await patch({
      remindAt: { integerValue: String(deps.now() + minutes * 60_000) },
      notified: { booleanValue: false },
      nagAt: nul(),
      nagCount: { integerValue: "0" },
    });
    return r === "gone" ? "gone" : "snoozed";
  }

  return { SNOOZE_OPTIONS, DEFAULT_SNOOZE, snoozeMinutes, snoozeLabel, actionButtons, notificationOptions, readAuthRecordFromIndexedDB, getIdToken, run };
});
