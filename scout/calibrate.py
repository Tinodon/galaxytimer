"""Capture d'ecran de Galaxy Life, a la touche.

    python scout/calibrate.py

    c     capture la fenetre Galaxy Life
    esc   quitter

Le raccourci est global : appuie sur `c` pendant que tu es DANS le jeu.

Le script cherche la fenetre par son TITRE, pas au premier plan. C'est la seule
difference avec une capture d'ecran ordinaire, et c'est ce qui evite de
photographier le terminal quand on appuie depuis le terminal.

Les images vont dans scout/captures/. Pour voir ou le detecteur compte cliquer :

    python scout/systems.py --annotate
"""

from __future__ import annotations

import ctypes
from datetime import datetime
from pathlib import Path

import keyboard
import mss
from PIL import Image

OUT_DIR = Path(__file__).resolve().parent / "captures"
OUT_DIR.mkdir(exist_ok=True)

GAME_TITLE = "galaxy life"

user32 = ctypes.windll.user32


def find_game_window():
    """(titre, rectangle) de la fenetre du jeu, ou None si elle n'est pas ouverte."""
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def visit(handle, _):
        if not user32.IsWindowVisible(handle):
            return True
        length = user32.GetWindowTextLengthW(handle)
        if not length:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(handle, buffer, length + 1)
        if GAME_TITLE not in buffer.value.lower():
            return True

        rect = ctypes.create_string_buffer(16)
        user32.GetWindowRect(handle, rect)
        left, top, right, bottom = (
            int.from_bytes(rect.raw[i:i + 4], "little", signed=True)
            for i in (0, 4, 8, 12)
        )
        found.append((buffer.value, (left, top, right - left, bottom - top)))
        return False

    user32.EnumWindows(visit, None)
    return found[0] if found else None


def capture():
    window = find_game_window()
    if not window:
        print("Galaxy Life n'est pas ouvert (aucune fenetre a ce nom).")
        return

    title, (left, top, width, height) = window
    if width < 300 or height < 300:
        print("Fenetre trop petite ({}x{}), capture ignoree.".format(width, height))
        return

    with mss.mss() as sct:
        shot = sct.grab({"left": left, "top": top, "width": width, "height": height})
        image = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

    path = OUT_DIR / "jeu_{}.png".format(datetime.now().strftime("%H-%M-%S"))
    image.save(path)
    print("capture {}x{}  ->  {}".format(width, height, path.name))


def main():
    window = find_game_window()
    print("--- Capture Galaxy Life ---")
    print("Dossier : {}".format(OUT_DIR))
    if window:
        print("Fenetre trouvee : {} ({}x{})".format(window[0], window[1][2], window[1][3]))
    else:
        print("Galaxy Life pas encore ouvert — lance-le, ca marchera quand meme.")
    print("")
    print("  c    capturer")
    print("  esc  quitter")
    print("")

    keyboard.on_press_key("c", lambda _: capture())
    keyboard.wait("esc")
    print("Termine.")


if __name__ == "__main__":
    main()
