// Pruebas de la edición de pendientes. Ejecutar con: npm run test:client
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planEdit } = require("../../public/edit-plan.js");

const REMIND_AT = 1_000_000;
// Pendiente guardado: 17:00 del 2026-10-10, avisar a la hora.
const base = (over = {}) => ({ title: "Dentista", date: "2026-10-10", time: "17:00", remindMin: 0, remindAt: REMIND_AT, notified: false, done: false, nagMin: 0, nagAt: null, nagCount: 0, ...over });
// Lo que manda el formulario al guardar (remindAt recalculado desde fecha + hora).
const form = (over = {}) => ({ title: "Dentista", date: "2026-10-10", time: "17:00", remindMin: 0, remindAt: REMIND_AT, nagMin: 0, ...over });

test("solo cambia el título: no se tocan el aviso ni la cadena", () => {
  const out = planEdit(base(), form({ title: "Dentista (Dr. Pérez)" }));
  assert.equal(out.title, "Dentista (Dr. Pérez)");
  assert.equal("remindAt" in out, false);
  assert.equal("notified" in out, false);
  assert.equal("nagAt" in out, false);
  assert.equal("nagCount" in out, false);
});

test("un aviso pospuesto desde la notificación sobrevive a corregir el título", () => {
  const snoozedAt = REMIND_AT + 10 * 60_000;                      // remindAt movido por el botón Posponer
  const old = base({ remindAt: snoozedAt });
  const out = planEdit(old, form({ title: "Dentista (corregido)", remindAt: REMIND_AT }));   // el formulario recalcula desde la hora original
  assert.equal("remindAt" in out, false, "no debe volver a la hora original");
  assert.equal("notified" in out, false);
});

test("un aviso pospuesto que además ya avisó dos veces no se reinicia por editar el título", () => {
  const old = base({ notified: true, nagMin: 10, nagAt: 9_999, nagCount: 2, remindAt: REMIND_AT + 600_000 });
  const out = planEdit(old, form({ title: "Otro", nagMin: 10, remindAt: REMIND_AT }));
  assert.deepEqual(Object.keys(out).sort(), ["date", "nagMin", "time", "title", "remindMin"].sort());
});

test("cambiar la hora reprograma: nuevo remindAt y, si ya había avisado, se vuelve a armar", () => {
  const out = planEdit(base({ notified: true }), form({ time: "18:30", remindAt: REMIND_AT + 90 * 60_000 }));
  assert.equal(out.remindAt, REMIND_AT + 90 * 60_000);
  assert.equal(out.notified, false);
  assert.equal(out.nagAt, null);
  assert.equal(out.nagCount, 0);
});

test("cambiar la hora de un pendiente que aún no avisó: nuevo remindAt sin tocar notified", () => {
  const out = planEdit(base({ notified: false }), form({ time: "18:30", remindAt: REMIND_AT + 90 * 60_000 }));
  assert.equal(out.remindAt, REMIND_AT + 90 * 60_000);
  assert.equal("notified" in out, false);
});

test("cambiar la fecha o la anticipación también reprograma", () => {
  const byDate = planEdit(base({ notified: true }), form({ date: "2026-10-11", remindAt: REMIND_AT + 86_400_000 }));
  assert.equal(byDate.remindAt, REMIND_AT + 86_400_000);
  assert.equal(byDate.notified, false);
  const byRemind = planEdit(base({ notified: true }), form({ remindMin: 15, remindAt: REMIND_AT - 15 * 60_000 }));
  assert.equal(byRemind.remindAt, REMIND_AT - 15 * 60_000);
  assert.equal(byRemind.notified, false);
});

test("reprogramar un aviso pospuesto usa la hora nueva del formulario (el cambio es explícito)", () => {
  const old = base({ remindAt: REMIND_AT + 600_000, notified: false });
  const out = planEdit(old, form({ time: "19:00", remindAt: REMIND_AT + 2 * 3_600_000 }));
  assert.equal(out.remindAt, REMIND_AT + 2 * 3_600_000);
});

test("pasar a 'Sin aviso' pone remindAt en null y reinicia la cadena", () => {
  const out = planEdit(base({ nagMin: 10, notified: true, nagAt: 5, nagCount: 1 }), form({ remindMin: -1, remindAt: null, nagMin: 0 }));
  assert.equal(out.remindAt, null);
  assert.equal(out.nagAt, null);
  assert.equal(out.nagCount, 0);
});

test("cambiar solo el intervalo de insistencia reinicia la cadena sin tocar el aviso", () => {
  const out = planEdit(base({ nagMin: 10, notified: true, nagAt: 5, nagCount: 1 }), form({ nagMin: 30 }));
  assert.equal("remindAt" in out, false);
  assert.equal("notified" in out, false);
  assert.equal(out.nagAt, null);
  assert.equal(out.nagCount, 0);
  assert.equal(out.nagMin, 30);
});

test("pendientes anteriores (sin campos de insistencia) se editan sin problemas", () => {
  const old = { title: "Viejo", date: "2026-10-10", time: "09:00", remindMin: 15, remindAt: 1, notified: true, done: false };
  const out = planEdit(old, { title: "Viejo editado", date: "2026-10-10", time: "09:00", remindMin: 15, remindAt: 1, nagMin: 0 });
  assert.equal(out.title, "Viejo editado");
  assert.equal("nagAt" in out, false);                              // nagMin 0 = 0: no cambió
  assert.equal("remindAt" in out, false);
});

test("no modifica el objeto que recibe", () => {
  const data = form({ time: "18:30", remindAt: 5 });
  const copy = JSON.stringify(data);
  planEdit(base({ notified: true }), data);
  assert.equal(JSON.stringify(data), copy);
});
