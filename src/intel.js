// Suivi historique des joueurs et alliances.
//
// C'est ce que le bot officiel ne peut pas faire : il interroge l'API et
// affiche l'instant present. Ici on releve periodiquement et on garde ce qui a
// change, donc on peut repondre a "qu'est-ce qui a bouge cette semaine ?".
//
// On n'enregistre un releve QUE s'il differe du precedent. Une base pleine de
// copies identiques ne dit rien et gonfle le stockage pour rien.

import { selectBackend } from './store.js';
import * as api from './glapi.js';

// Assez pour couvrir plusieurs semaines de changements sans faire enfler le
// blob : au-dela on oublie les plus anciens.
const MAX_SNAPSHOTS = 40;

let backend = null;
let state = { watched: {}, players: {}, alliances: {} };

export async function init() {
  backend = selectBackend('intel');
  if (backend.init) await backend.init();
  load();
  const p = Object.keys(state.players).length;
  const a = Object.keys(state.alliances).length;
  console.log(`[intel] backend: ${backend.name} — ${p} player(s), ${a} alliance(s) tracked`);
}

function load() {
  const raw = backend.read();
  state = {
    watched: raw.watched ?? {},
    players: raw.players ?? {},
    alliances: raw.alliances ?? {},
  };
}

function save() {
  backend.write(state);
}

/** Reduit un profil a ce qui vaut la peine d'etre suivi dans le temps. */
export function playerSnapshot(user, stats) {
  return {
    t: Date.now(),
    name: user.Name,
    level: user.Level,
    xp: user.Experience,
    alliance: user.AllianceId ?? null,
    // Niveaux de QG tries : detecte une colonie gagnee, perdue ou amelioree.
    hq: (user.Planets ?? []).map((p) => p.HQLevel).sort((a, b) => b - a),
    attacksDone: stats?.PlayersAttacked ?? null,
    timesAttacked: stats?.TimesAttacked ?? null,
    starbasesDestroyed: stats?.StarbasesDestroyed ?? null,
  };
}

export function allianceSnapshot(alliance) {
  return {
    t: Date.now(),
    name: alliance.Name,
    level: alliance.AllianceLevel,
    warPoints: alliance.WarPoints,
    warsWon: alliance.WarsWon,
    warsLost: alliance.WarsLost,
    inWar: Boolean(alliance.InWar),
    opponent: alliance.OpponentAllianceId ?? null,
    members: (alliance.Members ?? []).map((m) => ({ id: m.Id, name: m.Name, level: m.Level })),
  };
}

/** Deux releves sont identiques si tout differe sauf l'horodatage. */
function sameContent(a, b) {
  if (!a || !b) return false;
  const strip = ({ t, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

function push(collection, id, snapshot) {
  const history = collection[id] ?? [];
  const last = history[history.length - 1];
  if (sameContent(last, snapshot)) return false;

  history.push(snapshot);
  // On garde le tout premier releve : c'est la reference "depuis le debut".
  collection[id] = history.length > MAX_SNAPSHOTS
    ? [history[0], ...history.slice(-(MAX_SNAPSHOTS - 1))]
    : history;
  return true;
}

export function recordPlayer(id, snapshot) {
  const changed = push(state.players, id, snapshot);
  if (changed) save();
  return changed;
}

export function recordAlliance(id, snapshot) {
  const changed = push(state.alliances, id, snapshot);
  if (changed) save();
  return changed;
}

export function playerHistory(id) {
  return state.players[id] ?? [];
}

export function allianceHistory(id) {
  return state.alliances[String(id).toLowerCase()] ?? [];
}

// --- Liste de surveillance, par serveur Discord ---

const listOf = (guildId) => {
  const key = guildId ?? 'dm';
  state.watched[key] ??= { players: [], alliances: [] };
  return state.watched[key];
};

export function watch(guildId, kind, id, label) {
  const list = listOf(guildId);
  const bucket = kind === 'player' ? list.players : list.alliances;
  if (bucket.some((e) => e.id === id)) return false;
  bucket.push({ id, label });
  save();
  return true;
}

export function unwatch(guildId, kind, id) {
  const list = listOf(guildId);
  const bucket = kind === 'player' ? list.players : list.alliances;
  const index = bucket.findIndex((e) => e.id === id);
  if (index === -1) return false;
  bucket.splice(index, 1);
  save();
  return true;
}

export function watchList(guildId) {
  return listOf(guildId);
}

/** Toutes les entites suivies, tous serveurs confondus, dedoublonnees. */
export function allWatched() {
  const players = new Map();
  const alliances = new Map();
  for (const list of Object.values(state.watched)) {
    for (const e of list.players ?? []) players.set(e.id, e);
    for (const e of list.alliances ?? []) alliances.set(e.id, e);
  }
  return { players: [...players.values()], alliances: [...alliances.values()] };
}

/**
 * Releve toutes les entites suivies. Sequentiel et non parallele : l'API est
 * celle d'un tiers, rien ne justifie de lui envoyer trente requetes d'un coup.
 */
export async function pollAll() {
  const { players, alliances } = allWatched();
  let changed = 0;

  for (const entry of players) {
    try {
      const user = await api.getUserById(entry.id);
      if (!user) continue;
      const stats = await api.getUserStats(entry.id).catch(() => null);
      if (recordPlayer(entry.id, playerSnapshot(user, stats))) changed += 1;
    } catch (err) {
      console.error(`[intel] poll failed for player ${entry.label}: ${err.message}`);
    }
  }

  for (const entry of alliances) {
    try {
      const alliance = await api.getAlliance(entry.id);
      if (!alliance) continue;
      if (recordAlliance(String(alliance.Id).toLowerCase(), allianceSnapshot(alliance))) changed += 1;
    } catch (err) {
      console.error(`[intel] poll failed for alliance ${entry.label}: ${err.message}`);
    }
  }

  return { watched: players.length + alliances.length, changed };
}
