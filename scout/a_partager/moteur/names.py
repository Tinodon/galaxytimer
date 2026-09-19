"""Rapprochement entre un pseudo lu par l'OCR et un vrai pseudo du jeu.

L'OCR ne rend jamais exactement le nom : la police du jeu confond
systematiquement certaines formes. Observe sur de vraies captures :

    SzuetamNarab  ->  SZUETANNARAB   (m lu "nn")
    Briankings    ->  SRIANKINGS     (B lu S)
    YaGirlTie     ->  YAGIRUTIE      (l lu U)
    ALPHERATZ     ->  ALPHERATS      (Z lu S)

Interroger l'API a chaque lecture couterait des dizaines de requetes par
systeme, ce qui est intenable sur des dizaines de milliers d'ecrans. On stocke
donc la lecture brute pendant le balayage, et on rapproche au moment de la
consultation, hors ligne.

La regle : dans le doute, ne rien affirmer. Un faux rapprochement envoie
quelqu'un attaquer une base qui n'est pas la bonne.
"""

from __future__ import annotations

# Formes que la police du jeu rend indistinguables. On ramene les deux cotes
# a un meme symbole avant de comparer, plutot que de tolerer une distance
# d'edition plus grande — ce qui creerait des faux positifs ailleurs.
CONFUSIONS = [
    ("m", "nn"),
    ("rn", "nn"),
    ("b", "s"),
    ("8", "s"),
    ("l", "u"),
    ("i", "l"),
    ("1", "l"),
    ("z", "s"),
    ("2", "z"),
    ("0", "o"),
    ("5", "s"),
    ("g", "q"),
    ("vv", "w"),
]


def canonical(name):
    """Forme comparable : minuscules, sans separateur, confusions applatis."""
    text = "".join(ch for ch in str(name).lower() if ch.isalnum())
    # Les paires les plus longues d'abord, sinon "nn" serait coupe par "n".
    for left, right in sorted(CONFUSIONS, key=lambda p: -max(len(p[0]), len(p[1]))):
        symbol = left if len(left) <= len(right) else right
        text = text.replace(left, symbol).replace(right, symbol)
    return text


# Couts de substitution. Remplacer un caractere par un autre ne coute pas
# toujours pareil : les gabarits confondent en permanence 2 et Z, jamais A et W.
# Une distance d'edition ordinaire, qui compte tout a 1, ne peut pas departager
# deux joueurs reels a un caractere de la lecture — l'un obtenu par une
# confusion que l'OCR commet vraiment, l'autre par un changement impossible.
#
# Idee de Noe : n'autoriser que les echanges de lettres que la lecture peut
# reellement produire, et tomber ainsi sur le seul joueur existant plausible.
CONFUSABLE = [
    "0oOQD", "1lIiJ", "2Zz", "5Ss", "8B", "6Gb", "9gq", "uUvV",
    "mnN", "rn", "cC", "eE", "tT", "yY", "xX", "kK", "wW", "AA4",
]

# Cout d'un echange entre caracteres visuellement proches. Assez bas pour que la
# bonne correction gagne, assez haut pour qu'accumuler les corrections coute.
CONFUSION_COST = 0.3


def _build_costs():
    costs = {}
    for group in CONFUSABLE:
        flat = [c.lower() for c in group]
        for a in flat:
            for b in flat:
                if a != b:
                    costs[(a, b)] = CONFUSION_COST
    return costs


SUBSTITUTION_COSTS = _build_costs()


def substitution_cost(a, b):
    if a == b:
        return 0.0
    return SUBSTITUTION_COSTS.get((a.lower(), b.lower()), 1.0)


# Un seul glyphe lu comme PLUSIEURS caracteres. La police du jeu dessine M et W
# en traits separes, que l'OCR rend regulierement en deux ou trois lettres :
# MYRA sort "AAYRA", HANSWORSDT sort "HANSVWWORSDT". Compte comme deux ou trois
# fautes, ces lectures tombaient sous le seuil et etaient refusees alors qu'un
# seul glyphe avait ete mal lu — c'est la raison pour laquelle une membre de
# l'alliance restait introuvable sur une case pourtant relevee.
#
# Uniquement des confusions constatees sur des captures reelles : une regle
# inventee rapprocherait des pseudos qui n'ont rien a voir.
MERGES = {
    "m": ("aa", "rn", "nn", "vv", "in"),
    "w": ("vw", "vv", "uu", "vwv", "vww", "wv"),
    "u": ("ii", "ll"),
    "d": ("cl",),
    "o": ("cj",),
}

# Meme cout qu'une confusion simple : c'est bien un seul glyphe mal lu.
MERGE_COST = CONFUSION_COST

_MERGE_COSTS = {(part, single) for single, parts in MERGES.items() for part in parts}
_MERGE_WIDTHS = sorted({len(part) for part, _ in _MERGE_COSTS}, reverse=True)


