"""Balayage automatique de la carte : deplace la vue, lit, enregistre.

    python scout/crawler.py            balaye et ecrit en base
    python scout/crawler.py --dry-run  balaye et affiche, sans rien ecrire
    python scout/crawler.py --resume   reprend ou le dernier passage s'est arrete

Le script glisse la carte pas a pas selon une grille, capture chaque position,
lit le texte et pousse les coordonnees trouvees dans la meme base Upstash que
le bot Discord.

Bornes volontaires : duree et nombre de captures plafonnes, attente variable
entre deux deplacements. Un script sans limite finit par tourner toute la nuit
sur un ecran d'erreur, en croyant travailler.

ECHAP a tout moment interrompt proprement et sauvegarde ce qui a ete trouve.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from datetime import datetime
from pathlib import Path

import keyboard
import mss
import pyautogui
import pytesseract
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import PinStore  # noqa: E402
from parse import parse  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
STATE_FILE = BASE_DIR / "crawl_state.json"
SHOTS_DIR = BASE_DIR / "captures"

# pyautogui coupe tout si la souris file dans un coin : garde-fou utile.
pyautogui.FAILSAFE = True

stop_requested = False


def request_stop():
    global stop_requested
    stop_requested = True
    print("\n[!] Arret demande, sauvegarde en cours...")


def load_config():
    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    grid = config.get("grid", {})
    drag = config.get("drag", {})
    if not grid.get("columns") or not grid.get("rows"):
        raise SystemExit(
            "config.json n'est pas calibre : grid.columns et grid.rows valent 0.\n"
            "Lance d'abord scout/calibrate.py pour mesurer la carte."
        )
    if not drag.get("step_x") and not drag.get("step_y"):
        raise SystemExit(
            "config.json n'est pas calibre : drag.step_x et drag.step_y valent 0.\n"
            "Mesure de combien la carte se deplace pour un glissement donne."
        )
    return config


def grab(viewport):
    with mss.mss() as sct:
        if viewport:
            x, y, w, h = viewport
            monitor = {"left": x, "top": y, "width": w, "height": h}
        else:
            monitor = sct.monitors[1]
        shot = sct.grab(monitor)
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def preprocess(image):
    """Agrandit et binarise : le texte de jeu est petit et sur fond charge."""
    grey = image.convert("L").resize((image.width * 2, image.height * 2), Image.LANCZOS)
    return grey.point(lambda p: 255 if p > 140 else 0)


def read_text(image):
    return pytesseract.image_to_string(preprocess(image))


def drag_view(viewport, dx, dy):
    """Fait glisser la carte de (dx, dy) pixels depuis son centre."""
    if viewport:
        x, y, w, h = viewport
        cx, cy = x + w // 2, y + h // 2
    else:
        cx, cy = [v // 2 for v in pyautogui.size()]

    pyautogui.moveTo(cx, cy, duration=0.15)
    pyautogui.mouseDown()
    # Deplacement en deux temps : un glissement instantane est parfois ignore
    # par les interfaces qui attendent un mouvement continu.
    pyautogui.moveTo(cx - dx // 2, cy - dy // 2, duration=0.2)
    pyautogui.moveTo(cx - dx, cy - dy, duration=0.2)
    pyautogui.mouseUp()


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"col": 0, "row": 0}


def save_state(col, row):
    STATE_FILE.write_text(json.dumps({"col": col, "row": row}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="n'ecrit rien en base")
    parser.add_argument("--resume", action="store_true", help="reprend le dernier passage")
    parser.add_argument("--save-shots", action="store_true", help="garde les captures sur disque")
    args = parser.parse_args()

    config = load_config()
    viewport = config.get("viewport")
    step_x = config["drag"]["step_x"]
    step_y = config["drag"]["step_y"]
    columns = config["grid"]["columns"]
    rows = config["grid"]["rows"]
    settle = config["timing"]["settle_ms"] / 1000
    jitter = config["timing"]["jitter_ms"] / 1000
    max_seconds = config["session"]["max_minutes"] * 60
    max_captures = config["session"]["max_captures"]

    store = None
    if not args.dry_run:
        store = PinStore(config["guild_id"], config["scout_name"])
        store.load()
        print("Base : {}".format(store.summary()))

    if args.save_shots:
        SHOTS_DIR.mkdir(exist_ok=True)

    state = load_state() if args.resume else {"col": 0, "row": 0}
    print("Grille {}x{}, depart ({}, {})".format(columns, rows, state["col"], state["row"]))
    print("Bornes : {} min, {} captures. ECHAP pour arreter.".format(
        config["session"]["max_minutes"], max_captures))
    print("Demarrage dans 5 secondes — mets Galaxy Life au premier plan.\n")

    keyboard.on_press_key("esc", lambda _: request_stop())
    time.sleep(5)

    started = time.time()
    captures = 0
    found_total = 0
    seen = set()

    for row in range(state["row"], rows):
        for col in range(state["col"] if row == state["row"] else 0, columns):
            if stop_requested:
                break
            if time.time() - started > max_seconds:
                print("[!] Duree maximale atteinte.")
                break
            if captures >= max_captures:
                print("[!] Nombre de captures maximal atteint.")
                break

            time.sleep(settle + random.uniform(0, jitter))
            image = grab(viewport)
            captures += 1

            text = read_text(image)
            entries = parse(text)

            if args.save_shots:
                stamp = datetime.now().strftime("%H-%M-%S")
                image.save(SHOTS_DIR / "crawl_{}_{}_{}.png".format(row, col, stamp))

            for entry in entries:
                key = (entry["name"].lower(), entry["x"], entry["y"])
                if key in seen:
                    continue
                seen.add(key)
                found_total += 1
                print("  ({},{}) {} -> ({},{})".format(
                    col, row, entry["name"], entry["x"], entry["y"]))

            save_state(col, row)
            if col < columns - 1:
                drag_view(viewport, step_x, 0)

        if stop_requested or time.time() - started > max_seconds or captures >= max_captures:
            break
        # Fin de ligne : on revient a gauche et on descend d'un cran.
        drag_view(viewport, -step_x * (columns - 1), 0)
        drag_view(viewport, 0, step_y)

    print("\n{} capture(s), {} coordonnee(s) distinctes trouvees.".format(captures, found_total))

    if args.dry_run:
        print("--dry-run : rien n'a ete ecrit.")
        return

    # Les pseudos lus a l'ecran doivent etre resolus en identifiants stables :
    # sans ca, un joueur qui se renomme casse tout l'historique.
    import requests

    resolved = 0
    by_name = {}
    for name, x, y in seen:
        by_name.setdefault(name, []).append((x, y))

    for name, coords in by_name.items():
        try:
            response = requests.get(
                "https://api.galaxylifegame.net/Users/name",
                params={"name": name},
                timeout=10,
            )
            body = response.text.strip()
            if not body.startswith("{"):
                print("  ? joueur inconnu de l'API, ignore : {}".format(name))
                continue
            user = json.loads(body)
            store.add(user["Id"], user["Name"], coords)
            resolved += 1
        except Exception as error:  # noqa: BLE001
            print("  ! echec sur {} : {}".format(name, error))

    store.save()
    print("{} joueur(s) enregistres. {}".format(resolved, store.summary()))


if __name__ == "__main__":
    main()
