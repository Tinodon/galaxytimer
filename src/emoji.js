// Resolution des emojis custom de l'application.
//
// On resout par NOM au demarrage plutot que de figer des IDs dans items.js :
// si Noe reuploade un emoji (nouvel ID) ou en ajoute un qui manquait, le bot
// le prend sans modification de code. Si le nom n'existe pas, on retombe sur
// l'emoji unicode de l'item — le bot reste utilisable dans tous les cas.

import { ITEM_LIST } from './items.js';
import { loadEmojiArtwork } from './artwork.js';

/** @type {Map<string, string>} itemId -> "<:nom:id>" */
const resolved = new Map();

/**
 * Emojis qui ne sont pas des icones de timer, resolus par nom eux aussi.
 * `starbase` remplace le mot "HQ" devant un niveau de QG (demande de Noe).
 * Chacun a un repli texte : sans l'emoji, le bot affiche le mot.
 */
export const NAMED_EMOJIS = { starbase: 'HQ' };
const named = new Map();

export async function loadEmojis(client) {
  resolved.clear();
  named.clear();
  let emojis;
  try {
    emojis = await client.application.emojis.fetch();
  } catch (err) {
    console.warn('[emoji] could not read application emojis, falling back to unicode:', err.message);
    return;
  }

  const byName = new Map([...emojis.values()].map((e) => [e.name.toLowerCase(), e]));
  const missing = [];

  for (const item of ITEM_LIST) {
    const name = (item.emojiName ?? item.id).toLowerCase();
    const found = byName.get(name);
    if (found) {
      resolved.set(item.id, found.animated ? `<a:${found.name}:${found.id}>` : `<:${found.name}:${found.id}>`);
    } else {
      missing.push(name);
    }
  }

  for (const name of Object.keys(NAMED_EMOJIS)) {
    const found = byName.get(name);
    if (found) named.set(name, found.animated ? `<a:${found.name}:${found.id}>` : `<:${found.name}:${found.id}>`);
    else missing.push(name);
  }

  console.log(`[emoji] ${resolved.size}/${ITEM_LIST.length} custom emojis resolved` +
    (missing.length ? ` — missing (unicode fallback): ${missing.join(', ')}` : ''));

  // Les emojis qui ne servent pas d'icone de type alimentent la bibliotheque
  // d'illustrations de /upgrade.
  const indexed = loadEmojiArtwork(
    [...emojis.values()],
    [...ITEM_LIST.map((i) => i.emojiName ?? i.id), ...Object.keys(NAMED_EMOJIS)],
  );
  console.log(`[artwork] ${indexed} application emoji(s) usable as upgrade artwork`);
}

/** Emoji nomme (voir NAMED_EMOJIS) : custom si present, sinon son repli texte. */
export function namedEmoji(name) {
  return named.get(name) ?? NAMED_EMOJIS[name];
}

/** Emoji a afficher dans le texte d'un embed : custom si dispo, sinon unicode. */
export function emojiFor(item) {
  return resolved.get(item.id) ?? item.emoji;
}

/**
 * Emoji pour un bouton. discord.js veut un objet {id} ou {name}, pas la
 * syntaxe texte `<:nom:id>` — d'ou cette seconde forme.
 */
export function buttonEmojiFor(item) {
  const custom = resolved.get(item.id);
  if (!custom) return item.emoji;
  const match = custom.match(/^<(a?):([^:]+):(\d+)>$/);
  return match ? { id: match[3], name: match[2], animated: match[1] === 'a' } : item.emoji;
}
