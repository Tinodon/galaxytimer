// Affiche le rendu texte reel des messages, emojis custom resolus.
// Sert a verifier ce que verra le salon sans avoir a lancer les commandes.
//
//   npm run preview

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { ITEMS } from '../src/items.js';
import { loadEmojis } from '../src/emoji.js';
import { startedText, readyText, completedText, panelText } from '../src/ui.js';
import { helpText } from '../src/help.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async (c) => {
  await loadEmojis(c);
  const now = Date.now();
  const mk = (id, h, name = null, repeat = false) => ({
    key: `g:u:${id}:`, userId: '796447983604072498', itemId: id, name,
    duration: h * 3600e3, expiresAt: now + h * 3600e3, repeat,
  });

  const sb = mk('starbattery', 11);
  const hl = mk('helmet', 35, null, true);
  const tc = mk('toolcase', 23);
  const w0 = mk('wars', 3);
  const w1 = mk('wars', 3, 'Bnavic');
  const up = mk('upgrade', 4, 'Laboratory');

  const show = (title, record, item) => {
    console.log(`\n--- ${title} ---`);
    console.log(startedText(record, item, 'Noe'));
  };

  show('/starbattery', sb, ITEMS.starbattery);
  show('/wars', w0, ITEMS.wars);
  show('/wars player:Bnavic', w1, ITEMS.wars);
  show('/upgrade duration:4h name:Laboratory', up, ITEMS.upgrade);

  console.log('\n--- ping ---');
  console.log(readyText(w1, ITEMS.wars));
  console.log('\n--- message de lancement, une fois echu ---');
  console.log(completedText(up, ITEMS.upgrade, 'Noe'));
  console.log('\n--- /timers ---');
  console.log(panelText([w0, w1, sb, up, tc, hl], ITEMS, 'Noe'));
  console.log('\n--- /glhelp ---');
  console.log(helpText());
  console.log('');

  await c.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
setTimeout(() => { console.error('Timeout.'); process.exit(1); }, 20000);
