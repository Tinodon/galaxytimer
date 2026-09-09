"""Balayage automatique de la carte Galaxy Life.

Pour chaque position : ecrire les coordonnees, valider, capturer la carte,
reperer les systemes, ouvrir chacun, capturer son popup, refermer, position
suivante.

    python scout/crawler.py --dry-run   montre le plan, ne clique nulle part
    python scout/crawler.py --one       une seule position, pour verifier
    python scout/crawler.py             balayage, jusqu'a Ctrl+C

PAR DEFAUT LE CRAWLER NE LIT RIEN. Il capture et il range. Lire un popup coute
environ cinq secondes de calcul, soit une minute par ecran : une nuit entiere
n'en couvrirait que 480. Sans lecture, un popup tombe a une seconde et demie et
la meme nuit en couvre 1600. Les images sont traitees ensuite, par
scout/process.py, pendant que la machine ne joue pas.

    python scout/crawler.py --read      lit pendant le balayage (lent)

Ctrl+C interrompt proprement : l'etat et les fichiers sont ecrits au fil de
l'eau, et la position en cours est terminee avant l'arret.
"""

from __future__ import annotations

import argparse
import json
import random
import signal
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gameui import GameWindow, find_game_window, is_game_focused  # noqa: E402
from popup import find_popup, popup_ready, read_popup  # noqa: E402
from store import SystemStore  # noqa: E402
from systems import find_systems, safe_box  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
DATA_DIR = BASE_DIR / "data"
STATE_FILE = DATA_DIR / "crawl_state.json"
LOG_FILE = DATA_DIR / "releve.txt"
MAPS_DIR = DATA_DIR / "cartes"
POPUPS_DIR = DATA_DIR / "popups"

UNIVERSE_MAX = 1408

stop_requested = False


def request_stop(*_):
    """Ctrl+C : on note la demande, on ne coupe pas au milieu d'un clic."""
    global stop_requested
    if stop_requested:
        print("\n[!] Deuxieme interruption — arret immediat.")
        sys.exit(1)
    stop_requested = True
    print("\n[!] Arret demande. On termine la position en cours puis on s'arrete.")


def load_config():
    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    config.setdefault("origin", [0, 0])
    # Ancien format : un pas unique. On le repartit sur les deux axes.
    if "step" in config and "step_x" not in config:
        config["step_x"] = config["step"]
        config["step_y"] = max(1, round(config["step"] / 2.9))
    config.setdefault("step_x", 5)
    config.setdefault("step_y", 3)
    return config


def positions(origin, step_x, step_y, limit=UNIVERSE_MAX):
    """Parcours ligne par ligne depuis l'origine.

    Deux pas differents, parce que l'ecran est un rectangle : la zone de jeu
    fait 1899x654, soit presque trois fois plus large que haute. Un pas unique
    laisserait des trous en vertical ou gaspillerait du temps en horizontal.

    Les coordonnees du jeu ne descendent pas sous zero : on part de (0,0) et on
    monte. Un parcours en lignes couvre tout sans jamais revenir en arriere, ce
    qui rend la reprise triviale.
    """
    y = origin[1]
    while y <= limit:
        x = origin[0]
        while x <= limit:
            yield (x, y)
            x += step_x
        y += step_y


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            print("[etat] fichier illisible, on repart de l'origine")
    return {"done": []}


def save_state(done):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps({"done": sorted(done)}))


