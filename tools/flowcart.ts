#!/usr/bin/env bun
// flowcart — CLI du plugin flow-cartographer (open-bot).
// Cartographie les chemins de requêtes : crons → outils → plugins → skills → mémoires.
// Sortie toujours JSON (ok:true/false). Graphe : ~/.open-bot/pages-data/flow-cartographer/graph.json
//
// Sous-commandes :
//   build              Scanner toutes les sources et (re)construire le graphe
//   graph [--pretty]   Afficher le graphe construit
//   who <noeud>        Qui touche ce nœud (dépendances inverses, jusqu'aux crons)
//   what <cron>        Ce que fait un cron (chemin sortant)
//   cleanup            Suggestions de nettoyage (nœuds morts, références cassées)
//   refresh            build + cleanup ; n'imprime [cron-agent] que si du nettoyage attend
//   dot                Export Graphviz du graphe (debug visuel)
//
// Nœud : {id, type, label, detail, data} — types : cron, tool, plugin, skill, persona, model, page, memoire
// Arête : {from, to, kind, count}

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ID = "flow-cartographer";
const HOME = process.env.HOME || "/home/agent";
const DATA_DIR = join(HOME, ".open-bot/pages-data", PLUGIN_ID);
const GRAPH_FILE = join(DATA_DIR, "graph.json");
const BIN_DIR = "/usr/local/bin";
const LOCAL_SKILLS_DIR = join(HOME, ".config/opencode/skills");
const OV_CONF = join(HOME, ".openviking/ovcli.conf");
const PAGES_DIR = join(HOME, ".open-bot/pages");

function out(obj: any, code = 0) {
  console.log(JSON.stringify(obj, null, code === 0 && process.argv.includes("--pretty") ? 2 : 0));
  process.exit(code);
}
function fail(erreur: string, code = 1): never {
  console.log(JSON.stringify({ ok: false, erreur }));
  process.exit(code);
}

// ---------- utilitaires ----------

function escRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function countMatches(text: string, name: string): number {
  if (!name) return 0;
  const re = new RegExp(`(?<![A-Za-z0-9_./-])${escRe(name)}(?![A-Za-z0-9_-])`, "g");
  return (text.match(re) || []).length;
}
function daysSince(ms: number | null | undefined): number | null {
  if (!ms) return null;
  return Math.floor((Date.now() - ms) / 86400000);
}
function fmtSchedule(j: any): string {
  if (j.cronExpr) return `cron ${j.cronExpr} (UTC)`;
  if (j.everySeconds) return `tous les ${j.everySeconds}s`;
  if (j.atMs) return `une fois à ${new Date(j.atMs).toISOString()}`;
  return "?";
}

// noms de skills trop génériques pour être matchés dans les prompts de crons
const GENERIC_SKILL_NAMES = new Set(["plugin", "cron", "skill", "project", "report", "media", "improve", "preview", "persona", "desktop", "thread", "apps", "research"]);

class Graph {
  nodes = new Map<string, any>();
  edges = new Map<string, any>();
  node(id: string, type: string, label: string, detail: string, data: any = {}) {
    const cur = this.nodes.get(id);
    if (cur) {
      // fusion douce (ex. skill présent en local ET sur OpenViking)
      cur.data = { ...data, ...cur.data };
      if (data.sources && cur.data.sources) cur.data.sources = [...new Set([...data.sources, ...cur.data.sources])];
      return cur;
    }
    const n = { id, type, label, detail, data };
    this.nodes.set(id, n);
    return n;
  }
  edge(from: string, to: string, kind: string, count = 1) {
    if (from === to) return;
    const k = `${from}|${to}|${kind}`;
    const cur = this.edges.get(k);
    if (cur) cur.count += count;
    else this.edges.set(k, { from, to, kind, count });
  }
  json() {
    const nodes = [...this.nodes.values()];
    const edges = [...this.edges.values()];
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] || 0) + 1;
    return { ok: true, generatedAt: new Date().toISOString(), plugin: PLUGIN_ID, counts, nodes, edges };
  }
}

// ---------- sources ----------

