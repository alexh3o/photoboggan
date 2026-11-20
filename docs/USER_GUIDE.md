# Photoboggan User Guide

Photoboggan is a fast, lightweight photo browser and organizer for your computer. It works directly on the folders you already have: no import, no copy, no proprietary library. Rate, color-label, pick or reject, keyword, compare and filter your photos, and everything you add is stored in the standard way, so other programs (digiKam, Lightroom, Windows Explorer…) see it too.

> **Beta software.** Always keep a complete backup of your photos.

## Contents

1. [Getting started](#1-getting-started)
2. [Interface overview](#2-interface-overview)
3. [Browsing and finding photos](#3-browsing-and-finding-photos)
4. [Organizing photos](#4-organizing-photos)
5. [Keywords, titles, author and metadata](#5-keywords-titles-author-and-metadata)
6. [File safety](#6-file-safety)
7. [People and face recognition](#7-people-and-face-recognition)
8. [Maps, geolocation and private zones](#8-maps-geolocation-and-private-zones)
9. [Private photos](#9-private-photos)
10. [Collection statistics](#10-collection-statistics)
11. [Settings](#11-settings)
12. [Keyboard shortcuts](#12-keyboard-shortcuts)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Getting started

### Install

Download the installer for your system from the project's [Releases page](https://github.com/alexh3o/photoboggan/releases).

- **Windows:** run the installer. Windows may warn that the publisher is unknown; choose *More info* then *Run anyway*.
- **Linux (Debian/Ubuntu):** install the `.deb` package (`sudo dpkg -i photoboggan_*.deb`, then `sudo apt-get install -f` if dependencies are missing). Linux support is less tested than Windows.

### First launch

#### 1. Useful first settings

Before scanning a large collection, open ⚙️**Settings** and review a few key options:

- **General:**
  - Choose the **Language** (English or French) and whether **At startup, show** opens **All photos** or the **Last opened folder**.
  - Enable **Offline mode** if you want Photoboggan to never connect to the Internet (models must then be installed manually from a folder, and online map tiles are disabled).
- **Storage:**
  - Check **Application data location** first if you want the database, thumbnails, and AI models on a fast SSD rather than the default folder.
  - Review **Thumbnail cache size** (1024 px by default, the largest available — recommended for clearer crops in the Faces review, though 512 or 768 px saves disk space; changing it later clears existing thumbnails) and **Thumbnail quality** (*Normal* is enough in most cases).
- **Optional features (disabled by default):**
  - **Maps:** Enable the map if desired, and optionally define your home or sensitive areas in **Maps > Offline / private zones** before browsing geotagged photos so remote map requests are never sent for those coordinates.
  - **Faces:** Enable **Enable face detection and recognition**, then click **Download** (~56 MB on Windows; Windows/Linux 64-bit) or install from a folder if offline.
  - **Search:** Enable **Content search** and click **Download** (~785 MB) or install from a folder if offline.
- **Metadata:**
  - Check **Reading priority** if your photos may contain conflicting metadata across formats (EXIF, IPTC, XMP, digiKam, Lightroom…), as changing this later requires rescanning the collection.
  - Enable **Pick / reject flags** under **Labels** if you plan to use them (they are off by default).

#### 2. Add photo folders to the collection

Tell Photoboggan where your photos live by adding one or more root folders (subfolders are included automatically). On a large collection, consider testing with a smaller folder first to confirm your settings.

1. Open ⚙️**Settings > General > Library**.
2. Click **+ Add folder** and pick a folder containing photos. Photoboggan queues a scan and displays the photos once done.
3. Repeat for any other root folders. Progress is shown in **Running tasks** (hourglass icon).

The initial scan reads every photo and its metadata, so it can take a few hours on very large collections. It can be **paused** and resumed at any time (including across restarts); already-scanned photos are kept.

#### 3. Feature scans (optional)

Once your folders are indexed, you can prepare the optional features by launching their scans. Scans can be queued; note that **Analyse content** runs at low priority in its own queue and automatically pauses while folder, face, or duplicate scans are running:

- **Faces:** Right-click a root folder > **Faces > Detect and recognize faces (unscanned photos)**, then click **Start**. It uses cached thumbnails (generating missing ones). If you stop it and resume later, choose **(unscanned photos)** so already-scanned photos are skipped.
- **Content search:** Right-click **All photos** (or a folder) > **Find > Analyse content**, or use **Analyse the whole library** in ⚙️**Settings > Search**. You can stop it at any time; already-analysed photos are skipped when you run it again.
- **Similar photos (pHash):** Right-click **All photos** (top of the Folders tree) > **Find duplicates > Similar** to compute the perceptual hash (`pHash`) of every photo across the collection. This initial pass takes time (it is faster if thumbnails are already cached) but is kept afterwards so future similarity searches are much faster.

### Supported files

| Type   | Formats                                                |
| ------ | ------------------------------------------------------ |
| Images | JPG, JPEG, JFIF, PNG, WebP, AVIF, GIF, BMP, HEIC, HEIF |
| RAW    | ARW, CR2, CR3, NEF, NRW, DNG, RAF, ORF, RW2, RAW, PEF  |
| Videos | MP4, MOV, AVI, MKV                                     |

- **RAW files** are never developed. Photoboggan shows the JPEG preview embedded in the file by the camera, which is quick but can be lower resolution than the real photo. To open them, set an application of your choice in ⚙️ Settings / Applications / RAW: shortcut O will use the first app in your list.
- **Videos** show a still thumbnail only. Double-click opens the video in your system's default player. Thumbnails come from Windows' own thumbnailer, or from `ffmpeg` if it is installed.

---

## 2. Interface overview

| Area            | Toggle<br>Shortcut | What it does                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Top bar**     | `T`                | Toggles for the **Filters** panel, <img src="https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/scan-face.svg" width="20" height="20" alt="scan-face" /> **People** view, **Preview** and **Info** panels<br/>**Compare** mode<br/>Buttons for **Settings**, **Running tasks**, **Display** (grid, layout, appearance...) and **Sort**. |
| **Left panel**  | `N`                | **Folders** tree<br/>**Albums**<br/>**People** list (if face reading is on)<br/>**Filters**<br/>**Selection** box (rating and color of the selected photos).                                                                                                                                                                                 |
| **Center**      |                    | The thumbnail grid.                                                                                                                                                                                                                                                                                                                          |
| **Preview**     | `P`                | Larger view of the selected photo(s).                                                                                                                                                                                                                                                                                                        |
| **Right panel** | `I`/`K`/`D`        | Three tabs: **Info** (file and camera data, author and rights, location map, histogram), **Keywords**, **Description** (title, description, author and rights).                                                                                                                                                                              |

Panels can be shown or hidden (see [shortcuts](#12-keyboard-shortcuts)) and resized by dragging their edges. Press `F11` for immersive mode, which hides the title bar and taskbar.

**Toolbar:** right-click the top bar for more options — immersive mode, **auto-hide** (the bar reappears when the pointer reaches the top of the window; shortcut `T`), **show all labels**, and panel toggles.

**Quick search in the sidebar:** the **Folders**, **Albums** and **People** blocks each have a magnifier in their title row (shown on hover). It filters the list live as you type, keeping the ancestors of matching entries, and never changes your selection or the fold state of the tree.

---

## 3. Browsing and finding photos

### Viewing

- Click a folder to see its photos. Turn **Include subfolders** on or off in **Display**. The **fold** button next to the **Folders** title folds or unfolds the whole tree, and root folders are shown differently from their subfolders.
- **Click** a thumbnail to select it and see it in the preview. **Double-click** (or press `F`) for fullscreen.
- In the grid, `←` / `→` select the previous/next photo and `↑` / `↓` the photo above/below (any layout).
- In preview and fullscreen: `←` / `→` for previous/next, `+` / `-` to zoom, `*` to switch between actual size and fit-to-window. `Ctrl`+mouse wheel also zooms; in fullscreen, holding `Z` and turning the wheel zooms while keeping the point under the cursor centred. Panning is gradual and can be combined with zooming at any time.
- Fullscreen extras: `D` shows photo info, `R` shows a rating bar, and `V` cycles the face frames (on hover, always, hidden).
- **Histogram:** `H` cycles *off*, *displayed* and *displayed with clippings* (clipped shadows and highlights are colored on the image). It shows at the bottom right of the grid, the preview or fullscreen. For RAW files it is computed from the embedded JPEG preview. The clipping range is set in **Display**.
- **Slideshow:** `F10` starts or stops it (on the selection if it has 2 photos or more, otherwise on the whole view); `Space` pauses and resumes. Delay, **Loop** and **Random order** are in **Settings > Misc > Slideshow**.
- **Show in its own folder:** in *All photos*, albums, search results and other whole-collection views, the photo's context menu jumps to the folder that contains it.
- Scrolling the grid with the mouse wheel is fast and fluid, and a scroll position indicator helps you find your way in long lists.

### Selecting

- `Ctrl`+click adds or removes a photo. `Shift`+click selects from the last click. They can be combined several times and in any direction for one selection.
- `Ctrl`+`A` selects all.
- **Deselect all** is the cross button in the Selection box.

### Display and sorting

**Display** (grid icon):

- **Thumbnails grid:** *Square*, *Framed*, *Justified* (full rows, no cropping) or *Waterfall* (masonry).
- **Thumbnail spacing** and **Size** (96 to 1024 px).
- **Theme** (*Dark* / *Light*), **Text size**, **Selection color**, **Active Buttons color**, and **Dim unselected photos on hover**.
- **Interface font**: choose the font used by the interface.

**Sort** (arrows icon): by **Date taken**, **Date modified** or **Filename**, ascending or descending, with optional separators (by day, week, month, year, or by folder when sorting by name).

### Filters

Filters are in the left panel and **combine with each other**. The grid shows the number of matching photos; the cross button next to **Filters** clears everything.

| Filter                | How it works                                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ratings & Colors**  | Five clickable stars (click the active star again to clear), a *∅* chip for unrated photos, a *≥ / =* toggle (at least / exactly N stars), plus one or more color labels (a photo matches any selected color) and, if enabled, pick / reject flags. |
| **Keywords (&)**      | Choose keywords; photos must have **all** of them. Ctrl+click a keyword in the Keywords tab to add it to the filter.                                                                                                                                |
| **Filename**          | Type text (3 characters minimum) and press Enter. Several words must **all** appear in the name.                                                                                                                                                    |
| **People (&)**        | Choose people; photos must show **all** of them. Only available when face reading is on.                                                                                                                                                            |
| **Camera / Lens**     | Choose a camera or a lens from the suggestions.                                                                                                                                                                                                     |
| **Shooting settings** | Shutter speed, ISO, aperture, focal length and flash.                                                                                                                                                                                               |
| **File format**       | File format and type (image, RAW, video).                                                                                                                                                                                                           |
| **Author**            | Choose one or more authors from the suggestions; several included authors must **all** appear in the photo.                                                                                                                                         |
| **Date taken**        | Type a date or range, or use the calendar button.                                                                                                                                                                                                   |

**Date filter examples** (formats `YYYY`, `YYYYMM`, `YYYYMMDD`, `YYYYMMDDHH`, `YYYYMMDDHHmm`):

- `2024` → the whole year 2024
- `20241225` → 25 December 2024
- `2024-20250630` → from the start of 2024 to the end of 30 June 2025

**Excluding values:** keywords, people, camera, lens, author and format can also be *excluded*: choose **Exclude** before picking the value, or `Alt`+`click` a chip or a keyword. `Ctrl`+`click` adds a value to the filter. On large folders, filters are applied **before** the 50,000-photo display limit, so every matching photo is found.

### Finding duplicates, similar photos and RAW files

Right-click a photo, a selection or a folder > **Find** (or **Find duplicates**). Nothing runs until you start a search, and the grid never changes until you click **Show** on the result.

- **Identical photos:** same image data, whatever the metadata (same file name can also be used as a criterion). **More…** opens the settings.
- **Similar images:** resized, recompressed or lightly edited copies, optionally rotated or mirrored; *strict*, *normal* or *loose* tolerance. Bursts can be ignored.
- **Result view:** photos appear in groups. Sort the groups, set the order of the **keep** criteria (resolution, size, rating, date, name, path), then **Select all but the best**. This only selects: deleting is the normal **Delete** (trash and confirmation). Navigating elsewhere ends the result view.
- **Find the RAW** (image context menu): locates the RAW file of a JPEG using the criteria of **Settings > Search > RAW search** (file name pattern, date and time, camera and lens, shooting settings, where to search from).

### Content search

An optional feature (**Settings > Search**, off by default) lets you analyse photos with a local AI model (SigLIP 2) so you can search them by what they show. Everything runs on your computer, and the search never writes to your photos.

1. In **Settings > Search**, enable it and download the model (about 785 MB), or use **Install from a folder…** in offline mode.
2. Right-click a photo, folder or selection > **Find** > **Analyse content** (or **Analyse the whole library** in the settings). The analysis runs in the background at low priority, pauses while other tasks run, and only re-analyses photos whose pixels changed. RAW files can be left out, and the analysis can create missing thumbnails. The first analysis of a large library can take a few hours.
3. Use the toolbar search box: describe a scene (e.g. *beach at sunset*) or type a keyword, then press `Enter`. The **View / Library** toggle chooses the search scope and the **Relevance** slider keeps more or fewer results. Photos already tagged with the keyword come first; results can show a score.
4. Right-click an analysed photo > **Find** > **Similar content** to find photos of the same subject or scene.

**Keyword help.** In the Keywords tab, *Suggestions* lists up to 5 keywords that may suit the selected photo, and **Find photos that may match** on a keyword lists photos that look like those already tagged with it. The keyword filter can include suggested photos (badge **Suggested**). Accepting a suggestion only adds a *pending* keyword: nothing is written until **Write to files**. Rejected suggestions are remembered and not offered again. **Keywords never suggested** (Settings > Search) excludes keywords and their children.

### Map and location

See [section 8](#8-maps-geolocation-and-private-zones). Optional (**Settings > Maps**). The Info panel shows the shooting place on a small map, and **Map** mode shows the photos on a larger one, with a filter on the visible area.

---

## 4. Organizing photos

### Rating, color labels and pick flags

- **Rating:** keys `0`–`5` (`0` removes it), the Selection box, or the stars in fullscreen.
- **Color labels:** keys `6` (red), `7` (yellow), `8` (green), `9` (blue); pressing the same key again removes it. More colors (orange, magenta, grey, black, white) are available in the Selection box and filters.
- **Pick / reject flags:** `Shift`+`P` picks, `Shift`+`X` rejects; pressing the same key again removes the flag. Photos carry a small square on their thumbnail (green: picked, red: rejected, yellow: pending; nothing when unflagged). In the Selection box and the floating bar, a single flag icon shows the current flag by its color (white: none, yellow: pending, green: picked, red: rejected); in the bar it unfolds to let you choose.
  - The choices offered follow the format ranked first under **Settings > Metadata > Reading priority > Pick**: *digiKam* (`digiKam:PickLabel`): none, pending, picked, rejected; *Adobe Lightroom* (`xmpDM:pick`) or *Adobe XMP* (`xmpDM:good`): none, picked, rejected. Whatever the order, all three fields are written.
  - The **Ratings & Colors** filter has a matching *Pick* row (picked, rejected, pending, no flag).
- `Alt` + a rating/color key applies it and moves to the next photo, for fast culling.

**Settings > Metadata > Labels** lets you turn **color labels** and **pick / reject flags** on or off. Pick flags are **off by default**. A turned-off feature is still read from the files but is no longer shown (filters, indicators, buttons) or modified (shortcuts ignored); `Shift`+`P` and `Shift`+`X` then keep their usual meaning. Rescan the collection to load the flags of photos already cataloged.

Ratings, colors and flags are written to your files right away (see [File safety](#6-file-safety)). You can also **cancel** a rating, color or flag, and `Ctrl`+`Z` undoes the latest rating, color, flag, rotation or batch rename (up to 20 changes back).

### Albums

The **Albums** block in the left panel organizes photos without touching files:

- **Virtual folders** organize albums into a tree.
- **Manual albums** are hand-picked photos.
- **Smart albums** are saved filters, updated automatically. Save a smart album's filters with its save icon.
- **Smart albums can be nested** inside a manual or smart album, to filter its content down further. Each child smart albums inherits its parent filters to narrow down the selection.

Albums exist only in Photoboggan's database, so back up its data folder if you rely on them. Drag to move or copy them.

### Rotating photos

Context menu, or `Ctrl`+`R` (right) / `Shift`+`R` (left). Rotation is **lossless**: only the orientation tag in the metadata changes, never the pixels, there is no re-compression. Not available for HEIC, HEIF and videos.

### Compare mode

Press `X` or click **Compare** to view up to 4 photos side by side.

1. Select 2 to 4 photos in the grid.
2. Zoom and pan are **synchronized**. Tick **Desynchronize** to move one photo independently.
3. Click photos in the comparison to sub-select them. Rating, color and deletion apply only to this sub-selection (`A` selects all of them).

### Copy, move, resize, delete

Right-click a photo or selection for the context menu:

| Action                          | Notes                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Photo info** (`J`)            | Information sheet.                                                                                                                            |
| **Delete** (`Del`)              | Moves to the system trash after confirmation.                                                                                                 |
| **Copy** (`Ctrl`+`C`)           | Copies the files to the clipboard.                                                                                                            |
| **Copy to…** (`C`)              | Copies to a folder you choose.                                                                                                                |
| **Resize…** (`S`)               | Batch resize into new files (see below).                                                                                                      |
| **Rename…** (`F2`)              | One photo: its new name. Several photos: batch rename (see below).                                                                            |
| **Show in file explorer** (`E`) |                                                                                                                                               |
| **Open with** (`O`)             | Programs of **Settings > Open with** for the file type (rendered images, RAW, videos), in your order, or **Choose…**. `O` uses the first one. |

You can also **drag** photos onto a folder in the tree: `Shift`+drag to **move**, `Ctrl`+drag to **copy**. When photos are copied or moved, their `.xmp` sidecar file goes with them.

Right-click a folder for **Rescan folder data**, **Integrity check**, **New subfolder…**, **Rename folder…**, **Open in file explorer**, and **Delete folder…** (subfolders only). A folder scan or rescan can be **paused** and resumed from the **Running tasks** window; interrupted scans stay paused and can be resumed at the next launch.

**Resize:** choose the longest side (px) or a percentage (never enlarges), JPEG/PNG output, quality, whether to keep metadata (JPEG only) and whether to drop the rating/color/flag marks, a destination folder (with an optional relative sub-folder hierarchy mirroring your library), a filename suffix, and what to do about conflicts. The destination is remembered: the **Last destination** button restores it. Resizing creates **new files** and can never overwrite the original photo: with no suffix you must pick another destination folder. If the new name already belongs to a different existing file, you choose *Replace*, *Increment name* or *Skip*. Videos are ignored.

**Batch rename:** select several photos and press `F2` (or right-click > **Rename…**). Build a *recipe* of steps that are applied in order to each file name (the extension is kept): **Start blank** (erases the current name so the recipe starts from nothing; added once, always first), **Replace text** (case-sensitive, optionally only the n-th occurrence), **Insert text** (at a position counted from the start or the end of the name) and **Delete characters** (at least one character must remain). The texts can contain variables, for example `{filename}` (original name), `{date_taken(YYYYMMDD_hhmmss;nodate)}` (date taken, written with the ISO 8601 symbols `YYYY MM DD hh mm ss`; the second value is used when the photo has no date), `{camera}`, `{lens}`, `{counter(3;1)}` (number in grid order, 3 digits, starting at 1) and `{author(initials)}` (`Jean-Pierre Dupont` gives `JpD`); the `?` buttons list every option, and `\` cancels the effect of the next character. The preview shows every new name, page by page, and nothing happens until you click **Rename**. Recipes can be saved and reused. A photo whose new name would be the same as another one (case ignored) or as an existing file is **left unchanged**, and listed at the end (the rest of the batch goes on); `.xmp` sidecars follow their photo. From 20 photos it runs as a background task you can stop. `Ctrl`+`Z` undoes the whole batch, including the part already done if you stopped it.

> **Deleting:** files go to the trash, so they can be restored. On USB drives and network locations Windows has no trash: Photoboggan warns you that deletion is then **permanent**. Deleting a photo keeps its `.xmp` sidecar file. Deleting a folder also removes files Photoboggan does not manage; it lists them before you confirm. Folder deletion is **refused** while a [private-photos set](#9-private-photos) is active, so hidden photos cannot be trashed unseen.

### Integrity check

Right-click a folder > **Integrity check** tries to decode each file and reports suspicious ones (truncated or damaged). It also builds missing thumbnails. It takes no action on the files: the report lets you show them in your file manager and export the list.

It checks JPEG, PNG, WebP, HEIC/HEIF and RAW previews. It does **not** check videos, GIF, BMP or AVIF, and it cannot detect every kind of damage. A clean report is not a guarantee.

---

## 5. Keywords, titles, author and metadata

### Keywords tab

Keywords are **hierarchical** (for example `Places / France / Paris`). Select photos, then in the **Keywords** tab:

- Tick a keyword's box in the tree to assign or remove it (`Shift`+click also includes its parents). Or type in **Add a keyword…** and press `Enter` to pick an existing keyword from the suggestions.
- Right-click a keyword to create a child, rename or delete it. This is how new keywords are created. Deleting or renaming a keyword updates every photo that carries it.
- The suggestion list sorts the shortest matches first, then your most frequently used keywords.
- Batch editing is safe: a keyword you do not touch on a photo is never removed from it.
- **Unify** gives every selected photo all keywords that at least one of them has.
- **Discard changes** reverts to the saved state.
- The tree switches between **All keywords** and **Assigned keywords** with `Ctrl`+`K`.
- `K` opens the Keywords tab; `Alt`+`K` puts the cursor in **Add a keyword…**, `Alt`+`D` in the title field and `Shift`+`K` in the keyword filter.

Names cannot contain `/`, `|` or `,`. Other characters (accents, non-Latin scripts) are fine.

### Title, description, author and rights

The **Description** tab holds a **Title**, a **Description** and five **author and rights** fields: **Author**, **Copyright notice**, **Credit**, **Usage terms** and **Author e-mail**.

- Several authors are typed separated by `;` (e.g. `Jean Dupont; Marie Martin`).
- With several photos selected, a field showing *Multiple values* is replaced on all photos when you type; a field you never touch is never written.
- Copyright and usage terms are small text areas that grow to three lines, but always hold a single-line value.
- The **Author and rights presets** line under the fields: pick a preset to fill all five fields at once, create a new one, or save your changes back to the selected preset with the floppy button (it turns amber when the fields differ from the preset). Presets are managed in their own window.
- The **Info** tab has a foldable **Author and rights** section showing the same data; clicking a row opens the Description tab with the cursor in the matching field.

Only the default text of title and description is written; translated variants already in a file are left alone unless you empty the default text.

### Writing changes to files

Ratings and colors are saved immediately. **Keywords, titles, descriptions, author and rights fields, and faces wait** until you click **Write to files** (or press `Ctrl`+`Enter`). If you change the selection or quit with unsaved changes, Photoboggan asks what to do. In **Settings > Metadata** you can tick **Automatically apply pending changes** to write them automatically instead.

Large keyword changes (20 photos or more) run as a background task.

### Where metadata goes

| File type                                  | Where it is stored                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| **JPEG**                                   | Inside the file (XMP and IPTC; with ExifTool also some EXIF fields).                   |
| **HEIC / HEIF**                            | Inside the file when its structure allows it safely; otherwise in a sidecar.           |
| **RAW, PNG, WebP, GIF, BMP, AVIF, videos** | In a **sidecar** file, `photo.ext.xmp` (or an existing `photo.xmp`) next to the photo. |

Photoboggan understands the main keyword conventions: digiKam, Lightroom, Media Pro, Microsoft Photo, ACDSee, plus flat lists (Dublin Core, IPTC, Windows). It writes all of them so other programs agree. When reading, one source wins, in the order set under **Settings > Metadata > Reading priority** (default: digiKam, Lightroom, Media Pro, Microsoft, ACDSee). The author and rights fields have their own reading priority. A new order applies to files read afterwards, so rescan to apply it.

Ratings and color labels use the standard XMP fields (plus Microsoft and ACDSee equivalents), which digiKam and Lightroom read. Pick flags use `digiKam:PickLabel` (0 none, 1 rejected, 2 pending, 3 picked), `xmpDM:pick` (-1 rejected, 0 none, 1 picked, as written by Lightroom) and `xmpDM:good` (true / false). When reading, the first of these present in the **Pick** reading priority wins; a value of 0 counts as an answer ("no flag"), only an absent field passes to the next one.

**Safe sidecars:** a shared `photo.xmp` used by several images (RAW+JPEG pairs…) is never overwritten; Photoboggan targets its own sidecar and logs conflicts.

### Changes made outside Photoboggan

Photoboggan notices new, modified or deleted files when it starts and when you return to its window, using file size and modification date. Use **Rescan folder data** (folder menu) or **Rescan all collection** (Settings) to force a full re-read, for instance after changing the reading priority.

---

## 6. File safety

**Your folders are the source of truth.** Photoboggan keeps only a cache (thumbnails and a small database, see [Settings](#11-settings)) and never needs your photos to be moved or imported.

### Read-only operations

Browsing, filtering, sorting, thumbnails, previews, Compare, Info, Integrity check, face detection, content analysis, statistics do **not** modify your files. Thumbnails and the database live in a separate data folder.

### Operations that modify or create files

| Operation                                                                 | Effect                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Rating, color, pick flag, keywords, title, description, author and rights | Changes metadata only (inside the file or its sidecar).                |
| Writing faces / **Erase face data…**                                      | Changes face-region metadata (and keywords set by face recognition).   |
| Rotating                                                                  | Changes metadata only                                                  |
| Move, Copy to…, drag and drop                                             | Moves or copies files (and their sidecars).                            |
| Rename, batch rename                                                      | Renames files (and their sidecars); never overwrites an existing file. |
| Resize                                                                    | Creates new files; it cannot replace the original files.               |
| Delete                                                                    | Trash (or permanent on drives without one).                            |
| New subfolder                                                             | Creates a folder.                                                      |

### How metadata writing protects your files

- **Pixels are never touched.** Only metadata is changed; image data is copied unchanged.
- **Write to a temporary file, then replace.** Each file is written to a temporary copy and replaces the original only once the write succeeded. A failure leaves the original in place, and the leftover temporary file is cleaned up. (With ExifTool, the same principle applies and the original is replaced via ExifTool's own temporary file.)
- **No fallback.** If a write fails, you get an error naming the file ("The file was not modified"); it is never shown as a success. If ExifTool cannot be found, writing is refused rather than switching method silently.
- **Rewritten JPEG segments only.** For JPEG, only the metadata segments are rebuilt; the rest of the file is copied byte for byte.
- **HEIC (Internal writing):** the result is verified before the original is replaced; if it cannot be done safely, a sidecar is used instead.
- **After a write, the file is read back** and the app shows what the file really contains.

### Precautions

> **Keep backups.** Photoboggan limits risk but cannot guarantee that no software, disk or power failure ever damages a file. A write rewrites the whole file, so a crash at the wrong moment, a full disk, or a faulty drive can still cause trouble. Never rely on a single copy.

- Do not edit the same files in another program while Photoboggan is writing to them.
- Do not quit during a metadata write if you can avoid it (the app asks you to confirm).
- Writing needs free space for a temporary copy of the file, on the same drive.
- Read-only files, or files on locked or disconnected drives, cannot be written to; the error is reported.
- **Copying and moving** use the operating system's standard file copy. Copies never overwrite an existing file (`photo (1).jpg` is used instead). Moving within a drive is a simple rename. Moving **across drives** copies first, then (by default) compares the copy with the original using a SHA-256 checksum, and deletes the original only if they match; otherwise the copy is discarded and the original stays. This verification re-reads both files and can be turned off in **Settings > Storage** for faster moves. The copy may be read back from the system cache rather than the disk, so this is a strong check, not an absolute proof: keep backups. Plain **Copy to…** is not checksummed.
- The integrity check is a **helper, not a proof** of file health (see above).
- **Everything stays local.** No photo or metadata is sent anywhere. The only network uses are the optional downloads of the face-recognition and content-search models, the optional update check and the map tiles; **Offline mode** disables all of them.
- Deleting a folder can include files Photoboggan does not manage; in that case photoboggan displays a warning and confirmation list.

---

## 7. People and face recognition

Photoboggan can read face areas already stored by other software, and can detect and recognize faces itself. Everything runs on your computer.

### Reading existing faces

**Settings > Faces > Read face data** reads face regions written by digiKam, Lightroom, Windows Photos. This enables the **People** list in the left panel, the **People (&)** filter and face frames in fullscreen (`V` cycles: on hover, always, hidden). Nothing is written. Rescan the collection to read faces of photos already scanned.

### Detecting and recognizing faces

Face detection is done through Yunet model, recognition with SFace model. A person can hold several reference faces (centroids), so recognition keeps working as faces change with age.

1. In **Settings > Faces**, tick **Enable face detection and recognition**.
2. Click **Download** to get the model (about 56 MB on Windows) from github, it will be stored in your chosen data folder, as set in Settings / Storage screen. Offline? Use **Offline mode** and **Install from a folder…** with the files listed under *Installing without Internet*.
3. Right-click a folder or a selection > **Faces** > **Detect and recognize faces (unscanned photos)** or **(all photos)**, then **Start**.

RAW files are scanned only if **Scan RAW files (embedded preview)** is ticked. Detection uses the cached thumbnails (512 px minimum, so the thumbnail cache cannot be set lower, and higher is better).

### Detection and Recognition tuning

The detection and recognition thresholds in **Settings > Faces** have sensible hints next to each field; defaults are provisional, so adjust them if you get too many false faces or suggestions. Changing a threshold reclassifies existing faces without a new scan, so slowly adjust and check the effects.

### Reviewing faces

Open the **People** view (top bar) for one tile per person, then **Review faces** to open the faces view. Each face has a status (filter them at the top):

| Status            | Meaning                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Confirmed**     | You confirmed the person. Confirmed faces improve recognition immediately, so more suggestions can appear.                         |
| **Automatic**     | Attributed automatically (high similarity) in database but confirmation is still needed to write to files and update the face data |
| **To confirm**    | Suggested person, needs your approval.                                                                                             |
| **Unknown faces** | Not recognized; name them yourself. **Group unknown** clusters similar ones.                                                       |
| **Ignored**       | A real face you don't care about (e.g. a stranger in a crowd).                                                                     |
| **Not faces**     | False detection (pattern, statue…). Never offered again.                                                                           |
| **Filtered**      | Below the detection thresholds.                                                                                                    |

Suggested faces are sorted by person and by decreasing probability, so focus more toward the end.

**Only confirmed faces are written to files.**

A photo preview panel keeps the faces in their context while you review. Select faces thumbnails and use the bottom bar or keyboard :

- **Confirm** (`Enter`) to confirm the recognized suggestion

- **Name…** (or just type a letter),

- **Unknown** (`-`),

- **Ignore** (`/`),

- **Not a face** (`Del`),

- **Profile** (use as the person's cover picture).

`Ctrl`+`A` selects all, `Esc` clears.

In fullscreen you can also draw a face area with `Shift`+drag, and right-click an area to name or delete it.

Right-click a person to rename, set an alias (display only, never written), hide, merge into another person (undoable), or delete. When a person is linked to a keyword, renaming goes through the keyword; conflicts between people and keywords are reported for you to resolve. **People without faces > Clean up…** (Settings > Faces) removes people who no longer have any face.

### Saving faces

Faces and names are only written to your files when you click **Write to files** (`Ctrl`+`Enter`) in the faces view; the button shows how many photos are waiting. Naming a new person also creates a keyword for them (under the root set in **Keyword root for new people**, for example `#CONTACTS`). The keyword will only appear in the keyword tree when the face is written.

---

## 8. Maps, geolocation and private zones

### Interactive Map

Click **Map** in the top toolbar to view photo coordinates plotted over an interactive vector map (light and dark styles are bundled).

- **Assign Location:** Select photos in the grid, hold Shift, and drag them onto the target spot on the map (or right-click the map and select *Place selection here*).
- **Filter by Map Area:** Check "Visible area only" to filter the thumbnail grid to images located within the current map viewport.
- **Place search** (when online): type a place name in the map's search box and press `Enter` to jump there. Disabled in offline mode.

### Geolocation

- **Erase geolocation** / **Restore geolocation** (context menu) remove or put back GPS data; the removed values are kept in the catalogue so they can be restored.
- Geotagging with the map is written with **Write to files**, like other metadata.

### Private zones and downloaded zones

Online map providers can log coordinate requests when fetching map tiles. Photoboggan solves this through **private zones**, managed with the padlock in the Location group or in **Settings > Maps**:

- You can define a sensitive area (such as your home, workplace, or private property) by drawing either a **Circle** or a **Rectangle**.
- Photoboggan downloads the vector map tiles for this specific area and saves them locally in an isolated `.mbtiles` container.
- Whenever a photo located inside a private zone is viewed, **Photoboggan strictly blocks any outgoing network requests**. Tiles are loaded solely from your local disk, and the map never falls back to the remote provider there.
- You can also import pre-downloaded `.mbtiles` packages for complete offline field use.
- Zones can also be downloaded simply as **offline map caches**: any downloaded zone serves its tiles locally, so the provider never sees repeated tile requests when you browse the same area.

Nothing is sent in **Offline mode**.

---

## 9. Private photos

Photoboggan can **hide sensitive photos across the whole app** — grid, photo counts, folder tree, albums, People and faces views, duplicate searches — **without modifying or moving any file on disk**. Scans, metadata writes and thumbnails still work normally on hidden photos.

### Privacy sets

You define named **privacy sets** in **Settings > Misc > Private photos**. Each set combines three kinds of criteria, and a photo is hidden as soon as it matches **at least one criterion of any active set**:

- **Folder path part**: matches the folder portion of the photo's path (the file name is never considered). A complete part must match a whole folder segment; a partial part (written `~text`) matches any part of the folder path.
- **Keyword**: any photo carrying that keyword is hidden.
- **Date range**: inclusive range such as `2024`, `202406-202408` or full dates. Dated photos are compared by date taken; undated photos by the date they were added to the catalogue.

An empty set hides nothing.

### Toggling and the shield

- When the feature is enabled, a **shield** appears in the Filters panel header: it turns green when sets are active, and its menu lets you switch sets on and off (or turn everything off) without opening the Settings.
- **Lock the shield** (Settings > Misc) prevents quick toggling outside the Settings: the sets can then only be changed there, and the shield tooltip says so.
- Active sets are restored at the next launch **before** anything is displayed, so hidden photos are never exposed.

### Safety

- Hidden photos are excluded from counts everywhere, so nothing betrays their existence.
- **Folder deletion is refused while any set is active**, so photos hidden inside a folder can never be trashed unseen. Deactivate your sets first if you really want to delete the folder.
- Files, sidecars and thumbnails of hidden photos are never touched.

---

## 10. Collection statistics

A read-only window (chart icon in Settings, next to the shortcut guide) summarises your library. Nothing is ever written.

**Filters** (combined, all optional): camera, root folder, file format, and a **period** (last month, last year, all time, or two custom dates). The time chart's granularity (day, week, month, year, decade) adapts to the period, or can be chosen by hand.

**Blocks shown, in order:**

1. Number of photos and total size.
2. Time chart of photos taken.
3. Top 5 cameras and top 5 lenses.
4. Photos and size per file extension.
5. Photos per rating, per color label and per pick flag (the latter two only if enabled in Settings).
6. The 15 most used keywords.
7. Geolocated vs. not geolocated.
8. People and faces (distinct people, total faces, top 5 people), when face detection is on.
9. Distribution by shooting setting — focal length, aperture, shutter speed or ISO — with a selector.
10. Content analysis (analysed vs. not), when the content search is on.

A note under each list says how many of the counted photos carry the information.

---

## 11. Settings

Open with the gear icon. The keyboard icon shows the shortcut guide; the chart icon opens the [statistics](#10-collection-statistics); the *i* icon shows the version and links.

| Tab              | Main options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **General**      | **Language** choice; <br/>**At startup, show** all photos or last folder<br/>**Offline mode** (never connect to the Internet)<br/>**Check for updates** (at startup, at most once a day; GitHub then receives your IP address and version number)<br/>**Library**:<br/> - **+ Add folder**, remove folders,<br/> - **Rescan all collection** re-reads every file; it can be long. It also cleans up orphan thumbnails.                                                                                                                                               |
| **Storage**      | **Thumbnail quality** (high doubles the size of new thumbnails on disk);<br/>**Application data location** (database, thumbnails, face models; moving it moves the files; a fast SSD is best). <br/>**Thumbnail cache size**: 512, 768 or 1024 px. Higher is better for face recognition's display in faces review page. Changing it deletes thumbnails, which are rebuilt as you browse. <br/>**Remove orphan thumbnails** deletes potential useless thumbnails<br/>**Verify moves between drives** (checksum)**: on by default, see [File safety](#6-file-safety). |
| **Applications** | **Open with** programs shown in the context menu.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Metadata**     | **Writing metadata to files**: *With ExifTool (recommended)* or *Internal (XMP and IPTC only)*; <br/>ExifTool location;<br/>**Labels**: use color labels, use pick / reject flags (off by default);<br/>**Automatically apply pending changes**; <br/>**Reading priority** per metadata type (drag to reorder), including the author and rights fields.                                                                                                                                                                                                              |
| **Maps**         | Show the map, default zoom, geolocation badge, place search, offline / downloaded / private zones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Faces**        | Face reading, detection, model, thresholds (see [section 7](#7-people-and-face-recognition)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Search**       | **RAW search** (Find-the-RAW criteria); content search: model, analysis options, search and keyword suggestion options, delete analysis data (see [Content search](#content-search)).                                                                                                                                                                                                                                                                                                                                                                                |
| **Misc**         | Slideshow, albums, **Private photos** (see [section 9](#9-private-photos)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**ExifTool vs Internal:** ExifTool is bundled with Photoboggan (on Linux it needs `perl`) and also writes the Windows/EXIF fields of JPEGs (Windows keywords, title and comment fields). The *Internal* method should be faster but writes only XMP and IPTC and never touches risky EXIF tags. Both write the same core data.

**Updates:** when *Check for updates* is on and a new release exists, Photoboggan offers to download the installer for your platform. The download is verified against the **SHA-256 digest published with the release** — checked while downloading and again before launching — and the installer is launched from within the app. Disabled in offline mode.

Display & appearance options (theme, text size, font, layout) are in **Display**, opened from the top bar.

---

## 12. Keyboard shortcuts

Many shortcuts are available to quickly adjust the interface and to rate/sort photos.
Press `G` for the full searchable in-app guide. Notable ones:

- `T` toggles the toolbar auto-hide; `F11` toggles immersive mode.
- `X` compare mode, `K` keywords tab, `H` histogram, `V` face frames, `D` info overlay and `R` rating bar in fullscreen.
- `F10` slideshow; `F2` rename; `S` resize; `C` copy to…; `E` show in file explorer; `O` open with.

---

## 13. Troubleshooting

| Problem                                          | What to try                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A photo shows no thumbnail**                   | Wait for the scan to finish (see **Running tasks**). Run **Integrity check** on the folder to rebuild missing thumbnails and find damaged files. Videos need a codec (Windows) or `ffmpeg`.                                                                                             |
| **Thumbnails appear slowly in the grid**         | When first displaying photos, they have to be fully read and decoded to generate a thumbnail. It takes time depending on the drive's performance. After that, thumbnails are cached on disk, and provided you use a SSD, they should appear instantly.                                  |
| **New or edited files don't appear**             | Switch away and back to the window, or use **Rescan folder data**.                                                                                                                                                                                                                      |
| **Photos seem to have disappeared**              | Check the **shield** in the Filters header: an active [private-photos set](#9-private-photos) hides photos everywhere (counts included). It can only be changed in Settings if the shield is locked.                                                                                    |
| **Folder deletion is refused**                   | A private-photos set is active; deactivate it first (see above).                                                                                                                                                                                                                        |
| **"ExifTool not found" / metadata won't write**  | Check **Settings > Metadata**. Use **Choose ExifTool…**, or switch to *Internal*. On Linux, install `perl`.                                                                                                                                                                             |
| **A write failed**                               | The error names the file, which was not modified. Check that it is not read-only, open in another program, or on a disconnected drive; then retry.                                                                                                                                      |
| **Copy / Move cannot be cancelled**              | Copies and file moves between disks cannot be interrupted mid-file or during SHA-256 check. Be patient. Note standard OS file copy is used.                                                                                                                                             |
| **Keywords from another program look different** | The *Reading priority* decides which format wins. Adjust it and rescan the collection.                                                                                                                                                                                                  |
| **No People section / face options**             | Enable **Read face data** and/or **face detection** in **Settings > Faces**.                                                                                                                                                                                                            |
| **Face model won't download**                    | Check that **Offline mode** is off, or install the model manually from a folder.                                                                                                                                                                                                        |
| **RAW photo looks low-res**                      | Photoboggan displays the embedded camera preview, by design.                                                                                                                                                                                                                            |
| **Faces in faces review look low-res**           | The faces in that view are a crop from the photo's thumbnail. photoboggan does not create higher-resolution face thumbnails to keep performance smooth and avoid using too much storage.                                                                                                |
| **Faces are not written as they're confirmed**   | It is not offered to apply faces after a modification on each face, to limit disk writes, as there are often several faces on a photo. It has to be written by user through "Write photos" button in faces review, or by choosing to apply on the dialog displayed when closing the app |
| **External drive or network share disconnected** | Photos on it are kept in the catalog, not treated as deleted. Reconnect it and they are back.                                                                                                                                                                                           |

To report a problem or suggest an idea, use the link in **Settings > About** (GitHub).
