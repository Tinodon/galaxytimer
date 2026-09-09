// Construction des messages et des boutons.
//
// Style "Mudae" : texte brut, pas d'embed, rien d'ephemere, AUCUN bouton.
//
// Les boutons ont ete retires a la demande de Noe : retrouver le message d'un
// timer dans l'historique pour cliquer "Relancer" prend plus de temps que de
// retaper /starbattery. Leurs deux fonctions sont devenues des commandes —
// /stop, et une option `repeat` sur chaque commande de timer. Les emojis custom
// s'affichent inline dans le texte et l'image de l'item est une piece jointe —
// aucun embed n'est necessaire pour montrer une image.
//
// Textes en anglais : c'est la langue du jeu et celle du bot.

import { AttachmentBuilder } from 'discord.js';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { formatDuration, discordRelative, discordAbsolute } from './duration.js';
import { resolveArtwork, assetsRoot } from './artwork.js';
import { emojiFor, buttonEmojiFor } from './emoji.js';
import { timerLabel } from './items.js';



// Discord plafonne un message a 5 rangees de 5 boutons.
//
// Jusqu'a 5 timers, une rangee chacun : Repeat + Stop, le confort maximal.
// Au-dela — plausible des qu'on suit une alliance entiere avec /wars — on passe
// en mode compact : uniquement des boutons Stop, 5 par rangee, donc 25 timers
// pilotables. Le Repeat reste accessible sur le message de chaque timer.
export const PANEL_MAX_ROWS = 5;
export const PANEL_ROOMY_MAX = 5;
export const PANEL_STOPPABLE_MAX = PANEL_MAX_ROWS * 5;


/**
 * Piece jointe du message de lancement.
 *
 * Priorite a l'illustration du NOM quand le type en propose une : sur
 * `/upgrade name:S-Trike`, l'image du S-Trike vaut mieux que l'icone generique
 * d'amelioration. A defaut, l'image fixe de l'item. Sinon rien — le bot reste
 * utilisable sans aucune image.
 */
export function itemImage(item, record = null) {
  const art = artworkFor(item, record);
  return art.file;
}

/**
 * Illustration du message de lancement : { file, url }.
 *
 * `file` est une piece jointe, `url` un lien que Discord deplie en apercu image
 * (cas d'un emoji d'application, qui ne peut pas etre joint comme fichier).
 * Les deux sont nuls quand rien ne correspond — le timer tourne sans image.
 */
export function artworkFor(item, record = null) {
  const empty = { file: null, url: null };

  if (item.artwork && record?.name) {
    const found = resolveArtwork(item.artwork, record.name);
    if (found?.kind === 'file') {
      return { file: new AttachmentBuilder(found.path, { name: basename(found.path) }), url: null };
    }
    if (found?.kind === 'emoji') return { file: null, url: found.url };
  }

  if (!item.image) return empty;
  const path = join(assetsRoot(), item.image);
  if (!existsSync(path)) return empty;
  return { file: new AttachmentBuilder(path, { name: item.image }), url: null };
}

/** Message de lancement : nom, emoji, item, duree, puis la ligne de reset. */
export function startedText(timer, item, username) {
  return [
    `**${username}** ${emojiFor(item)} **${timerLabel(timer, item)}** — ${formatDuration(timer.duration)}`,
    `Reset in ${discordRelative(timer.expiresAt)} (${discordAbsolute(timer.expiresAt)})`,
  ].join('\n');
}

/**
 * Message de lancement une fois le timer echu. Volontairement en horodatage
 * ABSOLU : le format relatif `<t:...:R>` continue de compter dans l'autre sens
 * une fois la date passee ("38 seconds ago", puis "2 hours ago"...), ce qui
 * laisse croire qu'un timer termine tourne encore.
 */
export function completedText(timer, item, username) {
  return [
    `**${username}** ${emojiFor(item)} **${timerLabel(timer, item)}** — ${formatDuration(timer.duration)}`,
    `Completed — ${discordAbsolute(timer.expiresAt)}`,
  ].join('\n');
}

/** Le ping. Une seule ligne : la mention, l'item, et les boutons dessous. */
export function readyText(timer, item) {
  return `<@${timer.userId}> ${emojiFor(item)} **${timerLabel(timer, item)}** is ready!`;
}

/** Texte du panneau /timers. */
export function panelText(timers, itemsById, username) {
  if (!timers.length) {
    return `**${username}**, no active timers. Start one with \`/timer\`.`;
  }

  const lines = timers.map((t) => {
    const item = itemsById[t.itemId];
    const icon = item ? emojiFor(item) : '⏳';
    const label = item ? timerLabel(t, item) : t.itemId;
    const repeat = t.repeat ? ' · 🔁' : '';
    return `${icon} **${label}** — ${discordRelative(t.expiresAt)} ` +
      `(${discordAbsolute(t.expiresAt)})${repeat}`;
  });

  if (timers.length > PANEL_STOPPABLE_MAX) {
    lines.push(`_Only the first ${PANEL_STOPPABLE_MAX} can be stopped here (Discord limit)._`);
  }
  return [`**${username}**, your active timers:`, ...lines].join('\n');
}
