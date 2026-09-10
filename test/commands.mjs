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
import { readFileSync } from 'node:fs';

import { handleCommand, handleAutocomplete, definitions, parseListInput } from '../src/commands.js';
import * as store from '../src/store.js';
import { initStores } from '../src/boot.js';
import * as sql from '../src/sql.js';
import * as api from '../src/glapi.js';
import * as pins from '../src/pins.js';

const TEST_SCHEMA = 'essai';
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
    async deferReply() { sent.deferred = true; this.deferred = true; },
    async reply(payload) {
      if (sent.deferred) throw new Error('reply() apres deferReply() : Discord le refuse');
      sent.content = payload?.content ?? payload;
      this.replied = true;
    },
    async editReply(payload) { sent.content = payload?.content ?? payload; this.replied = true; },
    deferred: false,
    replied: false,
    async respond(choices) { sent.content = choices; },
    isRepliable: () => true,
  };
}

// Commandes restees "en train de reflechir" : differees, jamais completees.
// C'est le symptome exact que voit l'utilisateur quand un gestionnaire plante
// apres son deferReply.
const hanging = [];

async function run(name, options = {}) {
  const interaction = fakeInteraction(name, options);
  try {
    await handleCommand(interaction);
  } catch (err) {
    hanging.push(`/${name} a leve : ${err.message}`);
  }
  if (interaction.sent.deferred && interaction.sent.content == null) {
    hanging.push(`/${name} differee sans reponse`);
  }
  return interaction.sent.content;
}

// Colonies de depart du schema de test : de vrais joueurs (leurs ids viennent
// de l'API, comme en production), de vraies coordonnees relevees.
const FIXTURES = [
  { name: 'Myra', spots: [[336, 7, null], [338, 10, 5], [349, 5, null], [359, 11, null]] },
  { name: 'HansWorsdt', spots: [[359, 11, 7]] },
  { name: 'Stijnjr', spots: [[3, 0, null]] },
];

// Ce qu'une reponse de carte ne doit JAMAIS afficher : un QG inconnu n'affiche
// rien (demande explicite de Noe).
const FORBIDDEN = /HQ \?|NaN|\bnull\b|\bundefined\b/;

async function seedMap() {
  const ids = {};
  for (const fixture of FIXTURES) {
    const user = await api.getUserByName(fixture.name);
    ids[fixture.name] = Number(user.Id);
    await sql.query(
      `INSERT INTO joueurs (id, pseudo, alliance, niveau, nb_planetes) VALUES ($1, $2, $3, $4, $5)`,
      [user.Id, user.Name, user.AllianceId ?? null, user.Level, user.Planets?.length ?? 0],
    );
    for (const [x, y, hq] of fixture.spots) {
      await sql.query(
        `INSERT INTO colonies (joueur_id, x, y, qg, systeme, origine)
         VALUES ($1, $2, $3, $4, $5, 'releve')`,
        [user.Id, x, y, hq, x === 359 && y === 11 ? 'DIADEM' : null],
      );
    }
  }
  await sql.query('SELECT rafraichir_cases($1::bigint[])', [Object.values(ids)]);
  return ids;
}

