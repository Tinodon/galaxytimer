// La carte globale : qui a une planete ou, et avec quel QG.
//
// Tout vit dans la base SQL (voir src/sql.js et scout/schema.sql) :
//   - `colonies` : une ligne par PLANETE connue, relevee par le balayage ou
//     saisie avec /pin. C'est la verite. Un joueur peut avoir plusieurs
//     planetes dans le meme systeme : `numero` les distingue.
//   - `joueurs` : un joueur par ligne avec ses 24 cases (12 planetes, 12 QG),
//     recalculees depuis `colonies` par rafraichir_cases().
//
// La carte est GLOBALE : un pin fait sur un serveur Discord est visible partout.
// Le but est de cartographier tout le jeu, pas le renseignement d'une alliance.
//
// Les recherches se font par id de joueur, jamais par pseudo : le bot obtient
// l'id aupres de l'API du jeu, qui tolere la casse et suit les changements de
// pseudo. Chercher par pseudo, c'est ce qui avait rendu 18 % des joueurs
// introuvables avec les morceaux Upstash ranges par premiere lettre.

import * as sql from './sql.js';

export const MAX_COLONIES = 12;

/**
 * Forme reduite d'un pseudo : minuscules, sans accents, seulement a-z et 0-9.
 * Copie exacte de `flatten` dans scout/upload.py.
 */
