// Exerce CHAQUE commande du bot de bout en bout, contre les vraies donnees.
//
// Les tests unitaires de smoke.mjs verifient des morceaux ; ici on appelle les
// gestionnaires comme Discord le ferait, et on regarde ce que l'utilisateur
// recevrait. C'est ce qui manquait : /find a ete branche sur la carte et /map
// oublie, sans qu'aucun test ne s'en apercoive — les deux passaient, parce
// qu'aucun ne les executait.
//
//   node test/commands.mjs
//
// Demande un .env valide : ce controle touche l'API du jeu et Upstash, parce
// que c'est justement le raccordement a ces deux services qu'on veut verifier.

import 'dotenv/config';

import { handleCommand, handleAutocomplete, definitions } from '../src/commands.js';
import * as store from '../src/store.js';
import * as intel from '../src/intel.js';
import * as pins from '../src/pins.js';
import { loadEmojis } from '../src/emoji.js';

const GUILD = '796447983604072498';
const USER = '481225';
const CHANNEL = '999999999999999999';

let passed = 0;
const failures = [];

function report(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'ECHEC'}  ${label}${ok ? '' : `   <- ${detail}`}`);
  if (ok) passed += 1;
  else failures.push(label);
}

/** Fausse interaction Discord : retient ce que la commande a voulu repondre. */
function fakeInteraction(name, options = {}) {
  const sent = { content: null, deferred: false };
  return {
    sent,
    commandName: name,
    guildId: GUILD,
    channelId: CHANNEL,
    user: { id: USER, username: 'Tinodon', displayName: 'Tinodon' },
    member: { displayName: 'Tinodon' },
    options: {
      getString: (key) => options[key] ?? null,
      getBoolean: (key) => options[key] ?? null,
      getFocused: () => options.focused ?? '',
    },
    async deferReply() { sent.deferred = true; },
    async reply(payload) { sent.content = payload?.content ?? payload; },
    async editReply(payload) { sent.content = payload?.content ?? payload; },
    async respond(choices) { sent.content = choices; },
    isRepliable: () => true,
  };
}

async function run(name, options = {}) {
  const interaction = fakeInteraction(name, options);
  await handleCommand(interaction);
  return interaction.sent.content;
}

async function main() {
  console.log('Verification de toutes les commandes\n');

  // Les timers reels vivent dans Upstash. Ce controle en cree et en arrete :
  // s'il ecrivait la-bas, il effacerait les timers en cours de vraies
  // personnes. On masque donc les identifiants le temps des trois `init`, qui
  // figent chacun leur support — ensuite on les rend, parce que la carte, elle,
  // doit bien etre lue dans Upstash.
  const upstash = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.GALAXYTIMER_DB = new URL('../data/timers.check.json', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1');

  const support = store.selectBackend().name;
  await store.init();
  await intel.init();
  await pins.init();

  if (upstash.url) process.env.UPSTASH_REDIS_REST_URL = upstash.url;
  if (upstash.token) process.env.UPSTASH_REDIS_REST_TOKEN = upstash.token;

  report('les timers reels ne sont pas touches', support.includes('check.json'), support);

  await loadEmojis({ application: { emojis: { fetch: async () => new Map() } } });

  const names = definitions.map((c) => c.name);
  console.log(`${names.length} commande(s) declarees : ${names.join(' ')}\n`);

  // --- Les timers ---
  console.log('TIMERS');
  for (const item of ['helmet', 'toolcase', 'starbattery']) {
    const text = await run(item);
    report(`/${item} demarre un timer`,
      typeof text === 'string' && /Reset in/.test(text), String(text).slice(0, 60));
  }

  const wars = await run('wars', { player: 'TestCible' });
  report('/wars accepte un nom', /TestCible/i.test(String(wars)), String(wars).slice(0, 60));

  const upgrade = await run('upgrade', { duration: '2h', name: 'Barracks' });
  report('/upgrade accepte duree et nom',
    /Barracks/i.test(String(upgrade)) && /Reset in/.test(String(upgrade)),
    String(upgrade).slice(0, 60));

  const mauvaise = await run('upgrade', { duration: 'pas-une-duree' });
  report('/upgrade refuse une duree invalide',
    /Could not read duration/i.test(String(mauvaise)), String(mauvaise).slice(0, 60));

  const liste = await run('timers');
  report('/timers liste les timers en cours',
    /Tinodon/.test(String(liste)), String(liste).slice(0, 60));

  const running = store.forUser(USER, GUILD);
  report('les timers sont bien en base', running.length >= 5, `${running.length} trouve(s)`);

  // --- L'arret ---
  console.log('\nARRET');
  const cible = running[0];
  const stopped = await run('stop', { timer: cible.key });
  report('/stop arrete le bon timer',
    store.get(cible.key) === null, 'le timer est toujours la');
  // Le libelle compte autant que l'arret : "stopped undefined." laissait
  // passer un appel a timerLabel dont les arguments etaient inverses.
  report('/stop nomme le timer arrete',
    /stopped .+\./.test(String(stopped)) && !/undefined|null/.test(String(stopped)),
    String(stopped).slice(0, 60));

  const inconnu = await run('stop', { timer: 'cle-inexistante' });
  report('/stop refuse une cle inconnue',
    /No such timer/i.test(String(inconnu)), String(inconnu).slice(0, 60));

  // L'autocompletion est le SEUL moyen de designer un timer : sans elle, /stop
  // demande une cle interne que personne ne peut deviner.
  const suggestions = await (async () => {
    const it = fakeInteraction('stop', { focused: '' });
    await handleAutocomplete(it);
    return it.sent.content;
  })();
  report('/stop propose les timers de celui qui tape',
    Array.isArray(suggestions) && suggestions.length > 0,
    JSON.stringify(suggestions).slice(0, 60));
  report('/stop propose des libelles lisibles',
    (suggestions ?? []).every((c) => c.name && !/undefined|null/.test(c.name)),
    JSON.stringify(suggestions).slice(0, 90));
  report('/stop propose "tout arreter"',
    (suggestions ?? []).some((c) => c.value === '__all__'),
    JSON.stringify(suggestions).slice(0, 60));
  report('/stop ne propose que des cles reelles',
    (suggestions ?? []).every((c) => c.value === '__all__' || store.get(c.value)),
    'une suggestion pointe sur un timer inexistant');

  // --- Les coordonnees a la main ---
  console.log('\nPIN');
  const pin = await run('pin', { player: 'Myra', coords: '512,340 601,299' });
  report('/pin accepte plusieurs paires',
    /\*\*2\*\* new/.test(String(pin)), String(pin).slice(0, 80));

  const apresPin = await run('find', { player: 'Myra' });
  report('/find ressort ce que /pin a enregistre',
    /512,\s*340/.test(String(apresPin)), String(apresPin).slice(0, 90));

  const pinNul = await run('pin', { player: 'Myra', coords: 'nawak' });
  report('/pin refuse des coordonnees illisibles',
    !/^\*\*/.test(String(pinNul)) || /could not|no coordinate/i.test(String(pinNul)),
    String(pinNul).slice(0, 70));

  // --- L'intel, qui touche l'API du jeu ---
  console.log('\nINTEL (API du jeu)');
  const scout = await run('scout', { player: 'Myra' });
  report('/scout trouve un joueur reel',
    /Myra/i.test(String(scout)) && /level/i.test(String(scout)), String(scout).slice(0, 70));

  const scoutNul = await run('scout', { player: 'zzz-nexiste-vraiment-pas' });
  report('/scout gere un joueur inexistant',
    /No player found/i.test(String(scoutNul)), String(scoutNul).slice(0, 60));

  const alliance = await run('alliance', { name: 'folk valley' });
  report('/alliance trouve une alliance reelle',
    /Folk Valley/i.test(String(alliance)), String(alliance).slice(0, 70));

  // --- La carte, qui touche Upstash ---
  console.log('\nCARTE (Upstash)');
  const find = await run('find', { player: 'Myra' });
  report('/find sort les coordonnees du balayage',
    /336,\s*7|336,7/.test(String(find).replace(/\s+/g, ' ')), String(find).slice(0, 90));
  report('/find annonce le nombre de colonies',
    /colonies mapped/i.test(String(find)), String(find).slice(0, 90));

  const findVide = await run('find', { player: 'badboytgr' });
  report('/find gere un joueur hors zone',
    /None mapped|colonies mapped/i.test(String(findVide)), String(findVide).slice(0, 70));

  const carte = await run('map', { alliance: 'folk valley' });
  report('/map trouve les membres cartographies',
    /Myra/.test(String(carte)), String(carte).slice(0, 90));

  const carteVide = await run('map', { alliance: 'nexiste-pas-du-tout' });
  report('/map gere une alliance inexistante',
    /No alliance found/i.test(String(carteVide)), String(carteVide).slice(0, 60));

  // --- L'aide ---
  console.log('\nAIDE');
  const aide = await run('glhelp');
  report('/glhelp cite toutes les commandes',
    names.filter((n) => n !== 'glhelp').every((n) => String(aide).includes(`/${n}`)),
    names.filter((n) => !String(aide).includes(`/${n}`)).join(' '));
  report('/glhelp tient dans un message Discord', String(aide).length <= 2000,
    `${String(aide).length} caracteres`);

  // --- Menage ---
  store.forUser(USER, GUILD).forEach((t) => store.remove(t.key));

  console.log(`\n${passed} controle(s) passes, ${failures.length} echec(s)`);
  if (failures.length) {
    console.log('\nA CORRIGER :');
    failures.forEach((f) => console.log(`   ${f}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nLe controle a plante :', err);
  process.exitCode = 1;
});
