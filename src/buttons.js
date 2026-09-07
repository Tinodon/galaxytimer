// Gestion des clics sur les boutons Restart / Repeat / Stop.
//
// Un bouton vient soit du message d'un timer (source 'm'), soit du panneau
// /timers (source 'p'). Dans les deux cas on modifie le message existant plutot
// que d'en envoyer un nouveau : pas de confirmation qui s'empile.

import * as store from './store.js';
import { ITEMS } from './items.js';
import { parseButtonId, timerButtons, startedText } from './ui.js';
import { armTimer, buildPanel, displayNameOf, replyAndTrack } from './commands.js';

const EPHEMERAL = 64;
const NO_PING = { parse: [] };

// Cle : `serveur:user:item:slug`.
function ownerOf(key) {
  return key.split(':')[1];
}

function itemOf(key) {
  return ITEMS[key.split(':')[2]] ?? null;
}

/**
 * Le slug de la cle, faute de mieux, comme nom au redemarrage.
 *
 * On perd la casse et les accents ("Tino Don" revient en "tino-don") : c'est le
 * prix d'un bouton qui survit a la disparition du timer en base. Un slug lisible
 * vaut mieux qu'un timer relance sans nom du tout.
 */
function nameFromKey(key) {
  const slug = key.split(':')[3] ?? '';
  return slug || '';
}

export async function handleButton(interaction) {
  const parsed = parseButtonId(interaction.customId);
  if (!parsed) return;
  const { action, source, key } = parsed;

  // Le bot est multi-utilisateur : chacun ne pilote que ses propres timers.
  // Seul refus qui reste ephemere — inutile de polluer le salon avec ca.
  if (ownerOf(key) !== interaction.user.id) {
    await interaction.reply({
      content: "That timer isn't yours. Start your own with `/timer`.",
      flags: EPHEMERAL,
    });
    return;
  }

  const item = itemOf(key);
  if (!item) {
    await interaction.reply({ content: 'Unknown item for this timer.', flags: EPHEMERAL });
    return;
  }

  if (action === 'stop') return doStop(interaction, key, item, source);
  if (action === 'repeat') return doRepeat(interaction, key, item, source);
  if (action === 'restart') return doRestart(interaction, key, item);
}

/** Re-rend le panneau /timers apres une action lancee depuis celui-ci. */
function refreshPanel(interaction) {
  return interaction.update(
    buildPanel(interaction.user.id, interaction.guildId, displayNameOf(interaction)),
  );
}

async function doStop(interaction, key, item, source) {
  store.remove(key);

  if (source === 'p') {
    await refreshPanel(interaction);
    return;
  }
  // Message de timer : on remplace le texte et on retire les boutons, il n'y a
  // plus rien a piloter dessus.
  await interaction.update({
    content: `**${displayNameOf(interaction)}** **${item.label}** timer stopped.`,
    components: [],
    allowedMentions: NO_PING,
  });
}

async function doRepeat(interaction, key, item, source) {
  const current = store.get(key);
  if (!current) {
    await interaction.reply({
      content: `No active timer for **${item.label}** — start it again with \`/timer\`.`,
      flags: EPHEMERAL,
    });
    return;
  }

  const next = store.patch(key, { repeat: !current.repeat });
  if (source === 'p') {
    await refreshPanel(interaction);
    return;
  }
  // Seul le libelle du bouton change : le texte ne mentionne plus le repeat.
  await interaction.update({ components: [timerButtons(next)] });
}

async function doRestart(interaction, key, item) {
  // Apres un ping sans repeat, le timer n'est plus en base : on retombe alors
  // sur la duree par defaut de l'item.
  const previous = store.get(key);
  const username = displayNameOf(interaction);
  const record = armTimer({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    username,
    item,
    // Le nom fait partie de la cle : le relire dessus le preserve au redemarrage.
    name: nameFromKey(key),
    duration: previous?.duration ?? item.duration,
    repeat: previous?.repeat ?? false,
  });
  await replyAndTrack(interaction, record, item, username);
}
