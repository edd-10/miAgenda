// Formato de hora: los pendientes se guardan siempre como "HH:MM" (24 h); solo cambia cómo se muestran y se eligen.
// También funciona como módulo de Node (tests/client/format.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Format = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const pad2 = (n) => String(n).padStart(2, "0");

  // "21:30" → "21:30" (24 h) o "9:30 p. m." (12 h). Si el texto no es una hora válida, lo devuelve tal cual.
  function formatTime(hhmm, fmt) {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
    if (!m || fmt !== "12") return hhmm || "";
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? "a. m." : "p. m."}`;
  }

  // 12 h → 24 h: (12, "am") = 0, (12, "pm") = 12, (9, "pm") = 21.
  const to24 = (hour12, ampm) => (Number(hour12) % 12) + (ampm === "pm" ? 12 : 0);
  // 24 h → 12 h: 0 → 12 am, 13 → 1 pm.
  const from24 = (hour) => ({ hour12: hour % 12 || 12, ampm: hour < 12 ? "am" : "pm" });

  return { pad2, formatTime, to24, from24 };
});
