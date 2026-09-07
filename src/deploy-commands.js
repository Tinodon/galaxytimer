// Enregistre les slash commands aupres de Discord.
// A relancer uniquement quand on ajoute/modifie une commande.
//
//   npm run deploy          portee serveur : instantane. GUILD_ID accepte
//                           plusieurs ids separes par des virgules.
//   npm run deploy:global   portee globale : couvre tous les serveurs sans les
//                           lister, mais jusqu'a 1h de propagation. A reserver
//                           au cas ou le bot tourne sur beaucoup de serveurs.
//
// Piege : les deux portees se cumulent. Une commande deployee sur le serveur ET
// globalement apparait EN DOUBLE dans le selecteur de ce serveur. Le mode global
// efface donc les copies serveur au passage.

import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { definitions } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN and CLIENT_ID are required in .env');
  process.exit(1);
}

const global = process.argv.includes('--global');
const rest = new REST().setToken(DISCORD_TOKEN);

/** GUILD_ID accepte "id" ou "id1,id2,id3". */
const guildIds = (GUILD_ID ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Le stack trace brut de discord.js noie la cause reelle sous le corps de la
// requete. Ces trois erreurs sont les seules qui arrivent en pratique.
const DIAGNOSTICS = {
  50001: `The bot is not in that guild, or it was invited without the
"applications.commands" scope. Re-invite it via OAuth2 > URL Generator with BOTH
scopes ticked: "bot" and "applications.commands".`,
  10002: `Invalid CLIENT_ID: it matches no Discord application.
Copy it from the "General Information" tab of your application.`,
  0: `Invalid or revoked DISCORD_TOKEN. Regenerate it from the Bot > Reset Token tab.`,
};

try {
  if (global) {
    const data = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: definitions });
    console.log(
      `${data.length} command(s) deployed globally:`,
      data.map((c) => `/${c.name}`).join(' '),
    );

    for (const id of guildIds) {
      // Sans ca, ces serveurs afficheraient chaque commande deux fois.
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, id), { body: [] });
      console.log(`Guild-scoped copies cleared from ${id} to avoid duplicates.`);
    }
    console.log('Global commands can take up to 1 hour to appear on every server.');
  } else {
    if (!guildIds.length) {
      console.error('GUILD_ID is empty: either set it, or run `npm run deploy:global`.');
      process.exit(1);
    }

    // Un serveur ou le bot n'est pas encore invite ne doit pas faire echouer
    // les autres : on deploie serveur par serveur et on resume a la fin.
    let failed = 0;
    for (const id of guildIds) {
      try {
        const data = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, id), {
          body: definitions,
        });
        const names = data.map((c) => '/' + c.name).join(' ');
        console.log(`  OK   ${id} - ${names}`);
      } catch (err) {
        failed += 1;
        console.error(`  FAIL ${id} - ${err.message} (code ${err.code ?? err.status})`);
        if (err.code === 50001) {
          console.error('       Bot not invited there, or invited without "applications.commands".');
        }
      }
    }
    console.log(`${guildIds.length - failed}/${guildIds.length} guild(s) deployed.`);
    if (failed) process.exit(1);
  }
} catch (err) {
  const hint = DIAGNOSTICS[err.code] ?? DIAGNOSTICS[err.status === 401 ? 0 : -1];
  console.error(`\nDeploy failed: ${err.message} (code ${err.code ?? err.status})\n`);
  if (hint) console.error(`${hint}\n`);
  process.exit(1);
}
