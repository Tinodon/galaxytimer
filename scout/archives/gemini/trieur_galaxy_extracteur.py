import cv2
import numpy as np
import os
import shutil
import pytesseract
import re

# ==========================================
# CONFIGURATION ET DOSSIERS
# ==========================================

CHEMIN_BASE = os.path.dirname(os.path.abspath(__file__))

dossier_source = os.path.join(CHEMIN_BASE, "a_traiter")
dossier_empty = os.path.join(CHEMIN_BASE, "outputs", "empty")
dossier_pas_empty = os.path.join(CHEMIN_BASE, "outputs", "pas_empty")
dossier_non_resolu = os.path.join(CHEMIN_BASE, "outputs", "non_resolu")
dossier_lettres = os.path.join(CHEMIN_BASE, "lettres_ref")

fichier_resultats = os.path.join(CHEMIN_BASE, "resultats_galaxy.txt")

for dossier in [dossier_empty, dossier_pas_empty, dossier_non_resolu, dossier_lettres]:
    os.makedirs(dossier, exist_ok=True)

# Charger les templates d'images si présents
TEMPLATES = {}
for file in os.listdir(dossier_lettres):
    if file.lower().endswith(('.png', '.jpg')):
        char = os.path.splitext(file)[0].upper()
        img_t = cv2.imread(os.path.join(dossier_lettres, file), cv2.IMREAD_GRAYSCALE)
        if img_t is not None:
            TEMPLATES[char] = img_t

print(f"[CONFIG] {len(TEMPLATES)} gabarit(s) de lettres chargé(s) pour le Template Matching.")

# ==========================================
# GRILLE DES 12 EMPLACEMENTS DE CARTE
# ==========================================

SLOTS_GRID = [
    (0.050, 0.200, 0.180, 0.490), (0.200, 0.200, 0.330, 0.490),
    (0.350, 0.200, 0.480, 0.490), (0.500, 0.200, 0.630, 0.490),
    (0.650, 0.200, 0.780, 0.490), (0.800, 0.200, 0.930, 0.490),
    (0.050, 0.510, 0.180, 0.800), (0.200, 0.510, 0.330, 0.800),
    (0.350, 0.510, 0.480, 0.800), (0.500, 0.510, 0.630, 0.800),
    (0.650, 0.510, 0.780, 0.800), (0.800, 0.510, 0.930, 0.800),
]

lower_purple = np.array([130, 40, 40])
upper_purple = np.array([170, 255, 255])

# ==========================================
# NIVEAU 1 : PRETRAITEMENT ET OCR
# ==========================================

