// Pruebas de firestore.rules con el emulador. Ejecutar con: npm run test:rules
const { test, before, after, beforeEach } = require("node:test");
const { readFileSync } = require("node:fs");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, query, where, serverTimestamp } = require("firebase/firestore");

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-miagenda",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const alice = () => env.authenticatedContext("alice").firestore();
const bob = () => env.authenticatedContext("bob").firestore();
const anon = () => env.unauthenticatedContext().firestore();

// Un pendiente válido; `over` sobrescribe campos. createdAt usa la hora del servidor, como la app.
const task = (over = {}) => ({
  uid: "alice", title: "Dentista", date: "2026-10-15", time: "09:30",
  remindMin: 15, remindAt: 1760517000000, notified: false, done: false,
  createdAt: serverTimestamp(), ...over,
});

// Inserta un documento saltándose las reglas (lo que haría el Worker o datos previos).
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
}
const seedTask = (id = "t1", over = {}) => seed(`tasks/${id}`, { ...task(over), createdAt: new Date("2026-10-01T00:00:00Z") });

/* ---------- tasks: crear ---------- */
test("tasks: el dueño puede crear un pendiente válido", async () => {
  await assertSucceeds(setDoc(doc(alice(), "tasks/t1"), task()));
});

test("tasks: remindMin -1 con remindAt null es válido (sin aviso)", async () => {
  await assertSucceeds(setDoc(doc(alice(), "tasks/t1"), task({ remindMin: -1, remindAt: null })));
});

test("tasks: no se puede crear sin sesión ni a nombre de otro usuario", async () => {
  await assertFails(setDoc(doc(anon(), "tasks/t1"), task()));
  await assertFails(setDoc(doc(bob(), "tasks/t1"), task()));   // uid: "alice" desde la sesión de bob
});

const invalidCreates = {
  "título vacío": { title: "" },
  "título de 121 caracteres": { title: "x".repeat(121) },
  "título que no es texto": { title: 123 },
  "fecha con formato incorrecto": { date: "15/10/2026" },
  "hora fuera de rango": { time: "24:00" },
  "hora sin cero": { time: "9:30" },
  "remindMin no permitido": { remindMin: 7 },
  "remindMin -1 con remindAt numérico": { remindMin: -1 },
  "remindMin 15 con remindAt null": { remindAt: null },
  "remindAt que no es entero": { remindAt: "mañana" },
  "notified true desde el cliente": { notified: true },
  "done que no es booleano": { done: "no" },
  "createdAt con hora del cliente": { createdAt: new Date() },
  "campo extra": { admin: true },
};
for (const [name, over] of Object.entries(invalidCreates)) {
  test(`tasks: se rechaza crear con ${name}`, async () => {
    await assertFails(setDoc(doc(alice(), "tasks/t1"), task(over)));
  });
}

test("tasks: se rechaza crear sin un campo obligatorio", async () => {
  const { time, ...sinHora } = task();
  await assertFails(setDoc(doc(alice(), "tasks/t1"), sinHora));
});

/* ---------- tasks: leer ---------- */
test("tasks: el dueño lee su pendiente y la consulta por uid funciona", async () => {
  await seedTask();
  await assertSucceeds(getDoc(doc(alice(), "tasks/t1")));
  await assertSucceeds(getDocs(query(collection(alice(), "tasks"), where("uid", "==", "alice"), where("date", ">=", "2026-10-01"), where("date", "<=", "2026-10-31"))));
});

test("tasks: otro usuario o sin sesión no puede leer", async () => {
  await seedTask();
  await assertFails(getDoc(doc(bob(), "tasks/t1")));
  await assertFails(getDoc(doc(anon(), "tasks/t1")));
});

test("tasks: no se puede listar sin filtrar por el propio uid", async () => {
  await seedTask();
  await assertFails(getDocs(collection(alice(), "tasks")));
  await assertFails(getDocs(query(collection(bob(), "tasks"), where("uid", "==", "alice"))));
});

