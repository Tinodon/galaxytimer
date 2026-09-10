# GalaxyTimer -- regles du sous-projet

Bot Discord de timers d'items Galaxy Life. Stack : Node 18+, ESM,
discord.js v14, zero base de donnees (JSON sur disque).

## Invariants a ne pas casser

- **Dates absolues, jamais de `setTimeout` long.** Les timers vont jusqu'a 35h et
  le bot tourne sur un PC qui s'eteint. Tout passe par `expiresAt` + le balayage
  de `src/scheduler.js`. Un `setTimeout(35h)` ne survit pas a un redemarrage.
- **Re-armer avant d'envoyer.** Dans `fire()`, l'etat disque est mis a jour avant
  l'appel reseau : si l'envoi echoue, on ne repingue pas en boucle toutes les 10s.
- **Multi-utilisateur.** Une cle de timer est `guildId:userId:itemId`. Toute
  nouvelle action doit verifier que `interaction.user.id` correspond au user de
  la cle (voir `ownerOf` dans `src/buttons.js`).
- **Ecriture atomique** du store (`.tmp` + `rename`), et un JSON corrompu est
  deplace, jamais ecrase.
- **Une seule instance.** `src/lock.js` refuse le demarrage si un autre bot
  tourne : deux process avec le meme token repondent en double et le plus lent
  echoue en "Unknown interaction" (10062).
- **Les tests n'ecrivent jamais dans `data/timers.json`.** `store.js` honore
  `GALAXYTIMER_DB` ; `test/smoke.mjs` le pointe sur `data/timers.test.json` et
  l'assertion 0 verrouille ce comportement. Sans ca, `npm test` effacerait les
  timers reels en cours.
- **Un message ne doit jamais afficher un decompte perime.** `<t:...:R>` compte
  a l'envers une fois la date passee. Le scheduler edite donc le message de
  lancement a l'echeance (`closeLaunchMessage`), d'ou le `messageId` stocke dans
  le timer. Toute nouvelle surface affichant `discordRelative` sur une date
  future doit prevoir sa fermeture.
- **Emojis resolus par nom, jamais d'ID en dur.** Voir `src/emoji.js` : un ID
  fige casse des que l'emoji est reuploade, et le fallback unicode garantit que
  le bot reste utilisable meme sans emojis custom.

## Style de sortie : texte brut, public

Pas d'embed, pas de `MessageFlags.Ephemeral`. Noe veut du Mudae : du texte que
le salon entier voit. Les emojis custom s'affichent inline dans le texte
(`<:nom:id>`), donc un embed n'est PAS necessaire pour montrer une image d'item
-- seules les vignettes de fichiers PNG l'exigeaient, et elles ont ete retirees.

Le seul ephemere restant : le refus quand quelqu'un clique sur le bouton d'un
timer qui n'est pas le sien. Inutile de polluer le salon avec ca.

Les actions de bouton MODIFIENT le message existant (`interaction.update`)
plutot que d'empiler des confirmations.

**Tous les boutons sont gris** (`ButtonStyle.Secondary`, constante `NEUTRAL`
dans `src/ui.js`). Discord n'expose que 4 styles imposes et aucun moyen de
colorer le texte ; le rouge de Danger et le vert de Success agressent l'oeil sur
un bot consulte en permanence. La distinction passe par l'emoji et le libelle,
jamais par la couleur. Verrouille par une assertion.

Tout message doit porter `allowedMentions` : `{ parse: [] }` partout sauf le
ping, qui mentionne uniquement son proprietaire.

## Surface de commandes : tout par commande, aucun bouton

**Il n'y a plus de boutons.** Retires a la demande de Noe : retrouver le message
d'un timer dans l'historique du salon pour cliquer "Relancer" prend plus de
temps que de retaper `/starbattery`. Ne pas les reintroduire.

