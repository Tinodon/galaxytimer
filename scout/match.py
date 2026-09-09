"""Rapproche une lecture approximative du pseudo reel correspondant.

C'est la piece qui rend la qualite de la lecture secondaire. Lire
`FORTHNITE739XD` au lieu de `FORTNITE799XD` n'a plus d'importance des lors
qu'on connait les 482 776 pseudos existants : la lecture fautive n'a qu'un seul
voisin plausible dans cette liste.

Comparer une lecture aux 482 776 noms un par un serait beaucoup trop lent —
18 000 colonies a rapprocher. On indexe donc par BIGRAMMES : deux noms proches
partagent forcement des couples de lettres, et il suffit d'examiner ceux qui en
partagent assez. Le nombre de candidats tombe de 482 776 a quelques dizaines.

    python scout/match.py <lecture>     essaie un rapprochement
    python scout/match.py --check       mesure sur les pseudos verifies par Noe
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from names import canonical, weighted_distance  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
ROSTER_FILE = BASE_DIR / "data" / "roster.json"

# Au-dessous, on refuse de trancher. Mieux vaut signaler un pseudo incertain que
# d'en designer un faux : une coordonnee attribuee au mauvais joueur envoie
# quelqu'un attaquer dans le vide.
MIN_SCORE = 0.72

# Ecart minimal entre le meilleur et le second candidat. Deux noms aussi proches
# l'un que l'autre de la lecture ne peuvent pas etre departages honnetement.
MIN_MARGIN = 0.04

# Le score seul ne suffit pas : il mesure la distance au voisin le plus proche,
# jamais si la LECTURE valait quelque chose. Avec 482 776 noms, n'importe quel
# charabia finit par avoir un voisin a 0.80 — c'est ainsi que `aoe__-oo`, qui
# etait en realite `XNMY`, s'est vu attribuer `noe00`. Un faux positif est bien
# pire qu'un refus : il envoie quelqu'un attaquer une base qui n'existe pas.
#
# Ces trois garde-fous portent sur la lecture elle-meme, pas sur sa distance.
MIN_READ_LENGTH = 4          # en dessous, il n'y a pas de quoi identifier
MIN_LENGTH_RATIO = 0.75      # une correction ne doit pas refaire le mot
MAX_JUNK_RATIO = 0.25        # trop de signes = du bruit, pas un pseudo


def reading_is_usable(reading):
    """La lecture vaut-elle la peine d'etre rapprochee ? (motif du refus sinon)"""
    flat = "".join(c for c in str(reading) if c.isalnum())
    if len(flat) < MIN_READ_LENGTH:
        return "lecture trop courte"
    if len(reading) and sum(1 for c in reading if not c.isalnum()) / len(reading) > MAX_JUNK_RATIO:
        return "lecture trop bruitee"
    return None


