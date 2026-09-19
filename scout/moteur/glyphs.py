"""Construction et usage de gabarits de caracteres.

L'OCR generaliste est le mauvais outil ici : Tesseract est fait pour lire du
texte inconnu dans une police inconnue, alors que Galaxy Life affiche toujours
la meme police, a la meme taille, aux memes pixels. Un `A` de SADALBARI est
identique a un `A` de NUSAKAN.

On decoupe donc chaque caractere une fois, depuis des captures dont Noe a
confirme le contenu, et on compare pixel a pixel. Sur du texte de jeu, cette
methode depasse largement l'OCR — et elle donne un score de confiance par
caractere, ce que Tesseract ne fournit pas de facon exploitable.

    python scout/glyphs.py --build     construit les gabarits depuis la verite
    python scout/glyphs.py --report    montre ce qui est couvert
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

BASE_DIR = Path(__file__).resolve().parent
TRUTH_FILE = BASE_DIR / "truth.json"
GLYPH_FILE = BASE_DIR / "glyphs.json"

# Pas de seuil fixe : le jeu affiche les pseudos en DEUX regimes. Une tuile
# active ecrit en blanc pur (255), une tuile grisee en gris pale qui plafonne
# vers 133. Un seuil unique reglé pour les unes efface completement les autres —
# c'est ce qui donnait des etiquettes sans aucune encre detectee.
#
# On calcule donc le seuil sur CHAQUE etiquette, par la methode d'Otsu : elle
# cherche la coupure qui separe le mieux deux populations de pixels, sans rien
# supposer de leur luminosite absolue.

# Taille normalisee des gabarits. Toutes les etiquettes font la meme taille dans
# le jeu, mais le rognage du popup peut varier d'un pixel ou deux.
#
# La LARGEUR aussi est fixe : comparer deux tableaux de meme forme se fait par
# une simple difference, la ou redimensionner a chaque comparaison coutait cent
# fois plus cher — et l'alignement en fait des dizaines de milliers.
# La largeur reelle n'est pas perdue pour autant : elle est comparee a part,
# c'est elle qui distingue un I d'un M.
# Une grille PLUS FINE que la source, jamais plus grossiere. Un caractere fait
# une douzaine de pixels dans le jeu et le double apres agrandissement ; le
# ramener a dix, comme au premier essai, effacait les details qui distinguent un
# E d'un L ou un G d'un 6, et faisait tomber la lecture sous Tesseract.
GLYPH_HEIGHT = 24
GLYPH_WIDTH = 18

# Poids de l'ecart de largeur dans le score. Trop haut, deux lettres de meme
# forme mais de largeur differente ne se rapprochent jamais ; trop bas, un I
# passe pour un M.
WIDTH_WEIGHT = 0.25

# Une colonne compte comme separateur si elle contient moins que ca d'encre.
COLUMN_INK_MIN = 1


def otsu_threshold(grey):
    """Coupure qui separe le mieux le fond du texte, quelle que soit sa clarte."""
    histogram = np.bincount(grey.ravel(), minlength=256).astype(float)
    total = histogram.sum()
    if total == 0:
        return 128

    levels = np.arange(256)
    weight_low = np.cumsum(histogram)
    weight_high = total - weight_low
    sum_low = np.cumsum(histogram * levels)
    sum_total = sum_low[-1]

    with np.errstate(invalid="ignore", divide="ignore"):
        mean_low = sum_low / weight_low
        mean_high = (sum_total - sum_low) / weight_high
        between = weight_low * weight_high * (mean_low - mean_high) ** 2

    between[~np.isfinite(between)] = 0
    return int(np.argmax(between))


def ink_mask(image):
    """Pixels d'encre d'une etiquette, seuil calcule sur l'etiquette elle-meme."""
    grey = np.array(image.convert("L")).astype(int)
    return grey > otsu_threshold(grey)


def text_band(mask, min_rows=4):
    """Restreint le masque a la bande ou se trouve reellement le texte.

    La decoupe deborde sur le haut de la vignette en dessous : sans ce
    recadrage, les pixels de l'avatar comptent comme de l'encre et collent les
    lettres entre elles.
    """
    rows = mask.sum(axis=1)
    if not rows.any():
        return mask

    # On decoupe en bandes denses separees par des creux, puis on prend LA PLUS
    # HAUTE — pas la plus chargee.
    #
    # Partir de la ligne la plus chargee semblait sur, et ne l'etait pas : sur
    # une vignette decoree, le sprite qui deborde par le bas est plus dense que
    # le pseudo lui-meme. Le lecteur cadrait alors le decor au lieu du nom et
    # rendait une suite de lettres tiree de rien (MYRA lu "omesue"). La grille
    # place le nom en haut du recadrage : la premiere bande est la bonne.
    floor = max(1, rows.max() * 0.15)
    bands = []
    start = None
    for index, value in enumerate(rows):
        if value >= floor and start is None:
            start = index
        elif value < floor and start is not None:
            bands.append((start, index - 1))
            start = None
    if start is not None:
        bands.append((start, len(rows) - 1))

    # Une bande trop courte ou trop legere est un artefact (bord de vignette,
    # bruit JPEG), pas une ligne de texte.
    mass = {band: int(rows[band[0]:band[1] + 1].sum()) for band in bands}
    heaviest = max(mass.values()) if mass else 0
    usable = [
        band for band in bands
        if band[1] - band[0] + 1 >= min_rows and mass[band] >= heaviest * 0.3
    ]
    if not usable:
        return mask

    top, bottom = usable[0]
    return mask[top:bottom + 1, :]


