#!/usr/bin/env bun
// gen.ts — assemble open-bot.plugin.json depuis tools/, server/ et parts/.
// Le contenu du tool est inliné dans le manifest (tools[].content) ; les files[]
// pointent vers server/server.ts et server/index.html.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

const tool = read("tools/flowcart.ts");
const skillBody = read("parts/skill.md");
const persona = read("parts/persona.txt").trim();

if (tool.includes("```")) throw new Error("le tool ne doit pas contenir de triple backtick");
if (persona.length > 2000) throw new Error(`persona trop longue (${persona.length} > 2000)`);

const manifest = {
  $schema: "/home/agent/.config/opencode/skills/plugin/open-bot.plugin.schema.json",
  id: "flow-cartographer",
  name: "Cartographe de flux",
  version: "0.1.1",
  description:
    "Carte des flux open-bot : analyse les cron-jobs, les skills (locales + OpenViking) et les plugins installés, puis affiche un nodegraph interactif — quand un cron s'exécute, quels outils il appelle, quels plugins il lit ou modifie, quelles mémoires il consulte. Requêtes who/what, suggestions de nettoyage, cron quotidien silencieux et personnalité Cartographe pour guider les modifications de chemins.",
  author: "Justin Hallé",
  repo: "shpaw415/flow-cartographer",
  category: "utilities",
  tags: ["nodegraph", "debug", "cron", "skills", "plugins", "cleanup"],
  tools: [{ name: "flowcart", content: tool }],
  files: [
    { name: "server.ts", source: "server/server.ts", exec: true },
    { name: "index.html", source: "server/index.html" },
    // libs vendues (le navigateur du dashboard ne joint pas toujours les CDN)
    { name: "vendor-cytoscape.js", source: "server/vendor/vendor-cytoscape.js" },
    { name: "vendor-dagre.js", source: "server/vendor/vendor-dagre.js" },
    { name: "vendor-cytoscape-dagre.js", source: "server/vendor/vendor-cytoscape-dagre.js" },
    { name: "vendor-cytoscape-fcose.js", source: "server/vendor/vendor-cytoscape-fcose.js" },
  ],
  dashboard: {
    pages: { entry: "server.ts" },
    tabs: [{ id: "flowmap", title: "Carte des flux", kind: "app" }],
  },
  cron: [
    {
      name: "refresh",
      cronExpr: "30 13 * * *",
      run: "auto",
      script: "ob-plugin-flow-cartographer-flowcart refresh",
      message:
        "[cron: plugin:flow-cartographer:refresh] Le scan quotidien de la carte des flux a trouvé des alertes. Lance `ob-plugin-flow-cartographer-flowcart cleanup`, traite les alertes (crons en erreur, références cassées) avec Justin — info = à confirmer seulement — puis refais `build` pour valider. Réponds court.",
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
