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
  if (event.action === "done" || event.action === "snooze" || event.action === "move") {
    event.waitUntil(runAction(event.action, data));
    return;
  }
  // Un resumen abre directamente la vista "Hoy".
  event.waitUntil(openApp(data.kind && data.kind.startsWith("digest") ? "/?view=today" : "/"));
});

// Hecho / Posponer sin abrir la app. Si algo falla (sin sesión, sin red…) se avisa para que se haga desde la app.
async function runAction(action, data) {
  try {
    const result = await SWActions.run(action, data, {
      projectId: firebaseConfig.projectId,
      apiKey: firebaseConfig.apiKey,
      fetch: (...a) => fetch(...a),
      now: () => Date.now(),
    });
    // Mover a mañana cambia muchos pendientes de golpe: se confirma para que no quede la duda.
    if (typeof result === "string" && result.startsWith("moved:")) {
      const n = Number(result.slice(6));
      await self.registration.showNotification(n ? "Movidos a mañana" : "No había pendientes que mover", {
        body: n ? `${n} ${n === 1 ? "pendiente pasó" : "pendientes pasaron"} a mañana.` : "Ya estaba todo hecho o movido.",
        icon: "/icon-192.png",
        tag: "digest-evening",
      });
    }
    return result;
  } catch (e) {
    console.warn("No se pudo completar la acción de la notificación:", e);
    await self.registration.showNotification("No se pudo completar la acción", {
      body: data.kind === "digest-evening" ? "Abre Mi Agenda y mueve los pendientes desde la app." : `Abre Mi Agenda y gestiona «${data.title || "el pendiente"}» desde la app.`,
      icon: "/icon-192.png",
      tag: "err-" + (data.taskId || "x"),
    });
  }
}

function openApp(url = "/") {
  return clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      // Si ya hay una ventana y se pide otra vista (el resumen abre "Hoy"), se lleva ahí; si no, solo se enfoca.
      if (url !== "/" && "navigate" in c) return c.navigate(url).then((w) => (w || c).focus());
      if ("focus" in c) return c.focus();
    }
    return clients.openWindow(url);
  });
}
