// Test d'integration sans Discord : on simule le client et les interactions
// pour verifier le cycle de vie complet d'un timer (arme -> ping -> repeat,
// rattrapage apres redemarrage, isolation entre utilisateurs).

import assert from 'node:assert/strict';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Fichier dedie : le test ne doit JAMAIS toucher aux timers reels de data/.
// Doit etre pose avant l'import de store.js, qui lit la variable au chargement.
const DB = join(ROOT, 'data', 'timers.test.json');
process.env.GALAXYTIMER_DB = DB;
// Bibliotheque d'images dediee : le test ne doit pas dependre du contenu reel
// de assets/, ni le modifier.
const ART_ROOT = join(ROOT, 'data', 'assets.test');
process.env.GALAXYTIMER_ASSETS = ART_ROOT;
rmSync(DB, { force: true });

const store = await import('../src/store.js');
const { fileBackend, upstashBackend } = await import('../src/backends.js');
const { createServer } = await import('node:http');
const { spawn } = await import('node:child_process');
const { tick } = await import('../src/scheduler.js');
const { ITEMS, slugify, timerLabel } = await import('../src/items.js');
const { armTimer, definitions } = await import('../src/commands.js');
const { startedText, panelText, readyText, itemImage, completedText } = await import('../src/ui.js');
const { buildPanel } = await import('../src/commands.js');
const { helpText, descriptionText, MAX_DESCRIPTION } = await import('../src/help.js');
const { loadLibrary, loadEmojiArtwork, resolveArtwork, normalize } = await import('../src/artwork.js');
const intel = await import('../src/intel.js');
const { playerReport, allianceReport, fit } = await import('../src/intelview.js');
const { artworkFor } = await import('../src/ui.js');
const { startedMessage } = await import('../src/commands.js');

const sent = [];
// Messages de lancement, indexes par id : le scheduler doit les EDITER a
// l'echeance pour remplacer le decompte par "Completed".
const posted = new Map();
const fakeClient = {
  channels: {
    fetch: async (id) => ({
      isTextBased: () => true,
      send: async (p) => { sent.push({ id, ...p }); },
      messages: {
        fetch: async (mid) => {
          const m = posted.get(mid);
          if (!m) throw new Error('Unknown Message');
          return { id: mid, edit: async (p) => { Object.assign(m, p); return m; } };
        },
      },
    }),
  },
};

/** Simule le message poste par /timer et suivi par le scheduler. */
function trackLaunch(record, item) {
  const id = `msg-${record.key}`;
  posted.set(id, { content: startedText(record, item, 'Noe'), components: ['live'] });
  store.patch(record.key, { messageId: id, username: 'Noe' });
  return id;
}

const USER = '111111111111111111';
const GUILD_B = '555555555555555555';
const OTHER = '222222222222222222';
const GUILD = '333333333333333333';
const CHAN = '444444444444444444';

let passed = 0;
const check = (name, fn) => { fn(); console.log(`  ok  ${name}`); passed++; };

console.log('\n0. Le test est isole de la vraie base');
check('ecrit dans data/timers.test.json', () => assert.ok(DB.endsWith('timers.test.json')));
check('ne touche pas data/timers.json', () =>
  assert.notEqual(DB, join(ROOT, 'data', 'timers.json')));

console.log('\n1. Timer simple : ping puis desarmement');
store.load();
const t1 = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, item: ITEMS.starbattery, duration: 50, repeat: false });
check('timer persiste', () => assert.equal(store.all().length, 1));
check('expiration = now + duree', () => assert.ok(Math.abs(t1.expiresAt - Date.now() - 50) < 20));
await new Promise((r) => setTimeout(r, 80));
await tick(fakeClient);
check('un ping envoye', () => assert.equal(sent.length, 1));
check('mentionne le bon user', () => assert.ok(sent[0].content.startsWith(`<@${USER}>`)));
check('mention restreinte a ce user', () => assert.deepEqual(sent[0].allowedMentions.users, [USER]));
check('ping en texte brut, pas en embed', () => assert.equal(sent[0].embeds, undefined));
check('texte du ping correct', () => assert.match(sent[0].content, /Star Battery\*\* is ready!$/));
check('timer desarme apres ping', () => assert.equal(store.all().length, 0));