class Roster:
    """Le dictionnaire des joueurs, indexe pour la recherche approchee."""

    def __init__(self, names=None):
        if names is None:
            if not ROSTER_FILE.exists():
                raise SystemExit(
                    "Dictionnaire absent. Lance d'abord : python scout/roster.py")
            names = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))

        self.names = names
        self.canonical = [canonical(n) for n in names]
        self.exact = {}
        self.index = defaultdict(list)

        for position, flat in enumerate(self.canonical):
            # Premier arrive, premier servi : deux pseudos de forme canonique
            # identique (Tinodon / T1n0don) ne peuvent de toute facon pas etre
            # departages par une lecture d'image.
            self.exact.setdefault(flat, position)
            for gram in self._bigrams(flat):
                self.index[gram].append(position)

    @staticmethod
    def _bigrams(flat):
        if len(flat) < 2:
            return {flat} if flat else set()
        return {flat[i:i + 2] for i in range(len(flat) - 1)}

    def candidates(self, flat, max_candidates=60):
        """Positions des noms partageant assez de bigrammes avec la lecture."""
        grams = self._bigrams(flat)
        if not grams:
            return []

        counts = defaultdict(int)
        for gram in grams:
            for position in self.index.get(gram, ()):
                counts[position] += 1

        # Un nom doit partager au moins un tiers des bigrammes : en dessous, il
        # ne peut pas etre a distance d'edition raisonnable.
        floor = max(1, len(grams) // 3)

        # Filtre de longueur, avant tout calcul : un nom deux fois plus long que
        # la lecture ne peut pas atteindre le score minimal, quelles que soient
        # les substitutions. L'ecarter ici evite une distance d'edition complete
        # pour rien — c'est ce qui rendait le rapprochement des 15 000 lectures
        # interminable.
        span = len(flat)
        low_length = int(span * MIN_SCORE)
        high_length = int(span / MIN_SCORE) + 1

        keep = []
        for position, count in counts.items():
            if count < floor:
                continue
            if not (low_length <= len(self.canonical[position]) <= high_length):
                continue
            keep.append((count, position))

        keep.sort(reverse=True)
        return [position for _, position in keep[:max_candidates]]

    def match(self, reading):
        """Meilleur pseudo reel pour cette lecture, ou None si trop incertain.

        Renvoie un dictionnaire avec le nom, le score, et la raison du refus le
        cas echeant — l'appelant doit pouvoir dire POURQUOI il ne sait pas.
        """
        flat = canonical(reading)
        if not flat:
            return {"name": None, "score": 0.0, "reason": "lecture vide"}

        # Une lecture inexploitable n'est pas rapprochee : mieux vaut ne rien
        # dire que designer le premier voisin venu.
        unusable = reading_is_usable(reading)
        if unusable:
            return {"name": None, "score": 0.0, "reason": unusable}

        if flat in self.exact:
            position = self.exact[flat]
            return {"name": self.names[position], "score": 1.0, "reason": "exact"}

        scored = []
        for position in self.candidates(flat):
            other = self.canonical[position]
            # Distance ponderee : les confusions que la lecture commet
            # reellement coutent moins cher qu'un changement impossible.
            score = 1 - weighted_distance(flat, other) / max(len(flat), len(other))
            scored.append((score, position))

        if not scored:
            return {"name": None, "score": 0.0, "reason": "aucun candidat"}

        scored.sort(reverse=True)
        best_score, best_position = scored[0]
        if best_score < MIN_SCORE:
            return {"name": None, "score": round(best_score, 3),
                    "reason": "trop eloigne", "closest": self.names[best_position]}

        if len(scored) > 1 and best_score - scored[1][0] < MIN_MARGIN:
            return {"name": None, "score": round(best_score, 3), "reason": "ambigu",
                    "between": [self.names[best_position], self.names[scored[1][1]]]}

        # Une correction qui change beaucoup la longueur ne corrige pas une
        # faute de lecture : elle reecrit le mot. Les deux longueurs sont
        # mesurees sous la meme forme, sans quoi un pseudo a tirets comme
        # `lil_miss_seera` serait rejete a tort.
        target = self.canonical[best_position]
        ratio = min(len(flat), len(target)) / max(len(flat), len(target), 1)
        if ratio < MIN_LENGTH_RATIO:
            return {"name": None, "score": round(best_score, 3),
                    "reason": "longueur trop differente",
                    "closest": self.names[best_position]}

        return {"name": self.names[best_position], "score": round(best_score, 3),
                "reason": "approche"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reading", nargs="?")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    roster = Roster()
    print("{} pseudo(s) au dictionnaire\n".format(len(roster.names)))

    if args.check:
        truth = json.loads((BASE_DIR / "truth.json").read_text(encoding="utf-8"))
        expected = [n for key, names in truth.items()
                    if not key.startswith("_") for n in names]
        found = sum(1 for n in expected if canonical(n) in roster.exact)
        print("{}/{} pseudos verifies par Noe presents au dictionnaire ({:.0f}%)".format(
            found, len(expected), 100 * found / len(expected)))
        missing = [n for n in expected if canonical(n) not in roster.exact]
        if missing:
            print("absents : {}".format(", ".join(missing[:10])))
        return

    if not args.reading:
        raise SystemExit("usage: python scout/match.py <lecture>")

    result = roster.match(args.reading)
    print("lecture   : {}".format(args.reading))
    print("resultat  : {}".format(result.get("name") or "NON RESOLU"))
    print("score     : {}".format(result["score"]))
    print("raison    : {}".format(result["reason"]))
    for extra in ("closest", "between"):
        if extra in result:
            print("{:<10}: {}".format(extra, result[extra]))


if __name__ == "__main__":
    main()
