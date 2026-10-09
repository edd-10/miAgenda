// Pruebas de la captura en lenguaje natural. Ejecutar con: npm run test:client
const { test } = require("node:test");
const assert = require("node:assert/strict");
const NL = require("../../public/nl.js");

// "Ahora" fijo: viernes 9 de octubre de 2026, 15:30.
const NOW = new Date(2026, 9, 9, 15, 30);
const p = (text) => NL.parse(text, NOW);

// Comprueba solo los campos indicados (los demás pueden ser lo que sea).
function expectParse(text, want) {
  const got = p(text);
  for (const [k, v] of Object.entries(want)) {
    if (k === "notes") { for (const n of v) assert.ok(got.notes.includes(n), `"${text}": faltan nota ${n}; hay ${JSON.stringify(got.notes)}`); continue; }
    assert.deepEqual(got[k], v, `"${text}" → ${k}: ${JSON.stringify(got[k])} (esperado ${JSON.stringify(v)}); resultado completo ${JSON.stringify(got)}`);
  }
}

/* ---------- Ejemplos del uso diario ---------- */
test("ejemplo principal: título, día, hora y aviso", () => {
  expectParse("dentista el viernes 5pm avisar 30 min antes", { title: "Dentista", date: "2026-10-09", time: "17:00", remindMin: 30, nagMin: null });
});

test("sin fecha ni hora: solo título", () => {
  expectParse("comprar leche", { title: "Comprar leche", date: null, time: null, remindMin: null, nagMin: null });
  expectParse("comprar pan y leche", { title: "Comprar pan y leche" });
  expectParse("ir a la tienda mañana", { title: "Ir a la tienda", date: "2026-10-10", time: null });
});

test("verbos al inicio: recuérdame, avísame, agrega…", () => {
  expectParse("recuérdame que pague la luz el lunes 9am avisar 1 día antes", { title: "Pague la luz", date: "2026-10-12", time: "09:00", remindMin: 1440 });
  expectParse("recuérdame llamar a mamá mañana", { title: "Llamar a mamá", date: "2026-10-10" });
  expectParse("agregar sacar la basura hoy 8pm", { title: "Sacar la basura", date: "2026-10-09", time: "20:00" });
});

test("los verbos del inicio solo se quitan si son verbos: 'Aviso de pago', 'Recordatorio…' y 'Ponche…' se conservan", () => {
  expectParse("aviso de pago mañana", { title: "Aviso de pago", date: "2026-10-10" });
  expectParse("recordatorio de renta el 15", { title: "Recordatorio de renta", date: "2026-10-15" });
  expectParse("ponche de frutas mañana", { title: "Ponche de frutas" });
  expectParse("creatividad taller viernes", { title: "Creatividad taller" });
  expectParse("anotaciones de clase mañana", { title: "Anotaciones de clase" });
  expectParse("avísame que llame al banco mañana 9am", { title: "Llame al banco", time: "09:00" });
  expectParse("recordarme comprar pan", { title: "Comprar pan" });
  expectParse("ponme una alarma para correr mañana", { title: "Una alarma para correr" });
});

/* ---------- Días ---------- */
test("hoy, mañana y pasado mañana", () => {
  expectParse("x hoy", { date: "2026-10-09" });
  expectParse("x mañana", { date: "2026-10-10" });
  expectParse("x pasado mañana", { date: "2026-10-11" });
  expectParse("examen de mañana 7am", { title: "Examen", date: "2026-10-10", time: "07:00" });
});

test("días de la semana: el más cercano, y 'próximo' fuerza el de la semana siguiente si es hoy", () => {
  expectParse("reunión el jueves", { date: "2026-10-15" });
  expectParse("sábado 10am gym", { title: "Gym", date: "2026-10-10", time: "10:00" });
  expectParse("miércoles junta", { date: "2026-10-14" });
  expectParse("domingo comida", { date: "2026-10-11" });
  expectParse("reunión próximo viernes 5pm", { date: "2026-10-16", time: "17:00" });
  expectParse("cita el próximo lunes a las 4 y media de la tarde", { title: "Cita", date: "2026-10-12", time: "16:30" });
});

