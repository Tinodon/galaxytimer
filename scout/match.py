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
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from names import canonical, merge_variants, weighted_distance  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
ROSTER_FILE = BASE_DIR / "data" / "roster.json"
LEVELS_FILE = BASE_DIR / "data" / "roster_niveaux.json"

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
SHORT_NAME_LENGTH = 3        # accepte seulement exact ET confirme par les lettres
MIN_LENGTH_RATIO = 0.75      # une correction ne doit pas refaire le mot
MAX_JUNK_RATIO = 0.25        # trop de signes = du bruit, pas un pseudo

# Ressemblance minimale entre les lettres de l'image et celles du pseudo retenu,
# quand la verification lettre a lettre est utilisee.
MIN_LETTERS = 0.80
MIN_LETTERS_CORRECTED = 0.90


def reading_is_usable(reading):
    """La lecture vaut-elle la peine d'etre rapprochee ? (motif du refus sinon)"""
    flat = "".join(c for c in str(reading) if c.isalnum())
    if len(flat) < MIN_READ_LENGTH:
        return "lecture trop courte"
    if len(reading) and sum(1 for c in reading if not c.isalnum()) / len(reading) > MAX_JUNK_RATIO:
        return "lecture trop bruitee"
    return None


def _level_fits(name, level, levels):
    """Le niveau de ce joueur colle-t-il a celui lu sur la vignette ?

    Sans niveau connu pour le joueur, ou sans niveau lu, on ne conclut pas :
    l'absence de preuve n'est pas une preuve d'absence, et rejeter dans le
    doute perdrait bien plus de colonies que la mesure n'en sauve.

    La vignette date de la capture, l'API d'aujourd'hui : entre les deux, le
    joueur a pu monter, parfois beaucoup (Myra : 89 sur la capture, 96 deux
    jours plus tard). L'ancienne regle, un cran d'ecart dans un sens ou dans
    l'autre, aurait rejete la vraie Myra. D'ou une regle a sens unique :
      - l'API ne peut pas etre SOUS la vignette (un niveau ne redescend pas ;
        un cran de marge pour une lecture limite) ;
      - elle peut etre au-dessus, dans une limite : max(15, 25 % du niveau lu).
    Ce qui rejette toujours NOSTER -> Noster (vignette 4, API 101) ou
    Meowbah (23 -> 281), les fausses attributions que ce controle vise.
    """
    if level is None or not levels:
        return True
    known = levels.get(name)
    if known is None:
        return True
    return level_growth_fits(int(level), int(known))


def level_growth_fits(on_tile, now):
    """Un joueur lu au niveau `on_tile` peut-il etre au niveau `now` aujourd'hui ?"""
    if now < on_tile - 1:
        return False
    return now - on_tile <= max(15, on_tile * 0.25)


def _levenshtein(a, b):
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1,
                               previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def literal(name):
    """Minuscules, lettres et chiffres seulement, sans rien confondre."""
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


