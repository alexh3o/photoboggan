# Photofile

Photofile est un navigateur et gestionnaire de photothèque local, minimaliste.

L'application a été pensée pour un objectif précis : accélérer le processus de tri, de notation et de comparaison de photos sans alourdir le système.

⚠️ **Avertissement (Beta)** : Ce logiciel est actuellement en version bêta, fourni sans aucune garantie (« as is »), <u>à utiliser à vos risques et périls</u>. Il est fortement recommandé d'<u>effectuer une sauvegarde complète de vos photos</u> avant toute utilisation.

![Aperçu de Photofile](/screenshots/photofile_9pnYgRmcUT.jpg)

# 🚀 Fonctionnalités principales

**Zéro copie, respect de l'arborescence** : Vos fichiers restent strictement là où ils sont. Aucune modification de structure ni duplication de fichiers n'est effectuée sur votre disque.

**Navigation fluide et dossiers locaux** : Parcourez vos répertoires en un clin d'œil avec une grille de miniatures et une taille d'affichage entièrement réglable.

**Visualisation rapide** : Accès immédiat à un aperçu plein écran zoomable.

**Recherche multicritère avancée** :

- Par mots-clés et notes.

- Par filtre de date unifié ultra-flexible (prise en charge des formats de l'année à la minute : AAAA, AAAAMM, AAAAMMJJ, AAAAMMJJHH, AAAAMMJJHHmm, ainsi que des plages personnalisées combinables).

**Mode Comparaison simultanée** : Comparez 2 à 4 images côte à côte avec des zooms et déplacements synchronisés (ou désynchronisables à tout moment).

**Métadonnées et EXIF** :

- Affichage des données EXIF essentielles.

- Écriture directe des notes et tags dans les fichiers EXIF pour une portabilité maximale.

# 🛠️ Stack Technique

Développé pour offrir des performances natives maximales grâce à une architecture hybride moderne :

- Application de bureau : Tauri v2 (garantissant un exécutable léger, rapide et sécurisé).

- Backend (Performances & Fichiers) :

  - Rust pour la rapidité d'exécution et le traitement lourd.

  - Rayon pour l'exploration et l'indexation multithread des dossiers de photos.

  - Walkdir pour la traversée récursive rapide de l'arborescence locale.

  - Kamadak-exif pour l'extraction ultra-rapide des métadonnées embarquées.

- Base de données : SQLite intégré localement (via rusqlite et r2d2 en mode WAL) pour des recherches et une indexation instantanées sans dépendance externe.

- Frontend : Vue.js 3 / Vite pour une interface réactive et moderne.

# 🌍 Langue et Internationalisation

L'application est actuellement disponible en français. Une architecture multilingue (avec l'anglais par défaut) sera intégrée dans les prochaines versions.

# ⛶ Screenshots

![Aperçu de Photofile](/screenshots/photofile_D62drnmLzg.jpg)

*Vue plein écran*

![Aperçu de Photofile](/screenshots/photofile_VPAX3vJOkt.jpg)

*Miniatures seules & Mode clair*

![Aperçu de Photofile](/screenshots/photofile_3UdcAhXK98.jpg)

*Mode Comparer*

![Aperçu de Photofile](/screenshots/photofile_9sLSsMjmtq.jpg)

*Paramètres*

# 📄 Licence

Projet distribué sous licence MIT. (Voir le fichier LICENSE pour plus de détails).
