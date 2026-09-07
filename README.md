# GalaxyTimer

Bot Discord de timers pour Galaxy Life. Tu lances une commande quand tu
recuperes un item, le bot te ping dans le salon quand il reset.

Style volontairement "Mudae" : **texte brut, pas d'embed**, et **rien
d'ephemere** — tous les messages sont visibles par le salon. Les textes du bot
sont en anglais ; les commentaires du code restent en francais.

Format du lancement (2 lignes, le repeat n'y figure pas — il est sur le bouton) :

```
**Noe** <:helmet:...> **Helmet** — 1d 11h
Reset in <t:...:R> (<t:...:f>)
```

Format du ping (1 ligne + les boutons) :

```
@Noe <:helmet:...> **Helmet** is ready!
```

A l'echeance, le message de lancement est **edite** : sa ligne de decompte
devient `Completed — <date absolue>` et ses boutons disparaissent. Sans cette
edition, l'horodatage relatif de Discord continue de compter a l'envers
("38 seconds ago", puis "2 hours ago") et un timer termine a l'air actif. Un
timer en `repeat` garde son message vivant, avec la nouvelle echeance.

## Commandes

| Commande | Duree | Nom libre |
|---|---|---|
| `/helmet` | 35h | — |
| `/toolcase` | 23h | — |
| `/starbattery` | 11h | — |
| `/wars [player]` | 3h | nom du joueur dont tu as tape la base |
| `/upgrade <duration> [name]` | au choix | ce qui est en amelioration |
| `/timers` | — | liste tout, avec les boutons Stop |
| `/glhelp` | — | le mode d'emploi complet |

Une commande par type de timer, **generee depuis `src/items.js`** : ajouter une
entree la-bas cree la commande, le bot l'enregistre au demarrage suivant.

`duration` accepte `4h`, `1h30`, `90m`, `2d`.

Pour un test rapide sans attendre 3h : `/upgrade duration:1m name:Test`.

### Timers nommes

`/wars` et `/upgrade` acceptent un nom, ce qui permet **plusieurs timers du meme
type en parallele** : `/wars player:Bnavic` et `/wars player:Tinodon` sont deux
timers distincts. La cle d'un timer est `serveur:user:item:slug` ; sans nom le
slug est vide, donc `/helmet` relance remplace le precedent au lieu d'empiler.

Le nom s'ajoute au libelle (`War Bases — Bnavic`) sauf pour `/upgrade`, ou il le
remplace (`Laboratory` plutot que `Upgrade — Laboratory`).

Il n'y a pas de `/stop` : le bouton fait le travail. `/timers` existe pour
retrouver ces boutons quand le message d'origine est enterre dans l'historique
du salon — sans lui, un timer de 35h deviendrait impilotable.

Le message de ping porte en plus un bouton **Restart**. Seul le proprietaire
d'un timer peut cliquer sur ses boutons.

### Capacite du panneau

Discord plafonne un message a 5 rangees de 5 boutons. Le panneau s'adapte :
jusqu'a 5 timers, une rangee chacun avec **Repeat** et **Stop** ; au-dela, mode
compact avec uniquement les **Stop**, 5 par rangee, soit **25 timers pilotables**.
Le texte les liste tous quoi qu'il arrive, et le Repeat reste accessible sur le
message de chaque timer.

## Aide et description

`/glhelp` et la description de l'application (visible en cliquant sur le bot)
sont **generees depuis `src/items.js`** (`src/help.js`). Ajouter un type de
timer les met a jour sans y toucher : une aide qui ment est pire que pas d'aide.

La description se publie par l'API, pas seulement a la main dans le portail :

```
npm run describe             apercu, ne publie rien
npm run describe -- --apply  publie
```

Discord la plafonne a 400 caracteres, `descriptionText()` tronque au besoin.

## Images et emojis

Deux mecanismes distincts, tous les deux sans embed :

- **Emoji custom** — inline dans le texte (`<:helmet:id>`), comme les 💠 de
  Mudae. Resolu par nom, voir plus bas.
- **Image de l'item** — un PNG depose dans `assets/`, joint au message de
  `/timer` et affiche en dessous du texte. Voir `assets/README.md` pour les noms
  de fichiers attendus. Fichier absent = message sans image, rien ne casse.

## Emojis

Les emojis des items sont resolus **par nom** au demarrage depuis les emojis de
l'application (portail dev > ton app > Emojis), via le champ `emojiName` de
`src/items.js`. Ils s'affichent inline dans le texte, comme chez Mudae — un
embed n'est pas necessaire pour afficher une image d'item.

Reuploader un emoji ou en ajouter un qui manquait ne demande aucune
modification de code. Si le nom n'existe pas, le bot retombe sur l'emoji unicode
et le signale au demarrage.

`npm run emojis` liste ce qui est disponible ; `npm run preview` montre le rendu
texte exact des messages, emojis resolus.

## Installation

1. Cree l'application sur https://discord.com/developers/applications
   -> **New Application** -> onglet **Bot** -> **Reset Token**, copie le token.
2. `cp .env.example .env` puis remplis `DISCORD_TOKEN`, `CLIENT_ID`
   (onglet *General Information*) et `GUILD_ID` — attention, l'ID **du serveur**,
   pas celui de l'application : clic droit sur le serveur -> *Copier
   l'identifiant* (mode developpeur active).
3. Invite le bot via **OAuth2 -> URL Generator**, scopes `bot` **et**
   `applications.commands`, permissions `Send Messages`, `Embed Links`,
   `Read Message History`. Il faut etre admin (ou avoir "Gerer le serveur")
   sur chaque serveur vise.
4. ```
   npm install
   npm run deploy   # une seule fois, et a chaque ajout/modif de commande
   npm start
   ```

Aucun intent privilegie n'est requis : le bot ne lit pas les messages.

## Plusieurs serveurs

**Il n'y a rien a faire : clique le lien d'invitation, c'est tout.**

Le bot enregistre ses commandes lui-meme au demarrage (`src/register.js`), en
**portee globale** : elles valent pour toutes les installations, presentes et
futures. Pas de `deploy` a lancer, pas de `GUILD_ID` a tenir a jour.

Ajouter `&guild_id=<id>` au lien OAuth2 pre-selectionne le serveur. Il faut la
permission "Gerer le serveur" dessus — etre admin suffit, pas besoin d'en etre
proprietaire.

### Pourquoi global et pas par serveur

Les commandes par serveur apparaissent instantanement, contre jusqu'a 1h de
propagation pour les globales. Mais **seules les commandes globales alimentent
la section "Commands" du profil du bot** — les pastilles `/helmet`, `/wars`...
qu'on voit en cliquant dessus. C'est ce qui tranche.

Le delai ne concerne que l'ajout ou la modification d'une commande, jamais leur
utilisation. Au demarrage, le bot supprime aussi les copies par serveur laissees
par l'ancien mode : cumulees avec les globales, elles feraient apparaitre chaque
commande en double.

`npm run deploy` reste la pour resynchroniser a la main sans redemarrer.

### Les timers sont isoles par serveur

Un `/timer helmet` lance sur le serveur A n'apparait pas dans le `/timers` du
serveur B, et son ping part dans le salon du serveur A. C'est voulu : le ping
doit atterrir la ou tu l'as demande, et tes timers ne fuitent pas dans un
serveur ou d'autres gens les verraient. Verrouille par 4 assertions (section 4b
de `test/smoke.mjs`).

