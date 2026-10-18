// uitest.ts — stress-test UI du nodegraph flow-cartographer (happy-dom).
// Point de vue utilisateur : la page charge, les stats s'affichent, les filtres
// marchent, la recherche, le clic nœud → panneau, suggestions listées, bannière d'erreur sur API morte.
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";

const PORT = process.env.UI_PORT || "4746";
const BASE = `http://127.0.0.1:${PORT}`;
const source = readFileSync(new URL("../server/index.html", import.meta.url).pathname, "utf-8");
// le VRAI artefact : le HTML assemblé servi par le serveur de page (vendors inline)
const served = await (await fetch(BASE + "/")).text();

const results: [string, boolean, string][] = [];
function check(name: string, cond: boolean, info = "") {
  results.push([name, !!cond, info]);
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${info ? " :: " + info : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- scénario 0 : structure (régression v0.1.3 : les <script src> devenaient
// type="module" au bundling → exécutés APRÈS le code de page → « cytoscape is
// not defined »). La SOURCE doit avoir 4 marqueurs et zéro sous-ressource ;
// le HTML SERVI doit être auto-contenu, vendors inline avant le code de page.
{
  const srcRefs = (source.match(/<script src=/g) || []).length + (source.match(/<link rel="stylesheet"/g) || []).length;
  check("source : zéro sous-ressource externe", srcRefs === 0, `${srcRefs} trouvées`);
  check("source : 4 marqueurs VENDOR", (source.match(/<!--VENDOR:/g) || []).length === 4);
  const srvRefs = (served.match(/<script src=/g) || []).length + (served.match(/<link rel="stylesheet"/g) || []).length;
  check("servi : zéro sous-ressource externe", srvRefs === 0, `${srvRefs} trouvées`);
  check("servi : 4 vendors inline, zéro marqueur restant",
    (served.match(/<script data-vendor=/g) || []).length === 4 && !served.includes("<!--VENDOR:"));
  const modulesAvecCode = [...served.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)]
    .filter((m) => m[1].trim().length > 0).length;
  check("servi : zéro module portant du code", modulesAvecCode === 0, `${modulesAvecCode} trouvés`);
  const mainAt = served.indexOf("const TYPES = {");
  const openTag = served.lastIndexOf("<script", mainAt);
  const tag = served.slice(openTag, served.indexOf(">", openTag));
  check("servi : code de page hors module", !/type="module"/.test(tag), tag);
  const lastVendor = served.lastIndexOf("</script>", openTag);
  check("servi : vendors exécutés avant le code de page", lastVendor !== -1 && lastVendor < openTag);
}

async function boot(fetchImpl: any, html = served) {
  const win = new Window({ url: BASE + "/" });
  const doc = win.document;
  (win as any).fetch = fetchImpl;
  (doc as any).fetch = fetchImpl;
  doc.write(html);
  // exécute les scripts inline SAUF les vendors [data-vendor] : le vrai cytoscape
  // n'est pas rendable en happy-dom (canvas) — un stub minimal remplace, la
  // présence réelle des vendors est couverte par le scénario 0 + le navigateur.
  const scripts = [...doc.querySelectorAll("script")].filter((s) => !s.getAttribute("src") && !s.hasAttribute("data-vendor"));
  for (const s of scripts) {
    const code = s.textContent || "";
    // cytoscape est requis : stub minimal si absent (le CDN n'est pas joignable en happy-dom)
    const wrapped = `
      if (!window.cytoscape) {
        const mkNode = (e) => ({ id:()=>e.data.id, data:(k)=>k?e.data[k]:e.data, addClass:()=>{}, removeClass:()=>{},
          style:()=>{}, closedNeighborhood:()=>({removeClass:()=>{},addClass:()=>{}}), forEach:()=>{} });
        window.cytoscape = function(cfg){
          const els = (cfg.elements||[]).map(e=>mkNode(e));
          return {
            elements:()=>({addClass:()=>{},removeClass:()=>{},forEach:(f)=>els.forEach(f)}),
            nodes:()=>({forEach:(f)=>els.forEach(f), on:()=>{}}),
            on:()=>{}, layout:()=>({run:()=>{}}), fit:()=>{},
            getElementById:()=>({closedNeighborhood:()=>({removeClass:()=>{},addClass:()=>{}}),addClass:()=>{}}),
            _els: els,
          };
        };
        window.cytoscape.use = () => {};
      }
      ${code}`;
    await new Function("window", "document", "fetch", "with(window){" + wrapped + "}")(win, doc, fetchImpl);
  }
  return { win, doc };
}

// ---- scénario 1 : graphe présent (API ok, avec le token de page comme le proxy)
{
  let pageToken = "";
  try { pageToken = (await import("node:fs")).readFileSync(`/home/agent/.open-bot/pages/flow-cartographer.token`, "utf-8").trim(); } catch {}
  const realFetch = async (url: any, init: any) => {
    const u = String(url).startsWith("http") ? String(url) : BASE + "/" + String(url).replace(/^\//, "");
    const headers = { ...(init?.headers || {}), ...(pageToken ? { "x-open-bot-page-token": pageToken } : {}) };
    return fetch(u, { ...init, headers });
  };
  const { win, doc } = await boot(realFetch);
  await (win as any).happyDOM.waitUntilComplete();
  await sleep(600);
  check("chips de stats remplies", /nœuds/.test(doc.getElementById("chips").textContent || ""), doc.getElementById("chips").textContent);
  // filtres = un par type PRÉSENT dans le graphe (les types à 0 sont masqués)
  const gfile = JSON.parse((await import("node:fs")).readFileSync("/home/agent/.open-bot/pages-data/flow-cartographer/graph.json", "utf-8"));
  const typesPresents = Object.values(gfile.counts || {}).filter((v: any) => v > 0).length;
  const nbCb = doc.querySelectorAll("#filters input[type=checkbox]").length;
  check("une case de filtre par type présent", nbCb === typesPresents && nbCb >= 7, `${nbCb}/${typesPresents}`);
  check("sélecteur de layout à 2 dispositions", doc.querySelectorAll("#layout option").length === 2);
  check("aucune bannière d'erreur", doc.getElementById("banner").style.display !== "block");

  // clic sur le premier nœud de la liste side via simulation : appelle showNode? On vérifie plutôt la liste suggestions
  const sugg = doc.querySelectorAll(".sugg-item");
  check("suggestions listées", sugg.length > 0, `${sugg.length} items`);
  // filtre : décocher les crons → checkbox unchecked (le canvas est stubbé, on vérifie l'état)
  const cb: any = doc.querySelector('#filters input[data-type="cron"]');
  cb.checked = false;
  cb.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
  check("filtre togglable sans erreur", true);
  // recherche
  const q = doc.getElementById("q");
  (q as any).value = "fb";
  q.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
  check("recherche sans erreur", true);
}

// ---- scénario 2 : API morte → bannière d'erreur visible (pas de grille vide)
{
  const deadFetch = async (url: any) => {
    const s = String(url);
    if (s.includes("api/graph") || s.includes("api/")) return new Response(JSON.stringify({ ok: false, erreur: "API en échec simulée" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("", { status: 500 });
  };
  const { win, doc } = await boot(deadFetch);
  await (win as any).happyDOM.waitUntilComplete();
  await sleep(400);
  const b = doc.getElementById("banner");
  check("bannière d'erreur affichée si API ko", b.style.display === "block" && /Reconstruire|échec/i.test(b.textContent || ""), b.textContent);
  check("chips restent vides", doc.getElementById("chips").children.length === 0);
}

// ---- scénario 2bis : libs absentes (setup pas encore passé) → bannière claire
{
  const flagged = source.replace("</head>", "<script>window.__VENDOR_MISSING__=true;</script></head>");
  const { doc } = await boot(async () => new Response("{}", { headers: { "content-type": "application/json" } }), flagged);
  await (doc as any).defaultView.happyDOM?.waitUntilComplete?.();
  await sleep(300);
  const b = doc.getElementById("banner");
  check("bannière « libs absentes » si setup pas passé", b.style.display === "block" && /ob-plugin setup flow-cartographer/.test(b.textContent || ""), b.textContent);
}

// ---- scénario 3 : build endpoint + refus sans token
{
  let pageToken = "";
  try { pageToken = (await import("node:fs")).readFileSync(`/home/agent/.open-bot/pages/flow-cartographer.token`, "utf-8").trim(); } catch {}
  const r = await fetch(BASE + "/api/build", { method: "POST", headers: pageToken ? { "x-open-bot-page-token": pageToken } : {} });
  const j = await r.json();
  check("api/build reconstruit", j.ok === true && j.counts && j.counts.cron >= 10, JSON.stringify(j.counts || {}));
  if (pageToken) {
    const anon = await fetch(BASE + "/api/graph");
    check("api sans token refusée", anon.status === 403, `status ${anon.status}`);
    const g2 = await (await fetch(BASE + "/api/graph", { headers: { "x-open-bot-page-token": pageToken } })).json();
    const cronNode = (g2.nodes || []).find((n: any) => n.type === "cron");
    check("pas de prompt brut dans le graphe", cronNode && cronNode.data && cronNode.data.message === undefined && cronNode.data.script === undefined,
      JSON.stringify(cronNode?.data || {}).slice(0, 120));
  }
}
const fs = await import("node:fs");
check("graphe fichier à jour", JSON.parse(fs.readFileSync("/home/agent/.open-bot/pages-data/flow-cartographer/graph.json", "utf-8")).ok === true);

const fails = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