def log(line):
    """Journal lisible a l'oeil, en plus du JSONL.

    Filet de securite demande par Noe : si le fichier structure devient
    inexploitable, tout reste lisible ici.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write("{}  {}\n".format(datetime.now().strftime("%H:%M:%S"), line))


def wait(base, jitter):
    time.sleep(base + random.uniform(0, jitter))


def save_map(image, position):
    """Carte VIERGE, sans annotation : c'est la matiere de la carte interactive.

    En JPEG et rognee a la zone de jeu : en PNG plein ecran, une nuit de
    balayage pese des dizaines de gigaoctets pour rien.
    """
    MAPS_DIR.mkdir(parents=True, exist_ok=True)
    x0, y0, x1, y1 = safe_box(image.width, image.height)
    path = MAPS_DIR / "{}_{}.jpg".format(position[0], position[1])
    image.crop((x0, y0, x1, y1)).save(path, "JPEG", quality=80)
    return path


def visit_system(game, target, position, timings, store, do_read):
    """Ouvre un systeme, capture son popup, referme. Lit seulement si demande."""
    # Dernier controle avant de toucher a la souris : si le jeu n'est plus
    # devant, le clic partirait dans une autre application.
    if not is_game_focused():
        return {"status": "focus perdu"}

    game.click(target["x"], target["y"], settle=0)
    wait(timings["popup"], timings["jitter"])

    image = game.capture()
    box = find_popup(image)
    if not box:
        # Le clic n'a rien ouvert : espace vide, ou le jeu a rame. On n'insiste
        # pas, le systeme sera revu depuis l'ecran voisin.
        return {"status": "rien"}

    # Le cadre s'affiche avant son contenu. Capturer maintenant enregistrerait
    # un systeme comme vide alors qu'il ne l'est pas — pire qu'une lecture
    # ratee, puisque ca produit une donnee fausse qu'on croira bonne.
    ready, drawn = popup_ready(image.crop(box))
    attempts = 0
    while not ready and attempts < timings["load_retries"]:
        attempts += 1
        time.sleep(timings["load_wait"])
        image = game.capture()
        box = find_popup(image)
        if not box:
            return {"status": "popup disparu pendant le chargement"}
        ready, drawn = popup_ready(image.crop(box))

    if not ready:
        game.close_popup(box, settle=timings["close"])
        return {"status": "popup incomplet ({}/12 vignettes)".format(drawn)}

    # La capture du popup est gardee dans tous les cas : c'est elle qui permet
    # de retraiter plus tard sans rejouer le balayage.
    POPUPS_DIR.mkdir(parents=True, exist_ok=True)
    shot = POPUPS_DIR / "{}_{}_{}_{}.jpg".format(
        position[0], position[1], target["x"], target["y"])
    image.crop(box).save(shot, "JPEG", quality=85)

    # Fermeture AVANT tout traitement : tant que le popup est ouvert, le clic
    # suivant tomberait dedans.
    game.close_popup(box, settle=timings["close"])
    if find_popup(game.capture()):
        again = find_popup(game.capture())
        if again:
            game.close_popup(again, settle=timings["close"] * 2)
        if find_popup(game.capture()):
            return {"status": "popup bloque"}

    if not do_read:
        return {"status": "capture", "file": shot.name}

    result = read_popup(image, expected=position)
    if not result or not result["coords"]:
        return {"status": "coordonnees illisibles"}

    x, y = result["coords"]
    players = [p["name"] for p in result["players"] if p["name"]]
    if store.has(x, y):
        return {"status": "deja vu", "coords": (x, y), "name": result["name"]}

    store.record(x, y, result["name"], players, screen=position)
    return {"status": "nouveau", "coords": (x, y), "name": result["name"],
            "players": players}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--one", action="store_true")
    parser.add_argument("--test", action="store_true",
                        help="trois positions : sur place, un pas a droite, un pas en bas")
    parser.add_argument("--limit", type=int, default=0,
                        help="s'arrete apres ce nombre de positions")
    parser.add_argument("--read", action="store_true",
                        help="lit les popups pendant le balayage (cinq fois plus lent)")
    parser.add_argument("--restart", action="store_true",
                        help="reprend depuis l'origine au lieu de continuer")
    args = parser.parse_args()

    config = load_config()
    step_x, step_y = config["step_x"], config["step_y"]
    origin = tuple(config["origin"])
    timings = {
        "navigate": config["timing"].get("settle_ms", 900) / 1000,
        "popup": config["timing"].get("popup_ms", 700) / 1000,
        "close": config["timing"].get("close_ms", 400) / 1000,
        "jitter": config["timing"].get("jitter_ms", 400) / 1000,
        "load_wait": config["timing"].get("load_wait_ms", 5000) / 1000,
        "load_retries": config["timing"].get("load_retries", 2),
    }

    store = SystemStore()
    state = {"done": []} if args.restart else load_state()
    done = set(tuple(p) for p in state["done"])

    print("Base locale  : {}".format(store.summary()))
    total = ((UNIVERSE_MAX // step_x) + 1) * ((UNIVERSE_MAX // step_y) + 1)
    print("Parcours     : depuis {}, pas {} horizontal / {} vertical".format(
        origin, step_x, step_y))
    print("Total        : {} positions".format(total))
    print("Deja fait    : {} position(s)".format(len(done)))
    print("Mode         : {}".format(
        "capture ET lecture (lent)" if args.read else "capture seule (rapide)"))

    if args.dry_run:
        print("\n25 premieres positions :")
        for index, position in enumerate(positions(origin, step_x, step_y)):
            if index >= 25:
                break
            print("  {:>3}. {}".format(index + 1, position))
        print("--dry-run : rien n'a ete clique.")
        return

    if not find_game_window():
        raise SystemExit("Galaxy Life n'est pas ouvert.")

    game = GameWindow()
    print("Fenetre      : {} ({}x{})".format(game.title, game.rect[2], game.rect[3]))
    print("\nCtrl+C pour arreter proprement.")
    print("Demarrage dans 5 secondes — Galaxy Life au premier plan, vue carte.\n")

    signal.signal(signal.SIGINT, request_stop)
    time.sleep(5)

    started = time.time()
    screens = 0
    popups = 0
    found = 0
    empty_streak = 0

    log("--- debut, origine {} pas {}x{} ---".format(origin, step_x, step_y))

    # --test : on verifie les deux sens de deplacement d'affilee, ce que le
    # parcours normal ne ferait qu'apres avoir traverse toute une ligne.
    if args.test:
        plan = [
            origin,
            (origin[0] + step_x, origin[1]),
            (origin[0], origin[1] + step_y),
        ]
        print("Test : {} -> un pas a droite -> un pas en haut\n".format(origin))
    else:
        plan = positions(origin, step_x, step_y)

    for position in plan:
        if stop_requested:
            break
        if args.limit and screens >= args.limit:
            print("\n--limit {} atteint.".format(args.limit))
            break
        # En mode test on refait les positions meme si elles sont deja notees :
        # c'est un controle du pilotage, pas une collecte.
        if position in done and not args.test:
            continue

        # Le jeu a pu etre ferme, plante, ou passer en arriere-plan pendant la
        # nuit. Sans ce controle, le script continuerait a cliquer — au mieux
        # dans le vide, au pire dans une autre application.
        if not find_game_window():
            print("[!] La fenetre Galaxy Life a disparu. Arret.")
            log("fenetre du jeu disparue, arret")
            break
        if not is_game_focused():
            print("[!] Galaxy Life n'est plus au premier plan. Arret.")
            log("focus perdu, arret")
            break

        game.go_to(position[0], position[1], settle=timings["navigate"])
        game.park_mouse()
        wait(0.2, timings["jitter"])

        image = game.capture()
        save_map(image, position)
        targets = find_systems(image)
        screens += 1

        if not targets:
            empty_streak += 1
        else:
            empty_streak = 0

        print("[{:>4},{:>4}] {} systeme(s)".format(position[0], position[1], len(targets)))
        log("position {} : {} systeme(s)".format(position, len(targets)))

        for target in targets:
            if stop_requested:
                break
            report = visit_system(game, target, position, timings, store, args.read)
            if report["status"] == "focus perdu":
                print("  [!] Galaxy Life n'est plus au premier plan. Arret.")
                log("focus perdu pendant un clic, arret")
                request_stop()
                break
            popups += 1

            if report["status"] == "nouveau":
                found += 1
                line = "  + {} {} — {}".format(
                    report["name"] or "?", report["coords"],
                    ", ".join(report["players"]) or "aucun joueur")
            elif report["status"] == "deja vu":
                line = "  = {} {}".format(report["name"] or "?", report["coords"])
            elif report["status"] == "capture":
                line = "  . {}".format(report["file"])
            else:
                line = "  ! {}".format(report["status"])
            print(line)
            log(line.strip())

        done.add(position)
        save_state(done)

        if args.one:
            print("\n--one : une position traitee.")
            break

    elapsed = time.time() - started
    summary = "{} ecran(s), {} popup(s), {} nouveau(x) systeme(s) en {:.0f} min".format(
        screens, popups, found, elapsed / 60)
    print("\n{}".format(summary))
    print(store.summary())
    print("\nCartes  : {}".format(MAPS_DIR))
    print("Popups  : {}".format(POPUPS_DIR))
    print("Journal : {}".format(LOG_FILE))
    if not args.read and popups:
        print("\nPour lire les popups captures : python scout/process.py")
    log("--- fin : {} ---".format(summary))


if __name__ == "__main__":
    main()
