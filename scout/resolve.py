"""Rapproche tous les pseudos lus des joueurs reellement existants.

C'est l'etape qui transforme des lectures approximatives en donnees utilisables.
Un pseudo lu tel quel dans le dictionnaire est accepte ; sinon on cherche le
joueur existant le plus proche, en n'autorisant que les echanges de lettres que
la lecture commet vraiment (2/Z, 0/O, 1/I...). Si aucun n'est assez proche, on
refuse plutot que de designer quelqu'un au hasard.

    python scout/resolve.py            rapproche et rend compte
    python scout/resolve.py --write    ecrit les pseudos corriges en base
    python scout/resolve.py --sample 30  montre trente corrections au hasard

Le fichier d'origine n'est jamais modifie sans --write : on peut mesurer avant
de decider.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from match import Roster  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
SYSTEMS_FILE = BASE_DIR / "data" / "systems.jsonl"
RESOLVED_FILE = BASE_DIR / "data" / "systems_resolus.jsonl"
NAMES_FILE = BASE_DIR / "data" / "pseudos_resolus.json"


def load_systems():
    entries = {}
    with SYSTEMS_FILE.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            # Une meme position peut apparaitre plusieurs fois : le balayage
            # revoit un systeme depuis plusieurs ecrans. La derniere lecture
            # fait foi.
            entries[(entry["x"], entry["y"])] = entry
    return list(entries.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--sample", type=int, default=0)
    args = parser.parse_args()

    systems = load_systems()
    raw_names = Counter()
    for entry in systems:
        raw_names.update(entry.get("players", []))

    print("{} systeme(s), {} colonie(s), {} pseudo(s) distincts".format(
        len(systems),
        sum(len(e.get("players", [])) for e in systems),
        len(raw_names)))

    roster = Roster()
    print("{} joueur(s) au dictionnaire\n".format(len(roster.names)))

    started = time.time()
    resolved = {}
    reasons = Counter()

    for index, name in enumerate(raw_names, start=1):
        result = roster.match(name)
        resolved[name] = result
        reasons[result["reason"]] += 1
        if index % 2000 == 0:
            rate = index / max(time.time() - started, 1)
            print("  ... {}/{}  ({:.0f}/s)".format(index, len(raw_names), rate))

    exact = reasons["exact"]
    fixed = reasons["approche"]
    refused = len(raw_names) - exact - fixed

    print("\n--- lectures distinctes ---")
    print("  reconnues telles quelles : {:>6}  ({:.0f}%)".format(
        exact, 100 * exact / len(raw_names)))
    print("  corrigees vers un joueur : {:>6}  ({:.0f}%)".format(
        fixed, 100 * fixed / len(raw_names)))
    print("  non resolues             : {:>6}  ({:.0f}%)".format(
        refused, 100 * refused / len(raw_names)))
    for reason, count in reasons.most_common():
        if reason not in ("exact", "approche"):
            print("      dont {:<16} {}".format(reason, count))

    # Pondere par le nombre de colonies : une lecture qui revient souvent pese
    # plus qu'une vue une seule fois.
    slots = ok_slots = 0
    for entry in systems:
        for name in entry.get("players", []):
            slots += 1
            if resolved[name]["name"]:
                ok_slots += 1
    print("\n--- colonies ---")
    print("  {}/{} colonies rattachees a un joueur reel ({:.0f}%)".format(
        ok_slots, slots, 100 * ok_slots / max(slots, 1)))

    if args.sample:
        corrections = [(k, v) for k, v in resolved.items()
                       if v["reason"] == "approche"]
        random.seed(1)
        print("\n--- {} corrections au hasard ---".format(args.sample))
        for raw, result in random.sample(corrections, min(args.sample, len(corrections))):
            print("  {:<24} -> {:<24} {}".format(raw, result["name"], result["score"]))

    if not args.write:
        print("\nRien ecrit. Ajoute --write pour enregistrer les pseudos corriges.")
        return

    NAMES_FILE.write_text(json.dumps(
        {k: {"name": v["name"], "score": v["score"], "reason": v["reason"]}
         for k, v in resolved.items()}, ensure_ascii=False), encoding="utf-8")

    with RESOLVED_FILE.open("w", encoding="utf-8") as handle:
        for entry in systems:
            players = []
            for name in entry.get("players", []):
                result = resolved[name]
                players.append({
                    "raw": name,
                    "name": result["name"],
                    "score": result["score"],
                })
            handle.write(json.dumps({**entry, "players": players},
                                    ensure_ascii=False) + "\n")

    print("\nEcrit : {}".format(RESOLVED_FILE))
    print("Ecrit : {}".format(NAMES_FILE))


if __name__ == "__main__":
    main()
