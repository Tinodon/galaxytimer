// Registre des types de timer. Chaque entree devient une slash command portant
// son `id` : /helmet, /toolcase, /starbattery, /wars, /upgrade, /test.
//
// duration      : duree fixe en ms. Absente si le type demande une duree custom.
// customDuration: le lancement exige une option `duration` (cas de /upgrade).
// nameOption    : nom de l'option texte qui nomme le timer (ex. 'player'), ou
//                 null si le type n'accepte pas de nom.
// nameOnly      : le nom REMPLACE le libelle au lieu de s'y ajouter. Pour
//                 /upgrade, "Laboratory" se lit mieux que "Upgrade — Laboratory".
// emojiName     : nom de l'emoji custom cote application, resolu au demarrage.
// emoji         : fallback unicode.
// image         : fichier dans assets/, joint au message de lancement.
// artwork       : dossier d'images dans assets/ ou chercher une illustration
//                 correspondant au NOM saisi (voir src/artwork.js). Sert a
//                 /upgrade : name:S-Trike sort l'image du S-Trike.

const H = 3600 * 1000;

export const ITEMS = {
  helmet: {
    id: 'helmet',
    label: 'Helmet',
    description: 'Start the 35h Helmet timer',
    source: 'Collect from Compact Houses',
    duration: 35 * H,
    emojiName: 'helmet',
    emoji: '⛑️',
    image: 'helmet.png',
  },
  toolcase: {
    id: 'toolcase',
    label: 'Tool Case',
    description: 'Start the 23h Tool Case timer',
    source: 'Help friends',
    duration: 23 * H,
    emojiName: 'toolcate',
    emoji: '🧰',
    image: 'toolcase.png',
  },
  starbattery: {
    id: 'starbattery',
    label: 'Star Battery',
    description: 'Start the 11h Star Battery timer',
    source: 'Help friends',
    duration: 11 * H,
    emojiName: 'starbattery',
    emoji: '🔋',
    image: 'starbattery.png',
  },
  wars: {
    id: 'wars',
    label: 'War Bases',
    description: 'Start a 3h war base regen timer',
    source: 'Player bases regen',
    duration: 3 * H,
    nameOption: 'player',
    nameDescription: 'Player whose base you hit (optional)',
    emojiName: 'wars',
    emoji: '⚔️',
    image: 'wars.png',
  },
  upgrade: {
    id: 'upgrade',
    label: 'Upgrade',
    description: 'Start a custom timer for a building upgrade',
    source: 'Building upgrade',
    customDuration: true,
    nameOption: 'name',
    nameDescription: 'What is upgrading, e.g. Laboratory (optional)',
    nameOnly: true,
    artwork: 'upgrades',
    emojiName: 'upgrade',
    emoji: '🔧',
    image: 'upgrade.png',
  },
};

export const ITEM_LIST = Object.values(ITEMS);

/**
 * Type de repli pour un timer dont l'item n'existe plus dans le registre.
 *
 * Retirer un type (ou renommer son id) ne doit pas faire disparaitre en silence
 * les timers en cours : ils sonnent avec ce qu'on sait d'eux plutot que d'etre
 * jetes. Un ping approximatif vaut mieux qu'un reveil manque.
 */
export function fallbackItem(record) {
  return {
    id: record.itemId,
    label: record.name || record.itemId,
    source: 'Unknown timer type',
    emoji: '⏳',
  };
}

/**
 * Reduit un nom libre a un fragment de cle sur.
 *
 * Les cles de timer sont decoupees sur `:` et voyagent dans les customId de
 * boutons (100 caracteres maxi chez Discord), donc le nom brut ne peut pas y
 * entrer tel quel.
 */
export function slugify(name) {
  if (!name) return '';
  const slug = String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (slug) return slug;

  // Nom compose uniquement de caracteres non latins (ex. cyrillique, emojis) :
  // on garde une empreinte stable plutot que de tout fusionner sur la cle vide.
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `n${hash.toString(36)}`;
}

/** Libelle affiche pour un timer, nom libre inclus. */
export function timerLabel(record, item) {
  if (!record.name) return item.label;
  return item.nameOnly ? record.name : `${item.label} — ${record.name}`;
}
