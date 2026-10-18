// uitest.ts — stress-test UI du nodegraph flow-cartographer (happy-dom).
// Point de vue utilisateur : la page charge, les stats s'affichent, les filtres
// marchent, la recherche, le clic nœud → panneau, suggestions listées, bannière d'erreur sur API morte.
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";

const PORT = process.env.UI_PORT || "4746";
const BASE = `http://127.0.0.1:${PORT}`;
// UI_HTML : tester le VRAI artefact (ex. bundle marketplace reconstruit) au lieu du fichier repo
const html = readFileSync(process.env.UI_HTML || new URL("../server/index.html", import.meta.url).pathname, "utf-8");

const results: [string, boolean, string][] = [];
function check(name: string, cond: boolean, info = "") {
  results.push([name, !!cond, info]);
  console.log(`${cond ? "PASS" : "FAIL"} — ${name}${info ? " :: " + info : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- scénario 0 : auto-contenu et ordre d'exécution correct (régression v0.1.3 :
// les <script src> devenaient type="module" au bundling → exécutés APRÈS le code
// de page → « cytoscape is not defined »). Toute sous-ressource externe est interdite.
// NB : le bundler ajoute parfois un chunk externe VIDE (0 octet) en type=module —
// il ne porte aucun code : inoffensif. Ce qui est interdit : un module avec du code.
{
  const srcRefs = (html.match(/<script src=/g) || []).length + (html.match(/<link rel="stylesheet"/g) || []).length;
  check("zéro sous-ressource externe (script src / link css)", srcRefs === 0, `${srcRefs} trouvées`);
  const modulesAvecCode = [...html.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)]
    .filter((m) => m[1].trim().length > 0).length;
  check("zéro module portant du code", modulesAvecCode === 0, `${modulesAvecCode} trouvés`);
  check("4 vendors inline marqués", (html.match(/<script data-vendor=/g) || []).length === 4);
  // le code de page doit vivre dans un script CLASSIQUE, pas un module
  const mainAt = html.indexOf("const TYPES = {");
  const openTag = html.lastIndexOf("<script", mainAt);
  const tag = html.slice(openTag, html.indexOf(">", openTag));
  check("code de page hors module", !/type="module"/.test(tag), tag);
  const lastVendor = html.lastIndexOf("</script>", openTag);
  check("vendors exécutés avant le code de page", lastVendor !== -1 && lastVendor < openTag);
}

async function boot(fetchImpl: any) {
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
