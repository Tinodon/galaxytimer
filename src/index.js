import 'dotenv/config';
import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import * as lock from './lock.js';
import * as store from './store.js';
import { ITEM_LIST } from './items.js';
import * as scheduler from './scheduler.js';
import * as intel from './intel.js';
import { initStores } from './boot.js';
import { handleAutocomplete, handleCommand } from './commands.js';
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

// Aucun intent privilegie : le bot ne lit pas les messages, il repond a des
// interactions. Rien a activer dans le portail developpeur.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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

client.once(Events.ClientReady, async (c) => {
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
  scheduler.start(client);
  ready = { tag: c.user.tag, guilds: c.guilds.cache.size };
  startIntelPolling();


});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
  } catch (err) {
    console.error('[bot] error while handling an interaction:', err);
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
});

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
    client.destroy();
    process.exit(0);
  });
}

// Une connexion ratee ne doit pas tuer le process : on garde le serveur HTTP
// debout pour que l'hebergeur affiche le service et que /health dise pourquoi,
// au lieu d'une boucle de redemarrage muette.
client.login(token).catch((err) => {
  loginError = err.message;
  console.error(`[bot] Discord login failed: ${err.message}`);
  console.error('[bot] check DISCORD_TOKEN. The HTTP server stays up so /health can report it.');
});
