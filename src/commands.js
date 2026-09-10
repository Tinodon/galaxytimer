// Definition et execution des slash commands.
//
// Une commande par type de timer, generee depuis src/items.js : /helmet,
// /toolcase, /starbattery lancent leur duree fixe sans aucune option ; /wars
// accepte un nom de joueur ; /upgrade demande une duree et accepte un nom.
// /timers liste tout. Le reste (arreter, repeat, relancer) se fait au bouton.
//
// Aucune reponse n'est ephemere : le salon voit les timers.

import { SlashCommandBuilder } from 'discord.js';
import * as store from './store.js';
import { ITEMS, ITEM_LIST, fallbackItem, slugify, timerLabel } from './items.js';
import { formatDuration, parseDuration } from './duration.js';
import { startedText, panelText, artworkFor } from './ui.js';
import { helpText } from './help.js';
import * as api from './glapi.js';
import * as intel from './intel.js';
import { playerReport, allianceReport, fit } from './intelview.js';
import * as pins from './pins.js';
import * as map from './map.js';
import * as sql from './sql.js';
import { namedEmoji } from './emoji.js';

// Le message nomme son proprietaire mais ne doit pinger personne : seul le ping
// de fin de timer a le droit de notifier.
const NO_PING = { parse: [] };

// Discord refuse un nom d'option de plus de 100 caracteres ; on borne bien plus
// bas, un nom de joueur ou de batiment n'a aucune raison d'etre long.
const MAX_NAME_LENGTH = 60;

/** Construit la slash command d'un type de timer. */
function buildCommand(item) {
  const command = new SlashCommandBuilder()
    .setName(item.id)
    .setDescription(item.description);

  if (item.customDuration) {
    command.addStringOption((o) =>
      o
        .setName('duration')
        .setDescription('How long, e.g. 4h, 1h30, 90m, 2d')
        .setRequired(true),
    );
  }
  if (item.nameOption) {
    command.addStringOption((o) =>
      o
        .setName(item.nameOption)
        .setDescription(item.nameDescription)
        .setMaxLength(MAX_NAME_LENGTH)
        .setRequired(false),
    );
  }
  // Le repeat etait pilote par un bouton. Sans les boutons, il lui faut une
  // option : sinon un timer recurrent devient impossible a demander.
  command.addBooleanOption((o) =>
    o
      .setName('repeat')
      .setDescription('Restart this timer automatically on every reset')
      .setRequired(false),
  );
  return command.toJSON();
}

