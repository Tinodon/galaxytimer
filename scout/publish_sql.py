"""Publie la carte globale dans la base SQL (Postgres, hebergee chez Neon).

Une ligne par joueur existant (~482 000), avec son alliance, son niveau et 24
cases : ses 12 colonies et le niveau de QG de chacune. Le bot lit cette base
pour /find, /map et /who, et /pin y ecrit.

    python scout/publish_sql.py                  montre ce qui serait publie
    python scout/publish_sql.py --apply          publie pour de bon
    python scout/publish_sql.py --import-pins    reprend les pins d'Upstash (une fois)

Sources, toutes sur ce PC :
  - data/roster_joueurs.json    id, alliance, niveau, planetes de chaque joueur
                                (python scout/roster.py --reset) ;
  - data/systems_resolus.jsonl  les colonies relevees et rattachees a un joueur
                                (python scout/resolve.py --write).

Une ligne par PLANETE : un joueur qui a 6 planetes dans un systeme y a 6 lignes,
numerotees 1 a 6.

La publication ne touche JAMAIS aux pins ni aux corrections faites avec /edit :
elle remplace seulement les planetes relevees et non corrigees. Une planete
relevee qui tombe sur la place d'un pin (meme joueur, meme systeme, meme numero)
est ignoree : celui qui a pinne vient de regarder.

Tout se fait dans une seule transaction : un lecteur voit l'ancienne carte ou la
nouvelle, jamais une moitie. Les fichiers source ne sont pas modifies ; la base
se reconstruit a l'identique a partir d'eux.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import load_env  # noqa: E402
from upload import resolved_colonies  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
SCHEMA_FILE = BASE_DIR / "schema.sql"
PLAYERS_FILE = BASE_DIR / "data" / "roster_joueurs.json"

PINS_KEY = "galaxytimer:pins"


def load_players():
    """{id: (pseudo, alliance, niveau, nb_planetes)} et {pseudo: id}."""
    if not PLAYERS_FILE.exists():
        raise SystemExit(
            "Fichier absent : {}\n"
            "Lance d'abord : python scout/roster.py --reset".format(PLAYERS_FILE))

    by_id, id_of = {}, {}
    for name, (player_id, alliance, level, planets) in json.loads(
            PLAYERS_FILE.read_text(encoding="utf-8")).items():
        try:
            player_id = int(player_id)
        except (TypeError, ValueError):
            continue
        # Un joueur renomme peut apparaitre sous deux pseudos pendant un
        # balayage : l'id tranche, un seul enregistrement par joueur.
        by_id[player_id] = (name, alliance, level, planets)
        id_of[name] = player_id
    return by_id, id_of


def plan():
    """Ce qui serait publie, et les incoherences a signaler."""
    by_id, id_of = load_players()
    colonies, kept, skipped = resolved_colonies()

    rows, orphans = [], 0
    for colony in colonies:
        player_id = id_of.get(colony["name"])
        if player_id is None:
            orphans += 1
            continue
        rows.append((player_id, colony))

    per_player = Counter(player_id for player_id, _ in rows)
    # Plus de colonies connues que de planetes : au moins une attribution fausse.
    too_many = [
        (by_id[pid][0], count, by_id[pid][3])
        for pid, count in per_player.items()
        if by_id[pid][3] and count > by_id[pid][3]
    ]
    return by_id, rows, per_player, orphans, too_many


def connect(env, schema):
    import psycopg  # noqa: PLC0415 — seulement quand on publie vraiment

    url = env.get("DATABASE_URL", "")
    if not url:
        raise SystemExit("DATABASE_URL requis dans .env (chaine de connexion Neon)")
    conn = psycopg.connect(url)
    if schema != "public":
        # Schema a part : les controles s'y isolent sans toucher a la vraie carte.
        conn.execute('CREATE SCHEMA IF NOT EXISTS "{}"'.format(schema))
    # Toujours explicite, meme pour `public` : on ecrit la ou on l'a decide,
    # jamais la ou une session precedente aurait laisse le search_path.
    conn.execute('SET search_path TO "{}"'.format(schema))
    conn.execute(SCHEMA_FILE.read_text(encoding="utf-8"))
    return conn


def publish(conn, by_id, rows):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TEMP TABLE t_joueurs (
              id bigint, pseudo text, alliance text, niveau integer, nb_planetes smallint
            ) ON COMMIT DROP""")
        with cur.copy("COPY t_joueurs FROM STDIN") as copy:
            for player_id, (name, alliance, level, planets) in by_id.items():
                copy.write_row((player_id, name, alliance, level, planets))
        cur.execute("""
            INSERT INTO joueurs (id, pseudo, alliance, niveau, nb_planetes, maj)
            SELECT id, pseudo, alliance, niveau, nb_planetes, now() FROM t_joueurs
            ON CONFLICT (id) DO UPDATE SET
              pseudo = EXCLUDED.pseudo, alliance = EXCLUDED.alliance,
              niveau = EXCLUDED.niveau, nb_planetes = EXCLUDED.nb_planetes,
              maj = now()""")

        # Joueurs dont les cases sont a recalculer : ceux qui avaient des
        # colonies avant, et ceux qui en auront apres.
        cur.execute("""
            CREATE TEMP TABLE t_touches ON COMMIT DROP AS
            SELECT DISTINCT joueur_id AS id FROM colonies""")

        # Les lignes du releve corrigees a la main (/edit) restent : masquees,
        # elles bloquent le retour de la valeur fausse.
        cur.execute("DELETE FROM colonies WHERE origine = 'releve' AND NOT masquee")

        cur.execute("""
            CREATE TEMP TABLE t_colonies (
              joueur_id bigint, x smallint, y smallint, numero smallint, qg smallint,
              systeme text, confiance real, image text, vu_le bigint
            ) ON COMMIT DROP""")
        with cur.copy("COPY t_colonies FROM STDIN") as copy:
            for player_id, c in rows:
                copy.write_row((player_id, c["x"], c["y"], c["number"], c["hq"],
                                c["system"], c["score"], c["image"], c["at"]))
        cur.execute("""
            INSERT INTO colonies
              (joueur_id, x, y, numero, qg, systeme, origine, confiance, image, vu_le)
            SELECT joueur_id, x, y, numero, qg, systeme, 'releve', confiance, image,
                   COALESCE(to_timestamp(vu_le), now())
            FROM t_colonies
            ON CONFLICT (joueur_id, x, y, numero) DO NOTHING""")
        inserted = cur.rowcount

        cur.execute("""
            SELECT rafraichir_cases(array(
              SELECT id FROM t_touches UNION SELECT DISTINCT joueur_id FROM colonies))""")

        cur.execute("SELECT count(*) FROM joueurs")
        players = cur.fetchone()[0]
        cur.execute("""SELECT count(*) FILTER (WHERE NOT masquee),
                              count(*) FILTER (WHERE origine = 'pin' AND NOT masquee)
                       FROM colonies""")
        colonies, pinned = cur.fetchone()
    return players, colonies, pinned, inserted


