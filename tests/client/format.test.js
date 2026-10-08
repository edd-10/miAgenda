// Pruebas del formato de hora. Ejecutar con: npm run test:client
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatTime, to24, from24, pad2 } = require("../../public/format.js");

test("24 h: deja la hora como está", () => {
  assert.equal(formatTime("09:30", "24"), "09:30");
  assert.equal(formatTime("21:05", "24"), "21:05");
  assert.equal(formatTime("00:00", undefined), "00:00");
});

test("12 h: casos de borde (medianoche, mediodía, 1 pm)", () => {
  assert.equal(formatTime("00:00", "12"), "12:00 a. m.");
  assert.equal(formatTime("00:05", "12"), "12:05 a. m.");
  assert.equal(formatTime("09:30", "12"), "9:30 a. m.");
  assert.equal(formatTime("11:59", "12"), "11:59 a. m.");
  assert.equal(formatTime("12:00", "12"), "12:00 p. m.");
  assert.equal(formatTime("13:00", "12"), "1:00 p. m.");
  assert.equal(formatTime("21:30", "12"), "9:30 p. m.");
  assert.equal(formatTime("23:59", "12"), "11:59 p. m.");
});

test("un texto que no es hora se devuelve tal cual (sin lanzar errores)", () => {
  for (const v of ["", "9:30", "25:00x", "abc", null, undefined]) {
    assert.doesNotThrow(() => formatTime(v, "12"));
  }
  assert.equal(formatTime("abc", "12"), "abc");
  assert.equal(formatTime(null, "12"), "");
});

test("to24 y from24 son inversas para las 24 horas del día", () => {
  for (let h = 0; h < 24; h++) {
    const { hour12, ampm } = from24(h);
    assert.ok(hour12 >= 1 && hour12 <= 12, `hora12 ${hour12}`);
    assert.equal(to24(hour12, ampm), h, `ida y vuelta de ${h}`);
  }
});

test("to24: 12 a. m. es 0 y 12 p. m. es 12", () => {
  assert.equal(to24(12, "am"), 0);
  assert.equal(to24(12, "pm"), 12);
  assert.equal(to24(1, "pm"), 13);
  assert.equal(to24("9", "pm"), 21);
});

test("el formato 12 h y la ida y vuelta cubren los 1440 minutos del día", () => {
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) {
    const hhmm = `${pad2(h)}:${pad2(m)}`;
    const out = formatTime(hhmm, "12");
    const parsed = /^(\d{1,2}):(\d{2}) ([ap])\. m\.$/.exec(out);
    assert.ok(parsed, `formato válido para ${hhmm}: ${out}`);
    assert.equal(to24(parsed[1], parsed[3] === "p" ? "pm" : "am"), h, hhmm);
    assert.equal(parsed[2], pad2(m), hhmm);
  }
});