export const definitions = [
  ...ITEM_LIST.map(buildCommand),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop a timer you have running')
    .addStringOption((o) =>
      o
        .setName('timer')
        .setDescription('Which one — the list shows only yours')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('timers')
    .setDescription('Your active timers')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('scout')
    .setDescription('Intel on a player, and start tracking what changes')
    .addStringOption((o) =>
      o.setName('player').setDescription('Player name').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('alliance')
    .setDescription('Intel on an alliance, and start tracking what changes')
    .addStringOption((o) =>
      o.setName('name').setDescription('Alliance name').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('pin')
    .setDescription('Add a planet you saw in game: /pin Myra 336,7 5 (5 = HQ level)')
    // UN seul champ, rempli d'une traite : "Myra 336,7 5". Deux champs
    // obligeaient a cliquer de l'un a l'autre, ce que Noe trouvait lent.
    // Chaque /pin ajoute une planete, meme sur une case deja connue.
    .addStringOption((o) =>
      o.setName('player')
        .setDescription('Player, coordinates, HQ level if known — e.g. Myra 336,7 5')
        .setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('edit')
    .setDescription('Fix a line of /find: /edit Myra 3 delete, /edit Myra 3 336,7 5')
    .addStringOption((o) =>
      o.setName('player')
        .setDescription('Player, line number from /find, then delete / new coords / HQ')
        .setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('find')
    .setDescription('Every colony coordinate this server knows for a player')
    .addStringOption((o) =>
      o.setName('player').setDescription('Player name').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('map')
    .setDescription('Known colonies of every member of an alliance')
    .addStringOption((o) =>
      o.setName('alliance').setDescription('Alliance name').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('list')
    .setDescription('Players on the map: /list, /list 2, /list myr')
    // Un seul champ facultatif, comme /pin : une page, un bout de pseudo, ou
    // les deux ("myr 2").
    .addStringOption((o) =>
      o.setName('filter')
        .setDescription('A page number, part of a name, or both — e.g. 2, myr, myr 2')
        .setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('who')
    .setDescription('Who has a colony at these coordinates')
    .addStringOption((o) =>
      o.setName('coords').setDescription('One coordinate, e.g. 359,11').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('glhelp')
    .setDescription('How GalaxyTimer works: every command and what it does')
    .toJSON(),
];

/** Cree ou remplace le timer d'un utilisateur pour un item (et un nom) donne. */
export function armTimer({ guildId, channelId, userId, username, item, name, duration, repeat }) {
  const now = Date.now();
  const record = {
    key: store.keyOf({ guildId, userId, itemId: item.id, slug: slugify(name) }),
    guildId: guildId ?? 'dm',
    channelId,
    userId,
    // Memorise pour pouvoir re-rendre le message sans interaction, quand le
    // scheduler l'edite a l'echeance.
    username,
    itemId: item.id,
    // Nom libre affiche tel quel ; c'est son slug qui entre dans la cle.
    name: name || null,
    duration,
    expiresAt: now + duration,
    repeat: Boolean(repeat),
    createdAt: now,
  };
  return store.upsert(record);
}

/** Nom a afficher : pseudo du serveur si defini, sinon nom de compte. */
export function displayNameOf(interaction) {
  return interaction.member?.displayName ?? interaction.user.displayName ?? interaction.user.username;
}

/** Contenu du panneau /timers, reutilise a chaque rafraichissement au bouton. */
export function buildPanel(userId, guildId, username) {
  const timers = store.forUser(userId, guildId);
  return {
    content: panelText(timers, ITEMS, username),
    allowedMentions: NO_PING,
  };
}

/** Message de lancement d'un timer, image de l'item jointe si disponible. */
export function startedMessage(record, item, username) {
  const { file, url } = artworkFor(item, record);
  const text = startedText(record, item, username);
  return {
    // Une URL d'image seule sur sa ligne : Discord la deplie en apercu.
    content: url ? [text, url].join('\n') : text,
    files: file ? [file] : [],
    allowedMentions: NO_PING,
  };
}

/**
 * Repond puis retient l'id du message : a l'echeance, le scheduler l'edite pour
 * remplacer le decompte par "Completed". Sans ca, l'horodatage relatif de
 * Discord continue de compter a l'envers indefiniment.
 */
export async function replyAndTrack(interaction, record, item, username) {
  await interaction.reply(startedMessage(record, item, username));
  try {
    const message = await interaction.fetchReply();
    store.patch(record.key, { messageId: message.id });
  } catch (err) {
    // Perdre l'id n'empeche pas le ping : on perd seulement l'edition du
    // message d'origine.
    console.error('[commands] could not track the launch message:', err.message);
  }
}

/** Lance un timer depuis n'importe quelle commande de type. */
async function startTimer(interaction, item) {
  let duration = item.duration;
  if (item.customDuration) {
    const raw = interaction.options.getString('duration');
    duration = parseDuration(raw);
    if (duration === null) {
      await interaction.reply({
        content: `Could not read duration \`${raw}\`. Accepted formats: \`4h\`, \`1h30\`, \`90m\`, \`2d\`.`,
      });
      return;
    }
  }

  const name = item.nameOption
    ? (interaction.options.getString(item.nameOption) ?? '').trim()
    : '';

  const username = displayNameOf(interaction);
  const existing = store.get(
    store.keyOf({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      itemId: item.id,
      slug: slugify(name),
    }),
  );

  const record = armTimer({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    username,
    item,
    name,
    duration,
    // Relancer un timer conserve son reglage repeat.
    repeat: existing?.repeat ?? false,
  });

  await replyAndTrack(interaction, record, item, username);
}

async function handleTimers(interaction) {
  await interaction.reply(
    buildPanel(interaction.user.id, interaction.guildId, displayNameOf(interaction)),
  );
}

// Plafond par serveur : chaque entite suivie coute une requete API par releve.
// Sans limite, un serveur actif finirait par marteler une API tierce.
const MAX_WATCHED_PLAYERS = 40;
const MAX_WATCHED_ALLIANCES = 10;

async function handleScout(interaction) {
  // Un appel reseau depasse souvent les 3 secondes accordees a une reponse.
  await interaction.deferReply();
  const name = interaction.options.getString('player');

  const user = await api.getUserByName(name).catch(() => null);
  if (!user) {
    await interaction.editReply(`No player found for \`${name}\`.`);
    return;
  }

  const stats = await api.getUserStats(user.Id).catch(() => null);
  const history = intel.playerHistory(user.Id);

  // Scouter, c'est commencer a suivre : l'historique se construit tout seul.
  const list = intel.watchList(interaction.guildId);
  if (list.players.length < MAX_WATCHED_PLAYERS) {
    intel.watch(interaction.guildId, 'player', user.Id, user.Name);
  }
  intel.recordPlayer(user.Id, intel.playerSnapshot(user, stats));

  await interaction.editReply({
    content: fit(playerReport(user, stats, history)),
    allowedMentions: NO_PING,
  });
}

async function handleAlliance(interaction) {
  await interaction.deferReply();
  const name = interaction.options.getString('name');

  const alliance = await api.getAlliance(name).catch(() => null);
  if (!alliance) {
    await interaction.editReply(`No alliance found for \`${name}\`.`);
    return;
  }

  const id = String(alliance.Id).toLowerCase();
  const history = intel.allianceHistory(id);

  const list = intel.watchList(interaction.guildId);
  if (list.alliances.length < MAX_WATCHED_ALLIANCES) {
    intel.watch(interaction.guildId, 'alliance', id, alliance.Name);
  }
  intel.recordAlliance(id, intel.allianceSnapshot(alliance));

  await interaction.editReply({
    content: fit(allianceReport(alliance, history)),
    allowedMentions: NO_PING,
  });
}

/**
 * Morceaux optionnels d'une ligne, joints par " · ".
 *
 * Une information absente n'apparait PAS : ni "HQ ?", ni "NaN", ni "null".
 * Noe l'a demande explicitement — un QG pas encore lu n'est pas une donnee a
 * afficher.
 */
const extras = (...parts) => parts.filter((p) => p !== null && p !== undefined && p !== '').join(' · ');

/**
 * Niveau de QG : l'emoji starbase puis le niveau (demande de Noe), ou "HQ 5"
 * tant que l'emoji n'est pas ajoute a l'application. Rien si le QG est inconnu.
 */
const hqLabel = (hq) => (Number.isFinite(hq) ? `${namedEmoji('starbase')} ${hq}` : '');

// Espace "chiffre" (U+2007) : il a la largeur d'un chiffre. Mis APRES le bloc
// gris, il compense les chiffres qui manquent a une coordonnee courte, pour
// que les emojis de QG tombent en colonne. Un espace ordinaire est bien plus
// etroit qu'un chiffre : le decalage resterait visible.
const FIGURE_SPACE = ' ';

const coordText = (spot) => `${spot.x},${spot.y}`;

/**
 * "`336,7`  <starbase> 5" — coordonnees dans un bloc gris SERRE (pas d'espace
 * dedans : Noe l'a demande), puis le QG aligne sur la plus longue coordonnee
 * de la liste (`width`). Ni numero de ligne ni marque de pin : Noe trouvait
 * ca moche. Rien apres le bloc si le QG est inconnu.
 */
function spotLine(spot, width = coordText(spot).length) {
  const hq = hqLabel(spot.hq);
  if (!hq) return `\`${coordText(spot)}\``;
  const pad = FIGURE_SPACE.repeat(Math.max(0, width - coordText(spot).length));
  return `\`${coordText(spot)}\`${pad} ${hq}`;
}

/**
 * Une ligne par planete, QG en colonne. L'ordre est celui de la base (x, y,
 * puis numero dans le systeme) : c'est aussi celui que /edit utilise, la
 * premiere ligne est la ligne 1.
 */
function planetLines(planets) {
  const width = Math.max(0, ...planets.map((spot) => coordText(spot).length));
  return planets.map((spot) => spotLine(spot, width));
}

/**
 * Plusieurs planetes d'un joueur sur la meme case, regroupees pour une liste
 * sur une ligne (/map) : "`102,0`×6 <starbase> 5·3".
 */
function groupedSpots(planets) {
  const groups = new Map();
  for (const spot of planets) {
    const key = coordText(spot);
    const group = groups.get(key) ?? { key, count: 0, hqs: [] };
    group.count += 1;
    if (Number.isFinite(spot.hq)) group.hqs.push(spot.hq);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => [
    `\`${g.key}\`${g.count > 1 ? `×${g.count}` : ''}`,
    g.hqs.length ? `${namedEmoji('starbase')} ${g.hqs.join('·')}` : '',
  ].filter(Boolean).join(' '));
}

/** Repond proprement quand la base de la carte n'est pas configuree. */
async function requireMap(interaction) {
  if (sql.configured()) return true;
  await interaction.editReply('The map database is not configured on this bot yet.');
  return false;
}

/** Fiche joueur transmise a la base : l'API fait foi pour le pseudo et l'alliance. */
const playerRecord = (user) => ({
  id: user.Id,
  name: user.Name,
  alliance: user.AllianceId ?? null,
  level: user.Level ?? null,
  planets: user.Planets?.length ?? 0,
});

async function handlePin(interaction) {
  await interaction.deferReply();
  const { name, entries, error } = pins.parsePinInput(interaction.options.getString('player'));
  if (error) {
    await interaction.editReply(error);
    return;
  }
  if (!(await requireMap(interaction))) return;

  // On resout le joueur via l'API : la planete est ainsi rattachee a un id
  // stable, meme si la personne change de pseudo.
  const user = await api.getUserByName(name).catch(() => null);
  if (!user) {
    await interaction.editReply(`No player found for \`${name}\`.`);
    return;
  }

  const owned = user.Planets?.length ?? 0;
  const result = await map.pin(playerRecord(user), entries, displayNameOf(interaction));

  const lines = [
    `**${user.Name}** — **${result.added}** planet(s) added: ${entries.map((e) => spotLine(e)).join(' ')}`,
    `${result.total} planet(s) recorded out of **${owned}** they own. ` +
      `\`/find ${user.Name}\` numbers them for \`/edit\`.`,
  ];
  // Plus de planetes que le joueur n'en possede : l'une d'elles est fausse.
  if (result.total > (owned || map.MAX_COLONIES)) {
    lines.push(`⚠️ That is more than they own — fix the wrong one with \`/edit ${user.Name} <line> delete\`.`);
  }

  await interaction.editReply({ content: lines.join('\n'), allowedMentions: NO_PING });
}

/** /edit : corrige une ligne de /find, designee par son numero. */
async function handleEdit(interaction) {
  await interaction.deferReply();
  const { name, line, change, error } = pins.parseEditInput(interaction.options.getString('player'));
  if (error) {
    await interaction.editReply(error);
    return;
  }
  if (!(await requireMap(interaction))) return;

  const user = await api.getUserByName(name).catch(() => null);
  if (!user) {
    await interaction.editReply(`No player found for \`${name}\`.`);
    return;
  }

  const result = await map.editLine(user.Id, line, change, displayNameOf(interaction));
  if (result.error === 'no-line') {
    await interaction.editReply(result.count
      ? `**${user.Name}** has no line ${line} — \`/find ${user.Name}\` shows ${result.count}.`
      : `**${user.Name}** has no mapped planet yet.`);
    return;
  }

  const was = spotLine(result.before);
  const what = change.remove
    ? `line ${line} (${was}) deleted.`
    : `line ${line} was ${was}, now ${spotLine({
      x: change.coords?.x ?? result.before.x,
      y: change.coords?.y ?? result.before.y,
      hq: change.hq ?? result.before.hq,
      pinned: true,
    })}.`;

  // La liste renumerotee : apres une suppression, les numeros suivants
  // descendent d'un cran ; mieux vaut les montrer que les laisser deviner.
  const lines = [
    `**${user.Name}** — ${what}`,
    '',
    ...(result.planets.length ? planetLines(result.planets) : ['No mapped planet left.']),
  ];
  await interaction.editReply({ content: fit(lines.join('\n')), allowedMentions: NO_PING });
}

async function handleFind(interaction) {
  await interaction.deferReply();
  const name = interaction.options.getString('player');

  const user = await api.getUserByName(name).catch(() => null);
  if (!user) {
    await interaction.editReply(`No player found for \`${name}\`.`);
    return;
  }

  const owned = user.Planets?.length ?? 0;

  // Une seule source : la base, releve et pins confondus. Une ligne par
  // planete, numerotee : ce sont les numeros qu'attend /edit.
  if (!(await requireMap(interaction))) return;
  const found = await map.coloniesOf(user.Id);

  if (!found.length) {
    await interaction.editReply(
      `**${user.Name}** owns **${owned}** colonies. None mapped yet — ` +
      `record what you see with \`/pin\`.`,
    );
    return;
  }

  const lines = [
    `**${user.Name}** — ${extras(`level ${user.Level}`, user.AllianceId ?? 'no alliance')}`,
    `**${found.length}/${owned}** colonies mapped`,
    '',
    ...planetLines(found),
  ];

  await interaction.editReply({ content: fit(lines.join('\n')), allowedMentions: NO_PING });
}

async function handleMap(interaction) {
  await interaction.deferReply();
  const name = interaction.options.getString('alliance');

  const alliance = await api.getAlliance(name).catch(() => null);
  if (!alliance) {
    await interaction.editReply(`No alliance found for \`${name}\`.`);
    return;
  }

  const members = alliance.Members ?? [];
  if (!(await requireMap(interaction))) return;

  // La liste des membres vient de l'API (toujours a jour), leurs colonies de
  // la base, en UNE requete pour toute l'alliance. Un membre sans colonie
  // connue n'apparait pas plutot que d'apparaitre vide.
  const colonies = await map.coloniesOfMany(members.map((m) => m.Id));
  const rows = [];
  let mapped = 0;

  for (const member of members) {
    const spots = colonies.get(Number(member.Id)) ?? [];
    if (!spots.length) continue;

    mapped += spots.length;
    // Meme format que /find ; les blocs gris separent deja les colonies.
    const list = groupedSpots(spots).join(' ');
    rows.push(`**${member.Name}** (lvl ${member.Level}) — ${list}`);
  }

  if (!rows.length) {
    await interaction.editReply(
      `**${alliance.Name}** — ${members.length} members, none of them mapped yet.
` +
      'They may sit outside the scanned area, or their names were unreadable.',
    );
    return;
  }

  await interaction.editReply({
    content: fit([
      `**${alliance.Name}** — ${mapped} colonies across ${rows.length}/${members.length} member(s)`,
      alliance.InWar ? `**AT WAR** against ${alliance.OpponentAllianceId}` : '',
      '',
      ...rows,
    ].filter(Boolean).join('\n')),
    allowedMentions: NO_PING,
  });
}


// 50 joueurs par page : les pseudos font 18 caracteres au plus, une page
// tient donc toujours sous les 2000 caracteres d'un message Discord.
const LIST_PAGE_SIZE = 50;

/** "myr 2" -> { search: 'myr', page: 2 } ; "3" -> page 3 ; "" -> tout, page 1. */
export function parseListInput(input) {
  const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
  let page = 1;
  if (tokens.length && /^\d+$/.test(tokens[tokens.length - 1])) {
    page = Math.max(1, Number(tokens.pop()));
  }
  return { search: tokens.join(' '), page };
}

/** Les joueurs de la carte, pour verifier ce que la base contient et copier un pseudo vers /find. */
async function handleList(interaction) {
  await interaction.deferReply();
  if (!(await requireMap(interaction))) return;

  const { search, page } = parseListInput(interaction.options.getString('filter'));
  const result = await map.listPlayers({ search, page, pageSize: LIST_PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(result.total / LIST_PAGE_SIZE));

  if (!result.total) {
    await interaction.editReply(search
      ? `No mapped player matches \`${search.replace(/`/g, '')}\`.`
      : 'The map is empty.');
    return;
  }
  if (!result.rows.length) {
    await interaction.editReply(`Page ${page} does not exist — there are ${pages}.`);
    return;
  }

  // "`Myra` 4/5" : colonies connues / planetes selon l'API. ⚠️ quand il y a
  // plus de colonies que de planetes : au moins une attribution est fausse.
  const entry = (r) => {
    const name = `\`${String(r.name).replace(/`/g, '')}\``;
    if (!Number.isFinite(r.planets) || r.planets <= 0) return `${name} ${r.known}`;
    const warn = r.known > r.planets ? ' ⚠️' : '';
    return `${name} ${r.known}/${r.planets}${warn}`;
  };

  const next = page < pages
    ? ` — next: \`/list ${search ? `${search.replace(/`/g, '')} ` : ''}${page + 1}\``
    : '';
  const lines = [
    `**${result.total}** player(s) on the map${search ? ` matching \`${search.replace(/`/g, '')}\`` : ''}` +
      ` · ${result.colonies} colonies · page ${page}/${pages}${next}`,
    'known colonies / planets they own',
    '',
    result.rows.map(entry).join(' · '),
  ];
  await interaction.editReply({ content: fit(lines.join('\n')), allowedMentions: NO_PING });
}

/** Qui a une colonie sur cette case. La recherche que la carte par pseudo ne permettait pas. */
async function handleWho(interaction) {
  await interaction.deferReply();
  const { coords, error } = pins.parseCoords(interaction.options.getString('coords'));
  if (error) {
    await interaction.editReply(error);
    return;
  }
  if (coords.length !== 1) {
    await interaction.editReply('Give one coordinate at a time, e.g. `359,11`.');
    return;
  }
  if (!(await requireMap(interaction))) return;

  const [{ x, y }] = coords;
  const found = await map.whoAt(x, y);
  if (!found.length) {
    await interaction.editReply(
      `Nobody known at **${x},${y}** — not scanned yet, or only free planets there.`,
    );
    return;
  }

  const system = found.find((f) => f.system)?.system;
  const lines = [
    `**${system ? `${system} ` : ''}(${x},${y})** — ${found.length} player(s)`,
    '',
    // Un joueur par ligne ; plusieurs planetes a lui sur cette case : "×6".
    ...found.map((f) => {
      const more = extras(
        f.alliance,
        Number.isFinite(f.level) ? `lvl ${f.level}` : '',
        f.hqs.length ? `${namedEmoji('starbase')} ${f.hqs.join('·')}` : '',
      );
      const name = `**${f.name}**${f.count > 1 ? ` ×${f.count}` : ''}`;
      return more ? `${name} · ${more}` : name;
    }),
  ];
  await interaction.editReply({ content: fit(lines.join('\n')), allowedMentions: NO_PING });
}

async function handleHelp(interaction) {
  await interaction.reply({ content: helpText(), allowedMentions: NO_PING });
}

/** Arrete un timer. Remplace le bouton Stop, retire a la demande de Noe. */
async function handleStop(interaction) {
  const choice = interaction.options.getString('timer');
  const mine = store.forUser(interaction.user.id, interaction.guildId);

  if (choice === '__all__') {
    mine.forEach((t) => store.remove(t.key));
    await interaction.reply({
      content: mine.length
        ? `**${displayNameOf(interaction)}** stopped ${mine.length} timer(s).`
        : 'You had no timers running.',
      allowedMentions: NO_PING,
    });
    return;
  }

  const timer = mine.find((t) => t.key === choice);
  if (!timer) {
    await interaction.reply({
      content: 'No such timer running. `/timers` lists yours.',
      allowedMentions: NO_PING,
    });
    return;
  }

  store.remove(timer.key);
  // Un type retire du registre ne doit pas empecher d'arreter un timer en cours
  // (meme regle que le scheduler) : on lui donne un libelle de repli.
  const item = ITEMS[timer.itemId] ?? fallbackItem(timer);
  await interaction.reply({
    content: `**${displayNameOf(interaction)}** stopped ${timerLabel(timer, item)}.`,
    allowedMentions: NO_PING,
  });
}

/**
 * Choix proposes pour /stop : uniquement les timers de celui qui tape, avec le
 * temps restant. On ne fait pas saisir un nom d'item a la main — c'etait le
 * defaut que les boutons evitaient, et il ne doit pas revenir avec eux.
 */
export async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'stop') {
    await interaction.respond([]);
    return;
  }

  const typed = (interaction.options.getFocused() ?? '').toLowerCase();
  const mine = store.forUser(interaction.user.id, interaction.guildId);

  const choices = mine.map((timer) => {
    const item = ITEMS[timer.itemId] ?? fallbackItem(timer);
    const left = formatDuration(timer.expiresAt - Date.now());
    return {
      name: `${timerLabel(timer, item)} — ${left} left${timer.repeat ? ' (repeat)' : ''}`,
      value: timer.key,
    };
  });

  if (mine.length > 1) {
    choices.unshift({ name: `Stop all ${mine.length} timers`, value: '__all__' });
  }

  await interaction.respond(
    choices.filter((c) => c.name.toLowerCase().includes(typed)).slice(0, 25),
  );
}

export async function handleCommand(interaction) {
  if (interaction.commandName === 'timers') return handleTimers(interaction);
  if (interaction.commandName === 'stop') return handleStop(interaction);
  if (interaction.commandName === 'glhelp') return handleHelp(interaction);
  if (interaction.commandName === 'scout') return handleScout(interaction);
  if (interaction.commandName === 'alliance') return handleAlliance(interaction);
  if (interaction.commandName === 'pin') return handlePin(interaction);
  if (interaction.commandName === 'find') return handleFind(interaction);
  if (interaction.commandName === 'map') return handleMap(interaction);
  if (interaction.commandName === 'who') return handleWho(interaction);
  if (interaction.commandName === 'list') return handleList(interaction);
  if (interaction.commandName === 'edit') return handleEdit(interaction);

  const item = ITEMS[interaction.commandName];
  if (!item) return undefined;
  return startTimer(interaction, item);
}

export { timerLabel };
