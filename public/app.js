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
let mode = "month";        // vista activa: "month" (calendario) o "today"
let timeFormat = loadTimeFormat();   // "24" | "12": solo cambia cómo se muestran y eligen las horas (se guardan siempre como HH:MM)
let nagMax = 5;            // máximo de repeticiones al insistir (por cuenta: users/{uid}.nagMax)
let unsubPrefs = null;
const pendingDeletes = new Set();   // ids ocultos que se borran de Firestore al vencer UNDO_MS
let deleteTimer = null;
const UNDO_MS = 6000;
const visibleTasks = () => tasks.filter((t) => !pendingDeletes.has(t.id));

const pad = (n) => String(n).padStart(2, "0");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (t) => Format.formatTime(t, timeFormat);
const fmtDay = (key) => parseKey(key).toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
const REMIND_LABELS = { "-1": "sin aviso", 0: "aviso a la hora", 5: "aviso 5 min antes", 15: "aviso 15 min antes", 30: "aviso 30 min antes", 60: "aviso 1 hora antes", 1440: "aviso 1 día antes" };
function loadTimeFormat() {
  try { return localStorage.getItem("timeFormat") === "12" ? "12" : "24"; } catch (_) { return "24"; }
}
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
    if (unsubPrefs) { unsubPrefs(); unsubPrefs = null; }
    tasks = [];
    if (selectedDate) closeDay();
    closeSettings();
    return;
  }
  setMode(loadMode());
  subscribePrefs();
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
        refresh();
      },
      (e) => toast("Error al cargar: " + e.message)
    );
}

/* ---------- Vistas ---------- */
// Redibuja lo que esté a la vista: calendario, lista del día abierto y/o vista "Hoy".
function refresh() {
  render();
  if (selectedDate) renderList();
  if (mode === "today") renderToday();
}

function loadMode() {
  try { return localStorage.getItem("mode") === "today" ? "today" : "month"; } catch (_) { return "month"; }
}

// Solo cambia lo visible; quien llama vuelve a suscribirse si hace falta (en "Hoy" el mes mostrado es el actual).
function setMode(m) {
  mode = m;
  try { localStorage.setItem("mode", m); } catch (_) {}
  if (m === "today") { view = new Date(); view.setDate(1); }
  $("view-month").hidden = m !== "month";
  $("view-today").hidden = m !== "today";
  $("nav").hidden = m !== "month";
  $("today").hidden = m !== "month";
  for (const [id, active] of [["tab-month", m === "month"], ["tab-today", m === "today"]]) {
    if (active) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  }
}

$("tab-month").onclick = () => { if (mode !== "month") { setMode("month"); refresh(); } };
$("tab-today").onclick = () => { if (mode !== "today") { setMode("today"); subscribeTasks(); refresh(); } };
$("today-add").onclick = () => openDay(keyOf(new Date()));

function renderToday() {
  const key = keyOf(new Date());
  $("today-title").textContent = cap(parseKey(key).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }));
  const ul = $("today-list");
  ul.innerHTML = "";
  const list = visibleTasks().filter((t) => t.date === key).sort((a, b) => a.time.localeCompare(b.time));
  const done = list.filter((t) => t.done).length;
  $("today-summary").textContent = list.length ? `${done} de ${list.length} completados` : "";
  if (!list.length) {
    ul.innerHTML = '<li class="empty">Sin pendientes para hoy</li>';
    return;
  }
  for (const t of list) ul.appendChild(buildItem(t));
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
      c.textContent = `${fmtTime(t.time)} ${t.title}`;
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
  $("modal-title").textContent = cap(d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }));
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
  const dialog = !$("settings").hidden ? $("settings") : !$("modal").hidden ? $("modal") : null;
  if (!dialog) return;
  if (e.key === "Escape") return dialog === $("settings") ? closeSettings() : closeDay();
  if (e.key !== "Tab") return;
  // Atrapa el foco dentro del diálogo abierto.
  const items = [...dialog.querySelectorAll("button, input, select"), ...$("toast").querySelectorAll("button")]
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
  for (const t of list) ul.appendChild(buildItem(t));
}

