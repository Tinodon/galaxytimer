import 'dotenv/config';
import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import * as lock from './lock.js';
import * as store from './store.js';
import { ITEM_LIST } from './items.js';
import * as scheduler from './scheduler.js';
import { handleCommand } from './commands.js';
import { loadEmojis } from './emoji.js';
import { loadLibrary, librarySize } from './artwork.js';
import { startHealthServer } from './health.js';
import { registerGlobally, clearGuildCommands } from './register.js';
import { handleButton } from './buttons.js';

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

client.once(Events.ClientReady, async (c) => {
  await store.init();
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

  // Uniquement pour l'hebergeur : PORT est defini par Render, absent en local.
  startHealthServer({
    port: process.env.PORT,
    status: () => ({
      status: 'ok',
      bot: c.user.tag,
      guilds: c.guilds.cache.size,
      activeTimers: store.all().length,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isButton()) return await handleButton(interaction);
  } catch (err) {
    console.error('[bot] error while handling an interaction:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'Internal error, try again.', flags: 64 })
        .catch(() => {});
    }
  }
});

// Filet de securite : couvre les sorties qui ne passent pas par un signal.
process.on('exit', () => lock.release());

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[bot] ${signal} received, shutting down.`);
    scheduler.stop();
    lock.release();
    client.destroy();
    process.exit(0);
  });
}

client.login(token);
