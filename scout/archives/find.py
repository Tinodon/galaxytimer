"""Interroge les systemes releves. Sert a verifier en jeu que c'est juste.

    python scout/find.py --stats                  etat de la base
    python scout/find.py PabloOjeda               ou joue ce joueur
    python scout/find.py --system 1004,7          qui habite ce systeme
    python scout/find.py --name ATLAS             chercher un systeme par nom
    python scout/find.py --full                   les systemes complets (12/12)
    python scout/find.py --empty                  les systemes inhabites

La recherche d'un joueur compare son nom aux lectures brutes de l'OCR, apres
avoir applati les confusions de la police du jeu (m lu "nn", B lu S, l lu U).
C'est le sens qui marche : verifier "est-ce que cette lecture correspond a
PabloOjeda" reussit la ou chercher "qui est ce pseudo" a l'aveugle echoue.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from names import similarity  # noqa: E402
from store import SystemStore  # noqa: E402

# Au-dessus, on considere que c'est la meme personne. Mesure sur de vraies
# lectures : les bons rapprochements depassent 0.83, les mauvais plafonnent
# nettement plus bas.
THRESHOLD = 0.82


def show_system(entry, highlight=None):
    players = entry.get("players", [])
    print("\n{}  ({}, {})  —  {} colonie(s)".format(
        entry.get("name") or "?", entry["x"], entry["y"], len(players)))
    for player in players:
        mark = ""
        if highlight and similarity(player, highlight) >= THRESHOLD:
            mark = "   <<< {}".format(highlight)
        print("    {}{}".format(player, mark))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("player", nargs="?", help="pseudo a chercher")
    parser.add_argument("--system", help="coordonnees, ex: 1004,7")
    parser.add_argument("--name", help="nom de systeme")
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("--full", action="store_true", help="systemes 12/12")
    parser.add_argument("--empty", action="store_true", help="systemes inhabites")
    parser.add_argument("--limit", type=int, default=40)
    args = parser.parse_args()

    store = SystemStore()
    systems = list(store.systems.values())

    if not systems:
        raise SystemExit("Base vide. Lance d'abord : python scout/process.py")

    if args.stats or not any([args.player, args.system, args.name, args.full, args.empty]):
        s = store.stats()
        xs = [e["x"] for e in systems]
        ys = [e["y"] for e in systems]
        full = sum(1 for e in systems if len(e.get("players", [])) >= 12)
        print("systemes releves   : {}".format(s["systems"]))
        print("dont habites       : {}".format(s["occupied"]))
        print("dont complets 12/12: {}".format(full))
        print("colonies relevees  : {}".format(s["player_slots"]))
        print("zone couverte      : X {}..{}   Y {}..{}".format(
            min(xs), max(xs), min(ys), max(ys)))
        names = {}
        for entry in systems:
            for player in entry.get("players", []):
                names[player] = names.get(player, 0) + 1
        print("pseudos distincts  : {}".format(len(names)))
        top = sorted(names.items(), key=lambda kv: -kv[1])[:10]
        if top:
            print("\nles plus vus (lectures brutes) :")
            for name, count in top:
                print("   {:<24} {} systeme(s)".format(name, count))
        return

    if args.system:
        try:
            x, y = (int(v) for v in args.system.replace(" ", "").split(","))
        except ValueError:
            raise SystemExit("Format attendu : --system 1004,7")
        entry = store.get(x, y)
        if not entry:
            print("Aucun systeme releve en ({}, {}).".format(x, y))
            return
        show_system(entry)
        return

    if args.name:
        wanted = args.name.strip().upper()
        found = [e for e in systems if (e.get("name") or "").upper().startswith(wanted)]
        print("{} systeme(s) dont le nom commence par {}".format(len(found), wanted))
        for entry in found[:args.limit]:
            show_system(entry)
        return

    if args.full:
        found = [e for e in systems if len(e.get("players", [])) >= 12]
        print("{} systeme(s) complets".format(len(found)))
        for entry in sorted(found, key=lambda e: (e["x"], e["y"]))[:args.limit]:
            print("   {:<14} ({}, {})".format(entry.get("name") or "?", entry["x"], entry["y"]))
        return

    if args.empty:
        found = [e for e in systems if not e.get("players")]
        print("{} systeme(s) inhabites".format(len(found)))
        for entry in sorted(found, key=lambda e: (e["x"], e["y"]))[:args.limit]:
            print("   {:<14} ({}, {})".format(entry.get("name") or "?", entry["x"], entry["y"]))
        return

    # Recherche d'un joueur.
    hits = []
    for entry in systems:
        for player in entry.get("players", []):
            score = similarity(player, args.player)
            if score >= THRESHOLD:
                hits.append((score, entry, player))

    if not hits:
        print("Aucune colonie trouvee pour {!r}.".format(args.player))
        print("La base couvre {} systeme(s) — il n'y est peut-etre pas encore.".format(
            len(systems)))
        return

    hits.sort(key=lambda h: -h[0])
    print("{} colonie(s) trouvee(s) pour {!r} :\n".format(len(hits), args.player))
    for score, entry, player in hits[:args.limit]:
        print("   ({:>4}, {:>4})  {:<14}  lu {!r}  ({:.2f})".format(
            entry["x"], entry["y"], entry.get("name") or "?", player, score))


if __name__ == "__main__":
    main()
