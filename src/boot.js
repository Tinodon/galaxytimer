// Initialisation des stockages, partagee par le bot et par ses controles.
//
// Chaque module de donnees fige son support (fichier ou Upstash) a son `init`.
// Un module oublie ici n'a AUCUN support en production : sa premiere ecriture
// leve une erreur. C'est arrive a /pin — index.js initialisait les timers et
// l'intel, pas les pins, et la commande restait "en train de reflechir" pour
// toujours. Le controle de bout en bout ne l'avait pas vu parce qu'il faisait
// ses propres `init` au lieu de passer par le meme chemin que le bot.
//
// D'ou ce module unique : le bot et test/commands.mjs l'appellent tous les
// deux, un stockage ne peut plus etre initialise dans l'un et oublie dans
// l'autre.

import * as store from './store.js';
import * as intel from './intel.js';
import * as sql from './sql.js';

export async function initStores() {
  await store.init();
  await intel.init();
  // La carte vit dans Postgres (pins compris). Une base injoignable ne doit
  // pas empecher les timers de demarrer : on le signale et on continue, les
  // commandes de carte repondront une erreur propre.
  await sql.init().catch((err) => {
    console.error('[sql] map database unreachable at startup:', err.message);
  });
}
