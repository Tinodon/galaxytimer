"""Lit les popups captures pendant le balayage et remplit la base.

Le crawler ne lit rien pendant la nuit : il capture et il range. C'est ici que
les images deviennent des donnees. Separer les deux a trois avantages :

  - le balayage va cinq fois plus vite, donc couvre cinq fois plus de carte ;
  - on peut retraiter les memes images si la lecture s'ameliore, sans rejouer
    une nuit de balayage ;
  - un echec de lecture n'interrompt pas le balayage.

    python scout/process.py               traite ce qui n'a pas ete traite
    python scout/process.py --all         retraite meme les images deja lues
    python scout/process.py --limit 50    s'arrete apres 50 images
    python scout/process.py --workers 4   limite le nombre de coeurs utilises

La lecture d'un popup coute environ cinq secondes : une nuit de balayage en
produit assez pour occuper une machine onze heures. Le travail est donc reparti
sur tous les coeurs — chaque image est independante des autres, rien ne s'y
oppose. Sur seize coeurs, les onze heures tombent sous l'heure.

Le nom des fichiers porte la position ou le crawler avait navigue :
`700_860_412_318.jpg` — ecran (700,860), clic a (412,318) dans la fenetre. Cette
position sert a valider les coordonnees lues, l'OCR perdant parfois un chiffre.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
POPUPS_DIR = DATA_DIR / "popups"
PROCESSED_FILE = DATA_DIR / "popups_traites.json"

sys.path.insert(0, str(BASE_DIR))


def position_from_name(name):
    """`700_860_412_318.jpg` -> (700, 860), la position de l'ecran."""
    parts = Path(name).stem.split("_")
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return None


def read_one(path_str):
    """Lit une image. Executee dans un processus separe, d'ou les imports ici."""
    from PIL import Image

    from popup import read_popup

    path = Path(path_str)
    try:
        result = read_popup(Image.open(path), expected=position_from_name(path.name))
    except Exception as error:  # noqa: BLE001
        return {"file": path.name, "error": str(error)}

    if not result or not result["coords"]:
        return {"file": path.name, "error": "coordonnees illisibles"}

    return {
        "file": path.name,
        "x": result["coords"][0],
        "y": result["coords"][1],
        "name": result["name"],
        "players": [p["name"] for p in result["players"] if p["name"]],
        # Toutes les lectures de chaque emplacement, une par seuil. resolve.py
        # choisira celle qui designe un joueur reel : ici on n'a pas de quoi
        # trancher, et trancher trop tot perdait le bon candidat.
        "reads": [p.get("reads") or ([p["name"]] if p["name"] else [])
                  for p in result["players"] if p["name"]],
        "screen": position_from_name(path.name),
    }


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=0,
                        help="nombre de coeurs (defaut : tous sauf un)")
    args = parser.parse_args()

    if not POPUPS_DIR.exists():
        raise SystemExit("Aucun popup capture dans {}".format(POPUPS_DIR))

    shots = sorted(POPUPS_DIR.glob("*.jpg"))
    processed = set() if args.all else load_processed()
    todo = [s for s in shots if s.name not in processed]
    if args.limit:
        todo = todo[:args.limit]

    if not todo:
        print("{} image(s) au total, toutes deja traitees.".format(len(shots)))
        return

    # Un coeur reste libre : la machine doit rester utilisable pendant que ca
    # tourne, ce sont plusieurs dizaines de minutes.
    workers = args.workers or max(1, (os.cpu_count() or 2) - 1)

    from store import SystemStore

    store = SystemStore()
    print("{} image(s) a traiter sur {}".format(len(todo), len(shots)))
    print("{} coeur(s) — estimation : {:.0f} min".format(
        workers, len(todo) * 5 / workers / 60))
    print("Base avant : {}\n".format(store.summary()))

    new = duplicates = unreadable = 0
    started = time.time()
    done = 0

    # L'ecriture en base reste dans le processus principal : un seul fichier,
    # un seul ecrivain, pas de course a gerer.
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(read_one, str(path)): path for path in todo}
        for future in as_completed(futures):
            result = future.result()
            done += 1

            if "error" in result:
                unreadable += 1
            else:
                if store.has(result["x"], result["y"]):
                    duplicates += 1
                else:
                    new += 1
                    print("  + {:<14} ({},{})  {} colonie(s)".format(
                        result["name"] or "?", result["x"], result["y"],
                        len(result["players"])))
                store.record(result["x"], result["y"], result["name"],
                             result["players"], screen=result["screen"],
                             source=result["file"], reads=result.get("reads"))

            processed.add(result["file"])

            if done % 200 == 0:
                save_processed(processed)
                rate = done / max(time.time() - started, 1)
                left = (len(todo) - done) / max(rate, 0.01) / 60
                print("  ... {}/{}  ({:.1f} img/s, ~{:.0f} min restantes)".format(
                    done, len(todo), rate, left))

    save_processed(processed)
    elapsed = (time.time() - started) / 60
    print("\n{} nouveau(x), {} deja connu(s), {} illisible(s) en {:.0f} min".format(
        new, duplicates, unreadable, elapsed))
    print("Base : {}".format(store.summary()))


if __name__ == "__main__":
    main()