async function checkMap() {
  // La vraie carte ne doit pas bouger d'une ligne pendant le controle.
  const realCount = async () => {
    const { rows } = await sql.query(
      "SELECT CASE WHEN to_regclass('public.colonies') IS NULL THEN -1 ELSE " +
      '(SELECT count(*) FROM public.colonies) END AS n',
    ).catch(() => ({ rows: [{ n: -1 }] }));
    return Number(rows[0].n);
  };
  const before = await realCount();

  const ids = await seedMap();
  const outputs = [];
  const keep = (text) => { outputs.push(String(text)); return String(text); };

  const find = keep(await run('find', { player: 'Myra' }));
  report('/find sort les coordonnees relevees',
    /336,\s*7/.test(find) && /colonies mapped/i.test(find), find.slice(0, 90));
  report('/find affiche le QG quand il est connu', find.includes('`338,10` HQ 5'), find);
  // Noe veut les coordonnees dans un bloc gris, mais SERRE : "`336,7`", pas
  // "`  336,   7`" avec des espaces d'alignement.
  const spans = find.match(/`[^`]*`/g) ?? [];
  report('/find met chaque coordonnee dans un bloc gris sans espace',
    spans.length === 4 && spans.every((s) => /^`\d+,\d+`$/.test(s)), JSON.stringify(spans));

  // Un pseudo en S : avec les morceaux Upstash, ces joueurs etaient ranges
  // sous "b" et cherches sous "s" — 18 % d'introuvables. La base cherche par id.
  const findS = keep(await run('find', { player: 'Stijnjr' }));
  report('/find trouve un joueur dont le pseudo commence par S',
    /colonies mapped/i.test(findS), findS.slice(0, 90));

  const findVide = keep(await run('find', { player: 'badboytgr' }));
  report('/find gere un joueur sans colonie connue', /None mapped/i.test(findVide),
    findVide.slice(0, 70));

  const carte = keep(await run('map', { alliance: 'folk valley' }));
  report('/map trouve les membres cartographies', /Myra/.test(carte), carte.slice(0, 90));

  const carteVide = await run('map', { alliance: 'nexiste-pas-du-tout' });
  report('/map gere une alliance inexistante',
    /No alliance found/i.test(String(carteVide)), String(carteVide).slice(0, 60));

  const who = keep(await run('who', { coords: '359,11' }));
  report('/who cite les joueurs de la case',
    /Myra/.test(who) && /HansWorsdt/.test(who) && /DIADEM/.test(who), who.slice(0, 120));
  const whoVide = keep(await run('who', { coords: '1,1' }));
  report('/who gere une case inconnue', /Nobody known/i.test(whoVide), whoVide.slice(0, 70));
  const whoDeux = await run('who', { coords: '1,2 3,4' });
  report('/who refuse plusieurs coordonnees', /one coordinate/i.test(String(whoDeux)),
    String(whoDeux).slice(0, 70));

  // /list : ce que la base contient, pour verifier le releve.
  const liste = keep(await run('list', {}));
  report('/list montre les joueurs de la carte',
    /Myra/.test(liste) && /HansWorsdt/.test(liste) && /Stijnjr/.test(liste), liste.slice(0, 200));
  report('/list donne colonies connues / planetes', /`Myra` 4\/\d+/.test(liste), liste.slice(0, 200));
  report('/list tient dans un message Discord', liste.length <= 2000, `${liste.length} caracteres`);
  const listeFiltre = keep(await run('list', { filter: 'myr' }));
  report('/list myr filtre par bout de pseudo',
    /Myra/.test(listeFiltre) && !/HansWorsdt/.test(listeFiltre), listeFiltre.slice(0, 200));
  const listeVide = keep(await run('list', { filter: 'zzzqqq' }));
  report('/list gere un filtre sans resultat', /No mapped player/i.test(listeVide), listeVide);
  const listeLoin = keep(await run('list', { filter: '99' }));
  report('/list gere une page inexistante', /does not exist/i.test(listeLoin), listeLoin);
  for (const [saisie, attendu] of [['', '|1'], ['3', '|3'], ['myr', 'myr|1'], ['myr 2', 'myr|2']]) {
    const r = parseListInput(saisie);
    report(`/list lit "${saisie}"`, `${r.search}|${r.page}` === attendu, `${r.search}|${r.page}`);
  }

  // La saisie en une traite : le pseudo, puis les coordonnees lues depuis la fin.
  const lu = (text) => {
    const r = pins.parsePinInput(text);
    return r.error ? 'erreur' : `${r.name}|${r.coords.map((c) => `${c.x},${c.y}`).join(' ')}`;
  };
  for (const [saisie, attendu] of [
    ['Myra 351,10', 'Myra|351,10'],
    ['krzysztof32171 351,10 352,11', 'krzysztof32171|351,10 352,11'],
    ['Myra 351 10', 'Myra|351,10'],
    ['Myra 351, 10', 'Myra|351,10'],
    ['2003 351,10', '2003|351,10'],
    ['Myra', 'erreur'],
  ]) {
    report(`/pin lit "${saisie}"`, lu(saisie) === attendu, `${lu(saisie)} au lieu de ${attendu}`);
  }

  // /pin ecrit dans la base, et la carte est globale.
  // Un seul champ, rempli d'une traite : "/pin Myra 512,340 601,299".
  const pin = keep(await run('pin', { player: 'Myra 512,340 601,299' }));
  report('/pin accepte plusieurs paires', /\*\*2\*\* new/.test(pin), pin.slice(0, 80));

  // Separateurs tolerés : "336, 7" doit valoir "336,7".
  const repin = keep(await run('pin', { player: 'Myra 336, 7' }));
  report('/pin sur une colonie relevee la confirme', /1 already known/.test(repin),
    repin.slice(0, 80));
  const { rows: origine } = await sql.query(
    'SELECT origine FROM colonies WHERE joueur_id = $1 AND x = 336 AND y = 7', [ids.Myra]);
  report('un pin prime sur le releve a la meme coordonnee', origine[0]?.origine === 'pin',
    JSON.stringify(origine));

  // Les 24 cases de la table joueurs suivent /pin sans autre intervention.
  const { rows: [fiche] } = await sql.query('SELECT * FROM joueurs WHERE id = $1', [ids.Myra]);
  const cases = Array.from({ length: 12 }, (_, i) => fiche[`colonie_${i + 1}`]).filter(Boolean);
  report('les 24 cases de Myra incluent ses pins',
    cases.length === 6 && cases.includes('512,340') && cases.includes('601,299'),
    JSON.stringify(cases));
  report('chaque QG est dans la case voisine de sa colonie',
    fiche.colonie_2 === '338,10' && fiche.qg_2 === 5 && fiche.qg_1 === null,
    `colonie_2=${fiche.colonie_2} qg_2=${fiche.qg_2} qg_1=${fiche.qg_1}`);

  const apresPin = keep(await run('find', { player: 'Myra' }));
  report('/find ressort les pins, marques comme tels',
    apresPin.includes('`512,340` 📌'), apresPin.slice(0, 200));

  const carteSerree = keep(await run('map', { alliance: 'folk valley' }));
  const spansMap = carteSerree.match(/`[^`]*`/g) ?? [];
  report('/map met aussi chaque coordonnee dans un bloc gris sans espace',
    spansMap.length > 0 && spansMap.every((s) => /^`\d+,\d+`$/.test(s)), JSON.stringify(spansMap));

  const pinNul = await run('pin', { player: 'Myra nawak' });
  report('/pin refuse des coordonnees illisibles',
    /No coordinates found/i.test(String(pinNul)), String(pinNul).slice(0, 70));

  const bad = outputs.filter((text) => FORBIDDEN.test(text));
  report('aucune reponse de carte n\'affiche "HQ ?", NaN, null ou undefined', !bad.length,
    bad.map((t) => t.match(FORBIDDEN)[0]).join(', '));

  report('la vraie carte (schema public) n\'est pas touchee', (await realCount()) === before,
    `${before} -> ${await realCount()} colonies`);
}

