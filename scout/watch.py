"""Barre de progression pour les traitements longs.

    python scout/watch.py

Affiche l'avancement de ce qui tourne — extraction des popups, rapprochement
des pseudos, construction du dictionnaire — avec un debit et une estimation de
fin. S'arrete tout seul quand tout est termine.

Ne lance rien et ne modifie rien : il lit les memes fichiers que les scripts de
travail. On peut donc l'ouvrir, le fermer et le relancer sans rien perturber.
"""

from __future__ import annotations

import json
import string
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

REFRESH = 2.0
BAR_WIDTH = 34


def count_json(path, default=0):
    try:
        return len(json.loads(path.read_text(encoding="utf-8")))
    except Exception:  # noqa: BLE001
        return default


def count_lines(path):
    try:
        with path.open(encoding="utf-8") as handle:
            return sum(1 for line in handle if line.strip())
    except Exception:  # noqa: BLE001
        return 0


def jobs():
    """Les traitements suivis, avec leur avancement courant."""
    popups = len(list((DATA_DIR / "popups").glob("*.jpg"))) if (DATA_DIR / "popups").exists() else 0
    extraction = count_json(DATA_DIR / "popups_traites.json")

    roster_state = DATA_DIR / "roster_state.json"
    done_pairs = 0
    if roster_state.exists():
        try:
            done_pairs = len(json.loads(roster_state.read_text())["done"])
        except Exception:  # noqa: BLE001
            pass

    # On lit l'avancement dans le JOURNAL, pas dans le fichier de resultat :
    # celui-ci n'est ecrit qu'a la toute fin, donc il refleterait le passage
    # PRECEDENT et afficherait 100% alors que le calcul en cours n'en est qu'a
    # la moitie.
    resolved = 0
    # Le rapprochement porte sur les pseudos distincts, qu'on ne connait qu'en
    # relisant la base : on approche par le journal, moins couteux.
    total_names = 0
    log = DATA_DIR / "resolve.log"
    if log.exists():
        try:
            for line in log.read_text(encoding="utf-8").splitlines():
                if "pseudo(s) distincts" in line:
                    total_names = int(line.split("colonie(s),")[1].split("pseudo")[0])
                elif line.strip().startswith("...") and "/" in line:
                    # "  ... 8000/15204  (15/s)"
                    resolved = int(line.split("...")[1].split("/")[0])
                elif "colonies rattachees" in line:
                    resolved = total_names
        except Exception:  # noqa: BLE001
            pass

    return [
        ("extraction des popups", extraction, popups),
        ("dictionnaire des joueurs", done_pairs, len(string.ascii_lowercase + string.digits) ** 2),
        ("rapprochement des pseudos", resolved, total_names),
    ]


def bar(done, total):
    if not total:
        return "[" + " " * BAR_WIDTH + "]    ?"
    ratio = min(1.0, done / total)
    filled = int(BAR_WIDTH * ratio)
    return "[{}{}] {:>3.0f}%".format("#" * filled, "-" * (BAR_WIDTH - filled), 100 * ratio)


def human(seconds):
    if seconds is None or seconds < 0:
        return "?"
    if seconds < 90:
        return "{:.0f}s".format(seconds)
    if seconds < 5400:
        return "{:.0f} min".format(seconds / 60)
    return "{:.1f} h".format(seconds / 3600)


def main():
    started = time.time()
    first = {name: done for name, done, _ in jobs()}
    lines_printed = 0

    print("Avancement des traitements — Ctrl+C pour fermer (ne coupe rien)\n")

    try:
        while True:
            rows = jobs()
            elapsed = max(time.time() - started, 1)

            if lines_printed:
                # Remonte pour reecrire par-dessus, plutot que de derouler.
                sys.stdout.write("\033[{}A".format(lines_printed))

            lines_printed = 0
            everything_done = True

            for name, done, total in rows:
                if not total:
                    continue
                progress = done - first.get(name, 0)
                rate = progress / elapsed
                left = (total - done) / rate if rate > 0.01 and done < total else None
                state = "termine" if done >= total else "reste {}".format(human(left))
                if done < total:
                    everything_done = False

                sys.stdout.write("\033[2K{:<26} {} {:>6}/{:<6} {:>3.1f}/s  {}\n".format(
                    name, bar(done, total), done, total, rate, state))
                lines_printed += 1

            sys.stdout.flush()
            if everything_done:
                print("\nTout est termine.")
                return
            time.sleep(REFRESH)
    except KeyboardInterrupt:
        print("\nFerme. Les traitements continuent en arriere-plan.")


if __name__ == "__main__":
    main()
