# Instructions pour les Agents IA — photoboggan

> Ce fichier doit rester court (≈120 lignes) : il est relu à chaque session. Il ne contient que les règles ; le détail (flux, noms de fonctions, champs écrits, pièges) est dans la documentation technique `docs/development/`.
> Réponses à l'utilisateur et interface en **français** (clés d'interface en anglais, voir §5.F). **Documentation, commentaires de code et messages de commit en anglais** (voir §4.9).

---

## 1. Identité et Philosophie

* **Mission** : Visionneur/gestionnaire de photothèque de bureau ultra-rapide, léger et local.
* **Zéro copie / In-Place** : les dossiers sur disque sont la seule source de vérité ; catalogue et caches sont reconstructibles.
* **Performance** : défilement virtuel, lecture multithreadée, miniatures en DCT réduit, RAW via l'aperçu JPEG intégré.
* **Interopérabilité** : les métadonnées sont écrites dans les fichiers (ou en sidecars `.xmp` standards pour RAW, PNG, vidéos…), compatibles digiKam, Lightroom et l'Explorateur Windows.
* **Multiplateforme** : Windows et Linux distribués ; rien qui bloquerait un autre OS.
* **Hors ligne possible** : aucune ressource chargée depuis Internet (polices, scripts… embarqués). Tout accès réseau part du backend, vérifie `internet_allowed()` (`face_models.rs`) et renvoie `internet_disabled` en mode hors ligne. Seule exception : les tuiles de carte, via le protocole `pbmap://` (`map-tile-protocol.js`, seul code autorisé à joindre `tiles.openfreemap.org`, aussi dans la CSP `connect-src`), sous condition de `isMapNetworkAllowed()`. Tout nouvel accès réseau suit la même règle et est mentionné dans l'infobulle « Mode hors ligne ».

## 2. Pile Technologique

* **Tauri v2** (plugins `dialog`, `opener`, `single-instance`). **Backend Rust** (édition 2021), crates en Rust pur privilégiées (voir `Cargo.toml`) ; SQLite en WAL via `rusqlite` + pool `r2d2`. **ExifTool** embarqué, non versionné (`npm run fetch-exiftool`).
* **Frontend** : **JavaScript Vanilla (ES Modules)**, HTML5, CSS3, bundler Vite. Aucun framework.

## 3. Documentation technique

* Point d'entrée : `docs/development/README.md` (table « Where to look »). Pour une modification, lire **seulement** le doc du module concerné (`docs/development/modules/<module>.md`), les lignes utiles des tables `docs/development/generated/` (chercher par nom, ne jamais les charger en entier), puis les fichiers de code qu'il cite. Règles transverses : `invariants.md` ; marches à suivre : `recipes.md` ; où est quoi : `code-map.md`.
* **Mise à jour avec le code, dans le même commit** : après une modification de code, lancer `npm run docs:gen` puis `npm run docs:stale` ; pour chaque doc signalé, lire le diff de ses sources et corriger seulement la section touchée (souvent rien), puis `node scripts/gen-docs.mjs --stamp <doc>`. Ne jamais tamponner un doc non vérifié. Une commande, un réglage, une table ou un test ajoutés n'exigent que `docs:gen` ; un doc écrit à la main change seulement si un flux, un invariant ou une recette change.
* `TODO.md` : backlog de l'utilisateur (voir §4.12).

## 4. Règles d'Intervention

