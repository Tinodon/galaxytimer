// Verrou d'instance unique.
//
// Deux bots avec le meme token repondent tous les deux a chaque interaction :
// le plus lent se prend "Unknown interaction" (10062) et l'utilisateur voit des
// doublons. Ca arrive des qu'on relance sans avoir tue l'ancien process, donc
// on refuse de demarrer au lieu de laisser la situation se produire.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Le verrou suit la base de donnees : deux instances pointant sur des bases
// differentes ne se marchent pas dessus, et un test ne bloque pas le bot reel.
const LOCK = process.env.GALAXYTIMER_DB
  ? `${resolve(process.env.GALAXYTIMER_DB)}.lock`
  : join(ROOT, 'data', 'bot.lock');

/** `kill(pid, 0)` ne tue rien : il teste seulement si le process existe. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = le process existe mais appartient a un autre utilisateur.
    return err.code === 'EPERM';
  }
}

/** Prend le verrou, ou termine le process avec un message explicite. */
export function acquire() {
  if (existsSync(LOCK)) {
    try {
      const { pid, startedAt } = JSON.parse(readFileSync(LOCK, 'utf8'));
      if (pid !== process.pid && isAlive(pid)) {
        console.error(
          `\nAnother GalaxyTimer is already running (PID ${pid}, started ${startedAt}).\n` +
          `Two instances would both answer the same interactions.\n\n` +
          `Stop the other one first:  taskkill /PID ${pid} /F\n`,
        );
        process.exit(1);
      }
    } catch {
      // Verrou illisible ou process mort : on le considere perime et on reprend.
    }
  }

  mkdirSync(dirname(LOCK), { recursive: true });
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

export function release() {
  try {
    const { pid } = JSON.parse(readFileSync(LOCK, 'utf8'));
    // Ne jamais liberer le verrou d'un autre process.
    if (pid === process.pid) unlinkSync(LOCK);
  } catch {
    // Deja supprime, rien a faire.
  }
}
