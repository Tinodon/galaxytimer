"""Reperage des systemes cliquables sur la vue carte.

On ne cherche pas a reconnaitre le TYPE de systeme (etoile rouge, amas violet,
galaxie verte...). On n'a besoin que d'une chose : ou cliquer. Detecter une
tache lumineuse sur fond noir est bien plus robuste qu'apprendre six formes, et
c'est la meme approche que celle qui distingue deja les vignettes occupees des
vignettes libres dans un popup.

    python scout/systems.py <carte.png>            liste les cibles
    python scout/systems.py <carte.png> --annotate ecrit une image annotee

L'image annotee sert a valider a l'oeil : chaque croix est un endroit ou le
crawler cliquerait.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# Zone cliquable, en fraction de la fenetre du jeu. Le haut porte la barre de
# menus et le champ de coordonnees, le bas la barre d'amis et les boutons
# ATTACK / ALLIANCES : un clic qui y tombe fait quitter la carte, et le reste du
# balayage part en vrille sans que personne s'en apercoive.
SAFE_ZONE = {"top": 0.16, "bottom": 0.79, "left": 0.01, "right": 0.99}

# Un pixel appartient a un systeme s'il est nettement plus lumineux que le fond
# spatial. Le fond est sombre et bruite d'etoiles ponctuelles, d'ou le filtrage
# par TAILLE qui suit : une etoile isolee fait quelques pixels, un systeme des
# centaines.
BRIGHTNESS_THRESHOLD = 95
MIN_BLOB_PIXELS = 220
MAX_BLOB_PIXELS = 40000

# Deux detections plus proches que ca sont le meme systeme, coupe en deux par
# une zone sombre en son milieu.
MERGE_DISTANCE = 55


def safe_box(width, height):
    return (
        int(SAFE_ZONE["left"] * width), int(SAFE_ZONE["top"] * height),
        int(SAFE_ZONE["right"] * width), int(SAFE_ZONE["bottom"] * height),
    )


def _label(mask):
    """Composantes connexes, en balayage par pile. Evite une dependance a scipy."""
    height, width = mask.shape
    labels = np.zeros((height, width), dtype=np.int32)
    current = 0
    blobs = []

    ys, xs = np.nonzero(mask)
    for start_y, start_x in zip(ys, xs):
        if labels[start_y, start_x]:
            continue
        current += 1
        stack = [(start_y, start_x)]
        labels[start_y, start_x] = current
        pixels = []
        while stack:
            y, x = stack.pop()
            pixels.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height and 0 <= nx < width \
                            and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = current
                        stack.append((ny, nx))
        blobs.append(pixels)
    return blobs


def find_systems(image):
    """Points ou cliquer. Coordonnees en pixels dans l'image fournie."""
    width, height = image.size
    x0, y0, x1, y1 = safe_box(width, height)

    grey = np.array(image.convert("L")).astype(int)
    bright = grey > BRIGHTNESS_THRESHOLD

    # Hors zone sure : on n'y cherche meme pas, pour ne jamais y cliquer.
    mask = np.zeros_like(bright)
    mask[y0:y1, x0:x1] = bright[y0:y1, x0:x1]

    # Sous-echantillonnage : diviser la resolution par 4 accelere le balayage
    # d'un facteur seize et ne coute rien, un systeme faisant des dizaines de
    # pixels de large.
    step = 4
    small = mask[::step, ::step]

    targets = []
    for pixels in _label(small):
        if not (MIN_BLOB_PIXELS // (step * step) <= len(pixels)
                <= MAX_BLOB_PIXELS // (step * step)):
            continue
        ys = [p[0] for p in pixels]
        xs = [p[1] for p in pixels]
        targets.append({
            "x": int(sum(xs) / len(xs)) * step,
            "y": int(sum(ys) / len(ys)) * step,
            "size": len(pixels) * step * step,
        })

    # Fusion des detections trop proches : un systeme peut se scinder si son
    # centre est plus sombre que ses bords.
    merged = []
    for target in sorted(targets, key=lambda t: -t["size"]):
        for kept in merged:
            if abs(kept["x"] - target["x"]) < MERGE_DISTANCE \
                    and abs(kept["y"] - target["y"]) < MERGE_DISTANCE:
                break
        else:
            merged.append(target)

    return sorted(merged, key=lambda t: (t["y"], t["x"]))


def annotate(image, targets, path):
    """Ecrit une image montrant chaque point de clic et la zone sure."""
    canvas = image.convert("RGB").copy()
    draw = ImageDraw.Draw(canvas)
    width, height = canvas.size

    x0, y0, x1, y1 = safe_box(width, height)
    draw.rectangle([x0, y0, x1, y1], outline=(255, 255, 0), width=3)
    draw.text((x0 + 8, y0 + 8), "zone de clic autorisee", fill=(255, 255, 0))

    for index, target in enumerate(targets, start=1):
        x, y, arm = target["x"], target["y"], 16
        draw.line([x - arm, y, x + arm, y], fill=(255, 40, 40), width=3)
        draw.line([x, y - arm, x, y + arm], fill=(255, 40, 40), width=3)
        draw.ellipse([x - 26, y - 26, x + 26, y + 26], outline=(255, 40, 40), width=2)
        draw.text((x + 30, y - 10), str(index), fill=(255, 255, 255))

    canvas.save(path)
    return path


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python scout/systems.py <carte.png> [--annotate]")

    source = Path(sys.argv[1])
    image = Image.open(source)
    targets = find_systems(image)

    print("image   : {}  ({}x{})".format(source.name, image.width, image.height))
    print("cibles  : {}".format(len(targets)))
    for index, target in enumerate(targets, start=1):
        print("  {:>2}  ({:>4}, {:>4})  taille {:>6}".format(
            index, target["x"], target["y"], target["size"]))

    if "--annotate" in sys.argv:
        out = source.with_name(source.stem + "_cibles.png")
        annotate(image, targets, out)
        print("\nImage annotee : {}".format(out))


if __name__ == "__main__":
    main()
