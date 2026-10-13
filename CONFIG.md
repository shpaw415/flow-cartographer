# flow-cartographer — guide de configuration (pour l'agent installateur)

Rien à configurer : pas de réglage, pas de clé de coffre. Après l'installation,
vérifie que tout tourne :

1. **Construire le premier graphe**

   ```sh
   ob-plugin-flow-cartographer-flowcart build
   ```

   Attendu : JSON `ok:true` avec `counts` (crons, tools, plugins, skills…) et
   `file` pointant vers `~/.open-bot/pages-data/flow-cartographer/graph.json`.
   Si `sources.crons.ok` est `false`, le token du control plane manque dans
   l'environnement — relance depuis un shell du desktop (`OPEN_BOT_LLM_TOKEN`).

2. **Page dashboard** — onglet « Carte des flux » du dashboard : le graphe doit
   s'afficher ; sinon l'UI montre l'erreur exacte. « Reconstruire » relance le scan.

3. **Cron quotidien** — le job `plugin:flow-cartographer:refresh` (13:30 UTC)
   scanne en silence et ne réveille l'agent que si une alerte de nettoyage attend.
   `ob-cron list` doit l'afficher actif ; pour tester : `ob-cron run <id>`.

4. **Skill + personnalité** — la skill `flow-cartographer` charge le réflexe
   « lire la carte avant de toucher un cron » ; la personnalité **Cartographe**
   (nouveau fil) accompagne l'utilisateur pour modifier les chemins.

Aucune marche à suivre avec l'utilisateur : il n'a rien à remplir.
