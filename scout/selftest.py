"""Verifie la chaine de lecture d'un popup sur une capture reelle.

    python scout/selftest.py [image.png]

Sans argument, prend la capture de reference livree avec le projet. Sert de
garde-fou : si une modification casse la detection du popup, la lecture des
coordonnees ou le rapprochement des pseudos, ce script le dit tout de suite.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from match import level_growth_fits  # noqa: E402
from names import best_match, looks_like_free_slot, similarity  # noqa: E402
from popup import read_popup  # noqa: E402

DEFAULT_SHOT = Path(__file__).resolve().parent / "captures" / "jeu_18-49-43.png"

# Ce que contient reellement ce systeme, verifie a l'oeil sur la capture.
EXPECTED_COORDS = (688, 852)
EXPECTED_PLAYERS = ["Briankings", "SzuetamNarab", "SzuetamNarab", "badboytgr", "YaGirlTie"]

# Pseudos plausibles du voisinage, tels que l'API les orthographie. Sert de
# dictionnaire de rapprochement pour le test.
KNOWN = ["Briankings", "SzuetamNarab", "badboytgr", "YaGirlTie", "KilledByAGirl", "Suetantsu"]

failures = []


def check(label, condition, detail=""):
    print("  {}  {}{}".format("ok  " if condition else "ECHEC", label,
                              "" if condition else "   <- " + detail))
    if not condition:
        failures.append(label)


def check_levels():
    """Le controle par niveau, sur des cas reels verifies contre l'API.

    Sans capture requise : il tourne toujours.
    """
    print("Controle par niveau (vignette -> API aujourd'hui) :")
    # Vraie Myra : 89 sur la capture, 96 deux jours plus tard. L'ancienne
    # regle (un cran d'ecart) l'aurait rejetee.
    check("Myra 89 -> 96 acceptee", level_growth_fits(89, 96))
    check("meme niveau accepte", level_growth_fits(128, 128))
    # Fausses attributions reelles, trouvees sur les popups de truth.json.
    for label, tile, api in [("Noster", 4, 101), ("Meowbah", 23, 281),
                             ("IcyKat", 3, 0), ("SamuelAbel", 62, 0)]:
        check("{} {} -> {} rejete".format(label, tile, api),
              not level_growth_fits(tile, api))
    print()


def main():
    check_levels()
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SHOT
    if not path.exists():
        # Les captures ne sont pas versionnees : elles montrent un ecran de jeu
        # et le depot est public. Sans elles, ce test n'a rien a verifier.
        print("Capture de reference absente : {}".format(path.name))
        print("Lance scout/calibrate.py, ouvre un popup de systeme, puis relance.")
        return 1 if failures else 0

    print("Capture : {}\n".format(path.name))
    result = read_popup(Image.open(path))
    check("popup detecte", result is not None)
    if not result:
        raise SystemExit(1)

    check("coordonnees lues", result["coords"] == EXPECTED_COORDS,
          "lu {} au lieu de {}".format(result["coords"], EXPECTED_COORDS))

    occupied = [p for p in result["players"] if not looks_like_free_slot(p["name"])]
    check("emplacements occupes", len(occupied) == len(EXPECTED_PLAYERS),
          "{} detectes au lieu de {}".format(len(occupied), len(EXPECTED_PLAYERS)))

    print("\n  lectures et rapprochements :")
    resolved = []
    for player in occupied:
        match = best_match(player["name"], KNOWN)
        label = "{} ({:.2f})".format(match["name"], match["score"]) if match else "NON RESOLU"
        print("    slot {:>2}  {:<18} -> {}".format(player["slot"], player["name"], label))
        if match:
            resolved.append(match["name"])

    # On ne demande pas que TOUS soient resolus : une lecture trop abimee doit
    # etre abandonnee plutot que rapprochee au hasard. On demande qu'aucun
    # rapprochement ne soit FAUX.
    print()
    wrong = [n for n in resolved if n not in EXPECTED_PLAYERS]
    check("aucun rapprochement faux", not wrong, "faux : {}".format(wrong))
    check("au moins 3 joueurs resolus", len(resolved) >= 3,
          "{} resolus".format(len(resolved)))

    print("\n  separation bons / mauvais rapprochements :")
    good = min(similarity(a, b) for a, b in [
        ("SRIANKINGS", "Briankings"),
        ("YAGIRUTIE", "YaGirlTie"),
        ("SZUETANNNARAE", "SzuetamNarab"),
        ("BADBOYTGR", "badboytgr"),
    ])
    bad = max(similarity(a, b) for a, b in [
        ("YAGIRUTIE", "KilledByAGirl"),
        ("SRIANKINGS", "badboytgr"),
        ("BADBOYTGR", "Briankings"),
        ("SZUETANNARAB", "Suetantsu"),
    ])
    print("    pire bon rapprochement : {:.3f}".format(good))
    print("    meilleur mauvais       : {:.3f}".format(bad))
    check("marge suffisante", good - bad > 0.25,
          "marge de seulement {:.3f}".format(good - bad))

    print("\n{}".format("TOUT PASSE" if not failures else "{} ECHEC(S)".format(len(failures))))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
