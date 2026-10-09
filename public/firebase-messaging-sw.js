importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
importScripts("/firebase-config.js");
importScripts("/sw-actions.js");

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Una versión nueva toma el control de inmediato (si no, esperaría a que se cerraran todas las pestañas y los botones tardarían en aparecer).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

// El Worker manda solo datos (sin "notification"): aquí se arma la notificación para poder ponerle los botones
// "Hecho" y "Posponer". Con la app abierta, en cambio, el aviso lo muestra la propia app.
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  if (!d.title) return;
  return self.registration.showNotification(d.title, SWActions.notificationOptions(d));
});

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  if (event.action === "done" || event.action === "snooze") {
    event.waitUntil(runAction(event.action, data));
    return;
  }
  event.waitUntil(openApp());
});

// Hecho / Posponer sin abrir la app. Si algo falla (sin sesión, sin red…) se avisa para que se haga desde la app.
async function runAction(action, data) {
  try {
    return await SWActions.run(action, data, {
      projectId: firebaseConfig.projectId,
      apiKey: firebaseConfig.apiKey,
      fetch: (...a) => fetch(...a),
      now: () => Date.now(),
    });
  } catch (e) {
    console.warn("No se pudo completar la acción de la notificación:", e);
    await self.registration.showNotification("No se pudo completar la acción", {
      body: `Abre Mi Agenda y gestiona «${data.title || "el pendiente"}» desde la app.`,
      icon: "/icon-192.png",
      tag: "err-" + (data.taskId || "x"),
    });
  }
}

function openApp() {
  return clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow("/");
  });
}