def import_pins(conn, env):
    """Reprend les pins deja saisis, qui vivaient dans Upstash, par serveur.

    La carte est desormais globale : les pins de tous les serveurs sont fusionnes.
    La cle Upstash n'est pas supprimee.
    """
    import requests  # noqa: PLC0415

    url = env.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
    token = env.get("UPSTASH_REDIS_REST_TOKEN", "")
    raw = requests.get("{}/get/{}".format(url, PINS_KEY),
                       headers={"Authorization": "Bearer " + token}, timeout=30).json()["result"]
    if not raw:
        print("Aucun pin dans Upstash.")
        return
    payload = json.loads(raw)
    # Le stockage du bot enveloppe tout dans {version, timers} (src/backends.js).
    guilds = payload.get("timers", payload)

    ids = set()
    with conn.cursor() as cur:
        for guild, players in guilds.items():
            for player_id, entry in players.items():
                pid = int(player_id)
                ids.add(pid)
                cur.execute("""
                    INSERT INTO joueurs (id, pseudo) VALUES (%s, %s)
                    ON CONFLICT (id) DO NOTHING""", (pid, entry["name"]))
                for spot in entry.get("coords", []):
                    print("  {:<16} {:>4},{:<4}  par {}".format(
                        entry["name"], spot["x"], spot["y"], spot.get("by") or "?"))
                    cur.execute("""
                        INSERT INTO colonies (joueur_id, x, y, numero, origine, par, vu_le)
                        VALUES (%s, %s, %s, 1, 'pin', %s, to_timestamp(%s / 1000.0))
                        ON CONFLICT (joueur_id, x, y, numero) DO UPDATE SET
                          origine = 'pin', par = EXCLUDED.par, vu_le = EXCLUDED.vu_le""",
                                (pid, spot["x"], spot["y"], spot.get("by"),
                                 spot.get("at") or time.time() * 1000))
        cur.execute("SELECT rafraichir_cases(%s::bigint[])", (sorted(ids),))
    print("{} joueur(s) repris".format(len(ids)))


def main():
    # La console Windows (cp1252) ne sait pas afficher certains pseudos Discord :
    # un caractere exotique faisait planter l'import en plein milieu.
    sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--import-pins", action="store_true")
    args = parser.parse_args()

    env = load_env()
    schema = env.get("GALAXYTIMER_SQL_SCHEMA", "public")

    if args.import_pins:
        with connect(env, schema) as conn:
            import_pins(conn, env)
        return

    by_id, rows, per_player, orphans, too_many = plan()
    print("{} joueur(s) au total".format(len(by_id)))
    print("{} colonie(s) rattachees, {} joueur(s) avec au moins une colonie".format(
        len(rows), len(per_player)))
    if orphans:
        print("{} colonie(s) ecartees : pseudo absent du dictionnaire "
              "(relancer roster.py --reset)".format(orphans))
    if too_many:
        print("\n{} joueur(s) ont plus de colonies connues que de planetes — "
              "au moins une attribution fausse :".format(len(too_many)))
        for name, count, planets in sorted(too_many, key=lambda t: -t[1])[:10]:
            print("  {:<20} {} connues pour {} planete(s)".format(name, count, planets))

    if not args.apply:
        print("\nRien envoye. Ajoute --apply pour publier.")
        return

    started = time.time()
    with connect(env, schema) as conn:
        players, colonies, pinned, inserted = publish(conn, by_id, rows)
    print("\nPublie en {:.0f}s : {} joueurs, {} colonies dont {} pin(s)".format(
        time.time() - started, players, colonies, pinned))
    if inserted < len(rows):
        print("{} releve(s) ignores : un pin existe deja sur ces coordonnees".format(
            len(rows) - inserted))


if __name__ == "__main__":
    main()
