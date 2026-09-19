"""Mesure le poids reel des images a stocker, pour dimensionner le balayage.

Separer capture et traitement suppose de garder les images sur disque. Reste a
savoir combien ca pese : plein ecran ou rogne, PNG ou JPEG, l'ecart est d'un
ordre de grandeur.

    python scout/measure_storage.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from popup import find_popup  # noqa: E402
from systems import safe_box  # noqa: E402

CAPTURES = Path(__file__).resolve().parent / "captures"
TMP = Path(__file__).resolve().parent / "_sizing"
TMP.mkdir(exist_ok=True)

# Hypotheses de balayage, pas de 6 sur un univers de 1408x1408.
POSITIONS = (1408 // 6) ** 2
POPUPS_PER_SCREEN = 12


def weigh(image, label, fmt, **options):
    path = TMP / "{}.{}".format(label, "jpg" if fmt == "JPEG" else "png")
    image.convert("RGB").save(path, fmt, **options)
    return path.stat().st_size


def human(total_bytes):
    for unit in ("o", "Ko", "Mo", "Go", "To"):
        if total_bytes < 1024:
            return "{:.1f} {}".format(total_bytes, unit)
        total_bytes /= 1024
    return "{:.1f} Po".format(total_bytes)


def main():
    popup_shot = CAPTURES / "jeu_18-49-43.png"
    map_shot = CAPTURES / "jeu_18-49-20.png"
    if not popup_shot.exists() or not map_shot.exists():
        raise SystemExit("captures de reference absentes dans scout/captures/")

    print("Hypotheses : pas de 6 -> {} positions, {} popups par ecran\n".format(
        POSITIONS, POPUPS_PER_SCREEN))

    # --- Un popup ---
    full = Image.open(popup_shot)
    box = find_popup(full)
    popup = full.crop(box) if box else full
    print("popup rogne : {}x{}".format(popup.width, popup.height))

    variants = [
        ("plein ecran PNG", weigh(full, "p_full", "PNG"), POSITIONS * POPUPS_PER_SCREEN),
        ("rogne PNG", weigh(popup, "p_crop", "PNG"), POSITIONS * POPUPS_PER_SCREEN),
        ("rogne JPEG q90", weigh(popup, "p_j90", "JPEG", quality=90), POSITIONS * POPUPS_PER_SCREEN),
        ("rogne JPEG q75", weigh(popup, "p_j75", "JPEG", quality=75), POSITIONS * POPUPS_PER_SCREEN),
    ]
    print("\nPOPUPS ({} images)".format(POSITIONS * POPUPS_PER_SCREEN))
    for label, size, count in variants:
        print("  {:<20} {:>8} / image   -> {:>10}".format(label, human(size), human(size * count)))

    # --- Une vue carte ---
    map_image = Image.open(map_shot)
    x0, y0, x1, y1 = safe_box(map_image.width, map_image.height)
    cropped = map_image.crop((x0, y0, x1, y1))
    print("\ncarte rognee a la zone utile : {}x{}".format(cropped.width, cropped.height))

    variants = [
        ("plein ecran PNG", weigh(map_image, "m_full", "PNG"), POSITIONS),
        ("rognee PNG", weigh(cropped, "m_crop", "PNG"), POSITIONS),
        ("rognee JPEG q90", weigh(cropped, "m_j90", "JPEG", quality=90), POSITIONS),
        ("rognee JPEG q75", weigh(cropped, "m_j75", "JPEG", quality=75), POSITIONS),
    ]
    print("\nVUES CARTE ({} images)".format(POSITIONS))
    for label, size, count in variants:
        print("  {:<20} {:>8} / image   -> {:>10}".format(label, human(size), human(size * count)))

    for leftover in TMP.iterdir():
        leftover.unlink()
    TMP.rmdir()


if __name__ == "__main__":
    main()
