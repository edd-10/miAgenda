// Captura en lenguaje natural (español): "dentista el viernes 5pm avisar 30 min antes" → título, fecha, hora y aviso.
// Es una función pura (sin red ni IA): NL.parse(texto, ahora). También funciona como módulo de Node (tests/client/nl.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NL = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  // Opciones que acepta la app (deben coincidir con los selectores y con las reglas de Firestore).
  const REMIND_OPTIONS = [0, 5, 15, 30, 60, 1440];
  const NAG_OPTIONS = [5, 10, 15, 30];

  const MONTHS = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9,
    octubre: 10, noviembre: 11, diciembre: 12,
    ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sept: 9, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
  };
  const WEEKDAYS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
  const NUMWORDS = {
    un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
    once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, media: 0.5,
  };

  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const validYMD = (y, m, d) => { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };

  // Minúsculas y sin acentos ni ñ, conservando la longitud para poder recortar el texto original por posición.
  const MAP = { á: "a", à: "a", ä: "a", â: "a", é: "e", è: "e", ë: "e", ê: "e", í: "i", ì: "i", ï: "i", î: "i",
    ó: "o", ò: "o", ö: "o", ô: "o", ú: "u", ù: "u", ü: "u", û: "u", ñ: "n" };
  const norm = (s) => s.toLowerCase().replace(/[áàäâéèëêíìïîóòöôúùüûñ]/g, (c) => MAP[c]);

  // Texto con dos vistas del mismo largo: la original (para el título) y la normalizada (para buscar).
  function makeBuf(text) {
    let o = text.normalize("NFC"), n = norm(o);
    return {
      get orig() { return o; },
      // Busca `re`; si `fn` devuelve algo (no null), borra lo encontrado y lo devuelve.
      take(re, fn) {
        const m = re.exec(n);
        if (!m) return null;
        const r = fn ? fn(m) : {};
        if (r === null || r === undefined) return null;
        const blank = " ".repeat(m[0].length);
        o = o.slice(0, m.index) + blank + o.slice(m.index + m[0].length);
        n = n.slice(0, m.index) + blank + n.slice(m.index + m[0].length);
        return r;
      },
    };
  }

  const numOf = (tok) => (/^\d+$/.test(tok) ? Number(tok) : NUMWORDS[tok]);
  const nearest = (value, options) =>        // en un empate gana el mayor (avisar antes es más seguro que después)
    options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) || (Math.abs(o - value) === Math.abs(best - value) && o > best) ? o : best));

  /* ---------- Fragmentos de expresiones regulares ---------- */
  const NUM = String.raw`(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|media)`;
  const AMPM = String.raw`(a\.?\s?m\.?|p\.?\s?m\.?)`;
  const PERIOD = String.raw`(manana|tarde|noche|madrugada|dia)`;
  const WORDHOUR = "una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce";
  const monthAlt = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

  const RE = {
    noRemind: /\b(?:sin\s+(?:aviso|recordatorio|alarma|notificacion(?:es)?)|no\s+avis\w+|no\s+recordar\w*)\b/,
    remindOnTime: /\bavis\w*\s+a\s+la\s+hora\b/,
    remind: new RegExp(String.raw`\b(?:(?:avis\w*|recuerd\w*|record\w*|alarm\w*|notific\w*)\s+)?(?:con\s+)?${NUM}\s*(min(?:utos?)?|h(?:oras?)?|dias?)\s+(?:antes|de\s+anticipacion)\b`),
    nagWord: new RegExp(String.raw`\binsist\w*(?:\s+cada\s+${NUM}\s*(min(?:utos?)?|h(?:oras?)?))?`),
    nagEvery: new RegExp(String.raw`\b(?:repet\w*|repit\w*)\s+cada\s+${NUM}\s*(min(?:utos?)?|h(?:oras?)?)\b`),
    relative: new RegExp(String.raw`\b(?:en|dentro\s+de)\s+${NUM}\s*(min(?:utos?)?|h(?:oras?)?|dias?|semanas?|mes(?:es)?)\b`),
    noon: /\b(?:al\s+)?mediodia\b/,
    midnight: /\b(?:a\s+la\s+)?medianoche\b/,
    hhmm: new RegExp(String.raw`\b(?:a\s+las?\s+)?(\d{1,2}):(\d{2})(?:\s*${AMPM}(?![a-z]))?(?:\s+(?:de\s+la\s+|del\s+)${PERIOD}\b)?`),
    alas: new RegExp(String.raw`\ba\s+(?:las|la)\s+(\d{1,2}|${WORDHOUR})(?:\s+(y\s+media|y\s+cuarto|menos\s+cuarto|y\s+\d{1,2}))?(?:\s*${AMPM}(?![a-z]))?(?:\s+(?:de\s+la\s+|del\s+)${PERIOD}\b)?`),
    ampm: new RegExp(String.raw`\b(\d{1,2})\s*${AMPM}(?![a-z])(?:\s+(?:de\s+la\s+|del\s+)${PERIOD}\b)?`),
    period: new RegExp(String.raw`\b(\d{1,2})\s+(?:de\s+la\s+|del\s+)${PERIOD}\b`),
    periodPhrase: new RegExp(String.raw`\b(?:(?:de|por|en)\s+la|del)\s+${PERIOD}\b`),
    dayAfterTomorrow: /\bpasado\s+manana\b/,
    tomorrow: /\bmanana\b/,
    today: /\bhoy\b/,
    weekday: /\b(?:el\s+)?(?:(proximo|proxima|este|esta)\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/,
    iso: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,
    numeric: /\b(?:el\s+)?(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/,
    dayMonth: new RegExp(String.raw`\b(?:el\s+)?(\d{1,2})\s*(?:de\s+)?(${monthAlt})\.?(?:\s+(?:de(?:l)?\s+)?(\d{4}))?(?![a-z])`),
    dayOnly: /\bel\s+(\d{1,2})\b/,
  };

  /* ---------- Hora ---------- */
  // Pasa una hora "como se dice" a 24 h. `assumed` avisa cuando hubo que adivinar a. m./p. m.
  function to24(h, ampm, period) {
    if (ampm) {
      if (h < 1 || h > 12) return null;
      const pm = ampm[0] === "p";
      return { h: pm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h), assumed: null };
    }
    if (h > 23) return null;
    if (h === 0 || h > 12) return { h, assumed: null };            // ya viene en 24 h
    if (period) {
      const table = {
        manana: h,
        tarde: h === 12 ? 12 : h + 12,
        noche: h === 12 ? 0 : h >= 6 ? h + 12 : h,
        madrugada: h === 12 ? 0 : h,
        dia: h === 12 ? 12 : h <= 6 ? h + 12 : h,
      };
      return { h: table[period], assumed: null };
    }
    if (h === 12) return { h: 12, assumed: null };
    return h <= 6 ? { h: h + 12, assumed: "pm" } : { h, assumed: "am" };   // "a las 5" → 17:00, "a las 9" → 09:00
  }

  function parseTime(buf) {
    // Palabras con hora propia
    let r = buf.take(RE.noon, () => ({ minutes: 12 * 60, assumed: null }));
    if (r) return r;
    r = buf.take(RE.midnight, () => ({ minutes: 0, assumed: null }));
    if (r) return r;

    const fromParts = (h, min, ampm, period) => {
      if (min > 59) return null;
      const t = to24(h, ampm && ampm.replace(/[^ap]/g, ""), period);
      return t ? { minutes: t.h * 60 + min, assumed: t.assumed } : null;
    };

    r = buf.take(RE.hhmm, (m) => fromParts(Number(m[1]), Number(m[2]), m[3], m[4]));
    if (!r) r = buf.take(RE.alas, (m) => {
      const h = numOf(m[1]);
      let min = 0, offset = 0;
      const phrase = (m[2] || "").replace(/\s+/g, " ");
      if (phrase === "y media") min = 30;
      else if (phrase === "y cuarto") min = 15;
      else if (phrase === "menos cuarto") offset = -15;
      else if (phrase) min = Number(phrase.slice(2));
      const t = fromParts(h, min, m[3], m[4]);
      return t ? { minutes: (t.minutes + offset + 1440) % 1440, assumed: t.assumed } : null;
    });
    if (!r) r = buf.take(RE.ampm, (m) => fromParts(Number(m[1]), 0, m[2], m[3]));
    if (!r) r = buf.take(RE.period, (m) => fromParts(Number(m[1]), 0, null, m[2]));
    return r;
  }

  /* ---------- Fecha ---------- */
  function parseDate(buf, today, time, nowMin) {
    // Relativas: pasado mañana, mañana, hoy
    if (buf.take(RE.dayAfterTomorrow)) return { date: addDays(today, 2) };
    if (buf.take(RE.tomorrow)) return { date: addDays(today, 1) };
    if (buf.take(RE.today)) return { date: today };

    // Días de la semana
    const wd = buf.take(RE.weekday, (m) => ({ mod: m[1], dow: WEEKDAYS[m[2]] }));
    if (wd) {
      let delta = (wd.dow - today.getDay() + 7) % 7;
      if (delta === 0 && (/^prox/.test(wd.mod || "") || (time && time.minutes <= nowMin))) delta = 7;
      return { date: addDays(today, delta) };
    }

    // Fechas completas: 2026-10-15, 15/10/2026, 15/10, 15 de octubre (de 2026)
    let invalid = false;
    const iso = buf.take(RE.iso, (m) => {
      const y = +m[1], mo = +m[2], d = +m[3];
      if (!validYMD(y, mo, d)) { invalid = true; return {}; }
      return { date: new Date(y, mo - 1, d) };
    });
    if (iso) return iso.date ? iso : { invalid };

    const withYear = (d, mo, y, explicitYear) => {
      if (!validYMD(y, mo, d)) return null;
      let date = new Date(y, mo - 1, d);
      if (!explicitYear && date < today) {                       // sin año y ya pasó: es el del año próximo
        if (!validYMD(y + 1, mo, d)) return null;
        date = new Date(y + 1, mo - 1, d);
      }
      return date;
    };
    const fixYear = (y) => (y < 100 ? 2000 + y : y);

    const dm = buf.take(RE.dayMonth, (m) => {
      const d = +m[1], mo = MONTHS[m[2]];
      const date = withYear(d, mo, m[3] ? +m[3] : today.getFullYear(), !!m[3]);
      if (!date) { invalid = true; return {}; }
      return { date };
    });
    if (dm) return dm.date ? dm : { invalid };

    const nu = buf.take(RE.numeric, (m) => {
      const d = +m[1], mo = +m[2];
      if (mo < 1 || mo > 12) return null;                        // no es una fecha (p. ej. "3-45")
      const date = withYear(d, mo, m[3] ? fixYear(+m[3]) : today.getFullYear(), !!m[3]);
      if (!date) { invalid = true; return {}; }
      return { date };
    });
    if (nu) return nu.date ? nu : { invalid };

    // "el 15": el próximo día 15
    const only = buf.take(RE.dayOnly, (m) => {
      const d = +m[1];
      if (d < 1 || d > 31) return null;
      for (let k = 0; k < 13; k++) {
        const y = today.getFullYear() + Math.floor((today.getMonth() + k) / 12), mo = ((today.getMonth() + k) % 12) + 1;
        if (validYMD(y, mo, d) && new Date(y, mo - 1, d) >= today) return { date: new Date(y, mo - 1, d) };
      }
      return null;
    });
    return only || null;
  }

  /* ---------- Título ---------- */
  // Solo formas verbales completas: así "Aviso de pago", "Recordatorio de renta" o "Ponche de frutas" no pierden su primera palabra.
  const LEAD = /^(?:(?:recu[eé]rda(?:me)?|recordar(?:me)?|av[ií]sa(?:me|r|rme)?|agrega(?:r|me)?|agr[eé]game|anota(?:r|me)?|an[oó]tame|crea|crear|cr[eé]ame|pon|ponme|poner)\s+(?:que\s+|de\s+|a\s+)?)+/iu;
  const EDGE_WORDS = "el|la|los|las|a|al|de|del|en|para|por|y|con|que";
  function cleanTitle(s) {
    let t = s.replace(/\s+/g, " ").trim();
    t = t.replace(LEAD, "");
    const strip = (re) => { const next = t.replace(re, "").trim(); if (next) t = next; };
    for (let i = 0; i < 4; i++) {
      strip(new RegExp(String.raw`^(?:${EDGE_WORDS})(?:\s+|$)`, "i"));
      strip(new RegExp(String.raw`(?:^|\s+)(?:${EDGE_WORDS})$`, "i"));
      strip(/^[\s,.;:\-–—]+|[\s,.;:\-–—]+$/g);
    }
    t = t.replace(/\s+([,.;:])/g, "$1");
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
  }

  /* ---------- Principal ---------- */
  // Devuelve { title, date: "YYYY-MM-DD"|null, time: "HH:MM"|null, remindMin: número|null, nagMin: número|null, notes: [...] }.
  // Lo que no se menciona queda en null para que la app use sus valores por defecto.
  function parse(text, nowInput) {
    const now = nowInput ? new Date(nowInput) : new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const buf = makeBuf(String(text || ""));
    const out = { title: "", date: null, time: null, remindMin: null, nagMin: null, notes: [] };

    // 1) Aviso e insistencia (primero, para que "30 min antes" no se confunda con otra cosa)
    if (buf.take(RE.noRemind)) out.remindMin = -1;
    else if (buf.take(RE.remindOnTime)) out.remindMin = 0;
    else {
      const r = buf.take(RE.remind, (m) => {
        const unit = m[2][0] === "m" ? 1 : m[2][0] === "h" ? 60 : 1440;
        const v = numOf(m[1]);
        return v > 0 ? { minutes: v * unit } : null;
      });
      if (r) {
        out.remindMin = nearest(r.minutes, REMIND_OPTIONS);
        if (out.remindMin !== r.minutes) out.notes.push(`remind-adjusted:${r.minutes}->${out.remindMin}`);
      }
    }
    const nagMatch = buf.take(RE.nagEvery, (m) => ({ n: numOf(m[1]), unit: m[2] })) || buf.take(RE.nagWord, (m) => ({ n: m[1] ? numOf(m[1]) : 10, unit: m[2] || "min" }));
    if (nagMatch) {
      const minutes = nagMatch.n * (nagMatch.unit[0] === "h" ? 60 : 1);
      out.nagMin = nearest(minutes > 0 ? minutes : 10, NAG_OPTIONS);
      if (out.nagMin !== minutes) out.notes.push(`nag-adjusted:${minutes}->${out.nagMin}`);
    }

    // 2) "en 2 horas", "dentro de 30 minutos", "en 3 días"
    let relDate = null;
    const rel = buf.take(RE.relative, (m) => ({ v: numOf(m[1]), unit: m[2] }));
    let relativeDone = false;
    if (rel && rel.v > 0) {
      const u = rel.unit[0];
      if (u === "m" && rel.unit[1] === "i") {                      // minutos
        const t = new Date(now.getTime() + rel.v * 60_000);
        out.date = dateKey(t); out.time = `${pad(t.getHours())}:${pad(t.getMinutes())}`; relativeDone = true;
      } else if (u === "h") {                                      // horas
        const t = new Date(now.getTime() + rel.v * 3_600_000);
        out.date = dateKey(t); out.time = `${pad(t.getHours())}:${pad(t.getMinutes())}`; relativeDone = true;
      } else if (u === "d") relDate = addDays(today, Math.round(rel.v));
      else if (u === "s") relDate = addDays(today, Math.round(rel.v * 7));
      else relDate = new Date(today.getFullYear(), today.getMonth() + Math.round(rel.v), today.getDate());   // meses
    }

    // 3) Hora y 4) fecha (la hora primero: "5 de la tarde" no debe confundirse con "mañana")
    let time = null;
    if (!relativeDone) {
      time = parseTime(buf);
      const period = buf.take(RE.periodPhrase, (m) => ({ p: m[1] }));
      if (time && period && time.assumed) {                        // "a las 5 por la tarde"
        const h = Math.floor(time.minutes / 60) % 12 || 12;
        const t = to24(h, null, period.p);
        if (t) time = { minutes: t.h * 60 + (time.minutes % 60), assumed: null };
      }
      if (time) {
        out.time = `${pad(Math.floor(time.minutes / 60))}:${pad(time.minutes % 60)}`;
        if (time.assumed) out.notes.push(`assumed-${time.assumed}`);
      }
    } else {
      buf.take(RE.periodPhrase);
    }

    if (!relativeDone) {
      const d = relDate ? { date: relDate } : parseDate(buf, today, time, nowMin);
      if (d && d.date) out.date = dateKey(d.date);
      else if (d && d.invalid) out.notes.push("invalid-date");
      if (!out.date && time) {                                     // solo hora: hoy si aún no pasa; si ya pasó, mañana
        if (time.minutes <= nowMin) { out.date = dateKey(addDays(today, 1)); out.notes.push("tomorrow-assumed"); }
        else out.date = dateKey(today);
      }
    }

    if (out.date && out.date < dateKey(today)) out.notes.push("past");
    else if (out.date === dateKey(today) && out.time && out.time <= `${pad(now.getHours())}:${pad(now.getMinutes())}`) out.notes.push("past");

    out.title = cleanTitle(buf.orig);
    return out;
  }

  return { parse, REMIND_OPTIONS, NAG_OPTIONS, _to24: to24 };
});
