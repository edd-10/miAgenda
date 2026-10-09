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