test("el mismo día de la semana: hoy si la hora aún no pasó, si no, el de la próxima semana", () => {
  expectParse("yoga viernes 8pm", { date: "2026-10-09", time: "20:00" });     // 20:00 > 15:30
  expectParse("yoga viernes 8am", { date: "2026-10-16", time: "08:00" });     // 08:00 ya pasó
  expectParse("yoga viernes", { date: "2026-10-09" });                         // sin hora: hoy
});

test("fechas explícitas: día y mes, numéricas e ISO", () => {
  expectParse("pagar renta el 15 de noviembre", { title: "Pagar renta", date: "2026-11-15", time: null });
  expectParse("pagar 15 de octubre", { date: "2026-10-15" });
  expectParse("entrega 3 dic", { date: "2026-12-03" });
  expectParse("cumpleaños de ana 3/12", { title: "Cumpleaños de ana", date: "2026-12-03" });
  expectParse("examen 20/10/2026 8:30 am", { title: "Examen", date: "2026-10-20", time: "08:30" });
  expectParse("entrega 2026-12-24 10:00", { date: "2026-12-24", time: "10:00" });
  expectParse("fiesta el 3 de noviembre de 2027", { title: "Fiesta", date: "2027-11-03" });
});

test("sin año y ya pasó: se toma el del año siguiente", () => {
  expectParse("pagar renta 15 de agosto", { date: "2027-08-15" });
  expectParse("pagar 3 sep", { date: "2027-09-03" });
  expectParse("pagar 9 de octubre", { date: "2026-10-09" });                    // hoy no cuenta como pasado
});

test("'el 15' / 'el 3': el próximo día con ese número", () => {
  expectParse("visita el 3", { date: "2026-11-03" });
  expectParse("pago el 15", { date: "2026-10-15" });
  expectParse("pago el 9", { date: "2026-10-09" });
});

test("fechas inválidas no inventan nada", () => {
  const r = p("pagar 31 de febrero");
  assert.equal(r.date, null);
  assert.ok(r.notes.includes("invalid-date"));
  assert.equal(r.title, "Pagar");
  assert.equal(p("pagar 45/13").date, null);
});

test("días que no existen en ese mes no se corren al mes siguiente (31 de noviembre, 29 de febrero sin bisiesto)", () => {
  for (const text of ["pagar 31 de noviembre", "pagar 31 de abril", "pagar 30 de febrero", "pagar 31/11", "pagar 29 de febrero de 2027"]) {
    const r = p(text);
    assert.equal(r.date, null, `"${text}" → ${r.date}`);
    assert.ok(r.notes.includes("invalid-date"), text);
  }
  expectParse("pagar 29 de febrero de 2028", { date: "2028-02-29" });          // bisiesto: sí existe
  expectParse("pagar 30 de noviembre", { date: "2026-11-30" });
});

test("fecha en el pasado con año explícito se marca como pasada", () => {
  expectParse("revisar 20/03/2020", { date: "2020-03-20", notes: ["past"] });
});

test("relativas: en N días / semanas / meses", () => {
  expectParse("en 3 días entregar proyecto", { title: "Entregar proyecto", date: "2026-10-12", time: null });
  expectParse("en una semana revisar", { title: "Revisar", date: "2026-10-16" });
  expectParse("en 2 meses pagar", { date: "2026-12-09" });
});

/* ---------- Horas ---------- */
test("a. m. / p. m. en varios formatos", () => {
  expectParse("x mañana 5pm", { time: "17:00" });
  expectParse("x mañana 5 pm", { time: "17:00" });
  expectParse("x mañana 5:30 p. m.", { time: "17:30" });
  expectParse("x mañana 5:30pm", { time: "17:30" });
  expectParse("x mañana 9am", { time: "09:00" });
  expectParse("x mañana 12am", { time: "00:00" });
  expectParse("x mañana 12pm", { time: "12:00" });
  expectParse("x mañana 12:15 a.m.", { time: "00:15" });
});