async function getCrons(g: Graph): Promise<{ ok: boolean; erreur?: string }> {
  const base = process.env.OPEN_BOT_CONTROL_URL || "http://open-bot:8787";
  const token = process.env.OPEN_BOT_LLM_TOKEN || "";
  try {
    const r = await fetch(`${base}/api/cron`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const jobs: any[] = await r.json();
    for (const j of jobs) {
      const id = `cron:${j.id}`;
      const sched = fmtSchedule(j);
      const lastErr = j.lastError ? String(j.lastError).slice(0, 200) : null;
      g.node(
        id,
        "cron",
        j.name,
        `${j.enabled ? "actif" : "désactivé"} · ${sched} · ${j.runKind || "prompt"} · ${j.runCount ?? 0} run(s)${lastErr ? " · ERREUR" : ""}`,
        {
          name: j.name,
          schedule: sched,
          cronExpr: j.cronExpr,
          everySeconds: j.everySeconds,
          runKind: j.runKind,
          enabled: !!j.enabled,
          runCount: j.runCount ?? 0,
          lastRunAt: j.lastRunAt ?? null,
          nextRunAt: j.nextRunAt ?? null,
          lastError: lastErr,
          model: j.providerId && j.modelId ? `${j.providerId}/${j.modelId}` : null,
          personaId: j.personaId ?? null,
          message: j.message ?? null,
          script: j.script ?? null,
        },
      );
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erreur: `crons indisponibles (${e?.message || e})` };
  }
}

async function getPlugins(g: Graph): Promise<string[]> {
  const p = Bun.spawn(["ob-plugin", "list"], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^- ([a-z0-9][a-z0-9._-]*)\s+v(\S+)\s*(\(local\))?\s*(\(disabled\))?\s*(.*)$/);
    if (!m) continue;
    const [, id, ver, local, disabled, desc] = m;
    ids.push(id);
    g.node(
      `plugin:${id}`,
      "plugin",
      id,
      `v${ver}${local ? " (local)" : ""}${disabled ? " · désactivé" : ""} — ${(desc || "").slice(0, 120)}`,
      { id, version: ver, local: !!local, enabled: !disabled, description: (desc || "").slice(0, 300) },
    );
  }
  return ids;
}

async function getTools(g: Graph): Promise<string[]> {
  let names: string[] = [];
  try {
    names = readdirSync(BIN_DIR).filter((n) => /^ob-[a-z0-9-]+$/.test(n));
  } catch {}
  for (const n of names) {
    const pm = n.match(/^ob-plugin-([a-z0-9][a-z0-9._-]*?)-([a-z0-9][a-z0-9_-]*)$/);
    if (pm) {
      // ob-plugin-<pluginId>-<tool> — le pluginId peut contenir des tirets :
      // on ratachera l'arête plus tard avec la liste des plugins connus.
      g.node(`tool:${n}`, "tool", n, `outil du plugin ${pm[1]}`, { ownerPlugin: pm[1], toolName: pm[2] });
    } else {
      g.node(`tool:${n}`, "tool", n, "outil open-bot (cœur)", { core: true });
    }
  }
  return names;
}

function parseFrontmatter(md: string): { name?: string; description?: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: md };
  const fm = m[1];
  const name = fm.match(/^name:\s*(?:'([^']*)'|"([^"]*)"|(.*))$/m);
  const desc = fm.match(/^description:\s*(?:'([^']*)'|"([^"]*)"|(.*))$/m);
  return {
    name: (name?.[1] || name?.[2] || name?.[3] || "").trim() || undefined,
    description: (desc?.[1] || desc?.[2] || desc?.[3] || "").trim() || undefined,
    body: m[2],
  };
}

