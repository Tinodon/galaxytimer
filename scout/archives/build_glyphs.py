"""Construit les gabarits de caracteres depuis les captures verifiees par Noe.

    python scout/build_glyphs.py            construit et rend compte
    python scout/build_glyphs.py --check    evalue la reconnaissance obtenue

Principe : pour chaque etiquette dont on connait le pseudo exact, on decoupe
l'image en autant de morceaux qu'il y a de caracteres, et on range chaque
morceau sous sa lettre. Un caractere vu dix fois donne dix gabarits ; la
reconnaissance retient ensuite le meilleur des dix.

On ecarte les etiquettes qui debordent sur une voisine : leurs pixels
appartiennent a deux pseudos, et un gabarit construit dessus serait faux.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from glyphs import (  # noqa: E402
    align, forced_split, load_glyphs, normalise, recognise, save_glyphs,
    text_band, touches_edges, upscale_mask,
)
from popup import GRID, find_popup, tile_state  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
POPUPS = BASE_DIR / "data" / "popups"
TRUTH = json.loads((BASE_DIR / "truth.json").read_text(encoding="utf-8"))


def name_crops(popup):
    """Etiquettes des emplacements occupes, dans l'ordre de lecture."""
    width, height = popup.size
    crops = []
    for row in range(GRID["rows"]):
        for col in range(GRID["columns"]):
            left = GRID["first_left"] + col * GRID["col_pitch"]
            top = GRID["name_top"] + row * GRID["row_pitch"]
            if tile_state(popup, left, top) != "occupee":
                continue
            crops.append(popup.crop((
                int(left * width), int(top * height),
                int((left + GRID["col_width"]) * width),
                int((top + GRID["name_height"]) * height),
            )))
    return crops


def labelled_samples():
    """(etiquette, pseudo attendu) pour chaque cas verifie et exploitable."""
    for key, names in TRUTH.items():
        if key.startswith("_"):
            continue
        path = POPUPS / (key + ".jpg")
        if not path.exists():
            continue
        image = Image.open(path)
        box = find_popup(image)
        if not box:
            continue
        for crop, expected in zip(name_crops(image.crop(box)), names):
            yield key, crop, expected.upper()


def build(rounds=3):
    """Construit les gabarits, puis les affine.

    Le premier passage decoupe a intervalles reguliers, faute de gabarits pour
    faire mieux : le resultat est grossier, les lettres larges empietant sur les
    etroites. Les passages suivants realignent chaque etiquette sur les gabarits
    obtenus, ce qui corrige les frontieres, et reconstruisent des gabarits plus
    nets. Deux ou trois tours suffisent a converger.
    """
    samples = list(labelled_samples())
    glyphs = {}
    used = skipped = 0

    for round_index in range(rounds):
        collected = defaultdict(list)
        used = skipped = 0

        for key, crop, expected in samples:
            mask = text_band(upscale_mask(crop))
            if touches_edges(mask):
                # Un pseudo voisin deborde : ces pixels ne sont pas tous a nous.
                skipped += 1
                continue

            if round_index == 0:
                spans = forced_split(mask, len(expected))
            else:
                spans = align(mask, expected, glyphs)
            if not spans or len(spans) != len(expected):
                skipped += 1
                continue

            for char, span in zip(expected, spans):
                glyph = normalise(mask, span)
                if glyph is not None:
                    collected[char].append(glyph)
            used += 1

        glyphs = {c: samples_[:12] for c, samples_ in collected.items()}
        print("passage {} : {} etiquette(s) exploitees, {} caractere(s)".format(
            round_index + 1, used, len(glyphs)))

    # On borne le nombre d'exemplaires par caractere : au-dela, on ne gagne
    # plus en justesse et chaque comparaison coute du temps sur 7500 images.
    for char in glyphs:
        glyphs[char] = glyphs[char][:12]

    save_glyphs(dict(glyphs))
    print("{} etiquette(s) exploitees, {} ecartees (debordement)".format(used, skipped))
    print("{} caractere(s) distincts\n".format(len(glyphs)))

    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    missing = [c for c in alphabet if c not in glyphs]
    weak = [c for c in alphabet if 0 < len(glyphs.get(c, [])) <= 2]
    print("couverture : {}/{}".format(len(alphabet) - len(missing), len(alphabet)))
    if missing:
        print("   MANQUANTS : {}".format(" ".join(missing)))
    if weak:
        print("   fragiles  : {}".format(
            " ".join("{}({})".format(c, len(glyphs[c])) for c in weak)))


def check():
    """Relit les etiquettes connues avec les gabarits, et compte les erreurs."""
    glyphs = load_glyphs()
    if not glyphs:
        raise SystemExit("Aucun gabarit. Lance d'abord : python scout/build_glyphs.py")

    total = exact = 0
    char_ok = char_total = 0

    for key, crop, expected in labelled_samples():
        mask = text_band(upscale_mask(crop))
        if touches_edges(mask):
            continue
        spans = align(mask, expected, glyphs) or forced_split(mask, len(expected))
        read = ""
        for span in spans:
            glyph = normalise(mask, span)
            if glyph is None:
                read += "?"
                continue
            char, score = recognise(glyph, glyphs)
            read += char if score >= 0.80 else "?"

        total += 1
        if read == expected:
            exact += 1
        else:
            print("   {:<20} lu {}".format(expected, read))
        for a, b in zip(expected, read):
            char_total += 1
            char_ok += a == b

    print("\n{}/{} pseudos relus exactement ({:.0f}%)".format(
        exact, total, 100 * exact / max(total, 1)))
    print("{}/{} caracteres justes ({:.0f}%)".format(
        char_ok, char_total, 100 * char_ok / max(char_total, 1)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
    else:
        build()
