// server.ts — page dashboard du plugin flow-cartographer (Bun HTTP).
// Sert l'UI nodegraph et l'API JSON du graphe. Stateless : le graphe vit
// dans ~/.open-bot/pages-data/flow-cartographer/graph.json (volume home).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ID = process.env.OPEN_BOT_PLUGIN_ID || "flow-cartographer";
const PORT = Number(process.env.OPEN_BOT_PAGE_PORT || 4746);
const TOKEN = process.env.OPEN_BOT_PAGE_TOKEN || "";
const HOME = process.env.HOME || "/home/agent";
const GRAPH_FILE = join(HOME, ".open-bot/pages-data", PLUGIN_ID, "graph.json");
const VENDOR_DIR = join(HOME, ".open-bot/pages-data", PLUGIN_ID, "vendor");
const TOOL = `/usr/local/bin/ob-plugin-${PLUGIN_ID}-flowcart`;
const VENDORS = ["cytoscape", "dagre", "cytoscape-dagre", "cytoscape-fcose"];

// Le document servi sur "/" doit rester auto-contenu (le proxy du dashboard ne
// garantit que le document et les chemins api/ relatifs). Les libs sont hors
// payload (fenêtre security-review marketplace) : le setup du plugin les
// télécharge versionnées depuis le repo GitHub (checksum sha256), et chaque
// <!--VENDOR:x--> du HTML est remplacé à la volée par le <script> inline.
// Relecture à chaque requête : dès que le setup a écrit les fichiers, la page
// suivante est complète — aucun redémarrage nécessaire.
function assembleUi(html: string): string {
  let missing = false;
  for (const v of VENDORS) {
    const marker = `<!--VENDOR:${v}-->`;
    if (!html.includes(marker)) continue;
    const f = join(VENDOR_DIR, `vendor-${v}.js`);
    if (existsSync(f)) {
      const code = readFileSync(f, "utf-8");
      if (/<\/script/i.test(code) || /<!--/.test(code)) { missing = true; html = html.replace(marker, ""); continue; }
      // fonction de remplacement : le code minifié contient des $& / $'
      html = html.replace(marker, () => `<script data-vendor="${v}">\n${code}\n</script>`);
    } else {
      missing = true;
      html = html.replace(marker, "");
    }
  }
  if (missing) html = html.replace("</head>", "<script>window.__VENDOR_MISSING__=true;</script></head>");
  return html;
}

function pageRes(): Response {
  const uiPath = process.env.OPEN_BOT_PAGE_UI || join(import.meta.dir, "index.html");
  return new Response(assembleUi(readFileSync(uiPath, "utf-8")), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

function jsonRes(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function tokenOk(req: Request): boolean {
  if (!TOKEN) return true;
  // strict : sans le bon token, pas d'accès aux données (le proxy du dashboard
  // transmet x-open-bot-page-token ; un client direct doit le présenter aussi)
  return req.headers.get("x-open-bot-page-token") === TOKEN;
}

async function buildGraph(): Promise<any> {
  if (!existsSync(TOOL)) return { ok: false, erreur: `outil introuvable : ${TOOL}` };
  const proc = Bun.spawn([TOOL, "build"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), 90000);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  clearTimeout(timer);
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, erreur: `build a échoué : ${(err || out || "sortie vide").slice(0, 300)}` };
  }
}

// le checkout local / preview lit index.html sur disque (assembleur commun) ;
// l'install figée marketplace passe le bundle via OPEN_BOT_PAGE_UI.
const routes = { "/": () => pageRes() };

Bun.serve({
  port: PORT,
  routes,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");

    if (path === "/index.html") {
      return pageRes();
    }

    // pas de route /static/ : l'UI est auto-contenue (vendors inlinés dans
    // index.html par scripts/build-ui.ts) — le proxy dashboard ne sert que "/"

    if (!tokenOk(req)) return jsonRes({ ok: false, erreur: "accès refusé : token de page manquant ou invalide" }, 403);

    if (path === "/api/graph") {
      try {
        if (!existsSync(GRAPH_FILE)) {
          return jsonRes({ ok: false, erreur: "Aucun graphe construit — clique « Reconstruire »." });
        }
        return jsonRes(JSON.parse(readFileSync(GRAPH_FILE, "utf-8")));
      } catch (e: any) {
        return jsonRes({ ok: false, erreur: `graphe illisible : ${e?.message || e}` }, 500);
      }
    }

    if (path === "/api/build" && req.method === "POST") {
      const res = await buildGraph();
      return jsonRes(res, res.ok ? 200 : 500);
    }

    if (path === "/api/suggestions") {
      try {
        if (!existsSync(GRAPH_FILE)) return jsonRes({ ok: false, erreur: "Aucun graphe construit." });
        const g = JSON.parse(readFileSync(GRAPH_FILE, "utf-8"));
        return jsonRes({ ok: true, generatedAt: g.generatedAt, count: (g.suggestions || []).length, suggestions: g.suggestions || [] });
      } catch (e: any) {
        return jsonRes({ ok: false, erreur: `graphe illisible : ${e?.message || e}` }, 500);
      }
    }

    return jsonRes({ ok: false, erreur: "introuvable : " + path }, 404);
  },
});

console.log(`[${PLUGIN_ID}] page server on :${PORT}`);
