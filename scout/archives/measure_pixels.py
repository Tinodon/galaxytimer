"""Mesure luminosite et saturation sur des zones connues d'une capture.

Sert a choisir les seuils de detection sur des chiffres plutot qu'au jugé. On
compare ce qu'on veut GARDER (les systemes, y compris les plus pales) a ce
qu'on veut REJETER (le texte, le curseur, les nebuleuses de fond).

    python scout/measure_pixels.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

CAPTURES = Path(__file__).resolve().parent / "captures"
SHOT = CAPTURES / "jeu_01-26-25.png"

# Zones relevees a la main sur la capture : (x, y, largeur, hauteur).
ZONES = [
    ("CHARA (vif, cyan)", 660, 280, 80, 80, "garder"),
    ("MIAPLACIDUS (vif, jaune)", 1210, 240, 80, 80, "garder"),
    ("SAIPH (vif, rouge)", 1760, 730, 80, 80, "garder"),
    ("MISAM (pale, blanchatre)", 630, 490, 80, 80, "GARDER - rate"),
    ("ALGEDI (pale, blanchatre)", 620, 720, 90, 80, "GARDER - rate"),
    ("texte 'CHARA 3/12'", 680, 350, 100, 50, "rejeter"),
    ("curseur souris", 1290, 505, 50, 50, "rejeter"),
    ("nebuleuse (fausse cible 7)", 320, 630, 80, 80, "REJETER - faux positif"),
    ("nebuleuse (fausse cible 8)", 1270, 630, 80, 80, "REJETER - faux positif"),
    ("fond vide", 400, 300, 80, 80, "rejeter"),
    ("bouton GO HOME", 600, 865, 90, 30, "rejeter"),
]


def main():
    if not SHOT.exists():
        raise SystemExit("capture absente : {}".format(SHOT))

    rgb = np.array(Image.open(SHOT).convert("RGB")).astype(int)
    value = rgb.max(axis=2)
    spread = value - rgb.min(axis=2)
    saturation = np.where(value > 0, spread * 255 // np.maximum(value, 1), 0)

    print("{:<30} {:>8} {:>8} {:>8} {:>8}   {}".format(
        "zone", "lum.moy", "lum.max", "sat.moy", "sat.max", "attendu"))
    print("-" * 88)

    for label, x, y, w, h, expected in ZONES:
        v = value[y:y + h, x:x + w]
        s = saturation[y:y + h, x:x + w]
        # On regarde le 95e centile plutot que le maximum : un pixel isole ne
        # doit pas decider a lui seul.
        print("{:<30} {:>8.0f} {:>8.0f} {:>8.0f} {:>8.0f}   {}".format(
            label, v.mean(), np.percentile(v, 95), s.mean(), np.percentile(s, 95), expected))


if __name__ == "__main__":
    main()
