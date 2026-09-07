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
const { tick } = await import('../src/scheduler.js');
const { ITEMS, slugify, timerLabel } = await import('../src/items.js');
const { armTimer, definitions } = await import('../src/commands.js');
const { handleButton } = await import('../src/buttons.js');
const { timerButtons, panelRows, startedText, panelText, readyText, itemImage, completedText } = await import('../src/ui.js');
const { buildPanel } = await import('../src/commands.js');
const { helpText, descriptionText, MAX_DESCRIPTION } = await import('../src/help.js');
const { loadLibrary, loadEmojiArtwork, resolveArtwork, normalize } = await import('../src/artwork.js');
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
check('bouton Restart propose', () =>
  assert.ok(sent[0].components[0].components.some((c) => c.data.label === 'Restart')));

console.log('\n2. Timer repeat : se re-arme tout seul');
sent.length = 0;
armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, item: ITEMS.wars, duration: 50, repeat: true });
await new Promise((r) => setTimeout(r, 80));
await tick(fakeClient);
check('ping envoye', () => assert.equal(sent.length, 1));
check('timer toujours actif', () => assert.equal(store.all().length, 1));
check('re-arme dans le futur', () => assert.ok(store.all()[0].expiresAt > Date.now()));
check('pas de bouton Restart (deja re-arme)', () =>
  assert.ok(!sent[0].components[0].components.some((c) => c.data.label === 'Restart')));
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
check('le panneau ne pilote que mes timers', () => assert.equal(panel.components.length, 1));
check('le panneau porte Repeat et Stop', () =>
  assert.deepEqual(panel.components[0].toJSON().components.map((c) => c.label),
    ['Repeat: OFF', 'Stop Tool Case']));
check('le panneau est du texte brut', () => assert.equal(typeof panel.content, 'string'));
check('le panneau ne ping personne', () => assert.deepEqual(panel.allowedMentions, { parse: [] }));

let rejected = null;
await handleButton({
  customId: `gt|stop|m|${mine.key}`,
  user: { id: OTHER },
  guildId: GUILD,
  channelId: CHAN,
  reply: async (p) => { rejected = p.content; },
  update: async () => { throw new Error('ne doit pas etre appele'); },
});
check('un autre user ne peut pas stopper mon timer', () => assert.match(rejected, /isn't yours/));
check('mon timer est intact', () => assert.ok(store.get(mine.key)));

console.log('\n4b. Isolation entre serveurs');
const inB = armTimer({ guildId: GUILD_B, channelId: '666', userId: USER, item: ITEMS.toolcase, duration: 9e6, repeat: false });
check('meme user, meme item, deux serveurs = deux timers', () => assert.notEqual(inB.key, mine.key));
check('le serveur A ne voit que son timer', () => assert.equal(store.forUser(USER, GUILD).length, 1));
check('le serveur B ne voit que le sien', () => assert.equal(store.forUser(USER, GUILD_B).length, 1));
check('le timer B pingue dans le salon de B', () => assert.equal(store.get(inB.key).channelId, '666'));
store.remove(inB.key);

console.log('\n5. Bouton repeat : bascule ON/OFF');
let updated = null;
await handleButton({
  customId: `gt|repeat|m|${mine.key}`,
  user: { id: USER },
  guildId: GUILD,
  channelId: CHAN,
  update: async (p) => { updated = p; },
  followUp: async () => {},
});
check('repeat active en base', () => assert.equal(store.get(mine.key).repeat, true));
check('bouton relabellise', () =>
  assert.ok(updated.components[0].components.some((c) => c.data.label === 'Repeat: ON')));

console.log('\n6. Construction des messages et des boutons');
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
check('timerButtons', () => assert.equal(timerButtons(mine).toJSON().components.length, 2));
check('tous les boutons sont neutres (gris)', () => {
  const styles = [
    ...timerButtons(mine, { includeRestart: true }).toJSON().components,
    ...panelRows([mine], ITEMS)[0].toJSON().components,
  ].map((c) => c.style);
  // 2 = ButtonStyle.Secondary, le seul style neutre expose par Discord.
  assert.deepEqual([...new Set(styles)], [2]);
});
const fakeTimers = (n) =>
  Array.from({ length: n }, (_, i) => ({ ...mine, key: `g:u:wars:p${i}`, itemId: 'wars', name: `P${i}` }));

check('jusqu a 5 timers : une rangee chacun, Repeat + Stop', () => {
  const rows = panelRows(fakeTimers(5), ITEMS);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].toJSON().components.length, 2);
});
check('au-dela de 5 : mode compact, Stop seul, 5 par rangee', () => {
  const rows = panelRows(fakeTimers(8), ITEMS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].toJSON().components.length, 5);
  assert.equal(rows[1].toJSON().components.length, 3);
  // Le libelle porte le nom du timer : on sait lequel on arrete.
  assert.deepEqual(
    rows[0].toJSON().components.map((c) => c.label),
    ['War Bases — P0', 'War Bases — P1', 'War Bases — P2', 'War Bases — P3', 'War Bases — P4'],
  );
});
check('le mode compact pilote 25 timers, pas 5', () => {
  const rows = panelRows(fakeTimers(40), ITEMS);
  assert.equal(rows.length, 5);
  assert.equal(rows.flatMap((r) => r.toJSON().components).length, 25);
});
check('libelle de bouton tronque sous la limite Discord de 80', () => {
  const long = [{ ...mine, key: 'g:u:upgrade:x', itemId: 'upgrade', name: 'A'.repeat(200) }];
  const label = panelRows(long, ITEMS)[0].toJSON().components[1].label;
  assert.ok(label.length <= 80, `libelle de ${label.length} caracteres`);
});
check('emoji unicode en fallback sans emojis d application', () =>
  assert.match(startedText(mine, ITEMS.wars, 'Noe'), /⚔️/));
