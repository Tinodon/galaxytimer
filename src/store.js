// Persistance des timers.
//
// Les timers durent jusqu'a 35h et le bot peut redemarrer a tout moment : rien
// ne peut vivre uniquement en memoire. On garde des dates d'expiration absolues,
// et au demarrage le scheduler rattrape ce qui a expire pendant la coupure.
//
// Le support de stockage est choisi par l'environnement (voir src/backends.js) :
// fichier local en developpement, base distante en production, parce que le
// disque d'un hebergeur gratuit est efface a chaque redeploiement.

import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileBackend, upstashBackend } from './backends.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Map<string, object>} */
let timers = new Map();
let backend = null;

/**
 * Choisit le backend. Upstash des que ses deux variables sont presentes,
 * fichier sinon — aucune configuration n'est requise en local.
 */
export function selectBackend() {
  const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
  if (url && token) return upstashBackend({ url, token });

  const path = process.env.GALAXYTIMER_DB
    ? resolve(process.env.GALAXYTIMER_DB)
    : join(ROOT, 'data', 'timers.json');
  return fileBackend(path);
}

/**
 * Prepare le stockage et charge les timers.
 * Asynchrone : un backend distant doit etre lu avant que le bot ne serve.
 */
export async function init() {
  backend = selectBackend();
  if (backend.init) await backend.init();
  console.log(`[store] backend: ${backend.name}`);
  load();
}

/** Recharge depuis le backend. Synchrone : les backends gardent un cache. */
export function load() {
  if (!backend) backend = selectBackend();
  timers = new Map(Object.entries(backend.read()));
  migrateKeys();
}

/**
 * Cle d'un timer : `serveur:user:item:slug`.
 *
 * Le slug (nom libre reduit, voir items.js) permet plusieurs timers du meme
 * type en parallele — /wars John et /wars Mike, ou deux /upgrade sur des
 * batiments differents. Sans nom il est vide, donc un seul timer par item :
 * relancer /helmet remplace le precedent, ce qui est le comportement voulu.
 */
export function keyOf({ guildId, userId, itemId, slug = '' }) {
  return `${guildId ?? 'dm'}:${userId}:${itemId}:${slug}`;
}

/**
 * Ajoute le segment de slug aux cles de l'ancien format `serveur:user:item`.
 *
 * Sans ca un /helmet relance creerait une cle `...:helmet:` distincte de
 * l'ancienne `...:helmet`, donc deux timers Helmet au lieu d'un remplacement.
 */
function migrateKeys() {
  let migrated = 0;
  for (const [key, timer] of [...timers]) {
    if (key.split(':').length !== 3) continue;
    timers.delete(key);
    const next = `${key}:`;
    timers.set(next, { ...timer, key: next, name: timer.name ?? null });
    migrated += 1;
  }
  if (migrated) {
    console.log(`[store] migrated ${migrated} timer(s) to the named-key format`);
    save();
  }
}

function save() {
  backend.write(Object.fromEntries(timers));
}

export function all() {
  return [...timers.values()];
}

export function get(key) {
  return timers.get(key) ?? null;
}

export function forUser(userId, guildId) {
  return all()
    .filter((t) => t.userId === userId && t.guildId === (guildId ?? 'dm'))
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

export function upsert(timer) {
  timers.set(timer.key, timer);
  save();
  return timer;
}

export function remove(key) {
  const existed = timers.delete(key);
  if (existed) save();
  return existed;
}

export function patch(key, changes) {
  const current = timers.get(key);
  if (!current) return null;
  const next = { ...current, ...changes };
  timers.set(key, next);
  save();
  return next;
}