async function getLocalSkills(g: Graph): Promise<string[]> {
  const names: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(LOCAL_SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {}
  for (const dir of dirs) {
    const f = join(LOCAL_SKILLS_DIR, dir, "SKILL.md");
    if (!existsSync(f)) continue;
    try {
      const parsed = parseFrontmatter(readFileSync(f, "utf-8"));
      const name = parsed.name || dir;
      names.push(name);
      g.node(`skill:${name}`, "skill", name, `${(parsed.description || "").slice(0, 160)}`, {
        sources: ["locale"],
        description: (parsed.description || "").slice(0, 300),
      });
    } catch {}
  }
  return names;
}

async function getVikingSkills(g: Graph): Promise<{ ok: boolean; erreur?: string }> {
  let conf: any;
  try {
    conf = JSON.parse(readFileSync(OV_CONF, "utf-8"));
  } catch {
    return { ok: false, erreur: "conf OpenViking illisible" };
  }
  const base = (conf.url || "http://viking:1933").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/api/v1/skills`, {
      headers: { "X-API-Key": conf.api_key },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const skills: any[] = data?.result?.skills || [];
    for (const s of skills.slice(0, 200)) {
      const name = s.name;
      let content = "";
      try {
        const r2 = await fetch(`${base}/api/v1/skills/${encodeURIComponent(name)}`, {
          headers: { "X-API-Key": conf.api_key },
          signal: AbortSignal.timeout(10000),
        });
        if (r2.ok) {
          const d2 = await r2.json();
          content = String(d2?.result?.content || d2?.result?.overview || "");
        }
      } catch {}
      content = content.slice(0, 20000);
      const id = `skill:${name}`;
      const cur = g.nodes.get(id);
      if (cur) {
        cur.data.sources = [...new Set([...(cur.data.sources || []), "openviking"])];
        cur.data.description = cur.data.description || (s.description || "").slice(0, 300);
      } else {
        g.node(id, "skill", name, `${(s.description || "").slice(0, 160)}`, {
          sources: ["openviking"],
          description: (s.description || "").slice(0, 300),
        });
      }
      if (content) (g.nodes.get(id) as any)._content = content;
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erreur: `skills OpenViking indisponibles (${e?.message || e})` };
  }
}

async function getPersonas(g: Graph): Promise<{ id: string; label: string }[]> {
  const p = Bun.spawn(["ob-persona", "list"], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  const list: { id: string; label: string }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^-\s+(.+?)\s+\[([^\]]+)\]\s*(built-in)?\s*—?(.*)$/);
    if (!m) continue;
    const [, label, id, , desc] = m;
    list.push({ id, label });
    g.node(`persona:${id}`, "persona", label, `${desc ? desc.slice(0, 100) : "personnalité"}${id === "assistant" ? " (cœur)" : ""}`, {
      id,
      label,
      builtin: !!m[3],
    });
  }
  return list;
}

function getPages(g: Graph): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(PAGES_DIR).filter((n) => n.endsWith(".pid")).map((n) => n.replace(/\.pid$/, ""));
  } catch {}
  for (const id of names) {
    g.node(`page:${id}`, "page", `page ${id}`, "page dashboard servie par ce plugin", { pluginId: id });
  }
  return names;
}

// ---------- analyse ----------

function analyze(g: Graph, pluginIds: string[], toolNames: string[]) {
  const knownPluginSet = new Set(pluginIds);
  // arêtes plugin → outil (nommage ob-plugin-<id>-<tool>)
  for (const n of g.nodes.values()) {
    if (n.type !== "tool") continue;
    const owner = n.data?.ownerPlugin;
    if (!owner) continue;
    // retrouve l'id de plugin réel (préfixe le plus long correspondant)
    const ownerId = pluginIds.filter((p) => owner === p || owner.startsWith(p + "-")).sort((a, b) => b.length - a.length)[0];
    if (ownerId && knownPluginSet.has(ownerId)) {
      g.edge(`plugin:${ownerId}`, n.id, "fournit");
      n.data.ownerPlugin = ownerId;
    }
  }
  // arêtes plugin → cron (naming plugin:<id>:*)
  for (const n of g.nodes.values()) {
    if (n.type !== "cron") continue;
    const pm = n.data?.name?.match(/^plugin:([a-z0-9._-]+):/);
    if (pm && knownPluginSet.has(pm[1])) g.edge(`plugin:${pm[1]}`, n.id, "planifie");
  }
  // arêtes plugin → page
  for (const n of g.nodes.values()) {
    if (n.type === "page" && knownPluginSet.has(n.data?.pluginId)) g.edge(`plugin:${n.data.pluginId}`, n.id, "affiche");
  }
  // arêtes plugin → skill embarqué (même nom)
  for (const n of g.nodes.values()) {
    if (n.type === "skill" && knownPluginSet.has(n.label)) g.edge(`plugin:${n.label}`, n.id, "embarque");
  }
  // contenu des crons → outils / plugins / skills / mémoires / modèle / persona
  for (const n of g.nodes.values()) {
    if (n.type !== "cron") continue;
    const text = `${n.data?.message || ""}\n${n.data?.script || ""}`;
    for (const t of toolNames) {
      const c = countMatches(text, t);
      if (c > 0) g.edge(n.id, `tool:${t}`, "appelle", c);
    }
    for (const pid of pluginIds) {
      const c = countMatches(text, pid);
      if (c > 0) g.edge(n.id, `plugin:${pid}`, "utilise", c);
    }
    for (const sn of g.nodes.values()) {
      if (sn.type !== "skill") continue;
      // noms trop génériques (skills du cœur : "plugin", "cron"…) : fausses
      // arêtes en masse sur les gardes de plugins — on ne les matche pas
      if (GENERIC_SKILL_NAMES.has(sn.label)) continue;
      const c = countMatches(text, sn.label);
      if (c > 0) g.edge(n.id, sn.id, "charge", c);
    }
    // mémoires référencées (viking:// URIs)
    const uris = text.match(/viking:\/\/[^\s"'`\])}]+/g) || [];
    for (const u of [...new Set(uris)]) {
      const uid = "memoire:" + Buffer.from(u).toString("base64url").slice(0, 40);
      g.node(uid, "memoire", u.replace(/\/$/, "").split("/").slice(-2).join("/"), u, { uri: u });
      g.edge(n.id, uid, "lit");
    }
    // modèle
    if (n.data?.model) {
      const mid = `model:${n.data.model}`;
      g.node(mid, "model", n.data.model, "modèle utilisé par ce cron", {});
      g.edge(n.id, mid, "tourne-sur");
    }
    // persona
    if (n.data?.personaId) {
      const pid2 = `persona:${n.data.personaId}`;
      if (g.nodes.has(pid2)) g.edge(n.id, pid2, "incarne");
    }
  }
  // skills → outils / plugins référencés dans leur contenu
  for (const n of g.nodes.values()) {
    if (n.type !== "skill") continue;
    const content: string = (n as any)._content || "";
    if (!content) continue;
    for (const t of toolNames) {
      if (countMatches(content, t) > 0) g.edge(n.id, `tool:${t}`, "réfère");
    }
    for (const pid of pluginIds) {
      if (countMatches(content, pid) > 0) g.edge(n.id, `plugin:${pid}`, "pilote");
    }
  }
}

