"""Ecriture des coordonnees relevees dans la base partagee avec le bot Discord.

Le bot tourne sur Render et lit ses donnees dans Upstash. Ce script tourne sur
le PC de Noe. Les deux se rejoignent sur la meme cle Redis, donc le schema
ecrit ici doit rester identique a celui que lit src/pins.js :

    { "<guildId>": { "<playerId>": {"name": str, "coords": [
        {"x": int, "y": int, "by": str, "at": <ms epoch>} ]}}}

Les identifiants viennent du .env du projet, jamais du code.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests

PINS_KEY = "galaxytimer:pins"
MAX_COORD = 1408  # L'univers connu va de (0,0) a (1408,1408).
TIMEOUT = 15


def load_env() -> dict:
    """Lit le .env du projet sans dependance supplementaire."""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    values = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    # Une variable d'environnement reelle l'emporte sur le fichier.
    for key, value in os.environ.items():
        if key.startswith(("UPSTASH_", "GALAXYTIMER_", "DATABASE_")):
            values[key] = value
    return values


class PinStore:
    """Acces a la base de coordonnees, cote script."""

    def __init__(self, guild_id, scout_name):
        env = load_env()
        self.url = env.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
        self.token = env.get("UPSTASH_REDIS_REST_TOKEN", "")
        if not self.url or not self.token:
            raise RuntimeError(
                "UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN manquants dans .env"
            )
        self.guild_id = str(guild_id)
        self.scout_name = scout_name
        self._data = {}

    @property
    def _headers(self):
        return {"Authorization": "Bearer " + self.token}

    def load(self):
        response = requests.get(
            self.url + "/get/" + PINS_KEY, headers=self._headers, timeout=TIMEOUT
        )
        response.raise_for_status()
        raw = response.json().get("result")
        self._data = json.loads(raw) if raw else {}
        return self._data

    def save(self):
        # La valeur passe dans le corps de la requete : un blob JSON depasserait
        # la longueur d'URL admissible.
        response = requests.post(
            self.url + "/set/" + PINS_KEY,
            headers={**self._headers, "Content-Type": "text/plain"},
            data=json.dumps(self._data, ensure_ascii=False).encode("utf-8"),
            timeout=TIMEOUT,
        )
        response.raise_for_status()

    def add(self, player_id, player_name, coords):
        """Ajoute des coordonnees. Une coordonnee deja connue est mise a jour."""
        guild = self._data.setdefault(self.guild_id, {})
        entry = guild.setdefault(str(player_id), {"name": player_name, "coords": []})
        entry["name"] = player_name

        added = updated = 0
        now = int(time.time() * 1000)
        for x, y in coords:
            if not (0 <= x <= MAX_COORD and 0 <= y <= MAX_COORD):
                continue
            existing = None
            for candidate in entry["coords"]:
                if candidate["x"] == x and candidate["y"] == y:
                    existing = candidate
                    break
            if existing:
                existing["by"] = self.scout_name
                existing["at"] = now
                updated += 1
            else:
                entry["coords"].append(
                    {"x": x, "y": y, "by": self.scout_name, "at": now}
                )
                added += 1

        entry["coords"].sort(key=lambda c: (c["x"], c["y"]))
        return {"added": added, "updated": updated, "total": len(entry["coords"])}

    def summary(self):
        guild = self._data.get(self.guild_id, {})
        total = sum(len(e["coords"]) for e in guild.values())
        return "{} coordonnee(s) connues sur {} joueur(s)".format(total, len(guild))
