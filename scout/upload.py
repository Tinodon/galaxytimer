"""Envoie la carte relevee dans Upstash, pour que le bot Discord y accede.

Le balayage vit sur le PC de Noe, le bot tourne sur Render : les deux se
rejoignent par Upstash, comme les timers.

Tout envoyer en un seul bloc passerait tout juste sous la limite de taille d'une
valeur, et n'y passerait plus une fois la carte etendue. On DECOUPE donc par
premiere lettre du pseudo : une recherche ne charge qu'un morceau de quelques
kilo-octets au lieu de la carte entiere.

    python scout/upload.py            montre ce qui serait envoye
    python scout/upload.py --apply    envoie pour de bon

Seuls les pseudos rattaches a un joueur reel sont envoyes. Une lecture non
resolue n'aiderait personne a trouver quoi que ce soit, et ferait croire a une
donnee la ou il n'y en a pas.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import load_env  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
RESOLVED_FILE = BASE_DIR / "data" / "systems_resolus.jsonl"

# Cle par premiere lettre de la forme canonique du pseudo. Le bot n'a qu'un
# morceau a charger pour repondre a une recherche.
KEY_PREFIX = "galaxytimer:map:"
INDEX_KEY = "galaxytimer:map:index"

# En dessous, le rapprochement n'etait pas assez sur pour publier le resultat.
MIN_SCORE = 0.78

TIMEOUT = 60


def flatten(name):
    """Copie EXACTE de `flatten` dans src/map.js : minuscules, accents retires,
    seuls a-z et 0-9 gardes.

    Le morceau ou l'on range un joueur doit etre celui ou le bot le cherchera.
    On utilisait `canonical`, qui confond aussi les lettres que l'OCR melange
    (S->b, L->i, O->0, U->i, Z->2, Q->g) : Stijnjr etait range dans "b", le bot
    le cherchait dans "s", et /find repondait "aucune colonie". 18% des joueurs
    publies — tous ceux commencant par S, L, O, Z, U ou Q — etaient ainsi
    introuvables. La confusion de lettres sert a RECONNAITRE un pseudo lu,
    jamais a ranger un pseudo deja reconnu.
    """
    name = unicodedata.normalize("NFD", str(name or "").lower())
    name = "".join(c for c in name if not unicodedata.combining(c))
    return re.sub("[^a-z0-9]", "", name)


def shard_of(name):
    flat = flatten(name)
    return flat[0] if flat else "_"


def build_shards():
    """{lettre: {pseudo: [[x, y, qg], ...]}} a partir des systemes resolus."""
    if not RESOLVED_FILE.exists():
        raise SystemExit(
            "Fichier absent : {}\nLance d'abord : python scout/resolve.py --write".format(
                RESOLVED_FILE))

    shards = defaultdict(lambda: defaultdict(list))
    kept = skipped = 0

    with RESOLVED_FILE.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            for player in entry.get("players", []):
                name = player.get("name")
                if not name or player.get("score", 0) < MIN_SCORE:
                    skipped += 1
                    continue
                kept += 1
                shards[shard_of(name)][name].append(
                    [entry["x"], entry["y"], player.get("hq")])

    # Une meme colonie peut avoir ete vue depuis deux ecrans : on dedoublonne
    # sur les coordonnees, en gardant le niveau de QG connu s'il y en a un.
    for names in shards.values():
        for name, spots in names.items():
            best = {}
            for x, y, hq in spots:
                current = best.get((x, y))
                if current is None or (current is None and hq is not None):
                    best[(x, y)] = hq
                elif hq is not None:
                    best[(x, y)] = hq
            names[name] = [[x, y, hq] for (x, y), hq in sorted(best.items())]

    return shards, kept, skipped


def push(url, token, key, payload):
    response = requests.post(
        "{}/set/{}".format(url.rstrip("/"), key),
        headers={"Authorization": "Bearer " + token, "Content-Type": "text/plain"},
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        timeout=TIMEOUT,
    )
    response.raise_for_status()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    shards, kept, skipped = build_shards()
    players = sum(len(names) for names in shards.values())
    spots = sum(len(v) for names in shards.values() for v in names.values())

    sizes = {
        letter: len(json.dumps(names, ensure_ascii=False).encode("utf-8"))
        for letter, names in shards.items()
    }
    biggest = max(sizes.items(), key=lambda kv: kv[1])

    print("{} colonie(s) retenues, {} ecartees (pseudo non resolu ou doute)".format(
        kept, skipped))
    print("{} joueur(s) distincts, {} coordonnee(s) apres dedoublonnage".format(
        players, spots))
    print("{} morceau(x), le plus gros : '{}' a {:.0f} Ko".format(
        len(shards), biggest[0], biggest[1] / 1024))

    if not args.apply:
        print("\nRien envoye. Ajoute --apply pour publier.")
        return

    env = load_env()
    url = env.get("UPSTASH_REDIS_REST_URL", "")
    token = env.get("UPSTASH_REDIS_REST_TOKEN", "")
    if not url or not token:
        raise SystemExit("UPSTASH_REDIS_REST_URL et _TOKEN requis dans .env")

    for index, (letter, names) in enumerate(sorted(shards.items()), start=1):
        push(url, token, KEY_PREFIX + letter, names)
        print("  {}/{}  '{}' : {} joueur(s)".format(
            index, len(shards), letter, len(names)))

    # L'index dit au bot quels morceaux existent, et depuis quand.
    push(url, token, INDEX_KEY, {
        "shards": sorted(shards),
        "players": players,
        "spots": spots,
    })
    print("\nCarte publiee. Le bot peut maintenant repondre a /find.")


if __name__ == "__main__":
    main()
