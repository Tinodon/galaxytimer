"""Calibrage : verifie que l'OCR lit reellement l'ecran de Galaxy Life.

Ne clique nulle part, n'ecrit rien en base.

    python scout/calibrate.py

AUCUN RACCOURCI CLAVIER. Le script surveille la fenetre au premier plan : des
que Galaxy Life y est et que l'affichage s'est stabilise, il capture tout seul.
Il ne capture QUE la fenetre du jeu, jamais l'ecran entier.

Marche a suivre :
    1. lance le script
    2. bascule sur Galaxy Life
    3. mets-toi sur la vue carte, attends 2 secondes -> capture
    4. reviens lire la console
    5. retourne dans le jeu, ouvre un popup de systeme -> nouvelle capture

Une capture par passage : il faut quitter puis revenir sur le jeu pour en
declencher une autre. Ca evite d'en produire cent pendant que tu joues.
"""

from __future__ import annotations

import ctypes
import re
import time
from datetime import datetime
from pathlib import Path

import mss
import pytesseract
from PIL import Image, ImageOps

BASE_DIR = Path(__file__).resolve().parent
OUT_DIR = BASE_DIR / "captures"
OUT_DIR.mkdir(exist_ok=True)

GAME_TITLE = "galaxy life"
SETTLE_SECONDS = 2.0
POLL_SECONDS = 0.4

XY_READOUT = re.compile(r"X\s*[:.]?\s*(\d{1,4})\s+Y\s*[:.]?\s*(\d{1,4})", re.I)
POPUP_TITLE = re.compile(r"([A-Z][A-Z0-9 ]{2,20})\s*\(\s*(\d{1,4})\s*[,.]\s*(\d{1,4})\s*\)")
OCCUPANCY = re.compile(r"^(\d{1,2})\s*/\s*12$")

user32 = ctypes.windll.user32


def foreground():
    """(titre, rectangle) de la fenetre au premier plan."""
    handle = user32.GetForegroundWindow()
    length = user32.GetWindowTextLengthW(handle)
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(handle, buffer, length + 1)

    rect = ctypes.create_string_buffer(16)
    user32.GetWindowRect(handle, rect)
    left, top, right, bottom = (
        int.from_bytes(rect.raw[i:i + 4], "little", signed=True) for i in (0, 4, 8, 12)
    )
    return buffer.value or "", (left, top, right - left, bottom - top)


def grab(rect):
    """Capture la fenetre du jeu seule, pas tout l'ecran."""
    left, top, width, height = rect
    with mss.mss() as sct:
        shot = sct.grab({"left": left, "top": top, "width": width, "height": height})
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def prepare(image, scale=3, threshold=150):
    """Texte clair sur fond sombre : agrandir, seuiller, inverser."""
    grey = image.convert("L")
    grey = grey.resize((grey.width * scale, grey.height * scale), Image.LANCZOS)
    return ImageOps.invert(grey.point(lambda p: 255 if p > threshold else 0))


def words_of(image, psm, scale=3):
    data = pytesseract.image_to_data(
        prepare(image, scale=scale),
        config="--psm {}".format(psm),
        output_type=pytesseract.Output.DICT,
    )
    words = []
    for i, text in enumerate(data["text"]):
        text = text.strip()
        if not text:
            continue
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        if conf < 25:
            continue
        words.append({
            "text": text, "conf": conf,
            "x": data["left"][i] // scale, "y": data["top"][i] // scale,
        })
    return words


def lines_of(words, tolerance=14):
    rows = []
    for word in sorted(words, key=lambda w: (w["y"], w["x"])):
        for row in rows:
            if abs(row["y"] - word["y"]) <= tolerance:
                row["words"].append(word)
                break
        else:
            rows.append({"y": word["y"], "words": [word]})
    return [
        {
            "y": r["y"],
            "x": min(w["x"] for w in r["words"]),
            "text": " ".join(w["text"] for w in sorted(r["words"], key=lambda w: w["x"])),
        }
        for r in rows
    ]


def analyse(image):
    stamp = datetime.now().strftime("%H-%M-%S")
    image.save(OUT_DIR / "jeu_{}.png".format(stamp))

    # Deux passes : texte epars pour la carte, bloc homogene pour un popup.
    sparse = lines_of(words_of(image, psm=11))
    block = lines_of(words_of(image, psm=6))
    raw = "\n".join(l["text"] for l in sparse)
    (OUT_DIR / "jeu_{}.txt".format(stamp)).write_text(raw, encoding="utf-8")

    print("\n" + "=" * 70)
    print("CAPTURE {}  ({}x{})".format(stamp, image.width, image.height))
    print("=" * 70)

    combined = raw + "\n" + "\n".join(l["text"] for l in block)

    xy = XY_READOUT.search(combined)
    print("Champ X/Y        : {}".format(
        "X={} Y={}".format(xy.group(1), xy.group(2)) if xy else "NON LU"))

    popup = POPUP_TITLE.search(combined)
    print("Titre de popup   : {}".format(
        "{} ({}, {})".format(popup.group(1).strip(), popup.group(2), popup.group(3))
        if popup else "aucun"))

    counters = [l for l in sparse if OCCUPANCY.match(l["text"].replace(" ", ""))]
    print("Compteurs N/12   : {}".format(len(counters)))

    systems = []
    for i, line in enumerate(sparse):
        match = OCCUPANCY.match(line["text"].replace(" ", ""))
        if not match:
            continue
        for candidate in sparse[:i][::-1]:
            if abs(candidate["x"] - line["x"]) < 110 and 0 < line["y"] - candidate["y"] < 50:
                systems.append((candidate["text"], int(match.group(1)), candidate["x"], candidate["y"]))
                break

    print("Systemes nommes  : {}".format(len(systems)))
    for name, occupied, x, y in systems:
        print("   {:<24} {:>2}/12   ecran({},{}){}".format(
            name, occupied, x, y, "   <- vide" if occupied == 0 else ""))

    print("\n--- texte lu, mode epars ({} lignes) ---".format(len(sparse)))
    for line in sparse[:35]:
        print("   | {}".format(line["text"]))

    print("\nImage : captures/jeu_{}.png".format(stamp))
    print("=" * 70)
    print("Reviens dans le jeu pour declencher la capture suivante.\n")


def main():
    print("--- Calibrage OCR GalaxyTimer ---")
    print("Captures : {}\n".format(OUT_DIR))
    print("Bascule sur Galaxy Life : la capture se declenche toute seule")
    print("apres {} secondes d'affichage stable.".format(SETTLE_SECONDS))
    print("Reviens ici pour lire, puis retourne dans le jeu pour la suivante.")
    print("Ctrl+C pour quitter.\n")

    armed = True   # Une seule capture par passage sur le jeu.
    since = None

    while True:
        title, rect = foreground()
        in_game = GAME_TITLE in title.lower()

        if not in_game:
            armed = True
            since = None
            time.sleep(POLL_SECONDS)
            continue

        if since is None:
            since = time.time()
            print("Galaxy Life detecte ({}x{}) — capture dans {}s...".format(
                rect[2], rect[3], SETTLE_SECONDS))

        if armed and time.time() - since >= SETTLE_SECONDS:
            armed = False
            if rect[2] < 200 or rect[3] < 200:
                print("Fenetre trop petite ({}x{}), capture ignoree.".format(rect[2], rect[3]))
            else:
                analyse(grab(rect))

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nTermine.")
