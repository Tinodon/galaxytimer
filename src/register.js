// Enregistrement automatique des slash commands, en portee GLOBALE.
//
// Pourquoi global et pas par serveur : seules les commandes globales alimentent
// la section "Commands" du profil du bot (les pastilles /helmet, /wars... quand
// on clique dessus). Les commandes par serveur sont instantanees mais restent
// invisibles la-bas.
//
// Contrepartie assumee : Discord met jusqu'a 1h a propager un changement de
// commande. Ca ne concerne que l'ajout ou la modification d'une commande, pas
// leur utilisation.

import { definitions } from './commands.js';

/** Enregistre les commandes pour toutes les installations du bot. */
export async function registerGlobally(client) {
  try {
    const data = await client.application.commands.set(definitions);
    console.log(`[commands] ${data.size} command(s) registered globally: ` +
      [...data.values()].map((c) => `/${c.name}`).join(' '));
    return true;
  } catch (err) {
    console.error(`[commands] global registration failed: ${err.message} (code ${err.code ?? err.status})`);
    return false;
  }
}

/**
 * Supprime les copies par serveur laissees par l'ancien mode.
 *
 * Sans ce nettoyage, une commande enregistree a la fois globalement et sur le
 * serveur apparait EN DOUBLE dans le selecteur. On ne touche qu'aux serveurs qui
 * en ont vraiment, pour ne pas taper l'API pour rien a chaque demarrage.
 */
export async function clearGuildCommands(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const existing = await client.application.commands.fetch({ guildId: guild.id });
      if (!existing.size) continue;
      await client.application.commands.set([], guild.id);
      console.log(`[commands] cleared ${existing.size} guild-scoped copy(ies) from "${guild.name}"`);
    } catch (err) {
      console.error(`[commands] could not clean "${guild.name}": ${err.message}`);
    }
  }
}