test("24 horas", () => {
  expectParse("junta viernes 18:30", { title: "Junta", date: "2026-10-09", time: "18:30" });
  expectParse("x mañana 07:05", { time: "07:05" });
  expectParse("x mañana a las 17:45", { time: "17:45" });
  expectParse("x mañana 23:59", { time: "23:59" });
  expectParse("x mañana 00:00", { time: "00:00" });
});

test("'a las N' sin más: se supone p. m. de 1 a 6 y a. m. de 7 a 11, y se avisa", () => {
  expectParse("x mañana a las 5", { time: "17:00", notes: ["assumed-pm"] });
  expectParse("x mañana a las 9", { time: "09:00", notes: ["assumed-am"] });
  expectParse("x mañana a las 7", { time: "07:00", notes: ["assumed-am"] });
  expectParse("x mañana a las 12", { time: "12:00" });
  expectParse("x mañana a las 15", { time: "15:00" });
  assert.ok(!p("x mañana 5pm").notes.includes("assumed-pm"));                 // explícito: no se supone nada
});

test("de la mañana / tarde / noche / madrugada / del día", () => {
  expectParse("x mañana 5 de la tarde", { date: "2026-10-10", time: "17:00" });
  expectParse("x mañana a las 9 de la mañana", { date: "2026-10-10", time: "09:00" });
  expectParse("x mañana 11 de la noche", { time: "23:00" });
  expectParse("x mañana 12 de la noche", { time: "00:00" });
  expectParse("x mañana a las 3 de la madrugada", { time: "03:00" });
  expectParse("x mañana a las 12 del día", { time: "12:00" });
  expectParse("cena con ana viernes 8 de la noche", { title: "Cena con ana", date: "2026-10-09", time: "20:00" });
});

test("'por la tarde' / 'en la noche' después de la hora", () => {
  expectParse("cita a las 5 por la tarde", { title: "Cita", time: "17:00" });
  expectParse("x mañana a las 9 por la noche", { time: "21:00" });
  expectParse("x mañana a las 8 en la mañana", { time: "08:00" });
  assert.ok(!p("cita a las 5 por la tarde").notes.includes("assumed-pm"));
});

test("y media, y cuarto, menos cuarto, y N", () => {
  expectParse("x mañana a las 5 y media", { time: "17:30" });
  expectParse("x mañana a las 9 y cuarto", { time: "09:15" });
  expectParse("x mañana a las 5 menos cuarto", { time: "16:45" });
  expectParse("x mañana a las 10 y 20", { time: "10:20" });
  expectParse("x mañana a las 4 y media de la tarde", { time: "16:30" });
});

test("palabras: a la una, a las dos…, mediodía, medianoche", () => {
  expectParse("x mañana a la una", { time: "13:00" });
  expectParse("x mañana a las dos de la tarde", { time: "14:00" });
  expectParse("comer mañana mediodía", { title: "Comer", date: "2026-10-10", time: "12:00" });
  expectParse("x mañana al mediodía", { time: "12:00" });
  expectParse("x mañana medianoche", { time: "00:00" });
});

test("solo hora: hoy si falta, mañana si ya pasó", () => {
  expectParse("reunión a las 17:30", { title: "Reunión", date: "2026-10-09", time: "17:30" });
  const r = p("llamar a las 14:00");
  assert.equal(r.date, "2026-10-10");
  assert.ok(r.notes.includes("tomorrow-assumed"));
  expectParse("cita a la una", { date: "2026-10-10", time: "13:00", notes: ["tomorrow-assumed"] });
  expectParse("a las 5 menos cuarto algo", { date: "2026-10-09", time: "16:45" });
});

test("relativas: en N minutos / horas", () => {
  expectParse("gym en 2 horas", { title: "Gym", date: "2026-10-09", time: "17:30" });
  expectParse("en 30 minutos tomar pastilla", { title: "Tomar pastilla", date: "2026-10-09", time: "16:00" });
  expectParse("dentro de 2 horas llamar", { date: "2026-10-09", time: "17:30" });
  expectParse("en media hora salir", { title: "Salir", time: "16:00" });
  expectParse("en una hora comer", { time: "16:30" });
  assert.equal(NL.parse("en 10 horas dormir", new Date(2026, 9, 9, 20, 0)).date, "2026-10-10");   // cruza la medianoche
});

