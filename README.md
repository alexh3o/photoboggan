<div id="english">
<p align="center">
  <b>English</b> | <a href="#francais">Français</a>
</p>

# Photofile

<p align="center">
  <img src="/screenshots/logo256.png" alt="Photofile Logo" width="128" />
</p>

<p align="center">
  <b>Fast, lightweight, and local desktop photo browser and culling manager.</b>
</p>



Photofile is built with a clear purpose: **accelerate photo sorting, rating, comparison, and exploration** across large local image collections without sluggish catalogs or vendor lock-in.

⚠️ **Beta Warning**: Photofile is currently in beta, provided "as is" without warranty of any kind. <u>Use at your own risk</u>. It is strongly recommended to <u>keep a complete backup of your photos</u>.

![Photofile Preview](/screenshots/thumbnails-preview-info.jpg)

---

## 🚀 Key Features

### ⚡ Uncompromising Performance

- **Zero Copy**: Your folder hierarchy is respected as-is on disk. No duplicated files or opaque proprietary database libraries.
- **Fast Multi-Threaded Scanning**: Background indexing powered by Rust (`rayon` + `walkdir`) reading hundreds of files in seconds.
- **High-Performance Virtual Scrolling**: Smooth scrolling with custom inertia physics.
- **Customizable Storage Location**: Choose where to store your database and thumbnail caches (e.g., on a secondary fast SSD) with automated, safe on-the-fly migration.

### 📷 Broad Format & Native RAW Support

- **Standard formats**: JPEG, PNG, WebP, AVIF, GIF, BMP, JFIF.
- **Camera RAW files**: Sony (`.arw`), Canon (`.cr2`, `.cr3`), Nikon (`.nef`, `.nrw`), Adobe (`.dng`), Fujifilm (`.raf`), Olympus (`.orf`), Panasonic (`.rw2`).
- **Instant RAW Previews**: Leverages embedded JPEG previews extracted instantly from RAW containers  — no heavy demosaicing lag during navigation.

### 📐 Ergonomic & Adaptable Layouts

- **3 Grid Modes**: Justified, Square, Waterfall (Masonry).
- **Adjustable Thumbnail Sizes**: Continuous scaling from 96 px up to your configured cache size (up to 1024 px).
- **Smart Group Separators**: Organize the grid by date (day, week, month, year) or by folder.

### 🔍 Advanced Filtering & Search

- **Multi-criteria stack**: Filter in real time by minimum star rating, color label(s), cumulative keywords (`&`), and dates.
- **Unified Flexible Date Syntax**: Compact range input (`YYYY`, `YYYYMM`, `YYYYMMDD`, `YYYYMMDDHH`, `YYYYMMDDHHmm`, e.g., `20240501-2025`) or via the integrated calendar picker.

### 🔍 Precision Inspection & Compare Mode

- **Dual / Quad Comparison**: Compare up to 4 photos side-by-side with synchronized (or independently unlinked) zoom and pan.
- **Contextual Single-Photo Actions**: Inspect, reveal, or delete individual rejected shots directly from the comparison view without collapsing your session.
- **Immersive Fullscreen**: Quick toggle with `F` or double-click, featuring mouse-centered zoom (`Ctrl` + Wheel, `+` / `-` / `*`).

### 🏷️ Open & Interoperable Metadata

- **Real File Persistence**: Ratings (0 to 5 stars) and color labels are written directly into standard JPEG XMP APP1 segments or companion `.xmp` sidecars for RAW files.
- **Cross-Software Compatibility**: Synchronized with Adobe Lightroom / XMP, digiKam, ACDSee, and Windows Photo standards.
- **Full Inspector**: Detailed panel and dialog displaying File, EXIF, XMP, and IPTC tags.

### 🗂️ Effortless File Management

