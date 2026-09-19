import cv2
import numpy as np
import os
import shutil

# Récupère le dossier exact où se trouve ce script python
CHEMIN_BASE = os.path.dirname(os.path.abspath(__file__))

# Définition des dossiers en se basant sur l'emplacement du script
dossier_source = os.path.join(CHEMIN_BASE, "a_traiter")
dossier_empty = os.path.join(CHEMIN_BASE, "outputs", "empty")
dossier_pas_empty = os.path.join(CHEMIN_BASE, "outputs", "pas_empty")

# Création des dossiers de sortie s'ils n'existent pas
for dossier in [dossier_empty, dossier_pas_empty]:
    os.makedirs(dossier, exist_ok=True)

# Définition de la plage de couleur du cadre violet des joueurs (en format HSV)
lower_purple = np.array([130, 50, 50])
upper_purple = np.array([165, 255, 255])
SEUIL_PIXELS = 500 

def classer_images():
    if not os.path.exists(dossier_source):
        print(f"Erreur : Le dossier '{dossier_source}' est introuvable.")
        return

    fichiers = [f for f in os.listdir(dossier_source) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
    
    if not fichiers:
        print(f"Aucune image trouvée dans '{dossier_source}'.")
        return

    for filename in fichiers:
        chemin_complet = os.path.join(dossier_source, filename)
        img = cv2.imread(chemin_complet)

        if img is None:
            print(f"Erreur de lecture pour {filename}")
            continue

        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        masque = cv2.inRange(hsv, lower_purple, upper_purple)
        pixels_violets = cv2.countNonZero(masque)

        if pixels_violets > SEUIL_PIXELS:
            destination = os.path.join(dossier_pas_empty, filename)
            print(f"[JOUEUR DETECTE] -> {filename}")
        else:
            destination = os.path.join(dossier_empty, filename)
            print(f"[VIDE] -> {filename}")
            
        shutil.move(chemin_complet, destination)

if __name__ == "__main__":
    classer_images()
    print("Tri terminé !")