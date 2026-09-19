"""Mesure le temps de traitement d'un popup.

Decide l'architecture : si le traitement est plus rapide qu'un clic dans le jeu,
un processus separe suit le rythme et rien ne s'accumule sur le disque. Sinon,
il faut stocker les images et traiter plus tard — au prix de dizaines de Go.

    python scout/measure_speed.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from popup import find_popup, read_popup  # noqa: E402
from systems import find_systems  # noqa: E402

CAPTURES = Path(__file__).resolve().parent / "captures"
ROUNDS = 5


def timed(label, fn, rounds=ROUNDS):
    # Un premier passage a vide : le tout premier appel paie des initialisations
    # qui ne se reproduisent pas.
    fn()
    start = time.perf_counter()
    for _ in range(rounds):
        fn()
    per_call = (time.perf_counter() - start) / rounds
    print("  {:<38} {:>7.0f} ms".format(label, per_call * 1000))
    return per_call


def main():
    popup_shot = CAPTURES / "jeu_18-49-43.png"
    map_shot = CAPTURES / "jeu_18-49-20.png"
    if not popup_shot.exists() or not map_shot.exists():
        raise SystemExit("captures de reference absentes dans scout/captures/")

    popup_image = Image.open(popup_shot)
    popup_image.load()
    map_image = Image.open(map_shot)
    map_image.load()

    print("Temps de traitement, moyenne sur {} passages\n".format(ROUNDS))
    detect = timed("localiser le popup", lambda: find_popup(popup_image))
    full = timed("lire un popup entier (5 joueurs)", lambda: read_popup(popup_image))
    systems = timed("reperer les systemes d'une vue carte", lambda: find_systems(map_image))

    print("\n  lecture des pseudos seule : {:.0f} ms".format((full - detect) * 1000))

    # Un cycle complet, tel que le crawler l'enchainera.
    per_screen = systems + 12 * full
    print("\nPar ecran (1 carte + 12 popups) : {:.1f} s de calcul".format(per_screen))
    print("Sur 54756 ecrans : {:.1f} heures de calcul pur".format(
        per_screen * 54756 / 3600))
    print("\nA comparer au temps de JEU : un clic, l'ouverture d'un popup et sa")
    print("fermeture prennent 1 a 2 s chacun dans un jeu qui rame, soit")
    print("{:.1f} a {:.1f} heures rien qu'a manipuler l'interface.".format(
        54756 * 12 * 2 / 3600, 54756 * 12 * 4 / 3600))


if __name__ == "__main__":
    main()
