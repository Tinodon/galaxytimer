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

// Un morceau de coordonnee : "351,10", "351", "10", "351;10", "351," ...
const COORD_TOKEN = /^\d+([,;]\d*)?$/;

/**
 * Lit "/pin myra 351,10" : le pseudo, puis les coordonnees, en une seule saisie.
 *
 * Noe trouvait lent de cliquer sur un champ "player" puis sur un champ
 * "coords" : /pin n'a plus qu'un champ, qu'on remplit d'une traite. Les
 * coordonnees sont lues depuis la FIN (tout ce qui est numerique), le reste est
 * le pseudo — ce qui garde les pseudos qui contiennent des chiffres
 * (krzysztof32171) et le rare pseudo avec un espace.
 */
export function parsePinInput(input) {
  const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
  let cut = tokens.length;
  while (cut > 0 && COORD_TOKEN.test(tokens[cut - 1])) cut -= 1;
  // Pseudo entierement numerique ("2003 351,10") : le premier mot reste le pseudo.
  if (cut === 0 && tokens.length > 1) cut = 1;

  const name = tokens.slice(0, cut).join(' ');
  if (!name) return { name: '', coords: [], error: 'Write the player, then the coordinates, e.g. `/pin Myra 351,10`.' };

  const { coords, error } = parseCoords(tokens.slice(cut).join(' '));
  if (error) {
    return { name, coords: [], error: `${error} Write it like \`/pin ${tokens[0]} 351,10\`.` };
  }
  return { name, coords, error: null };
}