// suggestions de nettoyage
function suggest(g: Graph): any[] {
  const s: any[] = [];
  const push = (severite: string, type: string, cible: string, message: string, action: string) =>
    s.push({ severite, type, cible, message, action });
  const toolIds = new Set([...g.nodes.values()].filter((n) => n.type === "tool").map((n) => n.id));
  for (const n of g.nodes.values()) {
    if (n.type !== "cron") continue;
    const d = n.data || {};
    if (!d.enabled) {
      push(
        d.runCount > 0 ? "alerte" : "info",
        "cron-inactif",
        n.label,
        d.runCount > 0 ? `désactivé (${d.runCount} run(s), dernier ${daysSince(d.lastRunAt) ?? "?"} j)` : "jamais exécuté",
        `supprimer : ob-cron remove ${d.id || n.id.slice(5)} — ou réactiver dans le dashboard`,
      );
    }
    if (d.lastError) {
      push("alerte", "cron-en-erreur", n.label, `dernière exécution en erreur : ${d.lastError}`, "lire le fil du job, corriger, puis ob-cron run " + (d.id || n.id.slice(5)));
    }
  }
  // références d'outils cassées depuis les crons
  for (const e of g.edges.values()) {
    if (e.kind !== "appelle") continue;
    const src = g.nodes.get(e.from);
    const dst = g.nodes.get(e.to);
    if (src?.type === "cron" && dst?.type === "tool" && !existsSync(join(BIN_DIR, dst.label))) {
      push("alerte", "reference-cassee", `${src.label} → ${dst.label}`, `le cron appelle l'outil ${dst.label}, absent de ${BIN_DIR}`, "corriger le prompt/script du cron ou réinstaller le plugin fournisseur");
    }
  }
  // skills locaux jamais référencés par un cron (info seulement : usage à la demande possible)
  const referencedSkills = new Set([...g.edges.values()].filter((e) => e.kind === "charge").map((e) => e.to));
  for (const n of g.nodes.values()) {
    if (n.type === "skill" && n.data?.sources?.includes("locale") && !referencedSkills.has(n.id)) {
      push("info", "skill-sans-cron", n.label, "aucun cron ne charge ce skill (usage à la demande possible)", "garder si utile à la demande, sinon supprimer le skill");
    }
  }
  // plugins désactivés
  for (const n of g.nodes.values()) {
    if (n.type === "plugin" && n.data?.enabled === false) {
      push("info", "plugin-desactive", n.label, "plugin désactivé (outils et skills déchargés)", "ob-plugin enable " + n.label + " — ou remove si abandonné");
    }
  }
  return s;
}

