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
import { parseDuration } from './duration.js';
import { startedText, panelText, panelRows, timerButtons, artworkFor } from './ui.js';
import { helpText } from './help.js';
import * as api from './glapi.js';
import * as intel from './intel.js';
import { playerReport, allianceReport, fit } from './intelview.js';

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
  return command.toJSON();
}

export const definitions = [
  ...ITEM_LIST.map(buildCommand),
  new SlashCommandBuilder()
    .setName('timers')
    .setDescription('Your active timers, with their Stop buttons')
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
    components: panelRows(timers, ITEMS),
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
    components: [timerButtons(record)],
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

export async function handleCommand(interaction) {
  if (interaction.commandName === 'timers') return handleTimers(interaction);
  if (interaction.commandName === 'glhelp') return handleHelp(interaction);
  if (interaction.commandName === 'scout') return handleScout(interaction);
  if (interaction.commandName === 'alliance') return handleAlliance(interaction);
  if (interaction.commandName === 'watchlist') return handleWatchlist(interaction);

  const item = ITEMS[interaction.commandName];
  if (!item) return undefined;
  return startTimer(interaction, item);
}

export { timerLabel };
