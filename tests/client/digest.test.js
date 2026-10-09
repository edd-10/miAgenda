// Pruebas de los horarios de los resúmenes en la zona horaria del usuario. Ejecutar con: npm run test:client
const { test } = require("node:test");
const assert = require("node:assert/strict");
const D = require("../../public/digest.js");

const utc = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);

test("localParts: la misma hora UTC marca relojes distintos según la zona", () => {
  const t = utc(2026, 10, 9, 22, 0);                                   // 22:00 UTC
  assert.equal(D.localParts(t, "UTC").hhmm, "22:00");
  assert.equal(D.localParts(t, "America/Mexico_City").hhmm, "16:00");   // UTC-6
  assert.equal(D.localParts(t, "Europe/Madrid").hhmm, "00:00");         // UTC+2 (verano) → ya es el día siguiente
  assert.equal(D.localParts(t, "Europe/Madrid").ymd, "2026-10-10");
  assert.equal(D.localParts(t, "Asia/Kolkata").hhmm, "03:30");          // UTC+5:30
  assert.equal(D.localParts(t, "Pacific/Auckland").hhmm, "11:00");      // UTC+13 (verano austral)
});

test("localParts: medianoche se da como 00, nunca 24", () => {
  const p = D.localParts(utc(2026, 10, 10, 6, 0), "America/Mexico_City");   // 00:00 en CDMX
  assert.equal(p.hh, 0);
  assert.equal(p.hhmm, "00:00");
  assert.equal(p.ymd, "2026-10-10");
});

test("isValidTimeZone", () => {
  for (const ok of ["UTC", "America/Mexico_City", "Asia/Kolkata"]) assert.equal(D.isValidTimeZone(ok), true, ok);
  for (const bad of ["", "Marte/Olympus", "mexico", null, undefined, 5, "x".repeat(65)]) assert.equal(D.isValidTimeZone(bad), false, String(bad));
});

test("nextOccurrence: las 8:00 de Ciudad de México", () => {
  const after = utc(2026, 10, 9, 21, 30);                               // 15:30 en CDMX del 9
  assert.equal(D.nextOccurrence("America/Mexico_City", "08:00", after), utc(2026, 10, 10, 14, 0));   // 08:00 CDMX del 10 = 14:00 UTC
});

test("nextOccurrence: si aún no pasa hoy, es hoy; si ya pasó o es exactamente ahora, mañana", () => {
  const at8 = utc(2026, 10, 9, 14, 0);                                  // 08:00 CDMX del 9
  assert.equal(D.nextOccurrence("America/Mexico_City", "08:00", at8 - 1), at8);
  assert.equal(D.nextOccurrence("America/Mexico_City", "08:00", at8), at8 + 24 * 3_600_000);
  assert.equal(D.nextOccurrence("America/Mexico_City", "08:00", at8 + 1), at8 + 24 * 3_600_000);
});

test("nextOccurrence: la misma hora del reloj cae en instantes UTC distintos según la zona", () => {
  const after = utc(2026, 10, 9, 0, 0);                                 // 00:00 UTC del 9 (en CDMX aún es el 8 a las 18:00)
  const mx = D.nextOccurrence("America/Mexico_City", "21:00", after), es = D.nextOccurrence("Europe/Madrid", "21:00", after), jp = D.nextOccurrence("Asia/Tokyo", "21:00", after);
  assert.equal(mx, utc(2026, 10, 9, 3, 0));                             // 21:00 CDMX del 8 = 03:00 UTC del 9
  assert.equal(es, utc(2026, 10, 9, 19, 0));                            // 21:00 Madrid (verano) = 19:00 UTC
  assert.equal(jp, utc(2026, 10, 9, 12, 0));                            // 21:00 Tokio = 12:00 UTC
});

test("horario de verano: el reloj local manda (el día corto dura 23 h y el largo 25 h)", () => {
  // Nueva York: adelantan el reloj el 8 de marzo de 2026 y lo atrasan el 1 de noviembre.
  const ny = "America/New_York";
  const mar7 = D.nextOccurrence(ny, "08:00", utc(2026, 3, 7, 0, 0));
  const mar8 = D.nextOccurrence(ny, "08:00", mar7);
  assert.equal(D.localParts(mar7, ny).hhmm, "08:00");
  assert.equal(D.localParts(mar8, ny).hhmm, "08:00");
  assert.equal((mar8 - mar7) / 3_600_000, 23);
  // El 1 de noviembre atrasan el reloj: el tramo del 31 de octubre a las 08:00 al 1 de noviembre a las 08:00 dura 25 h.
  const oct31 = D.nextOccurrence(ny, "08:00", utc(2026, 10, 30, 12, 0));
  const nov1 = D.nextOccurrence(ny, "08:00", oct31);
  assert.equal(D.localParts(oct31, ny).ymd, "2026-10-31");
  assert.equal(D.localParts(nov1, ny).hhmm, "08:00");
  assert.equal((nov1 - oct31) / 3_600_000, 25);
});

