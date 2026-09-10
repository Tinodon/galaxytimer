import 'dotenv/config';
import { Client, GatewayIntentBits, Events, ActivityType, REST } from 'discord.js';
import * as lock from './lock.js';
import * as store from './store.js';
import { ITEM_LIST } from './items.js';
import * as scheduler from './scheduler.js';
import * as intel from './intel.js';
import { initStores } from './boot.js';
import { handleAutocomplete, handleCommand } from './commands.js';
import { interactionFromMessage, messageContentEnabled, PREFIX } from './textcommands.js';
import { loadEmojis } from './emoji.js';
import { loadLibrary, librarySize } from './artwork.js';
import { startHealthServer } from './health.js';
import { registerGlobally, clearGuildCommands } from './register.js';

// Toute premiere ligne du journal : sans elle, un demarrage qui echoue tot ne
// laisse aucune trace et l'hebergeur affiche des logs vides.
console.log(`[bot] starting — node ${process.version}, port ${process.env.PORT ?? 'none (local)'}`);

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Refuse de demarrer si un autre bot tourne deja : voir src/lock.js.
lock.acquire();

// Le client est cree une fois connu ce que l'application a le droit de lire
// (voir main plus bas).
let client = null;

// Etat publie par /health. Renseigne des que le bot est pret ; avant ca, le
// serveur repond quand meme "starting", ce qui suffit a l'hebergeur.
let ready = null;
let loginError = null;

// Le port s'ouvre AVANT la connexion a Discord : Render valide un deploiement
// sur l'ouverture d'un port, et resterait bloque a "Deploying..." si on
// attendait d'etre connecte. PORT est defini par l'hebergeur, absent en local.
startHealthServer({
  port: process.env.PORT,
  status: () => ({
    status: ready ? 'ok' : loginError ? 'login_failed' : 'starting',
    error: loginError,
    bot: ready?.tag ?? null,
    guilds: ready?.guilds ?? 0,
    activeTimers: ready ? store.all().length : 0,
    uptimeSeconds: Math.round(process.uptime()),
  }),
});

async function onReady(c) {
  await initStores();
  await loadEmojis(c);
  for (const folder of new Set(ITEM_LIST.map((i) => i.artwork).filter(Boolean))) {
    loadLibrary(folder);
    console.log(`[artwork] ${librarySize(folder)} image(s) indexed in assets/${folder}/`);
  }
  // Le bot enregistre ses propres commandes : rien a lancer a la main.
  // Portee globale, pour qu'elles apparaissent aussi dans le profil du bot.
  await registerGlobally(c);
  await clearGuildCommands(c);
  c.user.setActivity('Galaxy Life', { type: ActivityType.Watching });
  const active = store.all().length;
  console.log(`[bot] logged in as ${c.user.tag} — ${active} timer(s) restored`);
  scheduler.start(c);
  ready = { tag: c.user.tag, guilds: c.guilds.cache.size };
  startIntelPolling();
}

/** Repond quelque chose quand une commande plante, plutot que rien. */
async function answerError(interaction, err) {
  console.error('[bot] error while handling a command:', err);
  if (!interaction.isRepliable() || interaction.replied) return;
    // Une commande DIFFEREE (deferReply) affiche "en train de reflechir"
    // jusqu'a ce qu'on edite sa reponse. Sans cette branche, toute erreur apres
    // le deferReply laissait le bot reflechir indefiniment — /pin, /find, /map,
    // /scout et /alliance differont tous avant de toucher au reseau.
    if (interaction.deferred) {
      await interaction
        .editReply({ content: 'Something went wrong on my side — try again in a moment.' })
        .catch(() => {});
      return;
    }
  await interaction
    .reply({ content: 'Internal error, try again.', flags: 64 })
    .catch(() => {});
}

async function onInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
  } catch (err) {
    await answerError(interaction, err);
  }
  return undefined;
}

/** "!find myra" : meme gestionnaire qu'une commande slash (voir textcommands.js). */
async function onMessage(message) {
  const interaction = interactionFromMessage(message);
  if (!interaction) return;
  try {
    await handleCommand(interaction);
  } catch (err) {
    await answerError(interaction, err);
  }
}

/**
 * L'intent "Message Content" est-il active dans le portail developpeur ?
 *
 * Il faut le savoir AVANT de se connecter : un bot qui demande cet intent sans
 * l'avoir fait activer est refuse par Discord, et tomberait entierement. On
 * lit donc les drapeaux de l'application ; en cas de doute, on s'en passe.
 */
async function messageContentAllowed() {
  try {
    const app = await new REST().setToken(token).get('/applications/@me');
    return messageContentEnabled(app.flags);
  } catch (err) {
    console.warn('[bot] could not read application flags, text commands disabled:', err.message);
    return false;
  }
}

function createClient(withMessages) {
  const intents = [GatewayIntentBits.Guilds];
  if (withMessages) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  const c = new Client({ intents });
  c.once(Events.ClientReady, onReady);
  c.on(Events.InteractionCreate, onInteraction);
  if (withMessages) c.on(Events.MessageCreate, onMessage);
  return c;
}

// Filet de securite : couvre les sorties qui ne passent pas par un signal.
process.on('exit', () => lock.release());

// Un releve par heure : assez fin pour voir une colonie apparaitre ou une
// guerre demarrer, assez espace pour ne pas marteler une API tierce.
const INTEL_POLL_MS = 60 * 60 * 1000;
let intelTimer = null;

function startIntelPolling() {
  const run = async () => {
    try {
      const { watched, changed } = await intel.pollAll();
      if (watched) console.log(`[intel] polled ${watched} entity(ies), ${changed} change(s) recorded`);
    } catch (err) {
      console.error('[intel] poll cycle failed:', err.message);
    }
  };
  void run();
  intelTimer = setInterval(() => void run(), INTEL_POLL_MS);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[bot] ${signal} received, shutting down.`);
    scheduler.stop();
    if (intelTimer) clearInterval(intelTimer);
    lock.release();
    client?.destroy();
    process.exit(0);
  });
}

// Une connexion ratee ne doit pas tuer le process : on garde le serveur HTTP
// debout pour que l'hebergeur affiche le service et que /health dise pourquoi,
// au lieu d'une boucle de redemarrage muette.
async function main() {
  const withMessages = await messageContentAllowed();
  console.log(withMessages
    ? `[bot] text commands on: "${PREFIX}find myra" works alongside /find`
    : '[bot] text commands off: enable "Message Content Intent" in the developer portal (Bot tab) to use them');
  client = createClient(withMessages);
  await client.login(token);
}

main().catch((err) => {
  loginError = err.message;
  console.error(`[bot] Discord login failed: ${err.message}`);
  console.error('[bot] check DISCORD_TOKEN. The HTTP server stays up so /health can report it.');
});