check('plus aucun type "test" dans le registre', () => assert.equal(ITEMS.test, undefined));

console.log('');
console.log('7. Le panneau se rafraichit apres un Stop au bouton');
let panelAfter = null;
await handleButton({
  customId: `gt|stop|p|${mine.key}`,
  user: { id: USER, username: 'noe' },
  guildId: GUILD,
  channelId: CHAN,
  update: async (p) => { panelAfter = p; },
  followUp: async () => {},
});
check('timer supprime', () => assert.equal(store.get(mine.key), null));
check('panneau re-rendu sans ce timer', () => assert.equal(panelAfter.components.length, 0));
check('texte du panneau redevient vide', () => assert.match(panelAfter.content, /no active timers/i));

console.log('\n8. Le message de lancement s arrete a l echeance');
store.all().forEach((t) => store.remove(t.key));
sent.length = 0; posted.clear();

// Timer simple : le message doit passer en Completed et perdre ses boutons.
const one = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item: ITEMS.starbattery, duration: 40, repeat: false });
const oneId = trackLaunch(one, ITEMS.starbattery);
check('le message de lancement affiche un decompte', () =>
  assert.match(posted.get(oneId).content, /Reset in <t:\d+:R>/));
await new Promise((r) => setTimeout(r, 70));
await tick(fakeClient);
check('le decompte a disparu', () => assert.ok(!/Reset in/.test(posted.get(oneId).content)));
check('remplace par Completed', () => assert.match(posted.get(oneId).content, /Completed — <t:\d+:f>/));
check('horodatage absolu, donc fige', () =>
  assert.ok(!/<t:\d+:R>/.test(posted.get(oneId).content)));
check('boutons retires du message termine', () =>
  assert.deepEqual(posted.get(oneId).components, []));
check('le ping garde ses boutons', () => assert.equal(sent.length, 1));

