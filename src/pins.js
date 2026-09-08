// Coordonnees de colonies relevees par les joueurs.
//
// L'API du jeu ne publie pas les coordonnees, mais les membres les voient en
// jeu. Ce module les capture pour que l'information cesse de mourir dans la
// tete de celui qui l'a vue : un membre en releve quatre, un autre six, et au
// bout d'une semaine l'alliance adverse est cartographiee pour tout le monde.
//
// Les relevés sont cloisonnes PAR SERVEUR Discord : le renseignement d'une
// alliance n'a pas a fuiter chez une autre.

import { selectBackend } from './store.js';

// L'univers connu va de (0,0) a (1408,1408) — voir le wiki du jeu. Une saisie
// hors bornes est une faute de frappe, pas une colonie.
export const MAX_COORD = 1408;

let backend = null;
let pins = {};

export async function init() {
  backend = selectBackend('pins');
  if (backend.init) await backend.init();
  pins = backend.read() ?? {};
  const total = Object.values(pins)
    .flatMap((g) => Object.values(g))
    .reduce((n, entry) => n + entry.coords.length, 0);
  console.log(`[pins] backend: ${backend.name} — ${total} coordinate(s) recorded`);
}

function save() {
  backend.write(pins);
}

const guildPins = (guildId) => {
  const key = guildId ?? 'dm';
  pins[key] ??= {};
  return pins[key];
};

/**
 * Analyse une saisie libre de coordonnees.
 *
 * Tolere "512,340", "512 340", "512;340", separes par des espaces ou des
 * virgules — on ne va pas imposer une syntaxe a quelqu'un qui recopie des
 * chiffres depuis un ecran de jeu.
 */
export function parseCoords(input) {
  const numbers = String(input ?? '').match(/\d+/g) ?? [];
  if (numbers.length % 2 !== 0) {
    return { coords: [], error: 'Coordinates must come in pairs, e.g. `512,340 601,299`.' };
  }

  const coords = [];
  for (let i = 0; i < numbers.length; i += 2) {
    const x = Number(numbers[i]);
    const y = Number(numbers[i + 1]);
    if (x > MAX_COORD || y > MAX_COORD) {
      return { coords: [], error: `(${x},${y}) is outside the galaxy — it goes up to ${MAX_COORD},${MAX_COORD}.` };
    }
    coords.push({ x, y });
  }
  if (!coords.length) return { coords: [], error: 'No coordinates found in that input.' };
  return { coords, error: null };
}

/**
 * Enregistre des coordonnees pour un joueur.
 * Une coordonnee deja connue est mise a jour, pas dupliquee.
 */
export function pin(guildId, player, coords, scoutName) {
  const store = guildPins(guildId);
  const key = String(player.id);
  const entry = (store[key] ??= { name: player.name, coords: [] });
  entry.name = player.name;

  let added = 0;
  let updated = 0;
  for (const { x, y } of coords) {
    const existing = entry.coords.find((c) => c.x === x && c.y === y);
    if (existing) {
      existing.by = scoutName;
      existing.at = Date.now();
      updated += 1;
    } else {
      entry.coords.push({ x, y, by: scoutName, at: Date.now() });
      added += 1;
    }
  }
  entry.coords.sort((a, b) => a.x - b.x || a.y - b.y);
  save();
  return { added, updated, total: entry.coords.length };
}

/** Retire une coordonnee devenue fausse (colonie deplacee, faute de frappe). */
export function unpin(guildId, playerId, x, y) {
  const entry = guildPins(guildId)[String(playerId)];
  if (!entry) return false;
  const index = entry.coords.findIndex((c) => c.x === x && c.y === y);
  if (index === -1) return false;
  entry.coords.splice(index, 1);
  if (!entry.coords.length) delete guildPins(guildId)[String(playerId)];
  save();
  return true;
}

export function forPlayer(guildId, playerId) {
  return guildPins(guildId)[String(playerId)] ?? null;
}

/** Tous les relevés du serveur, indexes par id de joueur. */
export function all(guildId) {
  return guildPins(guildId);
}