console.log('\n2. Timer repeat : se re-arme tout seul');
sent.length = 0;
armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, item: ITEMS.wars, duration: 50, repeat: true });
await new Promise((r) => setTimeout(r, 80));
await tick(fakeClient);
check('ping envoye', () => assert.equal(sent.length, 1));
check('timer toujours actif', () => assert.equal(store.all().length, 1));
check('re-arme dans le futur', () => assert.ok(store.all()[0].expiresAt > Date.now()));
sent.length = 0;
await tick(fakeClient);
check('pas de ping en boucle', () => assert.equal(sent.length, 0));

console.log('\n3. Rattrapage apres redemarrage du bot');
store.all().forEach((t) => store.remove(t.key));
sent.length = 0;
const stale = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, item: ITEMS.helmet, duration: 1000, repeat: false });
store.patch(stale.key, { expiresAt: Date.now() - 5 * 3600 * 1000 }); // expire il y a 5h
store.load(); // simule un redemarrage : relecture depuis le disque
check('timer relu depuis le disque', () => assert.equal(store.all().length, 1));
await tick(fakeClient);
check('ping de rattrapage envoye', () => assert.equal(sent.length, 1));
check('rattrapage : meme format qu un ping normal', () =>
  assert.match(sent[0].content, /Helmet\*\* is ready!$/));
check('le ping tient sur une seule ligne', () => assert.equal(sent[0].content.split('\n').length, 1));

console.log('\n4. Isolation multi-utilisateur');
store.all().forEach((t) => store.remove(t.key));
const mine = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, item: ITEMS.toolcase, duration: 9e6, repeat: false });
armTimer({ guildId: GUILD, channelId: CHAN, userId: OTHER, item: ITEMS.toolcase, duration: 9e6, repeat: false });
check('deux timers independants', () => assert.equal(store.all().length, 2));
check('/timers ne montre que les miens', () => assert.equal(store.forUser(USER, GUILD).length, 1));
const panel = buildPanel(USER, GUILD, 'Noe');
check('le panneau est du texte brut', () => assert.equal(typeof panel.content, 'string'));
check('le panneau ne ping personne', () => assert.deepEqual(panel.allowedMentions, { parse: [] }));

check('mon timer est intact', () => assert.ok(store.get(mine.key)));

console.log('\n4b. Isolation entre serveurs');
const inB = armTimer({ guildId: GUILD_B, channelId: '666', userId: USER, item: ITEMS.toolcase, duration: 9e6, repeat: false });
check('meme user, meme item, deux serveurs = deux timers', () => assert.notEqual(inB.key, mine.key));
check('le serveur A ne voit que son timer', () => assert.equal(store.forUser(USER, GUILD).length, 1));
check('le serveur B ne voit que le sien', () => assert.equal(store.forUser(USER, GUILD_B).length, 1));
check('le timer B pingue dans le salon de B', () => assert.equal(store.get(inB.key).channelId, '666'));
store.remove(inB.key);

console.log('\n5. Ce qui remplace les boutons : option repeat et /stop');
// Les boutons ont ete retires. Leurs deux roles doivent rester atteignables,
// sinon un timer devient impossible a arreter ou a rendre recurrent.
check('chaque commande de timer porte une option repeat', () => {
  const timerCommands = definitions.filter((c) => ITEMS[c.name]);
  assert.ok(timerCommands.length >= 5);
  assert.ok(timerCommands.every((c) => (c.options ?? []).some((o) => o.name === 'repeat')));
});
check('une commande /stop existe', () =>
  assert.ok(definitions.some((c) => c.name === 'stop')));
