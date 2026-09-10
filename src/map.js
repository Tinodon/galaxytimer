// La carte globale : qui a une colonie ou, et avec quel QG.
//
// Tout vit dans la base SQL (voir src/sql.js et scout/schema.sql) :
//   - `colonies` : une ligne par colonie connue, relevee par le balayage ou
//     saisie avec /pin. C'est la verite.
//   - `joueurs` : un joueur par ligne avec ses 24 cases (12 colonies, 12 QG),
//     recalculees depuis `colonies` par rafraichir_cases().
//
// La carte est GLOBALE : un pin fait sur un serveur Discord est visible partout.
// Le but est de cartographier tout le jeu, pas le renseignement d'une alliance.
//
// Les recherches se font par id de joueur, jamais par pseudo : le bot obtient
// l'id aupres de l'API du jeu, qui tolere la casse et suit les changements de
// pseudo. Chercher par pseudo, c'est ce qui avait rendu 18 % des joueurs
// introuvables avec les morceaux Upstash rangés par premiere lettre.

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

const toSpot = (row) => ({
  x: row.x,
  y: row.y,
  hq: row.qg ?? null,
  pinned: row.origine === 'pin',
});

/** Colonies connues d'un joueur, triees par coordonnees : [{ x, y, hq, pinned }]. */
export async function coloniesOf(playerId) {
  const { rows } = await sql.query(
    'SELECT x, y, qg, origine FROM colonies WHERE joueur_id = $1 ORDER BY x, y',
    [Number(playerId)],
  );
  return rows.map(toSpot);
}

/** Colonies de plusieurs joueurs en UNE requete : Map(id -> spots). */
export async function coloniesOfMany(playerIds) {
  const ids = playerIds.map(Number);
  const byPlayer = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byPlayer;
  const { rows } = await sql.query(
    `SELECT joueur_id, x, y, qg, origine FROM colonies
     WHERE joueur_id = ANY($1::bigint[]) ORDER BY joueur_id, x, y`,
    [ids],
  );
  for (const row of rows) byPlayer.get(Number(row.joueur_id))?.push(toSpot(row));
  return byPlayer;
}

/** Qui a une colonie sur cette case : [{ name, alliance, level, hq, system, pinned }]. */
export async function whoAt(x, y) {
  const { rows } = await sql.query(
    `SELECT j.pseudo, j.alliance, j.niveau, c.qg, c.systeme, c.origine
     FROM colonies c JOIN joueurs j ON j.id = c.joueur_id
     WHERE c.x = $1 AND c.y = $2
     ORDER BY j.niveau DESC NULLS LAST, j.pseudo`,
    [x, y],
  );
  return rows.map((row) => ({
    name: row.pseudo,
    alliance: row.alliance,
    level: row.niveau,
    hq: row.qg ?? null,
    system: row.systeme,
    pinned: row.origine === 'pin',
  }));
}

/**
 * Enregistre des coordonnees vues en jeu (/pin).
 *
 * Dans une transaction : la fiche du joueur est creee ou mise a jour, chaque
 * coordonnee devient un pin (une colonie deja relevee au meme endroit passe en
 * pin, elle vient d'etre confirmee a l'oeil), puis ses 24 cases sont
 * recalculees. Sans ce recalcul, la table `joueurs` ne montrerait pas le pin.
 *
 * @param player { id, name, alliance, level, planets }
 */
export async function pin(player, coords, by) {
  const id = Number(player.id);
  return sql.transaction(async (client) => {
    await client.query(
      `INSERT INTO joueurs (id, pseudo, alliance, niveau, nb_planetes, maj)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         pseudo = EXCLUDED.pseudo, alliance = EXCLUDED.alliance,
         niveau = EXCLUDED.niveau, nb_planetes = EXCLUDED.nb_planetes, maj = now()`,
      [id, player.name, player.alliance ?? null, player.level ?? null, player.planets ?? null],
    );

    let added = 0;
    let updated = 0;
    for (const { x, y } of coords) {
      // xmax = 0 : la ligne vient d'etre inseree, sinon elle existait deja.
      const { rows } = await client.query(
        `INSERT INTO colonies (joueur_id, x, y, origine, par, vu_le)
         VALUES ($1, $2, $3, 'pin', $4, now())
         ON CONFLICT (joueur_id, x, y) DO UPDATE SET
           origine = 'pin', par = EXCLUDED.par, vu_le = now()
         RETURNING (xmax = 0) AS inserted`,
        [id, x, y, by],
      );
      if (rows[0].inserted) added += 1;
      else updated += 1;
    }

    await client.query('SELECT rafraichir_cases($1::bigint[])', [[id]]);
    const { rows } = await client.query(
      'SELECT count(*)::int AS total FROM colonies WHERE joueur_id = $1',
      [id],
    );
    return { added, updated, total: rows[0].total };
  });
}