- **Native OS Clipboard**: Copy files with `Ctrl+C` directly pasteable into Windows Explorer, email clients, or messaging apps.
- **Drag & Drop Organization**: Move (`Shift` + Drag) or copy (`Ctrl` + Drag) photos directly into the folder tree.
- **"Open With" Launcher**: Configure favorite external editors (Photoshop, Lightroom, RawTherapee, Affinity...) directly accessible from the context menu.

---

## ⌨️ Essential Keyboard Shortcuts

| Shortcut              | Context                | Action                                            |
|:--------------------- |:---------------------- |:------------------------------------------------- |
| `0` – `5`             | Selection / Fullscreen | Set rating (or reset if already assigned)         |
| `F` or `Double-Click` | Grid / Fullscreen      | Enter or exit Fullscreen                          |
| `R`                   | Fullscreen             | Show / pin rating bar                             |
| `+` / `-`             | Preview / Fullscreen   | Zoom in / Zoom out                                |
| `*`                   | Preview / Fullscreen   | Toggle 1:1 Actual size / Fit to window            |
| `Ctrl` + `Wheel`      | Preview / Fullscreen   | Smooth zoom around cursor                         |
| `Ctrl` + `C`          | Grid / Selection       | Copy original files to OS clipboard               |
| `C`                   | Grid / Selection       | Copy to a selected folder                         |
| `Delete`              | Grid / Compare         | Delete selected file(s) permanently               |
| `I`                   | Selection              | Open detailed Metadata dialog (EXIF / XMP / IPTC) |
| `E`                   | Selection              | Reveal photo in default File Manager              |
| `F11`                 | Global                 | Toggle Immersive Mode (borderless fullscreen)     |

---

## 🛠️ Technical Stack

- **Desktop Shell**: [Tauri v2](https://tauri.app/) (lightweight, secure, native OS webview).
- **Backend (Rust)**:
  - `rayon` for parallel scanning and EXIF extraction.
  - `walkdir` for fast recursive directory traversal.
  - `kamadak-exif` for metadata decoding.
  - `jpeg-decoder` (scaled DCT) & `jpeg-encoder` for native thumbnail rendering.
  - `clipboard-rs` for cross-platform OS clipboard operations.
  - `rusqlite` + `r2d2` for transactional SQLite storage in WAL mode.
- **Frontend**: Pure Vanilla JavaScript (ES modules), HTML5, and responsive CSS (Vite build system)—zero runtime framework overhead.

---

## 🌍 Languages & Internationalization

Available in **English** and **French**.

Contributions are welcome! Pick a JSON file in `src/locales/`, translate it, and submit a pull request.

---

## ⛶ Screenshots

![Fullscreen View](/screenshots/fullscreen.jpg)
*Fullscreen view*

![Fullscreen View with Rating](/screenshots/fullscreen-rating.jpg)
*Fullscreen view with rating bar*

![Thumbnails Only](/screenshots/thumbnails-only.jpg)
*Thumbnails grid view*

![Comparison Mode](/screenshots/compare.jpg)
*Comparison mode & light theme*

![Settings Modal](/screenshots/settings.jpg)
*Settings modal (tabbed organization)*

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for details.

</div>

---

<div id="francais">
<p align="center">
  <a href="#english">English</a> | <b>Français</b>
</p>

# Photofile

<p align="center">
  <img src="/screenshots/logo256.png" alt="Logo Photofile" width="128" />
</p>

<p align="center">
  <b>Visionneur et gestionnaire de photothèque local ultra-rapide, léger et ergonomique.</b>
</p>



Photofile a été conçu dans un but précis : **accélérer le tri, la notation, la comparaison et l'exploration** de collections de photos volumineuses, sans catalogue propriétaire lourd ni enfermement d'écosystème.

⚠️ **Avertissement (Bêta)** : Ce logiciel est actuellement en version bêta, fourni sans aucune garantie (« as is »), <u>à utiliser à vos risques et périls</u>. Il est fortement recommandé d'<u>effectuer une sauvegarde complète de vos photos</u>.

![Aperçu de Photofile](/screenshots/thumbnails-preview-info.jpg)

---

## 🚀 Fonctionnalités principales

### ⚡ Performances sans compromis

- **Zéro copie, respect de vos dossiers** : Vos fichiers restent strictement à leur emplacement sur le disque. Aucun déplacement forcé ni duplication de catalogue.
- **Indexation multithread ultra-rapide** : Exploration et lecture d'en-têtes en arrière-plan propulsées par Rust (`rayon` + `walkdir`), traitant des milliers de fichiers en quelques secondes.
- **Virtual Scrolling fluide** : Défilement avec modèle d'inertie physique. Seules les miniatures visibles à l'écran sont instanciées dans le DOM.
- **Génération native de miniatures** : Décodage DCT partiel (1/2, 1/4, 1/8) en Rust évitant de décoder les images 24+ Mpx en pleine définition, avec cache sur disque paramétrable (256, 512, 768 ou 1024 px).
- **Emplacement des données personnalisable** : Déplacez votre base SQLite et vos dossiers de cache (par exemple sur un SSD secondaire rapide) avec migration automatique et sécurisée des données à chaud.

### 📷 Formats étendus et support natif des RAW

- **Formats standards** : JPEG, PNG, WebP, AVIF, GIF, BMP, JFIF.
- **Fichiers RAW boîtiers** : Sony (`.arw`), Canon (`.cr2`, `.cr3`), Nikon (`.nef`, `.nrw`), Adobe (`.dng`), Fujifilm (`.raf`), Olympus (`.orf`), Panasonic (`.rw2`).
- **Prévisualisations RAW instantanées** : Extraction en quelques millisecondes du JPEG haute définition intégré aux conteneurs RAW. Aucune latence de dématriçage lors du tri, du défilement ou du plein écran.

### 📐 Dispositions ergonomiques et adaptatives

- **3 modes d'affichage de grille** :
  - **Justifiées** : Préserve le ratio d'aspect réel de chaque photo sans aucun recadrage ni marge superflue.
  - **Carrées** : Grille symétrique épurée avec taille de cellule ajustable.
  - **Cascade (Waterfall / Masonry)** : Disposition dynamique sur plusieurs colonnes idéale pour les orientations mixtes.
- **Taille de miniatures réglable** : Échelle continue de 96 px jusqu'à la taille maximale de cache choisie (jusqu'à 1024 px).
- **Séparateurs intelligents** : Regroupement automatique par date (jour, semaine, mois, année) ou par dossier.

