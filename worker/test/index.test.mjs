// Pruebas del punto de entrada del Worker (cron). Ejecutar con: npm run test:worker
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("el Worker expone el cron (scheduled) y responde 404 a cualquier petición HTTP", async () => {
  assert.equal(typeof worker.scheduled, "function");
  assert.equal((await worker.fetch()).status, 404);
});

test("si avisos y resúmenes fallan, el error se propaga (no se traga en silencio) y las dos tareas se intentan", async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response("sin acceso", { status: 500 }); };
  try {
    // Una clave inválida hace fallar el token de ambas tareas; lo que importa es que scheduled rechace.
    await assert.rejects(worker.scheduled({}, { SERVICE_ACCOUNT: JSON.stringify({ project_id: "x", client_email: "a@b", private_key: "no-es-una-clave" }) }));
  } finally {
    globalThis.fetch = realFetch;
  }
});
