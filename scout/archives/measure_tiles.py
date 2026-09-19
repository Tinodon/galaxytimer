"""Mesure la couleur dominante des 12 vignettes d'un popup.

But : decider si un emplacement est occupe par sa COULEUR plutot que par ce que
l'OCR croit y lire. Une vignette occupee est magenta, une vignette libre est
cyan — c'est un signal bien plus fiable qu'un texte minuscule.

    python scout/measure_tiles.py [image.png]
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from popup import GRID, find_popup  # noqa: E402

SHOT = Path(sys.argv[1]) if len(sys.argv) > 1 else (
    Path(__file__).resolve().parent / "captures" / "jeu_18-49-43.png"
)

# Ce que contient reellement la capture de reference.
OCCUPIED_SLOTS = {0, 1, 2, 3, 4}

# Corps de la vignette, sous la bande de nom, en fraction du popup.
TILE_TOP_OFFSET = 0.06
TILE_HEIGHT = 0.17

image = Image.open(SHOT).convert("RGB")
box = find_popup(image)
if not box:
    raise SystemExit("aucun popup detecte")

x0, y0, x1, y1 = box
popup = image.crop(box)
width, height = popup.size
print("popup {}x{}\n".format(width, height))
print("slot  occupe  R    G    B    | r-b   g-b")
print("-" * 48)

for row in range(GRID["rows"]):
    for col in range(GRID["columns"]):
        slot = row * GRID["columns"] + col
        left = GRID["first_left"] + col * GRID["col_pitch"]
        top = GRID["name_top"] + row * GRID["row_pitch"] + TILE_TOP_OFFSET
        crop = popup.crop((
            int(left * width), int(top * height),
            int((left + GRID["col_pitch"] * 0.85) * width),
            int((top + TILE_HEIGHT) * height),
        ))
        arr = np.array(crop).astype(int)
        r, g, b = (arr[:, :, i].mean() for i in range(3))
        print("{:>3}   {:>5}   {:>4.0f} {:>4.0f} {:>4.0f} | {:>5.0f} {:>5.0f}".format(
            slot, "oui" if slot in OCCUPIED_SLOTS else "non", r, g, b, r - b, g - b))
