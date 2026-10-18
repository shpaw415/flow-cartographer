#!/usr/bin/env bun
// build-ui.ts — génère server/index.html : UI auto-contenue (règle d'or dashboard).
// Les 4 <script src="./static/vendor-*.js"> de server/ui.src.html sont remplacés par
// des <script data-vendor="…"> inline CLASSIQUES (pas de src, pas de type=module).
// Pourquoi inline classique et pas src : le bundler UI de l'install transforme les
// <script src> en <script type="module">, exécuté APRÈS les scripts classiques —
// le code de page tournait avant cytoscape (« cytoscape is not defined », v0.1.3).
// Rejouer après chaque modif de ui.src.html : bun scripts/build-ui.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "server", "ui.src.html");
const OUT = join(ROOT, "server", "index.html");

const VENDORS = [
  "vendor-cytoscape.js",
  "vendor-dagre.js",
  "vendor-cytoscape-dagre.js",
  "vendor-cytoscape-fcose.js",
];

let html = readFileSync(SRC, "utf-8");

for (const name of VENDORS) {
  const code = readFileSync(join(ROOT, "server", "static", name), "utf-8");
  // un </script> ou <!-- dans le code casserait le HTML inline : refuser plutôt que corrompre
  if (/<\/script/i.test(code) || /<!--/.test(code)) {
    throw new Error(`${name} contient </script> ou <!-- : inline dangereux`);
  }
  const tag = `<script src="./static/${name}"></script>`;
  if (!html.includes(tag)) {
    throw new Error(`référence absente de ui.src.html : ${tag}`);
  }
  const slug = name.replace(/^vendor-|\.js$/g, "");
  // fonction de remplacement : le code minifié contient des $& / $' qu'une
  // string de remplacement interpréterait (corruption silencieuse)
  html = html.replace(tag, () => `<script data-vendor="${slug}">\n${code}\n</script>`);
}

// gardes-fous : la sortie doit être auto-contenue et dans le bon ordre
const srcRefs = (html.match(/<script src=/g) || []).length;
const modules = (html.match(/type="module"/g) || []).length;
const vendorTags = (html.match(/<script data-vendor=/g) || []).length;
const mainFirst = html.indexOf("const TYPES = {");
const lastVendorEnd = html.lastIndexOf("</script>", mainFirst);
if (srcRefs !== 0 || modules !== 0) {
  throw new Error(`sortie non auto-contenue : ${srcRefs} script src, ${modules} module`);
}
if (vendorTags !== VENDORS.length) {
  throw new Error(`${vendorTags} vendors inline, attendu ${VENDORS.length}`);
}
if (lastVendorEnd === -1 || lastVendorEnd > mainFirst) {
  throw new Error("ordre invalide : le code de page doit venir APRÈS les vendors");
}

writeFileSync(OUT, html);
console.log(`server/index.html écrit : auto-contenu, ${VENDORS.length} vendors inline, ${(html.length / 1024).toFixed(0)} Ko`);
