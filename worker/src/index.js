// Worker de Cloudflare: cada minuto atiende los recordatorios que vencen en el próximo minuto y envía el push (FCM)
// en el instante exacto. La lógica está en reminders.mjs (probada con un reloj simulado en worker/test).

import { processReminders } from "./reminders.mjs";

export default {
  // Se espera la promesa directamente (no ctx.waitUntil): la ejecución puede durar hasta ~75 s esperando la hora de cada aviso.
  async scheduled(event, env) {
    await processReminders(env);
  },
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