def _merge_cost(chunk, single):
    return MERGE_COST if (chunk, single) in _MERGE_COSTS else None


def weighted_distance(a, b):
    """Distance d'edition ou les confusions de lecture coutent moins cher.

    En plus des echanges de lettres, la distance autorise le repli de plusieurs
    caracteres sur un seul (voir MERGES) : sans ca, un glyphe eclate en deux
    comptait pour deux fautes et eloignait la lecture de son vrai pseudo.
    """
    if a == b:
        return 0.0
    if not a:
        return float(len(b))
    if not b:
        return float(len(a))

    # Matrice complete plutot que deux lignes glissantes : un repli de trois
    # caracteres a besoin de remonter trois lignes en arriere.
    rows = len(a) + 1
    cols = len(b) + 1
    grid = [[0.0] * cols for _ in range(rows)]
    for i in range(rows):
        grid[i][0] = float(i)
    for j in range(cols):
        grid[0][j] = float(j)

    for i in range(1, rows):
        ca = a[i - 1]
        for j in range(1, cols):
            cb = b[j - 1]
            best = min(
                grid[i - 1][j] + 1.0,
                grid[i][j - 1] + 1.0,
                grid[i - 1][j - 1] + substitution_cost(ca, cb),
            )
            for width in _MERGE_WIDTHS:
                # Plusieurs caracteres de `a` pour un seul de `b`.
                if i >= width:
                    cost = _merge_cost(a[i - width:i], cb)
                    if cost is not None:
                        best = min(best, grid[i - width][j - 1] + cost)
                # ... et l'inverse, la lecture pouvant etre du cote `b`.
                if j >= width:
                    cost = _merge_cost(b[j - width:j], ca)
                    if cost is not None:
                        best = min(best, grid[i - 1][j - width] + cost)
            grid[i][j] = best

    return grid[-1][-1]


def distance(a, b):
    """Distance de Levenshtein, en gardant seulement deux lignes en memoire."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)

    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (ca != cb),
            ))
        previous = current
    return previous[-1]


def similarity(ocr_name, real_name):
    """Score entre 0 et 1 apres applatissement des confusions."""
    a, b = canonical(ocr_name), canonical(real_name)
    if not a or not b:
        return 0.0
    return 1 - distance(a, b) / max(len(a), len(b))


# En dessous, on considere que ce n'est pas la meme personne. Regle sur de
# vraies lectures : les bons rapprochements depassent 0.85, les mauvais
# plafonnent nettement plus bas.
THRESHOLD = 0.82


def best_match(ocr_name, candidates, threshold=THRESHOLD):
    """Meilleur candidat, ou None si aucun n'est assez proche.

    Renvoie aussi None en cas d'egalite entre deux candidats : mieux vaut ne
    rien dire que designer le mauvais joueur.
    """
    scored = sorted(
        ((similarity(ocr_name, c), c) for c in candidates),
        key=lambda pair: -pair[0],
    )
    if not scored or scored[0][0] < threshold:
        return None
    if len(scored) > 1 and abs(scored[0][0] - scored[1][0]) < 0.02:
        return None
    return {"name": scored[0][1], "score": round(scored[0][0], 3)}


# Lectures produites par une case vide "FREE PLANET". Les marqueurs passent par
# la meme normalisation que le texte compare, sinon ils ne correspondent jamais.
FREE_MARKERS = ("free", "planet", "coce", "ptanet", "pianet")


def looks_like_free_slot(ocr_name):
    """Vrai si cette lecture vient d'un emplacement libre, pas d'un joueur."""
    flat = canonical(ocr_name)
    if len(flat) < 4:
        return True
    return any(canonical(marker) in flat for marker in FREE_MARKERS)


def merge_variants(flat, limit=24):
    """Formes possibles de la lecture une fois les glyphes eclates recolles.

    "aayra" donne "myra", "hansvwworsdt" donne "hansworsdt". Sans ca, la
    recherche par bigrammes ne PROPOSE jamais le bon pseudo : "aayra" partage
    trop peu de bigrammes avec "myra" pour figurer parmi les candidats, et la
    distance, si bonne soit-elle, n'est jamais calculee. Recoller d'abord, puis
    chercher.

    La lecture d'origine fait toujours partie du resultat.
    """
    seen = [flat]
    frontier = [flat]
    while frontier and len(seen) < limit:
        current = frontier.pop()
        for single, parts in MERGES.items():
            for part in parts:
                start = current.find(part)
                while start != -1 and len(seen) < limit:
                    candidate = current[:start] + single + current[start + len(part):]
                    if candidate not in seen:
                        seen.append(candidate)
                        frontier.append(candidate)
                    start = current.find(part, start + 1)
    return seen
