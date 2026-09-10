// Commandes texte : "!find myra", "!pin myra 336,7 5", tapees librement.
//
// Pourquoi, en plus des commandes slash : une commande "/" qui recoit du texte
// a forcement un champ, et Discord affiche son nom ("player:") — Noe trouvait
// ca lent et genant. Un message qui commence par "!" s'ecrit d'une traite,
// sans aucune fenetre. Les commandes slash restent : ce sont elles qui
// remplissent la section "Commands" du profil du bot.
//
// Aucun gestionnaire n'est duplique : un message est habille en fausse
// interaction et passe par handleCommand, exactement comme une commande "/".
//
// Lire le texte des messages demande l'intent privilegie "Message Content",
// active a la main dans le portail developpeur. Sans lui, Discord refuse la
// connexion du bot : index.js ne le demande donc que s'il est active (voir
// messageContentAllowed).

import { definitions } from './commands.js';
import * as store from './store.js';
import { ITEMS, timerLabel } from './items.js';

export const PREFIX = '!';

// Drapeaux d'application qui signalent l'intent "Message Content" : le premier
// pour un bot verifie, le second (interrupteur du portail) pour un bot de moins
// de 100 serveurs.
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

/** L'intent "Message Content" est-il active pour cette application ? */
export function messageContentEnabled(applicationFlags) {
  const flags = Number(applicationFlags ?? 0);
  return Boolean(flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED));
}

/** "!find myra" -> { name: 'find', rest: 'myra' } ; null si ce n'est pas pour nous. */
export function parseMessage(content) {
  const text = String(content ?? '').trim();
  if (!text.startsWith(PREFIX)) return null;
  const match = text.slice(PREFIX.length).match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  // Seules nos commandes : "!" est aussi le prefixe d'autres bots.
  if (!definitions.some((d) => d.name === name)) return null;
  return { name, rest: match[2].trim() };
}

/**
 * Traduit le texte libre en valeurs d'options, d'apres la definition de la
 * commande slash du meme nom :
 *   - "repeat" en dernier mot active l'option repeat des timers ;
 *   - une seule option texte recoit tout le reste ("!find Myra");
 *   - plusieurs : un mot chacune, la derniere prend le reste
 *     ("!upgrade 2h Barracks" -> duration=2h, name=Barracks).
 */
export function optionsFor(name, rest, userTimers = []) {
  const definition = definitions.find((d) => d.name === name);
  const declared = definition?.options ?? [];
  const values = {};
  let words = rest ? rest.split(/\s+/) : [];

  if (declared.some((o) => o.name === 'repeat') && words.at(-1)?.toLowerCase() === 'repeat') {
    values.repeat = true;
    words = words.slice(0, -1);
  }

  // /stop attend une cle interne, fournie par l'autocompletion. En texte, on
  // la retrouve depuis ce que la personne ecrit : "!stop helmet", "!stop all".
  if (name === 'stop') {
    values.timer = resolveTimer(words.join(' '), userTimers);
    return values;
  }

  // Type 3 = option texte dans l'API Discord.
  const strings = declared.filter((o) => o.type === 3);
  strings.forEach((option, i) => {
    const last = i === strings.length - 1;
    const value = last ? words.slice(i).join(' ') : words[i];
    if (value) values[option.name] = value;
  });
  return values;
}

/** "helmet", "wars john", "all" -> cle du timer vise parmi ceux de la personne. */
function resolveTimer(text, timers) {
  const wanted = text.trim().toLowerCase();
  if (wanted === 'all') return '__all__';
  if (!wanted) return timers.length === 1 ? timers[0].key : null;
  const label = (t) => timerLabel(t, ITEMS[t.itemId] ?? { label: t.itemId }).toLowerCase();
  const exact = timers.find((t) => t.itemId === wanted || label(t) === wanted);
  if (exact) return exact.key;
  const partial = timers.filter((t) => label(t).includes(wanted) || t.itemId.includes(wanted));
  return partial.length === 1 ? partial[0].key : null;
}

/** Une reponse d'interaction, adaptee a un envoi dans le salon. */
function toMessagePayload(payload) {
  const body = typeof payload === 'string' ? { content: payload } : { ...payload };
  // L'ephemere n'existe pas pour un message : il serait refuse.
  delete body.flags;
  body.allowedMentions = body.allowedMentions ?? { parse: [] };
  return body;
}

/**
 * Habille un message en interaction, pour reutiliser handleCommand tel quel.
 * La reponse part dans le salon ; une reponse "differee" puis editee devient
 * un seul message, envoye puis modifie.
 */
export function messageInteraction(message, name, values) {
  let sent = null;
  return {
    commandName: name,
    guildId: message.guildId,
    channelId: message.channelId,
    user: message.author,
    member: message.member,
    options: {
      getString: (key) => values[key] ?? null,
      getBoolean: (key) => values[key] ?? null,
      getFocused: () => '',
    },
    deferred: false,
    replied: false,
    isRepliable: () => true,
    async deferReply() {
      this.deferred = true;
      await message.channel.sendTyping().catch(() => {});
    },
    async reply(payload) {
      sent = await message.channel.send(toMessagePayload(payload));
      this.replied = true;
      return sent;
    },
    async editReply(payload) {
      if (sent) return sent.edit(toMessagePayload(payload));
      return this.reply(payload);
    },
    async fetchReply() {
      return sent;
    },
  };
}

/** Construit l'interaction d'un message "!commande", ou null s'il ne nous concerne pas. */
export function interactionFromMessage(message) {
  if (message.author?.bot) return null;
  const parsed = parseMessage(message.content);
  if (!parsed) return null;
  const timers = parsed.name === 'stop' ? store.forUser(message.author.id, message.guildId) : [];
  return messageInteraction(message, parsed.name, optionsFor(parsed.name, parsed.rest, timers));
}
