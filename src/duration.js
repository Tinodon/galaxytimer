// Parsing et formatage de durees, pour l'option `duree` de /timer.

const UNITS = { j: 86400e3, d: 86400e3, h: 3600e3, m: 60e3, min: 60e3, s: 1000 };

/**
 * Accepte "35h", "1h30", "1h30m", "90m", "2j", "3h15m20s".
 * Retourne un nombre de millisecondes, ou null si la saisie est invalide.
 */
export function parseDuration(input) {
  if (input == null) return null;
  const raw = String(input).trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;

  // Forme "1h30" : les minutes suivent l'heure sans unite explicite.
  const bare = raw.match(/^(\d+)h(\d{1,2})$/);
  if (bare) return Number(bare[1]) * UNITS.h + Number(bare[2]) * UNITS.m;

  const matches = [...raw.matchAll(/(\d+(?:[.,]\d+)?)(j|d|h|min|m|s)/g)];
  if (!matches.length) return null;
  // Rejette les saisies partiellement comprises ("35hbanane").
  if (matches.reduce((n, m) => n + m[0].length, 0) !== raw.length) return null;

  const ms = matches.reduce(
    (total, [, value, unit]) => total + Number(value.replace(',', '.')) * UNITS[unit],
    0,
  );
  return ms > 0 ? Math.round(ms) : null;
}

// En dessous de ce seuil on reste en heures. Un joueur connait ses items par
// leur duree en heures ("35h", "23h") : les convertir en "1d 11h" oblige a
// recalculer de tete pour rien.
const DAYS_THRESHOLD_HOURS = 48;

/** Formate une duree en "35h", "2d 3h", "23h 30m" — pour l'affichage humain. */
export function formatDuration(ms) {
  if (ms <= 0) return 'now';
  const total = Math.round(ms / 1000);
  const totalHours = Math.floor(total / 3600);

  const parts = [];
  if (totalHours >= DAYS_THRESHOLD_HOURS) {
    parts.push(`${Math.floor(total / 86400)}d`);
    const h = Math.floor((total % 86400) / 3600);
    if (h) parts.push(`${h}h`);
    return parts.join(' ');
  }

  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (totalHours) parts.push(`${totalHours}h`);
  if (m) parts.push(`${m}m`);
  if (s && !totalHours) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

/** Horodatage relatif Discord : s'auto-actualise dans le client de chacun. */
export function discordRelative(timestampMs) {
  return `<t:${Math.floor(timestampMs / 1000)}:R>`;
}

/** Horodatage absolu Discord, dans le fuseau local de chaque lecteur. */
export function discordAbsolute(timestampMs) {
  return `<t:${Math.floor(timestampMs / 1000)}:f>`;
}