/* ---------- tasks: actualizar ---------- */
test("tasks: el dueño puede marcar done", async () => {
  await seedTask();
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { done: true }));
});

const invalidUpdates = {
  "cambiar notified": { notified: true },
  "cambiar uid a otro usuario": { uid: "bob" },
  "cambiar createdAt": { createdAt: new Date() },
  "dejar el título vacío": { title: "" },
  "remindMin inválido": { remindMin: 7 },
  "añadir un campo extra": { admin: true },
};
for (const [name, over] of Object.entries(invalidUpdates)) {
  test(`tasks: se rechaza actualizar con ${name}`, async () => {
    await seedTask();
    await assertFails(updateDoc(doc(alice(), "tasks/t1"), over));
  });
}

test("tasks: el dueño puede editar título, fecha, hora y aviso a la vez", async () => {
  await seedTask();
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), {
    title: "Dentista (reprogramado)", date: "2026-10-20", time: "11:00", remindMin: 30, remindAt: 1760947800000,
  }));
});

test("tasks: el dueño puede quitar el aviso de un pendiente", async () => {
  await seedTask();
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { remindMin: -1, remindAt: null }));
});

test("tasks: al reprogramar un aviso ya enviado se puede volver a armar notified", async () => {
  await seedTask("t1", { notified: true });
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), {
    time: "18:00", remindAt: 1760547600000, notified: false,
  }));
});

test("tasks: no se puede volver a armar notified sin reprogramar (mismo remindAt)", async () => {
  await seedTask("t1", { notified: true });
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { notified: false }));
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { title: "otro", notified: false }));
});

test("tasks: reprogramar no permite marcar notified en true", async () => {
  await seedTask();
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { remindAt: 1760547600000, notified: true }));
});

test("tasks: editar con remindMin y remindAt inconsistentes se rechaza", async () => {
  await seedTask();
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { remindMin: -1 }));          // remindAt sigue numérico
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { remindMin: 5, remindAt: null }));
});

test("tasks: editar con fecha u hora inválidas se rechaza", async () => {
  await seedTask();
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { date: "mañana" }));
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { time: "25:00" }));
});

test("tasks: otro usuario o sin sesión no puede actualizar", async () => {
  await seedTask();
  await assertFails(updateDoc(doc(bob(), "tasks/t1"), { done: true }));
  await assertFails(updateDoc(doc(anon(), "tasks/t1"), { done: true }));
});

/* ---------- tasks: borrar ---------- */
test("tasks: solo el dueño puede borrar", async () => {
  await seedTask();
  await assertFails(deleteDoc(doc(bob(), "tasks/t1")));
  await assertFails(deleteDoc(doc(anon(), "tasks/t1")));
  await assertSucceeds(deleteDoc(doc(alice(), "tasks/t1")));
});

/* ---------- tokens ---------- */
const token = (over = {}) => ({ uid: "alice", ua: "Mozilla/5.0", updatedAt: serverTimestamp(), ...over });

test("tokens: el dueño puede crear, actualizar, leer y borrar el suyo", async () => {
  await assertSucceeds(setDoc(doc(alice(), "tokens/tok1"), token()));
  await assertSucceeds(setDoc(doc(alice(), "tokens/tok1"), token()));
  await assertSucceeds(getDoc(doc(alice(), "tokens/tok1")));
  await assertSucceeds(deleteDoc(doc(alice(), "tokens/tok1")));
});

test("tokens: no se puede crear sin sesión ni con el uid de otro", async () => {
  await assertFails(setDoc(doc(anon(), "tokens/tok1"), token()));
  await assertFails(setDoc(doc(bob(), "tokens/tok1"), token()));
});

const invalidTokens = {
  "campo extra": { role: "admin" },
  "ua de más de 120 caracteres": { ua: "x".repeat(121) },
  "ua que no es texto": { ua: 5 },
  "updatedAt con hora del cliente": { updatedAt: new Date() },
};
for (const [name, over] of Object.entries(invalidTokens)) {
  test(`tokens: se rechaza escribir con ${name}`, async () => {
    await assertFails(setDoc(doc(alice(), "tokens/tok1"), token(over)));
  });
}

