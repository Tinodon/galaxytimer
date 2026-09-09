"""Mesure ce que contient reellement une etiquette de pseudo.

Le decoupage en caracteres ne donnait que 2% d'exactitude, avec des etiquettes
sans aucune encre detectee : le seuil etait donc faux. On regarde les valeurs
avant de choisir.

    python scout/measure_ink.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from popup import GRID, find_popup, tile_state  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
POPUPS = BASE_DIR / "data" / "popups"
OUT = BASE_DIR / "captures"
KEY = "0_0_1124_540"
TRUTH = json.loads((BASE_DIR / "truth.json").read_text(encoding="utf-8"))[KEY]


def main():
    image = Image.open(POPUPS / (KEY + ".jpg"))
    box = find_popup(image)
    popup = image.crop(box)
    width, height = popup.size
    print("popup {}x{}\n".format(width, height))

    OUT.mkdir(exist_ok=True)
    index = 0
    for row in range(GRID["rows"]):
        for col in range(GRID["columns"]):
            left = GRID["first_left"] + col * GRID["col_pitch"]
            top = GRID["name_top"] + row * GRID["row_pitch"]
            if tile_state(popup, left, top) != "occupee":
                continue

            crop = popup.crop((
                int(left * width), int(top * height),
                int((left + GRID["col_width"]) * width),
                int((top + GRID["name_height"]) * height),
            ))
            grey = np.array(crop.convert("L")).astype(int)
            expected = TRUTH[index] if index < len(TRUTH) else "?"

            print("{:<16} decoupe {}x{}  min {:>3}  moy {:>3}  max {:>3}  p90 {:>3}".format(
                expected, crop.width, crop.height,
                grey.min(), int(grey.mean()), grey.max(), int(np.percentile(grey, 90))))

            if index < 3:
                # Agrandi pour inspection visuelle.
                crop.resize((crop.width * 6, crop.height * 6), Image.LANCZOS).save(
                    OUT / "_etiquette_{}.png".format(index))
            index += 1

    print("\nTrois etiquettes agrandies dans {}".format(OUT))


if __name__ == "__main__":
    main()
