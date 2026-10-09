// Tema de la app: sistema / claro / oscuro / personalizado (color de acento + color de fondo).
// Se carga en <head> y aplica lo guardado de inmediato para evitar un destello con el tema equivocado.
// También funciona como módulo de Node (tests/client/theme.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.Theme = api; api.init(); }
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULTS = { mode: "system", accent: "#3b6ef5", bg: "#f6f7fb" };
  const MODES = ["system", "light", "dark", "custom"];
  const STORAGE_KEY = "theme";
  const VARS = ["--bg", "--card", "--text", "--muted", "--line", "--primary", "--primary-dark", "--accent-text", "--on-primary", "--today", "--danger"];
  const LIGHT_TEXT = "#f5f7fb", DARK_TEXT = "#14181f";

  /* ---------- Matemática de color ---------- */
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

  function parseHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const toHex = (rgb) => "#" + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

  function luminance(hex) {
    const [r, g, b] = parseHex(hex);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  function contrast(a, b) {            // razón de contraste WCAG (1 a 21)
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function mix(a, b, t) {
    const A = parseHex(a), B = parseHex(b);
    return toHex(A.map((v, i) => v + (B[i] - v) * t));
  }
  // Acerca `fg` a negro o blanco (el que más contraste dé) hasta alcanzar `min` contra `bg`.
  function ensureContrast(fg, bg, min) {
    if (contrast(fg, bg) >= min) return fg;
    const target = contrast("#000000", bg) >= contrast("#ffffff", bg) ? "#000000" : "#ffffff";
    for (let i = 1; i <= 20; i++) {
      const c = mix(fg, target, i / 20);
      if (contrast(c, bg) >= min) return c;
    }
    return target;
  }
  const readableOn = (bg) => (contrast(LIGHT_TEXT, bg) >= contrast(DARK_TEXT, bg) ? LIGHT_TEXT : DARK_TEXT);

  /* ---------- Paleta derivada de acento + fondo ---------- */
  function derivePalette(input) {
    const accent = isHex(input && input.accent) ? input.accent : DEFAULTS.accent;
    const bg = isHex(input && input.bg) ? input.bg : DEFAULTS.bg;
    const dark = contrast(LIGHT_TEXT, bg) > contrast(DARK_TEXT, bg);          // fondo oscuro si el texto claro se lee mejor
    const text = readableOn(bg);
    const card = dark ? mix(bg, "#ffffff", 0.06) : mix(bg, "#ffffff", 0.55);
    const today = mix(bg, accent, dark ? 0.22 : 0.14);
    // Legible (≥ 4.5:1) siempre sobre el fondo; sobre tarjeta y "hoy" también cuando se puede sin perder lo anterior
    // (con un fondo de luminosidad media ningún color alcanza 4.5:1 sobre todas las superficies a la vez).
    const against = (color) => {
      let c = ensureContrast(color, bg, 4.5);
      for (const surface of [card, today]) {
        const t = ensureContrast(c, surface, 4.5);
        if (contrast(t, bg) >= 4.5) c = t;
      }
      return c;
    };
    const onPrimary = contrast("#ffffff", accent) >= contrast("#000000", accent) ? "#ffffff" : "#000000";
    return {
      scheme: dark ? "dark" : "light",
      vars: {
        "--bg": bg,
        "--card": card,
        "--text": against(text),
        "--muted": against(mix(text, bg, 0.4)),
        "--line": mix(bg, text, 0.14),
        "--primary": accent,                                                   // relleno de botones y marcas
        "--primary-dark": dark ? mix(accent, "#ffffff", 0.2) : mix(accent, "#000000", 0.25),
        "--accent-text": against(accent),                                       // el acento usado como texto
        "--on-primary": onPrimary,                                              // texto sobre el relleno
        "--today": today,
        "--danger": against("#d33b3b"),
      },
    };
  }

  // Aviso para la interfaz cuando el acento casi no se distingue del fondo.
  function describe(p) {
    const n = normalize(p);
    return contrast(n.accent, n.bg) < 3
      ? "El acento se parece mucho al fondo: se ajustó automáticamente el color del texto para que se lea bien."
      : "";
  }

  /* ---------- Preferencias ---------- */
  function normalize(p) {
    const o = p && typeof p === "object" ? p : {};
    return {
      mode: MODES.includes(o.mode) ? o.mode : DEFAULTS.mode,
      accent: isHex(o.accent) ? o.accent.toLowerCase() : DEFAULTS.accent,
      bg: isHex(o.bg) ? o.bg.toLowerCase() : DEFAULTS.bg,
    };
  }
  function load() {
    try { return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch (_) { return { ...DEFAULTS }; }
  }
  function save(p) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(p))); } catch (_) {}
  }

  let originalThemeColor = null;
  function apply(p, doc) {
    doc = doc || document;
    const t = normalize(p), el = doc.documentElement;
    VARS.forEach((v) => el.style.removeProperty(v));
    el.style.removeProperty("color-scheme");
    if (t.mode === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", t.mode);

    let themeColor = null;
    if (t.mode === "custom") {
      const pal = derivePalette(t);
      for (const [k, v] of Object.entries(pal.vars)) el.style.setProperty(k, v);
      el.style.setProperty("color-scheme", pal.scheme);
      themeColor = pal.vars["--bg"];
    }
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) {
      if (originalThemeColor === null) originalThemeColor = meta.getAttribute("content");
      meta.setAttribute("content", themeColor || originalThemeColor);
    }
  }
  function init() { try { apply(load()); } catch (_) {} }

  return { DEFAULTS, MODES, VARS, isHex, parseHex, toHex, luminance, contrast, mix, ensureContrast, readableOn, derivePalette, describe, normalize, load, save, apply, init };
});
