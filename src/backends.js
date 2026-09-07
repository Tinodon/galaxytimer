// Backends de persistance des timers.
//
// En local, un fichier JSON suffit. Sur Render (offre gratuite), le disque est
// EPHEMERE : il est efface a chaque redeploiement et a chaque redemarrage de
// l'instance. Un timer Helmet de 35h n'y survivrait pas, ce qui detruirait
// l'interet du bot. Il faut donc une base externe.
//
// Les deux backends exposent la meme interface minimale :
//   read()          -> objet { cle: timer }, {} si vide
//   write(timers)   -> persiste l'objet entier
//
// L'etat tient en quelques kilo-octets et s'ecrit rarement (une action
// utilisateur, un timer qui sonne) : reecrire le tout est plus simple et
// largement assez rapide. Pas de raison de gerer des ecritures partielles.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Fichier JSON local, avec ecriture atomique. */
export function fileBackend(path) {
  return {
    name: `file (${path})`,

    read() {
      if (!existsSync(path)) return {};
      try {
        return JSON.parse(readFileSync(path, 'utf8')).timers ?? {};
      } catch (err) {
        // Un fichier corrompu ne doit pas empecher le bot de demarrer : on le
        // met de cote pour inspection plutot que de l'ecraser en silence.
        const backup = `${path}.corrupt-${Date.now()}`;
        try {
          renameSync(path, backup);
          console.error(`[store] timers file unreadable, moved to ${backup}`, err.message);
        } catch {
          console.error('[store] timers file unreadable and could not be moved', err.message);
        }
        return {};
      }
    },

    write(timers) {
      mkdirSync(dirname(path), { recursive: true });
      const payload = JSON.stringify({ version: 1, timers }, null, 2);
      // Un crash pendant l'ecriture ne doit pas laisser un JSON tronque.
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, path);
    },
  };
}

/**
 * Upstash Redis, via son API REST.
 *
 * Choisi pour Render : offre gratuite permanente, et une API HTTP toute simple
 * — aucune dependance a installer, `fetch` suffit. Notre "base" est un unique
 * blob JSON, donc pas de schema SQL a maintenir pour rien.
 *
 * Les ecritures sont asynchrones ; le cache en memoire garde le bot reactif et
 * une ecriture qui echoue est signalee sans faire tomber l'interaction en cours.
 */
export function upstashBackend({ url, token, key = 'galaxytimer:timers' }) {
  let cache = {};

  const auth = { Authorization: `Bearer ${token}` };

  const get = async () => {
    const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: auth });
    if (!response.ok) throw new Error(`Upstash GET ${response.status}: ${await response.text()}`);
    return (await response.json()).result;
  };

  // La valeur passe dans le CORPS de la requete, pas dans l'URL : un blob JSON
  // de plusieurs kilo-octets depasserait la longueur d'URL admissible.
  const set = async (payload) => {
    const response = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'text/plain' },
      body: payload,
    });
    if (!response.ok) throw new Error(`Upstash SET ${response.status}: ${await response.text()}`);
  };

  return {
    name: `upstash (${key})`,

    /** Charge la base distante dans le cache. A appeler une fois au demarrage. */
    async init() {
      const raw = await get();
      if (!raw) {
        cache = {};
        return;
      }
      try {
        cache = JSON.parse(raw).timers ?? {};
      } catch (err) {
        // On ne detruit pas une base illisible : on repart a vide en le disant,
        // la valeur reste inspectable cote Upstash.
        console.error('[store] remote payload unreadable, starting empty:', err.message);
        cache = {};
      }
    },

    read() {
      return cache;
    },

    write(timers) {
      cache = timers;
      const payload = JSON.stringify({ version: 1, timers });
      // Volontairement non attendu : une ecriture reseau ne doit pas ralentir la
      // reponse a une interaction Discord (3 secondes maxi).
      set(payload).catch((err) => {
        console.error('[store] remote write failed:', err.message);
      });
    },
  };
}
