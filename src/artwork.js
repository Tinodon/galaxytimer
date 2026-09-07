// Correspondance entre un nom libre et une image d'unite ou de batiment.
//
// `/upgrade duration:4h name:S-Trike` doit sortir l'image du S-Trike. Le nom est
// saisi a la main : "S-Trike", "s trike", "strike", "S.Trike" et "S-Trike lvl 5"
// doivent tous tomber sur le meme fichier. On indexe donc sur une forme
// normalisee (minuscules, sans separateur ni accent) plutot que sur le nom brut.
//
// Deux sources, dans cet ordre :
//
//  1. un fichier dans assets/<dossier>/ — resolution libre, joint au message ;
//  2. un emoji d'application portant le meme nom — pratique (tout se gere dans
//     le portail Discord, rien a deposer sur la machine) mais Discord le
//     redimensionne a 128x128. On poste alors son URL CDN, que Discord deplie
//     en apercu image, au lieu de l'emoji inline qui ferait 22 pixels.
//
// Un aliases.json optionnel dans le dossier gere les surnoms que la
// normalisation ne peut pas deviner ("labo" -> "laboratory").

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Surchargeable pour que les tests travaillent sur leurs propres fixtures. */
export const assetsRoot = () => process.env.GALAXYTIMER_ASSETS ?? join(ROOT, 'assets');

const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// Suffixes de niveau a ignorer : "Laboratory lvl 5", "Mine level 3", "Silo 4".
const LEVEL_SUFFIX = /(?:lvl|level|niveau|niv)?\s*\d+$/i;

/** @type {Map<string, Map<string, string>>} dossier -> (cle normalisee -> fichier) */
const libraries = new Map();

/** @type {Map<string, string>} cle normalisee -> URL CDN de l'emoji d'application */
const emojiArtwork = new Map();

/** Minuscules, sans accent ni separateur : "S-Trike" et "s trike" -> "strike". */
export function normalize(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Indexe un dossier d'images. Appele au demarrage. */
export function loadLibrary(folder) {
  const dir = join(assetsRoot(), folder);
  const index = new Map();
  libraries.set(folder, index);

  if (!existsSync(dir)) return index;

  for (const file of readdirSync(dir)) {
    if (!EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const key = normalize(basename(file, extname(file)));
    // Premier arrive, premier servi : deux fichiers de meme nom normalise
    // (strike.png et s-trike.png) ne doivent pas se remplacer en silence.
    if (key && !index.has(key)) index.set(key, join(dir, file));
  }

  const aliasFile = join(dir, 'aliases.json');
  if (existsSync(aliasFile)) {
    try {
      const aliases = JSON.parse(readFileSync(aliasFile, 'utf8'));
      for (const [alias, target] of Object.entries(aliases)) {
        const file = index.get(normalize(target));
        if (file) index.set(normalize(alias), file);
        else console.warn(`[artwork] alias "${alias}" points at "${target}", which has no image`);
      }
    } catch (err) {
      console.warn(`[artwork] ${folder}/aliases.json unreadable:`, err.message);
    }
  }

  return index;
}

/**
 * Indexe les emojis de l'application comme source d'images de repli.
 *
 * Appele au demarrage avec ce que `client.application.emojis.fetch()` renvoie.
 * On ignore les emojis deja utilises comme icone de type de timer : ils n'ont
 * rien a faire dans la bibliotheque d'illustrations.
 */
export function loadEmojiArtwork(emojis, reservedNames = []) {
  emojiArtwork.clear();
  const reserved = new Set(reservedNames.map(normalize));
  for (const emoji of emojis) {
    const key = normalize(emoji.name);
    if (!key || reserved.has(key) || emojiArtwork.has(key)) continue;
    emojiArtwork.set(key, `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}?size=128`);
  }
  return emojiArtwork.size;
}

/**
 * Cherche l'image correspondant a un nom libre.
 *
 * Trois passes, de la plus sure a la plus permissive. La derniere exige 4
 * caracteres pour eviter qu'un nom court ("mine") ne se declenche au milieu
 * d'un mot sans rapport.
 */
export function resolveArtwork(folder, name) {
  if (!name) return null;
  const key = normalize(name);
  if (!key) return null;

  const file = lookup(libraries.get(folder), key, name);
  if (file) return { kind: 'file', path: file };

  // Repli sur les emojis d'application : moins bon (128x128) mais il n'y a rien
  // a deposer sur la machine.
  const url = lookup(emojiArtwork, key, name);
  return url ? { kind: 'emoji', url } : null;
}

/** Les trois passes de correspondance, communes aux deux sources. */
function lookup(index, key, name) {
  if (!index?.size) return null;

  // 1. Correspondance exacte, alias compris.
  if (index.has(key)) return index.get(key);

  // 2. Sans le suffixe de niveau : "Laboratory lvl 5" -> "laboratory".
  const withoutLevel = normalize(String(name).replace(LEVEL_SUFFIX, ''));
  if (withoutLevel && index.has(withoutLevel)) return index.get(withoutLevel);

  // 3. Le nom contient un nom d'image connu : "upgrading my starport".
  let best = null;
  for (const [candidate, value] of index) {
    if (candidate.length < 4 || !key.includes(candidate)) continue;
    if (!best || candidate.length > best.key.length) best = { key: candidate, value };
  }
  return best?.value ?? null;
}

/** Nombre d'images indexees, pour le log de demarrage. */
export function librarySize(folder) {
  return libraries.get(folder)?.size ?? 0;
}

export function emojiArtworkSize() {
  return emojiArtwork.size;
}
