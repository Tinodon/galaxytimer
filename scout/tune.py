"""Cherche la largeur de decoupe qui resout le plus de pseudos.

Les noms longs debordent de leur vignette et empietent sur les voisines : une
decoupe large capture le nom entier mais aussi des morceaux de ses voisins,
une decoupe etroite evite la pollution mais tronque. Ce script mesure, il ne
suppose pas.

    python scout/tune.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import popup as popup_module  # noqa: E402
from names import best_match, looks_like_free_slot  # noqa: E402

SHOT = Path(__file__).resolve().parent / "captures" / "jeu_18-49-43.png"
KNOWN = ["Briankings", "SzuetamNarab", "badboytgr", "YaGirlTie", "KilledByAGirl", "Suetantsu"]
TRUTH = {0: "Briankings", 1: "SzuetamNarab", 2: "SzuetamNarab",
         3: "badboytgr", 4: "YaGirlTie"}


def run(col_width, name_top, name_height):
    popup_module.GRID["col_width"] = col_width
    popup_module.GRID["name_top"] = name_top
    popup_module.GRID["name_height"] = name_height
    result = popup_module.read_popup(Image.open(SHOT))
    if not result:
        return None

    correct = wrong = noise = 0
    for player in result["players"]:
        if looks_like_free_slot(player["name"]):
            continue
        match = best_match(player["name"], KNOWN)
        expected = TRUTH.get(player["slot"])
        if not match:
            if expected:
                pass  # occupe mais non resolu : ni bon, ni faux
            else:
                noise += 1
        elif match["name"] == expected:
            correct += 1
        else:
            wrong += 1
    return {"correct": correct, "wrong": wrong, "noise": noise,
            "coords": result["coords"]}


def main():
    print("largeur  haut   hauteur | bons  faux  bruit")
    print("-" * 48)
    best = None
    for col_width in (0.126, 0.140, 0.150, 0.165, 0.180):
        for name_top in (0.226, 0.232, 0.238):
            for name_height in (0.038, 0.045, 0.052):
                stats = run(col_width, name_top, name_height)
                if not stats:
                    continue
                print("  {:.3f}  {:.3f}  {:.3f}  |  {:>2}    {:>2}    {:>2}".format(
                    col_width, name_top, name_height,
                    stats["correct"], stats["wrong"], stats["noise"]))
                score = (stats["correct"], -stats["wrong"], -stats["noise"])
                if best is None or score > best[0]:
                    best = (score, col_width, name_top, name_height, stats)

    print("\nmeilleur reglage : col_width={} name_top={} name_height={}".format(
        best[1], best[2], best[3]))
    print("  -> {} bons, {} faux, {} bruit".format(
        best[4]["correct"], best[4]["wrong"], best[4]["noise"]))


if __name__ == "__main__":
    main()