check('/stop propose ses choix en autocompletion', () => {
  const stop = definitions.find((c) => c.name === 'stop');
  assert.equal(stop.options[0].autocomplete, true);
});
check('plus aucune commande ne renvoie de composants', () =>
  assert.equal(buildPanel(USER, GUILD, 'Noe').components, undefined));
{
  const repeated = armTimer({
    guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe',
    item: ITEMS.starbattery, duration: 9e6, repeat: true,
  });
  check('un timer peut etre cree en repeat', () =>
    assert.equal(store.get(repeated.key).repeat, true));
  store.remove(repeated.key);
  check('l arret retire bien le timer', () =>
    assert.equal(store.get(repeated.key), null));
}

console.log('\n6. Construction des messages');
check('startedText : nom, emoji, item, duree', () =>
  assert.match(startedText(mine, ITEMS.toolcase, 'Noe'), /^\*\*Noe\*\* .+ \*\*Tool Case\*\* — /));
check('startedText : ligne de reset', () =>
  assert.match(startedText(mine, ITEMS.toolcase, 'Noe').split('\n')[1], /^Reset in <t:\d+:R> \(<t:\d+:f>\)$/));
check('startedText ne mentionne plus le repeat', () =>
  assert.ok(!/repeat/i.test(startedText({ ...mine, repeat: true }, ITEMS.toolcase, 'Noe'))));
check('startedText tient en 2 lignes', () =>
  assert.equal(startedText(mine, ITEMS.toolcase, 'Noe').split('\n').length, 2));
check('readyText', () => assert.match(readyText(mine, ITEMS.toolcase), /Tool Case\*\* is ready!$/));
check('panelText liste les timers', () =>
  assert.match(panelText(store.forUser(USER, GUILD), ITEMS, 'Noe'), /Tool Case/));
check('panelText vide', () => assert.match(panelText([], ITEMS, 'Noe'), /no active timers/i));
check('itemImage null si le fichier manque', () =>
  assert.equal(itemImage({ image: 'inexistant.png' }), null));
check('itemImage null si l item n a pas d image', () => assert.equal(itemImage({}), null));
const fakeTimers = (n) =>
  Array.from({ length: n }, (_, i) => ({ ...mine, key: `g:u:wars:p${i}`, itemId: 'wars', name: `P${i}` }));

check('emoji unicode en fallback sans emojis d application', () =>
  assert.match(startedText(mine, ITEMS.wars, 'Noe'), /⚔️/));
check('plus aucun type "test" dans le registre', () => assert.equal(ITEMS.test, undefined));


console.log('');
console.log('13. Aide et description, generees depuis le registre');
{
  const help = helpText();
  for (const id of ['helmet', 'toolcase', 'starbattery', 'wars', 'upgrade', 'timers']) {
    check(`/glhelp mentionne /${id}`, () => assert.ok(help.includes(`/${id}`)));
  }
  check('/glhelp tient sous les 2000 caracteres Discord', () => assert.ok(help.length <= 2000));
  check('/glhelp annonce 35h, pas 1d 11h', () => assert.ok(help.includes('35h')));
  check('/glhelp explique les timers nommes', () => assert.match(help, /side by side/i));

  const desc = descriptionText();
  check('description sous la limite Discord de 400', () => assert.ok(desc.length <= MAX_DESCRIPTION));
  check('description listant chaque commande', () =>
    assert.ok(['helmet', 'toolcase', 'starbattery', 'wars', 'upgrade', 'timers'].every((id) => desc.includes(`/${id}`))));
  check('description renvoyant vers /glhelp', () => assert.ok(desc.includes('/glhelp')));
}

