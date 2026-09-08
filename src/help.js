// Textes d'aide, generes depuis src/items.js.
//
// Rien n'est ecrit en dur : ajouter un type de timer met a jour /glhelp et la
// description du bot sans y toucher. Une aide qui ment est pire que pas d'aide.

import { ITEM_LIST } from './items.js';
import { formatDuration } from './duration.js';
import { emojiFor } from './emoji.js';

/** Discord plafonne la description d'une application a 400 caracteres. */
export const MAX_DESCRIPTION = 400;

const fixed = () => ITEM_LIST.filter((i) => i.duration && !i.nameOption);
const named = () => ITEM_LIST.filter((i) => i.nameOption);

/** Message de /glhelp. */
export function helpText() {
  const lines = [
    '**GalaxyTimer** — start a timer when you collect, get pinged when it resets.',
    '',
    '**Fixed timers** — one per item, running it again restarts it',
  ];

  for (const item of fixed()) {
    lines.push(`${emojiFor(item)} \`/${item.id}\` — **${formatDuration(item.duration)}** · ${item.source}`);
  }

  lines.push('', '**Named timers** — run as many at once as you want');
  for (const item of named()) {
    const args = [
      item.customDuration ? '<duration>' : null,
      `[${item.nameOption}]`,
    ].filter(Boolean).join(' ');
    const length = item.duration ? `**${formatDuration(item.duration)}**` : '**any duration**';
    lines.push(`${emojiFor(item)} \`/${item.id} ${args}\` — ${length} · ${item.source}`);
  }

  lines.push(
    '',
    // Pseudos volontairement generiques : le guide est lu par tout le serveur,
    // pas seulement par ceux qui reconnaitraient un nom d'alliance.
    'Naming a timer lets several run side by side: `/wars player:John` and',
    '`/wars player:Mike` are two separate timers.',
    'Durations accept `1h30`, `90m`, `2d`, `35h`.',
    '',
    '`/timers` — everything you have running, with a **Stop** button on each.',
    '',
    '**Intel** — public Galaxy Life data, tracked over time',
    '`/scout <player>` — level, planets, HQ levels, attack record, and what',
    'changed since the bot first saw them.',
    '`/alliance <name>` — level, war points, war status, member movements.',
    '`/watchlist` — who this server is tracking. Scouting adds them automatically;',
    'snapshots are taken hourly and only changes are stored.',
    '',
    'Every timer message carries buttons: **Restart**, **Repeat** (relaunch itself',
    'on each reset) and **Stop**. Only the owner of a timer can press them.',
  );

  return lines.join('\n');
}

/**
 * Description de l'application, visible en cliquant sur le bot.
 * Sans emoji custom : le profil ne les rend pas, ils s'y affichent en brut.
 */
export function descriptionText() {
  const all = [...fixed(), ...named()];
  const list = all
    .map((item) => {
      const args = item.customDuration ? ' <duration>' : '';
      const name = item.nameOption ? ` [${item.nameOption}]` : '';
      const length = item.duration ? formatDuration(item.duration) : 'any duration';
      return `/${item.id}${args}${name} — ${length}`;
    })
    .join('\n');

  const text = [
    'Galaxy Life timers. Run a command when you collect something, get pinged when it comes back.',
    '',
    list,
    '/timers — everything you have running',
    '',
    'Type /glhelp for the full guide.',
  ].join('\n');

  if (text.length <= MAX_DESCRIPTION) return text;
  // Filet : Discord refuse au-dela de 400 caracteres, on coupe plutot qu'echouer.
  return `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
}
