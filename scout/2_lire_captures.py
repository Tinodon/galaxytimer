"""Etape 2 : lit les captures du scan, reconnait les pseudos, trie les images.

    python 2_lire_captures.py                    toutes les captures a traiter
    python 2_lire_captures.py --ecran 360_12     seulement celles d'un ecran du scan
    python 2_lire_captures.py --limit 50         s'arrete apres 50 captures
    python 2_lire_captures.py --workers 4        coeurs utilises (4 par defaut)

Pour chaque capture de data/captures/1_a_traiter/ :
  1. lit les coordonnees et le nom de la galaxie dans le titre ;
  2. pour chaque joueur, trois preuves ensemble (moteur/match.py, match_slot) :
     le dictionnaire des vrais pseudos, l'accord des 4 lectures OCR, et les
     lettres de l'image posees une a une ;
  3. RENOMME l'image : E<ecran x>_<ecran y>__G<galaxie x>_<galaxie y>.jpg ;
  4. la RANGE :
       2_validees/    tous les pseudos reconnus ;
       3_a_verifier/  au moins un pseudo a regarder a la main. A cote de
                      l'image, une copie ..._ENTOURE.png ou les pseudos rates
                      sont entoures en rouge et les reconnus ecrits en vert ;
  5. ecrit le resultat a trois endroits :
       data/resultats/joueurs_trouves.txt  une ligne par joueur : "pseudo x,y"
       data/resultats/systems_resolus.jsonl  le detail, pour 3_publier_carte.py
       data/journaux/lecture.txt             le deroule capture par capture

Rien n'est jamais supprime : les images sont DEPLACEES, pas effacees. Un pseudo
douteux n'est jamais publie : il reste "a verifier". Mieux vaut une vignette a
regarder qu'un joueur faux sur la carte.

Environ 10 a 30 secondes par capture (la verification lettre par lettre est ce
qui coute) : lancer le gros lot la nuit.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "moteur"))

import chemins  # noqa: E402

# Initialise une fois par processus : le dictionnaire de 482 000 pseudos met
# plusieurs secondes a se charger, on ne le recharge pas a chaque image.
_ROSTER = None
_GLYPHS = None


def _init_worker():
    global _ROSTER, _GLYPHS
    from glyphs import load_glyphs
    from match import Roster
    _ROSTER = Roster()
    _GLYPHS = load_glyphs()


def screen_of(filename):
    """`360_12_712_396.jpg` -> (360, 12) : l'ecran du scan ou la capture a ete prise."""
    parts = Path(filename).stem.split("_")
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return None


def new_name(screen, coords):
    sx, sy = screen if screen else ("????", "????")
    g = "G{:04d}_{:04d}".format(*coords) if coords else "G____-____"
    return "E{}_{}__{}".format(
        "{:04d}".format(sx) if isinstance(sx, int) else sx,
        "{:04d}".format(sy) if isinstance(sy, int) else sy, g)