// ---------- sous-commandes ----------

async function scanAll() {
  const g = new Graph();
  const [cronsRes] = await Promise.all([getCrons(g), Promise.resolve()]);
  const pluginIds = await getPlugins(g);
  const toolNames = await getTools(g);
  await getLocalSkills(g);
  const ovRes = await getVikingSkills(g);
  const personas = await getPersonas(g);
  getPages(g);
  analyze(g, pluginIds, toolNames);
  const graph = g.json();
  (graph as any).suggestions = suggest(g);
  (graph as any).sources = { crons: cronsRes, openvikingSkills: ovRes, personasDetectes: personas.length };
  return graph;
}

function loadGraph(): any {
  if (!existsSync(GRAPH_FILE)) fail("aucun graphe construit — lance d'abord : ob-plugin-flow-cartographer-flowcart build", 4);
  return JSON.parse(readFileSync(GRAPH_FILE, "utf-8"));
}

function resolveNode(graph: any, q: string): any | null {
  const nodes: any[] = graph.nodes;
  const byId = nodes.find((n) => n.id === q || n.id === `cron:${q}` || n.id.endsWith(`:${q}`));
  if (byId) return byId;
  const byLabel = nodes.filter((n) => n.label === q);
  if (byLabel.length === 1) return byLabel[0];
  const partial = nodes.filter((n) => n.label.toLowerCase().includes(q.toLowerCase()));
  if (partial.length === 1) return partial[0];
  return byId || byLabel[0] || partial[0] || null;
}

// arêtes de POSSESSION : plugin → ce qu'il fournit. En « who » (dépendances
// inverses) elles créent de faux chemins — exclues du parcours. En « what »
// elles restent : voir les outils d'un plugin est utile.
const OWNERSHIP_KINDS = new Set(["fournit", "planifie", "affiche", "embarque"]);

function neighborhood(graph: any, nodeId: string, dir: "in" | "out" | "both", depth: number): { nodes: any[]; edges: any[] } {
  const keep = new Set<string>([nodeId]);
  const keepEdges: any[] = [];
  let frontier = new Set([nodeId]);
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const e of graph.edges) {
      if (dir !== "out" && OWNERSHIP_KINDS.has(e.kind)) continue;
      if ((dir === "in" || dir === "both") && frontier.has(e.to)) {
        if (!keep.has(e.from)) next.add(e.from);
        keepEdges.push(e);
      }
      if ((dir === "out" || dir === "both") && frontier.has(e.from)) {
        if (!keep.has(e.to)) next.add(e.to);
        keepEdges.push(e);
      }
    }
    for (const x of next) keep.add(x);
    if (!next.size) break;
    frontier = next;
  }
  const seen = new Set<string>();
  const edges = keepEdges.filter((e) => {
    const k = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return keep.has(e.from) && keep.has(e.to);
  });
  return { nodes: graph.nodes.filter((n: any) => keep.has(n.id)), edges };
}