class Roster:
    """Le dictionnaire des joueurs, indexe pour la recherche approchee."""

    def __init__(self, names=None):
        if names is None:
            if not ROSTER_FILE.exists():
                raise SystemExit(
                    "Dictionnaire absent. Lance d'abord : python scout/roster.py")
            names = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))

        # Niveaux connus, quand roster.py les a releves. Optionnels : sans eux
        # le rapprochement fonctionne comme avant, simplement sans la preuve
        # qui departage deux pseudos aussi plausibles l'un que l'autre.
        self.levels = {}
        if LEVELS_FILE.exists():
            try:
                self.levels = json.loads(LEVELS_FILE.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass

        self.names = names
        self.canonical = [canonical(n) for n in names]
        self.exact = {}
        # Index LITTERAL : minuscules, lettres et chiffres seulement, SANS
        # applatir les lettres qui se ressemblent. `canonical` confond U, L et I
        # (et S avec B) : "ULSUS" et "Lisus" y deviennent tous deux "iibib", et
        # une lecture parfaite designait le mauvais joueur. Une lecture qui colle
        # lettre pour lettre a un vrai pseudo passe desormais avant tout le reste.
        self.literal = defaultdict(list)
        # Tous les pseudos sous forme litterale, pour chercher une lecture dont
        # une lettre a ete coupee ou mangee par le decor.
        self.literal_names = []
        self.index = defaultdict(list)

        for position, flat in enumerate(self.canonical):
            # Premier arrive, premier servi : deux pseudos de forme canonique
            # identique (Tinodon / T1n0don) ne peuvent de toute facon pas etre
            # departages par une lecture d'image.
            self.exact.setdefault(flat, position)
            plain = literal(names[position])
            self.literal[plain].append(position)
            self.literal_names.append(plain)
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

    def _pick(self, positions, level):
        """Un seul joueur parmi des pseudos litteralement identiques a la lecture.

        Le niveau DEPARTAGE, il n'elimine jamais : lu par OCR, il est faux une
        fois sur deux ("96" lu "36"), et s'en servir pour refuser tuait des
        lectures parfaites.
        """
        positions = list(dict.fromkeys(positions))
        if len(positions) == 1:
            return positions[0]
        if level is not None:
            fitting = [p for p in positions if self._level_fits(self.names[p], level)
                       and self.levels.get(self.names[p]) is not None]
            if len(fitting) == 1:
                return fitting[0]
        return None

    def _literal_match(self, reading, level):
        """Pseudo reel ecrit EXACTEMENT comme la lecture, ou presque.

        Dans l'ordre, du plus sur au moins sur :
          1. la lecture telle quelle ;
          2. sans un caractere parasite au debut ou a la fin ("_HIRIKI",
             "KALOLOXD_", "GORANLl") ;
          3. en rendant au 0 les O d'une suite de chiffres ("HARVEYOOO") et au
             W les UV / VV d'un W eclate ("KLEUVIN") ;
          4. une lecture dont la premiere ou la derniere lettre a ete coupee par
             le bord de la vignette : un seul pseudo reel la contient
             ("EANDREPONCET" dans leandreponcet).
        """
        plain = literal(reading)
        if len(plain) < 3:
            return None

        forms = [plain]
        for form in (plain[1:], plain[:-1], plain[1:-1]):
            if len(form) >= 3:
                forms.append(form)
        for form in list(forms):
            fixed = re.sub(r"(?<=[0-9o])o|o(?=[0-9o]*[0-9])", "0", form)
            fixed = fixed.replace("uv", "w").replace("vv", "w")
            if fixed != form:
                forms.append(fixed)

        # Chiffres de fin lus comme des lettres : "WILLYSOSAIS" pour willysosa15.
        # Seulement sur les trois derniers caracteres, ou le jeu met les chiffres.
        digit_like = {"i": "1", "l": "1", "s": "5", "o": "0", "z": "2", "b": "8", "g": "9"}
        for form in list(forms):
            head, tail = form[:-3], form[-3:]
            swapped = "".join(digit_like.get(c, c) for c in tail)
            if swapped != tail:
                forms.append(head + swapped)
                # un seul chiffre change a la fois aussi ("sa15" : le a reste)
                for i, c in enumerate(tail):
                    if c in digit_like:
                        forms.append(head + tail[:i] + digit_like[c] + tail[i + 1:])

        for index, form in enumerate(forms):
            positions = self.literal.get(form)
            if positions:
                chosen = self._pick(positions, level)
                if chosen is not None:
                    return {"name": self.names[chosen],
                            "score": 1.0 if index == 0 else 0.98,
                            "reason": "litteral" if index == 0 else "litteral corrige"}

        # Le pseudo de la vignette VOISINE deborde dans la lecture : "HARVEYOOOLE"
        # = harvey000 + "LE" de LEANDREPONCET. On retire jusqu'a 3 caracteres
        # a la fin, et on n'accepte qu'un pseudo assez long pour etre sur.
        for form in forms:
            for cut in (1, 2, 3):
                shorter = form[:-cut]
                # Refus si un AUTRE vrai pseudo prolonge ce debut : "HYSTERIANS"
                # coupe en hysteria alors que Hysteria19 existe — les lettres
                # retirees etaient peut-etre ses chiffres, pas le voisin.
                longer = [n for n in self.literal_names
                          if n != shorter and n.startswith(shorter) and len(n) <= len(form) + 1]
                if len(shorter) >= 6 and shorter in self.literal and not longer:
                    chosen = self._pick(self.literal[shorter], level)
                    if chosen is not None:
                        return {"name": self.names[chosen], "score": 0.93,
                                "reason": "litteral, debordement du voisin"}

        # Lettre coupee au bord : un pseudo reel un peu plus long qui contient
        # la lecture. Seulement pour une lecture assez longue pour etre
        # discriminante, et seulement si elle ne designe qu'UN joueur.
        if len(plain) >= 7:
            for form in forms:
                found = [i for i, name in enumerate(self.literal_names)
                         if form in name and len(name) <= len(form) + 2]
                chosen = self._pick(found, level) if found else None
                if chosen is not None:
                    return {"name": self.names[chosen], "score": 0.95,
                            "reason": "litteral, lettre coupee"}
        return None

    def match_slot(self, reads, level=None, margin=0.05, verify=None, finalists=3):
        """Meilleur pseudo pour UNE vignette, a partir de TOUTES ses lectures.

        Chaque seuil donne une lecture. Un seuil qui mange une lettre peut
        tomber, par hasard, sur un autre vrai joueur : "MOONLIGHTR" lu
        "MOONLIGHT" designait MoonLight, "KLEWIN" lu "KLEIN" designait Klein.
        Prendre la meilleure lecture isolee retenait ces faux.

        On rassemble donc les candidats proposes par chaque lecture, puis on
        garde celui qui ressemble le plus a L'ENSEMBLE des lectures. Si deux
        candidats restent trop proches, on ne tranche pas : mieux vaut une
        vignette a verifier a la main qu'un pseudo faux en base.
        """
        proposals = {}
        for read in reads:
            m = self.match(read, level=level)
            if m["name"]:
                proposals.setdefault(m["name"], m)
        if not proposals:
            return {"name": None, "score": 0.0, "reason": "aucune lecture ne donne un joueur",
                    "consensus": []}

        plains = [literal(r) for r in reads if literal(r)]


        def similarity(a, b):
            return 1 - _levenshtein(a, b) / max(len(a), len(b), 1)

        ranked = sorted(
            ((sum(similarity(p, literal(name)) for p in plains) / len(plains), name)
             for name in proposals),
            reverse=True,
        )

        # Verification LETTRE A LETTRE sur l'image, pour les finalistes
        # seulement (elle coute environ une seconde par candidat). Les lectures
        # ne voient que des caracteres ; les gabarits voient leur forme et leur
        # largeur, et un W prend deux fois la place d'un I : c'est ce qui separe
        # klewin de Klein quand un seuil a mange le W.
        self.last_letters = {}
        # Doute mesure AVANT de meler le score des lettres.
        # Toute CORRECTION est aussi un doute : une lettre retiree ou un O
        # change en 0 sur une lecture deja trop courte donnait Pedr0 pour
        # PedroP, Koloss pour kolos69. Seule une lecture exacte en est dispensee.
        in_doubt = (len(proposals) > 1 or ranked[0][0] < 0.95
                    or len(literal(ranked[0][1])) <= SHORT_NAME_LENGTH
                    or proposals[ranked[0][1]].get("reason") not in ("litteral", "exact"))
        if verify is not None:
            rescored = []
            for score, name in ranked[:finalists]:
                letters = verify(name)
                self.last_letters[name] = round(letters, 3)
                rescored.append(((score + letters) / 2, name))
            ranked = sorted(rescored, reverse=True) + ranked[finalists:]
        best_score, best_name = ranked[0]
        consensus = [(name, round(score, 3)) for score, name in ranked]
        # Les lettres ne tranchent qu'en cas de DOUTE : plusieurs joueurs
        # proposes, ou des lectures qui ne sont pas d'accord entre elles. Une
        # lecture qui tombe pile sur un vrai pseudo a chaque seuil n'a pas a etre
        # contredite par des gabarits qui connaissent mal certaines lettres
        # (GoranL et xqxqx, pourtant justes, auraient ete rejetes).
        # Une lecture CORRIGEE (lettre retiree, O change en 0...) doit coller
        # nettement aux lettres de l'image : sur les captures verifiees, les
        # corrections fausses (Pedr0, Koloss, Cycu123, plato) etaient toutes
        # entre 0,81 et 0,88, les justes au-dessus.
        corrected = proposals[best_name].get("reason") not in ("litteral", "exact")
        needed = MIN_LETTERS_CORRECTED if corrected else MIN_LETTERS
        if verify is not None and in_doubt and self.last_letters.get(best_name, 1.0) < needed:
            return {"name": None, "score": round(best_score, 3), "consensus": consensus,
                    "letters": self.last_letters,
                    "reason": "les lettres de l'image ne collent pas a {}".format(best_name)}
        if len(ranked) > 1 and best_score - ranked[1][0] < margin:
            return {"name": None, "score": round(best_score, 3), "consensus": consensus,
                    "reason": "hesite entre {} et {}".format(best_name, ranked[1][1])}
        chosen = dict(proposals[best_name])
        chosen["consensus"] = consensus
        chosen["letters"] = self.last_letters
        return chosen

    def _level_fits(self, name, level):
        return _level_fits(name, level, self.levels)

    def match(self, reading, level=None):
        """Meilleur pseudo reel pour cette lecture, ou None si trop incertain.

        `level` : le niveau lu sur la vignette du jeu. L'API donne le niveau de
        chaque joueur, donc un candidat dont le niveau ne correspond pas n'est
        pas le bon, quelle que soit la ressemblance des lettres. C'est la seule
        chose qui rattrape une lecture fausse tombee par hasard sur un joueur
        existant : NOSTER lu a la place de MOSTER designait "Noster", niveau
        101, sur une vignette qui affiche 4.

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
            # Un pseudo de 3 lettres (BAS) reste possible, mais UNIQUEMENT s'il
            # existe tel quel : aucune correction sur une lecture aussi courte.
            # match_slot exige en plus que les lettres de l'image le confirment.
            plain = literal(reading)
            if (len(plain) == SHORT_NAME_LENGTH and unusable == "lecture trop courte"
                    and plain in self.literal):
                chosen = self._pick(self.literal[plain], level)
                if chosen is not None:
                    return {"name": self.names[chosen], "score": 1.0, "reason": "litteral court"}
            return {"name": None, "score": 0.0, "reason": unusable}

        # Les formes obtenues en recollant un glyphe eclate ("aayra" -> "myra").
        # Elles servent a TROUVER des candidats ; le score reste mesure sur la
        # lecture d'origine, donc rien n'est offert gratuitement.
        forms = merge_variants(flat)

        hit = self._literal_match(reading, level)
        if hit:
            return hit

        if flat in self.exact:
            position = self.exact[flat]
            name = self.names[position]
            if self._level_fits(name, level):
                return {"name": name, "score": 1.0, "reason": "exact"}
            # Lecture qui existe telle quelle mais designe quelqu'un d'un autre
            # niveau : on ne la valide pas, on cherche plus loin.

        pool = []
        for form in forms:
            for position in self.candidates(form):
                if position not in pool:
                    pool.append(position)

        scored = []
        for position in pool:
            other = self.canonical[position]
            # Distance ponderee : les confusions que la lecture commet
            # reellement coutent moins cher qu'un changement impossible.
            score = 1 - weighted_distance(flat, other) / max(len(flat), len(other))
            scored.append((score, position))

        if not scored:
            return {"name": None, "score": 0.0, "reason": "aucun candidat"}

        scored.sort(reverse=True)

        # Le niveau elimine les candidats impossibles AVANT le classement, donc
        # avant le test d'ambiguite : deux pseudos a egalite dont un seul a le
        # bon niveau ne sont plus ambigus du tout.
        if level is not None and self.levels:
            kept = [(sc, pos) for sc, pos in scored
                    if self._level_fits(self.names[pos], level)]
            if kept:
                scored = kept

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
