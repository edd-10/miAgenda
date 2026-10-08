// Pruebas del tema (color derivado de acento + fondo). Ejecutar con: npm run test:client
const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../public/theme.js");

// Cuadrícula determinista de colores: extremos, grises críticos, primarios y una rejilla de tonos.
function sampleColors() {
  const out = ["#000000", "#ffffff", "#777777", "#808080", "#767676", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"];
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) out.push(T.toHex([r, g, b]));
  return out;
}

test("contraste WCAG: valores conocidos", () => {
  assert.equal(T.contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(T.contrast("#ffffff", "#ffffff").toFixed(2), "1.00");
  assert.ok(Math.abs(T.contrast("#767676", "#ffffff") - 4.54) < 0.02);   // el gris más claro con 4.5:1 sobre blanco
});

test("ensureContrast alcanza el mínimo y no toca lo que ya cumple", () => {
  assert.equal(T.ensureContrast("#000000", "#ffffff", 4.5), "#000000");
  const c = T.ensureContrast("#aaaaaa", "#ffffff", 4.5);
  assert.ok(T.contrast(c, "#ffffff") >= 4.5);
});

test("el texto, el texto atenuado, el acento como texto y el peligro se leen (≥ 4.5:1) sobre el fondo con cualquier combinación", () => {
  for (const bg of sampleColors()) for (const accent of ["#3b6ef5", "#ff0000", "#00ff00", "#ffff00", bg]) {
    const v = T.derivePalette({ accent, bg }).vars;
    for (const k of ["--text", "--muted", "--accent-text", "--danger"]) {
      const c = T.contrast(v[k], v["--bg"]);
      assert.ok(c >= 4.5, `${k} sobre fondo ${bg} con acento ${accent}: ${c.toFixed(2)}`);
    }
  }
});

test("el texto sobre el botón de acento se lee (≥ 4.5:1) con cualquier acento", () => {
  for (const accent of sampleColors()) {
    const v = T.derivePalette({ accent, bg: "#f6f7fb" }).vars;
    assert.ok(T.contrast(v["--on-primary"], accent) >= 4.5, `acento ${accent}`);
  }
});

test("sobre tarjetas y el día de hoy el texto es legible (≥ 3:1) y, fuera de la zona media de luminosidad, ≥ 4.5:1", () => {
  for (const bg of sampleColors()) {
    const v = T.derivePalette({ accent: "#3b6ef5", bg }).vars;
    const L = T.luminance(bg), strict = L < 0.08 || L > 0.35;
    for (const surface of ["--card", "--today"]) {
      for (const k of ["--text", "--muted", "--accent-text"]) {
        const c = T.contrast(v[k], v[surface]);
        assert.ok(c >= 3, `${k} sobre ${surface} con fondo ${bg}: ${c.toFixed(2)}`);
        if (strict) assert.ok(c >= 4.5, `${k} sobre ${surface} con fondo ${bg} (fuera de la zona media): ${c.toFixed(2)}`);
      }
    }
  }
});

test("el esquema (claro/oscuro) sigue a la luminosidad del fondo", () => {
  assert.equal(T.derivePalette({ accent: "#3b6ef5", bg: "#ffffff" }).scheme, "light");
  assert.equal(T.derivePalette({ accent: "#3b6ef5", bg: "#f6f7fb" }).scheme, "light");
  assert.equal(T.derivePalette({ accent: "#3b6ef5", bg: "#000000" }).scheme, "dark");
  assert.equal(T.derivePalette({ accent: "#3b6ef5", bg: "#12151c" }).scheme, "dark");
});

test("la paleta define todas las variables CSS que usa la hoja de estilos", () => {
  const vars = T.derivePalette(T.DEFAULTS).vars;
  assert.deepEqual(Object.keys(vars).sort(), [...T.VARS].sort());
  for (const v of Object.values(vars)) assert.match(v, /^#[0-9a-f]{6}$/);
});

test("entradas inválidas caen a los valores por defecto sin lanzar errores", () => {
  for (const bad of [null, undefined, {}, { accent: "rojo", bg: 5 }, { accent: "#12", bg: "#gggggg" }]) {
    assert.doesNotThrow(() => T.derivePalette(bad));
    assert.deepEqual(T.normalize(bad), T.DEFAULTS);
  }
  assert.equal(T.normalize({ mode: "inventado" }).mode, "system");
  assert.equal(T.normalize({ mode: "custom", accent: "#ABCDEF" }).accent, "#abcdef");
});

test("describe avisa solo cuando el acento casi no se distingue del fondo", () => {
  assert.equal(T.describe({ mode: "custom", accent: "#3b6ef5", bg: "#f6f7fb" }), "");
  assert.notEqual(T.describe({ mode: "custom", accent: "#f6f7fa", bg: "#f6f7fb" }), "");
});

// apply() sobre un documento simulado, sin navegador.
function fakeDoc() {
  const style = { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } };
  const attrs = {}, meta = { c: "#3b6ef5", getAttribute: () => meta.c, setAttribute: (_, v) => { meta.c = v; } };
  return {
    documentElement: { style, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } },
    querySelector: () => meta, attrs, style, meta,
  };
}

test("apply: sistema no deja nada forzado; claro/oscuro solo ponen data-theme", () => {
  const d = fakeDoc();
  T.apply({ mode: "dark" }, d);
  assert.equal(d.attrs["data-theme"], "dark");
  assert.deepEqual(d.style.props, {});
  T.apply({ mode: "system" }, d);
  assert.equal(d.attrs["data-theme"], undefined);
});

test("apply: personalizado pone las variables y ajusta theme-color; volver a sistema lo limpia todo", () => {
  const d = fakeDoc();
  T.apply({ mode: "custom", accent: "#e91e63", bg: "#101820" }, d);
  assert.equal(d.attrs["data-theme"], "custom");
  assert.equal(d.style.props["--bg"], "#101820");
  assert.equal(d.style.props["--primary"], "#e91e63");
  assert.equal(d.style.props["color-scheme"], "dark");
  assert.equal(d.meta.c, "#101820");
  T.apply({ mode: "system" }, d);
  assert.deepEqual(d.style.props, {});
  assert.equal(d.meta.c, "#3b6ef5");                      // se restaura el theme-color original
});