def read_one(path_str):
    """Lit une capture. Execute dans un processus separe."""
    from PIL import Image

    from glyphs import align, compare, normalise, text_band, upscale_mask
    from popup import GRID, find_popup, read_popup

    def letters_score(mask, name):
        expected = [c for c in name.upper() if c.isalnum()]
        if not expected or any(c not in _GLYPHS for c in expected):
            return 0.0
        spans = align(mask, expected, _GLYPHS)
        if not spans:
            return 0.0
        total = 0.0
        for char, span in zip(expected, spans):
            glyph = normalise(mask, span)
            total += max(compare(glyph, s) for s in _GLYPHS[char]) if glyph else 0.0
        return total / len(expected)

    path = Path(path_str)
    screen = screen_of(path.name)
    image = Image.open(path).convert("RGB")
    result = read_popup(image, expected=screen)
    if not result or not result.get("coords"):
        return {"file": path.name, "screen": screen, "error": "popup ou coordonnees illisibles"}

    box = find_popup(image)
    popup = image.crop(box)
    width, height = popup.size

    tiles = []
    for player in result["players"]:
        row, col = divmod(player["slot"], GRID["columns"])
        left = GRID["first_left"] + col * GRID["col_pitch"]
        top = GRID["name_top"] + row * GRID["row_pitch"]
        crop_box = (int(left * width), int(top * height),
                    int((left + GRID["col_width"]) * width),
                    int((top + GRID["name_height"]) * height))
        mask = text_band(upscale_mask(popup.crop(crop_box)))
        reads = player.get("reads") or []
        decision = _ROSTER.match_slot(
            reads, level=player.get("level"),
            verify=lambda name, m=mask: letters_score(m, name))
        tiles.append({
            "slot": player["slot"] + 1,
            "box": [crop_box[0] + box[0], crop_box[1] + box[1],
                    crop_box[2] + box[0], crop_box[3] + box[1]],
            "reads": reads,
            "name": decision.get("name"),
            "reason": decision.get("reason"),
            "letters": decision.get("letters", {}),
            "hq": player.get("hq"),
            "level": player.get("level"),
        })

    return {
        "file": path.name,
        "screen": screen,
        "coords": list(result["coords"]),
        "system": result.get("name"),
        "tiles": tiles,
    }


