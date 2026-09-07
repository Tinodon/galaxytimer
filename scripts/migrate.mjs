// Copie les timers du fichier local vers le backend distant.
//
// A lancer UNE FOIS, au moment de passer sur un hebergeur : le bot lit alors la
// base distante et ignore le fichier, donc sans cette reprise les timers en
// cours seraient perdus.
//
//   npm run migrate            montre ce qui serait copie, sans rien ecrire
//   npm run migrate -- --apply copie pour de bon

import 'dotenv/config';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileBackend, upstashBackend } from '../src/backends.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');

const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
if (!url || !token) {
  console.error('UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN sont requis dans .env');
  process.exit(1);
}

const local = fileBackend(join(ROOT, 'data', 'timers.json'));
const remote = upstashBackend({ url, token });

const source = local.read();
const count = Object.keys(source).length;

await remote.init();
const existing = Object.keys(remote.read()).length;

const left = (t) => {
  const ms = t.expiresAt - Date.now();
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return ms <= 0 ? 'expire' : h ? `${h}h ${m}m` : `${m}m`;
};

console.log(`\nLocal file : ${count} timer(s)`);
for (const t of Object.values(source)) {
  console.log(`  ${(t.name ? `${t.itemId} (${t.name})` : t.itemId).padEnd(24)} ${left(t)} left`);
}
console.log(`Remote     : ${existing} timer(s) already there`);

if (!count) {
  console.log('\nRien a copier.\n');
  process.exit(0);
}
if (existing) {
  console.error('\nLa base distante n est pas vide : copier l ecraserait.');
  console.error('Verifie son contenu avant de forcer quoi que ce soit.\n');
  process.exit(1);
}
if (!apply) {
  console.log('\nApercu uniquement. Pour copier : npm run migrate -- --apply\n');
  process.exit(0);
}

remote.write(source);
// Les ecritures du backend sont asynchrones : on relit pour confirmer.
await new Promise((r) => setTimeout(r, 1500));
const check = upstashBackend({ url, token });
await check.init();
const written = Object.keys(check.read()).length;

if (written === count) {
  console.log(`\n${written}/${count} timer(s) copies et relus depuis la base distante.\n`);
} else {
  console.error(`\nEchec : ${written}/${count} timer(s) relus. Le fichier local est intact.\n`);
  process.exitCode = 1;
}
