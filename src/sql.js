// Connexion a la base SQL de la carte (Postgres, heberge chez Neon).
//
// La carte et les pins y vivent ; les timers et l'intel restent dans Upstash
// (voir src/store.js). La base est hebergee a part parce que le disque de
// Render est efface a chaque deploiement.
//
// Le schema est defini UNE fois, dans scout/schema.sql, et applique ici au
// demarrage comme par scout/publish_sql.py : une colonne ne peut pas exister
// d'un cote et manquer de l'autre. Il est rejouable, rien n'y est supprime.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = join(ROOT, 'scout', 'schema.sql');

let pool = null;

export function configured() {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Schema Postgres utilise. `public` en production ; les controles passent un
 * schema a part (GALAXYTIMER_SQL_SCHEMA) pour ne jamais ecrire dans la vraie
 * carte — comme GALAXYTIMER_DB le fait pour les timers.
 */
function schemaName() {
  const name = process.env.GALAXYTIMER_SQL_SCHEMA || 'public';
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`invalid schema name: ${name}`);
  return name;
}

function getPool() {
  if (!configured()) {
    throw new Error('DATABASE_URL is not set: the map database is not configured');
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      // Peu de connexions : Neon gratuit en limite le nombre, et le bot n'en
      // a jamais besoin de beaucoup en meme temps.
      max: 3,
      idleTimeoutMillis: 30_000,
      // Neon met la base en veille ; le reveil prend une seconde ou deux.
      connectionTimeoutMillis: 15_000,
    });
    // Une connexion inactive coupee par le serveur ne doit pas faire tomber le bot.
    pool.on('error', (err) => console.error('[sql] idle connection error:', err.message));
  }
  return pool;
}

/**
 * Prete une connexion dont le schema est fixe.
 *
 * Toujours explicite, meme pour `public` : on lit et ecrit la ou on l'a
 * decide, jamais la ou une session precedente aurait laisse le search_path.
 * Fixe une fois par connexion, et ATTENDU avant la premiere requete.
 */
async function withClient(fn) {
  const client = await getPool().connect();
  try {
    const schema = schemaName();
    if (client.galaxySchema !== schema) {
      await client.query(`SET search_path TO "${schema}"`);
      client.galaxySchema = schema;
    }
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function query(text, params) {
  return withClient((client) => client.query(text, params));
}

/** Execute `fn(client)` dans une transaction : tout est ecrit, ou rien. */
export async function transaction(fn) {
  return withClient(async (client) => {
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

/** Cree les tables si besoin. Sans DATABASE_URL, le bot tourne sans carte. */
export async function init() {
  if (!configured()) {
    console.log('[sql] DATABASE_URL not set — /find, /map, /who and /pin are unavailable');
    return;
  }
  const schema = schemaName();
  if (schema !== 'public') await query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await query(readFileSync(SCHEMA_FILE, 'utf8'));
  const { rows } = await query(
    "SELECT (SELECT count(*) FROM joueurs) AS joueurs, (SELECT count(*) FROM colonies) AS colonies",
  );
  console.log(`[sql] schema "${schema}" — ${rows[0].joueurs} player(s), ${rows[0].colonies} colonie(s)`);
}

/** Ferme les connexions (fin des controles). */
export async function close() {
  if (pool) await pool.end();
  pool = null;
}