1. **Inspecter avant d'agir** : lire l'état actuel des fichiers concernés et leurs dépendances avant toute modification.
2. Identifier les **effets de bord** sur les fonctionnalités voisines.
3. **Modifications ciblées** : ne jamais remplacer un fichier entier pour une petite évolution.
4. **Respect des modifications utilisateur** : préserver textes, raccourcis et ajustements existants, ou demander confirmation.
5. **Sécurité Git et données** : jamais de `git reset --hard`, de checkout destructif, de restauration de fichier ni de suppression de fichiers ou de base sans demande explicite.
6. **Pas de framework** dans le frontend (React, Vue, jQuery, bibliothèques lourdes…).
7. **Dépendances** : ne pas en ajouter sans demande ou nécessité (les tests ont `tempfile` en `[dev-dependencies]`, rien d'autre). Pour toute dépendance native ou réimplémentation de format, comparer compilation, distribution (Windows/Linux), maintenance, sécurité et performance, et justifier le choix.
8. **Portabilité** : pas d'appel spécifique à Windows (cmd.exe, PowerShell, registre…) sans équivalent Linux/macOS ; utiliser les API Tauri (`app.path()`, `PathBuf`).
9. **Lisibilité** : code facile à relire, ordonné logiquement, commenté **en anglais** (utilité de chaque bloc, intention de l'utilisateur). Toute documentation et tout message de commit sont aussi en anglais. Les commentaires français existants ne sont pas traduits en masse : les traduire quand on modifie le code concerné.
10. **Comportement existant** : conserver l'interface en français et le comportement actuel, sauf demande contraire.
11. **Vérifications honnêtes** : lancer les commandes du §6 (dont `cargo test`) si l'agent a un terminal. Sinon, le dire clairement : la vérification se limite à la relecture du code, et l'agent liste les commandes à exécuter par l'utilisateur. Ne jamais présenter une vérification non faite comme réussie.
12. **TODO.md** : lors de la livraison d'un item du backlog, proposer de le cocher (ne pas réécrire le fichier).
13. **Résumé final** : fichiers modifiés, changements, vérifications faites, limites connues, tests manuels suggérés à l'utilisateur.
14. **Mise à jour de ce fichier** : après validation de l'utilisateur d'une décision d'architecture, d'un nouveau pattern ou d'une convention modifiée, proposer la modification de ce fichier (diff ciblé), sans le laisser grossir : un détail va dans `docs/development/`, pas ici.

## 5. Règles par Domaine

### A. Frontend, CSS, grille
- **rem** pour typographie, espacements, boutons, icônes, modales ; **px** seulement pour les filets et ombres fines et **tous les calculs de la grille virtuelle** de `main.js` (au pixel près, sinon interstices en vue justifiée). Détails : `style.md`, `modules/grid-and-viewer.md`.
- Panneaux masqués : `.sidebar-section.hidden` et `#exif-panel.hidden` gardent `width: 0 !important` (et `min-width: 0` pour la barre latérale).
- Vue justifiée : photos jamais recadrées, ratio conservé, aucune marge, dernière ligne non étirée. Une miniature n'est jamais affichée plus grande que sa taille réelle (plafond sur le plus grand côté).
- **Cache des miniatures** : 256 sous-dossiers (`<2 car. du hash>/<hash>.jpg`). Chemin toujours par `thumbnail_cache_file` / `raw_preview_cache_file`, liste par `cache_files` (jamais `read_dir` à plat), dossier parent créé avant écriture. Changer le contenu d'une miniature impose d'incrémenter `PREVIEW_VERSION`. Résolution 512 px minimum (la détection des visages lit ces miniatures).

### B. Formats
- **RAW** : ne jamais dématricer ; toujours l'aperçu JPEG intégré (`extract_raw_preview`), plein écran par `get_raw_preview_path`. **Vidéos** : image fixe uniquement, lecture dans le lecteur de l'OS.
- Les miniatures non gérées côté Rust (ex. PNG) retombent sur la génération du webview : ne pas casser ce repli.
- Ajouter un format : les listes d'extensions sont multiples (`recipes.md` §4).

### C. Métadonnées
- **Deux chemins d'écriture** (`metadataWriter`) : **ExifTool** (défaut) ou **interne**. Mêmes champs dans les deux ; tout nouveau champ écrit va dans les deux et dans la relecture de vérification (`recipes.md` §3). ExifTool introuvable : écriture refusée, **jamais de repli** sur l'autre chemin.
- **Cibles** : JPEG et HEIC/HEIF dans le fichier ; le reste dans un sidecar. Les noms de sidecars ne sont construits que par `sidecar_target` / `read_sidecar` / `sidecar_candidates` ; un `photo.xmp` partagé avec une autre image n'est jamais écrit ; une image ne lit qu'un sidecar. Champs écrits et règles : `modules/metadata-read-write.md`, `invariants.md` §2.
- **Priorités de lecture** réglables (`set_metadata_read_order`) : la première source qui a une donnée l'emporte, une valeur 0 est une réponse ; un nouvel ordre ne vaut que pour les fichiers relus.
- **Mots-clés** : seul le dernier niveau d'un chemin est actif ; noms interdits `/`, `|`, `,`. Après toute écriture, le fichier est relu et la base reflète la relecture.
- **Rotation sans perte** : seule la balise d'orientation change ; HEIC/HEIF et vidéos exclus ; ce que la WebView n'applique pas passe par `view_fix`.

### D. Protection des Photos
- Ne jamais toucher aux données image : seules les métadonnées changent ; préserver les métadonnées non concernées.
- Toute modification passe par un fichier temporaire puis un remplacement : jamais de fichier partiellement écrit. ExifTool : toujours `-overwrite_original` (jamais `_in_place`) ; après un échec, ne supprimer `<fichier>_exiftool_tmp` **que si l'original existe encore** (sinon c'est la seule copie : `recover_after_failure`).
- Pas d'écritures concurrentes sur un même fichier (`exiftool::path_lock`). Un échec d'écriture n'est jamais présenté comme un succès.

### E. Tâches longues
- Tout scan, vérification, copie, déplacement, redimensionnement, téléchargement, recherche de doublons ou analyse passe par la file de `main.js` (`enqueueScanTask`, injectée aux modules en `enqueueTask`), avec `task_id` unique, progression `scan-progress` et annulation (`scan_cancel_flag` / `release_scan_cancel_flag`). Écritures de mots-clés : file à partir de 20 photos. Détails : `modules/main-window.md`.
- Ne jamais bloquer le thread principal : travail lourd dans `spawn_blocking` ou `rayon`, jamais dans un `#[tauri::command] fn` synchrone.

### F. Internationalisation
- Tout nouveau texte : clé anglaise dans `src/locales/en.json` **et** traduction dans `fr.json`. `labelWithColon('Key')` pour « : » en français, `tp('Key', count)` pour les pluriels (`Key|other`), attributs `data-i18n*`.

### G. Réglages, fenêtre
- Tout nouveau réglage mémorisé en `localStorage` a son défaut dans `src/defaults.jsonc` (commentaires en ligne entière seulement) ; jamais de défaut codé en dur. Le backend lit `faceSettings` (`face_detect.rs`) et `thumbnailCacheSize` (`main.rs`) du même fichier. Un réglage du backend gardé en statique Rust est renvoyé par le frontend **au démarrage** et à chaque changement (`configuration.md`).
- Restauration de la fenêtre : toujours `check_window_visibility` ; écran disparu → 1024×768 centré. Fermeture (`onCloseRequested`) : confirmation si des écritures sont en attente ou en cours (permission `core:window:allow-destroy`).

### H. Tests
- Backend Rust uniquement : `#[cfg(test)] #[path = "tests/<module>.rs"] mod tests;` en fin de module, code dans `src-tauri/src/tests/`. Fichiers synthétiques dans un `tempfile` (`test_support.rs`) : jamais de vraie photo, de réseau ni de modèle.
- Tout correctif sur l'écriture de métadonnées, la base ou la synchronisation s'accompagne d'un test qui l'aurait attrapé. Les tests d'écriture interne appellent les fonctions internes (`write_jpeg_metadata`, `write_xmp_sidecar_with`…).
- Test lent ou dépendant d'ExifTool : `#[ignore = "raison"]`. Un test ignoré qui échoue documente un écart connu : le dire, ne pas affaiblir l'assertion. État global (`sync_library`, réglages ExifTool) : un seul test par scénario. Détails : `testing.md`.

### I. Fonctions optionnelles et sensibles
- **Mises à jour** (`modules/updates.md`) : source unique, les releases GitHub du dépôt ; l'interface ne fournit jamais d'adresse ni de chemin ; SHA-256 publié exigé, vérifié au téléchargement et avant le lancement. La release garde un `.msi` et un `.deb`.
- **Doublons** (`modules/duplicates.md`) : changer les octets hachés impose `LAYOUT_VERSION` + 1 (idem `ALGO_VERSION` du pHash) ; jamais d'écriture dans le cache de miniatures ; zéro impact au repos ; la grille ne change jamais sans clic.
- **Recherche par contenu** (`modules/semantic.md`) : invisible et sans aucune IPC si désactivée ; données dérivées uniquement ; **accepter une suggestion = `addPendingKeyword`**, jamais d'écriture sans « Appliquer » ; tout appel asynchrone ignore une réponse périmée (compteur de requêtes) ; modèle et ONNX Runtime jamais dans l'installeur.
- **Zones privées** (`modules/private-zones.md`) : une tuile qui touche une zone privée ne vient jamais du fournisseur.

## 6. Commandes

```bash
npm run tauri dev                 # Application complète en développement
cd src-tauri && cargo check       # Vérification rapide du Rust
cd src-tauri && cargo test        # Tests rapides ; la CI les lance (tests.yml)
cd src-tauri && cargo test exiftool:: -- --ignored --test-threads=1   # Intégration ExifTool
npm run docs:gen                  # Régénère docs/development/generated/
npm run docs:stale                # Docs à revoir après une modification
npm run build                     # Build du frontend (Vite)
npm run tauri build               # Build de production
```

## 7. Anti-Patterns

- ❌ Casser le mode WAL de SQLite ou accéder à la base hors du pool r2d2 (toujours `state.pool()`, jamais gardé).
- ❌ Provoquer des reflows dans la grille : ne pas changer width/height des miniatures sélectionnées ; utiliser `transform: scale(...)` et `outline`.
- ❌ Balises HTML obsolètes (`<font>`…) ou styles en ligne non protégés par des guillemets.
- ❌ Bloquer le thread principal Rust (WalkDir, EXIF, copie, redimensionnement hors thread dédié).