def segment_columns(mask):
    """Decoupe en caracteres par colonnes vides.

    Les pseudos du jeu sont ecrits sans chevauchement interne, donc une colonne
    sans encre separe deux lettres. Ce qui se chevauche, ce sont les pseudos
    VOISINS, pas les lettres d'un meme pseudo.
    """
    columns = mask.sum(axis=0)
    spans = []
    start = None
    for x, value in enumerate(columns):
        if value >= COLUMN_INK_MIN and start is None:
            start = x
        elif value < COLUMN_INK_MIN and start is not None:
            spans.append((start, x))
            start = None
    if start is not None:
        spans.append((start, len(columns)))
    return spans


# Agrandissement applique avant tout decoupage. A 114 pixels pour dix lettres,
# l'anticrenelage relie les caracteres voisins et aucune colonne n'est vraiment
# vide ; en agrandissant, les creux redeviennent exploitables.
UPSCALE = 4


def upscale_mask(image, factor=UPSCALE):
    """Agrandit l'etiquette AVANT de seuiller, pour separer les lettres collees."""
    grey = image.convert("L")
    grey = grey.resize((grey.width * factor, grey.height * factor), Image.LANCZOS)
    array = np.array(grey).astype(int)
    return array > otsu_threshold(array)


def forced_split(mask, count):
    """Decoupe une etiquette en `count` caracteres.

    Le decoupage par colonnes vides echoue : a cette taille les lettres se
    touchent. Mais on connait le nombre de caracteres attendu, donc on cherche
    les `count - 1` coupures qui traversent le moins d'encre, en imposant une
    largeur minimale a chaque morceau pour ne pas tout couper au meme endroit.
    """
    columns = mask.sum(axis=0)
    inked = np.nonzero(columns)[0]
    if not len(inked) or count < 1:
        return []

    start, end = int(inked.min()), int(inked.max()) + 1
    span = end - start
    if count == 1:
        return [(start, end)]

    average = span / count
    # Une coupure ne peut pas tomber a moins de 40% de la largeur moyenne d'un
    # caractere du bord d'un autre : sinon on produit des morceaux vides.
    margin = max(1, int(average * 0.4))

    cuts = []
    for index in range(1, count):
        ideal = start + average * index
        low = max(start + margin, int(ideal - average * 0.45))
        high = min(end - margin, int(ideal + average * 0.45) + 1)
        if low >= high:
            cuts.append(int(ideal))
            continue
        window = columns[low:high]
        # A creux egal, on prefere la coupure la plus proche de la position
        # theorique — sinon les caracteres larges volent de la place aux etroits.
        penalty = window + np.abs(np.arange(low, high) - ideal) * 0.01
        cuts.append(int(low + np.argmin(penalty)))

    edges = [start] + sorted(cuts) + [end]
    return [(edges[i], edges[i + 1]) for i in range(count)]