### 🔍 Filtres et recherche multicritères

- **Combinaison en temps réel** : Filtrage par note minimale (étoiles), couleur(s), mots-clés cumulatifs (`&`) et dates.
- **Syntaxe de dates unifiée et ultra-souple** : Saisie compacte de l'année à la minute (`AAAA`, `AAAAMM`, `AAAAMMJJ`, `AAAAMMJJHH`, `AAAAMMJJHHmm`, ex. `20240501-2025`) ou sélection visuelle dans le calendrier intégré.
- **Remise à zéro rapide** : Effacez tous les filtres d'un simple clic grâce au bouton dédié.

### 🔍 Inspection précise et Mode Comparer

- **Comparaison 2 à 4 photos** : Visualisez vos prises côte-à-côte avec zooms et déplacements synchronisés (ou désynchronisables indépendamment).
- **Actions contextuelles ciblées** : Inspectez, révélez ou supprimez précisément une photo de la comparaison par clic droit sans réinitialiser votre sélection de travail.
- **Plein écran immersif** : Bascule instantanée avec `F` ou double-clic, zoom au curseur (`Ctrl` + Molette, `+` / `-` / `*`) et barre de notation escamotable (`R`).

### 🏷️ Métadonnées ouvertes et interopérables

- **Persistance réelle dans les fichiers** : Les notes (0 à 5 étoiles) et drapeaux de couleur sont directement inscrits dans les segments JPEG XMP APP1 ou dans des fichiers sidecars `.xmp` pour les RAW.
- **Interopérabilité maximale** : Compatible avec Adobe Lightroom, digiKam, ACDSee et l'Explorateur Windows.
- **Inspecteur complet** : Fiche et fenêtre détaillée affichant les données Fichier, EXIF, XMP et IPTC.

