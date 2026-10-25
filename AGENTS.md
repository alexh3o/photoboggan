# Instructions pour les Agents IA — photoboggan

> Ce fichier doit rester court (≈150 lignes max) : il est relu à chaque session. N'y mettre que ce qui ne se déduit pas du code.
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
  styles.css            # Thèmes sombre/clair, mise en page en rem
  i18n.js               # Moteur de traduction (t, tp, labelWithColon)
  locales/en.json, fr.json
src-tauri/
  Cargo.toml, tauri.conf.json
  src/
    main.rs             # Commandes IPC, AppState, fenêtres
    db.rs               # SQLite (schéma, pools r2d2, index, pagination)
    exif.rs             # Lecture EXIF/IPTC/XMP, écriture XMP (APP1 JPEG / sidecar)
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

- **JPEG** : injection du paquet XMP dans le segment APP1 (`http://ns.adobe.com/xap/1.0/\0`), sans décompresser ni ré-échantillonner l'image.
- **RAW, PNG, HEIC, vidéos…** : écriture dans un sidecar `.xmp` (ex. `photo.cr2.xmp` ou `photo.xmp`).
- **Note** : `xmp:Rating` (0–5), `acdsee:rating`, `MicrosoftPhoto:Rating`. **Couleur** : `xmp:Label` (Red, Orange, Yellow, Green, Blue, Magenta, Grey, Black, White ou vide), `photoshop:Urgency`, `digikam:ColorLabel`.

### E. Tâches asynchrones (`TaskQueue`)

- Tout scan, rescan, vérification d'intégrité, copie, déplacement ou redimensionnement par lot passe par la file d'attente globale.
- Chaque tâche a un `task_id` unique (un toast par tâche, jamais de mélange de nom/progression).
- Toute action longue est listée dans la modale « Sablier » avec annulation propre (`cancel`).
- Ne jamais bloquer le thread principal : opérations disque lourdes dans `spawn_blocking` ou `rayon`.

### F. Internationalisation

- Tout nouveau texte : clé anglaise dans `src/locales/en.json` **et** traduction dans `src/locales/fr.json`.
- `labelWithColon('Key')` pour l'espace insécable avant « : » en français ; `tp('Key', count, params)` pour les pluriels (forme `Key|other`) ; attributs HTML `data-i18n`, `data-i18n-title`, `data-i18n-aria-label`.

### G. Fenêtre & persistance

- État de la fenêtre (x, y, taille, maximisée) et des panneaux mémorisé. À la restauration, toujours appeler `check_window_visibility` ; si l'écran a disparu, recentrer en 1024×768 sur l'écran principal.

### H. Protection des Photos

- Ne jamais toucher aux données image d'un fichier : seules les métadonnées changent. Préserver les métadonnées non concernées.
- Toute modification passe par un fichier temporaire, puis remplacement de l'original une fois l'écriture réussie : jamais de fichier partiellement écrit.
- Pas d'écritures concurrentes sur un même fichier ; prévoir une sauvegarde/restauration pour les opérations potentiellement destructrices.
- Un échec d'écriture de métadonnées n'est jamais présenté comme un succès.

---

## 6. Commandes

```bash
npm run tauri dev                 # Application complète en développement
cd src-tauri && cargo check       # Vérification rapide du Rust
npm run build                     # Build du frontend (Vite)
npm run tauri build               # Build de production
```

---

## 7. Anti-Patterns

- ❌ Casser le mode WAL de SQLite (`PRAGMA journal_mode=WAL`) ou accéder à la base hors du pool r2d2.
- ❌ Provoquer des reflows dans la grille : ne pas changer width/height des miniatures sélectionnées ; utiliser `transform: scale(...)` et `outline`.
- ❌ Balises HTML obsolètes (`<font>`…) ou styles en ligne non protégés par des guillemets.
- ❌ Bloquer le thread principal Rust (WalkDir, EXIF, copie, redimensionnement hors thread dédié).
