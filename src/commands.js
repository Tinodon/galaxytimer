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
import { ITEMS, ITEM_LIST, slugify, timerLabel } from './items.js';
import { formatDuration, parseDuration } from './duration.js';
import { startedText, panelText, artworkFor } from './ui.js';
import { helpText } from './help.js';
import * as api from './glapi.js';
import * as intel from './intel.js';
import { playerReport, allianceReport, fit } from './intelview.js';
import * as pins from './pins.js';
import { discordRelative } from './duration.js';

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
    .setDescription('Record colony coordinates you saw in game')
    .addStringOption((o) =>
      o.setName('player').setDescription('Whose colonies').setRequired(true))
    .addStringOption((o) =>
      o.setName('coords')
        .setDescription('One or more pairs, e.g. 512,340 601,299')
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
    .setName('watchlist')
    .setDescription('Who this server is tracking')
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

/** Ligne "(512,340) — par X, il y a 2 jours". */
const pinLine = (c) => `\`(${String(c.x).padStart(4)},${String(c.y).padStart(4)})\` — ${c.by}, ${discordRelative(c.at)}`;

async function handlePin(interaction) {
  await interaction.deferReply();
  const name = interaction.options.getString('player');
  const { coords, error } = pins.parseCoords(interaction.options.getString('coords'));
  if (error) {
    await interaction.editReply(error);
    return;
  }

  // On resout le joueur via l'API : le releve est ainsi rattache a un id
  // stable, meme si la personne change de pseudo.
  const user = await api.getUserByName(name).catch(() => null);
  if (!user) {
    await interaction.editReply(`No player found for \`${name}\`.`);
    return;
  }

  const result = pins.pin(
    interaction.guildId,
    { id: user.Id, name: user.Name },
    coords,
    displayNameOf(interaction),
  );

  const known = user.Planets?.length ?? 0;
  const parts = [];
  if (result.added) parts.push(`**${result.added}** new`);
  if (result.updated) parts.push(`${result.updated} already known`);

  await interaction.editReply({
    content: [
      `**${user.Name}** — ${parts.join(', ')}.`,
      `${result.total} coordinate(s) recorded out of **${known}** colonies he owns.`,
    ].join('\n'),
    allowedMentions: NO_PING,
  });
}

async function handleFind(interaction) {
  await interaction.deferReply();
  const name = interaction.options.getString('player');

  const user = await api.getUserByName(name).catch(() => null);
  if (!user) {
    await interaction.editReply(`No player found for \`${name}\`.`);
    return;
  }

  const entry = pins.forPlayer(interaction.guildId, user.Id);
  const owned = user.Planets?.length ?? 0;
  if (!entry?.coords.length) {
    await interaction.editReply(
      `**${user.Name}** owns **${owned}** colonies. None mapped yet — ` +
      `record what you see with \`/pin\`.`,
    );
    return;
  }

  const lines = [
    `**${user.Name}** — level ${user.Level} · ${user.AllianceId ?? 'no alliance'}`,
    `**${entry.coords.length}/${owned}** colonies mapped`,
    '',
    ...entry.coords.map(pinLine),
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

  const known = pins.all(interaction.guildId);
  const rows = [];
  let mapped = 0;

  for (const member of alliance.Members ?? []) {
    const entry = known[String(member.Id)];
    if (!entry?.coords.length) continue;
    mapped += entry.coords.length;
    rows.push(
      `**${member.Name}** (lvl ${member.Level}) — ` +
      entry.coords.map((c) => `\`${c.x},${c.y}\``).join(' '),
    );
  }

  if (!rows.length) {
    await interaction.editReply(
      `**${alliance.Name}** — ${alliance.Members?.length ?? 0} members, nothing mapped yet.
` +
      'Start with `/pin player:<name> coords:<x,y ...>`.',
    );
    return;
  }

  await interaction.editReply({
    content: fit([
      `**${alliance.Name}** — ${mapped} colonies mapped across ${rows.length} member(s)`,
      alliance.InWar ? `**AT WAR** against ${alliance.OpponentAllianceId}` : '',
      '',
      ...rows,
    ].filter(Boolean).join('\n')),
    allowedMentions: NO_PING,
  });
}

async function handleWatchlist(interaction) {
  const { players, alliances } = intel.watchList(interaction.guildId);
  if (!players.length && !alliances.length) {
    await interaction.reply('Nothing tracked yet. Use `/scout` or `/alliance` to start.');
    return;
  }

  const lines = [`**Tracked by this server**`];
  if (players.length) {
    lines.push(`Players (${players.length}/${MAX_WATCHED_PLAYERS}): ` +
      players.map((p) => p.label).join(', '));
  }
  if (alliances.length) {
    lines.push(`Alliances (${alliances.length}/${MAX_WATCHED_ALLIANCES}): ` +
      alliances.map((a) => a.label).join(', '));
  }
  lines.push('', '_Snapshots are taken hourly. Only changes are stored._');
  await interaction.reply({ content: fit(lines.join('\n')), allowedMentions: NO_PING });
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
  const item = ITEMS[timer.itemId];
  await interaction.reply({
    content: `**${displayNameOf(interaction)}** stopped ${timerLabel(item, timer.name)}.`,
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
    const item = ITEMS[timer.itemId];
    const left = formatDuration(timer.expiresAt - Date.now());
    return {
      name: `${timerLabel(item, timer.name)} — ${left} left${timer.repeat ? ' (repeat)' : ''}`,
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
  if (interaction.commandName === 'watchlist') return handleWatchlist(interaction);
  if (interaction.commandName === 'pin') return handlePin(interaction);
  if (interaction.commandName === 'find') return handleFind(interaction);
  if (interaction.commandName === 'map') return handleMap(interaction);

  const item = ITEMS[interaction.commandName];
  if (!item) return undefined;
  return startTimer(interaction, item);
}

export { timerLabel };
