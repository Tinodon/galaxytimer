"""Reconstruit les gabarits de lettres a partir des pseudos lus EXACTEMENT.

Les gabarits d'origine (glyphs.json) venaient d'une poignee de captures
verifiees a la main : quelques exemples par lettre, trop peu pour departager
deux pseudos a une lettre pres (stefan123 / stefano22), et presque rien de
fiable sur les noms courts (BAS, Cix).

Or chaque vignette dont la lecture OCR tombe lettre pour lettre sur un vrai
pseudo est un exemple PARFAIT : on connait le texte exact affiche. Le releve en
contient des milliers. Aucune saisie a la main, aucune relecture OCR : les
lectures sont deja dans data/systems_resolus.jsonl.

    python scout/harvest_glyphs.py              recolte et ecrit glyphs_auto.json
    python scout/harvest_glyphs.py --limit 500  sur un echantillon

N'ecrase PAS glyphs.json : les nouveaux gabarits vont dans glyphs_auto.json,
et on ne bascule qu'apres mesure.

Garde-fous, parce qu'un gabarit faux contamine toutes les lectures suivantes :
  - seulement les lectures exactes, sur toutes les lettres ;
  - le nombre de vignettes detectees doit correspondre au releve, sinon
    l'image entiere est ignoree (on ne sait plus quelle vignette est laquelle) ;
  - chaque lettre decoupee doit ressembler au gabarit d'origine de CETTE
    lettre (sinon le decoupage a derape) ;
  - chaque lettre garde un nombre limite d'exemples, choisis pour etre
    differents les uns des autres : plus d'exemples ralentiraient la lecture
    sans la rendre plus sure.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

BASE_DIR = Path(__file__).resolve().parent
RESOLVED = BASE_DIR / "data" / "systems_resolus.jsonl"
POPUPS = BASE_DIR / "data" / "popups"
OUTPUT = BASE_DIR / "glyphs_auto.json"

# Une lettre decoupee doit ressembler au moins a ce point a l'ancien gabarit de
# la meme lettre, et le pseudo entier en moyenne a ce point.
MIN_CHAR = 0.72
MIN_NAME = 0.84
# Exemples gardes par lettre.
KEEP_PER_CHAR = 14


def literal(text):
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


def jobs(limit):
    """(image, [(rang de la vignette, pseudo)]) pour les lectures exactes."""
    by_image = defaultdict(list)
    counts = {}
    with RESOLVED.open(encoding="utf-8") as handle:
        for line in handle:
            entry = json.loads(line)
            source = entry.get("source")
            if not source:
                continue
            counts[source] = len(entry.get("players", []))
            for rank, player in enumerate(entry.get("players", [])):
                name = player.get("name")
                raw = player.get("raw", "")
                if name and len(literal(name)) >= 3 and literal(raw) == literal(name):
                    by_image[source].append((rank, name))
    items = [(source, tiles, counts[source]) for source, tiles in by_image.items()]
    return items[:limit] if limit else items


def harvest_image(args):
    """Lettres decoupees d'une image : {caractere: [(bits, largeur)]}."""
    source, tiles, expected_count = args
    from PIL import Image

    from glyphs import align, compare, load_glyphs, normalise, text_band, upscale_mask
    from popup import GRID, find_popup, is_occupied

    glyphs = load_glyphs()
    path = POPUPS / source
    if not path.exists():
        return {}, "absente"
    image = Image.open(path).convert("RGB")
    box = find_popup(image)
    if not box:
        return {}, "popup"
    popup = image.crop(box)
    width, height = popup.size

    boxes = []
    for row in range(GRID["rows"]):
        for col in range(GRID["columns"]):
            left = GRID["first_left"] + col * GRID["col_pitch"]
            top = GRID["name_top"] + row * GRID["row_pitch"]
            if is_occupied(popup, left, top):
                boxes.append((int(left * width), int(top * height),
                              int((left + GRID["col_width"]) * width),
                              int((top + GRID["name_height"]) * height)))
    if len(boxes) != expected_count:
        return {}, "vignettes"

    found = defaultdict(list)
    for rank, name in tiles:
        mask = text_band(upscale_mask(popup.crop(boxes[rank])))
        expected = [c for c in name.upper() if c.isalnum()]
        if any(c not in glyphs for c in expected):
            continue
        spans = align(mask, expected, glyphs)
        if not spans:
            continue
        pieces, scores = [], []
        for char, span in zip(expected, spans):
            glyph = normalise(mask, span)
            if glyph is None:
                break
            score = max(compare(glyph, sample) for sample in glyphs[char])
            pieces.append((char, glyph))
            scores.append(score)
        if len(pieces) != len(expected):
            continue
        if min(scores) < MIN_CHAR or sum(scores) / len(scores) < MIN_NAME:
            continue
        for char, (grid, real_width) in pieces:
            found[char].append((grid.astype(np.uint8).tobytes(), real_width))
    return dict(found), "ok"


def diverse(samples, keep):
    """Garde `keep` exemples les plus differents les uns des autres.

    Le premier est le plus "central" (le plus proche de la moyenne) ; chaque
    suivant est celui qui ressemble le moins a ceux deja retenus. Des exemples
    tous identiques n'apporteraient rien : ce sont les variantes (tuile grisee,
    lettre collee a sa voisine) qui rendent la reconnaissance robuste.
    """
    from glyphs import GLYPH_HEIGHT, GLYPH_WIDTH, compare

    grids = [(np.frombuffer(b, dtype=np.uint8).reshape(GLYPH_HEIGHT, GLYPH_WIDTH).astype(bool), w)
             for b, w in samples]
    mean = np.mean([g for g, _ in grids], axis=0) > 0.5
    mean_width = int(round(np.median([w for _, w in grids])))
    centre = max(range(len(grids)), key=lambda i: compare(grids[i], (mean, mean_width)))
    chosen = [centre]
    closest = [compare(g, grids[centre]) for g in grids]
    while len(chosen) < min(keep, len(grids)):
        nxt = min(range(len(grids)), key=lambda i: closest[i] if i not in chosen else 2)
        chosen.append(nxt)
        closest = [max(c, compare(g, grids[nxt])) for c, g in zip(closest, grids)]
    return [grids[i] for i in chosen]


def main():
    from glyphs import signature

    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = parser.parse_args()

    work = jobs(args.limit)
    print("{} image(s) avec des lectures exactes".format(len(work)))
    started = time.time()
    pool_samples = defaultdict(list)
    status = defaultdict(int)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(harvest_image, job) for job in work]
        for done, future in enumerate(as_completed(futures), start=1):
            found, state = future.result()
            status[state] += 1
            for char, samples in found.items():
                pool_samples[char].extend(samples)
            if done % 200 == 0:
                print("  ... {}/{}  ({:.0f}s)".format(done, len(work), time.time() - started))

    print("\nImages : {}".format(dict(status)))
    print("Exemples recoltes par lettre :")
    print("  " + "  ".join("{}:{}".format(c, len(pool_samples[c])) for c in sorted(pool_samples)))

    payload = {}
    for char in sorted(pool_samples):
        kept = diverse(pool_samples[char], KEEP_PER_CHAR)
        payload[char] = [{"width": int(w), "bits": signature(g)} for g, w in kept]
    missing = [c for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" if c not in payload]
    OUTPUT.write_text(json.dumps(payload), encoding="utf-8")
    print("\nEcrit : {} ({} caracteres{})".format(
        OUTPUT, len(payload), ", manquants : " + "".join(missing) if missing else ""))


if __name__ == "__main__":
    main()