// Timer repeat : le message reste vivant sur la nouvelle echeance.
sent.length = 0;
const rep = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item: ITEMS.wars, duration: 40, repeat: true });
const repId = trackLaunch(rep, ITEMS.wars);
await new Promise((r) => setTimeout(r, 70));
await tick(fakeClient);
check('un repeat ne passe pas en Completed', () =>
  assert.ok(!/Completed/.test(posted.get(repId).content)));
check('il repart sur la nouvelle echeance', () =>
  assert.match(posted.get(repId).content, /Reset in <t:\d+:R>/));
check('et garde ses boutons', () => assert.notDeepEqual(posted.get(repId).components, []));
store.all().forEach((t) => store.remove(t.key));

// Message supprime par un moderateur : le ping doit partir quand meme.
sent.length = 0;
const gone = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item: ITEMS.helmet, duration: 40, repeat: false });
store.patch(gone.key, { messageId: 'msg-supprime' });
await new Promise((r) => setTimeout(r, 70));
await tick(fakeClient);
check('message de lancement introuvable : le ping part quand meme', () =>
  assert.equal(sent.length, 1));

check('completedText tient en 2 lignes', () =>
  assert.equal(completedText(one, ITEMS.starbattery, 'Noe').split('\n').length, 2));

console.log('\n9. Timers nommes : plusieurs du meme type en parallele');
store.all().forEach((t) => store.remove(t.key));
const arm = (item, name, ms = 9e6) => armTimer({
  guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item, name, duration: ms, repeat: false,
});

const w1 = arm(ITEMS.wars, 'Bnavic');
const w2 = arm(ITEMS.wars, 'Tino Don');
const w0 = arm(ITEMS.wars, '');
check('deux /wars nommes coexistent', () => assert.notEqual(w1.key, w2.key));
check('un /wars sans nom est un 3e timer', () => assert.equal(store.forUser(USER, GUILD).length, 3));
check('le nom est conserve tel quel', () => assert.equal(w2.name, 'Tino Don'));
check('la cle utilise le slug', () => assert.ok(w2.key.endsWith(':tino-don')));
check('relancer le meme nom remplace', () => {
  arm(ITEMS.wars, 'Bnavic');
  assert.equal(store.forUser(USER, GUILD).length, 3);
});

check('libelle wars nomme', () => assert.equal(timerLabel(w1, ITEMS.wars), 'War Bases — Bnavic'));
check('libelle wars anonyme', () => assert.equal(timerLabel(w0, ITEMS.wars), 'War Bases'));
check('le ping nomme le joueur', () => assert.match(readyText(w1, ITEMS.wars), /War Bases — Bnavic\*\* is ready!$/));

// /upgrade : le nom REMPLACE le libelle, 'Laboratory' pas 'Upgrade — Laboratory'.
const up = arm(ITEMS.upgrade, 'Laboratory', 4 * 3600e3);
check('libelle upgrade = le nom seul', () => assert.equal(timerLabel(up, ITEMS.upgrade), 'Laboratory'));
check('upgrade anonyme retombe sur Upgrade', () =>
  assert.equal(timerLabel(arm(ITEMS.upgrade, ''), ITEMS.upgrade), 'Upgrade'));
check('deux upgrades differents coexistent', () => {
  arm(ITEMS.upgrade, 'Starport', 8 * 3600e3);
  assert.equal(store.forUser(USER, GUILD).filter((t) => t.itemId === 'upgrade').length, 3);
});

check('un timer nomme n en ecrase pas un autre item', () => {
  const h = arm(ITEMS.helmet, '');
  assert.ok(store.get(h.key) && store.get(w1.key));
});
store.all().forEach((t) => store.remove(t.key));

console.log('\n10. Les commandes correspondent au registre');
const names = definitions.map((c) => c.name);
check('une commande par item, plus /timers', () =>
  assert.deepEqual(names, ['helmet', 'toolcase', 'starbattery', 'wars', 'upgrade', 'timers', 'glhelp']));