test("tokens: otro usuario no puede leer ni borrar el token ajeno", async () => {
  await seed("tokens/tok1", { uid: "alice", ua: "x", updatedAt: new Date() });
  await assertFails(getDoc(doc(bob(), "tokens/tok1")));
  await assertFails(deleteDoc(doc(bob(), "tokens/tok1")));
});

/* ---------- el resto está denegado ---------- */
test("cualquier otra colección está denegada", async () => {
  await assertFails(setDoc(doc(alice(), "otra/x"), { a: 1 }));
  await assertFails(getDoc(doc(alice(), "otra/x")));
});

/* ---------- users (preferencias) ---------- */
test("users: el dueño puede crear, actualizar y leer sus preferencias", async () => {
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), { timeFormat: "12" }));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), { timeFormat: "24" }, { merge: true }));
  await assertSucceeds(updateDoc(doc(alice(), "users/alice"), { timeFormat: "12" }));
  await assertSucceeds(getDoc(doc(alice(), "users/alice")));
});

const invalidPrefs = {
  "un formato desconocido": { timeFormat: "13" },
  "un número en vez de texto": { timeFormat: 12 },
  "un campo extra": { timeFormat: "12", isAdmin: true },
  "sin timeFormat": {},
};
for (const [name, data] of Object.entries(invalidPrefs)) {
  test(`users: se rechaza guardar ${name}`, async () => {
    await assertFails(setDoc(doc(alice(), "users/alice"), data));
  });
}

test("users: nadie puede leer ni escribir las preferencias de otra cuenta", async () => {
  await seed("users/alice", { timeFormat: "12" });
  await assertFails(getDoc(doc(bob(), "users/alice")));
  await assertFails(setDoc(doc(bob(), "users/alice"), { timeFormat: "24" }));
  await assertFails(updateDoc(doc(bob(), "users/alice"), { timeFormat: "24" }));
  await assertFails(setDoc(doc(bob(), "users/bob2"), { timeFormat: "24" }));   // ni crear con un id que no es el suyo
});

test("users: sin sesión no hay acceso, y las preferencias no se pueden borrar desde el cliente", async () => {
  await seed("users/alice", { timeFormat: "12" });
  await assertFails(getDoc(doc(anon(), "users/alice")));
  await assertFails(setDoc(doc(anon(), "users/alice"), { timeFormat: "24" }));
  await assertFails(deleteDoc(doc(alice(), "users/alice")));
});

/* ---------- insistencia ---------- */
test("tasks: se puede crear con insistencia (nagMin) y la cadena vacía", async () => {
  await assertSucceeds(setDoc(doc(alice(), "tasks/t1"), task({ nagMin: 10, nagAt: null, nagCount: 0 })));
  await assertSucceeds(setDoc(doc(alice(), "tasks/t2"), task({ nagMin: 0 })));
});

const invalidNagCreates = {
  "nagMin que no es una opción": { nagMin: 7 },
  "nagMin que no es número": { nagMin: "10" },
  "una cadena ya programada (nagAt)": { nagMin: 10, nagAt: 1760517600000 },
  "nagCount distinto de cero": { nagMin: 10, nagCount: 1 },
  "nagCount negativo": { nagMin: 10, nagCount: -1 },
  "nagAt que no es número": { nagMin: 10, nagAt: "pronto" },
};
for (const [name, over] of Object.entries(invalidNagCreates)) {
  test(`tasks: se rechaza crear con ${name}`, async () => {
    await assertFails(setDoc(doc(alice(), "tasks/t1"), task(over)));
  });
}

test("tasks: un pendiente anterior (sin campos de insistencia) sigue pudiéndose editar y completar", async () => {
  await seedTask();
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { done: true, nagAt: null }));
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { nagMin: 15 }));
});

