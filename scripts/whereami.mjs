// Diagnostic : dans quels serveurs le bot est-il reellement present ?
// A lancer quand `npm run deploy` renvoie "Missing Access" : le plus souvent le
// bot n'a simplement pas ete invite sur le serveur vise.
//
//   npm run whereami

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// GUILD_ID accepte une liste separee par des virgules, comme le deploiement.
const wanted = (process.env.GUILD_ID ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

/** Un snowflake encode sa date de creation : utile pour reperer un mauvais ID. */
function createdAt(id) {
  try {
    return new Date(Number(BigInt(id) >> 22n) + 1420070400000).toISOString().slice(0, 10);
  } catch {
    return 'id invalide';
  }
}

client.once('clientReady', async (c) => {
  const guilds = [...c.guilds.cache.values()];
  const present = new Set(guilds.map((g) => g.id));

  console.log(`\nLogged in as: ${c.user.tag}`);

  console.log(`\nGuilds the bot is actually in (${guilds.length}):`);
  if (!guilds.length) console.log('  none — the invite never went through.');
  for (const g of guilds) {
    console.log(`  ${g.id}  ${g.name}${wanted.includes(g.id) ? '   [in GUILD_ID]' : '   [not in GUILD_ID]'}`);
  }

  console.log(`\nGUILD_ID entries (${wanted.length}):`);
  if (!wanted.length) console.log('  (empty)');
  for (const id of wanted) {
    const ok = present.has(id);
    console.log(`  ${id}  ${ok ? 'OK — bot present' : `NOT FOUND — bot not invited (id created ${createdAt(id)})`}`);
  }

  const missing = wanted.filter((id) => !present.has(id));
  if (missing.length) {
    console.log(
      `\n${missing.length} guild(s) in GUILD_ID have no bot. Invite it there with both\n` +
      `scopes ("bot" + "applications.commands"), then run: npm run deploy`,
    );
  }

  await c.destroy();
  process.exit(0);
});

client.on('error', (err) => { console.error('Error:', err.message); process.exit(1); });
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error(`\nLogin failed: ${err.message}`);
  console.error('DISCORD_TOKEN is probably invalid or revoked.\n');
  process.exit(1);
});
setTimeout(() => { console.error('Connection timeout (20s).'); process.exit(1); }, 20000);
