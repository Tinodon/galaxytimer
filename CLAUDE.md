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

## Surface de commandes : la garder minimale

Deux commandes (`/timer`, `/timers`), tout le reste au bouton. Avant d'ajouter
une commande, verifier qu'un bouton ne ferait pas mieux : un bouton est a un
clic et ne peut pas se tromper de nom d'item.

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

## Tests

`npm test` (`test/smoke.mjs`) simule le client Discord -- aucun token requis.
Toute modification du scheduler, du store, du panneau ou des boutons doit rester
couverte.
