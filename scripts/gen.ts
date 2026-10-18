#!/usr/bin/env bun
// gen.ts — assemble open-bot.plugin.json depuis tools/, server/ et parts/.
// Le contenu du tool est inliné dans le manifest (tools[].content) ; les files[]
// pointent vers server/server.ts et server/index.html (à marqueurs <!--VENDOR:*-->).
// Les libs cytoscape/dagre sont HORS payload (fenêtre security-review marketplace
// : 128K/fichier) : le setup les télécharge versionnées depuis ce repo GitHub
// (checksum sha256) vers ~/.open-bot/pages-data/flow-cartographer/vendor/, et
// server.ts assemble la page auto-contenue au runtime. Rejouer après chaque
// release : le tag de l'URL raw doit être le tag qui porte CE manifest.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

const tool = read("tools/flowcart.ts");
const skillBody = read("parts/skill.md");
const persona = read("parts/persona.txt").trim();

const TAG = "v0.1.5";
const VENDOR_SHA: Record<string, string> = {
  cytoscape: "83e8c54a6bec655bfd81df07df605649c268af69aeca67a5ea2da54ea42dac81",
  dagre: "62eb9787ccfdbdf4148d4d99d31dbf9ee4770eafee81e637d759b52aac22cd51",
  "cytoscape-dagre": "c7416531f7501f4f047d6ad2f0665aa18c74704abdb2eddb962922e301d4e204",
  "cytoscape-fcose": "5b96abb25cb79ee5822ad703532d59ca8a7366eb97ebe3f71d3000a620f7ffb9",
};
const VENDOR_DIR = "/home/agent/.open-bot/pages-data/flow-cartographer/vendor";
const setupCommands = [
  `mkdir -p ${VENDOR_DIR}`,
  ...Object.entries(VENDOR_SHA).map(
    ([v, sha]) =>
      `curl -fsSL https://raw.githubusercontent.com/shpaw415/flow-cartographer/${TAG}/server/static/vendor-${v}.js -o ${VENDOR_DIR}/vendor-${v}.js && echo '${sha}  ${VENDOR_DIR}/vendor-${v}.js' | sha256sum -c -`
  ),
];
for (const c of setupCommands) {
  if (c.length > 500) throw new Error(`commande setup trop longue (${c.length} > 500) : ${c.slice(0, 60)}…`);
}

if (tool.includes("```")) throw new Error("le tool ne doit pas contenir de triple backtick");
if (persona.length > 2000) throw new Error(`persona trop longue (${persona.length} > 2000)`);

const manifest = {
  $schema: "/home/agent/.config/opencode/skills/plugin/open-bot.plugin.schema.json",
  id: "flow-cartographer",
  name: "Cartographe de flux",
  version: "0.1.5",
  description:
    "Carte des flux open-bot : analyse les cron-jobs, les skills (locales + OpenViking) et les plugins installés, puis affiche un nodegraph interactif — quand un cron s'exécute, quels outils il appelle, quels plugins il lit ou modifie, quelles mémoires il consulte. Requêtes who/what, suggestions de nettoyage, cron quotidien silencieux et personnalité Cartographe pour guider les modifications de chemins.",
  author: "shpaw415",
  repo: "shpaw415/flow-cartographer",
  category: "utilities",
  tags: ["nodegraph", "debug", "cron", "skills", "plugins", "cleanup"],
  tools: [{ name: "flowcart", content: tool }],
  files: [
    { name: "server.ts", source: "server/server.ts", exec: true },
    // page à marqueurs <!--VENDOR:*> — libs assemblées au runtime par server.ts
    { name: "index.html", source: "server/index.html", exec: false },
  ],
  // libs du graphe hors payload : téléchargées versionnées + checksumées (sha256)
  // au install et après chaque desktop recreate ; servies inline dans "/" par le
  // serveur de page (l'UI reste auto-contenue, zéro sous-ressource externe)
  setup: { commands: setupCommands },
  dashboard: {
    pages: { entry: "server.ts", ui: "server/index.html" },
    tabs: [{ id: "flowmap", title: "Carte des flux", kind: "app", icon: "🗺️" }],
  },
  cron: [
    {
      name: "refresh",
      cronExpr: "30 13 * * *",
      run: "auto",
      script: "ob-plugin-flow-cartographer-flowcart refresh",
      message:
        "[cron: plugin:flow-cartographer:refresh] Le scan quotidien de la carte des flux a trouvé des alertes. Lance `ob-plugin-flow-cartographer-flowcart cleanup`, traite les alertes (crons en erreur, références cassées) avec l'utilisateur — info = à confirmer seulement — puis refais `build` pour valider. Réponds court.",
    },
  ],
  personas: [{ name: "Cartographe", instruction: persona }],
  skills: [
    {
      name: "flow-cartographer",
      description:
        "Lire la carte des flux du desktop (crons → outils → plugins → skills → mémoires) avant de modifier un chemin : qui touche quoi, impact d'un changement, nettoyage des nœuds morts. Déclencheurs : « pourquoi ce cron », « qui utilise ce plugin/outil », débogage d'un job planifié, suppression/retarget d'un cron ou skill, onglet Carte des flux.",
      body: skillBody,
    },
  ],
};

writeFileSync(join(ROOT, "open-bot.plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`open-bot.plugin.json écrit (tool ${tool.length}c, persona ${persona.length}c)`);
