# flow-cartographer — skill

Lire la carte des flux du desktop avant de modifier un chemin, et guider les
modifications sans rien casser. Déclencheurs : « pourquoi ce cron fait ça »,
« qui utilise ce plugin/cet outil », « nettoie les crons », « montre le
chemin de… », débogage d'un job planifié, suppression ou retarget d'un cron/skill,
onglet « Carte des flux » du dashboard.

# Cartographe de flux

L'outil est `ob-plugin-flow-cartographer-flowcart` (sortie JSON, `ok:true/false`).
La carte se voit dans l'onglet **Carte des flux** du dashboard ; en chat, passe
par le CLI.

## 1. Avoir une carte fraîche

```sh
ob-plugin-flow-cartographer-flowcart build     # scan complet (crons, skills, plugins)
ob-plugin-flow-cartographer-flowcart graph --pretty
```

`counts` donne la taille du graphe. Si `sources.crons.ok` est `false`, le graphe
est partiel (skills/plugins seulement) : dis-le et ne déduis rien des crons.

## 2. Explorer un chemin

```sh
# qui touche ce nœud (dépendances inverses, jusqu'aux crons) — impact avant modif
ob-plugin-flow-cartographer-flowcart who ob-plugin-price-scout-quote
ob-plugin-flow-cartographer-flowcart who price-scout
ob-plugin-flow-cartographer-flowcart who plugin:shared-calendar

# ce que fait un cron (outils appelés, plugins utilisés, mémoires lues, modèle, persona)
ob-plugin-flow-cartographer-flowcart what fb-guardian-watcher
```

Résous un nœud par nom exact ou partiel ; `who` renvoie `cronsQuiYArrivent` —
la liste des jobs à prévenir/valider avant de toucher la cible.

## 3. Nettoyer

```sh
ob-plugin-flow-cartographer-flowcart cleanup
```

- `alerte` : cron désactivé mais déjà exécuté, cron en erreur, référence d'outil cassée.
- `info` : cron jamais exécuté, skill local sans cron, plugin désactivé.

Une `info` n'est pas un ordre de suppression : un skill sert souvent à la
demande. Confirme avec l'utilisateur avant tout `ob-cron remove` définitif —
préfère désactiver (case du job dans le dashboard) le temps d'observer.

## 4. Modifier un chemin sans casser

1. `who <cible>` d'abord : liste les crons qui arrivent sur la cible.
2. Modifie le plus proche de l'utilisateur : `ob-cron set <id> --message/--script`
   pour un prompt, le skill source (OpenViking `add_skill`) pour une méthode,
   `ob-plugin settings` pour un réglage de plugin.
3. Rejoue : `ob-cron run <id>` (ou le cas métier exact) et vérifie le résultat réel.
4. `build` à nouveau : la carte doit montrer le nouveau chemin, sans référence cassée
   (`cleanup` vide côté `alerte`).

## 5. Règles

- Ne supprime jamais un cron `plugin:<id>:…` d'un plugin installé : passe par
  `ob-plugin remove` ou la garde du plugin, sinon le plugin le recrée.
- Ne montre pas de secrets : les prompts/scripts de crons peuvent en contenir —
  cite les chemins, pas les valeurs.
- Après toute modification, la source de vérité est un `build` frais, pas la carte en mémoire.