async function main() {
  console.log('Verification de toutes les commandes\n');

  // Les timers reels vivent dans Upstash. Ce controle en cree et en arrete :
  // s'il ecrivait la-bas, il effacerait les timers en cours de vraies
  // personnes. On retire donc les identifiants Upstash : les stockages
  // retombent sur un fichier de test.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.GALAXYTIMER_DB = new URL('../data/timers.check.json', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1');

  // Meme principe pour la carte : elle est GLOBALE, un faux pin ecrit ici
  // apparaitrait sur tous les serveurs. Tout se passe dans un schema a part,
  // vide au depart et supprime a la fin ; le schema `public` (la vraie carte)
  // n'est jamais touche.
  process.env.GALAXYTIMER_SQL_SCHEMA = TEST_SCHEMA;
  if (sql.configured()) await sql.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);

  const support = store.selectBackend().name;
  // Le MEME chemin que le bot (src/boot.js). Ce controle faisait ses propres
  // init, pins compris, alors que index.js oubliait les pins : /pin marchait
  // ici et restait bloque en production.
  await initStores();

  report('les timers reels ne sont pas touches', support.includes('check.json'), support);
  report('la base de la carte est configuree (DATABASE_URL)', sql.configured(),
    'DATABASE_URL absent du .env : /pin, /find, /map et /who ne peuvent pas marcher');

  // Le bot doit demarrer ses stockages par le meme chemin que ce controle,
  // sinon ce qui passe ici peut rester bloque en production.
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  report('le bot initialise ses stockages via boot.js', index.includes('await initStores()'),
    "src/index.js n'appelle pas initStores()");

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

  // --- La carte, dans la base SQL (schema de test) ---
  console.log(`\nCARTE (base SQL, schema "${TEST_SCHEMA}")`);
  if (sql.configured()) await checkMap();

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

  report('aucune commande ne reste "en train de reflechir"', hanging.length === 0,
    hanging.join(' ; '));

  if (sql.configured()) {
    await sql.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await sql.close();
  }

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
