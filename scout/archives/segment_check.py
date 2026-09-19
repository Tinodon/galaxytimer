"""Verifie que les lettres d'un pseudo se decoupent proprement.

Avant de construire des gabarits, il faut savoir si les caracteres sont
separables par colonnes vides. Si deux lettres se touchent, le decoupage
produira un bloc pour deux caracteres et tout le reste sera decale.

    python scout/segment_check.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from glyphs import ink_mask, segment_columns, text_band, touches_edges  # noqa: E402
from popup import GRID, find_popup, tile_state  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
POPUPS = BASE_DIR / "data" / "popups"
TRUTH = json.loads((BASE_DIR / "truth.json").read_text(encoding="utf-8"))


def name_crops(popup):
    """Les etiquettes des emplacements occupes, dans l'ordre de lecture."""
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


def main():
    total = exact = short = long_ = overflow = 0

    for key, names in TRUTH.items():
        if key.startswith("_"):
            continue
        path = POPUPS / (key + ".jpg")
        if not path.exists():
            print("capture absente : {}".format(path.name))
            continue

        image = Image.open(path)
        box = find_popup(image)
        if not box:
            print("popup non detecte : {}".format(path.name))
            continue

        crops = name_crops(image.crop(box))
        print("\n{}  —  {} etiquette(s) occupees, {} pseudo(s) fournis".format(
            key, len(crops), len(names)))

        for crop, expected in zip(crops, names):
            mask = text_band(ink_mask(crop))
            spans = segment_columns(mask)
            edge = touches_edges(mask)
            total += 1

            if len(spans) == len(expected):
                exact += 1
                verdict = "ok"
            elif len(spans) < len(expected):
                short += 1
                verdict = "COLLE"
            else:
                long_ += 1
                verdict = "COUPE"
            if edge:
                overflow += 1
                verdict += " + deborde"

            print("   {:<20} {:>2} lettres, {:>2} blocs   {}".format(
                expected, len(expected), len(spans), verdict))

    print("\n{} etiquettes : {} exactes, {} sous-decoupees, {} sur-decoupees".format(
        total, exact, short, long_))
    print("{} debordent sur une voisine".format(overflow))
    if total:
        print("taux de decoupage exact : {:.0f}%".format(100 * exact / total))


if __name__ == "__main__":
    main()