test("nextOccurrence recorre un año entero sin saltarse ni repetir días, en zonas con y sin horario de verano", () => {
  for (const tz of ["America/New_York", "Europe/Madrid", "Australia/Sydney", "America/Mexico_City", "Asia/Kolkata", "Pacific/Auckland", "America/Sao_Paulo", "UTC"]) {
    for (const hhmm of ["08:00", "11:30", "17:00", "23:30"]) {
      let prev = utc(2026, 1, 1, 0, 0), prevDay = null;
      for (let i = 0; i < 400; i++) {
        const t = D.nextOccurrence(tz, hhmm, prev);
        assert.ok(t > prev, `${tz} ${hhmm} día ${i}: no crece`);
        const p = D.localParts(t, tz);
        assert.equal(p.hhmm, hhmm, `${tz} ${hhmm} día ${i}: el reloj marca ${p.hhmm}`);
        assert.notEqual(p.ymd, prevDay, `${tz} ${hhmm}: dos veces el mismo día ${p.ymd}`);
        const hours = (t - prev) / 3_600_000;
        if (i > 0) assert.ok(hours >= 22.5 && hours <= 25.5, `${tz} ${hhmm} día ${i}: salto de ${hours} h`);
        prev = t; prevDay = p.ymd;
      }
    }
  }
});

test("todas las opciones de la app existen en el reloj de cualquier zona (no caen en un cambio de hora)", () => {
  for (const tz of ["America/New_York", "Europe/Madrid", "Australia/Sydney", "America/Santiago", "Pacific/Auckland", "America/Mexico_City"]) {
    for (const hhmm of [...D.MORNING_OPTIONS, ...D.EVENING_OPTIONS]) {
      let prev = utc(2026, 1, 1, 0, 0);
      for (let i = 0; i < 366; i += 1) {
        const t = D.nextOccurrence(tz, hhmm, prev);
        if (D.localParts(t, tz).hhmm !== hhmm) assert.fail(`${tz} ${hhmm}: el reloj marca ${D.localParts(t, tz).hhmm} el ${D.localParts(t, tz).ymd}`);
        prev = t;
      }
    }
  }
});

test("nextOccurrence con datos inválidos devuelve null sin lanzar errores", () => {
  const now = utc(2026, 10, 9);
  for (const hhmm of ["", "25:00", "8:00", "08:60", "ocho", null, undefined, 800]) assert.equal(D.nextOccurrence("UTC", hhmm, now), null, String(hhmm));
  assert.equal(D.nextOccurrence("Marte/Olympus", "08:00", now), null);
  assert.equal(D.nextOccurrence(undefined, "08:00", now), null);
});

test("nextDigestAt: el menor de los dos resúmenes activos, o null si ninguno", () => {
  const tz = "America/Mexico_City", after = utc(2026, 10, 9, 21, 30);       // 15:30 en CDMX
  assert.equal(D.nextDigestAt({ tz, morning: "08:00", evening: "21:00" }, after), D.nextOccurrence(tz, "21:00", after));   // hoy 21:00 llega antes que mañana 08:00
  assert.equal(D.nextDigestAt({ tz, morning: "08:00", evening: null }, after), D.nextOccurrence(tz, "08:00", after));
  assert.equal(D.nextDigestAt({ tz, morning: null, evening: "21:00" }, after), D.nextOccurrence(tz, "21:00", after));
  assert.equal(D.nextDigestAt({ tz, morning: null, evening: null }, after), null);
  assert.equal(D.nextDigestAt({ tz, morning: "basura", evening: undefined }, after), null);
});

test("las opciones de la app: 14 por la mañana (05:00–11:30) y 14 por la noche (17:00–23:30), todas con formato válido", () => {
  assert.equal(D.MORNING_OPTIONS.length, 14);
  assert.equal(D.EVENING_OPTIONS.length, 14);
  assert.equal(D.MORNING_OPTIONS[0], "05:00");
  assert.equal(D.MORNING_OPTIONS.at(-1), "11:30");
  assert.equal(D.EVENING_OPTIONS[0], "17:00");
  assert.equal(D.EVENING_OPTIONS.at(-1), "23:30");
  for (const o of [...D.MORNING_OPTIONS, ...D.EVENING_OPTIONS]) assert.match(o, D.HHMM);
});