async function cmdBuild() {
  const graph = await scanAll();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(GRAPH_FILE, JSON.stringify(graph));
  const sugg = graph.suggestions || [];
  out({
    ok: true,
    generatedAt: graph.generatedAt,
    counts: graph.counts,
    edges: graph.edges.length,
    sources: graph.sources,
    suggestions: sugg.length,
    file: GRAPH_FILE,
  });
}

function cmdGraph() {
  const graph = loadGraph();
  console.log(JSON.stringify(graph, null, process.argv.includes("--pretty") ? 2 : 0));
}

function cmdWho(q: string) {
  const graph = loadGraph();
  const node = resolveNode(graph, q);
  if (!node) fail(`nœud introuvable : ${q}`, 4);
  const { nodes, edges } = neighborhood(graph, node.id, "in", 2);
  const crons = nodes.filter((n: any) => n.type === "cron" && n.id !== node.id);
  out({ ok: true, node, touches: nodes.filter((n: any) => n.id !== node.id), edges, cronsQuiYArrivent: crons.map((c: any) => c.label) });
}

function cmdWhat(q: string) {
  const graph = loadGraph();
  const node = resolveNode(graph, q);
  if (!node) fail(`nœud introuvable : ${q}`, 4);
  const { nodes, edges } = neighborhood(graph, node.id, "out", 3);
  out({ ok: true, node, chemin: nodes.filter((n: any) => n.id !== node.id), edges });
}

function cmdCleanup() {
  const graph = loadGraph();
  const sugg = graph.suggestions || [];
  out({ ok: true, generatedAt: graph.generatedAt, count: sugg.length, suggestions: sugg });
}

function cmdDot() {
  const graph = loadGraph();
  const colors: Record<string, string> = {
    cron: "#f59e0b", tool: "#3b82f6", plugin: "#22c55e", skill: "#a855f7",
    persona: "#ec4899", model: "#6b7280", page: "#14b8a6", memoire: "#eab308",
  };
  const lines = ["digraph flowcart {", "  rankdir=LR; overlap=false;", '  node [shape=box style="rounded,filled" fontname="Helvetica" fontsize=10];'];
  for (const n of graph.nodes) {
    const label = (n.label || n.id).replace(/"/g, "'");
    lines.push(`  "${n.id}" [label="${n.type}\\n${label}" fillcolor="${colors[n.type] || "#ccc"}" fontcolor="white"];`);
  }
  for (const e of graph.edges) {
    lines.push(`  "${e.from}" -> "${e.to}" [label="${e.kind}"];`);
  }
  lines.push("}");
  console.log(lines.join("\n"));
}

async function cmdRefresh() {
  const graph = await scanAll();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(GRAPH_FILE, JSON.stringify(graph));
  const sugg: any[] = graph.suggestions || [];
  const alertes = sugg.filter((s) => s.severite === "alerte");
  if (alertes.length > 0) {
    console.log(`[cron-agent] flow-cartographer : ${alertes.length} alerte(s) à traiter. Détail : ob-plugin-flow-cartographer-flowcart cleanup`);
    for (const a of alertes.slice(0, 5)) console.log(`  - [${a.type}] ${a.cible} : ${a.message}`);
  } else if (sugg.length > 0) {
    console.log(`flow-cartographer : RAS (${sugg.length} info(s) de nettoyage optionnel, pas d'alerte)`);
  } else {
    console.log("flow-cartographer : RAS");
  }
}

// ---------- main ----------

const [, , cmd, ...rest] = process.argv;
(async () => {
  try {
    switch (cmd) {
      case "build": return await cmdBuild();
      case "graph": return cmdGraph();
      case "who": return rest[0] ? cmdWho(rest[0]) : fail("usage : who <noeud>", 2);
      case "what": return rest[0] ? cmdWhat(rest[0]) : fail("usage : what <cron>", 2);
      case "cleanup": return cmdCleanup();
      case "refresh": return await cmdRefresh();
      case "dot": return cmdDot();
      default:
        fail("usage : build | graph [--pretty] | who <noeud> | what <cron> | cleanup | refresh | dot", 2);
    }
  } catch (e: any) {
    fail(`erreur inattendue : ${e?.message || e}`, 1);
  }
})();