## Relancer apres une modification

Node ne recharge rien a chaud.

| Ce que tu changes | Ce qu'il faut faire |
|---|---|
| Un fichier `src/*.js` | relancer (`npm start`) |
| Un item dans `items.js` | relancer |
| Un emoji uploade sur l'application | relancer (resolu au demarrage) |
| Une **commande** ou une de ses options | `npm run deploy` **puis** relancer |
| Les timers eux-memes | rien, lus et ecrits en direct |

Relancer ne perd aucun timer : les dates d'expiration sont sur disque.

`npm run dev` relance tout seul a chaque sauvegarde, pratique pendant le dev.

Le bot refuse de demarrer si une autre instance tourne deja (`src/lock.js`).
Deux bots avec le meme token repondent en double aux memes interactions, et le
plus lent se prend "Unknown interaction" (10062) — mieux vaut un refus clair.

## Fonctionnement

Les timers sont ecrits dans `data/timers.json` avec une **date d'expiration
absolue**, pas un `setTimeout`. Consequence : si le PC s'eteint ou si le bot
plante, rien n'est perdu — au redemarrage il rattrape tout ce qui a expire
pendant la coupure et envoie les pings en retard, en le signalant.

Le scheduler balaie la liste toutes les 10 secondes.

## Scripts

| Script | Quand |
|---|---|
| `npm start` / `npm run dev` | Lancer le bot (dev = relance auto). |
| `npm run deploy` | Resynchroniser les commandes a la main (normalement inutile). |
| `npm run deploy:global` | Deploiement global (~1h de propagation). |
| `npm test` | 102 assertions, sans token Discord. |
| `npm run describe` | Apercu de la description du bot (`-- --apply` pour publier). |
| `npm run preview` | Voir le rendu texte exact des messages. |
| `npm run whereami` | `deploy` renvoie *Missing Access* : compare les serveurs du bot au `GUILD_ID`. |
| `npm run emojis` | Lister les emojis de l'application et du serveur. |

Les tests ecrivent dans `data/timers.test.json` via `GALAXYTIMER_DB`, jamais
dans `data/timers.json`.

## Limite connue

Le bot ne ping que si le processus tourne. Sur un PC qui dort, un timer de 35h
lance a 23h ne pingera qu'au reveil de la machine (avec la mention du retard).
Pour du 24/7 fiable, le deplacer sur un VPS.
