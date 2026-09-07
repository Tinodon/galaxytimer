// Boucle d'echeance des timers.
//
// Volontairement pas de setTimeout par timer : un setTimeout de 35h ne survit
// pas a un redemarrage et derive. On stocke des dates absolues et on balaie la
// liste toutes les TICK_MS. Au demarrage, ce meme balayage rattrape d'office
// tout ce qui a expire pendant que le bot etait eteint.

import * as store from './store.js';
import { ITEMS, fallbackItem } from './items.js';
import { readyText, completedText, startedText, timerButtons } from './ui.js';

const TICK_MS = 10_000;

let timer = null;

export function start(client) {
  stop();
  // Un premier passage immediat traite les timers echus pendant la coupure.
  void tick(client);
  timer = setInterval(() => void tick(client), TICK_MS);
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick(client) {
  const now = Date.now();
  const due = store.all().filter((t) => t.expiresAt <= now);
  for (const record of due) {
    try {
      await fire(client, record, now);
    } catch (err) {
      console.error(`[scheduler] failed to ping for ${record.key}:`, err.message);
      // On desarme quand meme, sinon le timer echu repingue toutes les 10s.
      store.remove(record.key);
    }
  }
}

async function fire(client, record, now) {
  // Un item disparu du registre (type retire, id renomme) ne doit pas faire
  // sauter le ping : on sonne avec un libelle de repli.
  let item = ITEMS[record.itemId];
  if (!item) {
    console.warn(`[scheduler] unknown item ${record.itemId}, pinging with a fallback label`);
    item = fallbackItem(record);
  }

  // Re-armer AVANT d'envoyer : si l'envoi echoue (salon supprime, perms
  // retirees), l'etat sur disque reste coherent et on ne repingue pas en boucle.
  let next = null;
  if (record.repeat) {
    next = store.patch(record.key, { expiresAt: now + record.duration, firedAt: now });
  } else {
    store.remove(record.key);
  }

  const channel = await client.channels.fetch(record.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`[scheduler] channel ${record.channelId} not found, ping dropped`);
    return;
  }

  await closeLaunchMessage(channel, record, item, next);

  // Le bouton porte l'etat du timer tel qu'il sera apres le ping : re-arme si
  // repeat, sinon un timer inactif dont "Restart" repart de zero.
  const buttons = timerButtons(next ?? { ...record, repeat: false }, { includeRestart: !next });

  await channel.send({
    content: readyText(record, item),
    components: [buttons],
    allowedMentions: { users: [record.userId] },
  });
}

/**
 * Met a jour le message de lancement a l'echeance.
 *
 * Sans ca, sa ligne `Reset in <t:...:R>` continue de compter dans l'autre sens
 * ("38 seconds ago", puis "2 hours ago"...) et un timer termine a l'air encore
 * actif. C'est purement cosmetique cote client — Discord rend l'horodatage, le
 * bot ne calcule rien — mais l'affichage est faux.
 *
 * Timer termine : "Completed" en horodatage absolu, boutons retires (ceux du
 * ping prennent le relais). Timer en repeat : la ligne de reset repart sur la
 * nouvelle echeance, le message reste vivant.
 */
async function closeLaunchMessage(channel, record, item, next) {
  if (!record.messageId) return;

  const message = await channel.messages.fetch(record.messageId).catch(() => null);
  if (!message) return; // Message supprime : rien a mettre a jour.

  const username = record.username ?? 'Timer';
  const payload = next
    ? { content: startedText(next, item, username), components: [timerButtons(next)] }
    : { content: completedText(record, item, username), components: [] };

  await message.edit({ ...payload, allowedMentions: { parse: [] } }).catch((err) => {
    console.error(`[scheduler] could not update launch message ${record.messageId}:`, err.message);
  });
}
