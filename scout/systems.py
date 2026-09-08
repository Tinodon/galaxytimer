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

# Zone cliquable, en PIXELS depuis les bords de la fenetre du jeu.
#
# En fractions, la zone se decalait quand Noe redimensionnait le jeu : elle
# mordait sur la barre de ressources d'une petite fenetre tout en coupant des
# systemes sur une grande. L'interface du jeu, elle, garde la meme taille en
# pixels quelle que soit la fenetre — c'est donc en pixels qu'il faut l'ecarter.
#
# En haut : menu (Free Gifts... Support) puis barre de coordonnees et ressources.
# En bas : boutons ATTACK / ALLIANCES et la barre d'amis. Un clic qui y tombe
# fait quitter la carte, et le reste du balayage part en vrille sans que
# personne s'en apercoive.
SAFE_MARGINS = {"top": 185, "bottom": 185, "left": 8, "right": 8}

# On cherche le COEUR brillant d'un systeme, pas son halo.
#
# Mesures sur capture reelle (scout/measure_pixels.py), pic de luminosite :
#   systemes, meme les plus pales   253-255
#   nebuleuses de fond              103
#   fond vide                        48
# Le pic separe donc net ce qu'on garde de ce qu'on rejette.
#
# La saturation, elle, ne separe rien : le texte "3/12" affiche 158 quand MISAM
# et ALGEDI, qui sont des systemes a garder, plafonnent a 83. S'en servir
# supprimait les systemes pales tout en gardant le texte — exactement l'inverse
# du but. Elle n'est plus utilisee.
CORE_BRIGHTNESS = 200

# Le texte et l'interface passent aussi le seuil de luminosite. Ils sont en
# revanche formes de traits FINS, la ou un coeur de systeme est une tache
# compacte : quelques passes d'erosion effacent les uns et laissent les autres.
EROSION_PASSES = 2

MIN_BLOB_PIXELS = 120
MAX_BLOB_PIXELS = 40000

# Distance de fusion volontairement courte. Les coeurs restent distincts meme
# quand les halos se touchent : une valeur genereuse fusionnait MISAM dans
# UKDAH et ALGEDI dans TUREIS, qui sont des systemes differents.
MERGE_DISTANCE = 45

# On ne filtre PAS sur la lisibilite du nom affiche sur la carte : le titre du
# popup porte deja le nom ET les coordonnees ("RAN (688,852)"). Un systeme dont
# l'etiquette est tronquee a l'ecran reste donc parfaitement exploitable une
# fois ouvert. On clique le plus de systemes possible, et ceux deja vus sont
# reconnus a leurs coordonnees puis refermes aussitot.

# Le curseur de la souris est une forme blanche compacte : il passe le seuil de
# luminosite et survit a l'erosion. On l'ecarte en le connaissant — le crawler
# ecarte la souris avant chaque capture — mais sur une capture prise a la main
# il faut pouvoir l'ignorer explicitement.
CURSOR_RADIUS = 45


def safe_box(width, height):
    return (
        SAFE_MARGINS["left"], SAFE_MARGINS["top"],
        width - SAFE_MARGINS["right"], height - SAFE_MARGINS["bottom"],
    )


def erode(mask, passes):
    """Erosion morphologique, en numpy pur pour eviter une dependance a scipy.

    Un pixel ne survit que si ses quatre voisins sont allumes. Les traits fins
    du texte disparaissent en une ou deux passes, une tache compacte non.
    """
    for _ in range(passes):
        kept = mask.copy()
        kept[1:, :] &= mask[:-1, :]
        kept[:-1, :] &= mask[1:, :]
        kept[:, 1:] &= mask[:, :-1]
        kept[:, :-1] &= mask[:, 1:]
        mask = kept
    return mask


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


def find_systems(image, cursor=None):
    """Points ou cliquer. Coordonnees en pixels dans l'image fournie.

    `cursor` : position de la souris au moment de la capture, si connue. Le
    curseur est une forme blanche compacte que rien ne distingue d'un coeur de
    systeme ; le seul moyen fiable de l'ecarter est de savoir ou il est.
    """
    width, height = image.size
    x0, y0, x1, y1 = safe_box(width, height)

    rgb = np.array(image.convert("RGB")).astype(int)
    cores = rgb.max(axis=2) > CORE_BRIGHTNESS

    # Hors zone sure : on n'y cherche meme pas, pour ne jamais y cliquer.
    mask = np.zeros_like(cores)
    mask[y0:y1, x0:x1] = cores[y0:y1, x0:x1]
    mask = erode(mask, EROSION_PASSES)

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

    # Fusion des detections trop proches : un coeur peut se scinder en deux si
    # une zone sombre le traverse.
    merged = []
    for target in sorted(targets, key=lambda t: -t["size"]):
        for kept in merged:
            if abs(kept["x"] - target["x"]) < MERGE_DISTANCE \
                    and abs(kept["y"] - target["y"]) < MERGE_DISTANCE:
                break
        else:
            merged.append(target)

    if cursor:
        merged = [
            t for t in merged
            if abs(t["x"] - cursor[0]) > CURSOR_RADIUS
            or abs(t["y"] - cursor[1]) > CURSOR_RADIUS
        ]

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
        colour = (60, 255, 90)
        draw.line([x - arm, y, x + arm, y], fill=colour, width=3)
        draw.line([x, y - arm, x, y + arm], fill=colour, width=3)
        draw.ellipse([x - 26, y - 26, x + 26, y + 26], outline=colour, width=2)
        draw.text((x + 30, y - 10), str(index), fill=colour)

    canvas.save(path)
    return path


def process(source, write_image):
    image = Image.open(source)
    targets = find_systems(image)

    print("\n{}  ({}x{})  ->  {} cible(s)".format(
        source.name, image.width, image.height, len(targets)))
    for index, target in enumerate(targets, start=1):
        print("  {:>2}  ({:>4}, {:>4})  taille {:>6}".format(
            index, target["x"], target["y"], target["size"]))

    if write_image:
        out = source.with_name(source.stem + "_cibles.png")
        annotate(image, targets, out)
        print("  -> {}".format(out.name))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    annotate_flag = "--annotate" in sys.argv

    if "--all" in sys.argv or not args:
        # Sans argument, on traite tout le dossier : recopier un nom de fichier
        # horodate a la main est une source d'erreur inutile.
        folder = Path(__file__).resolve().parent / "captures"
        shots = sorted(
            p for p in folder.glob("jeu_*.png") if not p.stem.endswith("_cibles")
        )
        if not shots:
            raise SystemExit(
                "Aucune capture dans {}.\n"
                "Lance d'abord : python scout/calibrate.py".format(folder)
            )
        print("{} capture(s) a traiter".format(len(shots)))
        for shot in shots:
            process(shot, annotate_flag)
        if annotate_flag:
            print("\nImages annotees ecrites a cote des captures, suffixe _cibles.png")
        return

    for name in args:
        process(Path(name), annotate_flag)


if __name__ == "__main__":
    main()
