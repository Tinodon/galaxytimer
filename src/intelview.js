// Mise en forme des rapports de renseignement.
//
// Texte brut, comme le reste du bot. Un rapport doit tenir sous les 2000
// caracteres d'un message Discord, donc on privilegie ce qui a CHANGE plutot
// que de tout reciter.

import { discordRelative } from './duration.js';

const num = (n) => (n == null ? '?' : Number(n).toLocaleString('en-US'));

/** Ecart signe, ou null si rien n'a bouge. */
function delta(now, before) {
  if (now == null || before == null) return null;
  const d = now - before;
  return d === 0 ? null : `${d > 0 ? '+' : ''}${num(d)}`;
}

/**
 * Compare deux listes de niveaux de QG.
 *
 * On compare des multi-ensembles tries, pas des positions : l'API ne garantit
 * aucun ordre stable entre deux appels, donc comparer index par index
 * inventerait des changements.
 */
function hqChanges(now = [], before = []) {
  const counts = new Map();
  for (const level of before) counts.set(level, (counts.get(level) ?? 0) + 1);
  for (const level of now) counts.set(level, (counts.get(level) ?? 0) - 1);

  const gained = [];
  const lost = [];
  for (const [level, n] of counts) {
    for (let i = 0; i < Math.abs(n); i += 1) (n < 0 ? gained : lost).push(level);
  }
  return { gained: gained.sort((a, b) => b - a), lost: lost.sort((a, b) => b - a) };
}

/** Rapport joueur : etat actuel, puis ce qui a bouge depuis le premier releve. */
export function playerReport(user, stats, history) {
  const hq = (user.Planets ?? []).map((p) => p.HQLevel).sort((a, b) => b - a);
  const lines = [
    `**${user.Name}** — level **${user.Level}** · ${hq.length} planet(s)`,
    user.AllianceId ? `Alliance: **${user.AllianceId}**` : 'No alliance',
    `HQ levels: ${hq.join(', ') || '—'}`,
  ];

  if (stats) {
    lines.push(
      `Attacks: **${num(stats.PlayersAttacked)}** done · **${num(stats.TimesAttacked)}** taken` +
        ` · ${num(stats.StarbasesDestroyed)} starbases destroyed`,
    );
  }

  const first = history[0];
  if (!first) {
    lines.push('', '_No history yet. It builds up from the next poll._');
    return lines.join('\n');
  }

  const changes = [];
  const lvl = delta(user.Level, first.level);
  if (lvl) changes.push(`level ${lvl} (was ${first.level})`);

  const { gained, lost } = hqChanges(hq, first.hq);
  if (gained.length) changes.push(`gained ${gained.length} planet(s) — HQ ${gained.join(', ')}`);
  if (lost.length) changes.push(`lost ${lost.length} planet(s) — HQ ${lost.join(', ')}`);

  if (first.alliance !== (user.AllianceId ?? null)) {
    changes.push(`alliance: ${first.alliance ?? 'none'} → ${user.AllianceId ?? 'none'}`);
  }

  const taken = delta(stats?.TimesAttacked, first.timesAttacked);
  if (taken) changes.push(`attacked ${taken} times`);
  const done = delta(stats?.PlayersAttacked, first.attacksDone);
  if (done) changes.push(`attacked others ${done} times`);
  const sb = delta(stats?.StarbasesDestroyed, first.starbasesDestroyed);
  if (sb) changes.push(`starbases destroyed ${sb}`);

  lines.push('', `**Since ${discordRelative(first.t)}** (${history.length} snapshot(s))`);
  lines.push(changes.length ? changes.map((c) => `· ${c}`).join('\n') : '· nothing changed');
  return lines.join('\n');
}

/** Rapport alliance : etat de guerre, puis mouvements de membres et warpoints. */
export function allianceReport(alliance, history) {
  const members = alliance.Members ?? [];
  const lines = [
    `**${alliance.Name}** — level **${alliance.AllianceLevel}** · ${members.length} member(s)`,
    `War points: **${num(alliance.WarPoints)}** · ${alliance.WarsWon}W / ${alliance.WarsLost}L`,
    alliance.InWar
      ? `**AT WAR** against **${alliance.OpponentAllianceId}**`
      : 'Not currently at war',
  ];

  const first = history[0];
  if (!first) {
    lines.push('', '_No history yet. It builds up from the next poll._');
    return lines.join('\n');
  }

  const changes = [];
  const wp = delta(alliance.WarPoints, first.warPoints);
  if (wp) changes.push(`war points ${wp}`);
  const lvl = delta(alliance.AllianceLevel, first.level);
  if (lvl) changes.push(`alliance level ${lvl}`);

  const before = new Map((first.members ?? []).map((m) => [m.id, m.name]));
  const now = new Map(members.map((m) => [m.Id, m.Name]));
  const joined = [...now].filter(([id]) => !before.has(id)).map(([, n]) => n);
  const left = [...before].filter(([id]) => !now.has(id)).map(([, n]) => n);
  if (joined.length) changes.push(`joined: ${joined.join(', ')}`);
  if (left.length) changes.push(`left: ${left.join(', ')}`);

  if (first.inWar !== Boolean(alliance.InWar)) {
    changes.push(alliance.InWar ? `war started against ${alliance.OpponentAllianceId}` : 'war ended');
  } else if (alliance.InWar && first.opponent !== alliance.OpponentAllianceId) {
    changes.push(`new opponent: ${first.opponent} → ${alliance.OpponentAllianceId}`);
  }

  lines.push('', `**Since ${discordRelative(first.t)}** (${history.length} snapshot(s))`);
  lines.push(changes.length ? changes.map((c) => `· ${c}`).join('\n') : '· nothing changed');
  return lines.join('\n');
}

/** Coupe proprement si un rapport depasse la limite d'un message Discord. */
export function fit(text, max = 1990) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
