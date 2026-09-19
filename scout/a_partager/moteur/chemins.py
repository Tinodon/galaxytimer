"""Tous les dossiers et fichiers du scout, a un seul endroit.

Avant, chaque script ecrivait ses propres chemins : deplacer un fichier en
cassait trois. Desormais, un chemin se change ici et nulle part ailleurs.

    scout/
      0_liste_des_joueurs.py  1_scanner.py  2_lire_captures.py  3_publier_carte.py
      config.json             reglages du scan
      moteur/                 code partage (ce dossier)
      outils/                 tests et calibrage
      archives/               anciens essais, non maintenus
      data/                   tout ce que les scripts produisent (jamais versionne)
"""

from pathlib import Path

SCOUT = Path(__file__).resolve().parent.parent
MOTEUR = SCOUT / "moteur"
CONFIG = SCOUT / "config.json"
ENV = SCOUT.parent / ".env"

# Gabarits de lettres, captures de reference verifiees, schema de la base.
GLYPHES = MOTEUR / "glyphs.json"
VERITE = MOTEUR / "truth.json"
SCHEMA_SQL = MOTEUR / "schema.sql"

DATA = SCOUT / "data"

# --- Les captures, dans l'ordre de leur vie ---
CAPTURES = DATA / "captures"
A_TRAITER = CAPTURES / "1_a_traiter"      # sorties du scan, pas encore lues
VALIDEES = CAPTURES / "2_validees"        # tous les pseudos reconnus
A_VERIFIER = CAPTURES / "3_a_verifier"    # au moins un pseudo a regarder a la main
ANCIENNES = CAPTURES / "anciennes"        # le premier releve (ancien lecteur)
ABIMEES = CAPTURES / "abimees_par_gemini" # rectangles rouges dessines dessus : a rescanner

# --- Les joueurs (0_liste_des_joueurs.py) ---
JOUEURS = DATA / "joueurs"
ROSTER = JOUEURS / "roster.json"
NIVEAUX = JOUEURS / "roster_niveaux.json"
FICHES = JOUEURS / "roster_joueurs.json"
ROSTER_ETAT = JOUEURS / "roster_state.json"

# --- Ce que la lecture a trouve ---
RESULTATS = DATA / "resultats"
SYSTEMES_BRUTS = RESULTATS / "systems.jsonl"        # ancien lecteur, lectures brutes
SYSTEMES_LUS = RESULTATS / "systems_resolus.jsonl"  # pseudos rattaches a de vrais joueurs

# --- Le scan (1_scanner.py) ---
SCAN = DATA / "scan"
SCAN_ETAT = SCAN / "crawl_state.json"
SCAN_JOURNAL = SCAN / "releve.txt"
CARTES = SCAN / "cartes"
ECRANS = SCAN / "ecrans_de_reference"   # captures d'ecran de calibrage

DEBUG = DATA / "debug"
JOURNAUX = DATA / "journaux"
CORBEILLE = DATA / "_trash"
