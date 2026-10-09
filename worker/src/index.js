// Worker de Cloudflare: cada minuto atiende los recordatorios que vencen en el próximo minuto (y sus insistencias) y los
// resúmenes diarios, y envía los push (FCM) en el instante exacto. La lógica está en reminders.mjs y digests.mjs
// (probadas con un reloj simulado en worker/test).

import { processReminders } from "./reminders.mjs";
import { processDigests } from "./digests.mjs";

export default {
  // Se espera la promesa directamente (no ctx.waitUntil): la ejecución puede durar hasta ~75 s esperando la hora de cada aviso.
  async scheduled(event, env) {
    // Cada tarea es independiente: si una falla, la otra se completa y el error se propaga al final para que quede en los logs.
    const results = await Promise.allSettled([processReminders(env), processDigests(env)]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  },
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