def annotate(source, destination, tiles):
    """Copie de la capture : reconnus en vert, rates entoures en rouge."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    for tile in tiles:
        x0, y0, x1, y1 = tile["box"]
        if tile["name"]:
            draw.rectangle((x0, y0, x1, y1), outline="lime", width=2)
            draw.text((x0, y1 + 1), tile["name"], fill="lime", font=font)
        else:
            draw.ellipse((x0 - 6, y0 - 6, x1 + 6, y1 + 6), outline="red", width=3)
            draw.text((x0, y1 + 1), "place {} ?".format(tile["slot"]), fill="red", font=font)
    image.save(destination)


def unique(path):
    """Ne jamais ecraser : ajoute _2, _3... si le nom existe deja."""
    if not path.exists():
        return path
    index = 2
    while True:
        candidate = path.with_name("{}_{}{}".format(path.stem, index, path.suffix))
        if not candidate.exists():
            return candidate
        index += 1


def record(result):
    """Ligne au format lu par 3_publier_carte.py (moteur/upload.py)."""
    return {
        "x": result["coords"][0],
        "y": result["coords"][1],
        "name": result["system"],
        # score 1.0 = reconnu avec les trois preuves ; 0 = a verifier, jamais publie.
        "players": [{
            "raw": min(t["reads"], key=len) if t["reads"] else "",
            "name": t["name"],
            "score": 1.0 if t["name"] else 0.0,
            "reads": t["reads"],
            "slot": t["slot"],
        } for t in result["tiles"]],
        "hq": [t["hq"] for t in result["tiles"]],
        "levels": [t["level"] for t in result["tiles"]],
        "source": result["new_name"],
        "screen": list(result["screen"]) if result["screen"] else None,
        "at": int(time.time()),
        "reader": "2_lire_captures",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ecran", help="seulement les captures d'un ecran, ex. 360_12")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=4,
                        help="chaque coeur charge le dictionnaire (~1 Go de memoire)")
    args = parser.parse_args()

    for folder in (chemins.VALIDEES, chemins.A_VERIFIER, chemins.RESULTATS, chemins.JOURNAUX):
        folder.mkdir(parents=True, exist_ok=True)

    shots = sorted(chemins.A_TRAITER.glob("*.jpg"))
    if args.ecran:
        shots = [s for s in shots if s.name.startswith(args.ecran + "_")]
    if args.limit:
        shots = shots[:args.limit]
    if not shots:
        raise SystemExit("Aucune capture a traiter dans {}".format(chemins.A_TRAITER))

    print("{} capture(s) a lire, {} coeur(s)".format(len(shots), args.workers))
    print("Chargement du dictionnaire des joueurs dans chaque coeur...\n")

    started = time.time()
    counts = {"validees": 0, "a_verifier": 0, "pseudos_ok": 0, "pseudos_a_voir": 0}
    journal = chemins.JOURNAUX / "lecture.txt"

    # Le .jsonl porte tout le detail, mais il est illisible pour un humain.
    # A cote, une liste toute simple : un joueur, ses coordonnees.
    trouves = chemins.RESULTATS / "joueurs_trouves.txt"

    with ProcessPoolExecutor(max_workers=args.workers, initializer=_init_worker) as pool, \
            journal.open("a", encoding="utf-8") as log, \
            trouves.open("a", encoding="utf-8") as simple, \
            chemins.SYSTEMES_LUS.open("a", encoding="utf-8") as results:
        futures = {pool.submit(read_one, str(s)): s for s in shots}
        for done, future in enumerate(as_completed(futures), start=1):
            source = futures[future]
            try:
                result = future.result()
            except Exception as error:  # noqa: BLE001 — une image ratee n'arrete pas le lot
                result = {"file": source.name, "screen": screen_of(source.name),
                          "error": "plantage : {}".format(error)}

            if "error" in result:
                target = unique(chemins.A_VERIFIER / "{}__ILLISIBLE.jpg".format(
                    new_name(result["screen"], None)))
                source.rename(target)
                counts["a_verifier"] += 1
                line = "[A VERIFIER] {} : {}".format(target.name, result["error"])
            else:
                failed = [t for t in result["tiles"] if not t["name"]]
                folder = chemins.A_VERIFIER if failed else chemins.VALIDEES
                target = unique(folder / "{}.jpg".format(new_name(result["screen"], result["coords"])))
                result["new_name"] = target.name
                results.write(json.dumps(record(result), ensure_ascii=False) + "\n")
                results.flush()
                for tile in result["tiles"]:
                    if tile["name"]:
                        simple.write("{} {},{}\n".format(
                            tile["name"], result["coords"][0], result["coords"][1]))
                simple.flush()
                if failed:
                    annotate(source, target.with_name(target.stem + "__ENTOURE.png"), result["tiles"])
                source.rename(target)

                counts["a_verifier" if failed else "validees"] += 1
                counts["pseudos_ok"] += len(result["tiles"]) - len(failed)
                counts["pseudos_a_voir"] += len(failed)
                names = ", ".join(t["name"] or "??? (place {})".format(t["slot"])
                                  for t in result["tiles"]) or "vide"
                line = "[{}] {} {} ({},{}) : {}".format(
                    "A VERIFIER" if failed else "OK", target.name, result["system"] or "?",
                    result["coords"][0], result["coords"][1], names)

            print(line)
            log.write(line + "\n")
            log.flush()

            if done % 25 == 0:
                rate = done / max(time.time() - started, 1)
                print("  ... {}/{}  ~{:.0f} min restantes".format(
                    done, len(shots), (len(shots) - done) / max(rate, 1e-6) / 60))

    minutes = (time.time() - started) / 60
    total_tiles = counts["pseudos_ok"] + counts["pseudos_a_voir"]
    print("\nTermine en {:.0f} min.".format(minutes))
    print("  captures validees    : {}".format(counts["validees"]))
    print("  captures a verifier  : {}  -> {}".format(counts["a_verifier"], chemins.A_VERIFIER))
    if total_tiles:
        print("  pseudos reconnus     : {}/{} ({:.0f} %)".format(
            counts["pseudos_ok"], total_tiles, 100 * counts["pseudos_ok"] / total_tiles))
    # Le dossier a_partager n'a pas l'etape 3 (elle demande les acces a la base).
    if (Path(__file__).resolve().parent / "3_publier_carte.py").exists():
        print("\nPour mettre la carte du bot a jour : python 3_publier_carte.py")
    else:
        # Le dossier a_partager est lu par quelqu'un qui ne parle pas francais.
        print("\nDone. Your results are in:")
        print("  data/resultats/joueurs_trouves.txt   one player and their coordinates per line")
        print("  data/captures/2_validees             photos fully read")
        print("  data/captures/3_a_verifier           photos with a name left to check")
        print("When you are finished, send the data/captures and data/resultats")
        print("folders to Noe (see README.md, step 7).")


if __name__ == "__main__":
    main()
