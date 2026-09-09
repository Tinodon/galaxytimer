"""Lit les popups captures pendant le balayage et remplit la base.

Le crawler ne lit rien pendant la nuit : il capture et il range. C'est ici que
les images deviennent des donnees. Separer les deux a trois avantages :

  - le balayage va cinq fois plus vite, donc couvre cinq fois plus de carte ;
  - on peut retraiter les memes images si la lecture s'ameliore, sans rejouer
    une nuit de balayage ;
  - un echec de lecture n'interrompt pas le balayage.

    python scout/process.py            traite tout ce qui n'a pas ete traite
    python scout/process.py --all      retraite meme les images deja lues
    python scout/process.py --limit 50 s'arrete apres 50 images

Le nom des fichiers porte la position ou le crawler avait navigue :
`700_860_412_318.jpg` — ecran (700,860), clic a (412,318) dans la fenetre. Cette
position sert a valider les coordonnees lues, l'OCR perdant parfois un chiffre.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from popup import read_popup  # noqa: E402
from store import SystemStore  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
POPUPS_DIR = DATA_DIR / "popups"
PROCESSED_FILE = DATA_DIR / "popups_traites.json"


def load_processed():
    if PROCESSED_FILE.exists():
        try:
            return set(json.loads(PROCESSED_FILE.read_text()))
        except json.JSONDecodeError:
            pass
    return set()


def save_processed(names):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_FILE.write_text(json.dumps(sorted(names)))


def position_from_name(name):
    """`700_860_412_318.jpg` -> (700, 860), la position de l'ecran."""
    parts = Path(name).stem.split("_")
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true",
                        help="retraite les images deja lues")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    if not POPUPS_DIR.exists():
        raise SystemExit("Aucun popup capture dans {}".format(POPUPS_DIR))

    shots = sorted(POPUPS_DIR.glob("*.jpg"))
    processed = set() if args.all else load_processed()
    todo = [s for s in shots if s.name not in processed]

    if not todo:
        print("{} image(s) au total, toutes deja traitees.".format(len(shots)))
        return

    print("{} image(s) a traiter sur {}".format(len(todo), len(shots)))
    store = SystemStore()
    print("Base avant : {}\n".format(store.summary()))

    new = duplicates = unreadable = 0
    for index, shot in enumerate(todo, start=1):
        if args.limit and index > args.limit:
            break

        expected = position_from_name(shot.name)
        # L'image est deja rognee au popup : read_popup redetecte le cadre, ce
        # qui fonctionne aussi bien sur un popup seul que sur un plein ecran.
        result = read_popup(Image.open(shot), expected=expected)

        if not result or not result["coords"]:
            unreadable += 1
            print("  ! {}  coordonnees illisibles".format(shot.name))
        else:
            x, y = result["coords"]
            players = [p["name"] for p in result["players"] if p["name"]]
            if store.has(x, y):
                duplicates += 1
            else:
                new += 1
                print("  + {:<12} ({},{})  {}".format(
                    result["name"] or "?", x, y,
                    ", ".join(players) or "aucun joueur"))
            store.record(x, y, result["name"], players, screen=expected)

        processed.add(shot.name)
        if index % 25 == 0:
            save_processed(processed)
            print("  ... {}/{}".format(index, len(todo)))

    save_processed(processed)
    print("\n{} nouveau(x), {} deja connu(s), {} illisible(s)".format(
        new, duplicates, unreadable))
    print("Base apres : {}".format(store.summary()))


if __name__ == "__main__":
    main()
