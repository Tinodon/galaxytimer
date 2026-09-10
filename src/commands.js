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
    .setDescription('Record colonies you saw in game: /pin Myra 351,10')
    // UN seul champ, rempli d'une traite : "Myra 351,10 352,11". Deux champs
    // obligeaient a cliquer de l'un a l'autre, ce que Noe trouvait lent.
    .addStringOption((o) =>
      o.setName('player')
        .setDescription('Player, then coordinates — e.g. Myra 351,10 352,11')
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

const hqLabel = (hq) => (Number.isFinite(hq) ? `HQ ${hq}` : '');

// Colonie saisie a la main avec /pin. Un emoji plutot qu'un mot : demande de
// Noe, ca se repere d'un coup d'oeil dans une liste.
const PIN_MARK = '📌';

/**
 * "336,7 · HQ 5 📌" — en texte simple, sans bloc de code (Noe ne veut pas
 * de "container" gris). Rien apres les coordonnees si rien n'est connu.
 */
function spotLine(spot) {
  const coords = `${spot.x},${spot.y}`;
  const hq = hqLabel(spot.hq);
  return [hq ? `${coords} · ${hq}` : coords, spot.pinned ? PIN_MARK : ''].filter(Boolean).join(' ');
}

/** Repond proprement quand la base de la carte n'est pas configuree. */
async function requireMap(interaction) {
  if (sql.configured()) return true;
  await interaction.editReply('The map database is not configured on this bot yet.');
  return false;
}

async function handlePin(interaction) {
  await interaction.deferReply();
  const { name, coords, error } = pins.parsePinInput(interaction.options.getString('player'));
  if (error) {
    await interaction.editReply(error);
    return;
  }
  if (!(await requireMap(interaction))) return;

  // On resout le joueur via l'API : le releve est ainsi rattache a un id
  // stable, meme si la personne change de pseudo.
  const user = await api.getUserByName(name).catch(() => null);
  if (!user) {
    await interaction.editReply(`No player found for \`${name}\`.`);
    return;
  }

  const known = user.Planets?.length ?? 0;
  const result = await map.pin(
    {
      id: user.Id,
      name: user.Name,
      alliance: user.AllianceId ?? null,
      level: user.Level ?? null,
      planets: known,
    },
    coords,
    displayNameOf(interaction),
  );

  const parts = [];
  if (result.added) parts.push(`**${result.added}** new`);
  if (result.updated) parts.push(`${result.updated} already known`);

  const lines = [
    `**${user.Name}** — ${parts.join(', ')}.`,
    `${result.total} coordinate(s) recorded out of **${known}** colonies they own.`,
  ];
  // Plus de coordonnees que de planetes : l'une d'elles est forcement fausse.
  if (result.total > (known || map.MAX_COLONIES)) {
    lines.push('That is more than they can own — one of these coordinates is probably wrong.');
  }

  await interaction.editReply({ content: lines.join('\n'), allowedMentions: NO_PING });
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

  // Une seule source : la base. Releve et pins y sont deja fusionnes, le pin
  // l'emportant sur une meme coordonnee (voir scout/publish_sql.py).
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
    ...found.map(spotLine),
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
    // Meme format que /find, sans bloc de code ; " | " separe les colonies,
    // la virgule appartenant deja aux coordonnees.
    const list = spots.map(spotLine).join(' | ');
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
    ...found.map((f) => {
      const more = extras(
        f.alliance,
        Number.isFinite(f.level) ? `lvl ${f.level}` : '',
        hqLabel(f.hq),
      );
      const line = more ? `**${f.name}** · ${more}` : `**${f.name}**`;
      return f.pinned ? `${line} ${PIN_MARK}` : line;
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

  const item = ITEMS[interaction.commandName];
  if (!item) return undefined;
  return startTimer(interaction, item);
}

export { timerLabel };
