// Lecture des coordonnees saisies par les joueurs (/pin, /who).
//
// L'API du jeu ne publie pas les coordonnees, mais les membres les voient en
// jeu. L'enregistrement se fait desormais dans la base SQL (src/map.js), sur la
// carte GLOBALE : plus d'isolement par serveur, le but est de cartographier
// tout le jeu. Ce module ne garde que l'analyse de la saisie.

// L'univers connu va de (0,0) a (1408,1408) — voir le wiki du jeu. Une saisie
// hors bornes est une faute de frappe, pas une colonie.
export const MAX_COORD = 1408;

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

// Niveau de QG valide. Un joueur niveau 495 a ses 12 QG au niveau 9 : c'est le
// maximum du jeu. Au-dela, c'est une faute de frappe.
export const MAX_HQ = 9;

const COORD = /^\d+,\d+$/;
const NUMBER = /^\d+$/;
const REMOVE_WORDS = new Set(['delete', 'del', 'remove', 'suppr', 'supprimer']);

/**
 * Decoupe une saisie en mots, en recollant "336, 7" ou "336;7" en "336,7".
 * La virgule est obligatoire dans une coordonnee : un nombre seul est un QG.
 */
function tokenize(input) {
  return String(input ?? '')
    .replace(/(\d+)\s*[,;]\s*(\d+)/g, '$1,$2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function toCoord(token) {
  const [x, y] = token.split(',').map(Number);
  if (x > MAX_COORD || y > MAX_COORD) {
    return { error: `(${x},${y}) is outside the galaxy — it goes up to ${MAX_COORD},${MAX_COORD}.` };
  }
  return { x, y };
}

function toHq(token) {
  const hq = Number(token);
  return hq >= 1 && hq <= MAX_HQ ? { hq } : { error: `HQ ${token} does not exist — it goes from 1 to ${MAX_HQ}.` };
}

/** Separe le pseudo (au debut) de la partie chiffree (a la fin). */
function splitName(tokens, isTail) {
  let cut = tokens.length;
  while (cut > 0 && isTail(tokens[cut - 1])) cut -= 1;
  // Pseudo entierement numerique ("2003 351,10") : le premier mot reste le pseudo.
  if (cut === 0 && tokens.length > 1) cut = 1;
  return { name: tokens.slice(0, cut).join(' '), tail: tokens.slice(cut) };
}

/**
 * Lit "/pin Myra 336,7 5" : le pseudo, puis une ou plusieurs planetes, chacune
 * en "x,y" suivi de son niveau de QG si on le connait.
 *
 *   Myra 336,7            une planete, QG inconnu
 *   Myra 336,7 5          une planete, QG 5
 *   Myra 336,7 5 338,10 4 deux planetes
 *
 * Un seul champ, rempli d'une traite (Noe trouvait lent de cliquer d'un champ
 * a l'autre). La partie chiffree est lue depuis la FIN : le reste est le
 * pseudo, ce qui garde ceux qui contiennent des chiffres (krzysztof32171).
 *
 * @returns {{ name, entries: [{x, y, hq}], error }}
 */
export function parsePinInput(input) {
  const tokens = tokenize(input);
  const { name, tail } = splitName(tokens, (t) => COORD.test(t) || NUMBER.test(t));
  const example = `\`/pin ${tokens[0] ?? 'Myra'} 336,7 5\``;
  if (!name) return { name: '', entries: [], error: `Write the player, then the coordinates, e.g. ${example}.` };

  const entries = [];
  for (const token of tail) {
    if (COORD.test(token)) {
      const coord = toCoord(token);
      if (coord.error) return { name, entries: [], error: coord.error };
      entries.push({ ...coord, hq: null });
    } else {
      const last = entries[entries.length - 1];
      if (!last || last.hq !== null) {
        return { name, entries: [], error: `\`${token}\` is not a coordinate. Write it like ${example} (coordinates, then the HQ level).` };
      }
      const hq = toHq(token);
      if (hq.error) return { name, entries: [], error: hq.error };
      last.hq = hq.hq;
    }
  }
  if (!entries.length) return { name, entries: [], error: `No coordinates found. Write it like ${example}.` };
  return { name, entries, error: null };
}

/**
 * Lit "/edit Myra 3 336,7 5" : le pseudo, le numero de ligne de /find, puis
 * ce qui change.
 *
 *   Myra 3 delete      supprime la ligne 3
 *   Myra 3 6           ligne 3 : QG 6
 *   Myra 3 340,8       ligne 3 : nouvelle coordonnee
 *   Myra 3 340,8 6     les deux
 *
 * @returns {{ name, line, change: {remove} | {coords?, hq?}, error }}
 */
export function parseEditInput(input) {
  const tokens = tokenize(input);
  const example = `\`/edit ${tokens[0] ?? 'Myra'} 3 336,7 5\` or \`/edit ${tokens[0] ?? 'Myra'} 3 delete\``;
  const fail = (error) => ({ name: '', line: 0, change: null, error });

  const rest = [...tokens];
  let change = {};
  if (rest.length && REMOVE_WORDS.has(rest[rest.length - 1].toLowerCase())) {
    rest.pop();
    change = { remove: true };
  } else {
    const last = rest[rest.length - 1];
    const before = rest[rest.length - 2];
    if (NUMBER.test(last ?? '') && COORD.test(before ?? '')) {
      change.hq = rest.pop();
      change.coords = rest.pop();
    } else if (COORD.test(last ?? '')) {
      change.coords = rest.pop();
    } else if (NUMBER.test(last ?? '') && NUMBER.test(before ?? '')) {
      change.hq = rest.pop();
    }
  }

  const lineToken = rest.pop();
  if (!NUMBER.test(lineToken ?? '')) return fail(`Say which line to change, as numbered by /find — e.g. ${example}.`);
  const line = Number(lineToken);
  const name = rest.join(' ');
  if (!name) return fail(`Write the player first — e.g. ${example}.`);
  if (!change.remove && change.hq === undefined && change.coords === undefined) {
    return fail(`Nothing to change on line ${line}. Write it like ${example}.`);
  }

  if (change.coords !== undefined) {
    const coord = toCoord(change.coords);
    if (coord.error) return fail(coord.error);
    change.coords = coord;
  }
  if (change.hq !== undefined) {
    const hq = toHq(change.hq);
    if (hq.error) return fail(hq.error);
    change.hq = hq.hq;
  }
  return { name, line, change, error: null };
}