def align(mask, expected, glyphs, min_width=4, max_width=None):
    """Trouve les frontieres de caracteres qui collent le mieux aux gabarits.

    Le decoupage a intervalles reguliers echoue parce que les lettres n'ont pas
    la meme largeur : un M prend deux fois la place d'un I. Ici on connait la
    suite de caracteres attendue, et on cherche par programmation dynamique la
    facon de la poser sur l'image qui maximise la ressemblance totale.

    Renvoie la liste des (debut, fin), ou None si aucun decoupage n'est possible.
    """
    columns = mask.sum(axis=0)
    inked = np.nonzero(columns)[0]
    if not len(inked):
        return None
    start, end = int(inked.min()), int(inked.max()) + 1
    width = end - start
    count = len(expected)
    if count == 0 or width < count * min_width:
        return None

    # Bornes serrees autour de la largeur moyenne. Sans elles, l'alignement
    # teste chaque position contre chaque largeur possible et le calcul explose :
    # aucune lettre ne fait la moitie ni le double du reste du pseudo.
    average = width / count
    low_width = max(min_width, int(average * 0.45))
    high_width = max(low_width + 1, int(average * 1.85))
    if max_width is not None:
        high_width = min(high_width, max_width)

    # best[i][x] : meilleur score pour avoir place les i premiers caracteres en
    # s'arretant a la colonne x.
    NEG = float("-inf")
    best = [[NEG] * (width + 1) for _ in range(count + 1)]
    back = [[0] * (width + 1) for _ in range(count + 1)]
    best[0][0] = 0.0

    # Un meme morceau est evalue pour plusieurs caracteres : on ne le
    # renormalise pas a chaque fois.
    pieces = {}

    def piece_at(x, w):
        if (x, w) not in pieces:
            pieces[(x, w)] = normalise(mask, (start + x, start + x + w))
        return pieces[(x, w)]

    for i, char in enumerate(expected):
        samples = glyphs.get(char)
        for x in range(width + 1):
            if best[i][x] == NEG:
                continue
            # Les caracteres restants doivent tenir dans ce qui reste.
            remaining = count - i - 1
            for w in range(low_width, high_width + 1):
                nx = x + w
                if nx > width - remaining * low_width:
                    break
                piece = piece_at(x, w)
                if piece is None:
                    continue
                if samples:
                    score = max(compare(piece, sample) for sample in samples)
                else:
                    # Caractere encore inconnu : on ne le penalise pas, sinon
                    # aucun decoupage ne serait possible au premier passage.
                    score = 0.5
                total = best[i][x] + score
                if total > best[i + 1][nx]:
                    best[i + 1][nx] = total
                    back[i + 1][nx] = x

    if best[count][width] == NEG:
        return None

    spans, x = [], width
    for i in range(count, 0, -1):
        px = back[i][x]
        spans.append((start + px, start + x))
        x = px
    return list(reversed(spans))


def touches_edges(mask, margin=1):
    """L'encre touche-t-elle le bord de la decoupe ?

    C'est le signe qu'un pseudo voisin deborde dans cette etiquette. Dans ce cas
    on ne peut rien affirmer, et il vaut mieux le dire que d'inventer.
    """
    if not mask.any():
        return False
    left = mask[:, :margin].any()
    right = mask[:, -margin:].any()
    return bool(left or right)


def normalise(mask, span):
    """Extrait un caractere, le cadre sur son encre, et le ramene a taille fixe.

    Renvoie (grille, largeur reelle). La grille sert a comparer les formes, la
    largeur a distinguer les caracteres etroits des larges.
    """
    x0, x1 = span
    piece = mask[:, x0:x1]
    rows = np.nonzero(piece.any(axis=1))[0]
    cols = np.nonzero(piece.any(axis=0))[0]
    if not len(rows) or not len(cols):
        return None
    piece = piece[rows.min():rows.max() + 1, cols.min():cols.max() + 1]
    real_width = piece.shape[1]

    image = Image.fromarray((piece * 255).astype(np.uint8))
    grid = np.array(image.resize((GLYPH_WIDTH, GLYPH_HEIGHT), Image.LANCZOS)) > 127
    return grid, real_width


def signature(grid):
    """Represente un gabarit par une chaine, pour le stocker en JSON."""
    return "".join("".join("1" if v else "0" for v in row) for row in grid)


def from_signature(text):
    values = np.array([c == "1" for c in text])
    return values.reshape(GLYPH_HEIGHT, GLYPH_WIDTH)


def load_glyphs():
    if not GLYPH_FILE.exists():
        return {}
    raw = json.loads(GLYPH_FILE.read_text(encoding="utf-8"))
    return {
        char: [(from_signature(s["bits"]), s["width"]) for s in samples]
        for char, samples in raw.items()
    }


def save_glyphs(glyphs):
    payload = {
        char: [{"width": width, "bits": signature(grid)} for grid, width in samples]
        for char, samples in sorted(glyphs.items())
    }
    GLYPH_FILE.write_text(json.dumps(payload), encoding="utf-8")


def compare(a, b):
    """Score entre deux caracteres, 0 a 1.

    a et b sont des couples (grille, largeur reelle). Les grilles ont la meme
    forme, donc la comparaison est une simple difference. L'ecart de largeur
    entre en compte a part : sans lui, un I et un M se ressemblent une fois
    etires a la meme taille.
    """
    grid_a, width_a = a
    grid_b, width_b = b
    shape = float((grid_a == grid_b).mean())
    ratio = min(width_a, width_b) / max(width_a, width_b, 1)
    return shape * (1 - WIDTH_WEIGHT) + ratio * WIDTH_WEIGHT


def recognise(glyph, glyphs):
    """Meilleur caractere pour ce caractere lu, avec son score de confiance."""
    best_char, best_score = None, 0.0
    for char, samples in glyphs.items():
        for sample in samples:
            score = compare(glyph, sample)
            if score > best_score:
                best_char, best_score = char, score
    return best_char, best_score