export function flatten(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Ordre unique de toutes les listes de planetes : x, y, puis numero dans le
// systeme. C'est aussi l'ordre des lignes numerotees de /find, sur lesquelles
// /edit s'appuie : un autre ordre ferait viser la mauvaise ligne.
const PLANET_ORDER = 'x, y, numero';

const toSpot = (row) => ({
  x: row.x,
  y: row.y,
  number: row.numero,
  hq: row.qg ?? null,
  pinned: row.origine === 'pin',
  origin: row.origine,
});

async function planetsOf(client, playerId) {
  const { rows } = await client.query(
    `SELECT x, y, numero, qg, origine FROM colonies
     WHERE joueur_id = $1 AND NOT masquee ORDER BY ${PLANET_ORDER}`,
    [Number(playerId)],
  );
  return rows.map(toSpot);
}

/**
 * Planetes connues d'un joueur, une par entree, dans l'ordre de /find :
 * [{ x, y, number, hq, pinned }]. Deux planetes dans le meme systeme donnent
 * deux entrees avec les memes coordonnees.
 */
export async function coloniesOf(playerId) {
  return planetsOf({ query: sql.query }, playerId);
}

/** Planetes de plusieurs joueurs en UNE requete : Map(id -> spots). */
export async function coloniesOfMany(playerIds) {
  const ids = playerIds.map(Number);
  const byPlayer = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byPlayer;
  const { rows } = await sql.query(
    `SELECT joueur_id, x, y, numero, qg, origine FROM colonies
     WHERE joueur_id = ANY($1::bigint[]) AND NOT masquee
     ORDER BY joueur_id, ${PLANET_ORDER}`,
    [ids],
  );
  for (const row of rows) byPlayer.get(Number(row.joueur_id))?.push(toSpot(row));
  return byPlayer;
}

/**
 * Joueurs presents sur la carte, par ordre alphabetique (/list).
 *
 * Alphabetique et sans tenir compte des majuscules : c'est l'ordre dans lequel
 * on cherche un nom. Chaque joueur vient avec son nombre de planetes connues ET
 * son nombre de planetes selon l'API : plus de connues que de reelles, c'est
 * une attribution fausse, visible d'un coup.
 *
 * @returns {{ total: number, colonies: number, rows: {name, known, planets}[] }}
 */
export async function listPlayers({ search = '', page = 1, pageSize = 50 } = {}) {
  const filter = search ? `%${search.toLowerCase()}%` : null;
  const where = `WHERE NOT c.masquee${filter ? ' AND lower(j.pseudo) LIKE $1' : ''}`;
  const params = filter ? [filter] : [];

  const { rows: [totals] } = await sql.query(
    `SELECT count(DISTINCT j.id)::int AS total, count(*)::int AS colonies
     FROM colonies c JOIN joueurs j ON j.id = c.joueur_id ${where}`,
    params,
  );
  const { rows } = await sql.query(
    `SELECT j.pseudo, j.nb_planetes, count(*)::int AS known
     FROM colonies c JOIN joueurs j ON j.id = c.joueur_id ${where}
     GROUP BY j.id, j.pseudo, j.nb_planetes
     ORDER BY lower(j.pseudo), j.pseudo
     LIMIT ${Number(pageSize)} OFFSET ${(Number(page) - 1) * Number(pageSize)}`,
    params,
  );
  return {
    total: totals.total,
    colonies: totals.colonies,
    rows: rows.map((r) => ({ name: r.pseudo, known: r.known, planets: r.nb_planetes })),
  };
}

/**
 * Qui a des planetes sur cette case, regroupe par joueur :
 * [{ name, alliance, level, count, hqs, system, pinned }].
 */
export async function whoAt(x, y) {
  const { rows } = await sql.query(
    `SELECT j.pseudo, j.alliance, j.niveau,
            count(*)::int AS count,
            array_agg(c.qg ORDER BY c.numero) FILTER (WHERE c.qg IS NOT NULL) AS hqs,
            max(c.systeme) AS systeme,
            bool_or(c.origine = 'pin') AS pinned
     FROM colonies c JOIN joueurs j ON j.id = c.joueur_id
     WHERE c.x = $1 AND c.y = $2 AND NOT c.masquee
     GROUP BY j.id, j.pseudo, j.alliance, j.niveau
     ORDER BY j.niveau DESC NULLS LAST, j.pseudo`,
    [x, y],
  );
  return rows.map((row) => ({
    name: row.pseudo,
    alliance: row.alliance,
    level: row.niveau,
    count: row.count,
    hqs: row.hqs ?? [],
    system: row.systeme,
    pinned: row.pinned,
  }));
}

async function upsertPlayer(client, player) {
  await client.query(
    `INSERT INTO joueurs (id, pseudo, alliance, niveau, nb_planetes, maj)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       pseudo = EXCLUDED.pseudo, alliance = EXCLUDED.alliance,
       niveau = EXCLUDED.niveau, nb_planetes = EXCLUDED.nb_planetes, maj = now()`,
    [Number(player.id), player.name, player.alliance ?? null, player.level ?? null,
      player.planets ?? null],
  );
}

/**
 * Ajoute une planete pinnee a la prochaine place libre de ce systeme.
 * Les places masquees comptent comme prises : une correction ne se rouvre pas.
 */
async function addPinned(client, playerId, { x, y, hq }, by) {
  await client.query(
    `INSERT INTO colonies (joueur_id, x, y, numero, qg, origine, par, vu_le)
     SELECT $1, $2, $3, COALESCE(max(numero), 0) + 1, $4, 'pin', $5, now()
     FROM colonies WHERE joueur_id = $1 AND x = $2 AND y = $3`,
    [Number(playerId), x, y, hq ?? null, by],
  );
}

/**
 * /pin : chaque entree ajoute UNE planete, meme sur une coordonnee deja connue
 * (regle de Noe : relancer /pin sur la meme case = une planete de plus). Une
 * erreur se corrige ensuite avec /edit.
 *
 * Dans une transaction : fiche du joueur a jour, planetes ajoutees, 24 cases
 * recalculees. Sans ce recalcul, la table `joueurs` ne montrerait pas le pin.
 *
 * @param player { id, name, alliance, level, planets }
 * @param entries [{ x, y, hq }]
 */
export async function pin(player, entries, by) {
  const id = Number(player.id);
  return sql.transaction(async (client) => {
    await upsertPlayer(client, player);
    for (const entry of entries) await addPinned(client, id, entry, by);
    await client.query('SELECT rafraichir_cases($1::bigint[])', [[id]]);
    const planets = await planetsOf(client, id);
    return { added: entries.length, total: planets.length, planets };
  });
}

/**
 * /edit : modifie la ligne `line` de /find (1 = la premiere).
 *
 * change = { remove: true } | { coords?: {x, y}, hq?: number }
 *
 * Une planete du releve n'est jamais effacee : elle est MASQUEE, sinon la
 * prochaine publication la ferait revenir. Une planete pinnee, elle, est
 * simplement supprimee. Changer de coordonnees = retirer l'ancienne ligne et
 * ajouter un pin a la nouvelle place, avec le QG indique ou l'ancien.
 *
 * @returns {{ error?: 'no-line', count?, before?, planets? }}
 */
export async function editLine(playerId, line, change, by) {
  const id = Number(playerId);
  return sql.transaction(async (client) => {
    const planets = await planetsOf(client, id);
    const target = planets[line - 1];
    if (!target) return { error: 'no-line', count: planets.length };

    const where = [id, target.x, target.y, target.number];
    const hide = async () => {
      if (target.origin === 'pin') {
        await client.query(
          'DELETE FROM colonies WHERE joueur_id = $1 AND x = $2 AND y = $3 AND numero = $4',
          where,
        );
      } else {
        await client.query(
          `UPDATE colonies SET masquee = true, par = $5, vu_le = now()
           WHERE joueur_id = $1 AND x = $2 AND y = $3 AND numero = $4`,
          [...where, by],
        );
      }
    };

    const moves = change.coords && (change.coords.x !== target.x || change.coords.y !== target.y);
    if (change.remove) {
      await hide();
    } else if (moves) {
      await hide();
      await addPinned(client, id, { ...change.coords, hq: change.hq ?? target.hq }, by);
    } else {
      // Meme place, nouveau QG : la ligne devient un pin, verifiee a l'oeil.
      await client.query(
        `UPDATE colonies SET qg = $5, origine = 'pin', par = $6, vu_le = now()
         WHERE joueur_id = $1 AND x = $2 AND y = $3 AND numero = $4`,
        [...where, change.hq ?? target.hq, by],
      );
    }

    await client.query('SELECT rafraichir_cases($1::bigint[])', [[id]]);
    return { before: target, planets: await planetsOf(client, id) };
  });
}
