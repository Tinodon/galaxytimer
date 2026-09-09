"""Positions des elements d'interface de Galaxy Life, et actions dessus.

Toutes les coordonnees sont en PIXELS depuis le coin haut-gauche de la fenetre
du jeu. L'interface est ancree en haut a gauche et garde la meme taille quelle
que soit la fenetre : mesure sur deux tailles differentes (1550x830 et
1938x1038), la barre de coordonnees tombe au meme endroit a cinq pixels pres.

    python scout/gameui.py --check   ecrit une image montrant ou on cliquerait

Le mode --check existe pour la meme raison que l'annotation des systemes : on
ne lance pas un automate sur des positions supposees. On les regarde d'abord.
"""

from __future__ import annotations

import ctypes
import sys
import time
from pathlib import Path

import mss
from PIL import Image, ImageDraw

GAME_TITLE = "galaxy life"

# Mesures relevees sur capture reelle (scout/captures/_barre.png).
COORD_FIELD_X = (585, 150)
COORD_FIELD_Y = (658, 150)
COORD_GO_BUTTON = (708, 150)

# Ou garer la souris avant une capture. Le curseur est une forme blanche
# compacte que le detecteur prend pour un systeme ; plutot que d'essayer de
# l'ecarter par filtrage, on le sort simplement de la carte.
MOUSE_PARK = (30, 250)

# Pause ajoutee apres CHAQUE action. Le jeu est lourd : enchainer les clics
# trop vite lui fait sauter des etapes, et on se retrouve avec un popup vide ou
# une navigation qui n'a pas eu lieu.
ACTION_PAUSE = 0.3

# Croix de fermeture d'un popup, en pixels depuis le coin de la fenetre.
# Mesuree sur capture reelle : le popup s'affiche toujours au meme endroit.
POPUP_CLOSE = (1295, 350)

# La meme croix, exprimee en fraction du cadre detecte. On s'en sert en
# priorite quand le cadre est trouve — ca reste juste meme si le jeu decale ou
# redimensionne le popup — et on retombe sur la valeur fixe sinon.
CLOSE_BUTTON = {"x": 0.974, "y": 0.038}

user32 = ctypes.windll.user32


def find_game_window():
    """(titre, (x, y, largeur, hauteur)) de la fenetre du jeu, ou None."""
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


def foreground_title():
    """Titre de la fenetre au premier plan."""
    handle = user32.GetForegroundWindow()
    length = user32.GetWindowTextLengthW(handle)
    if not length:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(handle, buffer, length + 1)
    return buffer.value or ""


def is_game_focused():
    """Galaxy Life est-il la fenetre active ?

    Verifier que la fenetre EXISTE ne suffit pas : si une autre application
    prend le focus pendant la nuit, les clics partiraient dedans. On veut savoir
    que le jeu est bien devant avant de toucher a la souris.
    """
    return GAME_TITLE in foreground_title().lower()


def grab(rect):
    left, top, width, height = rect
    with mss.mss() as sct:
        shot = sct.grab({"left": left, "top": top, "width": width, "height": height})
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


