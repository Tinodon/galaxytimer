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