test("tasks: con una cadena en curso, el cliente puede cortarla y seguir editando", async () => {
  await seedTask("t1", { notified: true, nagMin: 10, nagAt: 1760517600000, nagCount: 2 });
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { title: "Otro título" }));            // no toca la cadena
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { done: true, nagAt: null }));         // marcar como hecho
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { nagAt: null, nagCount: 0 }));        // reiniciarla al editar
});

test("tasks: el cliente no puede programar ni mover la cadena de insistencias", async () => {
  await seedTask("t1", { notified: true, nagMin: 10, nagAt: 1760517600000, nagCount: 2 });
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { nagAt: 1760999999999 }));               // otra hora
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { nagCount: 5 }));                        // otro contador
  await seedTask("t2", { notified: true });                                                       // sin cadena
  await assertFails(updateDoc(doc(alice(), "tasks/t2"), { nagAt: 1760999999999 }));               // programar una de la nada
});

test("tasks: nagMin inválido al editar se rechaza", async () => {
  await seedTask();
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { nagMin: 7 }));
});

/* ---------- users: máximo de insistencias ---------- */
test("users: nagMax acepta 3, 5, 10 y 20, solo o junto con timeFormat", async () => {
  for (const n of [3, 5, 10, 20]) await assertSucceeds(setDoc(doc(alice(), "users/alice"), { nagMax: n }));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), { timeFormat: "12", nagMax: 10 }));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), { nagMax: 20 }, { merge: true }));
});

test("users: se rechaza un nagMax fuera de las opciones o que no es número", async () => {
  await assertFails(setDoc(doc(alice(), "users/alice"), { nagMax: 7 }));
  await assertFails(setDoc(doc(alice(), "users/alice"), { nagMax: "5" }));
  await assertFails(setDoc(doc(alice(), "users/alice"), { nagMax: 0 }));
  await assertFails(setDoc(doc(alice(), "users/alice"), { nagMax: 1000 }));
});

/* ---------- users: duración de "Posponer" ---------- */
test("users: snoozeMin acepta 5, 10, 15, 30 y 60, solo o junto con las demás preferencias", async () => {
  for (const n of [5, 10, 15, 30, 60]) await assertSucceeds(setDoc(doc(alice(), "users/alice"), { snoozeMin: n }));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), { timeFormat: "12", nagMax: 10, snoozeMin: 30 }));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), { snoozeMin: 15 }, { merge: true }));
});

test("users: se rechaza un snoozeMin fuera de las opciones o que no es número", async () => {
  for (const bad of [0, 7, 45, 120, "10", -5, null]) await assertFails(setDoc(doc(alice(), "users/alice"), { snoozeMin: bad }));
});

/* ---------- lo que escribe el service worker con la sesión del usuario ---------- */
// "Hecho" y "Posponer" desde la notificación son escrituras de cliente: pasan por estas mismas reglas.
test("notificación → Hecho: done true y nagAt null sobre un pendiente ya avisado con insistencias en curso", async () => {
  await seedTask("t1", { notified: true, nagMin: 10, nagAt: 1760517600000, nagCount: 2 });
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { done: true, nagAt: null }));
});

test("notificación → Posponer: remindAt nuevo, notified false, nagAt null y nagCount 0", async () => {
  await seedTask("t1", { notified: true, nagMin: 10, nagAt: 1760517600000, nagCount: 2 });
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { remindAt: 1760999999000, notified: false, nagAt: null, nagCount: 0 }));
});

test("notificación → Posponer sobre un pendiente sin insistencias (anterior a esa función)", async () => {
  await seedTask("t1", { notified: true });
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { remindAt: 1760999999000, notified: false, nagAt: null, nagCount: 0 }));
});