console.log('');
console.log('14. Image d upgrade retrouvee depuis le nom saisi');
{
  const dir = join(ART_ROOT, 'upgrades');
  mkdirSync(dir, { recursive: true });
  for (const f of ['s-trike.png', 'laboratory.png', 'Starport.PNG', 'compact-house.webp', 'mine.png']) {
    writeFileSync(join(dir, f), '');
  }
  writeFileSync(join(dir, 'aliases.json'), JSON.stringify({ labo: 'laboratory', 'sniper': 'mine' }));
  writeFileSync(join(dir, 'notes.txt'), 'pas une image');
  loadLibrary('upgrades');

  const found = (name) => {
    const art = resolveArtwork('upgrades', name);
    return art?.kind === 'file' ? basename(art.path) : null;
  };

  for (const spelling of ['S-Trike', 's trike', 'strike', 'S.Trike', 'STRIKE', 's_trike']) {
    check(`"${spelling}" trouve s-trike.png`, () => assert.equal(found(spelling), 's-trike.png'));
  }
  check('majuscules du fichier ignorees', () => assert.equal(found('starport'), 'Starport.PNG'));
  check('autre extension indexee', () => assert.equal(found('Compact House'), 'compact-house.webp'));
  check('suffixe de niveau ignore', () => assert.equal(found('Laboratory lvl 5'), 'laboratory.png'));
  check('suffixe de niveau nu ignore', () => assert.equal(found('Laboratory 3'), 'laboratory.png'));
  check('alias respecte', () => assert.equal(found('labo'), 'laboratory.png'));
  check('nom noye dans une phrase', () => assert.equal(found('upgrading my starport tonight'), 'Starport.PNG'));
  check('nom inconnu : aucune image', () => assert.equal(found('Zorglub'), null));
  check('nom vide : aucune image', () => assert.equal(found(''), null));
  check('fichier non-image ignore', () => assert.equal(found('notes'), null));
  check('pas de faux positif sur un fragment court', () => assert.equal(found('mi'), null));

  const up = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item: ITEMS.upgrade, name: 'S-Trike', duration: 4 * 3600e3, repeat: false });
  check('la piece jointe porte le nom du fichier trouve', () =>
    assert.equal(itemImage(ITEMS.upgrade, up)?.name, 's-trike.png'));
  const unknown = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item: ITEMS.upgrade, name: 'Zorglub', duration: 4 * 3600e3, repeat: false });
  check('nom inconnu : pas de piece jointe (assets vide)', () =>
    assert.equal(itemImage(ITEMS.upgrade, unknown), null));
  check('un item sans artwork ignore le nom', () =>
    assert.equal(itemImage(ITEMS.helmet, up), null));
  store.all().forEach((t) => store.remove(t.key));
}

console.log('');
console.log('15. Emojis d application comme source d images de repli');
{
  // Emojis tels que client.application.emojis.fetch() les renvoie.
  loadEmojiArtwork(
    [
      { id: '111', name: 'starport', animated: false },
      { id: '222', name: 'wall_breaker', animated: false },
      { id: '333', name: 'helmet', animated: false },
      { id: '444', name: 'party', animated: true },
    ],
    ['helmet', 'toolcate', 'starbattery', 'wars', 'upgrade'],
  );

  const art = (name) => resolveArtwork('upgrades', name);
  check('un emoji sert d image quand aucun fichier ne correspond', () => {
    const a = art('Wall Breaker');
    assert.equal(a.kind, 'emoji');
    assert.match(a.url, /cdn\.discordapp\.com\/emojis\/222\.png/);
  });
  check('un emoji anime sort en .gif', () => assert.match(art('party').url, /444\.gif/));
  check('le fichier local prime sur l emoji', () => {
    const a = art('starport');
    assert.equal(a.kind, 'file');
  });
  check('les emojis d icone de type sont exclus de la bibliotheque', () =>
    assert.equal(art('helmet')?.kind, undefined));

  const wb = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item: ITEMS.upgrade, name: 'Wall Breaker', duration: 4 * 3600e3, repeat: false });
  const msg = startedMessage(wb, ITEMS.upgrade, 'Noe');
  check('l URL de l emoji est postee sur sa propre ligne', () => {
    const lines = msg.content.split('\n');
    assert.match(lines[lines.length - 1], /^https:\/\//);
  });
  check('aucune piece jointe dans ce cas', () => assert.deepEqual(msg.files, []));

  const st = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item: ITEMS.upgrade, name: 'S-Trike', duration: 4 * 3600e3, repeat: false });
  const fileMsg = startedMessage(st, ITEMS.upgrade, 'Noe');
  check('un fichier reste une piece jointe, pas une URL', () => {
    assert.equal(fileMsg.files.length, 1);
    assert.ok(!fileMsg.content.includes('https://'));
  });
  store.all().forEach((t) => store.remove(t.key));
}

