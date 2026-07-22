"""
Génère les icônes PNG de l'application Dette.

Aucune dépendance externe : l'encodage PNG se fait avec zlib (bibliothèque
standard). Relancer après un changement de couleurs :

    python tools/make-icons.py
"""

import math
import os
import struct
import zlib

ICI = os.path.dirname(os.path.abspath(__file__))
RACINE = os.path.dirname(ICI)

# Palette de marque (identique à tailwind.config.js)
ROSE = (0xFF, 0x3D, 0x6E)
CORAIL = (0xFF, 0x7A, 0x59)
BLANC = (0xFF, 0xFF, 0xFF)

SUPER = 3  # sur-échantillonnage : 3x3 par pixel pour des bords lisses


def ecrire_png(chemin, largeur, hauteur, pixels):
    """Écrit un PNG RGBA 8 bits. `pixels` est un bytearray de largeur*hauteur*4."""
    lignes = b"".join(
        b"\x00" + bytes(pixels[y * largeur * 4:(y + 1) * largeur * 4])
        for y in range(hauteur)
    )
    compresse = zlib.compress(lignes, 9)

    def bloc(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    with open(chemin, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(bloc(b"IHDR", struct.pack(">IIBBBBB", largeur, hauteur, 8, 6, 0, 0, 0)))
        f.write(bloc(b"IDAT", compresse))
        f.write(bloc(b"IEND", b""))


def dans_coeur(x, y):
    """Équation implicite du cœur, sur des coordonnées centrées et normalisées."""
    return (x * x + y * y - 1) ** 3 - x * x * (y ** 3) <= 0


def dans_carre_arrondi(px, py, taille, rayon):
    """Test d'appartenance à un carré aux coins arrondis."""
    cx = min(max(px, rayon), taille - rayon)
    cy = min(max(py, rayon), taille - rayon)
    return (px - cx) ** 2 + (py - cy) ** 2 <= rayon * rayon


def generer(nom, taille, ratio_coeur=0.62, ratio_rayon=0.22):
    """Fond dégradé en carré arrondi + cœur blanc centré."""
    pixels = bytearray(taille * taille * 4)
    rayon = taille * ratio_rayon
    echelle = taille * ratio_coeur / 2.0
    centre = taille / 2.0
    # Décalage vertical : le cœur paraît mieux centré légèrement remonté.
    decalage = taille * 0.045

    for y in range(taille):
        for x in range(taille):
            somme_r = somme_g = somme_b = somme_a = 0

            for sy in range(SUPER):
                for sx in range(SUPER):
                    px = x + (sx + 0.5) / SUPER
                    py = y + (sy + 0.5) / SUPER

                    if not dans_carre_arrondi(px, py, taille, rayon):
                        continue  # hors de l'icône : reste transparent

                    # Dégradé diagonal rose -> corail
                    t = max(0.0, min(1.0, (px + py) / (2.0 * taille)))
                    fond = tuple(
                        int(round(ROSE[i] + (CORAIL[i] - ROSE[i]) * t)) for i in range(3)
                    )

                    # Coordonnées normalisées pour l'équation du cœur
                    hx = (px - centre) / echelle
                    hy = -(py - centre + decalage) / echelle
                    couleur = BLANC if dans_coeur(hx, hy) else fond

                    somme_r += couleur[0]
                    somme_g += couleur[1]
                    somme_b += couleur[2]
                    somme_a += 255

            total = SUPER * SUPER
            i = (y * taille + x) * 4
            if somme_a:
                # Moyenne pondérée par la couverture (anti-aliasing des bords)
                pixels[i] = round(somme_r / (somme_a / 255))
                pixels[i + 1] = round(somme_g / (somme_a / 255))
                pixels[i + 2] = round(somme_b / (somme_a / 255))
                pixels[i + 3] = round(somme_a / total)

    chemin = os.path.join(RACINE, nom)
    ecrire_png(chemin, taille, taille, pixels)
    print(f"  {nom}  ({taille}x{taille})")


if __name__ == "__main__":
    print("Génération des icônes Dette :")
    # Icônes classiques : carré arrondi
    generer("icon-192.png", 192)
    generer("icon-512.png", 512)
    # Icône « maskable » : pleine surface, cœur réduit pour la zone de sécurité
    generer("icon-maskable-512.png", 512, ratio_coeur=0.44, ratio_rayon=0.0)
    # iOS applique son propre masque : fond plein, coins carrés
    generer("apple-touch-icon.png", 180, ratio_rayon=0.0)
    print("Terminé.")
