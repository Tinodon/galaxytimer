# Continuer le scan de la map

Où on en est : **~1,5 % de l'univers** (X 0 → 1408, Y 0 → 18). Le scan reprend
tout seul là où il s'est arrêté : les écrans déjà faits sont notés dans
`scout/data/crawl_state.json` et sautés.

Toutes les commandes se lancent depuis :

```
cd C:\Users\noebe\Desktop\HESPER\project\galaxytimer
```

---

## Étape 0 — Avant chaque session

- Galaxy Life ouvert **en fenêtre**, même taille que d'habitude, sur la carte de la galaxie.
- Ne touche plus à la souris ni au clavier pendant le scan : le script les pilote.
- Pour tout arrêter : **Ctrl+C** dans la console. Rien n'est perdu.

## Étape 1 — (Optionnel) Choisir d'où on part

Dans `scout/config.json`, `"origin": [0, 0]` est le point de départ. Le scan
avance **ligne par ligne** vers la droite puis vers le bas.

- Tu laisses `[0, 0]` : il continue la ligne Y 18, puis descend.
- Tu mets une coordonnée proche de ton alliance (ex. `[300, 0]`) : il cartographie
  d'abord cette zone. Les écrans déjà faits restent sautés.

## Étape 2 — Vérifier que tout est calé (30 secondes)

```
python scout/crawler.py --test
```

Il fait 3 positions (sur place, un pas à droite, un pas en bas). Si la caméra
bouge bien et que les popups s'ouvrent, c'est bon.

## Étape 3 — Lancer le scan (la nuit)

```
python scout/crawler.py
```

Il tourne jusqu'à Ctrl+C. Il **capture** les popups dans `scout/data/popups/`
sans les lire (c'est 5× plus rapide). La lecture se fait à l'étape 4.

## Étape 4 — Le lendemain : lire les nouvelles captures

```
python scout/process.py --workers 15
```

**Sans `--all`** : il ne lit que les nouvelles images. ~21 s par image divisé
par 15 cœurs. Il affiche son estimation au démarrage.

Dans une 2e console, pour la barre de progression (ne touche à rien) :

```
python scout/watch.py
```

## Étape 5 — Rattacher les pseudos lus aux vrais joueurs

```
python scout/resolve.py --write
```

~40 min. Compare chaque lecture aux 482 000 vrais pseudos.

## Étape 6 — Publier sur la base (Neon) pour le bot

```
python scout/publish_sql.py
```

Vérifie les chiffres affichés (joueurs, planètes), puis :

```
python scout/publish_sql.py --apply
```

~20 s. Tes `/pin` et `/edit` ne sont jamais écrasés.

## Étape 7 — Vérifier sur Discord

- `!list` : combien de joueurs sur la carte (le total doit avoir monté).
- `!find <pseudo>` sur quelqu'un de la nouvelle zone.
- Les ⚠️ de `!list` = plus de planètes connues que le joueur n'en a : à corriger avec `!edit`.

---

## De temps en temps (1× par mois)

Rafraîchir la liste des vrais joueurs (nouveaux comptes, pseudos changés,
niveaux, alliances) :

```
python scout/roster.py --reset
```

~20 min, puis refaire les étapes 5 et 6.

## Si quelque chose casse

| Symptôme | Cause probable |
|---|---|
| Le scan clique à côté | La fenêtre du jeu n'a pas la même taille qu'avant |
| Les popups restent vides | Bug côté jeu (déjà vu, réglé par le support) |
| `process.py` : « toutes deja traitees » | Normal, aucune nouvelle capture |
| `publish_sql.py` : DATABASE_URL requis | La ligne `DATABASE_URL=` a disparu du `.env` |