console.log('');
console.log('16. Backend distant (Upstash) pour l hebergement');
{
  // Faux Upstash : un GET/SET REST sur une valeur en memoire.
  let stored = null;
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: stored }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      stored = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'OK' }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const backend = upstashBackend({ url, token: 'tok', key: 'gt:test' });
  await backend.init();
  check('base distante vide au demarrage', () => assert.deepEqual(backend.read(), {}));

  backend.write({ 'g:u:helmet:': { key: 'g:u:helmet:', itemId: 'helmet' } });
  check('lecture immediate depuis le cache', () =>
    assert.equal(backend.read()['g:u:helmet:'].itemId, 'helmet'));
  await new Promise((r) => setTimeout(r, 120));
  check('la valeur est bien partie sur le reseau', () =>
    assert.equal(JSON.parse(stored).timers['g:u:helmet:'].itemId, 'helmet'));
  check('la valeur voyage dans le CORPS, pas dans l URL', () => {
    const post = seen.find((r) => r.method === 'POST');
    assert.ok(post.url.length < 60, `URL de ${post.url.length} caracteres`);
  });
  check('le token est envoye en Bearer', () =>
    assert.equal(seen[0].auth, 'Bearer tok'));

  const reopened = upstashBackend({ url, token: 'tok', key: 'gt:test' });
  await reopened.init();
  check('un redemarrage relit la base distante', () =>
    assert.equal(reopened.read()['g:u:helmet:'].itemId, 'helmet'));

  // Valeurs telles qu'un copier-coller maladroit les produit.
  for (const [label, dirty] of [
    ['barre oblique finale', `${url}/`],
    ['espaces autour', `  ${url}  `],
    ['guillemets', `"${url}"`],
  ]) {
    const b = upstashBackend({ url: dirty, token: ' tok ', key: 'gt:test' });
    await b.init();
    check(`URL avec ${label} : fonctionne quand meme`, () =>
      assert.equal(b.read()['g:u:helmet:'].itemId, 'helmet'));
  }
  check('token entoure d espaces : Bearer propre', () =>
    assert.equal(seen[seen.length - 1].auth, 'Bearer tok'));

  stored = 'ceci n est pas du JSON';
  const broken = upstashBackend({ url, token: 'tok', key: 'gt:test' });
  await broken.init();
  check('une base illisible ne fait pas tomber le demarrage', () =>
    assert.deepEqual(broken.read(), {}));

  server.close();
}

console.log('');
console.log('17. Choix du backend selon l environnement');
{
  const before = { ...process.env };
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  check('sans configuration : fichier local', () =>
    assert.match(store.selectBackend().name, /^file/));
  process.env.UPSTASH_REDIS_REST_URL = 'https://exemple.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  check('avec les deux variables : backend distant', () =>
    assert.match(store.selectBackend().name, /^upstash/));
  process.env.UPSTASH_REDIS_REST_URL = 'https://exemple.upstash.io';
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  check('une seule des deux ne suffit pas : fichier local', () =>
    assert.match(store.selectBackend().name, /^file/));
  Object.assign(process.env, before);
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

