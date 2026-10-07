firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const messaging = firebase.messaging.isSupported() ? firebase.messaging() : null;

const $ = (id) => document.getElementById(id);
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

let user = null;
let tasks = [];            // todos los pendientes del usuario
let unsubTasks = null;
let view = new Date(); view.setDate(1);
let selectedDate = null;   // "YYYY-MM-DD"
let fcmToken = null;       // token de este dispositivo (si los avisos están activos)
let lastFocus = null;      // elemento que abrió el modal, para devolverle el foco
let editingId = null;      // id del pendiente que se está editando (null = formulario de alta)
const pendingDeletes = new Set();   // ids ocultos que se borran de Firestore al vencer UNDO_MS
let deleteTimer = null;
const UNDO_MS = 6000;
const visibleTasks = () => tasks.filter((t) => !pendingDeletes.has(t.id));

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };

// action = { label, onClick, ms }: añade un botón (p. ej. "Deshacer") y alarga el tiempo en pantalla.
function toast(msg, action) {
  const t = $("toast");
  t.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = action.label;
    b.onclick = () => { t.hidden = true; clearTimeout(toast._t); action.onClick(); };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), action?.ms || 3000);
}

/* ---------- Sesión ---------- */
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);   // iPadOS

$("btn-login").onclick = async () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    if (isMobile) await auth.signInWithRedirect(provider);   // los popups fallan en Safari/iOS
    else await auth.signInWithPopup(provider);
  } catch (e) {
    if (e.code === "auth/popup-blocked") return auth.signInWithRedirect(provider);
    toast("No se pudo iniciar sesión: " + e.message);
  }
};
// Resultado de la redirección (solo muestra errores; el éxito lo maneja onAuthStateChanged)
auth.getRedirectResult().catch((e) => toast("No se pudo iniciar sesión: " + e.message));
$("btn-logout").onclick = async () => {
  await flushDeletes();      // los borrados en espera se confirman antes de salir
  await disablePush();       // el token no debe quedar ligado al usuario que sale
  try { await auth.signOut(); } catch (e) { toast("No se pudo cerrar sesión: " + e.message); }
};

auth.onAuthStateChanged((u) => {
  user = u;
  $("login").hidden = !!u;
  $("app").hidden = !u;
  if (!u) {
    if (unsubTasks) { unsubTasks(); unsubTasks = null; }
    tasks = [];
    if (selectedDate) closeDay();
    return;
  }
  subscribeTasks();
  setupNotifButton();
});

// Rango visible del calendario: 6 semanas que empiezan en lunes (incluye días de meses vecinos).
function gridStart() {
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  return start;
}

// Solo escuchamos los pendientes del rango visible; se reemplaza el listener al cambiar de mes.
function subscribeTasks() {
  if (unsubTasks) { unsubTasks(); unsubTasks = null; }
  if (!user) return;
  const start = gridStart();
  const end = new Date(start); end.setDate(start.getDate() + 41);
  unsubTasks = db.collection("tasks")
    .where("uid", "==", user.uid)
    .where("date", ">=", keyOf(start))
    .where("date", "<=", keyOf(end))
    .onSnapshot(
      (snap) => {
        tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
        if (selectedDate) renderList();
      },
      (e) => toast("Error al cargar: " + e.message)
    );
}

/* ---------- Calendario ---------- */
function render() {
  $("month-title").textContent = `${MESES[view.getMonth()]} ${view.getFullYear()}`;
  const grid = $("grid");
  grid.innerHTML = "";

  const start = gridStart();                           // la semana inicia en lunes
  const todayKey = keyOf(new Date());

  const byDate = {};
  for (const t of visibleTasks()) (byDate[t.date] ||= []).push(t);

  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = keyOf(d);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "day" + (d.getMonth() !== view.getMonth() ? " other" : "") + (k === todayKey ? " today" : "");
    cell.innerHTML = `<span class="num">${d.getDate()}</span>`;

    const list = (byDate[k] || []).sort((a, b) => a.time.localeCompare(b.time));
    list.slice(0, 3).forEach((t) => {
      const c = document.createElement("span");
      c.className = "chip" + (t.done ? " done" : "");
      c.textContent = `${t.time} ${t.title}`;
      cell.appendChild(c);
    });
    if (list.length > 3) {
      const m = document.createElement("span");
      m.className = "more"; m.textContent = `+${list.length - 3} más`;
      cell.appendChild(m);
    }
    cell.onclick = () => openDay(k);
    grid.appendChild(cell);
  }
}