test("hora inválida no se interpreta", () => {
  assert.equal(p("x mañana 25:00").time, null);
  assert.equal(p("x mañana 10:75").time, null);
  assert.equal(p("x mañana 13pm").time, null);
});

/* ---------- Aviso e insistencia ---------- */
test("aviso: se ajusta a las opciones de la app (0, 5, 15, 30, 60, 1440)", () => {
  expectParse("x mañana 9am 30 minutos antes", { remindMin: 30 });
  expectParse("x mañana 9am avisar 5 min antes", { remindMin: 5 });
  expectParse("x mañana 9am 1 hora antes", { remindMin: 60 });
  expectParse("x mañana 9am una hora antes", { remindMin: 60 });
  expectParse("x mañana 9am media hora antes", { remindMin: 30 });
  expectParse("x mañana 9am un día antes", { remindMin: 1440 });
  expectParse("x mañana 9am con 15 minutos de anticipación", { remindMin: 15 });
  expectParse("x mañana 9am avísame 30 min antes", { remindMin: 30, title: "X" });
  assert.deepEqual([p("x 10 min antes").remindMin, p("x 20 min antes").remindMin, p("x 45 min antes").remindMin, p("x 2 horas antes").remindMin], [15, 15, 60, 60]);
  assert.ok(p("x 10 min antes").notes.includes("remind-adjusted:10->15"));
});

test("sin aviso / a la hora", () => {
  expectParse("tarea mañana 8am sin aviso", { title: "Tarea", remindMin: -1, time: "08:00" });
  expectParse("tarea mañana 8am no avisar", { remindMin: -1 });
  expectParse("tarea mañana 8am avisar a la hora", { remindMin: 0 });
  expectParse("tarea mañana 8am", { remindMin: null });
});

test("insistir: cada N min, o solo 'insistir' (10 min)", () => {
  expectParse("estudiar hoy 7pm insistir cada 10 min", { title: "Estudiar", time: "19:00", nagMin: 10 });
  expectParse("tomar agua insistir", { title: "Tomar agua", nagMin: 10 });
  expectParse("tomar medicina mañana 8am repetir cada 15 minutos", { nagMin: 15 });
  expectParse("x mañana 8am insistir cada media hora", { nagMin: 30 });
  expectParse("x mañana 8am insistir cada 7 min", { nagMin: 5, notes: ["nag-adjusted:7->5"] });
});

test("la palabra 'repetir' sola es parte del título, no una insistencia", () => {
  expectParse("repetir examen mañana", { title: "Repetir examen", nagMin: null, date: "2026-10-10" });
});

test("lo que parece cantidad no se toma por hora, fecha ni aviso", () => {
  expectParse("comprar 2 boletos", { title: "Comprar 2 boletos", date: null, time: null });
  expectParse("ver capítulo 5 mañana", { title: "Ver capítulo 5", date: "2026-10-10", time: null });
  expectParse("hacer 30 min de ejercicio mañana", { title: "Hacer 30 min de ejercicio", remindMin: null, date: "2026-10-10" });
  expectParse("llamar a mamá a las 5 a mamá", { time: "17:00" });
});

/* ---------- Título y casos límite ---------- */
test("el título conserva mayúsculas internas y acentos y solo capitaliza la primera letra", () => {
  expectParse("reunión con la CFE mañana", { title: "Reunión con la CFE" });
  expectParse("llamar al abuelo mañana a las 9", { title: "Llamar al abuelo" });
});

test("conectores sobrantes en los bordes del título se limpian", () => {
  expectParse("dentista el viernes", { title: "Dentista" });
  expectParse("dentista, el viernes a las 5pm.", { title: "Dentista" });
  expectParse("el viernes dentista", { title: "Dentista" });
  expectParse("para mañana: entregar tarea", { title: "Entregar tarea" });
});