const byName = Object.fromEntries(definitions.map((c) => [c.name, c]));
check('/helmet n a aucune option', () => assert.equal((byName.helmet.options ?? []).length, 0));
check('/wars a un player optionnel', () => {
  const [opt] = byName.wars.options;
  assert.equal(opt.name, 'player');
  assert.ok(!opt.required);
});
check('/upgrade exige une duration', () => {
  const [duration, name] = byName.upgrade.options;
  assert.equal(duration.name, 'duration');
  assert.equal(duration.required, true);
  assert.equal(name.name, 'name');
  assert.ok(!name.required);
});
check('aucune commande ne depasse les 25 options Discord', () =>
  assert.ok(definitions.every((c) => (c.options ?? []).length <= 25)));
check('description de commande sous les 100 caracteres Discord', () =>
  assert.ok(definitions.every((c) => c.description.length <= 100)));

console.log('\n11. Migration des cles de l ancien format');
store.all().forEach((t) => store.remove(t.key));
{
  // Un timer ecrit par la version d avant les timers nommes.
  const legacy = `${GUILD}:${USER}:helmet`;
  writeFileSync(DB, JSON.stringify({ version: 1, timers: { [legacy]: {
    key: legacy, guildId: GUILD, channelId: CHAN, userId: USER, itemId: 'helmet',
    duration: 9e6, expiresAt: Date.now() + 9e6, repeat: false, createdAt: Date.now(),
  } } }));
  store.load();
  check('l ancienne cle est convertie', () => assert.equal(store.get(`${legacy}:`)?.itemId, 'helmet'));
  check('l ancienne cle ne subsiste pas', () => assert.equal(store.get(legacy), null));
  check('le timer reste unique', () => assert.equal(store.forUser(USER, GUILD).length, 1));
  const relaunched = armTimer({ guildId: GUILD, channelId: CHAN, userId: USER, username: 'Noe', item: ITEMS.helmet, name: '', duration: 9e6, repeat: false });
  check('relancer /helmet remplace au lieu de dupliquer', () => {
    assert.equal(relaunched.key, `${legacy}:`);
    assert.equal(store.forUser(USER, GUILD).length, 1);
  });
  store.all().forEach((t) => store.remove(t.key));
}

console.log('\n12. Un type retire du registre ne fait pas disparaitre ses timers');
store.all().forEach((t) => store.remove(t.key));
sent.length = 0;
{
  // Simule un timer lance par une version qui connaissait encore /test.
  const orphan = `${GUILD}:${USER}:test:`;
  writeFileSync(DB, JSON.stringify({ version: 1, timers: { [orphan]: {
    key: orphan, guildId: GUILD, channelId: CHAN, userId: USER, itemId: 'test',
    name: null, username: 'Noe', duration: 60000, expiresAt: Date.now() - 1000,
    repeat: false, createdAt: Date.now(),
  } } }));
  store.load();
  await tick(fakeClient);
  check('le ping part quand meme', () => assert.equal(sent.length, 1));
  check('libelle de repli lisible', () => assert.match(sent[0].content, /\*\*test\*\* is ready!$/));
  check('le timer est ensuite desarme', () => assert.equal(store.all().length, 0));
}

console.log('');
console.log('13. Aide et description, generees depuis le registre');
{
  const help = helpText();
  for (const id of ['helmet', 'toolcase', 'starbattery', 'wars', 'upgrade', 'timers']) {
    check(`/glhelp mentionne /${id}`, () => assert.ok(help.includes(`/${id}`)));
  }
  check('/glhelp tient sous les 2000 caracteres Discord', () => assert.ok(help.length <= 2000));
  check('/glhelp annonce 35h, pas 1d 11h', () => assert.ok(help.includes('35h')));
  check('/glhelp explique les timers nommes', () => assert.match(help, /several/i));

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

rmSync(DB, { force: true });
rmSync(ART_ROOT, { recursive: true, force: true });
console.log(`\n${passed}/${passed} assertions passees.\n`);
