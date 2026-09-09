"""Lit toutes les captures de popup et sort ce qu'elles contiennent.

Pour chaque capture reconnue comme un popup de systeme :

    NOM (X, Y)
      emplacement N : pseudo lu  ->  vrai pseudo, si l'API le reconnait

    python scout/report.py            lecture seule, hors ligne
    python scout/report.py --resolve  rapproche chaque pseudo d'un vrai compte

L'option --resolve interroge api.galaxylifegame.net. Elle coute plusieurs
requetes par pseudo : acceptable pour valider une dizaine de captures, hors de
question pendant un balayage de dizaines de milliers d'ecrans. Le crawler
stockera la lecture brute et rapprochera plus tard, hors ligne.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from names import best_match, canonical  # noqa: E402
from popup import find_popup, read_popup  # noqa: E402

CAPTURES = Path(__file__).resolve().parent / "captures"

_cache = {}


def api_search(fragment):
    import requests

    if fragment in _cache:
        return _cache[fragment]
    try:
        response = requests.get(
            "https://api.galaxylifegame.net/Users/search",
            params={"name": fragment}, timeout=10,
        )
        body = response.text.strip()
        result = json.loads(body) if body.startswith("[") else []
    except Exception:  # noqa: BLE001
        result = []
    _cache[fragment] = result
    return result


def resolve(ocr_name, max_queries=12):
    """Cherche le vrai pseudo a partir d'une lecture approximative.

    L'API fait de la recherche par SOUS-CHAINE mais n'est pas tolerante : un
    seul caractere faux et elle ne renvoie rien. On essaie donc des fragments,
    du plus long au plus court, puis on confirme par similarite pour ne pas
    retenir un homonyme.
    """
    flat = "".join(c for c in ocr_name if c.isalnum())
    if len(flat) < 4:
        return None

    tried = 0
    for length in range(len(flat), 3, -1):
        for start in range(0, len(flat) - length + 1):
            if tried >= max_queries:
                return None
            tried += 1
            candidates = api_search(flat[start:start + length])
            if not candidates:
                continue
            match = best_match(ocr_name, [c["Name"] for c in candidates])
            if match:
                return match
    return None


def main():
    do_resolve = "--resolve" in sys.argv
    shots = sorted(
        p for p in CAPTURES.glob("jeu_*.png") if not p.stem.endswith("_cibles")
    )
    if not shots:
        raise SystemExit("Aucune capture dans {}".format(CAPTURES))

    popups = 0
    for shot in shots:
        image = Image.open(shot)
        if not find_popup(image):
            continue

        result = read_popup(image)
        if not result:
            continue
        popups += 1

        header = "{} {}".format(
            result["name"] or "(nom non lu)",
            result["coords"] or "(coordonnees NON LUES)",
        )
        print("\n{}".format(header))
        print("  {}".format(shot.name))

        if not result["players"]:
            print("  aucun emplacement occupe")
            continue

        for player in result["players"]:
            line = "  emplacement {:>2} : {:<20}".format(player["slot"], player["name"])
            if do_resolve:
                match = resolve(player["name"])
                line += " -> {}".format(
                    "{} ({:.2f})".format(match["name"], match["score"])
                    if match else "non resolu"
                )
            print(line)

    print("\n{} popup(s) lu(s) sur {} capture(s).".format(popups, len(shots)))
    if not do_resolve and popups:
        print("Ajoute --resolve pour rapprocher les pseudos des vrais comptes.")


if __name__ == "__main__":
    main()