Leurs deux roles sont devenus des commandes, et doivent le rester :
- arreter un timer -> `/stop`, avec autocompletion sur les timers de celui qui
  tape (jamais un nom d'item a saisir a la main) ;
- rendre un timer recurrent -> option `repeat` sur chaque commande de timer.

Un test verifie que ces deux chemins existent : sans eux, un timer devient
impossible a arreter ou a rendre recurrent.

La seule raison de garder `/timers` plutot que de tout mettre sur le message du
timer : le message se perd dans l'historique du salon au bout de quelques
heures, et un timer de 35h doit rester pilotable. C'est le critere a appliquer
pour toute future commande -- si un bouton suffit, pas de commande.

Le panneau `/timers` est plafonne a 5 rangees (limite Discord de composants par
message). Au-dela de 5 items simultanes, il faudra passer a un menu deroulant.

## Multi-serveur

Le bot est concu multi-serveur : cle `guildId:userId:itemId`, timers isoles par
serveur, `store.forUser` filtre sur le couple (user, guild). Ne pas "simplifier"
en indexant sur le seul userId : un ping doit partir dans le salon ou le timer a
ete lance.

**Les commandes s'enregistrent seules au demarrage** (`src/register.js`), en
**portee GLOBALE**. Ne pas revenir a la portee par serveur pour gagner en
vitesse de propagation : seules les commandes globales alimentent la section
"Commands" du profil du bot, et c'est un besoin explicite de Noe.

`clearGuildCommands` supprime les copies par serveur de l'ancien mode ; global
et par-serveur cumules affichent chaque commande en double. Ne pas retirer ce
nettoyage tant qu'une installation peut encore en porter.

`GUILD_ID` n'est plus necessaire au fonctionnement ; il ne sert qu'aux scripts
manuels.

**Aide generee, jamais ecrite en dur** (`src/help.js`) : `/glhelp` et la
description de l'application se derivent du registre. Une aide qui ment est pire
que pas d'aide.

## Ajouter un type de timer

**Une entree dans `src/items.js` et c'est tout** : elle devient une slash
command portant son `id`, et le panneau, les messages et le scheduler la
prennent en compte. Le bot enregistre la nouvelle commande au demarrage suivant.

Ajouter aussi l'emoji custom cote application, nomme d'apres `emojiName`.

Ne pas ecrire de handler par commande : `handleCommand` route sur le registre.
Si un type demande un traitement particulier, l'exprimer par un champ du
registre (`customDuration`, `nameOption`, `nameOnly`), pas par un cas special
dans le code.

Retirer un type ne doit pas detruire les timers en cours : `fallbackItem` leur
donne un libelle de repli pour qu'ils sonnent quand meme. Verrouille par un test.

## Cles de timer

`serveur:user:item:slug`. Le slug vient de `slugify(name)` et vaut '' sans nom,
ce qui donne un unique timer par item — relancer `/helmet` remplace. Avec un
nom, plusieurs timers du meme type coexistent.

Contraintes a respecter si on touche a ce format :
- les cles voyagent dans les `customId` de boutons, plafonnes a 100 caracteres ;
- `ownerOf` lit le segment 1, `itemOf` le segment 2 : tout ajout va a la fin ;
- `store.migrateKeys` convertit l'ancien format a 3 segments. Ne pas le
  supprimer sans verifier qu'aucune base en production ne l'utilise encore.

## Hebergement

Le bot vise l'offre gratuite de Render : web service (pas de worker gratuit),
disque ephemere. Deux consequences a ne jamais casser :

- `src/health.js` ouvre un port des que `PORT` est defini. Sans port ecoute,
  Render considere le deploiement rate.
- **Rien d'important ne doit dependre du disque.** `src/store.js` choisit son
  backend selon l'environnement (`src/backends.js`) : fichier en local, Upstash
  des que ses deux variables sont la. Toute nouvelle donnee a conserver passe
  par le store, jamais par un `writeFileSync` direct.

Les ecritures distantes ne sont volontairement pas attendues : une interaction
Discord doit repondre en moins de 3 secondes.

## La carte : base SQL (Postgres chez Neon)

La carte et les pins vivent dans Postgres (`DATABASE_URL`), les timers et
l'intel dans Upstash. Les cles Upstash `galaxytimer:map:*` et `galaxytimer:pins`
ne sont plus lues.

- **Schema defini une seule fois** : `scout/schema.sql`, applique par le bot au
  demarrage (`src/sql.js`) et par `scout/publish_sql.py`. Rejouable, rien n'y
  est supprime.
- `colonies` est la verite (une ligne par colonie, `origine` = `releve` ou
  `pin`). Les 24 cases de `joueurs` (`colonie_n`, `qg_n`) ne s'ecrivent QUE par
  `rafraichir_cases()` — jamais a la main, jamais en JS.
- **Carte globale** : un pin est visible sur tous les serveurs. Choix de Noe :
  le but est de cartographier tout le jeu.
- **Une ligne par PLANETE**, pas par systeme : un joueur peut avoir plusieurs
  planetes au meme endroit (`numero` 1, 2, 3...). Fusionner par (joueur, x, y)
  en avait fait perdre 622. Les 24 cases repetent alors la coordonnee.
- **`/pin` ajoute toujours une planete**, meme sur une case connue (regle de
  Noe) : `/pin Myra 336,7 5` = coordonnee puis QG (1-9, le max du jeu).
- **`/edit` corrige une ligne par son numero dans `/find`** ; `/find` et
  `/edit` partagent l'ordre `x, y, numero` (`PLANET_ORDER` dans map.js). Une
  ligne du releve n'est jamais effacee mais `masquee`, sinon la publication
  suivante la ferait revenir.
- La publication ne remplace que les planetes `releve` non masquees ; un pin
  ou une ligne masquee a la meme place (joueur, x, y, numero) l'emporte.
- Le niveau de QG s'affiche avec l'emoji d'application `starbase`, repli
  "HQ" s'il manque (`NAMED_EMOJIS` dans src/emoji.js). L'aide doit tenir sous
  2000 caracteres AVEC les emojis custom (~30 caracteres chacun) : verifie par
  test/commands.mjs.
- Recherches **par id de joueur** (obtenu via l'API), jamais par pseudo.
- **Un QG inconnu n'affiche rien** sur Discord : ni `HQ ?`, ni `NaN`, ni
  `null`. Verrouille par `test/commands.mjs`.
- Une base injoignable ne bloque pas le demarrage : les timers tournent, les
  commandes de carte repondent une erreur propre.
- **Les tests n'ecrivent jamais dans le schema `public`** : `test/commands.mjs`
  travaille dans le schema `essai` (`GALAXYTIMER_SQL_SCHEMA`), cree puis
  supprime, et verifie que `public` n'a pas bouge.
- En local sans Neon : `npx pglite-server --db=<dossier> --port=5433
  --max-connections=10`, puis `DATABASE_URL=postgres://postgres@localhost:5433/postgres`.

## Tests

`npm test` (`test/smoke.mjs`) simule le client Discord -- aucun token requis.
Toute modification du scheduler, du store, du panneau ou des boutons doit rester
couverte.
