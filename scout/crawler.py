"""Balayage automatique de la carte Galaxy Life.

Pour chaque position de la grille : ecrire les coordonnees, valider, capturer,
reperer les systemes, ouvrir chacun, lire ses joueurs, refermer, passer au
suivant.

    python scout/crawler.py --dry-run     ne clique nulle part, montre le plan
    python scout/crawler.py --one         une seule position, pour verifier
    python scout/crawler.py               balayage complet
    python scout/crawler.py --resume      reprend ou le dernier s'est arrete

ECHAP interrompt proprement a tout moment : le fichier de systemes est ecrit au
fil de l'eau, rien n'est perdu.

Trois garde-fous, parce qu'un automate qui derape sans surveillance fait des
degats silencieux :
  - la zone de clic exclut les barres du jeu (voir scout/systems.py) ;
  - apres chaque clic, on verifie qu'un popup s'est bien ouvert, et apres
    fermeture qu'il a bien disparu ;
  - les coordonnees lues sont confrontees a la position ou l'on a navigue :
    une lecture aberrante est refusee plutot qu'enregistree.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import keyboard  # noqa: E402

from gameui import GameWindow, MOUSE_PARK  # noqa: E402
from popup import find_popup, read_popup  # noqa: E402
from store import SystemStore  # noqa: E402
from systems import find_systems  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
STATE_FILE = BASE_DIR / "data" / "crawl_state.json"

UNIVERSE_MAX = 1408

stop_requested = False


def request_stop():
    global stop_requested
    if not stop_requested:
        stop_requested = True
        print("\n[!] Arret demande — on termine le systeme en cours.")


def load_config():
    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    config.setdefault("step", 6)
    config.setdefault("origin", [700, 860])
    return config


def spiral(origin, step, limit=UNIVERSE_MAX):
    """Positions a visiter, en spirale depuis l'origine.

    En spirale et non en lignes : dans ce jeu la distance compte pour attaquer,
    donc la carte proche est la seule immediatement utile. Un balayage ligne par
    ligne depuis (0,0) mettrait des jours avant d'atteindre quoi que ce soit
    d'exploitable.
    """
    x, y = origin
    yield (x, y)

    ring = 1
    while True:
        exhausted = True
        for dx, dy in _ring_offsets(ring):
            nx, ny = x + dx * step, y + dy * step
            if 0 <= nx <= limit and 0 <= ny <= limit:
                exhausted = False
                yield (nx, ny)
        if exhausted:
            return
        ring += 1


def _ring_offsets(ring):
    """Cases du carre de rayon `ring`, dans l'ordre du parcours."""
    for dx in range(-ring, ring + 1):
        yield dx, -ring
    for dy in range(-ring + 1, ring + 1):
        yield ring, dy
    for dx in range(ring - 1, -ring - 1, -1):
        yield dx, ring
    for dy in range(ring - 1, -ring, -1):
        yield -ring, dy


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            pass
    return {"visited": []}


def save_state(visited):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps({"visited": sorted(visited)}))


def wait(base, jitter):
    time.sleep(base + random.uniform(0, jitter))