$("prev").onclick = () => { view.setMonth(view.getMonth() - 1); render(); subscribeTasks(); };
$("next").onclick = () => { view.setMonth(view.getMonth() + 1); render(); subscribeTasks(); };
$("today").onclick = () => { view = new Date(); view.setDate(1); render(); subscribeTasks(); };

/* ---------- Detalle del día ---------- */
function openDay(k) {
  selectedDate = k;
  cancelEdit();
  lastFocus = document.activeElement;
  const d = parseKey(k);
  $("modal-title").textContent = d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  $("modal").hidden = false;
  renderList();
  $("f-title").focus();
}
function closeDay() {
  cancelEdit();
  $("modal").hidden = true; selectedDate = null;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}
$("close").onclick = closeDay;
$("modal").onclick = (e) => { if (e.target === $("modal")) closeDay(); };
document.addEventListener("keydown", (e) => {
  if ($("modal").hidden) return;
  if (e.key === "Escape") return closeDay();
  if (e.key !== "Tab") return;
  // Atrapa el foco dentro del modal.
  const items = [...$("modal").querySelectorAll("button, input, select"), ...$("toast").querySelectorAll("button")]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function renderList() {
  const ul = $("list");
  ul.innerHTML = "";
  const list = visibleTasks().filter((t) => t.date === selectedDate).sort((a, b) => a.time.localeCompare(b.time));
  if (!list.length) {
    ul.innerHTML = '<li class="empty">Sin pendientes este día</li>';
    return;
  }
  for (const t of list) {
    const li = document.createElement("li");
    li.className = "item" + (t.done ? " done" : "") + (t.id === editingId ? " editing" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!t.done; cb.setAttribute("aria-label", `Completado: ${t.title}`);
    cb.onchange = () => db.collection("tasks").doc(t.id).update({ done: cb.checked });

    const time = document.createElement("span"); time.className = "time"; time.textContent = t.time;
    const title = document.createElement("span"); title.className = "title"; title.textContent = t.title;

    const ed = document.createElement("button");
    ed.className = "icon-btn edit"; ed.type = "button"; ed.textContent = "✎"; ed.title = "Editar";
    ed.setAttribute("aria-label", `Editar: ${t.title}`);
    ed.onclick = () => startEdit(t);

    const del = document.createElement("button");
    del.className = "icon-btn del"; del.type = "button"; del.textContent = "×"; del.title = "Eliminar"; del.setAttribute("aria-label", `Eliminar: ${t.title}`);
    del.onclick = () => scheduleDelete(t);

    li.append(cb, time, title, ed, del);
    ul.appendChild(li);
  }
}

// Eliminar con "Deshacer": el pendiente se oculta y solo se borra de Firestore si pasan UNDO_MS sin deshacer.
function scheduleDelete(t) {
  pendingDeletes.add(t.id);
  if (editingId === t.id) cancelEdit();
  render(); if (selectedDate) renderList();
  const n = pendingDeletes.size;
  toast(n === 1 ? "Pendiente eliminado" : `${n} pendientes eliminados`, { label: "Deshacer", onClick: undoDelete, ms: UNDO_MS });
  clearTimeout(deleteTimer);
  deleteTimer = setTimeout(flushDeletes, UNDO_MS);
}

function undoDelete() {
  clearTimeout(deleteTimer);
  pendingDeletes.clear();
  render(); if (selectedDate) renderList();
}

// Borra de verdad los pendientes ocultos (al vencer el plazo, al cerrar sesión o al salir de la página).
async function flushDeletes() {
  clearTimeout(deleteTimer);
  const ids = [...pendingDeletes];
  if (!ids.length) return;
  const results = await Promise.allSettled(ids.map((id) => db.collection("tasks").doc(id).delete()));
  ids.forEach((id) => pendingDeletes.delete(id));
  if (results.some((r) => r.status === "rejected")) toast("No se pudo eliminar algún pendiente");
  render(); if (selectedDate) renderList();
}
window.addEventListener("pagehide", flushDeletes);

function startEdit(t) {
  editingId = t.id;
  $("f-title").value = t.title;
  $("f-time").value = t.time;
  $("f-remind").value = String(t.remindMin);
  $("f-date").value = t.date;
  $("f-date-row").hidden = false;
  $("f-submit").textContent = "Guardar";
  $("f-cancel").hidden = false;
  renderList();
  $("f-title").focus();
}

function cancelEdit() {
  editingId = null;
  $("form").reset();
  $("f-date-row").hidden = true;
  $("f-submit").textContent = "Agregar";
  $("f-cancel").hidden = true;
  if (selectedDate) renderList();
}
$("f-cancel").onclick = cancelEdit;

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const title = $("f-title").value.trim();
  const time = $("f-time").value;
  const remindMin = Number($("f-remind").value);
  const date = editingId ? $("f-date").value : selectedDate;
  if (!title || !time || !date) return;

  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const when = new Date(y, m - 1, d, hh, mm).getTime();       // instante absoluto (ms UTC)
  const remindAt = remindMin >= 0 ? when - remindMin * 60000 : null;

  if (editingId) return saveEdit({ title, date, time, remindMin, remindAt });

  try {
    await db.collection("tasks").add({
      uid: user.uid, title, date, time,
      remindMin, remindAt, notified: false, done: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    $("f-title").value = "";
    if (remindMin >= 0 && messaging && Notification.permission !== "granted") {
      toast("Activa los avisos (botón 🔔) para recibir el recordatorio");
    }
  } catch (err) {
    toast("No se pudo guardar: " + err.message);
  }
};

async function saveEdit(data) {
  const old = tasks.find((t) => t.id === editingId);
  if (!old) { toast("Ese pendiente ya no existe"); return cancelEdit(); }
  // Si ya se había avisado y el aviso cambia, se vuelve a armar para que se envíe de nuevo.
  if (old.notified && data.remindAt !== old.remindAt) data.notified = false;
  try {
    await db.collection("tasks").doc(editingId).update(data);
    toast(data.date !== old.date ? `Movido al ${data.date}` : "Cambios guardados");
    cancelEdit();
  } catch (err) {
    toast("No se pudo guardar: " + err.message);
  }
}

/* ---------- Notificaciones push ---------- */
function updateNotifButtons() {
  if (!messaging || !("Notification" in window)) return;
  $("btn-notif").hidden = !!fcmToken || Notification.permission === "denied";
  $("btn-notif-off").hidden = !fcmToken;
}

// iOS solo permite push en la app instalada en la pantalla de inicio (iOS 16.4+): en Safari normal no hay Notification.
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;

function setupIosHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("iosHintDismissed") === "1"; } catch (_) {}
  $("ios-hint").hidden = !(isIOS && !isStandalone && !dismissed);
}
$("ios-hint-close").onclick = () => {
  $("ios-hint").hidden = true;
  try { localStorage.setItem("iosHintDismissed", "1"); } catch (_) {}
};

async function setupNotifButton() {
  setupIosHint();
  if (!messaging || !("Notification" in window)) return;
  if (Notification.permission === "granted") await registerToken();   // renueva/guarda el token de este dispositivo
  updateNotifButtons();
}

$("btn-notif").onclick = async () => {
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    await registerToken();
    updateNotifButtons();
    if (fcmToken) toast("Avisos activados en este dispositivo");
  } else {
    toast("Permiso de notificaciones denegado");
  }
};

$("btn-notif-off").onclick = async () => {
  await disablePush();
  updateNotifButtons();
  toast("Avisos desactivados en este dispositivo");
};

async function registerToken() {
  try {
    const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js");
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) return;
    await db.collection("tokens").doc(token).set({
      uid: user.uid,
      ua: navigator.userAgent.slice(0, 120),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    fcmToken = token;          // solo "activo" si el Worker ya puede conocer el token
  } catch (e) {
    toast("No se pudieron activar los avisos: " + e.message);
  }
}

// Desvincula este dispositivo: borra su documento de tokens e invalida el token en FCM.
async function disablePush() {
  if (!messaging || !user) return;
  let token = fcmToken;
  try {
    if (!token && Notification.permission === "granted") {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    }
  } catch (e) {
    console.warn("No se pudo obtener el token:", e);
  }
  // Pasos independientes: aunque falle el borrado en Firestore (p. ej. sin red), el token se invalida en FCM
  // y el Worker lo limpiará solo al recibir UNREGISTERED.
  try { if (token) await db.collection("tokens").doc(token).delete(); }
  catch (e) { console.warn("No se pudo borrar el token en Firestore:", e); }
  try { await messaging.deleteToken(); }
  catch (e) { console.warn("No se pudo invalidar el token en FCM:", e); }
  fcmToken = null;
}

// App abierta: FCM no muestra nada solo, así que lo mostramos nosotros.
if (messaging) {
  messaging.onMessage((p) => {
    const n = p.notification || {};
    toast(`⏰ ${n.title || ""} ${n.body || ""}`.trim());
  });
}
