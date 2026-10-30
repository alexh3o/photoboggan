# Photoboggan User Guide

Photoboggan is a fast, lightweight photo browser and organizer for your computer. It works directly on the folders you already have: no import, no copy, no proprietary library. Rate, color-label, keyword, compare and filter your photos, and everything you add is stored in the standard way, so other programs (digiKam, Lightroom, Windows Explorer…) see it too.

> **Beta software.** Always keep a complete backup of your photos.

## Contents

1. [Getting started](#1-getting-started)
2. [Interface overview](#2-interface-overview)
3. [Browsing and finding photos](#3-browsing-and-finding-photos)
4. [Organizing photos](#4-organizing-photos)
5. [Keywords, titles and metadata](#5-keywords-titles-and-metadata)
6. [File safety](#6-file-safety)
7. [People and face recognition](#7-people-and-face-recognition)
8. [Settings](#8-settings)
9. [Keyboard shortcuts](#9-keyboard-shortcuts)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Getting started

### Install

Download the installer for your system from the project's [Releases page](https://github.com/alexh3o/photoboggan/releases).

- **Windows:** run the installer. Windows may warn that the publisher is unknown; choose *More info* then *Run anyway*.
- **Linux (Debian/Ubuntu):** install the `.deb` package (`sudo dpkg -i photoboggan_*.deb`, then `sudo apt-get install -f` if dependencies are missing). Linux support is less tested than Windows.

### First launch

1. Open **Settings** (gear icon) > **General** > **Library**.
2. Click **+ Add folder** and pick a folder containing photos. Photoboggan scans it, then shows its photos. Subfolders are included.
3. Repeat for other folders. Progress is shown in the **Running tasks** window (hourglass icon).

The first scan builds thumbnails and reads metadata, so it can take a while on large collections. Afterwards, browsing is instant.

Other useful startup choices (**Settings > General**): the language (English or French), and whether to show **The last opened location** or **All photos** at startup.

### Supported files

| Type   | Formats                                                |
| ------ | ------------------------------------------------------ |
| Images | JPG, JPEG, JFIF, PNG, WebP, AVIF, GIF, BMP, HEIC, HEIF |
| RAW    | ARW, CR2, CR3, NEF, NRW, DNG, RAF, ORF, RW2, RAW       |
| Videos | MP4, MOV, AVI, MKV                                     |

- **RAW files** are never developed. Photoboggan shows the JPEG preview embedded in the file by the camera, which is quick but can be lower resolution than the real photo.
- **Videos** show a still thumbnail only. Double-click opens the video in your system's default player. Thumbnails come from Windows' own thumbnailer, or from `ffmpeg` if it is installed.

---

## 2. Interface overview

| Area            | What it does                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Top bar**     | Toggles for the **Filters** panel, **People** view, **Preview** and **Info** panels, **Compare** mode; buttons for **Settings**, **Running tasks**, **Display** (layout, theme, text size) and **Sort**. |
| **Left panel**  | **Folders** tree, **People** list (if face reading is on), **Filters**, and the **Selection** box (rating and color of the selected photos).                                                             |
| **Center**      | The thumbnail grid.                                                                                                                                                                                      |
| **Preview**     | Larger view of the selected photo(s).                                                                                                                                                                    |
| **Right panel** | Three tabs: **Info** (file and camera data), **Keywords**, **Description** (title and description).                                                                                                      |

Panels can be shown or hidden (see [shortcuts](#9-keyboard-shortcuts)) and resized by dragging their edges. Press `F11` for immersive mode, which hides the title bar and taskbar.

---

## 3. Browsing and finding photos

### Viewing

- Click a folder to see its photos. Turn **Include subfolders** on or off in **Display**.
- **Click** a thumbnail to select it and see it in the preview. **Double-click** (or press `F`) for fullscreen.
- In preview and fullscreen: `←` / `→` for previous/next, `+` / `-` to zoom, `*` to switch between actual size and fit-to-window.
- Fullscreen extras: `D` shows photo info, `R` shows a rating bar.

### Selecting

- `Ctrl`+click adds or removes a photo. `Shift`+click selects from the last click. They can be combined several times and in any direction for one selection.
- `Ctrl`+`A` selects all.
- **Deselect all** is the cross button in the Selection box.

### Display and sorting

**Display** (grid icon):

- **Thumbnails grid:** *Square*, *Framed*, *Justified* (full rows, no cropping) or *Waterfall*.
- **Thumbnail spacing** and **Size** (96 to 1024 px).
- **Theme** (*Dark* / *Light*), **Text size**, **Selection color**, **Active Buttons color**, and **Dim unselected photos on hover**.

**Sort** (arrows icon): by **Date taken**, **Date modified** or **Filename**, ascending or descending, with optional separators (by day, week, month, year, or by folder when sorting by name).

### Filters

Filters are in the left panel and **combine with each other**. The grid shows the number of matching photos; the cross button next to **Filters** clears everything.

| Filter               | How it works                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Ratings & Colors** | Minimum rating (*≥ 1 star* … *= 5 stars*), plus one or more color labels (a photo matches any selected color).       |
| **Keywords (&)**     | Choose keywords; photos must have **all** of them. Ctrl+click a keyword in the Keywords tab to add it to the filter. |
| **Filename**         | Type text (3 characters minimum) and press Enter. Several words must **all** appear in the name.                     |
| **People (&)**       | Choose people; photos must show **all** of them. Only available when face reading is on.                             |
| **Date taken**       | Type a date or range, or use the calendar button.                                                                    |

**Date filter examples** (formats `YYYY`, `YYYYMM`, `YYYYMMDD`, `YYYYMMDDHH`, `YYYYMMDDHHmm`):

- `2024` → the whole year 2024
- `20241225` → 25 December 2024
- `2024-20250630` → from the start of 2024 to the end of 30 June 2025

---

## 4. Organizing photos

### Rating and color labels

- **Rating:** keys `0`–`5` (`0` removes it), the Selection box, or the stars in fullscreen.
- **Color labels:** keys `6` (red), `7` (yellow), `8` (green), `9` (blue); pressing the same key again removes it. More colors (orange, magenta, grey, black, white) are available in the Selection box and filters.
- `Alt` + a rating/color key applies it and moves to the next photo, for fast culling.

Ratings and colors are written to your files right away (see [File safety](#6-file-safety)).

### Compare mode

Press `X` or click **Compare** to view up to 4 photos side by side.

1. Select 2 to 4 photos in the grid.
2. Zoom and pan are **synchronized**. Tick **Desynchronize** to move one photo independently.
3. Click photos in the comparison to sub-select them. Rating, color and deletion apply only to this sub-selection (`A` selects all of them).

### Copy, move, resize, delete

Right-click a photo or selection for the context menu:

| Action                          | Notes                                                           |
| ------------------------------- | --------------------------------------------------------------- |
| **Photo info** (`I`)            | Information sheet.                                              |
| **Delete** (`Del`)              | Moves to the system trash after confirmation.                   |
| **Copy** (`Ctrl`+`C`)           | Copies the files to the clipboard.                              |
| **Copy to…** (`C`)              | Copies to a folder you choose.                                  |
| **Resize…** (`S`)               | Batch resize into new files (see below).                        |
| **Show in file explorer** (`E`) |                                                                 |
| **Open with**                   | Your programs from **Settings > Applications**, or **Choose…**. |

You can also **drag** photos onto a folder in the tree: `Shift`+drag to **move**, `Ctrl`+drag to **copy**. When photos are copied or moved, their `.xmp` sidecar file goes with them.

Right-click a folder for **Rescan folder data**, **Integrity check**, **New subfolder…**, **Open in file explorer**, and **Delete folder…** (subfolders only).

**Resize:** choose the longest side (px) or a percentage, JPEG/PNG output, quality, whether to keep metadata (JPEG only), a destination folder and a filename suffix. Resizing creates **new files** and can never overwrite the original photo: with no suffix you must pick another destination folder. If the new name already belongs to a different existing file, you choose *Replace*, *Increment name* or *Skip*. Videos are ignored.

> **Deleting:** files go to the trash, so they can be restored. On USB drives and network locations Windows has no trash: Photoboggan warns you that deletion is then **permanent**. Deleting a photo keeps its `.xmp` sidecar file. Deleting a folder also removes files Photoboggan does not manage; it lists them before you confirm.

### Integrity check

Right-click a folder > **Integrity check** tries to decode each file and reports suspicious ones (truncated or damaged). It also builds missing thumbnails. It takes no action on the files: the report lets you show them in your file manager and export the list.

It checks JPEG, PNG, WebP, HEIC/HEIF and RAW previews. It does **not** check videos, GIF, BMP or AVIF, and it cannot detect every kind of damage. A clean report is not a guarantee.

---

## 5. Keywords, titles and metadata

### Keywords tab

Keywords are **hierarchical** (for example `Places / France / Paris`). Select photos, then in the **Keywords** tab:

- Tick a keyword's box in the tree to assign or remove it (`Shift`+click also includes its parents). Or type in **Add a keyword…** and press `Enter` to pick an existing keyword from the suggestions.
- Right-click a keyword to create a child, rename or delete it. This is how new keywords are created. Deleting or renaming a keyword updates every photo that carries it.
- **Unify** gives every selected photo all keywords that at least one of them has.
- **Discard changes** reverts to the saved state.
- The tree switches between **All keywords** and **Assigned keywords** with `Ctrl`+`K`.

Names cannot contain `/`, `|` or `,`. Other characters (accents, non-Latin scripts) are fine.

### Title and description

The **Description** tab holds a **Title** and a **Description**. Only the default text is written; translated variants already in a file are left alone unless you empty the default text.

### Writing changes to files

Ratings and colors are saved immediately. **Keywords, titles, descriptions and faces wait** until you click **Write to files** (or press `Ctrl`+`Enter`). If you change the selection or quit with unsaved changes, Photoboggan asks what to do. In **Settings > Metadata** you can tick **Automatically apply pending changes** to write them automatically instead.

Large keyword changes (20 photos or more) run as a background task.

### Where metadata goes

| File type                                  | Where it is stored                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| **JPEG**                                   | Inside the file (XMP and IPTC; with ExifTool also some EXIF fields).                   |
| **HEIC / HEIF**                            | Inside the file when its structure allows it safely; otherwise in a sidecar.           |
| **RAW, PNG, WebP, GIF, BMP, AVIF, videos** | In a **sidecar** file, `photo.ext.xmp` (or an existing `photo.xmp`) next to the photo. |

Photoboggan understands the main keyword conventions: digiKam, Lightroom, Media Pro, Microsoft Photo, ACDSee, plus flat lists (Dublin Core, IPTC, Windows). It writes all of them so other programs agree. When reading, one source wins, in the order set under **Settings > Metadata > Reading priority** (default: digiKam, Lightroom, Media Pro, Microsoft, ACDSee). A new order applies to files read afterwards, so rescan to apply it.

Ratings and color labels use the standard XMP fields (plus Microsoft and ACDSee equivalents), which digiKam and Lightroom read.

### Changes made outside Photoboggan

Photoboggan notices new, modified or deleted files when it starts and when you return to its window, using file size and modification date. Use **Rescan folder data** (folder menu) or **Rescan all collection** (Settings) to force a full re-read, for instance after changing the reading priority.

---

## 6. File safety

**Your folders are the source of truth.** Photoboggan keeps only a cache (thumbnails and a small database, see [Settings](#8-settings)) and never needs your photos to be moved or imported.

### Read-only operations

Browsing, filtering, sorting, thumbnails, previews, Compare, Info, Integrity check and face detection do **not** modify your files. Thumbnails and the database live in a separate data folder.

### Operations that modify or create files

| Operation                                   | Effect                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Rating, color, keywords, title, description | Changes metadata only (inside the file or its sidecar).              |
| Writing faces / **Erase face data…**        | Changes face-region metadata (and keywords set by face recognition). |
| Move, Copy to…, drag and drop               | Moves or copies files (and their sidecars).                          |
| Resize                                      | Creates new files; it cannot replace the original files.             |
| Delete                                      | Trash (or permanent on drives without one).                          |
| New subfolder                               | Creates a folder.                                                    |

### How metadata writing protects your files

- **Pixels are never touched.** Only metadata is changed; image data is copied unchanged.
- **Write to a temporary file, then replace.** Each file is written to a temporary copy and replaces the original only once the write succeeded. A failure leaves the original in place, and the leftover temporary file is cleaned up. (With ExifTool, the same principle applies and the original is replaced via ExifTool's own temporary file.)
- **No fallback.** If a write fails, you get an error naming the file ("The file was not modified"); it is never shown as a success. If ExifTool cannot be found, writing is refused rather than switching method silently.
- **Rewritten JPEG segments only.** For JPEG, only the metadata segments are rebuilt; the rest of the file is copied byte for byte.
- **HEIC (Internal writing):** the result is verified before the original is replaced; if it cannot be done safely, a sidecar is used instead.
- **After a keyword write, the file is read back** and the app shows what the file really contains.

### Precautions

> **Keep backups.** Photoboggan limits risk but cannot guarantee that no software, disk or power failure ever damages a file. A write rewrites the whole file, so a crash at the wrong moment, a full disk, or a faulty drive can still cause trouble. Never rely on a single copy.

- Do not edit the same files in another program while Photoboggan is writing to them.
- Do not quit during a metadata write if you can avoid it (the app asks you to confirm).
- Writing needs free space for a temporary copy of the file, on the same drive.
- Read-only files, or files on locked or disconnected drives, cannot be written to; the error is reported.
- **Copying and moving** use the operating system's standard file copy. Copies never overwrite an existing file (`photo (1).jpg` is used instead). Moving within a drive is a simple rename. Moving **across drives** copies first, then (by default) compares the copy with the original using a SHA-256 checksum, and deletes the original only if they match; otherwise the copy is discarded and the original stays. This verification re-reads both files and can be turned off in **Settings > Storage** for faster moves. The copy may be read back from the system cache rather than the disk, so this is a strong check, not an absolute proof: keep backups. Plain **Copy to…** is not checksummed.
- The integrity check is a **helper, not a proof** of file health (see above).
- **Everything stays local.** No photo or metadata is sent anywhere. The only network use is the optional download of the face-recognition model, and **Offline mode** disables it.
- Deleting a folder can include files Photoboggan does not manage; in that case photoboggan displays a warning and confirmation list.

---

## 7. People and face recognition

Photoboggan can read face areas already stored by other software, and can detect and recognize faces itself. Everything runs on your computer.

### Reading existing faces

**Settings > Faces > Read face data** reads face regions written by digiKam, Lightroom, Windows Photos. This enables the **People** list in the left panel, the **People (&)** filter and face frames in fullscreen (`V` cycles: on hover, always, hidden). Nothing is written. Rescan the collection to read faces of photos already scanned.

### Detecting and recognizing faces

1. In **Settings > Faces**, tick **Enable face detection and recognition**.
2. Click **Download** to get the model (about 56 MB on Windows). Offline? Use **Offline mode** and **Install from a folder…** with the files listed under *Installing without Internet*.
3. Right-click a folder or a selection > **Faces** > **Detect and recognize faces (unscanned photos)** or **(all photos)**, then **Start**.

RAW files are scanned only if **Scan RAW files (embedded preview)** is ticked. Detection uses the cached thumbnails (512 px minimum, so the thumbnail cache cannot be set lower, and higher is better).

### Detection and Recongnition tuning

The detection and recognition thresholds in **Settings > Faces** have sensible hints next to each field; defaults are provisional, so adjust them if you get too many false faces or suggestions. Changing a threshold reclassifies existing faces without a new scan, so slowly adjust and check the effects.

### Reviewing faces

Open the **People** view (top bar) for one tile per person, then **Review faces** to open the faces view. Each face has a status (filter them at the top):

| Status            | Meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| **Confirmed**     | You confirmed the person. Confirmed faces improve recognition immediately, so more suggestions can appear. |
| **Automatic**     | Attributed automatically (high similarity).                                                                |
| **To confirm**    | Suggested person, needs your approval.                                                                     |
| **Unknown faces** | Not recognized; name them yourself. **Group unknown** clusters similar ones.                               |
| **Ignored**       | A real face you don't care about (e.g. a stranger in a crowd).                                             |
| **Not faces**     | False detection (pattern, statue…). Never offered again.                                                   |
| **Filtered**      | Below the detection thresholds.                                                                            |

Select faces and use the bottom bar: **Confirm** (`Enter`), **Name…** (or just type a letter), **Unknown** (`-`), **Ignore** (`/`), **Not a face** (`Del`), **Profile** (use as the person's picture). `Ctrl`+`A` selects all, `Esc` clears.

In fullscreen you can also draw a face area with `Shift`+drag, and right-click an area to name or delete it.

Right-click a person to rename, set an alias (display only, never written), hide, merge into another person (undoable), or delete. **People without faces > Clean up…** (Settings > Faces) removes people who no longer have any face.

### Saving faces

Faces and names are only written to your files when you click **Write to files** (`Ctrl`+`Enter`) in the faces view; the button shows how many photos are waiting. Naming a new person also creates a keyword for them (under the root set in **Keyword root for new people**, for example `#CONTACTS`).

---

## 8. Settings

Open with the gear icon. The keyboard icon shows the shortcut guide; the *i* icon shows the version and links.

| Tab              | Main options                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **General**      | **Language**; **At startup, show**; **Offline mode (never connect to the Internet)**; **Library**: **+ Add folder**, remove folders, **Rescan all collection** (re-reads every file; can be long).                                                                                                                              |
| **Storage**      | **Application data location** (database, thumbnails, face models; moving it moves the files; a fast SSD is best). **Thumbnail cache size**: 512, 768 or 1024 px. Changing it deletes thumbnails, which are rebuilt as you browse. **Verify moves between drives (checksum)**: on by default, see [File safety](#6-file-safety). |
| **Applications** | **Open with** programs shown in the context menu.                                                                                                                                                                                                                                                                               |
| **Metadata**     | **Writing metadata to files**: *With ExifTool (recommended)* or *Internal (XMP and IPTC only)*; ExifTool location; **Automatically apply pending changes**; **Reading priority** per metadata type (drag to reorder).                                                                                                           |
| **Faces**        | Face reading, detection, model, thresholds (see [section 7](#7-people-and-face-recognition)).                                                                                                                                                                                                                                   |

**ExifTool vs Internal:** ExifTool is bundled with Photoboggan (on Linux it needs `perl`) and also writes the Windows/EXIF fields of JPEGs (Windows keywords, title and comment fields). The *Internal* method writes only XMP and IPTC. Both write the same core data.

Appearance options (theme, text size, layout) are in **Display**, opened from the top bar.

---

## 9. Keyboard shortcuts

Many shortcuts are available to qucikly adjust interface and to rate/sort photos.
Press `H` for the full searchable in-app guide.

---

## 10. Troubleshooting

| Problem                                          | What to try                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A photo shows no thumbnail**                   | Wait for the scan to finish (see **Running tasks**). Run **Integrity check** on the folder to rebuild missing thumbnails and find damaged files. Videos need a codec (Windows) or `ffmpeg`.                                                           |
| **Thumbnails appear slowly in the grid**         | When first displaying photos, they have to be fully read and decoded to generate a thumbnail. It takes time depening on the drive's performance. After that, thumbnails are cached on disk, and provided you use a SSD, they should appear instantly. |
| **New or edited files don't appear**             | Switch away and back to the window, or use **Rescan folder data**.                                                                                                                                                                                    |
| **"ExifTool not found" / metadata won't write**  | Check **Settings > Metadata**. Use **Choose ExifTool…**, or switch to *Internal*. On Linux, install `perl`.                                                                                                                                           |
| **A write failed**                               | The error names the file, which was not modified. Check that it is not read-only, open in another program, or on a disconnected drive; then retry.                                                                                                    |
| **Copy / Move cannot be cancelled**              | Copies and file moves between disks cannot be interrupted mid-file or during SHA-256 check. Be patient. Note standard OS file copy is used.                                                                                                           |
| **Keywords from another program look different** | The *Reading priority* decides which format wins. Adjust it and rescan the collection.                                                                                                                                                                |
| **No People section / face options**             | Enable **Read face data** and/or **face detection** in **Settings > Faces**.                                                                                                                                                                          |
| **Face model won't download**                    | Check that **Offline mode** is off, or install the model manually from a folder.                                                                                                                                                                      |
| **RAW photo looks low-res**                      | Photoboggan displays the embedded camera preview, by design.                                                                                                                                                                                          |
| **External drive or network share disconnected** | Photos on it are kept in the catalog, not treated as deleted. Reconnect it and they are back.                                                                                                                                                         |
| **Linux**                                        | No window moving by title bar and limited trash support are known issues.                                                                                                                                                                             |

To report a problem or suggest an idea, use the link in **Settings > About** (GitHub).