function buildItem(t) {
  const li = document.createElement("li");
  li.className = "item" + (t.done ? " done" : "") + (t.id === editingId ? " editing" : "");

  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = !!t.done; cb.setAttribute("aria-label", `Completado: ${t.title}`);
  cb.onchange = () => db.collection("tasks").doc(t.id).update(cb.checked ? { done: true, nagAt: null } : { done: false });

  const time = document.createElement("span"); time.className = "time"; time.textContent = fmtTime(t.time);
  const title = document.createElement("span"); title.className = "title"; title.textContent = t.title;

  const ed = document.createElement("button");
  ed.className = "icon-btn edit"; ed.type = "button"; ed.textContent = "✎"; ed.title = "Editar";
  ed.setAttribute("aria-label", `Editar: ${t.title}`);
  ed.onclick = () => { if ($("modal").hidden) openDay(t.date); startEdit(t); };

  const del = document.createElement("button");
  del.className = "icon-btn del"; del.type = "button"; del.textContent = "×"; del.title = "Eliminar"; del.setAttribute("aria-label", `Eliminar: ${t.title}`);
  del.onclick = () => scheduleDelete(t);

  li.append(cb, time, title);
  if (t.nagMin > 0 && !t.done) {
    const nag = document.createElement("span");
    nag.className = "nag"; nag.textContent = "🔁"; nag.title = `Insiste cada ${t.nagMin} min`;
    nag.setAttribute("role", "img"); nag.setAttribute("aria-label", nag.title);
    li.append(nag);
  }
  li.append(ed, del);
  return li;
}

// Eliminar con "Deshacer": el pendiente se oculta y solo se borra de Firestore si pasan UNDO_MS sin deshacer.
function scheduleDelete(t) {
  pendingDeletes.add(t.id);
  if (editingId === t.id) cancelEdit();
  refresh();
  const n = pendingDeletes.size;
  toast(n === 1 ? "Pendiente eliminado" : `${n} pendientes eliminados`, { label: "Deshacer", onClick: undoDelete, ms: UNDO_MS });
  clearTimeout(deleteTimer);
  deleteTimer = setTimeout(flushDeletes, UNDO_MS);
}

function undoDelete() {
  clearTimeout(deleteTimer);
  pendingDeletes.clear();
  refresh();
}

// Borra de verdad los pendientes ocultos (al vencer el plazo, al cerrar sesión o al salir de la página).
async function flushDeletes() {
  clearTimeout(deleteTimer);
  const ids = [...pendingDeletes];
  if (!ids.length) return;
  const results = await Promise.allSettled(ids.map((id) => db.collection("tasks").doc(id).delete()));
  ids.forEach((id) => pendingDeletes.delete(id));
  if (results.some((r) => r.status === "rejected")) toast("No se pudo eliminar algún pendiente");
  refresh();
}
window.addEventListener("pagehide", flushDeletes);

// Instante absoluto (ms UTC) del aviso: fecha y hora locales menos la anticipación; null si no hay aviso.
function remindAtOf(date, time, remindMin) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const when = new Date(y, m - 1, d, hh, mm).getTime();
  return remindMin >= 0 ? when - remindMin * 60000 : null;
}

