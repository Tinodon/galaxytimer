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


def slot_reads(entry):
    """Les lectures candidates de chaque emplacement d'un systeme.

    Les relevés d'avant la correction ne portent qu'une lecture par
    emplacement ; on les traite comme une liste d'un seul element plutot que de
    les ecarter.
    """
    players = entry.get("players", [])
    reads = entry.get("reads") or []
    return [
        list(dict.fromkeys(reads[i])) if i < len(reads) and reads[i] else [name]
        for i, name in enumerate(players)
    ]


def pick(candidates, resolved):
    """La meilleure lecture d'un emplacement, et ce qu'elle designe.

    Une lecture qui tombe sur un joueur reel bat une lecture qui ne mene nulle
    part, quelle que soit sa longueur ; a egalite, le meilleur score gagne.
    """
    best = None
    for raw in candidates:
        result = resolved[raw]
        rank = (1 if result["name"] else 0, result["score"] or 0)
        if best is None or rank > best[0]:
            best = (rank, raw, result)
    return (best[1], best[2]) if best else (None, None)


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

    # Chaque emplacement porte plusieurs lectures, une par seuil de binarisation.
    # On les rapproche TOUTES et on garde la meilleure : c'est ici, et seulement
    # ici, qu'on sait laquelle designe quelqu'un de reel. Trancher plus tot sur
    # la longueur retenait la lecture la plus bruitee.
    raw_names = Counter()
    for entry in systems:
        for candidates in slot_reads(entry):
            raw_names.update(candidates)

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
    slots = ok_slots = rescued = 0
    for entry in systems:
        for candidates in slot_reads(entry):
            slots += 1
            raw, result = pick(candidates, resolved)
            if result and result["name"]:
                ok_slots += 1
                # Une colonie que l'ancienne regle aurait perdue : la lecture la
                # plus longue ne menait a personne, une autre si.
                if len(candidates) > 1 and raw != max(candidates, key=len):
                    rescued += 1
    print("\n--- colonies ---")
    print("  {}/{} colonies rattachees a un joueur reel ({:.0f}%)".format(
        ok_slots, slots, 100 * ok_slots / max(slots, 1)))
    if rescued:
        print("  dont {} rattrapees en essayant tous les seuils de lecture".format(
            rescued))

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
            for candidates in slot_reads(entry):
                raw, result = pick(candidates, resolved)
                players.append({
                    "raw": raw,
                    "name": result["name"],
                    "score": result["score"],
                    # Les autres lectures du meme emplacement, pour pouvoir
                    # verifier une correction sans relire l'image.
                    "reads": candidates,
                })
            handle.write(json.dumps({**entry, "players": players},
                                    ensure_ascii=False) + "\n")

    print("\nEcrit : {}".format(RESOLVED_FILE))
    print("Ecrit : {}".format(NAMES_FILE))


if __name__ == "__main__":
    main()
