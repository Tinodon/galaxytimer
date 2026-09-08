"""Extraction des pseudos et coordonnees depuis le texte lu par l'OCR.

ATTENTION : les motifs ci-dessous sont provisoires. Ils sont ecrits a partir de
ce que l'affichage du jeu est SUPPOSE contenir, pas de ce qu'il contient
reellement — personne n'a encore fourni de capture. Ils seront remplaces des
qu'on aura du texte reel (voir scout/calibrate.py).

Regle de conduite de ce module : dans le doute, ne rien renvoyer. Une
coordonnee inventee pollue la base et envoie quelqu'un attaquer dans le vide,
ce qui est pire que pas de donnee du tout.
"""

from __future__ import annotations

import re

MAX_COORD = 1408

# "512,340" / "512, 340" / "512 340" / "(512,340)" / "X:512 Y:340"
COORD_PATTERNS = [
    re.compile(r"[Xx]\s*[:=]\s*(\d{1,4})\D{1,4}[Yy]\s*[:=]\s*(\d{1,4})"),
    re.compile(r"\(\s*(\d{1,4})\s*[,;]\s*(\d{1,4})\s*\)"),
    re.compile(r"\b(\d{1,4})\s*[,;]\s*(\d{1,4})\b"),
]

# Un pseudo Galaxy Life : lettres, chiffres, espaces internes, quelques signes.
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._\-\[\]]{2,23}$")

# Mots de l'interface qu'on ne doit jamais prendre pour un pseudo.
UI_WORDS = {
    "attack", "colonize", "colony", "coordinates", "galaxy", "level", "map",
    "planet", "player", "search", "starbase", "system", "back", "close",
    "alliance", "info", "profile", "cancel", "ok", "zoom",
}


def valid_coord(x, y):
    return 0 <= x <= MAX_COORD and 0 <= y <= MAX_COORD


def find_coords(text):
    """Toutes les paires de coordonnees plausibles d'un texte, dedoublonnees."""
    found = []
    seen = set()
    for pattern in COORD_PATTERNS:
        for match in pattern.finditer(text):
            x, y = int(match.group(1)), int(match.group(2))
            if not valid_coord(x, y) or (x, y) in seen:
                continue
            seen.add((x, y))
            found.append((x, y))
    return found


def looks_like_name(line):
    line = line.strip()
    if not NAME_PATTERN.match(line):
        return False
    if line.lower() in UI_WORDS:
        return False
    # Un "pseudo" entierement numerique est un nombre lu de travers.
    return not line.replace(" ", "").isdigit()


def parse(text):
    """Associe chaque coordonnee au pseudo le plus proche AU-DESSUS d'elle.

    Hypothese a confirmer sur de vraies captures : l'interface affiche le nom du
    proprietaire puis, en dessous, la position. Si l'ordre reel est inverse, il
    n'y a qu'a inverser le parcours ici.
    """
    results = []
    current_name = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        coords = find_coords(line)
        if coords:
            if current_name:
                for x, y in coords:
                    results.append({"name": current_name, "x": x, "y": y})
            continue

        if looks_like_name(line):
            current_name = line

    return results