class GameWindow:
    """Pilote la fenetre du jeu : ecrire des coordonnees, cliquer, capturer."""

    def __init__(self):
        window = find_game_window()
        if not window:
            raise RuntimeError("Galaxy Life n'est pas ouvert.")
        self.title, self.rect = window

    def refresh(self):
        window = find_game_window()
        if window:
            self.title, self.rect = window
        return self.rect

    def to_screen(self, x, y):
        """Coordonnee fenetre -> coordonnee ecran."""
        return self.rect[0] + x, self.rect[1] + y

    def focus(self):
        window = find_game_window()
        if not window:
            return False
        # On ne peut pas recuperer le handle depuis rect : on relit la fenetre
        # au premier plan apres un clic dans une zone inoffensive.
        import pyautogui

        pyautogui.click(*self.to_screen(*MOUSE_PARK))
        time.sleep(0.2)
        return True

    def click(self, x, y, settle=0.25):
        import pyautogui

        pyautogui.click(*self.to_screen(x, y))
        time.sleep(settle + ACTION_PAUSE)

    def park_mouse(self):
        import pyautogui

        pyautogui.moveTo(*self.to_screen(*MOUSE_PARK))

    def type_coordinate(self, field, value):
        """Remplace le contenu d'un champ par une valeur."""
        import pyautogui

        pyautogui.click(*self.to_screen(*field))
        time.sleep(ACTION_PAUSE)
        pyautogui.hotkey("ctrl", "a")
        pyautogui.press("delete")
        time.sleep(ACTION_PAUSE)
        pyautogui.typewrite(str(value), interval=0.05)
        time.sleep(ACTION_PAUSE)

    def go_to(self, x, y, settle=1.0):
        """Ecrit les coordonnees et valide. Ne verifie pas le resultat."""
        self.type_coordinate(COORD_FIELD_X, x)
        self.type_coordinate(COORD_FIELD_Y, y)
        self.click(*COORD_GO_BUTTON, settle=0)
        time.sleep(settle)

    def capture(self):
        self.refresh()
        return grab(self.rect)

    def close_popup(self, popup_box=None, settle=0.4):
        """Ferme un popup.

        Avec le cadre, la croix est calculee dessus — ca reste juste meme si le
        jeu decale le popup. Sans cadre, on retombe sur la position fixe.
        """
        if popup_box:
            x0, y0, x1, y1 = popup_box
            x = x0 + int((x1 - x0) * CLOSE_BUTTON["x"])
            y = y0 + int((y1 - y0) * CLOSE_BUTTON["y"])
        else:
            x, y = POPUP_CLOSE
        self.click(x, y, settle=settle)
        return x, y


def check():
    """Ecrit une image marquant chaque position sur laquelle on cliquerait."""
    window = find_game_window()
    if not window:
        raise SystemExit("Galaxy Life n'est pas ouvert.")

    title, rect = window
    image = grab(rect).convert("RGB")
    draw = ImageDraw.Draw(image)

    points = [
        ("champ X", COORD_FIELD_X, (255, 60, 60)),
        ("champ Y", COORD_FIELD_Y, (60, 160, 255)),
        ("bouton GO", COORD_GO_BUTTON, (60, 255, 90)),
        ("garage souris", MOUSE_PARK, (255, 220, 60)),
        ("croix de fermeture", POPUP_CLOSE, (255, 0, 255)),
    ]

    # Si un popup est ouvert, on montre AUSSI la position calculee depuis son
    # cadre : c'est celle que le crawler utilise en priorite. Les deux doivent
    # tomber au meme endroit.
    from popup import find_popup

    box = find_popup(image)
    computed = None
    if box:
        x0, y0, x1, y1 = box
        computed = (
            x0 + int((x1 - x0) * CLOSE_BUTTON["x"]),
            y0 + int((y1 - y0) * CLOSE_BUTTON["y"]),
        )
        draw.rectangle([x0, y0, x1, y1], outline=(0, 255, 255), width=2)
        draw.text((x0 + 6, y0 + 6), "cadre du popup detecte", fill=(0, 255, 255))
        points.append(("croix calculee", computed, (0, 255, 255)))

    for label, (x, y), colour in points:
        draw.ellipse([x - 14, y - 14, x + 14, y + 14], outline=colour, width=3)
        draw.line([x - 20, y, x + 20, y], fill=colour, width=1)
        draw.line([x, y - 20, x, y + 20], fill=colour, width=1)
        draw.text((x + 20, y + 16), label, fill=colour)

    out = Path(__file__).resolve().parent / "captures" / "_interface.png"
    out.parent.mkdir(exist_ok=True)
    image.save(out)
    print("Fenetre : {} ({}x{})".format(title, rect[2], rect[3]))
    print("Image de verification : {}".format(out))

    print("\ncroix de fermeture, valeur fixe : {}".format(POPUP_CLOSE))
    if computed:
        ecart = (abs(computed[0] - POPUP_CLOSE[0]), abs(computed[1] - POPUP_CLOSE[1]))
        print("croix calculee depuis le cadre  : {}  (ecart {} px)".format(computed, ecart))
    else:
        print("aucun popup ouvert : seule la valeur fixe est affichee")

    print("\nChaque cercle doit tomber sur l'element nomme. Si un seul est a")
    print("cote, ne lance pas le crawler : il taperait dans le vide.")


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
    else:
        window = find_game_window()
        print(window if window else "Galaxy Life n'est pas ouvert.")
