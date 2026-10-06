// Valida que los JSON del proyecto sean sintácticamente correctos.
const fs = require("fs");
const files = ["firebase.json", "firestore.indexes.json", ".firebaserc", "public/manifest.json", "package.json", "worker/package.json"];
let bad = 0;
for (const f of files) {
  try { JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { bad++; console.error(`JSON inválido en ${f}: ${e.message}`); }
}
process.exit(bad ? 1 : 0);
