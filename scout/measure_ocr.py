"""Compare des strategies d'OCR pour lire les pseudos d'un popup.

Le cout actuel vient du nombre d'appels a Tesseract : 5 pseudos x 4 seuils, soit
20 appels payant chacun son demarrage. Deux pistes :

  - assembler les etiquettes en UNE image et n'appeler Tesseract qu'une fois ;
  - reduire l'agrandissement et le nombre de seuils.

On mesure la vitesse ET la justesse : un OCR deux fois plus rapide qui perd un
pseudo sur deux ne sert a rien.

    python scout/measure_ocr.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytesseract  # noqa: E402

from names import best_match  # noqa: E402
from popup import GRID, NAME_CHARS, find_popup, is_occupied  # noqa: E402

CAPTURES = Path(__file__).resolve().parent / "captures"
KNOWN = ["Briankings", "SzuetamNarab", "badboytgr", "YaGirlTie", "KilledByAGirl", "Suetantsu"]
TRUTH = ["Briankings", "SzuetamNarab", "SzuetamNarab", "badboytgr", "YaGirlTie"]


def name_crops(popup):
    """Les etiquettes des emplacements occupes, dans l'ordre."""
    width, height = popup.size
    crops = []
    for row in range(GRID["rows"]):
        for col in range(GRID["columns"]):
            left = GRID["first_left"] + col * GRID["col_pitch"]
            top = GRID["name_top"] + row * GRID["row_pitch"]
            if not is_occupied(popup, left, top):
                continue
            crops.append(popup.crop((
                int(left * width), int(top * height),
                int((left + GRID["col_width"]) * width),
                int((top + GRID["name_height"]) * height),
            )))
    return crops


def binarise(image, scale, threshold):
    grey = image.convert("L")
    grey = grey.resize((grey.width * scale, grey.height * scale), Image.LANCZOS)
    return ImageOps.invert(grey.point(lambda p: 255 if p > threshold else 0))


def strategy_per_crop(crops, scale, thresholds):
    """L'existant : un appel par etiquette et par seuil."""
    results = []
    for crop in crops:
        best = ""
        for threshold in thresholds:
            text = pytesseract.image_to_string(
                binarise(crop, scale, threshold),
                config="--psm 7 -c tessedit_char_whitelist=" + NAME_CHARS,
            ).strip()
            cleaned = "".join(c for c in text if c.isalnum() or c in "_-")
            if len(cleaned) > len(best):
                best = cleaned
        results.append(best)
    return results


def strategy_stacked(crops, scale, threshold):
    """Toutes les etiquettes empilees en une image, un seul appel."""
    prepared = [binarise(crop, scale, threshold) for crop in crops]
    if not prepared:
        return []
    gap = 20
    width = max(p.width for p in prepared)
    height = sum(p.height for p in prepared) + gap * (len(prepared) + 1)
    canvas = Image.new("L", (width, height), 255)
    y = gap
    for image in prepared:
        canvas.paste(image, (0, y))
        y += image.height + gap

    text = pytesseract.image_to_string(
        canvas, config="--psm 6 -c tessedit_char_whitelist=" + NAME_CHARS
    )
    lines = [
        "".join(c for c in line if c.isalnum() or c in "_-")
        for line in text.splitlines() if line.strip()
    ]
    return lines


def strategy_stacked_multi(crops, scale, thresholds):
    """Empilage repete a plusieurs seuils : on garde la meilleure lecture par
    ligne. Un seul appel par seuil au lieu d'un par etiquette et par seuil."""
    passes = [strategy_stacked(crops, scale, threshold) for threshold in thresholds]
    results = []
    for index in range(len(crops)):
        candidates = [p[index] for p in passes if index < len(p)]
        # Le rapprochement gagne a avoir la lecture la plus complete : une
        # etiquette tronquee s'ecarte plus du vrai nom qu'une etiquette bruitee.
        results.append(max(candidates, key=len) if candidates else "")
    return results


def score(results):
    """Combien de pseudos sont correctement rapproches."""
    good = 0
    for read, expected in zip(results, TRUTH):
        match = best_match(read, KNOWN)
        if match and match["name"] == expected:
            good += 1
    return good


def bench(label, fn, rounds=3):
    fn()
    start = time.perf_counter()
    for _ in range(rounds):
        results = fn()
    elapsed = (time.perf_counter() - start) / rounds
    print("  {:<42} {:>7.0f} ms   {}/{} bons".format(
        label, elapsed * 1000, score(results), len(TRUTH)))
    return elapsed, results


def main():
    shot = CAPTURES / "jeu_18-49-43.png"
    if not shot.exists():
        raise SystemExit("capture de reference absente")

    image = Image.open(shot)
    box = find_popup(image)
    popup = image.crop(box)
    crops = name_crops(popup)
    print("{} etiquettes occupees\n".format(len(crops)))

    bench("actuel : x6, 4 seuils, 1 appel/etiquette",
          lambda: strategy_per_crop(crops, 6, (110, 140, 170, 200)))
    bench("x4, 2 seuils",
          lambda: strategy_per_crop(crops, 4, (140, 190)))
    bench("x3, 1 seuil",
          lambda: strategy_per_crop(crops, 3, (170,)))
    for scale in (3, 4, 6):
        for threshold in (140, 170, 200):
            bench("empile : x{}, seuil {}, 1 seul appel".format(scale, threshold),
                  lambda s=scale, t=threshold: strategy_stacked(crops, s, t))

    print()
    bench("empile x4, 3 seuils, meilleur par ligne",
          lambda: strategy_stacked_multi(crops, 4, (140, 170, 200)))
    bench("empile x4, 4 seuils, meilleur par ligne",
          lambda: strategy_stacked_multi(crops, 4, (110, 140, 170, 200)))
    bench("empile x6, 3 seuils, meilleur par ligne",
          lambda: strategy_stacked_multi(crops, 6, (140, 170, 200)))


if __name__ == "__main__":
    main()