test("sin título", () => {
  expectParse("mañana", { title: "", date: "2026-10-10" });
  expectParse("MAÑANA A LAS 9 DE LA MAÑANA", { title: "", date: "2026-10-10", time: "09:00" });
  expectParse("", { title: "", date: null, time: null, remindMin: null, nagMin: null });
  expectParse("   ", { title: "", date: null, time: null });
  expectParse(null, { title: "" });
  expectParse(undefined, { title: "" });
});

test("mayúsculas, acentos y espacios extra no importan", () => {
  expectParse("  DENTISTA   EL   VIERNES   5PM  ", { date: "2026-10-09", time: "17:00" });
  expectParse("miércoles 10am junta", { date: "2026-10-14", time: "10:00", title: "Junta" });
  expectParse("sábado 10am", { date: "2026-10-10", time: "10:00" });
});

test("hora pasada hoy se marca como pasada", () => {
  expectParse("x hoy 8am", { date: "2026-10-09", time: "08:00", notes: ["past"] });
  assert.ok(!p("x hoy 8pm").notes.includes("past"));
});

/* ---------- Robustez ---------- */
test("nunca lanza errores y siempre devuelve valores válidos (fuzzer con 3000 frases al azar)", () => {
  const words = [
    "comprar", "dentista", "reunión", "llamar", "mamá", "el", "la", "de", "a", "las", "en", "por", "y", "para", "con", "que",
    "mañana", "hoy", "pasado", "lunes", "viernes", "sábado", "próximo", "este", "15", "3", "12", "31", "0", "99", "5pm", "9 am", "17:30",
    "25:00", "10:75", "de la tarde", "de la noche", "por la mañana", "y media", "y cuarto", "menos cuarto", "mediodía", "medianoche",
    "octubre", "feb", "sep", "dic", "2026", "2020", "/", "-", ":", ".", "avisar", "30 min antes", "1 día antes", "media hora antes",
    "sin aviso", "insistir", "cada 10 min", "repetir", "cada", "min", "horas", "días", "semanas", "meses", "dentro de", "en 2 horas",
    "ñandú", "😀", "!!!", "¿", "(", ")", "   ", "\n", "a. m.", "p. m.", "am", "pm", "el 15", "15/10", "2026-10-15", "31/02", "45/13",
  ];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(rnd() * 9);
    const text = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ");
    let r;
    assert.doesNotThrow(() => { r = NL.parse(text, NOW); }, `lanzó error con: ${JSON.stringify(text)}`);
    assert.equal(typeof r.title, "string", text);
    if (r.date !== null) assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `fecha inválida con: ${JSON.stringify(text)} → ${r.date}`);
    if (r.date !== null) { const [y, m, d] = r.date.split("-").map(Number); const t = new Date(y, m - 1, d); assert.ok(t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d, `fecha inexistente con: ${JSON.stringify(text)} → ${r.date}`); }
    if (r.time !== null) assert.match(r.time, /^([01]\d|2[0-3]):[0-5]\d$/, `hora inválida con: ${JSON.stringify(text)} → ${r.time}`);
    if (r.remindMin !== null) assert.ok(r.remindMin === -1 || NL.REMIND_OPTIONS.includes(r.remindMin), `aviso inválido con: ${JSON.stringify(text)} → ${r.remindMin}`);
    if (r.nagMin !== null) assert.ok(NL.NAG_OPTIONS.includes(r.nagMin), `insistencia inválida con: ${JSON.stringify(text)} → ${r.nagMin}`);
    assert.ok(r.title.length <= text.length, `el título no puede ser más largo que el texto: ${JSON.stringify(text)}`);
  }
});

test("no hay hora sin fecha: si se reconoce una hora siempre hay día", () => {
  for (const t of ["x 5pm", "x a las 9", "x 17:30", "x en 2 horas", "x medianoche"]) {
    const r = p(t);
    assert.ok(r.time && r.date, `"${t}" → ${JSON.stringify(r)}`);
  }
});

test("la entrada no cambia entre llamadas (sin estado compartido)", () => {
  const a = JSON.stringify(p("dentista el viernes 5pm avisar 30 min antes"));
  p("otra cosa mañana 9am insistir cada 5 min");
  assert.equal(JSON.stringify(p("dentista el viernes 5pm avisar 30 min antes")), a);
});