test("notificación: otra cuenta no puede marcar hecho ni posponer los pendientes ajenos", async () => {
  await seedTask("t1", { notified: true });
  await assertFails(updateDoc(doc(bob(), "tasks/t1"), { done: true, nagAt: null }));
  await assertFails(updateDoc(doc(bob(), "tasks/t1"), { remindAt: 1760999999000, notified: false, nagAt: null, nagCount: 0 }));
  await assertFails(updateDoc(doc(anon(), "tasks/t1"), { done: true, nagAt: null }));
});

test("posponer no permite dejar remindAt en null con un remindMin de aviso (la regla de consistencia sigue vigente)", async () => {
  await seedTask("t1", { notified: true });
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { remindAt: null, notified: false }));
});

/* ---------- users: resúmenes (mañana / cierre del día) ---------- */
const digestDoc = (over = {}) => ({ tz: "America/Mexico_City", digestMorning: "08:00", digestEvening: "21:00", nextDigestAt: 1791540000000, ...over });

test("users: se puede activar y configurar el resumen de la mañana y el cierre del día", async () => {
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), digestDoc()));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), digestDoc({ digestEvening: null })));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), digestDoc({ digestMorning: null, digestEvening: null, nextDigestAt: null })));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), { timeFormat: "12", nagMax: 10, snoozeMin: 30, ...digestDoc() }));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), { digestMorning: "05:30" }, { merge: true }));
});

test("users: las horas de los resúmenes deben ser HH:MM válidas (o null)", async () => {
  for (const bad of ["25:00", "8:00", "08:60", "08:0", "ocho", "", "24:00", 800, true]) {
    await assertFails(setDoc(doc(alice(), "users/alice"), digestDoc({ digestMorning: bad })));
    await assertFails(setDoc(doc(alice(), "users/alice"), digestDoc({ digestEvening: bad })));
  }
});

test("users: zona horaria y nextDigestAt con tipos correctos", async () => {
  await assertFails(setDoc(doc(alice(), "users/alice"), digestDoc({ tz: 5 })));
  await assertFails(setDoc(doc(alice(), "users/alice"), digestDoc({ tz: "x".repeat(65) })));
  await assertSucceeds(setDoc(doc(alice(), "users/alice"), digestDoc({ tz: "x".repeat(64) })));
  await assertFails(setDoc(doc(alice(), "users/alice"), digestDoc({ nextDigestAt: "mañana" })));
  await assertFails(setDoc(doc(alice(), "users/alice"), digestDoc({ nextDigestAt: 1.5 })));
});

test("users: los resúmenes siguen sin admitir campos desconocidos ni acceso ajeno", async () => {
  await assertFails(setDoc(doc(alice(), "users/alice"), digestDoc({ digestNoon: "12:00" })));
  await seed("users/alice", digestDoc());
  await assertFails(getDoc(doc(bob(), "users/alice")));
  await assertFails(setDoc(doc(bob(), "users/alice"), digestDoc({ digestMorning: null })));
  await assertFails(setDoc(doc(anon(), "users/alice"), digestDoc()));
});

/* ---------- lo que escribe el service worker al "Mover a mañana" ---------- */
test("notificación → Mover a mañana: nueva fecha, nuevo remindAt, notified false y la cadena reiniciada", async () => {
  await seedTask("t1", { notified: true, nagMin: 10, nagAt: 1760517600000, nagCount: 2 });
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { date: "2026-10-16", remindAt: 1761000000000, notified: false, nagAt: null, nagCount: 0 }));
});

test("notificación → Mover a mañana un pendiente sin aviso: solo cambia la fecha (remindAt sigue null)", async () => {
  await seedTask("t1", { remindMin: -1, remindAt: null });
  await assertSucceeds(updateDoc(doc(alice(), "tasks/t1"), { date: "2026-10-16", remindAt: null }));
});

test("mover una tarea de otra cuenta se rechaza, y una fecha mal formada también", async () => {
  await seedTask("t1");
  await assertFails(updateDoc(doc(bob(), "tasks/t1"), { date: "2026-10-16" }));
  await assertFails(updateDoc(doc(alice(), "tasks/t1"), { date: "mañana" }));
});