function addTask({ title, date, time, remindMin, nagMin }) {
  return db.collection("tasks").add({
    uid: user.uid, title, date, time,
    remindMin, remindAt: remindAtOf(date, time, remindMin), notified: false, done: false, nagMin, nagAt: null, nagCount: 0,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

function startEdit(t) {
  editingId = t.id;
  $("f-title").value = t.title;
  setTimeValue(t.time);
  $("f-remind").value = String(t.remindMin);
  $("f-nag").value = String(t.nagMin || 0);
  syncNagField();
  $("f-date").value = t.date;
  $("f-date-row").hidden = false;
  $("f-submit").textContent = "Guardar";
  $("f-cancel").hidden = false;
  renderList();
  $("f-title").focus();
}

// "Insistir" solo tiene sentido si hay aviso; con "Sin aviso" se desactiva.
function syncNagField() {
  const off = $("f-remind").value === "-1";
  $("f-nag").disabled = off;
  if (off) $("f-nag").value = "0";
  $("f-nag-hint").textContent = !off && $("f-nag").value !== "0"
    ? `Repite el aviso hasta ${nagMax} veces, o hasta que lo marques como hecho.` : "";
}
$("f-remind").onchange = syncNagField;
$("f-nag").onchange = syncNagField;

function cancelEdit() {
  editingId = null;
  $("form").reset();
  setTimeValue("09:00");
  syncNagField();
  $("f-date-row").hidden = true;
  $("f-submit").textContent = "Agregar";
  $("f-cancel").hidden = true;
  if (selectedDate) renderList();
}
$("f-cancel").onclick = cancelEdit;

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const title = $("f-title").value.trim();
  const time = getTimeValue();
  const remindMin = Number($("f-remind").value);
  const nagMin = remindMin >= 0 ? Number($("f-nag").value) : 0;
  const date = editingId ? $("f-date").value : selectedDate;
  if (!title || !time || !date) return;

  if (editingId) return saveEdit({ title, date, time, remindMin, remindAt: remindAtOf(date, time, remindMin), nagMin });

  try {
    await addTask({ title, date, time, remindMin, nagMin });
    $("f-title").value = "";
    if (remindMin >= 0 && messaging && Notification.permission !== "granted") {
      toast("Activa los avisos en Ajustes (⚙) para recibir el recordatorio");
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
  // Cambiar la hora del aviso o el intervalo reinicia la cadena de insistencias (la programa el Worker).
  if (data.remindAt !== old.remindAt || data.nagMin !== (old.nagMin || 0)) { data.nagAt = null; data.nagCount = 0; }
  try {
    await db.collection("tasks").doc(editingId).update(data);
    toast(data.date !== old.date ? `Movido al ${data.date}` : "Cambios guardados");
    cancelEdit();
  } catch (err) {
    toast("No se pudo guardar: " + err.message);
  }
}

/* ---------- Agregar rápido (lenguaje natural) ---------- */
// Si la fecha cae fuera de lo que muestra el calendario, se lleva la vista a ese mes para que se vea el pendiente.
function ensureVisible(dateKey) {
  if (mode !== "month") return;
  const start = gridStart(), end = addDays(start, 41);
  const d = parseKey(dateKey);
  if (d >= start && d <= end) return;
  view = new Date(d.getFullYear(), d.getMonth(), 1);
  subscribeTasks();
  render();
}
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// Lo que se entendió de lo escrito, para corregirlo antes de agregar.
function describeQuick(r) {
  const parts = [`📌 ${r.title}`, `📅 ${fmtDay(r.date || keyOf(new Date()))}`];
  parts.push(r.time ? `🕒 ${fmtTime(r.time)}` : "🕒 sin hora: se abrirá el formulario para elegirla");
  parts.push(`🔔 ${REMIND_LABELS[r.remindMin ?? 0]}`);
  if (r.nagMin) parts.push(`🔁 insistir cada ${r.nagMin} min`);
  const notes = [];
  if (r.notes.includes("assumed-pm")) notes.push("supuse p. m.");
  if (r.notes.includes("assumed-am")) notes.push("supuse a. m.");
  if (r.notes.includes("tomorrow-assumed")) notes.push("esa hora ya pasó hoy, va para mañana");
  if (r.notes.includes("invalid-date")) notes.push("⚠ esa fecha no existe");
  if (r.notes.includes("past")) notes.push("⚠ ya pasó");
  const adj = r.notes.find((n) => n.startsWith("remind-adjusted:"));
  if (adj) notes.push(`aviso ajustado a la opción más cercana (pediste ${adj.split(":")[1].split("->")[0]} min)`);
  return parts.join(" · ") + (notes.length ? `  (${notes.join("; ")})` : "");
}

function renderQuickPreview() {
  const text = $("quick-input").value.trim();
  const el = $("quick-preview");
  if (!text) { el.textContent = ""; return; }
  const r = NL.parse(text, new Date());
  el.textContent = r.title ? describeQuick(r) : "Escribe qué quieres recordar y, si quieres, cuándo.";
}
$("quick-input").oninput = renderQuickPreview;
$("quick-input").onkeydown = (e) => { if (e.key === "Escape") { e.target.value = ""; renderQuickPreview(); } };

$("quick").onsubmit = async (e) => {
  e.preventDefault();
  const r = NL.parse($("quick-input").value, new Date());
  if (!r.title) { renderQuickPreview(); return; }
  const date = r.date || keyOf(new Date());
  const remindMin = r.remindMin ?? 0;
  const nagMin = remindMin >= 0 ? r.nagMin ?? 0 : 0;

  if (!r.time) {          // sin hora no se inventa una: se completa en el formulario de siempre
    ensureVisible(date);
    openDay(date);
    $("f-title").value = r.title;
    $("f-remind").value = String(remindMin);
    $("f-nag").value = String(nagMin);
    syncNagField();
    $("quick-input").value = ""; renderQuickPreview();
    $("f-hour").focus();
    toast("Falta la hora: elígela y pulsa Agregar");
    return;
  }
  try {
    const ref = await addTask({ title: r.title, date, time: r.time, remindMin, nagMin });
    $("quick-input").value = ""; renderQuickPreview();
    ensureVisible(date);
    toast(`Agregado: ${r.title} · ${fmtDay(date)} · ${fmtTime(r.time)}`, {
      label: "Deshacer", ms: UNDO_MS,
      onClick: () => ref.delete().catch((err) => toast("No se pudo deshacer: " + err.message)),
    });
  } catch (err) {
    toast("No se pudo guardar: " + err.message);
  }
};

/* ---------- Notificaciones push ---------- */
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
  renderNotifSettings();
}

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

/* ---------- Selector de hora (24 h o 12 h con a. m./p. m.) ---------- */
function buildTimeOptions(keep = getTimeValue()) {
  const is12 = timeFormat === "12";
  const hour = $("f-hour"), min = $("f-min");
  hour.innerHTML = "";
  const hours = is12 ? Array.from({ length: 12 }, (_, i) => i + 1) : Array.from({ length: 24 }, (_, i) => i);
  for (const h of hours) hour.add(new Option(is12 ? String(h) : Format.pad2(h), String(h)));
  if (!min.options.length) for (let m = 0; m < 60; m++) min.add(new Option(Format.pad2(m), String(m)));
  $("f-ampm").hidden = !is12;
  setTimeValue(keep);
}

function getTimeValue() {
  const h = Number($("f-hour").value), m = Number($("f-min").value);
  const hh = timeFormat === "12" ? Format.to24(h, $("f-ampm").value) : h;
  return `${Format.pad2(hh)}:${Format.pad2(m)}`;
}

function setTimeValue(hhmm) {
  const [hh, mm] = (hhmm || "09:00").split(":").map(Number);
  if (timeFormat === "12") {
    const { hour12, ampm } = Format.from24(hh);
    $("f-hour").value = String(hour12);
    $("f-ampm").value = ampm;
  } else {
    $("f-hour").value = String(hh);
  }
  $("f-min").value = String(mm);
}

function setTimeFormat(v, persist) {
  const keep = getTimeValue();           // la hora elegida se lee con el formato anterior, antes de cambiarlo
  timeFormat = v === "12" ? "12" : "24";
  try { localStorage.setItem("timeFormat", timeFormat); } catch (_) {}
  buildTimeOptions(keep);
  refresh();
  if (persist && user) {
    db.collection("users").doc(user.uid).set({ timeFormat }, { merge: true })
      .catch((e) => toast("No se pudo guardar el formato de hora: " + e.message));
  }
}

// El formato de hora es por cuenta (el Worker lo usa para el texto del aviso); el tema es por dispositivo.
function subscribePrefs() {
  if (unsubPrefs) unsubPrefs();
  unsubPrefs = db.collection("users").doc(user.uid).onSnapshot(
    (snap) => {
      const d = snap.exists ? snap.data() : {};
      const next = d.timeFormat === "12" ? "12" : "24";
      const max = [3, 5, 10, 20].includes(d.nagMax) ? d.nagMax : 5;
      let changed = false;
      if (next !== timeFormat) { setTimeFormat(next, false); changed = true; }
      if (max !== nagMax) { nagMax = max; syncNagField(); changed = true; }
      if (changed && !$("settings").hidden) renderSettings();
    },
    (e) => console.warn("No se pudieron leer las preferencias:", e)
  );
}

/* ---------- Ajustes ---------- */
let settingsFocus = null;

function openSettings() {
  settingsFocus = document.activeElement;
  renderSettings();
  $("settings").hidden = false;
  $("settings-close").focus();
}
function closeSettings() {
  $("settings").hidden = true;
  if (settingsFocus && document.contains(settingsFocus)) settingsFocus.focus();
  settingsFocus = null;
}
$("btn-settings").onclick = openSettings;
$("settings-close").onclick = closeSettings;
$("settings").onclick = (e) => { if (e.target === $("settings")) closeSettings(); };

function renderSettings() {
  const t = Theme.load();
  document.querySelector(`input[name="theme-mode"][value="${t.mode}"]`).checked = true;
  $("c-accent").value = t.accent;
  $("c-bg").value = t.bg;
  $("theme-custom").hidden = t.mode !== "custom";
  $("theme-hint").textContent = t.mode === "custom" ? Theme.describe(t) : "";
  document.querySelector(`input[name="time-format"][value="${timeFormat}"]`).checked = true;
  $("set-nagmax").value = String(nagMax);
  $("account-email").textContent = user && user.email ? user.email : "";
  renderNotifSettings();
}

function applyTheme(patch) {
  const t = { ...Theme.load(), ...patch };
  Theme.save(t);
  Theme.apply(t);
  return t;
}
document.querySelectorAll('input[name="theme-mode"]').forEach((r) => {
  r.onchange = () => { applyTheme({ mode: r.value }); renderSettings(); };
});
// Los selectores de color se actualizan en vivo; solo se refresca el aviso para no interrumpir el selector nativo.
$("c-accent").oninput = (e) => { $("theme-hint").textContent = Theme.describe(applyTheme({ accent: e.target.value })); };
$("c-bg").oninput = (e) => { $("theme-hint").textContent = Theme.describe(applyTheme({ bg: e.target.value })); };
$("theme-reset").onclick = () => { applyTheme({ accent: Theme.DEFAULTS.accent, bg: Theme.DEFAULTS.bg }); renderSettings(); };

document.querySelectorAll('input[name="time-format"]').forEach((r) => {
  r.onchange = () => setTimeFormat(r.value, true);
});

$("set-nagmax").onchange = (e) => {
  nagMax = Number(e.target.value);
  syncNagField();
  if (user) {
    db.collection("users").doc(user.uid).set({ nagMax }, { merge: true })
      .catch((err) => toast("No se pudo guardar el máximo de repeticiones: " + err.message));
  }
};

function renderNotifSettings() {
  const status = $("notif-status"), btn = $("btn-notif-toggle");
  btn.hidden = false;
  if (!messaging || !("Notification" in window)) {
    status.textContent = isIOS && !isStandalone
      ? "En iPhone/iPad los avisos requieren instalar la app: toca Compartir → Agregar a pantalla de inicio y ábrela desde ese ícono."
      : "Este navegador no admite avisos.";
    btn.hidden = true;
  } else if (Notification.permission === "denied") {
    status.textContent = "Bloqueaste los avisos para este sitio. Actívalos desde los ajustes del navegador y vuelve aquí.";
    btn.hidden = true;
  } else if (fcmToken) {
    status.textContent = "Avisos activados en este dispositivo.";
    btn.textContent = "Desactivar avisos"; btn.dataset.action = "off";
  } else {
    status.textContent = "Los avisos están desactivados en este dispositivo.";
    btn.textContent = "Activar avisos"; btn.dataset.action = "on";
  }
}

$("btn-notif-toggle").onclick = async () => {
  const btn = $("btn-notif-toggle");
  btn.disabled = true;
  try {
    if (btn.dataset.action === "off") {
      await disablePush();
      toast("Avisos desactivados en este dispositivo");
    } else {
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        await registerToken();
        if (fcmToken) toast("Avisos activados en este dispositivo");
      } else {
        toast("Permiso de notificaciones denegado");
      }
    }
  } finally {
    btn.disabled = false;
    renderNotifSettings();
  }
};

buildTimeOptions("09:00");
syncNagField();

// App abierta: FCM no muestra nada solo, así que lo mostramos nosotros.
if (messaging) {
  messaging.onMessage((p) => {
    const n = p.notification || {};
    toast(`⏰ ${n.title || ""} ${n.body || ""}`.trim());
  });
}
