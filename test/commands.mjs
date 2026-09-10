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
import { interactionFromMessage, messageContentEnabled, optionsFor, parseMessage } from '../src/textcommands.js';

const TEST_SCHEMA = 'essai';
import { loadEmojis, NAMED_EMOJIS } from '../src/emoji.js';
import { ITEM_LIST } from '../src/items.js';

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
  // Deux planetes dans le meme systeme : le cas qui en faisait perdre 622.
  { name: 'Stijnjr', spots: [[3, 0, null], [3, 0, 4]] },
];

// Ce qu'une reponse de carte ne doit JAMAIS afficher : un QG inconnu n'affiche
// rien (demande explicite de Noe).
const FORBIDDEN = /HQ \?|NaN|\bnull\b|\bundefined\b|📌/;

// Espace "chiffre" (U+2007), qui aligne les QG apres les blocs gris.
const F = '\u2007';

async function seedMap() {
  const ids = {};
  for (const fixture of FIXTURES) {
    const user = await api.getUserByName(fixture.name);
    ids[fixture.name] = Number(user.Id);
    await sql.query(
      `INSERT INTO joueurs (id, pseudo, alliance, niveau, nb_planetes) VALUES ($1, $2, $3, $4, $5)`,
      [user.Id, user.Name, user.AllianceId ?? null, user.Level, user.Planets?.length ?? 0],
    );
    const numero = {};
    for (const [x, y, hq] of fixture.spots) {
      numero[`${x},${y}`] = (numero[`${x},${y}`] ?? 0) + 1;
      await sql.query(
        `INSERT INTO colonies (joueur_id, x, y, numero, qg, systeme, origine)
         VALUES ($1, $2, $3, $4, $5, $6, 'releve')`,
        [user.Id, x, y, numero[`${x},${y}`], hq, x === 359 && y === 11 ? 'DIADEM' : null],
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
  const ordre = (liste.match(/`[^`]+` \d/g) ?? []).map((s) => s.slice(1, s.lastIndexOf('`')));
  report('/list est dans l\'ordre alphabetique, sans tenir compte des majuscules',
    ordre.join('|') === ['HansWorsdt', 'Myra', 'Stijnjr'].join('|'), ordre.join(' '));
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

  // --- /pin : le pseudo, puis chaque planete "x,y" suivie de son QG ---
  const lu = (text) => {
    const r = pins.parsePinInput(text);
    return r.error ? 'erreur' : `${r.name}|${r.entries.map((e) => `${e.x},${e.y}:${e.hq ?? '-'}`).join(' ')}`;
  };
  for (const [saisie, attendu] of [
    ['Myra 336,7', 'Myra|336,7:-'],
    ['Myra 336,7 5', 'Myra|336,7:5'],
    ['Myra 336, 7 5 338,10 4', 'Myra|336,7:5 338,10:4'],
    ['krzysztof32171 351,10 3', 'krzysztof32171|351,10:3'],
    ['2003 351,10', '2003|351,10:-'],
    ['Myra 5', 'erreur'],
    ['Myra 336,7 12', 'erreur'],
    ['Myra', 'erreur'],
  ]) {
    report(`/pin lit "${saisie}"`, lu(saisie) === attendu, `${lu(saisie)} au lieu de ${attendu}`);
  }

  // --- /edit : le pseudo, le numero de ligne de /find, puis ce qui change ---
  const luEdit = (text) => {
    const r = pins.parseEditInput(text);
    return r.error ? 'erreur' : `${r.name}|${r.line}|${JSON.stringify(r.change)}`;
  };
  for (const [saisie, attendu] of [
    ['Myra 3 delete', 'Myra|3|{"remove":true}'],
    ['Myra 3 6', 'Myra|3|{"hq":6}'],
    ['Myra 3 340,8', 'Myra|3|{"coords":{"x":340,"y":8}}'],
    ['Myra 3 340,8 6', 'Myra|3|{"hq":6,"coords":{"x":340,"y":8}}'],
    ['2003 3 5', '2003|3|{"hq":5}'],
    ['Myra delete', 'erreur'],
    ['Myra 3', 'erreur'],
    ['Myra 3 10', 'erreur'],
  ]) {
    report(`/edit lit "${saisie}"`, luEdit(saisie) === attendu, `${luEdit(saisie)} au lieu de ${attendu}`);
  }

  const visibles = async (x, y) => (await sql.query(
    `SELECT numero, origine, qg FROM colonies
     WHERE joueur_id = $1 AND x = $2 AND y = $3 AND NOT masquee ORDER BY numero`,
    [ids.Myra, x, y])).rows;

  // Chaque /pin ajoute une planete, meme sur une case deja connue (regle de Noe).
  const pin = keep(await run('pin', { player: 'Myra 512,340 5' }));
  report('/pin ajoute une planete avec son QG', /\*\*1\*\* planet\(s\) added/.test(pin), pin);
  keep(await run('pin', { player: 'Myra 512,340' }));
  report('/pin sur la meme case ajoute une 2e planete',
    (await visibles(512, 340)).map((r) => `${r.numero}:${r.qg ?? '-'}`).join(' ') === '1:5 2:-',
    JSON.stringify(await visibles(512, 340)));
  keep(await run('pin', { player: 'Myra 336,7' }));
  report('/pin sur une case relevee ajoute aussi une planete',
    (await visibles(336, 7)).map((r) => `${r.numero}:${r.origine}`).join(' ') === '1:releve 2:pin',
    JSON.stringify(await visibles(336, 7)));

  // /find : une ligne numerotee par planete, dans l'ordre x, y, numero.
  const numerote = keep(await run('find', { player: 'Myra' }));
  // Ni numero de ligne ni marque de pin (Noe trouvait ca moche) ; le QG est
  // aligne en colonne grace a des espaces "chiffre" apres le bloc gris.
  const lignes = numerote.split('\n').filter((l) => l.startsWith('`'));
  // Dans l'ordre de saisie (demande de Noe) : le releve d'abord, puis les pins
  // dans l'ordre ou ils ont ete faits — le 2e 336,7, pinne en dernier, arrive
  // en dernier, bien qu'il ait les plus petites coordonnees.
  report('/find : une ligne par planete, dans l\'ordre de saisie', lignes.join('|') === [
    '`336,7`', `\`338,10\`${F} HQ 5`, '`349,5`', '`359,11`',
    '`512,340` HQ 5', '`512,340`', '`336,7`'].join('|'), lignes.join(' | '));
  report('/find ne met aucun espace dans les blocs gris', lignes.every((l) => !/`[^`]*\s[^`]*`/.test(l)),
    lignes.join(' | '));

  // Les 24 cases : une par planete, meme coordonnee repetee.
  const fiche = async () => (await sql.query('SELECT * FROM joueurs WHERE id = $1', [ids.Myra])).rows[0];
  const cases = (row) => Array.from({ length: 12 }, (_, i) => row[`colonie_${i + 1}`]).filter(Boolean);
  let f = await fiche();
  report('les 24 cases ont une case par planete',
    cases(f).join(' ') === '336,7 338,10 349,5 359,11 512,340 512,340 336,7', cases(f).join(' '));
  report('chaque QG est dans la case voisine de sa planete',
    f.colonie_2 === '338,10' && f.qg_2 === 5 && f.qg_1 === null && f.qg_5 === 5,
    `colonie_2=${f.colonie_2} qg_2=${f.qg_2} qg_5=${f.qg_5}`);

  // /edit, ligne par ligne.
  const e1 = keep(await run('edit', { player: 'Myra 7 delete' }));
  report('/edit supprime une ligne pinnee', /line 7 .* deleted/.test(e1)
    && (await visibles(336, 7)).length === 1, e1.slice(0, 120));
  const e2 = keep(await run('edit', { player: 'Myra 1 delete' }));
  const { rows: masquee } = await sql.query(
    'SELECT masquee FROM colonies WHERE joueur_id = $1 AND x = 336 AND y = 7 AND numero = 1', [ids.Myra]);
  report("/edit masque une ligne du releve au lieu de l'effacer",
    masquee[0]?.masquee === true && (await visibles(336, 7)).length === 0, e2.slice(0, 120));
  const e3 = keep(await run('edit', { player: 'Myra 2 6' }));
  report('/edit change un QG', e3.includes(`\`349,5\`${F}${F} HQ 6`), e3);
  // Le QG tombe a la meme colonne sur toutes les lignes : meme nombre de
  // caracteres (chiffres ou espaces "chiffre") avant lui.
  const colonnes = e3.split('\n')
    .filter((l) => l.startsWith('`') && l.includes(' HQ '))
    .map((l) => l.indexOf(' HQ '));
  report('les QG sont alignes en colonne', colonnes.length >= 2 && new Set(colonnes).size === 1,
    JSON.stringify(colonnes));
  const e4 = keep(await run('edit', { player: 'Myra 3 360,12' }));
  // Deplacee, la planete garde sa place dans la liste (3e ligne).
  report('/edit deplace une planete sans changer sa place',
    e4.split('\n').filter((l) => l.startsWith('`'))[2] === '`360,12`'
    && (await visibles(359, 11)).length === 0, e4);
  const e5 = keep(await run('edit', { player: 'Myra 9 delete' }));
  report('/edit refuse une ligne inexistante', /has no line 9/.test(e5), e5);

  // Une correction doit survivre a la publication suivante. Memes requetes que
  // scout/publish_sql.py : on remplace les planetes relevees non masquees, et
  // une planete relevee qui retombe sur une place prise ou masquee est ignoree.
  await sql.query("DELETE FROM colonies WHERE origine = 'releve' AND NOT masquee");
  for (const fixture of FIXTURES) {
    const numero = {};
    for (const [x, y, hq] of fixture.spots) {
      numero[`${x},${y}`] = (numero[`${x},${y}`] ?? 0) + 1;
      await sql.query(
        // Date d'entree = date de capture, anterieure aux pins : comme la
        // vraie publication.
        `INSERT INTO colonies (joueur_id, x, y, numero, qg, origine, ajoute_le)
         VALUES ($1, $2, $3, $4, $5, 'releve', to_timestamp(1))
         ON CONFLICT (joueur_id, x, y, numero) DO NOTHING`,
        [ids[fixture.name], x, y, numero[`${x},${y}`], hq]);
    }
  }
  await sql.query('SELECT rafraichir_cases($1::bigint[])', [Object.values(ids)]);
  f = await fiche();
  report('une correction survit a la publication suivante',
    cases(f).join(' ') === '338,10 349,5 360,12 512,340 512,340'
      && (await visibles(349, 5))[0]?.qg === 6,
    cases(f).join(' '));

  // Plusieurs planetes d'un joueur dans le meme systeme.
  const who3 = keep(await run('who', { coords: '3,0' }));
  report("/who regroupe les planetes d'un joueur (×2)", /\*\*Stijnjr\*\* ×2/.test(who3), who3);
  const findS2 = keep(await run('find', { player: 'Stijnjr' }));
  report('/find liste chaque planete du meme systeme',
    /`3,0`\n`3,0` HQ 4/.test(findS2), findS2);
  const carte2 = keep(await run('map', { alliance: 'folk valley' }));
  report('/map regroupe les planetes sur la meme case', carte2.includes('`512,340`×2 HQ 5'), carte2);
  const spansMap = carte2.match(/`[^`]*`/g) ?? [];
  report('/map met chaque coordonnee dans un bloc gris sans espace',
    spansMap.length > 0 && spansMap.every((s) => /^`\d+,\d+`$/.test(s)), JSON.stringify(spansMap));

  const pinNul = await run('pin', { player: 'Myra nawak' });
  report('/pin refuse une saisie illisible', /not a coordinate|No coordinates/i.test(String(pinNul)),
    String(pinNul).slice(0, 90));

  const bad = outputs.filter((text) => FORBIDDEN.test(text));
  report('aucune reponse de carte n\'affiche "HQ ?", NaN, null ou undefined', !bad.length,
    bad.map((t) => t.match(FORBIDDEN)[0]).join(', '));

  report('la vraie carte (schema public) n\'est pas touchee', (await realCount()) === before,
    `${before} -> ${await realCount()} colonies`);
}

// --- Commandes texte : "!find myra", sans aucun champ ---
function fakeMessage(content) {
  const sent = [];
  const channel = {
    async send(payload) {
      const message = { content: payload.content, payload, async edit(next) { message.content = next.content; return message; } };
      sent.push(message);
      return message;
    },
    async sendTyping() {},
  };
  return {
    sent,
    message: {
      content,
      author: { id: USER, bot: false, username: 'Tinodon', displayName: 'Tinodon' },
      member: { displayName: 'Tinodon' },
      guildId: GUILD,
      channelId: CHANNEL,
      channel,
    },
  };
}

async function runText(content) {
  const { sent, message } = fakeMessage(content);
  const interaction = interactionFromMessage(message);
  if (!interaction) return null;
  await handleCommand(interaction);
  return sent;
}

async function checkTextCommands() {
  console.log('\nCOMMANDES TEXTE (!find myra)');

  // Le bot ne demande l'intent que s'il est active : sinon Discord refuse sa
  // connexion et il tomberait entierement.
  report("l'intent absent n'est pas demande (drapeaux actuels de l'application)",
    messageContentEnabled(10485760) === false);
  report("l'intent active par l'interrupteur du portail est reconnu",
    messageContentEnabled(10485760 | (1 << 19)) === true);
  report("l'intent d'un bot verifie est reconnu", messageContentEnabled(1 << 18) === true);

  const lecture = (text) => {
    const r = parseMessage(text);
    return r ? `${r.name}|${r.rest}` : 'ignore';
  };
  for (const [texte, attendu] of [
    ['!find myra', 'find|myra'],
    ['!FIND Myra', 'find|Myra'],
    ['!pin myra 336,7 5', 'pin|myra 336,7 5'],
    ['!list', 'list|'],
    ['find myra', 'ignore'],
    ['!ban someone', 'ignore'],
    ['!', 'ignore'],
  ]) {
    report(`"${texte}" est lu comme ${attendu}`, lecture(texte) === attendu, lecture(texte));
  }

  const opts = (name, rest) => JSON.stringify(optionsFor(name, rest));
  for (const [name, rest, attendu] of [
    ['find', 'myra', '{"player":"myra"}'],
    ['pin', 'myra 336,7 5', '{"player":"myra 336,7 5"}'],
    ['upgrade', '2h Barracks repeat', '{"repeat":true,"duration":"2h","name":"Barracks"}'],
    ['helmet', 'repeat', '{"repeat":true}'],
    ['wars', 'John Doe', '{"player":"John Doe"}'],
    ['list', '', '{}'],
  ]) {
    report(`!${name} ${rest} -> ${attendu}`, opts(name, rest) === attendu, opts(name, rest));
  }

  // Bout en bout : le message part dans le salon, sans champ ni fenetre.
  const aide = await runText('!glhelp');
  report('!glhelp repond dans le salon', aide?.length === 1 && /GalaxyTimer/.test(aide[0].content),
    JSON.stringify(aide?.map((m) => m.content.slice(0, 40))));

  const casque = await runText('!helmet repeat');
  const timer = store.forUser(USER, GUILD).find((t) => t.itemId === 'helmet');
  report('!helmet repeat lance un timer recurrent', Boolean(casque?.length) && timer?.repeat === true,
    JSON.stringify(timer));
  const stop = await runText('!stop helmet');
  report('!stop helmet arrete le bon timer', /stopped/i.test(stop?.[0]?.content ?? '')
    && !store.forUser(USER, GUILD).some((t) => t.itemId === 'helmet'), stop?.[0]?.content);

  if (sql.configured()) {
    const find = await runText('!find Myra');
    report('!find Myra repond un seul message, edite apres la recherche',
      find?.length === 1 && /colonies mapped/.test(find[0].content), find?.[0]?.content?.slice(0, 80));
    report('les reponses texte ne pingent personne',
      JSON.stringify(find?.[0]?.payload?.allowedMentions) === '{"parse":[]}',
      JSON.stringify(find?.[0]?.payload?.allowedMentions));
  }

  report('un message d\'un autre bot est ignore',
    interactionFromMessage({ ...fakeMessage('!find myra').message, author: { id: 'x', bot: true } }) === null);
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

  await run('toolcase', { repeat: true });
  report('/toolcase repeat:True lance un timer recurrent',
    store.forUser(USER, GUILD).find((t) => t.itemId === 'toolcase')?.repeat === true,
    'l option repeat est ignoree');

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

  await checkTextCommands();

  // --- L'aide ---
  console.log('\nAIDE');
  const aide = await run('glhelp');
  report('/glhelp cite toutes les commandes',
    names.filter((n) => n !== 'glhelp').every((n) => String(aide).includes(`/${n}`)),
    names.filter((n) => !String(aide).includes(`/${n}`)).join(' '));
  report('/glhelp tient dans un message Discord', String(aide).length <= 2000,
    `${String(aide).length} caracteres`);

  // En production les emojis sont custom : "<:helmet:1234567890123456789>"
  // fait ~30 caracteres au lieu de 2 pour l'emoji de secours. Mesurer l'aide
  // avec les seuls emojis de secours laissait passer une aide trop longue pour
  // Discord. On la remesure avec des emojis de taille reelle.
  const fakeEmojis = new Map(
    [...ITEM_LIST.map((i) => i.emojiName ?? i.id), ...Object.keys(NAMED_EMOJIS)]
      .map((name, i) => [String(i), { name, id: String(1234567890123456789n + BigInt(i)), animated: false }]),
  );
  await loadEmojis({ application: { emojis: { fetch: async () => fakeEmojis } } });
  const aideReelle = String(await run('glhelp'));
  report('/glhelp tient dans un message Discord avec les vrais emojis', aideReelle.length <= 2000,
    `${aideReelle.length} caracteres`);
  report("l'emoji starbase remplace le mot HQ quand il existe",
    /<:starbase:\d+> 5/.test(await (async () => {
      // Une ligne de /find avec un QG connu, rendue avec l'emoji charge.
      if (!sql.configured()) return '<:starbase:1> 5';
      return String(await run('find', { player: 'Myra' }));
    })()), 'pas d\'emoji starbase devant le niveau de QG');
  await loadEmojis({ application: { emojis: { fetch: async () => new Map() } } });

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
