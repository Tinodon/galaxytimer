"""Enregistrement local des systemes releves.

Un fichier JSONL, une ligne par systeme, ecrit au fil du balayage :

    {"x": 702, "y": 861, "name": "CHARA", "players": [...], "at": ..., "screen": [...]}

Pourquoi JSONL en local plutot que la base distante directement :

  - le balayage produit des dizaines de milliers d'entrees ; les pousser une par
    une sur le reseau ralentirait la boucle et la rendrait dependante d'internet ;
  - un fichier en ajout pur ne peut pas etre corrompu par une coupure : la
    derniere ligne est tronquee, les precedentes restent lisibles ;
  - on peut relire et retraiter sans rejouer le balayage.

`scout/sync.py` pousse ensuite vers Upstash ce dont le bot Discord a besoin.

L'IDENTITE d'un systeme, ce sont ses coordonnees, pas son nom : le nom peut
etre mal lu, les coordonnees sont fiables. C'est sur elles qu'on dedoublonne,
et c'est ce qui permet au crawler de savoir qu'il a deja vu un systeme.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
SYSTEMS_FILE = DATA_DIR / "systems.jsonl"


class SystemStore:
    """Systemes releves, en memoire et sur disque."""

    def __init__(self, path=None):
        self.path = Path(path) if path else SYSTEMS_FILE
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.systems = {}
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        broken = 0
        with self.path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    self.systems[(entry["x"], entry["y"])] = entry
                except (json.JSONDecodeError, KeyError):
                    # Une coupure en pleine ecriture ne tronque que la derniere
                    # ligne : on l'ignore au lieu de refuser tout le fichier.
                    broken += 1
        if broken:
            print("[store] {} ligne(s) illisible(s) ignoree(s)".format(broken))

    def has(self, x, y):
        return (x, y) in self.systems

    def get(self, x, y):
        return self.systems.get((x, y))

    def record(self, x, y, name, players, screen=None, source=None, reads=None):
        """Ajoute ou met a jour un systeme. Renvoie True si c'est une nouveaute."""
        key = (x, y)
        is_new = key not in self.systems

        entry = {
            "x": x,
            "y": y,
            "name": name,
            # Lectures brutes de l'OCR. Le rapprochement avec de vrais comptes
            # se fait plus tard, hors ligne : interroger l'API pendant le
            # balayage couterait des centaines de milliers de requetes.
            "players": players,
            "at": int(time.time()),
        }
        if screen:
            entry["screen"] = list(screen)
        # Le nom de l'image d'ou vient la lecture. Sans lui, verifier un pseudo
        # douteux oblige a relire des dizaines de captures pour retrouver la
        # bonne — ce qui est arrive deux fois.
        if source:
            entry["source"] = source
        # Les lectures alternatives de chaque emplacement, dans le meme ordre
        # que `players`. Elles ne servent qu'au rapprochement hors ligne.
        if reads:
            entry["reads"] = reads

        # Une relecture qui trouve MOINS de joueurs est probablement moins bonne
        # (popup mal capture, animation en cours) : on garde la plus riche.
        previous = self.systems.get(key)
        if previous and len(previous.get("players", [])) > len(players):
            entry["players"] = previous["players"]
            entry["name"] = entry["name"] or previous.get("name")
            entry["source"] = previous.get("source", entry.get("source"))
            entry["reads"] = previous.get("reads", entry.get("reads"))

        self.systems[key] = entry
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return is_new

    def stats(self):
        occupied = sum(1 for e in self.systems.values() if e.get("players"))
        players = sum(len(e.get("players", [])) for e in self.systems.values())
        return {
            "systems": len(self.systems),
            "occupied": occupied,
            "player_slots": players,
        }

    def summary(self):
        s = self.stats()
        return "{} systeme(s), {} habite(s), {} colonie(s) relevee(s)".format(
            s["systems"], s["occupied"], s["player_slots"])
