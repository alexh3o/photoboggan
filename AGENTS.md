# Instructions pour les Agents IA — photoboggan

> Ce fichier doit rester court (≈180 lignes max) : il est relu à chaque session. N'y mettre que ce qui ne se déduit pas du code.
> Réponses et interface en **français** (clés d'interface en anglais, voir §5.E).

---

## 1. Identité et Philosophie

* **Mission** : Visionneur/gestionnaire de photothèque de bureau ultra-rapide, léger et local.
* **Philosophie clé** :
  * **Zéro copie / In-Place** : Les dossiers sur disque sont la seule source de vérité.
  * **Performance brute & Réactivité** : Défilement virtuel fluide, lecture multithreadée, génération de miniatures optimisée, décodage RAW instantané via prévisualisation JPEG intégrée.
  * **Interopérabilité maximale** : Les métadonnées à écrire le sont dans les fichiers d'image (ou en sidecars `.xmp` standards pour les fichiers qui ne peuvent pas les contenir : RAW, PNG, HEIC, vidéos…), compatibles avec digiKam, Lightroom et l'Explorateur Windows.
  * **Multiplateforme** : Code portable (Windows et Linux distribués ; éviter tout ce qui bloquerait un autre OS).

---

## 2. Pile Technologique

* **Desktop Shell** : [Tauri v2](https://tauri.app/) (plugins `dialog`, `opener`).
* **Backend** : Rust (édition 2021), crates en Rust pur privilégiées (voir les commentaires de `Cargo.toml`).
  * Concurrence : `rayon` (parcours & EXIF parallèle), `tokio` (tâches asynchrones), `walkdir`.
  * Base locale : SQLite en mode WAL via `rusqlite` + pool `r2d2_sqlite`.
  * Images : `jpeg-decoder` (DCT réduit), `jpeg-encoder`, `png`, `image-webp` (lecture WebP, intégrité), `heic-rs` (HEIC/HEIF).
  * Métadonnées : `kamadak-exif` + analyseur binaire/XMP sur mesure.
  * Écriture des métadonnées : [ExifTool](https://exiftool.org) embarqué (processus externe, non versionné : `npm run fetch-exiftool`), ou écriture interne au choix (§5.D).
  * Système : `clipboard-rs` (presse-papiers), `trash` (corbeille), `windows` (cfg(windows) uniquement : vignettes vidéo du Shell).
* **Frontend** : **JavaScript Vanilla pur (ES Modules)**, HTML5, CSS3. Aucun framework. Bundler : [Vite](https://vitejs.dev/).

---

## 3. Fichiers Clés

```text
index.html              # Structure DOM complète (barre de titre, panneaux, modales)
TODO.md                 # Backlog fonctionnel (voir §4.12)
src/
  main.js               # Logique frontend principale (grille virtuelle, zoom, filtres, tri, file de tâches)
  photo-actions.js      # Menus contextuels, modales (infos, confirmation, redimensionnement)
  keywords-panel.js     # Panneau de droite à onglets Info / Mots-clés (arbre éditable, saisie, application différée)
  keywords.css          # Styles de ce panneau, de sa poignée de redimensionnement et de ses fenêtres
  metadata-settings.js  # Paramètres > Métadonnées : chemin d'écriture (ExifTool / interne), exécutable ExifTool
  styles.css            # Thèmes sombre/clair, mise en page en rem
  i18n.js               # Moteur de traduction (t, tp, labelWithColon)
  locales/en.json, fr.json
scripts/fetch-exiftool.mjs  # Télécharge ExifTool (version et SHA-256 figées) dans src-tauri/vendor/exiftool/
src-tauri/
  Cargo.toml, tauri.conf.json
  src/
    main.rs             # Commandes IPC, AppState, fenêtres
    db.rs               # SQLite (schéma, pools r2d2, index, pagination)
    exif.rs             # Lecture EXIF/IPTC/XMP, écriture XMP (APP1 JPEG / sidecar) et IPTC (JPEG)
    exiftool.rs         # Écriture via ExifTool : détection, processus persistants (-stay_open), mêmes cibles qu'exif.rs
    keywords.rs         # Arbre des mots-clés, association photo ↔ mot-clé, écriture / suppression / renommage dans les fichiers
    library_sync.rs     # Synchronisation incrémentale (taille + date de modification)
    thumbnails.rs       # Miniatures (DCT réduit), extraction des aperçus RAW
    resize.rs           # Redimensionnement par lot
    heif.rs             # HEIC / HEIF
    video.rs            # Vidéos : extraction d'une image fixe uniquement
    integrity.rs        # Vérification d'intégrité des fichiers
```

---

## 4. Règles d'Intervention

1. **Inspecter avant d'agir** : lire l'état actuel des fichiers concernés et leurs dépendances avant toute modification.
2. Identifier les **effets de bord** sur les fonctionnalités voisines.
3. **Modifications ciblées** : ne jamais remplacer un fichier entier pour une petite évolution.
4. **Respect des modifications utilisateur** : préserver textes, raccourcis et ajustements existants, ou demander confirmation.
5. **Sécurité Git et données** : jamais de `git reset --hard`, de checkout destructif, de restauration de fichier ni de suppression de fichiers ou de base sans demande explicite.
6. **Pas de framework** dans le frontend (React, Vue, jQuery, bibliothèques lourdes…).
7. **Dépendances** : ne pas en ajouter (ni tests) sans demande ou nécessité. Pour toute dépendance native ou réimplémentation de format, comparer compilation, distribution (Windows/Linux), maintenance, sécurité et performance, et justifier le choix.
8. **Portabilité** : pas d'appel spécifique à Windows (cmd.exe, PowerShell, registre…) sans équivalent Linux/macOS ; utiliser les API Tauri (`app.path()`, `PathBuf`).
9. **Lisibilité** : code facile à relire, commenté en français (utilité de chaque bloc, intention de l'utilisateur), ordonné logiquement.
10. **Comportement existant** : conserver l'interface en français et le comportement actuel, sauf demande contraire.
11. **Vérifications honnêtes** : lancer les commandes du §6 si l'agent a un terminal. Sinon (outils fichiers seuls), le dire clairement : la vérification se limite à la relecture du code, et l'agent liste les commandes à exécuter par l'utilisateur. Ne jamais présenter une vérification non faite comme réussie.
12. **TODO.md** : lors de la livraison d'un item du backlog, proposer de le cocher (ne pas réécrire le fichier).
13. **Résumé final** : fichiers modifiés, changements, vérifications faites, limites connues, tests manuels suggérés à l'utilisateur.
14. **Mise à jour de ce fichier** : après validation de l'utilisateur d'une décision d'architecture, d'un nouveau pattern ou d'une convention modifiée, proposer la modification de ce fichier (diff ciblé), sans le laisser grossir : retirer ce qui devient obsolète.

---

## 5. Directives par Domaine

### A. Frontend & CSS

- **rem** pour typographie, paddings, marges, boutons, icônes, modales.
- **px** impérativement pour : bordures et filets fins, ombres fines, et **tous les calculs de la grille virtuelle dans `main.js`** (clientWidth, offsetWidth, scrollTop, dimensions des photos) : au pixel près pour éviter tout interstice en vue justifiée.
- Barre latérale rétractable : largeur via `--sidebar-width` ou `style.removeProperty('width')`. Dans `.sidebar-section.hidden`, toujours `width: 0 !important; min-width: 0 !important;`.
- Panneau de droite (Info / Mots-clés) : largeur réglable par la poignée `#exif-resizer`, mémorisée (`exifPanelWidth`) ; masqué, `#exif-panel.hidden { width: 0 !important; }` (voir `keywords.css`).

### B. Grille de miniatures (invariants)

- **Taille d'affichage** réglable de 96 à 1024 px (curseur de la modale « Options d'affichage »), mémorisée localement.
- **Résolution du cache** de miniatures réglable dans les Paramètres (256, 512, 768 ou 1024 px max). Le cache conserve les proportions ; une miniature n'est pas affichée plus grande que sa taille réelle (sinon elle devient floue) : le plafond d'affichage se compte sur le plus grand côté.
- **Dispositions** : Carrées, Justifiées, Cascade (masonry).
- **Vue justifiée** : photos jamais recadrées, ratio largeur/hauteur conservé, lignes remplissant la largeur, aucune marge entre photos ; la dernière ligne n'est pas étirée.
- **Dimensions EXIF absentes en base** : le frontend apprend le ratio réel depuis l'image chargée et recalcule la disposition.
- **Notation** (0 à 5) : depuis la sélection et le plein écran, au clic ou au clavier ; en mode Comparer, elle vise la sous-sélection.

### C. Formats & RAW

- **Standards** : jpg, jpeg, png, webp, avif, gif, bmp, jfif, heic, heif. **RAW** : arw, cr2, cr3, nef, nrw, dng, raf, orf, rw2, raw. **Vidéos** : mp4, mov, avi, mkv (miniature fixe uniquement, ouverture dans le lecteur de l'OS, aucun moteur de lecture).
- **RAW** : ne jamais dématricer. Toujours extraire le JPEG intégré (`extract_raw_preview` dans `thumbnails.rs`). En plein écran, passer par `get_raw_preview_path` (le Webview ne lit pas les RAW).
- Les miniatures non gérées côté Rust (ex. PNG) retombent sur la génération du webview : ne pas casser ce repli.

### D. Métadonnées & Interopérabilité

- **Deux chemins d'écriture** (Paramètres > Métadonnées, `metadataWriter`) : **ExifTool** (défaut) ou **interne** (XMP + IPTC). Les mêmes champs sont écrits par les deux chemins ; seul ExifTool écrit en plus XPKeywords (JPEG). ExifTool introuvable : l'écriture est refusée, jamais de repli sur l'autre chemin. Ordre de recherche : chemin choisi (`exiftoolPath`) > version embarquée (ressource Tauri `exiftool/`) > PATH. Tout nouveau champ écrit (titre, description…) doit être ajouté aux deux chemins.
- **JPEG** : injection du paquet XMP dans le segment APP1 (`http://ns.adobe.com/xap/1.0/\0`), sans décompresser ni ré-échantillonner l'image.
- **RAW, PNG, HEIC, vidéos…** : écriture dans un sidecar `.xmp` (ex. `photo.cr2.xmp` ou `photo.xmp`).
- **Note** : `xmp:Rating` (0–5), `acdsee:rating`, `MicrosoftPhoto:Rating`. **Couleur** : `xmp:Label` (Red, Orange, Yellow, Green, Blue, Magenta, Grey, Black, White ou vide), `photoshop:Urgency`, `digikam:ColorLabel`.
- **Mots-clés hiérarchiques** (`keywords.rs`, `keywords-panel.js`) : l'arbre vit en base (`keyword_nodes`, `photo_keywords`) et grandit à la lecture des fichiers ; seul le dernier niveau d'un chemin est actif. À l'écriture (Appliquer, suppression, renommage), ce qui est actif remplace `dc:subject`, `digiKam:TagsList`, `lr:hierarchicalSubject`, `mediapro:CatalogSets`, `MicrosoftPhoto:LastKeywordXMP`, `acdsee:categories` (arbre XML en texte, `Assigned="1"` = actif) et l'IPTC 2:25 des JPEG ; XPKeywords est lu, et écrit seulement par ExifTool (JPEG, noms contenant `;` omis). Après écriture, le fichier est relu et la base reflète cette relecture. Noms interdits : `/`, `|`, `,`.
- **Priorité des formats hiérarchiques à la lecture** : XMP intégré avant sidecar ; puis, par défaut, digiKam `TagsList` > Lightroom `hierarchicalSubject` > Media Pro `CatalogSets` > Microsoft `LastKeywordXMP` > ACDSee `categories`. L'ordre des 5 formats est réglable par l'utilisateur (Paramètres > Métadonnées, liste ordonnable, mémorisée dans `keywordFormatOrder` et envoyée au backend au démarrage par `set_keyword_format_order`). Le premier format qui contient des données l'emporte : ses mots-clés sont ceux affichés dans l'interface et dans l'arbre, les autres sont ignorés. Un nouvel ordre ne s'applique qu'aux fichiers lus ensuite (relire la collection). Les formats à plat (`dc:subject`, IPTC, XPKeywords) ne modifient pas l'arbre.

### E. Tâches asynchrones (`TaskQueue`)

- Tout scan, rescan, vérification d'intégrité, copie, déplacement ou redimensionnement par lot passe par la file d'attente globale.
- Chaque tâche a un `task_id` unique (un toast par tâche, jamais de mélange de nom/progression).
- Toute action longue est listée dans la modale « Sablier » avec annulation propre (`cancel`).
- Les écritures de mots-clés (application, suppression, renommage) passent par la file à partir de 20 photos (famille `keywords`, qui ne bloque pas les scans) ; « Appliquer » est grisé tant qu'une écriture est en cours. En dessous, commande directe.
- Ne jamais bloquer le thread principal : opérations disque lourdes dans `spawn_blocking` ou `rayon`.

### F. Internationalisation

- Tout nouveau texte : clé anglaise dans `src/locales/en.json` **et** traduction dans `src/locales/fr.json`.
- `labelWithColon('Key')` pour l'espace insécable avant « : » en français ; `tp('Key', count, params)` pour les pluriels (forme `Key|other`) ; attributs HTML `data-i18n`, `data-i18n-title`, `data-i18n-aria-label`.

### G. Fenêtre & persistance

- État de la fenêtre (x, y, taille, maximisée) et des panneaux mémorisé. À la restauration, toujours appeler `check_window_visibility` ; si l'écran a disparu, recentrer en 1024×768 sur l'écran principal.
- Fermeture : `onCloseRequested` (`main.js`) demande confirmation si des mots-clés ne sont pas écrits ou si une écriture est en cours ; elle requiert la permission `core:window:allow-destroy` (`capabilities/default.json`).

### H. Protection des Photos

- Ne jamais toucher aux données image d'un fichier : seules les métadonnées changent. Préserver les métadonnées non concernées.
- Toute modification passe par un fichier temporaire, puis remplacement de l'original une fois l'écriture réussie : jamais de fichier partiellement écrit.
  ExifTool : toujours `-overwrite_original` (jamais `_in_place`) ; après un échec, supprimer le `<fichier>_exiftool_tmp` qu'il laisse.
- Pas d'écritures concurrentes sur un même fichier ; prévoir une sauvegarde/restauration pour les opérations potentiellement destructrices.
- Un échec d'écriture de métadonnées n'est jamais présenté comme un succès.

---

## 6. Commandes

```bash
npm run tauri dev                 # Application complète en développement
cd src-tauri && cargo check       # Vérification rapide du Rust
npm run build                     # Build du frontend (Vite)
npm run fetch-exiftool            # Télécharge ExifTool embarqué (lancé aussi avant tauri dev / tauri build)
npm run tauri build               # Build de production
```

---

## 7. Anti-Patterns

- ❌ Casser le mode WAL de SQLite (`PRAGMA journal_mode=WAL`) ou accéder à la base hors du pool r2d2.
- ❌ Provoquer des reflows dans la grille : ne pas changer width/height des miniatures sélectionnées ; utiliser `transform: scale(...)` et `outline`.
- ❌ Balises HTML obsolètes (`<font>`…) ou styles en ligne non protégés par des guillemets.
- ❌ Bloquer le thread principal Rust (WalkDir, EXIF, copie, redimensionnement hors thread dédié).
