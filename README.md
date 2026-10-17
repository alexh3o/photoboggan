# Photofile

<img title="" src="/screenshots/logo256.png" alt="/img" data-align="center" />

<p align="center">
  <b>English</b> | <a href="#francais">Français</a>
</p>

<div id="english">

Photofile is a minimalist, local photo library browser and manager.

The application was designed with a specific goal: to speed up the process of sorting, rating, and comparing photos without bogging down your system.

⚠️ **Beta Warning**: This software is currently in beta version, provided "as is" without warranty of any kind, <u>use at your own risk</u>. It is strongly recommended to <u>make a complete backup of your photos</u> before any use.

![Photofile Preview](/screenshots/thumbnails-preview-info.jpg)

# 🚀 Key Features

**Zero copy, folder structure respected**: Your files stay strictly where they are. No structural modifications or file duplications are performed on your disk.

**Smooth navigation & local folders**: Browse your directories in the blink of an eye with a grid of thumbnails and fully adjustable display sizes.

**Fast viewing**: Immediate access to a zoomable fullscreen preview.

**Advanced multi-criteria search**:

- By keywords and ratings.
- By an ultra-flexible unified date filter (supporting formats from year down to minute: YYYY, YYYYMM, YYYYMMDD, YYYYMMDDHH, YYYYMMDDHHmm, as well as combinable custom ranges).

**Simultaneous Comparison Mode**: Compare 2 to 4 images side by side with synchronized (or independently toggleable) zooms and pans.

**Metadata & EXIF**:

- Display of essential EXIF data.
- Direct writing of ratings and color tags into EXIF files for maximum portability.

# 🛠️ Technical Stack

Developed to deliver maximum native performance through a modern hybrid architecture:

- Desktop application: Tauri v2.
- Backend:
  - Rust for execution speed and heavy processing.
  - Rayon for multithreaded traversal and indexing of photo folders.
  - Walkdir for rapid recursive traversal of the local directory tree.
  - Kamadak-exif for ultra-fast extraction of embedded metadata.
- Database: Locally integrated SQLite (via rusqlite and r2d2 in WAL mode) .
- Frontend: Vue.js 3 / Vite.

# 🌍 Language & Internationalization

The application is currently available in French and English. You can contribute by copying a json file from /src/locales, and translating + sharing it.

# ⛶ Screenshots

![Photofile Preview](/screenshots/fullscreen.jpg)

*Fullscreen view*

![Aperçu de Photofile](/screenshots/fullscreen-rating.jpg)

*Fullscreen view with rating*

![Photofile Preview](/screenshots/thumbnails-only.jpg)

*Thumbnails only*

![Photofile Preview](/screenshots/compare.jpg)

*Comparison mode & light theme*

![Photofile Preview](/screenshots/settings.jpg)

*Settings*

# 📄 License

Project distributed under the MIT license. (See the LICENSE file for details).

</div>

<div id="francais">
<p align="center">
  <a href="#english">English</a> | Français
</p>
Photofile est un navigateur et gestionnaire de photothèque local, minimaliste.

L'application a été pensée pour un objectif précis : accélérer le processus de tri, de notation et de comparaison de photos sans alourdir le système.

⚠️ **Avertissement (Beta)** : Ce logiciel est actuellement en version bêta, fourni sans aucune garantie (« as is »), <u>à utiliser à vos risques et périls</u>. Il est fortement recommandé d'<u>effectuer une sauvegarde complète de vos photos</u> avant toute utilisation.

![Aperçu de Photofile](/screenshots/thumbnails-preview-info.jpg)

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

- Écriture directe des notes et tags de couleurs dans les fichiers EXIF pour une portabilité maximale.

# 🛠️ Stack Technique

Développé pour offrir des performances natives maximales grâce à une architecture hybride moderne :

- Application de bureau : Tauri v2.

- Backend :

  - Rust pour la rapidité d'exécution et le traitement lourd.

  - Rayon pour l'exploration et l'indexation multithread des dossiers de photos.

  - Walkdir pour la traversée récursive rapide de l'arborescence locale.

  - Kamadak-exif pour l'extraction ultra-rapide des métadonnées embarquées.

- Base de données : SQLite intégré localement (via rusqlite et r2d2 en mode WAL).

- Frontend : Vue.js 3 / Vite.

# 🌍 Langue et Internationalisation

L'application est actuellement disponible en français et anglais. Vous pouvez contribuer en récupérant un fichier json de /src/locales, puis en le traduisant et repartageant.

# ⛶ Screenshots

![Aperçu de Photofile](/screenshots/fullscreen.jpg)

*Vue plein écran*

![Aperçu de Photofile](/screenshots/fullscreen-rating.jpg)

*Vue plein écran et notation*

![Aperçu de Photofile](/screenshots/thumbnails-only.jpg)

*Miniatures seules*

![Aperçu de Photofile](/screenshots/compare.jpg)

*Mode Comparer et theme clair*

![Aperçu de Photofile](/screenshots/settings.jpg)

*Paramètres*

# 📄 Licence

Projet distribué sous licence MIT. (Voir le fichier LICENSE pour plus de détails).

</div>
