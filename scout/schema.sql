-- Carte globale de Galaxy Life : chaque joueur, ses colonies, le niveau de QG
-- de chacune.
--
-- SEULE definition du schema. publish_sql.py (Python, sur le PC de Noe) et le
-- bot (src/sql.js, sur Render) l'appliquent tous les deux : une colonne ne peut
-- pas exister d'un cote et manquer de l'autre.
--
-- Rejouable sans risque : tout est en IF NOT EXISTS / OR REPLACE, rien n'est
-- supprime.

-- Un joueur par ligne, avec les 24 cases demandees : 12 colonies, et le niveau
-- de QG de chacune a cote. On ouvre la table et on lit un joueur d'un coup
-- d'oeil.
--
-- Les 24 cases ne se saisissent JAMAIS a la main : elles sont recalculees
-- depuis `colonies` par rafraichir_cases(). Les modifier ici serait perdu au
-- prochain calcul.
CREATE TABLE IF NOT EXISTS joueurs (
  id          bigint PRIMARY KEY,          -- Id de l'API : stable si le pseudo change
  pseudo      text   NOT NULL,
  alliance    text,                         -- AllianceId de l'API (nom en minuscules)
  niveau      integer,
  nb_planetes smallint,                     -- colonies reelles selon l'API (12 max)
  colonie_1  text, qg_1  smallint,
  colonie_2  text, qg_2  smallint,
  colonie_3  text, qg_3  smallint,
  colonie_4  text, qg_4  smallint,
  colonie_5  text, qg_5  smallint,
  colonie_6  text, qg_6  smallint,
  colonie_7  text, qg_7  smallint,
  colonie_8  text, qg_8  smallint,
  colonie_9  text, qg_9  smallint,
  colonie_10 text, qg_10 smallint,
  colonie_11 text, qg_11 smallint,
  colonie_12 text, qg_12 smallint,
  maj         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS joueurs_pseudo   ON joueurs (lower(pseudo));
CREATE INDEX IF NOT EXISTS joueurs_alliance ON joueurs (alliance);

-- La verite : une ligne par PLANETE connue, relevee par le balayage ou saisie
-- avec /pin. C'est ici qu'on cherche "qui est en 359,11".
--
-- Un joueur peut avoir plusieurs planetes dans le meme systeme (sniviman en a
-- 6 en 102,0) : `numero` les distingue (1, 2, 3...). Une ligne par (joueur,
-- x, y) en faisait disparaitre 622.
CREATE TABLE IF NOT EXISTS colonies (
  joueur_id  bigint   NOT NULL REFERENCES joueurs (id) ON DELETE CASCADE,
  x          smallint NOT NULL,
  y          smallint NOT NULL,
  numero     smallint NOT NULL DEFAULT 1,     -- planete n de ce joueur dans ce systeme
  qg         smallint,                      -- vide tant que la vignette n'est pas lue
  systeme    text,                          -- nom du systeme, ex. DIADEM
  origine    text     NOT NULL CHECK (origine IN ('releve', 'pin')),
  par        text,                          -- qui a pinne (pseudo Discord)
  confiance  real,                          -- score du rapprochement de pseudo
  image      text,                          -- capture d'origine, pour verifier
  -- Ligne du balayage corrigee a la main (/edit). Elle reste en base, cachee,
  -- pour que la prochaine publication ne la fasse pas revenir.
  masquee    boolean  NOT NULL DEFAULT false,
  vu_le      timestamptz NOT NULL DEFAULT now()
);

-- Bases creees avant `numero` : on ajoute les colonnes et on remplace l'ancienne
-- unicite (une ligne par joueur et coordonnee) par une ligne par planete.
-- Aucune ligne n'est supprimee.
ALTER TABLE colonies ADD COLUMN IF NOT EXISTS numero  smallint NOT NULL DEFAULT 1;
ALTER TABLE colonies ADD COLUMN IF NOT EXISTS masquee boolean  NOT NULL DEFAULT false;
ALTER TABLE colonies DROP CONSTRAINT IF EXISTS colonies_joueur_id_x_y_key;
CREATE UNIQUE INDEX IF NOT EXISTS colonies_planete ON colonies (joueur_id, x, y, numero);

CREATE INDEX IF NOT EXISTS colonies_coords ON colonies (x, y);

-- Recalcule les 24 cases des joueurs donnes depuis `colonies`.
--
-- Appelee par la publication (tous les joueurs), /pin et /edit : c'est la seule
-- facon d'ecrire les cases, donc elles ne peuvent pas diverger de `colonies`.
-- Une case par PLANETE : deux planetes dans le meme systeme occupent deux
-- cases avec la meme coordonnee. Ordre : x, y, puis numero — le meme que les
-- lignes numerotees de /find. Lignes masquees exclues. Au-dela des planetes
-- connues, les cases restent vides.
CREATE OR REPLACE FUNCTION rafraichir_cases(ids bigint[]) RETURNS void
LANGUAGE sql AS $$
  UPDATE joueurs j SET
    colonie_1  = c.pos[1],  qg_1  = c.qg[1],
    colonie_2  = c.pos[2],  qg_2  = c.qg[2],
    colonie_3  = c.pos[3],  qg_3  = c.qg[3],
    colonie_4  = c.pos[4],  qg_4  = c.qg[4],
    colonie_5  = c.pos[5],  qg_5  = c.qg[5],
    colonie_6  = c.pos[6],  qg_6  = c.qg[6],
    colonie_7  = c.pos[7],  qg_7  = c.qg[7],
    colonie_8  = c.pos[8],  qg_8  = c.qg[8],
    colonie_9  = c.pos[9],  qg_9  = c.qg[9],
    colonie_10 = c.pos[10], qg_10 = c.qg[10],
    colonie_11 = c.pos[11], qg_11 = c.qg[11],
    colonie_12 = c.pos[12], qg_12 = c.qg[12]
  FROM (
    SELECT j2.id,
           array_agg(col.x || ',' || col.y ORDER BY col.x, col.y, col.numero)
             FILTER (WHERE col.joueur_id IS NOT NULL) AS pos,
           array_agg(col.qg ORDER BY col.x, col.y, col.numero)
             FILTER (WHERE col.joueur_id IS NOT NULL) AS qg
    FROM joueurs j2
    LEFT JOIN colonies col ON col.joueur_id = j2.id AND NOT col.masquee
    WHERE j2.id = ANY (ids)
    GROUP BY j2.id
  ) c
  WHERE j.id = c.id;
$$;
