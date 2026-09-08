// Client de l'API publique Galaxy Life (api.galaxylifegame.net).
//
// Lecture seule, sans authentification. Toutes les fonctions renvoient null
// plutot que de lever quand le joueur ou l'alliance n'existe pas : l'appelant
// affiche un message clair au lieu d'un plantage.
//
// L'API est celle d'un tiers : elle peut etre lente, en maintenance, ou changer
// de forme. On borne chaque appel dans le temps et on ne suppose jamais qu'un
// champ est present.

const BASE = 'https://api.galaxylifegame.net';
const TIMEOUT_MS = 10_000;

async function call(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    // 404 = absent ; 400 = requete vide ou mal formee, ce qui pour nous est
    // aussi une absence (l'appelant a passe un nom vide).
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw new Error(`API ${response.status} on ${path}`);
    const text = (await response.text()).trim();
    if (!text) return null;

    // L'API repond 200 avec un message en clair quand la ressource n'existe
    // pas ("User with this name does not exist!"). On traite ca comme une
    // absence, pas comme une panne.
    if (!text.startsWith('{') && !text.startsWith('[')) return null;

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`API returned malformed JSON on ${path}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Recherche par nom. Renvoie une liste, potentiellement vide. */
export async function searchUsers(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return [];
  const result = await call(`/Users/search?name=${encodeURIComponent(clean)}`);
  return Array.isArray(result) ? result : [];
}

/**
 * Profil par nom exact. L'API tolere la casse, mais pas les approximations :
 * on retombe sur la recherche pour rattraper "iraxeri" -> "IRaXeRI".
 */
export async function getUserByName(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return null;

  const direct = await call(`/Users/name?name=${encodeURIComponent(clean)}`);
  if (direct?.Id) return direct;

  const [first] = await searchUsers(clean);
  return first?.Id ? getUserById(first.Id) : null;
}

export async function getUserById(id) {
  const user = await call(`/Users/get?id=${encodeURIComponent(id)}`);
  return user?.Id ? user : null;
}

export async function getUserStats(id) {
  return call(`/Users/stats?id=${encodeURIComponent(id)}`);
}

export async function getAlliance(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return null;
  const alliance = await call(`/Alliances/get?name=${encodeURIComponent(clean)}`);
  return alliance?.Id ? alliance : null;
}

export async function getStatus() {
  const status = await call('/status');
  return Array.isArray(status) ? status : [];
}
