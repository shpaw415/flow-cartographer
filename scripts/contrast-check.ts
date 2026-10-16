/**
 * flow-cartographer — audit de contraste WCAG des deux thèmes (règle : clair +sombre).
 * Extrait les variables CSS de la page servie et vérifie les paires texte/fond (min 4.5).
 * Usage : UI_PORT=4746 bun scripts/contrast-check.ts
 */
const PORT = Number(process.env.UI_PORT ?? 4746);
const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();

function varsOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}
const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
const darkIdx = css.search(/html\[data-theme=["']dark["']\]\s*\{/);
if (darkIdx < 0) {
  console.error("bloc html[data-theme=dark] introuvable — page mono-thème ?");
  process.exit(1);
}
const light = varsOf(css.slice(0, darkIdx));
const dark = varsOf(css.slice(darkIdx));

function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg: string, bg: string): number {
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

let fail = 0;
function check(name: string, fg: string, bg: string, min = 4.5) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${r.toFixed(2)}:1 (min ${min})  [${fg} sur ${bg}]`);
}

// encre des pastilles de type (fixe, couleurs de type identiques dans les deux thèmes)
const CHIP_INK = "#0b101b";
// couleur de type la plus claire (mémoires #e8c53d) et la plus soutenue (crons #f59e0b)

for (const [theme, v] of [["clair", light], ["sombre", dark]] as const) {
  console.log(`\n— thème ${theme} —`);
  check(`${theme} boutons/inputs/chips actifs (text/panel2)`, v.text, v.panel2);
  check(`${theme} textes sur fond (text/bg)`, v.text, v.bg);
  check(`${theme} hints (muted/bg)`, v.muted, v.bg);
  check(`${theme} chips inactifs (muted/panel2)`, v.muted, v.panel2);
  check(`${theme} bloc data (muted/data-bg)`, v.muted, v["data-bg"]);
  check(`${theme} détail nœud (detail/panel)`, v.detail, v["panel-solid"]);
  check(`${theme} code suggestions (code/sugg-bg)`, v.code, v["sugg-bg"]);
  check(`${theme} bannière d'erreur (banner-text/banner-bg)`, v["banner-text"], v["banner-bg"]);
  check(`${theme} labels de nœuds du graphe (graph-label/bg)`, v["graph-label"], v.bg);
  check(`${theme} labels d'arêtes en surbrillance (graph-elabel/bg)`, v["graph-elabel"], v.bg, 3.0);
  check(`${theme} pastille de type (ink sur mémoires)`, CHIP_INK, "#e8c53d");
  check(`${theme} pastille de type (ink sur crons)`, CHIP_INK, "#f59e0b");
}

console.log(fail ? `\n${fail} échec(s)` : "\ntous les contrastes passent dans les deux thèmes");
process.exit(fail ? 1 : 0);