console.log('');
console.log('18. Le port HTTP s ouvre AVANT la connexion a Discord');
{
  // Regression : le serveur ne demarrait qu une fois connecte a Discord, donc
  // aucun port n etait ouvert tant que la connexion n aboutissait pas, et
  // l hebergeur restait bloque sur "Deploying..." sans message d erreur.
  const port = 39117;
  const probeDb = join(ROOT, 'data', 'probe.test.json');
  rmSync(probeDb, { force: true });
  rmSync(`${probeDb}.lock`, { force: true });

  const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DISCORD_TOKEN: 'volontairement.invalide.pour.le.test',
      GALAXYTIMER_DB: probeDb,
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
    },
    stdio: 'ignore',
  });

  const poll = async (until) => {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (!res.ok) continue;
        const json = await res.json();
        if (until(json)) return json;
      } catch {
        // Pas encore en ecoute.
      }
    }
    return null;
  };

  // Le port doit repondre bien avant que la connexion Discord n aboutisse ou
  // n echoue : c est tout l interet de la correction.
  const early = await poll(() => true);
  check('le port repond sans attendre la connexion Discord', () => assert.ok(early));
  check('et annonce qu il demarre', () => assert.equal(early.status, 'starting'));

  const failed = await poll((j) => j.status !== 'starting');
  check('/health finit par expliquer pourquoi', () => assert.equal(failed?.status, 'login_failed'));
  check('et donne l erreur exacte', () => assert.match(failed.error, /token/i));

  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(probeDb, { force: true });
  rmSync(`${probeDb}.lock`, { force: true });
}

console.log('');
console.log('19. Renseignement : detection des changements');
await intel.init();
{
  const user = (level, hq, alliance = 'folk valley') => ({
    Id: '306407', Name: 'IRaXeRI', Level: level, Experience: 1,
    AllianceId: alliance, Planets: hq.map((h) => ({ OwnerId: '306407', HQLevel: h })),
  });
  const stats = (taken, done) => ({ TimesAttacked: taken, PlayersAttacked: done, StarbasesDestroyed: 230 });

  const before = intel.playerSnapshot(user(294, [9,7,7,7,6,6,6,6,5,5,5]), stats(1142, 300));
  check('un releve enregistre le premier passage', () => assert.equal(intel.recordPlayer('306407', before), true));
  check('un releve identique n est PAS re-enregistre', () =>
    assert.equal(intel.recordPlayer('306407', intel.playerSnapshot(user(294, [9,7,7,7,6,6,6,6,5,5,5]), stats(1142, 300))), false));
  check('l historique ne contient qu une entree', () => assert.equal(intel.playerHistory('306407').length, 1));

  const now = user(297, [9,7,7,7,7,6,6,6,6,5,5,5], 'studenci debile');
  const report = playerReport(now, stats(1183, 315), intel.playerHistory('306407'));
  check('detecte la montee de niveau', () => assert.match(report, /level [\+]3/));
  check('detecte la colonie gagnee', () => assert.match(report, /gained 1 planet\(s\�?\), — HQ 7|gained 1 planet/));
  check('detecte le changement d alliance', () => assert.match(report, /folk valley → studenci debile/));
  check('detecte les attaques subies', () => assert.match(report, /attacked [\+]41 times/));
  check('ne signale pas de perte de colonie', () => assert.ok(!/lost/.test(report)));

  // Piege : l API ne garantit aucun ordre des planetes. Comparer index par
  // index inventerait des changements a chaque releve.
  const shuffled = user(294, [5,7,9,6,7,5,6,7,6,5,6]);
  const same = playerReport(shuffled, stats(1142, 300), intel.playerHistory('306407'));
  check('un ordre de planetes different n invente pas de changement', () =>
    assert.ok(!/gained|lost/.test(same)));

  const shrunk = user(294, [9,7,7,6,6,6,6,5,5,5]);
  const loss = playerReport(shrunk, stats(1142, 300), intel.playerHistory('306407'));
  check('detecte une colonie perdue', () => assert.match(loss, /lost 1 planet/));

  check('sans historique, le rapport le dit', () =>
    assert.match(playerReport(now, null, []), /No history yet/));

  // Alliance
  const ally = (wp, members, inWar = true) => ({
    Id: 'folk valley', Name: 'Folk Valley', AllianceLevel: 38, WarPoints: wp,
    WarsWon: 7, WarsLost: 0, InWar: inWar, OpponentAllianceId: 'studenci debile',
    Members: members.map((n) => ({ Id: n, Name: 'P' + n, Level: 100 })),
  });
  intel.recordAlliance('folk valley', intel.allianceSnapshot(ally(400000, ['1','2','3'])));
  const ar = allianceReport(ally(435351, ['1','3','4']), intel.allianceHistory('folk valley'));
  check('detecte les warpoints gagnes', () => assert.match(ar, /war points [\+]35,351/));
  check('detecte une arrivee', () => assert.match(ar, /joined: P4/));
  check('detecte un depart', () => assert.match(ar, /left: P2/));
  const peace = allianceReport(ally(435351, ['1','3','4'], false), intel.allianceHistory('folk valley'));
  check('detecte la fin de guerre', () => assert.match(peace, /war ended/));

  // Liste de surveillance
  intel.watch(GUILD, 'player', '306407', 'IRaXeRI');
  check('la surveillance retient le joueur', () =>
    assert.equal(intel.watchList(GUILD).players[0].label, 'IRaXeRI'));
  check('surveiller deux fois ne duplique pas', () => assert.equal(intel.watch(GUILD, 'player', '306407', 'IRaXeRI'), false));
  check('un rapport tient dans un message Discord', () => assert.ok(fit('x'.repeat(5000)).length <= 1990));
}

