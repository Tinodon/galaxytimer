"""Constitue le dictionnaire des pseudos reellement existants.

C'est le levier qui rend la qualite de l'OCR secondaire. Lire `FORTHNITE739XD`
au lieu de `FORTNITE799XD` n'a plus d'importance des lors qu'on sait quels
pseudos existent : la lecture approximative n'a qu'un seul voisin plausible
dans la liste reelle.

L'API cherche par SOUS-CHAINE. Tout pseudo d'au moins deux caracteres contient
donc au moins un couple de caracteres ; balayer les 1296 couples possibles
garantit de tous les voir, sans avoir a deviner quoi que ce soit.

    python scout/roster.py              construit ou complete le dictionnaire
    python scout/roster.py --stats      etat du dictionnaire
    python scout/roster.py --retry      reprend seulement les couples en echec

Le travail est repris la ou il s'arrete : chaque couple traite est note, et le
dictionnaire est ecrit au fil de l'eau.
"""

from __future__ import annotations

import argparse
import json
import string
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
ROSTER_FILE = DATA_DIR / "roster.json"
STATE_FILE = DATA_DIR / "roster_state.json"
LEVELS_FILE = DATA_DIR / "roster_niveaux.json"

ALPHABET = string.ascii_lowercase + string.digits

# Certaines recherches courantes renvoient plus de dix mille noms et prennent
# une dizaine de secondes. Un delai court les faisait passer pour vides.
TIMEOUT = 90

# Nombre de requetes simultanees. Volontairement bas : c'est l'API d'un tiers,
# et rien ne presse — le balayage complet n'est fait qu'une fois.
WORKERS = 5
PAUSE = 0.15


def pairs():
    """Les 1296 couples de caracteres possibles."""
    return [a + b for a in ALPHABET for b in ALPHABET]


def fetch(pair):
    """Noms contenant ce couple. Renvoie (couple, noms, erreur)."""
    time.sleep(PAUSE)
    try:
        response = requests.get(
            "https://api.galaxylifegame.net/Users/search",
            params={"name": pair}, timeout=TIMEOUT,
        )
        text = response.text.strip()
        if not text.startswith("["):
            return pair, {}, "reponse inattendue"
        # Le niveau vient dans la meme reponse et ne coute donc rien de plus.
        # Il sert a departager deux pseudos egalement plausibles pour une meme
        # lecture : la vignette du jeu affiche le niveau, l'API aussi.
        users = [u for u in json.loads(text) if u.get("Name")]
        return pair, {u["Name"]: u.get("Level") for u in users}, None
    except Exception as error:  # noqa: BLE001
        return pair, {}, str(error)[:60]


def load(path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return default


def save_roster(names, levels=None):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ROSTER_FILE.write_text(json.dumps(sorted(names), ensure_ascii=False),
                           encoding="utf-8")
    # Fichier separe : le dictionnaire de noms reste lisible par tout ce qui
    # existe deja, et un relevé sans niveaux continue de fonctionner.
    if levels:
        LEVELS_FILE.write_text(json.dumps(levels, ensure_ascii=False),
                               encoding="utf-8")


def save_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state), encoding="utf-8")


def build(only_failed=False, reset=False):
    """Complete le dictionnaire des joueurs.

    `reset` : reinterroge TOUS les couples, meme ceux deja faits. C'est ce
    qu'il faut quand la reponse de l'API sert a quelque chose de nouveau — les
    niveaux, par exemple, qui n'etaient pas conserves jusqu'ici. Rien n'est
    efface : les pseudos deja connus restent, l'avancement est simplement
    reecrit au fur et a mesure.
    """
    names = set(load(ROSTER_FILE, []))
    levels = load(LEVELS_FILE, {})
    state = load(STATE_FILE, {"done": [], "failed": []})
    done, failed = set(state["done"]), set(state["failed"])

    if reset:
        todo = pairs()
    elif only_failed:
        todo = sorted(failed)
    else:
        todo = [p for p in pairs() if p not in done]
    if not todo:
        print("Rien a faire. {} pseudo(s) connus, {} couple(s) en echec.".format(
            len(names), len(failed)))
        return

    print("{} couple(s) a interroger, {} deja fait(s)".format(len(todo), len(done)))
    print("{} pseudo(s) deja connus\n".format(len(names)))

    started = time.time()
    processed = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch, pair): pair for pair in todo}
        for future in as_completed(futures):
            pair, found, error = future.result()
            processed += 1

            if error:
                failed.add(pair)
                print("  ! {}  {}".format(pair, error))
            else:
                failed.discard(pair)
                done.add(pair)
                before = len(names)
                names.update(found)
                levels.update({k: v for k, v in found.items() if v is not None})
                gained = len(names) - before
                if gained:
                    print("  {} -> {:>6} noms, {:>5} nouveaux  (total {})".format(
                        pair, len(found), gained, len(names)))

            if processed % 25 == 0:
                save_roster(names, levels)
                save_state({"done": sorted(done), "failed": sorted(failed)})
                rate = processed / max(time.time() - started, 1)
                left = (len(todo) - processed) / max(rate, 0.001) / 60
                print("  ... {}/{}  ~{:.0f} min restantes".format(
                    processed, len(todo), left))

    # Les niveaux aussi : seules les sauvegardes intermediaires les gardaient,
    # donc les derniers couples interroges les perdaient a l'arrivee.
    save_roster(names, levels)
    save_state({"done": sorted(done), "failed": sorted(failed)})
    print("\n{} pseudo(s) au dictionnaire, {} avec niveau".format(
        len(names), len(levels)))
    print("{} couple(s) en echec".format(len(failed)))
    if failed:
        print("Relance avec --retry pour les reprendre.")


def stats():
    names = load(ROSTER_FILE, [])
    state = load(STATE_FILE, {"done": [], "failed": []})
    print("pseudos connus     : {}".format(len(names)))
    print("couples interroges : {}/{}".format(len(state["done"]), len(pairs())))
    print("couples en echec   : {}".format(len(state["failed"])))
    print("niveaux releves    : {}".format(len(load(LEVELS_FILE, {}))))
    if names:
        print("\nexemples : {}".format(", ".join(names[:8])))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("--retry", action="store_true",
                        help="reprend uniquement les couples en echec")
    parser.add_argument("--reset", action="store_true",
                        help="reinterroge tous les couples, pour relever les niveaux")
    args = parser.parse_args()
    if args.stats:
        stats()
    else:
        build(only_failed=args.retry, reset=args.reset)
