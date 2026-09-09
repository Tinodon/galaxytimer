// Acces a la carte relevee par le balayage.
//
// Le balayage tourne sur le PC de Noe et publie ses resultats dans Upstash ;
// le bot, heberge ailleurs, les lit ici. C'est le meme chemin que les timers.
//
// La carte est DECOUPEE par premiere lettre du pseudo. Repondre a une recherche
// ne charge donc qu'un morceau de quelques dizaines de kilo-octets au lieu de
// toute la carte — et rien ne butera sur la limite de taille d'Upstash quand le
// balayage s'etendra.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const KEY_PREFIX = 'map:';
const INDEX_KEY = 'map:index';

// Un morceau reste en memoire un moment : plusieurs recherches d'affilee
// portent souvent sur la meme lettre, et le contenu ne change qu'entre deux
// balayages.
const CACHE_MS = 10 * 60 * 1000;

// Une ABSENCE ne se garde pas aussi longtemps qu'une presence. Sans ca, une
// recherche faite juste avant une publication fige un "rien ici" pendant dix
// minutes, et la carte fraichement publiee reste invisible sans raison
// apparente.
const MISS_CACHE_MS = 20 * 1000;

const cache = new Map();

/** Meme normalisation que cote balayage, sans quoi les cles ne coincideraient pas. */
export function flatten(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function shardOf(name) {
  const flat = flatten(name);
  return flat ? flat[0] : '_';
}

/**
 * Lit une valeur brute, sans passer par le stockage des timers.
 *
 * Ce dernier enveloppe tout dans `{version, timers}` et ne rend que `timers` :
 * s'en servir ici renvoyait un objet vide pour chaque morceau de carte, sans
 * la moindre erreur — le bot repondait "aucune colonie" alors que la donnee
 * etait bien publiee. La carte a donc sa propre lecture, au format qu'elle
 * publie reellement.
 */
async function readKey(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    const base = String(url).trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
    const response = await fetch(`${base}/get/${encodeURIComponent(`galaxytimer:${key}`)}`, {
      headers: { Authorization: `Bearer ${String(token).trim().replace(/^["']|["']$/g, '')}` },
    });
    if (!response.ok) throw new Error(`Upstash ${response.status}`);
    const raw = (await response.json()).result;
    return raw ? JSON.parse(raw) : null;
  }

  // Hors production : un fichier depose a cote, pour pouvoir essayer en local.
  const path = join(ROOT, 'data', `${key.replace(/:/g, '_')}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function loadShard(letter) {
  const cached = cache.get(letter);
  if (cached) {
    const age = Date.now() - cached.at;
    const limit = cached.data ? CACHE_MS : MISS_CACHE_MS;
    if (age < limit) return cached.data;
  }

  let data = null;
  try {
    data = await readKey(KEY_PREFIX + letter);
  } catch (err) {
    console.error(`[map] could not read shard "${letter}": ${err.message}`);
  }
  cache.set(letter, { at: Date.now(), data });
  return data;
}

/**
 * Colonies connues d'un joueur : [{ x, y, hq }].
 *
 * La comparaison se fait sur la forme applatie, pas sur le pseudo affiche : le
 * joueur tape rarement la casse exacte, et le balayage a pu enregistrer une
 * variante.
 */
export async function coloniesOf(playerName) {
  const shard = await loadShard(shardOf(playerName));
  if (!shard) return null;

  const wanted = flatten(playerName);
  for (const [name, spots] of Object.entries(shard)) {
    if (flatten(name) === wanted) {
      return spots.map(([x, y, hq]) => ({ x, y, hq }));
    }
  }
  return [];
}

/** Etat de la carte publiee, ou null si aucun balayage n'a encore ete publie. */
export async function mapStatus() {
  try {
    return await readKey(INDEX_KEY);
  } catch {
    return null;
  }
}
