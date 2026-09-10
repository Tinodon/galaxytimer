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
    'Named timers run side by side: `/wars player:John`, `/wars player:Mike`.',
    'Durations: `1h30`, `90m`, `2d`. `repeat:True` relaunches on each reset.',
    '`/timers` — what you have running. `/stop <timer>` — stop one of yours.',
    '',
    '**Intel** — public Galaxy Life data, tracked hourly',
    '`/scout <player>` — level, planets, HQs, attacks, and what changed.',
    '`/alliance <name>` — level, war points, war status, member moves.',
    '',
    '**Map** — one map for every server',
    '`/find <player>` — their planets, one numbered line each.',
    '`/map <alliance>` — the same for every member.',
    '`/who <coords>` — who is there: `/who coords:359,11`.',
    '`/list [page or name]` — players on the map, A to Z. ⚠️ = more than they own.',
    '`/pin <player> <coords> [HQ]` — add a planet: `/pin John 512,340 5`. 📌 = pinned.',
    '`/edit <player> <line> ...` — fix a /find line: `/edit John 3 delete`,',
    '`/edit John 3 6` (HQ), `/edit John 3 512,341`, `/edit John 3 512,341 6`.',
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
