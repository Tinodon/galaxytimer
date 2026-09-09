"""Lecture d'un popup de systeme Galaxy Life.

Lire le popup entier d'un coup ne marche pas : les pseudos sont ecrits en tres
petit sur des vignettes colorees, et Tesseract les rate presque tous. On
procede donc en trois temps :

    1. localiser le cadre du popup grace a sa bordure cyan ;
    2. lire le titre, qui contient les coordonnees du systeme ;
    3. decouper les 12 etiquettes de la grille et lire chacune separement,
       tres agrandie.

Le decoupage repose sur la grille 6x2 du jeu, exprimee en fractions de la
taille du popup — elle reste valable quelle que soit la resolution.

    python scout/popup.py <image.png>      teste sur une capture existante
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np
import pytesseract
from PIL import Image, ImageOps

# "RAN (688,852)" : le nom du systeme, puis ses coordonnees.
#
# Les coordonnees sont l'identite du systeme — c'est sur elles qu'on
# dedoublonne. Le nom est du confort d'affichage : s'il est mal lu, on garde
# quand meme l'entree.
TITLE_COORDS = re.compile(r"\(?\s*(\d{1,4})\s*[,.]\s*(\d{1,4})\s*\)?")
TITLE_NAME = re.compile(r"([A-Za-z][A-Za-z0-9 '\-]{1,22}?)\s*\(")

NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

# Geometrie de la grille, en fraction de la taille du popup.
# Geometrie mesuree, pas devinee : scout/tune.py balaie les valeurs possibles
# et retient celles qui resolvent le plus de pseudos sans jamais en confondre.
# Relancer tune.py si le jeu change de mise en page.
GRID = {
    "name_top": 0.232,     # haut de la bande de nom, premiere rangee
    "name_height": 0.052,
    "row_pitch": 0.294,    # ecart vertical entre les deux rangees
    "first_left": 0.045,   # bord gauche de la premiere colonne
    "col_pitch": 0.152,    # ecart horizontal entre colonnes
    # Nettement plus large que la vignette. Les pseudos longs debordent sur
    # leurs voisines : couper au ras de la vignette les tronque et les rend
    # irrecuperables, alors qu'un peu de pollution voisine se rattrape au
    # rapprochement.
    "col_width": 0.165,
    "columns": 6,
    "rows": 2,
}


def find_popup(image):
    """Rectangle du popup, repere par sa bordure cyan. None si absent.

    Piege : la barre superieure du jeu est du meme cyan et traverse tout
    l'ecran. On s'appuie donc d'abord sur les bords VERTICAUX, que seule la
    boite de dialogue possede, puis on ne retient que les lignes horizontales
    dont la largeur correspond a celle du popup — la barre du jeu, large de tout
    l'ecran, est ainsi ecartee.
    """
    arr = np.array(image.convert("RGB"))
    r, g, b = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)
    cyan = (g > 150) & (b > 150) & (r < 120)
    if cyan.sum() < 2000:
        return None

    height, width = cyan.shape

    # Bords verticaux : colonnes ou le cyan court sur une grande hauteur.
    columns = cyan.sum(axis=0)
    vertical = np.nonzero(columns > height * 0.2)[0]
    if len(vertical) < 2:
        return None
    x0, x1 = int(vertical.min()), int(vertical.max())
    popup_width = x1 - x0
    if popup_width < 300:
        return None

    # Bords horizontaux : lignes dont la largeur cyan colle a celle du popup.
    rows = cyan.sum(axis=1)
    matching = np.nonzero(
        (rows > popup_width * 0.7) & (rows < popup_width * 1.3)
    )[0]
    if len(matching) < 2:
        return None
    y0, y1 = int(matching.min()), int(matching.max())
    if y1 - y0 < 200:
        return None

    return (x0, y0, x1, y1)


# Corps de la vignette, sous la bande de nom, en fraction du popup.
TILE = {"top_offset": 0.06, "height": 0.17, "width_ratio": 0.85}

# Le niveau de QG : un chiffre seul, a droite du petit personnage. Bien plus
# simple a lire qu'un pseudo — un seul caractere, uniquement des chiffres, a
# position fixe. En dessous se trouve le niveau du JOUEUR, qu'on ne lit pas :
# l'API le donne deja et de facon fiable.
HQ_DIGIT = {"left": 0.085, "width": 0.042, "top": 0.155, "height": 0.055}

# Une vignette occupee est magenta (bleu nettement au-dessus du vert), une
# vignette libre est cyan (vert et bleu a egalite). Mesure sur capture reelle :
# occupees entre -25 et -37, libres a -7. Le seuil est donc large.
OCCUPIED_GREEN_BLUE_MAX = -15


# En dessous de cette luminosite, la vignette n'est pas encore dessinee : le
# popup s'affiche avant son contenu.
TILE_DRAWN_MIN_BRIGHTNESS = 62


def tile_state(popup, left, top):
    """'occupee', 'libre', ou 'vide' si la vignette n'est pas encore dessinee.

    Decide par la COULEUR, bien plus fiable que le texte : une case libre
    affiche "FREE PLANET" en minuscule, que l'OCR rend en bouillie variable
    ("coce", "lepce"...) qu'aucune liste de fautes ne peut filtrer.
    """
    width, height = popup.size
    tile = popup.crop((
        int(left * width),
        int((top + TILE["top_offset"]) * height),
        int((left + GRID["col_pitch"] * TILE["width_ratio"]) * width),
        int((top + TILE["top_offset"] + TILE["height"]) * height),
    ))
    arr = np.array(tile.convert("RGB")).astype(int)
    if arr.size == 0:
        return "vide"

    green, blue = arr[:, :, 1].mean(), arr[:, :, 2].mean()
    if arr.max(axis=2).mean() < TILE_DRAWN_MIN_BRIGHTNESS:
        return "vide"
    return "occupee" if green - blue < OCCUPIED_GREEN_BLUE_MAX else "libre"


def read_hq_level(popup, left, top):
    """Niveau de QG d'un emplacement, ou None si illisible.

    Un chiffre de 1 a 9. On restreint Tesseract aux chiffres et on lui dit
    qu'il n'y en a qu'un : c'est ce qui evite qu'il lise "4" comme "41".
    """
    width, height = popup.size
    crop = popup.crop((
        int((left + HQ_DIGIT["left"]) * width),
        int((top + HQ_DIGIT["top"]) * height),
        int((left + HQ_DIGIT["left"] + HQ_DIGIT["width"]) * width),
        int((top + HQ_DIGIT["top"] + HQ_DIGIT["height"]) * height),
    ))
    if crop.width < 3 or crop.height < 3:
        return None

    # Seuil calcule sur la vignette elle-meme. Le jeu ecrit ce chiffre en blanc
    # sur une tuile active et en gris pale sur une tuile grisee : un seuil fixe
    # regle pour l'une efface completement l'autre.
    from glyphs import otsu_threshold

    grey = crop.convert("L")
    base = otsu_threshold(np.array(grey).astype(int))

    for scale in (6, 10):
        for offset in (0, -20, 20):
            enlarged = grey.resize((grey.width * scale, grey.height * scale),
                                   Image.LANCZOS)
            binary = ImageOps.invert(
                enlarged.point(lambda p: 255 if p > base + offset else 0))
            text = pytesseract.image_to_string(
                binary,
                config="--psm 10 -c tessedit_char_whitelist=123456789",
            ).strip()
            if len(text) == 1 and text.isdigit():
                return int(text)
    return None


def is_occupied(popup, left, top):
    return tile_state(popup, left, top) == "occupee"


def slot_positions():
    """Les 12 emplacements, en fractions du popup."""
    for row in range(GRID["rows"]):
        for col in range(GRID["columns"]):
            yield (
                row * GRID["columns"] + col,
                GRID["first_left"] + col * GRID["col_pitch"],
                GRID["name_top"] + row * GRID["row_pitch"],
            )


def popup_ready(popup):
    """Le popup a-t-il fini de s'afficher ?

    Un popup complet montre douze vignettes, chacune clairement occupee ou
    libre. Pendant le chargement, le cadre est deja la mais les vignettes sont
    encore sombres. Lire a ce moment-la enregistrerait un systeme comme vide
    alors qu'il ne l'est pas — une erreur bien pire qu'une lecture ratee.
    """
    drawn = sum(
        1 for _, left, top in slot_positions()
        if tile_state(popup, left, top) != "vide"
    )
    return drawn >= GRID["columns"] * GRID["rows"], drawn


def ocr(image, scale, threshold, psm=7, whitelist=None):
    grey = image.convert("L")
    grey = grey.resize((grey.width * scale, grey.height * scale), Image.LANCZOS)
    binary = ImageOps.invert(grey.point(lambda p: 255 if p > threshold else 0))
    config = "--psm {}".format(psm)
    if whitelist:
        config += " -c tessedit_char_whitelist={}".format(whitelist)
    return pytesseract.image_to_string(binary, config=config).strip()


def best_read(image, scale, thresholds, whitelist=None):
    """Le jeu varie les fonds : on essaie plusieurs seuils, on garde le meilleur."""
    best = ""
    for threshold in thresholds:
        text = ocr(image, scale, threshold, whitelist=whitelist)
        cleaned = "".join(ch for ch in text if ch.isalnum() or ch in "_-")
        if len(cleaned) > len(best):
            best = cleaned
    return best


def read_popup(image, debug_dir=None, expected=None, tolerance=12):
    """Renvoie {'coords': (x, y), 'name': str, 'players': [...]} ou None.

    `expected` : coordonnees ou le crawler vient de naviguer. Sert a ecarter une
    lecture ou l'OCR a perdu un chiffre — un systeme affiche a l'ecran est
    forcement dans le voisinage immediat de la position courante.
    """
    box = find_popup(image)
    if not box:
        return None

    x0, y0, x1, y1 = box
    popup = image.crop((x0, y0, x1, y1))
    width, height = popup.size
    if debug_dir:
        Path(debug_dir).mkdir(parents=True, exist_ok=True)
        popup.save(Path(debug_dir) / "popup.png")

    # --- Titre ---
    #
    # L'OCR perd parfois un chiffre : "(716,866)" ressort en "(71,866)". Des
    # coordonnees fausses sont pires que pas de coordonnees — elles envoient
    # quelqu'un au mauvais endroit. On lit donc plusieurs fois avec des reglages
    # differents et on confronte les resultats.
    title_img = popup.crop((0, 0, width, int(height * 0.09)))
    candidates = []
    for scale in (3, 4, 5):
        for threshold in (120, 150, 180):
            text = ocr(title_img, scale, threshold)
            match = TITLE_COORDS.search(text)
            if match:
                candidates.append((int(match.group(1)), int(match.group(2)), text))

    coords, title_text = None, ""
    if candidates:
        if expected:
            # Le crawler sait ou il a navigue : un systeme visible est
            # forcement a quelques unites de la. On retient la lecture la plus
            # proche, ce qui elimine d'office un chiffre manquant.
            plausible = [
                c for c in candidates
                if abs(c[0] - expected[0]) <= tolerance
                and abs(c[1] - expected[1]) <= tolerance
            ]
            if plausible:
                best = min(plausible, key=lambda c: abs(c[0] - expected[0]) + abs(c[1] - expected[1]))
                coords, title_text = (best[0], best[1]), best[2]
        else:
            # Sans reference, on prend la lecture la plus frequente : une erreur
            # d'OCR se repete rarement a l'identique sur trois reglages.
            counts = {}
            for x, y, text in candidates:
                counts.setdefault((x, y), []).append(text)
            best_key = max(counts, key=lambda k: len(counts[k]))
            coords, title_text = best_key, counts[best_key][0]

    # L'OCR coupe parfois le nom en morceaux ("^ZM IDI" pour AZMIDI) et ajoute
    # un caractere parasite en tete. On recolle tous les morceaux plutot que de
    # n'en garder qu'un — ne prendre que le dernier donnait "IDI".
    name_match = TITLE_NAME.search(title_text)
    system_name = None
    if name_match:
        joined = "".join(ch for ch in name_match.group(1) if ch.isalnum()).upper()
        system_name = joined.lstrip("0123456789") or None

    # --- Les 12 emplacements ---
    players = []
    for row in range(GRID["rows"]):
        for col in range(GRID["columns"]):
            slot = row * GRID["columns"] + col
            left = GRID["first_left"] + col * GRID["col_pitch"]
            top = GRID["name_top"] + row * GRID["row_pitch"]

            if not is_occupied(popup, left, top):
                continue

            crop = popup.crop((
                int(left * width), int(top * height),
                int((left + GRID["col_width"]) * width),
                int((top + GRID["name_height"]) * height),
            ))
            if debug_dir:
                crop.save(Path(debug_dir) / "nom_r{}c{}.png".format(row, col))

            name = best_read(crop, 6, (110, 140, 170, 200), whitelist=NAME_CHARS)
            players.append({
                "slot": slot,
                "name": name,
                "hq": read_hq_level(popup, left, top),
            })

    return {
        "coords": coords,
        "name": system_name,
        "title": title_text,
        "players": players,
    }


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python scout/popup.py <image.png> [--debug]")

    image = Image.open(sys.argv[1])
    debug = Path(__file__).parent / "debug" if "--debug" in sys.argv else None
    result = read_popup(image, debug_dir=debug)

    if not result:
        print("Aucun popup detecte dans cette image.")
        return

    print("titre lu    : {!r}".format(result["title"]))
    print("coordonnees : {}".format(result["coords"] or "NON LUES"))
    print("emplacements :")
    for player in result["players"]:
        label = player["name"] or "(vide ou illisible)"
        print("   {:>2}  {}".format(player["slot"], label))


if __name__ == "__main__":
    main()
