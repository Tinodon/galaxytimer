"""Test de lecture sur UNE capture, etape par etape, avec une image par etape.

    python scout/debug_lecture.py chemin\\vers\\capture.jpg

Ecrit tout dans scout/data/debug/<nom-de-l-image>_<heure>/ : un nouveau dossier a
chaque lancement, rien n'est efface. Ne deplace ni ne modifie la capture.

Etapes, dans l'ordre des fichiers :
  01_capture.png        l'image telle que le scan l'a enregistree
  02_popup.png          le popup detecte (cadre rouge)
  03_grille.png         les 12 places : vert = occupee, gris = libre
  slot_NN_1_nom.png     la bande du pseudo, decoupee
  slot_NN_2_agrandi.png agrandie x6 (ce que lit l'OCR)
  slot_NN_3_seuils.png  les 4 versions noir et blanc testees, une par seuil
  slot_NN_4_niveau.png  le badge du niveau du joueur, agrandi
  04_resultat.png       le popup annote : pseudo retenu (vert) ou echec (rouge)
  resume.txt            chaque lecture, chaque candidat, et pourquoi
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))

from glyphs import align, compare, load_glyphs, normalise, text_band, upscale_mask  # noqa: E402
from match import Roster  # noqa: E402
from popup import (  # noqa: E402
    GRID, LEVEL_DIGIT, NAME_CHARS, all_reads, find_popup, is_occupied,
    read_hq_level, read_player_level,
)

BASE_DIR = Path(__file__).resolve().parent
DEBUG_DIR = BASE_DIR / "data" / "debug"
THRESHOLDS = (110, 140, 170, 200)
SCALE = 6


def letters_score(mask, glyphs, name):
    """Pose le pseudo lettre par lettre sur l'image : ressemblance moyenne, 0 a 1."""
    expected = [c for c in name.upper() if c.isalnum()]
    if not expected or any(c not in glyphs for c in expected):
        return 0.0
    spans = align(mask, expected, glyphs)
    if not spans:
        return 0.0
    total = 0.0
    for char, span in zip(expected, spans):
        glyph = normalise(mask, span)
        total += max(compare(glyph, sample) for sample in glyphs[char]) if glyph else 0.0
    return total / len(expected)