def read_system(game, target, position, timings, store, save_shots):
    """Ouvre un systeme, lit son contenu, le referme. Renvoie un compte-rendu."""
    game.click(target["x"], target["y"], settle=0)
    wait(timings["popup"], timings["jitter"])

    image = game.capture()
    box = find_popup(image)
    if not box:
        # Le clic n'a rien ouvert : espace vide, ou le jeu a rame. On n'insiste
        # pas, le systeme sera revu depuis l'ecran voisin.
        return {"status": "pas de popup"}

    result = read_popup(image, expected=position)

    # Fermeture AVANT tout traitement : tant que le popup est ouvert, le clic
    # suivant tomberait dedans.
    game.close_popup(box, settle=timings["close"])
    after = game.capture()
    if find_popup(after):
        # Deuxieme tentative : la croix a pu manquer si le popup s'anime encore.
        game.close_popup(find_popup(after), settle=timings["close"] * 2)
        if find_popup(game.capture()):
            return {"status": "popup bloque"}

    if not result or not result["coords"]:
        return {"status": "coordonnees illisibles"}

    x, y = result["coords"]
    if store.has(x, y):
        return {"status": "deja vu", "coords": (x, y), "name": result["name"]}

    players = [p["name"] for p in result["players"] if p["name"]]
    store.record(x, y, result["name"], players, screen=position)

    if save_shots:
        shots = BASE_DIR / "captures" / "popups"
        shots.mkdir(parents=True, exist_ok=True)
        image.crop(box).save(shots / "{}_{}.png".format(x, y))

    return {"status": "nouveau", "coords": (x, y), "name": result["name"],
            "players": players}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="ne clique nulle part, affiche seulement le plan")
    parser.add_argument("--one", action="store_true",
                        help="une seule position, pour verifier que tout marche")
    parser.add_argument("--resume", action="store_true",
                        help="reprend en sautant les positions deja faites")
    parser.add_argument("--save-shots", action="store_true",
                        help="garde une image de chaque popup lu")
    args = parser.parse_args()

    config = load_config()
    step = config["step"]
    origin = tuple(config["origin"])
    timings = {
        "navigate": config["timing"].get("settle_ms", 900) / 1000,
        "popup": config["timing"].get("popup_ms", 700) / 1000,
        "close": config["timing"].get("close_ms", 400) / 1000,
        "jitter": config["timing"].get("jitter_ms", 400) / 1000,
    }
    max_seconds = config["session"]["max_minutes"] * 60
    max_screens = config["session"].get("max_screens", 500)

    store = SystemStore()
    state = load_state() if args.resume else {"visited": []}
    visited = set(tuple(v) for v in state["visited"])

    print("Base locale : {}".format(store.summary()))
    print("Origine {}, pas de {}, {} position(s) deja faite(s)".format(
        origin, step, len(visited)))

    if args.dry_run:
        print("\nPremieres positions du parcours en spirale :")
        for index, position in enumerate(spiral(origin, step)):
            if index >= 25:
                break
            print("  {:>3}. {}".format(index + 1, position))
        print("\n--dry-run : rien n'a ete clique.")
        return

    game = GameWindow()
    print("Fenetre : {} ({}x{})".format(game.title, game.rect[2], game.rect[3]))
    print("\nECHAP pour arreter. Demarrage dans 5 secondes —")
    print("mets Galaxy Life au premier plan, sur la vue carte.")
    keyboard.on_press_key("esc", lambda _: request_stop())
    time.sleep(5)

    started = time.time()
    screens = 0
    found = 0

    for position in spiral(origin, step):
        if stop_requested or screens >= max_screens:
            break
        if time.time() - started > max_seconds:
            print("[!] Duree maximale atteinte.")
            break
        if position in visited:
            continue

        game.go_to(position[0], position[1], settle=timings["navigate"])
        game.park_mouse()
        wait(0.2, timings["jitter"])

        image = game.capture()
        targets = find_systems(image)
        screens += 1
        print("\n[{}] {} systeme(s) a l'ecran".format(position, len(targets)))

        for target in targets:
            if stop_requested:
                break
            report = read_system(game, target, position, timings, store, args.save_shots)

            if report["status"] == "nouveau":
                found += 1
                print("  + {} {} — {}".format(
                    report["name"] or "?", report["coords"],
                    ", ".join(report["players"]) or "aucun joueur"))
            elif report["status"] == "deja vu":
                print("  = {} {}".format(report["name"] or "?", report["coords"]))
            else:
                print("  ! {}".format(report["status"]))

        visited.add(position)
        save_state(visited)

        if args.one:
            print("\n--one : une position traitee, on s'arrete.")
            break

    elapsed = time.time() - started
    print("\n{} ecran(s) en {:.0f} min, {} nouveau(x) systeme(s).".format(
        screens, elapsed / 60, found))
    print(store.summary())


if __name__ == "__main__":
    main()
