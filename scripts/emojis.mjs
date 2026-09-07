// Liste les emojis disponibles pour le bot, au format pret a coller dans src/items.js.
//
// Deux sources possibles :
//  - emojis de l'application (portail dev > ton app > Emojis) : utilisables
//    partout ou le bot est present, c'est la bonne place pour un bot.
//  - emojis du serveur : utilisables seulement sur ce serveur.
//
//   npm run emojis

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const fmt = (e) => (e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`);

client.once('clientReady', async (c) => {
  const appEmojis = await c.application.emojis.fetch().catch(() => new Map());
  console.log(`\n=== Emojis de l'application (${appEmojis.size}) ===`);
  if (!appEmojis.size) console.log('  (aucun)');
  for (const e of appEmojis.values()) console.log(`  ${e.name.padEnd(24)} ${fmt(e)}`);

  for (const g of c.guilds.cache.values()) {
    const guild = await c.guilds.fetch(g.id);
    const emojis = await guild.emojis.fetch();
    console.log(`\n=== Emojis du serveur "${guild.name}" (${emojis.size}) ===`);
    if (!emojis.size) console.log('  (aucun)');
    for (const e of emojis.values()) console.log(`  ${e.name.padEnd(24)} ${fmt(e)}`);
  }

  await c.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
setTimeout(() => { console.error('Timeout.'); process.exit(1); }, 20000);
