// Simulador compartido de Firestore y FCM en memoria, con reloj virtual, para las pruebas del Worker.
import assert from "node:assert/strict";

export const PID = "demo";
export const ENV = { SERVICE_ACCOUNT: JSON.stringify({ project_id: PID, client_email: "w@demo.iam", private_key: "no-se-usa" }) };
export const T0 = Date.UTC(2026, 9, 8, 16, 30, 0) + 51_000;   // el cron corre al segundo :51

export const val = (v) => (v === null ? { nullValue: null } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? { integerValue: String(v) } : { stringValue: v });

export function makeWorld(start = T0) {
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
      const coll = q.from[0].collectionId, store = coll === "tasks" ? tasks : coll === "users" ? users : tokens;
      let rows = [...store].filter(([, d]) => !q.where || matches(d, q.where));
      if (q.orderBy) {
        const f = q.orderBy[0].field.fieldPath;
        rows.sort((x, y) => fieldVal(x[1].fields[f]) - fieldVal(y[1].fields[f]));
      }
      if (q.limit) rows = rows.slice(0, q.limit);
      return json(200, rows.length ? rows.map(([id, d]) => ({ document: asDoc(coll, id, d) })) : [{}]);
    }
    if (u.hostname === "fcm.googleapis.com") {
      const m = JSON.parse(init.body).message;
      sends.push({ at: t, token: m.token, title: m.data.title, body: m.data.body, data: m.data, message: m, ttl: m.webpush.headers.TTL });
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
    addUser(uid, timeFormat, nagMax, snoozeMin) {
      const fields = { timeFormat: val(timeFormat) };
      if (nagMax !== undefined) fields.nagMax = val(nagMax);
      if (snoozeMin !== undefined) fields.snoozeMin = val(snoozeMin);
      users.set(uid, { updateTime: stamp(), fields });
    },
    // Usuario con resúmenes (users/{uid}); null desactiva uno de los dos.
    addDigestUser(uid, { tz = "America/Mexico_City", morning = null, evening = null, nextDigestAt = null, timeFormat = "24" } = {}) {
      users.set(uid, { updateTime: stamp(), fields: {
        tz: val(tz), digestMorning: val(morning), digestEvening: val(evening), nextDigestAt: val(nextDigestAt), timeFormat: val(timeFormat),
      } });
    },
    userField: (uid, name) => { const f = users.get(uid).fields[name]; return f === undefined ? undefined : f.nullValue !== undefined ? null : (f.stringValue ?? Number(f.integerValue)); },
    editUser(uid, changes) { const d = users.get(uid); for (const [k, v] of Object.entries(changes)) d.fields[k] = val(v); d.updateTime = "e" + stamp(); },
    field: (id, name) => { const f = tasks.get(id).fields[name]; return f === undefined ? undefined : f.nullValue !== undefined ? null : (f.booleanValue ?? Number(f.integerValue)); },
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
    addTask(id, { due = 0, uid = "u1", title = "Reunión", time = "10:30", date, remindMin = 0, notified = false, done = false, nagMin, nagAt, nagCount }) {
      const fields = {
        uid: val(uid), title: val(title), time: val(time), remindMin: val(remindMin), remindAt: val(due),
        notified: val(notified), done: val(done),
      };
      if (date !== undefined) fields.date = val(date);
      if (nagMin !== undefined) fields.nagMin = val(nagMin);
      if (nagAt !== undefined) fields.nagAt = val(nagAt);
      if (nagCount !== undefined) fields.nagCount = val(nagCount);
      tasks.set(id, { updateTime: stamp(), fields });
    },
    // Una tarea que ya avisó y está en medio de una cadena de insistencias.
    addNag(id, { nagAt, nagMin = 10, nagCount = 0, ...rest }) {
      this.addTask(id, { due: nagAt - 3_600_000, notified: true, nagMin, nagAt, nagCount, ...rest });
    },
    // Simula una edición del usuario durante la espera.
    edit(id, changes) { const d = tasks.get(id); for (const [k, v] of Object.entries(changes)) d.fields[k] = val(v); d.updateTime = "e" + stamp(); },
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
