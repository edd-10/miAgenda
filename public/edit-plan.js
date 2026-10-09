// Qué campos hay que escribir al editar un pendiente. Pura (sin red) para poder probarla: tests/client/edit-plan.test.js.
//
// Importante: el aviso puede haberse pospuesto desde la notificación (remindAt ≠ fecha + hora − anticipación). Si la
// edición no toca la fecha, la hora ni la anticipación, remindAt NO se reescribe: si no, corregir un título devolvería el
// aviso a su hora original, ya pasada, y sonaría de inmediato.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EditPlan = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // old: el pendiente tal como está guardado. data: { title, date, time, remindMin, remindAt, nagMin } desde el formulario.
  function planEdit(old, data) {
    const out = { ...data };
    const scheduleChanged = data.date !== old.date || data.time !== old.time || data.remindMin !== old.remindMin;
    if (!scheduleChanged) delete out.remindAt;
    const reschedules = scheduleChanged && data.remindAt !== old.remindAt;

    // Si ya se había avisado y el aviso cambia, se vuelve a armar para que se envíe de nuevo.
    if (old.notified && reschedules) out.notified = false;
    // Cambiar la hora del aviso o el intervalo reinicia la cadena de insistencias (la programa el Worker).
    if (reschedules || (data.nagMin || 0) !== (old.nagMin || 0)) { out.nagAt = null; out.nagCount = 0; }
    return out;
  }
  return { planEdit };
});