### 🗂️ Gestion de fichiers intégrée

- **Presse-papiers natif de l'OS** : Copie directe (`Ctrl+C`) collable dans l'Explorateur de fichiers, les courriels ou les messageries.
- **Organisation par glisser-déposer** : Déplacez (`Maj` + Glisser) ou copiez (`Ctrl` + Glisser) directement vos photos vers l'arborescence des dossiers.
- **Menu « Ouvrir avec »** : Configurez vos logiciels de retouche favoris (Photoshop, Lightroom, RawTherapee, Affinity...) accessibles au clic droit.

---

## ⌨️ Raccourcis clavier essentiels

| Raccourci            | Contexte                | Action                                                       |
|:-------------------- |:----------------------- |:------------------------------------------------------------ |
| `0` à `5`            | Sélection / Plein écran | Attribuer une note (ou effacer si identique)                 |
| `F` ou `Double-clic` | Grille / Plein écran    | Entrer ou sortir du plein écran                              |
| `R`                  | Plein écran             | Afficher / épingler la barre de notation                     |
| `+` / `-`            | Aperçu / Plein écran    | Zoom avant / Zoom arrière                                    |
| `*`                  | Aperçu / Plein écran    | Échelle 100 % (1:1) / Ajuster à la fenêtre                   |
| `Ctrl` + `Molette`   | Aperçu / Plein écran    | Zoom fluide centré sur le curseur                            |
| `Ctrl` + `C`         | Grille / Sélection      | Copier les fichiers originaux dans le presse-papiers OS      |
| `C`                  | Grille / Sélection      | Copier vers un dossier sélectionné                           |
| `Suppr`              | Grille / Comparer       | Supprimer définitivement la ou les photos                    |
| `I`                  | Sélection               | Ouvrir la fiche d'informations détaillée (EXIF / XMP / IPTC) |
| `E`                  | Sélection               | Révéler le fichier dans le gestionnaire de fichiers OS       |
| `F11`                | Global                  | Mode immersif (plein écran sans barre de titre)              |

---

## 🛠️ Stack technique

- **Conteneur bureau** : [Tauri v2](https://tauri.app/) (léger, sécurisé, exploitant la WebView native de l'OS).
- **Backend (Rust)** :
  - `rayon` pour l'indexation parallèle et l'extraction EXIF.
  - `walkdir` pour le parcours récursif rapide du disque.
  - `kamadak-exif` pour le décodage des métadonnées.
  - `jpeg-decoder` (DCT réduit) et `jpeg-encoder` pour la génération native des miniatures.
  - `clipboard-rs` pour la gestion multiplateforme du presse-papiers natif.
  - `rusqlite` + `r2d2` pour le stockage local SQLite transactionnel en mode WAL.
- **Frontend** : JavaScript Vanilla (modules ES), HTML5 et CSS moderne avec Vite (zéro surcharge de framework).

---

## 🌍 Langues et internationalisation

Disponible en **Français** et en **Anglais**.

Les contributions sont bienvenues ! Choisissez un fichier JSON dans `src/locales/`, traduisez-le et proposez une pull request.

---

## ⛶ Captures d'écran

![Vue plein écran](/screenshots/fullscreen.jpg)
*Vue plein écran*

![Vue plein écran et notation](/screenshots/fullscreen-rating.jpg)
*Vue plein écran avec barre de notation*

![Miniatures seules](/screenshots/thumbnails-only.jpg)
*Grille de miniatures*

![Mode Comparer](/screenshots/compare.jpg)
*Mode Comparer et thème clair*

![Paramètres](/screenshots/settings.jpg)
*Modale des paramètres (organisation par onglets)*

---

## 📄 Licence

Projet distribué sous licence **MIT**. Voir le fichier `LICENSE` pour plus de détails.

</div>
