// Horarios de los resúmenes (mañana / cierre del día) en la zona horaria del usuario. El Worker corre en UTC, así que
// "las 8:00" hay que traducirlas a un instante concreto según la zona de cada persona (y su horario de verano).
// Lo usan la app (para guardar la próxima hora) y el Worker (para avanzarla): una sola fuente de verdad.
// También funciona como módulo de Node (tests/client/digest.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Digest = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const pad = (n) => String(n).padStart(2, "0");
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

  // Horas que ofrece la app (cada 30 min). Los rangos evitan las horas en que cambian los relojes en casi todo el mundo.
  const half = (from, to) => { const out = []; for (let h = from; h <= to; h++) for (const m of [0, 30]) out.push(`${pad(h)}:${pad(m)}`); return out; };
  const MORNING_OPTIONS = half(5, 11);
  const EVENING_OPTIONS = half(17, 23);

  const formatters = new Map();
  function formatter(tz) {
    let f = formatters.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      formatters.set(tz, f);
    }
    return f;
  }
  function isValidTimeZone(tz) {
    if (typeof tz !== "string" || !tz || tz.length > 64) return false;
    try { formatter(tz); return true; } catch (_) { return false; }
  }

  // Fecha y hora que marca el reloj de `tz` en el instante `ms`.
  function localParts(ms, tz) {
    const p = {};
    for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
    const y = +p.year, m = +p.month, d = +p.day, hh = +p.hour % 24, mm = +p.minute, ss = +p.second;
    return { y, m, d, hh, mm, ss, ymd: `${y}-${pad(m)}-${pad(d)}`, hhmm: `${pad(hh)}:${pad(mm)}` };
  }

  // Diferencia (ms) entre el reloj local de `tz` y UTC en el instante `ms`.
  function offsetMs(ms, tz) {
    const p = localParts(ms, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
  }

  // Instante UTC en que el reloj de `tz` marca y-m-d hh:mm (se recalcula el desfase por si cambia con el horario de verano).
  function zonedToUtc(y, m, d, hh, mm, tz) {
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const o1 = offsetMs(guess, tz);
    let t = guess - o1;
    const o2 = offsetMs(t, tz);
    if (o2 !== o1) t = guess - o2;
    return t;
  }

  // Primer instante posterior a `after` en que el reloj de `tz` marca `hhmm`. Una vez por día local, siempre creciente.
  function nextOccurrence(tz, hhmm, after) {
    if (typeof hhmm !== "string" || !HHMM.test(hhmm) || !isValidTimeZone(tz)) return null;
    const [hh, mm] = hhmm.split(":").map(Number);
    const base = localParts(after, tz);
    for (let k = -1; k <= 2; k++) {
      const day = new Date(Date.UTC(base.y, base.m - 1, base.d + k));
      const t = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
      if (t > after) return t;
    }
    return null;
  }

  // La próxima hora en que toca algún resumen activo (el menor de los dos), o null si no hay ninguno.
  function nextDigestAt({ tz, morning, evening }, after) {
    const times = [nextOccurrence(tz, morning, after), nextOccurrence(tz, evening, after)].filter((t) => t !== null);
    return times.length ? Math.min(...times) : null;
  }

  return { MORNING_OPTIONS, EVENING_OPTIONS, HHMM, isValidTimeZone, localParts, offsetMs, zonedToUtc, nextOccurrence, nextDigestAt };
});
