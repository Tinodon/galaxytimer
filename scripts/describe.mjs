// Publie la description de l'application (visible en cliquant sur le bot).
//
// Elle est generee depuis src/items.js, donc elle suit automatiquement les
// commandes. A relancer apres avoir ajoute ou retire un type de timer.
//
//   npm run describe            affiche ce qui serait publie, sans rien changer
//   npm run describe -- --apply publie pour de bon

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { descriptionText, MAX_DESCRIPTION } from '../src/help.js';

const apply = process.argv.includes('--apply');
const text = descriptionText();

console.log(`\n--- description (${text.length}/${MAX_DESCRIPTION} caracteres) ---\n`);
console.log(text);
console.log('\n---');

if (!apply) {
  console.log('\nApercu uniquement. Pour publier : npm run describe -- --apply\n');
  process.exit(0);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('clientReady', async (c) => {
  try {
    await c.application.edit({ description: text });
    console.log(`\nDescription published for ${c.user.tag}.\n`);
  } catch (err) {
    console.error(`\nFailed to publish: ${err.message} (code ${err.code ?? err.status})\n`);
    process.exitCode = 1;
  }
  await c.destroy();
  process.exit(process.exitCode ?? 0);
});
client.login(process.env.DISCORD_TOKEN);
setTimeout(() => { console.error('Timeout.'); process.exit(1); }, 20000);
