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
const TOOL = `/usr/local/bin/ob-plugin-${PLUGIN_ID}-flowcart`;

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

// le payload installé est PRÉFIXÉ (ob-plugin-<id>-index.html) ; le nom nu ne
// reste que pour l'exécution depuis le checkout
const INDEX_CANDIDATES = [
  join(import.meta.dir, `ob-plugin-${PLUGIN_ID}-index.html`),
  join(import.meta.dir, "index.html"),
];
function indexHtml(): string {
  for (const p of INDEX_CANDIDATES) {
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  return "<h1>flow-cartographer</h1><p>index.html manquant</p>";
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");

    if (path === "/" || path === "/index.html") {
      try {
        return new Response(indexHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      } catch (e: any) {
        return new Response(`index.html manquant : ${e?.message || e}`, { status: 500 });
      }
    }

    if (path.startsWith("/static/")) {
      const name = path.replace("/static/", "").replace(/[^a-zA-Z0-9._-]/g, "");
      // payload installé : fichiers préfixés à côté du serveur ; checkout : libs dans server/vendor/
      const candidates = [
        join(import.meta.dir, `ob-plugin-${PLUGIN_ID}-${name}`),
        join(import.meta.dir, name),
        join(import.meta.dir, "vendor", name),
      ];
      for (const f of candidates) {
        if (existsSync(f)) {
          return new Response(readFileSync(f), {
            headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "max-age=300" },
          });
        }
      }
      return jsonRes({ ok: false, erreur: "fichier statique introuvable : " + name }, 404);
    }

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
