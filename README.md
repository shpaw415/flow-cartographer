# flow-cartographer — Cartographe de flux open-bot

Cartographie les chemins de requêtes du desktop open-bot : il analyse les
cron-jobs, les skills (locales + OpenViking) et les plugins installés, puis
construit un nodegraph interactif montrant **quand un cron s'exécute, quels
outils il appelle, quels plugins il lit ou modifie, quelles mémoires il
consulte** — tout ce qu'il faut pour déboguer un chemin ou faire du nettoyage.

## Contenu

- **Outil `ob-plugin-flow-cartographer-flowcart`** — scanner et requêtes :
  - `build` — scanne tout et construit le graphe (`~/.open-bot/pages-data/flow-cartographer/graph.json`)
  - `who <nœud>` — dépendances inverses : qui touche cet outil/plugin/skill, jusqu'aux crons
  - `what <cron>` — chemin sortant d'un cron (outils, plugins, skills, mémoires, modèle, persona)
  - `cleanup` — suggestions de nettoyage (crons morts, références cassées, skills orphelins)
  - `refresh` — build + cleanup, pensé pour le cron quotidien (`[cron-agent]` seulement si alerte)
  - `dot` — export Graphviz pour le debug visuel
- **Onglet dashboard « Carte des flux »** — nodegraph interactif (Cytoscape.js) :
  nœuds colorés par type, filtres, recherche, clic = détail + voisinage,
  panneau de suggestions de nettoyage, bouton Reconstruire.
- **Skill `flow-cartographer`** — quand et comment lire la carte et modifier un chemin sans rien casser.
- **Personnalité « Cartographe »** — guide l'utilisateur pour comprendre un chemin et le retargeter.
- **Cron `plugin:flow-cartographer:refresh`** — scan quotidien 13:30 UTC ; réveille l'agent seulement si une alerte attend.

## Sources scannées

| Source | Comment |
| --- | --- |
| Cron-jobs | API du control plane (`/api/cron`) : prompt, script, horaire, runKind, modèle, persona, erreurs |
| Outils | `/usr/local/bin/ob-*`, rattachés à leur plugin par le nommage `ob-plugin-<id>-<outil>` |
| Plugins | `ob-plugin list` (version, local, désactivé) + pages dashboard actives |
| Skills locales | `~/.config/opencode/skills/*/SKILL.md` |
| Skills OpenViking | API OpenViking (`/api/v1/skills`) |
| Personnalités | `ob-persona list` |
| Mémoires | URI `viking://…` citées dans les prompts/scripts des crons |

**Vie privée** : les prompts et scripts des crons ne sont jamais persistés dans
le graphe — seulement les liens qu'ils créent (outils, plugins, skills, URI
mémoires), leur longueur et leurs métadonnées. Les endpoints `/api/*` de la
page exigent le token de page quand il est configuré.

Aucune clé de coffre, aucun réglage requis.

## Développement

```sh
bun run scripts/gen.ts          # régénère open-bot.plugin.json depuis tools/ + server/ + parts/
ob-plugin validate ~/plugins-create/flow-cartographer
ob-plugin install --path ~/plugins-create/flow-cartographer
```