rmSync(DB, { force: true });
rmSync(DB.replace(/\.json$/, '.intel.json'), { force: true });
rmSync(ART_ROOT, { recursive: true, force: true });
console.log(`\n${passed}/${passed} assertions passees.\n`);

console.log('\n20. Carte du balayage : lecture et fusion avec /pin');
{
  const { flatten } = await import('../src/map.js');
  // La normalisation doit etre IDENTIQUE des deux cotes : le balayage publie
  // ses cles sous cette forme, le bot les cherche sous la meme. Une
  // divergence rendrait toute la carte introuvable sans rien casser de
  // visible.
  check('normalisation insensible a la casse', () =>
    assert.equal(flatten('IRaXeRI'), flatten('iraxeri')));
  check('normalisation ignore les separateurs', () =>
    assert.equal(flatten('lil_miss-seera'), 'lilmissseera'));
  check('normalisation ignore les accents', () =>
    assert.equal(flatten('Noé'), 'noe'));
  check('pseudo vide ne casse rien', () => assert.equal(flatten(null), ''));

  // Le bot doit savoir lire le format QUE LE BALAYAGE PUBLIE REELLEMENT.
  // Sans ce controle, le bot lisait la carte avec le lecteur des timers, qui
  // attend une enveloppe {version, timers} : chaque morceau ressortait vide,
  // sans la moindre erreur, et /find repondait 'aucune colonie' sur une carte
  // pourtant bien publiee.
  const { build_shards_shape } = { build_shards_shape: null };
  const publie = { Myra: [[336, 7, null], [338, 10, 9]] };
  const relu = JSON.parse(JSON.stringify(publie));
  check('le format publie est un objet pseudo -> coordonnees', () => {
    assert.ok(!('timers' in relu), 'la carte ne porte pas d enveloppe timers');
    assert.ok(Array.isArray(relu.Myra));
  });
  check('chaque coordonnee est [x, y, qg]', () => {
    const [x, y, hq] = relu.Myra[1];
    assert.equal(x, 338); assert.equal(y, 10); assert.equal(hq, 9);
  });
}