def isoler_texte_galaxy_life(roi):
    if roi is None or roi.size == 0:
        return None, None

    roi_large = cv2.resize(roi, (0, 0), fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    hsv = cv2.cvtColor(roi_large, cv2.COLOR_BGR2HSV)

    mask_white = cv2.inRange(hsv, np.array([0, 0, 170]), np.array([180, 50, 255]))
    mask_yellow = cv2.inRange(hsv, np.array([15, 80, 170]), np.array([35, 255, 255]))
    mask = cv2.bitwise_or(mask_white, mask_yellow)

    if cv2.countNonZero(mask) < 30:
        gray = cv2.cvtColor(roi_large, cv2.COLOR_BGR2GRAY)
        _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    kernel = np.ones((2, 2), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    
    return mask, cv2.bitwise_not(mask)

# ==========================================
# NIVEAU 2 : TEMPLATE MATCHING PAR CARACTÈRE
# ==========================================

def comparer_caractere_template(crop_char_bin):
    """Compare une lettre découpée avec les gabarits enregistrés."""
    if not TEMPLATES or crop_char_bin is None:
        return None

    meilleur_char = None
    meilleur_score = -1.0

    h_c, w_c = crop_char_bin.shape
    if h_c < 5 or w_c < 2:
        return None

    for char, template in TEMPLATES.items():
        # Redimensionner le template à la taille du caractère découpé
        tmpl_resized = cv2.resize(template, (w_c, h_c), interpolation=cv2.INTER_AREA)
        res = cv2.matchTemplate(crop_char_bin, tmpl_resized, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, _ = cv2.minMaxLoc(res)

        if max_val > meilleur_score:
            meilleur_score = max_val
            meilleur_char = char

    return meilleur_char if meilleur_score > 0.70 else None

def lecture_par_template_matching(mask_bin):
    """Découpe le masque binaire en caractères individuels et applique le matching."""
    contours, _ = cv2.findContours(mask_bin, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rects = [cv2.boundingRect(c) for c in contours]
    rects = [r for r in rects if r[3] > 12 and r[2] >= 2] # Filtrer le bruit
    rects = sorted(rects, key=lambda r: r[0]) # Tri de gauche à droite

    mot_reconstruit = []
    for x, y, w, h in rects:
        crop_char = mask_bin[y:y+h, x:x+w]
        char_trouve = comparer_caractere_template(crop_char)
        if char_trouve:
            mot_reconstruit.append(char_trouve)
            
    return "".join(mot_reconstruit) if mot_reconstruit else None

# ==========================================
# NIVEAU 3 : RÈGLES ET CORRECTIONS CONTEXTUELLES
# ==========================================

def corriger_regles_contextuelles(texte):
    if not texte:
        return texte
    # Correction B / 3 contextuelle
    texte = re.sub(r'^3([A-Z])', r'B\1', texte)
    texte = re.sub(r'([A-Z])3([A-Z])', r'\1B\2', texte)
    return texte

def analyser_zone_texte(img_roi):
    mask_bin, img_clean = isoler_texte_galaxy_life(img_roi)
    if mask_bin is None:
        return ""

    # 1. Essai prioritaire par Template Matching si les templates existent
    texte_tm = lecture_par_template_matching(mask_bin)
    
    # 2. Fallback / Vérification par OCR Tesseract
    texte_ocr = ""
    try:
        config = '--psm 7 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'
        texte_ocr = pytesseract.image_to_string(img_clean, config=config).strip().upper()
    except Exception:
        pass

    # Arbitrage entre Template Matching et OCR
    resultat_final = texte_tm if texte_tm and len(texte_tm) >= 2 else texte_ocr
    
    # 3. Application des règles contextuelles (B/3, regex)
    return corriger_regles_contextuelles(resultat_final)

# ==========================================
# EXTRACTION ET BOUCLE PRINCIPALE
# ==========================================

def extraire_coordonnees_haut(img):
    h, w, _ = img.shape
    roi = img[0:int(h * 0.12), int(w * 0.20):int(w * 0.80)]
    texte = analyser_zone_texte(roi)
    match = re.search(r'\(?\s*(\d+)\s*,\s*(\d+)\s*\)?', texte)
    return f"({match.group(1)}, {match.group(2)})" if match else "(?,?)"

def extraire_pseudo_slot(img, slot_coords):
    h, w, _ = img.shape
    x1, y1, x2, y2 = slot_coords
    
    px1, px2 = int(max(0, x1 - 0.015) * w), int(min(1.0, x2 + 0.015) * w)
    py1, py2 = int(y1 * h), int((y1 + 0.08) * h)
    
    roi = img[py1:py2, px1:px2]
    texte = analyser_zone_texte(roi)
    alnum = re.sub(r'[^A-Z0-9_-]', '', texte)
    
    return alnum if len(alnum) >= 2 else None, (px1, py1, px2, py2)

def traiter_images():
    fichiers = [f for f in os.listdir(dossier_source) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
    if not fichiers:
        print("Aucune image dans 'a_traiter'.")
        return

    print(f"--- Analyse Hybride (OCR + Template Matching + Règles) sur {len(fichiers)} image(s) ---")

    with open(fichier_resultats, "a", encoding="utf-8") as f_txt:
        for filename in fichiers:
            chemin_complet = os.path.join(dossier_source, filename)
            img = cv2.imread(chemin_complet)
            if img is None:
                continue

            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
            h, w, _ = img.shape
            coords = extraire_coordonnees_haut(img)
            
            pseudos_trouves, un_pseudo_echec, cartes_detectees = [], False, 0
            img_annotee = img.copy()

            for slot in SLOTS_GRID:
                sx1, sy1, sx2, sy2 = int(slot[0]*w), int(slot[1]*h), int(slot[2]*w), int(slot[3]*h)
                slot_hsv = hsv[sy1:sy2, sx1:sx2]
                mask_purple = cv2.inRange(slot_hsv, lower_purple, upper_purple)
                
                if cv2.countNonZero(mask_purple) > 150:
                    cartes_detectees += 1
                    pseudo, (px1, py1, px2, py2) = extraire_pseudo_slot(img, slot)
                    if pseudo:
                        pseudos_trouves.append(pseudo)
                    else:
                        un_pseudo_echec = True
                        cv2.rectangle(img_annotee, (px1, py1), (px2, py2), (0, 0, 255), 2)

            # Écriture instantanée
            if cartes_detectees == 0:
                f_txt.write(f"Galaxie {coords} : VIDE (0 joueur)\n")
                shutil.move(chemin_complet, os.path.join(dossier_empty, filename))
                print(f"[VIDE] Galaxie {coords}")
            elif un_pseudo_echec:
                p_str = ", ".join(pseudos_trouves) if pseudos_trouves else "Aucun"
                f_txt.write(f"Galaxie {coords} : [ERREUR LECTURE] Pseudos lus : {p_str}\n")
                cv2.imwrite(os.path.join(dossier_non_resolu, filename), img_annotee)
                if os.path.exists(chemin_complet): os.remove(chemin_complet)
                print(f"[ATTENTION] Galaxie {coords} -> [ERREUR LECTURE]")
            else:
                str_pseudos = ", ".join(pseudos_trouves)
                f_txt.write(f"Galaxie {coords} : {str_pseudos}\n")
                shutil.move(chemin_complet, os.path.join(dossier_pas_empty, filename))
                print(f"[OK] Galaxie {coords} : {str_pseudos}")

            f_txt.flush()

    print(f"\nTraitement terminé ! Données enregistrées dans : {fichier_resultats}")

if __name__ == "__main__":
    traiter_images()