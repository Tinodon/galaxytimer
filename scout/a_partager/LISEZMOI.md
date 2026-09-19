# Cartographier Galaxy Life

Ce dossier fait deux choses :

1. **il parcourt la carte du jeu tout seul** : il tape des coordonnées, clique
   sur chaque galaxie, photographie la fenêtre qui s'ouvre, la referme, et
   recommence ;
2. **il lit les pseudos sur ces photos** et dit qui habite où.

Il ne joue pas, ne touche à aucun compte et n'envoie rien nulle part : tout
reste sur ton ordinateur, dans le dossier `data/` qu'il crée tout seul.

---

## 1. Installer (une fois, ~10 minutes)

**a) Python**
Télécharge Python sur [python.org/downloads](https://www.python.org/downloads/).
Pendant l'installation, coche bien **« Add python.exe to PATH »**.

**b) Tesseract** (le lecteur de texte)
Télécharge l'installateur Windows :
[github.com/UB-Mannheim/tesseract/wiki](https://github.com/UB-Mannheim/tesseract/wiki).
Laisse le dossier proposé par défaut.

**c) Les bibliothèques**
Ouvre l'invite de commandes (touche Windows, tape `cmd`), va dans ce dossier et
lance :

```
pip install -r requirements.txt
```

## 2. La liste des joueurs — déjà fournie

Le dossier `data/joueurs/` contient déjà la liste des 482 000 pseudos existants
du jeu. Elle sert à corriger les fautes de lecture : si la photo donne
`SHOGUMIe`, le script sait que ce joueur n'existe pas et retrouve le vrai.

Tu n'as rien à faire ici. Dans un mois, pour récupérer les nouveaux joueurs :

```
python 0_liste_des_joueurs.py --reset
```

(compte 20 minutes, et une connexion Internet)

## 3. Choisir ta zone

Ouvre `config.json` avec le Bloc-notes. La ligne `zone` dit quelle partie de la
carte tu scannes :

```json
"zone": { "x_min": 0, "x_max": 1408, "y_min": 700, "y_max": 1408 }
```

**Important** : Noé et toi devez avoir des `y_min` / `y_max` **différents**,
sinon vous photographiez deux fois les mêmes galaxies. Mets aussi `origin` au
début de ta zone, par exemple `[0, 700]`.

## 4. Vérifier que les clics tombent juste (2 minutes, à faire une fois)

Les clics sont réglés sur la fenêtre de jeu de Noé. Sur ton écran, ils peuvent
tomber à côté.

1. Ouvre Galaxy Life **en fenêtre** (pas en plein écran), sur la vue de la carte.
2. Lance :

```
python 1_scanner.py --test
```

Il fait 3 déplacements. Regarde le jeu pendant ce temps : la carte doit se
déplacer et une fenêtre de galaxie doit s'ouvrir puis se refermer. Si les clics
tombent à côté, arrête et dis-le à Noé : il ajustera les réglages (il aura
besoin d'une capture d'écran de ton jeu, que tu peux faire avec
`python outils/calibrer_ecran.py`, touche `c`).

## 5. Scanner

```
python 1_scanner.py
```

- Ne touche plus à la souris ni au clavier pendant ce temps : le script les
  pilote. Laisse tourner aussi longtemps que tu veux, idéalement la nuit.
- **Ctrl+C** dans la fenêtre noire pour arrêter. Rien n'est perdu : au prochain
  lancement il reprend exactement là où il s'était arrêté.
- Les photos s'entassent dans `data/captures/1_a_traiter/` (environ 77 Ko
  chacune, soit ~1 Go pour une grosse nuit).

## 6. Lire les photos

```
python 2_lire_captures.py
```

Compte une dizaine de secondes par photo : lance-le pendant que tu fais autre
chose. Il range chaque photo :

- `data/captures/2_validees/` : tous les pseudos ont été reconnus ;
- `data/captures/3_a_verifier/` : au moins un pseudo est douteux. À côté de la
  photo, une copie `..._ENTOURE.png` montre en rouge les pseudos ratés.

Il n'invente jamais un pseudo : dans le doute, il préfère mettre la photo de
côté. Et il ne supprime rien, il ne fait que déplacer les fichiers.

Le résumé lisible de tout ce qu'il a trouvé est dans
`data/journaux/lecture.txt`.

## 7. Envoyer à Noé

Zippe le dossier **`data/captures`** et le fichier
**`data/resultats/systems_resolus.jsonl`**, et envoie-les-lui (Google Drive,
WeTransfer…). Inutile d'envoyer `data/joueurs`, il l'a déjà.

Tu peux ensuite vider `data/captures` si tu manques de place, **une fois qu'il
t'a confirmé la bonne réception**.

---

## Si quelque chose ne va pas

| Ce que tu vois | Ce que ça veut dire |
|---|---|
| `Galaxy Life n'est pas ouvert` | Le jeu doit être lancé, en fenêtre, sur la vue de la carte |
| `tesseract is not installed` | Tesseract n'est pas installé, ou pas dans le PATH (étape 1b) |
| `Dictionnaire absent` | L'étape 2 n'a pas été faite |
| Le scan clique à côté | Ta fenêtre de jeu n'a pas la même taille : voir l'étape 4 |
| Beaucoup de photos en `3_a_verifier` | Normal : environ un tiers. Noé les reprend à la main |

## Ce que ce dossier ne contient pas

Aucun mot de passe, aucun accès à la base de données ni au bot Discord. Rien ne
part sur Internet, à part la demande de la liste des pseudos à l'étape 2, qui
utilise l'interface publique du jeu.