def font(size):
    try:
        return ImageFont.truetype("arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def slot_box(popup, row, col):
    width, height = popup.size
    left = GRID["first_left"] + col * GRID["col_pitch"]
    top = GRID["name_top"] + row * GRID["row_pitch"]
    box = (int(left * width), int(top * height),
           int((left + GRID["col_width"]) * width),
           int((top + GRID["name_height"]) * height))
    return left, top, box


def threshold_strip(crop):
    """Les 4 versions noir et blanc, empilees : exactement ce que voit Tesseract."""
    grey = crop.convert("L")
    big = grey.resize((grey.width * SCALE, grey.height * SCALE), Image.LANCZOS)
    rows = []
    for threshold in THRESHOLDS:
        binary = ImageOps.invert(big.point(lambda p, t=threshold: 255 if p > t else 0))
        labelled = Image.new("RGB", (binary.width + 90, binary.height), "white")
        labelled.paste(binary.convert("RGB"), (90, 0))
        ImageDraw.Draw(labelled).text((5, binary.height // 2 - 8), "seuil {}".format(threshold),
                                      fill="red", font=font(14))
        rows.append(labelled)
    sheet = Image.new("RGB", (rows[0].width, sum(r.height + 4 for r in rows)), "gray")
    y = 0
    for r in rows:
        sheet.paste(r, (0, y))
        y += r.height + 4
    return sheet


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1])
    image = Image.open(source).convert("RGB")

    out = DEBUG_DIR / "{}_{}".format(source.stem, time.strftime("%H%M%S"))
    out.mkdir(parents=True, exist_ok=True)
    log = []

    def say(text=""):
        print(text)
        log.append(text)

    image.save(out / "01_capture.png")

    # --- Etape 2 : trouver le popup ---
    box = find_popup(image)
    if not box:
        say("ECHEC : aucun popup detecte (bordure cyan introuvable).")
        (out / "resume.txt").write_text("\n".join(log), encoding="utf-8")
        return
    marked = image.copy()
    ImageDraw.Draw(marked).rectangle(box, outline="red", width=3)
    marked.save(out / "02_popup.png")
    popup = image.crop(box)
    say("Popup detecte : {}".format(box))

    # --- Etape 3 : les 12 places ---
    grid = popup.copy()
    draw = ImageDraw.Draw(grid)
    occupied = []
    for row in range(GRID["rows"]):
        for col in range(GRID["columns"]):
            slot = row * GRID["columns"] + col + 1
            left, top, b = slot_box(popup, row, col)
            busy = is_occupied(popup, left, top)
            draw.rectangle(b, outline="lime" if busy else "gray", width=2)
            draw.text((b[0] + 2, b[1] - 14), str(slot), fill="yellow", font=font(12))
            if busy:
                occupied.append((slot, row, col, left, top, b))
    grid.save(out / "03_grille.png")
    say("Places occupees : {} sur 12 -> {}".format(len(occupied), [s for s, *_ in occupied]))

    # --- Etapes par place ---
    say("\nChargement du dictionnaire des joueurs...")
    roster = Roster()
    glyphs = load_glyphs()
    result = popup.copy()
    rdraw = ImageDraw.Draw(result)

    for slot, row, col, left, top, b in occupied:
        tag = "slot_{:02d}".format(slot)
        crop = popup.crop(b)
        crop.save(out / "{}_1_nom.png".format(tag))
        crop.resize((crop.width * SCALE, crop.height * SCALE), Image.LANCZOS).save(
            out / "{}_2_agrandi.png".format(tag))
        threshold_strip(crop).save(out / "{}_3_seuils.png".format(tag))

        width, height = popup.size
        badge = popup.crop((
            int((left + LEVEL_DIGIT["left"]) * width), int((top + LEVEL_DIGIT["top"]) * height),
            int((left + LEVEL_DIGIT["left"] + LEVEL_DIGIT["width"]) * width),
            int((top + LEVEL_DIGIT["top"] + LEVEL_DIGIT["height"]) * height)))
        badge.resize((badge.width * 8, badge.height * 8), Image.NEAREST).save(
            out / "{}_4_niveau.png".format(tag))

        reads = all_reads(crop, SCALE, THRESHOLDS, whitelist=NAME_CHARS)
        level = read_player_level(popup, left, top)
        hq = read_hq_level(popup, left, top)

        say("\n[place {}] lectures OCR : {}".format(slot, reads or "aucune"))
        say("           niveau lu : {}   QG lu : {}".format(level, hq))

        for read in reads:
            m = roster.match(read, level=level)
            detail = m.get("reason", "")
            if m.get("closest"):
                detail += " (le plus proche : {})".format(m["closest"])
            if m.get("between"):
                detail += " (entre {})".format(" / ".join(m["between"]))
            say("           '{}' -> {} score {} {}".format(read, m["name"], m["score"], detail))

        # La decision porte sur TOUTES les lectures de la vignette ensemble.
        mask = text_band(upscale_mask(crop))
        decision = roster.match_slot(
            reads, level=level, verify=lambda name: letters_score(mask, glyphs, name))
        if decision.get("consensus"):
            say("           accord avec l'ensemble des lectures : {}".format(decision["consensus"]))
        if decision.get("letters"):
            say("           lettres de l'image (gabarits) : {}".format(decision["letters"]))
        best = decision if decision["name"] else None
        if not best:
            say("           raison : {}".format(decision.get("reason")))
        if best:
            say("           RETENU : {} (score {})".format(best["name"], best["score"]))
            rdraw.rectangle(b, outline="lime", width=3)
            rdraw.text((b[0], b[3] + 2), best["name"], fill="lime", font=font(13))
        else:
            say("           ECHEC : a regarder a la main")
            rdraw.ellipse((b[0] - 6, b[1] - 6, b[2] + 6, b[3] + 6), outline="red", width=3)

    result.save(out / "04_resultat.png")
    (out / "resume.txt").write_text("\n".join(log), encoding="utf-8")
    print("\nTout est dans : {}".format(out))


if __name__ == "__main__":
    main()
