<p align="center">
  <img src="/webpage/screenshots/logo256.png" alt="photoboggan" width="128" />
</p>

<h1 align="center">photoboggan</h1>

<p align="center">
  <em>Managing and exploring your photos — fast, local, and enjoyable.</em>
</p>

<p align="center">
  <a href="#why-photoboggan">Why photoboggan</a> ·
  <a href="#core-strengths">Core Strengths</a> ·
  <a href="#app--platform-status">Platforms</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#license--disclaimer">License</a>
</p>

---

### Why photoboggan?

After 25 years of photographing as a hobbyist and a then a dad, I wanted less time spent repeating organizing chores and more time enjoying the collection. It works directly with your existing folders: no import step, proprietary library or duplicate photo vault. Its interface keeps photos in focus, adapts to your workflow and stays responsive with collections of **200,000+ photos**.

📖 **[User guide](docs/USER_GUIDE.md)**

---

### App & Platform Status

⚠️ The application is young and should be considered **beta** software. Use it at your own risk and always keep a **healthy, complete backup of your photos**. That said, file safety is our non-negotiable priority (see below).

- **Windows**: tested, stable, and used daily.
- **Linux (`.deb`)**: works, but I have only tested it quickly on some releases : it needs testing—give it a try and share feedback!
- **macOS & other Linux packages**: not published yet, but builds can be added if testers are interested. Feel free to open an issue.

Downloads are available on the [Releases page](https://github.com/alexh3o/photoboggan/releases): `.msi` installer for Windows (English and French; ignore the SmartScreen warning) and `.deb` for Ubuntu/Debian. photoboggan can also **check for updates** on GitHub and verify the installer checksum before launching it (optional, disabled in Offline mode).

---

### Core Strengths

- 📁 **Zero-copy, zero lock-in**
  Works directly on your existing folders on disk—no import step, no proprietary vault, no duplicated library.

- 🛡️ **Your files stay safe (and standard)**
  Only metadata is ever written; image content is never altered. Every write goes through a temporary file and is **verified by reading it back** before the catalog updates.

  - Cross-drive moves are **checksum-verified** before removing originals (toggleable in Settings).
  - Built-in **Integrity Check** scans folders for corrupted files (JPEG, PNG, WebP, HEIC, RAW previews) while generating missing thumbnails in the same pass.
  - Full interoperability with **digiKam, Lightroom, ACDSee, Windows Photos**, and OS file managers: writes standard embedded XMP/IPTC (JPEG), **in-place XMP in HEIC/HEIF**, or `.xmp` sidecars (RAW, PNG, video), with configurable read priority between formats and your choice of **ExifTool** or the **built-in writer**.

- 🔒 **100% local by default, with an explicit Offline Mode**
  Your photos never leave your computer. Online features (map tiles, place search, model downloads, update checks) are strictly opt-in, and flipping **Offline Mode** in Settings blocks all network connections across the app.

- ⚡ **Built for speed at 200k+ photos**
  Smooth scrolling, instant **embedded RAW previews** (no slow CPU demosaicing), **resumable folder scans** (pause anytime and pick up later, even after restarting), and quiet background sync for external changes.

- 🔎 **100% local AI content search & smart tagging** *(optional)*
  Find photos by describing what's in them (*"beach at sunset"*) or by visual similarity to another shot, using the local **SigLIP 2** model.

  - Combine typed keywords and AI matches in one search, and fine-tune results live with a relevance slider.
  - Get **two-way keyword suggestions** from your own vocabulary (suggest tags for a photo, or surface untagged photos matching a keyword)—with exclusions for things like camera gear.
  - Background analysis automatically pauses whenever you're actively working and skips photos whose metadata alone changed.

- 🙂 **Local face detection & recognition** *(optional)*
  Detects faces and suggests people locally (adapting to aging, glasses, and lighting), then writes standard face regions back to your files.

  - Adjust detection/recognition thresholds live without rescanning.
  - **Group similar unknown faces** to name dozens of shots at once, review rapidly from the keyboard, draw missing boxes manually, or merge people safely (with undo).

- 🧬 **3-way Duplicate Finder & "Find the RAW"**
  Search a folder, a selection, or the whole library for:

  - **Identical image data** (ignores metadata changes so re-rated or re-tagged copies are still caught);
  - **Visually similar photos** (handles resizing, rotations, and mirrors while **ignoring burst sequences**);
  - **Matching filenames** (with optional regex key extraction and date matching).
  - Rank groups with your own **"Best Copy"** rules (preferred/avoided paths, pixels, file size, rating, date) to cull duplicates safely.
  - **Find the RAW**: jump from any edited JPEG straight to its matching RAW file (by name pattern, shooting time, gear, and exposure settings).

- 🗺️ **Privacy-first Maps & Geolocation**
  Browse geotagged photos on a map, filter the grid by the visible map area, search places, and geotag selections by dragging them onto the map.

  - **Private Zones**: draw areas (like *Home*) or import offline map files (MBTiles). Any photo inside a private zone forces the map into strict local-only mode so those coordinates are never sent online.
  - **Erase & Restore GPS**: strip coordinates from files before sharing while keeping a restorable local backup.

- ⭐ **Fast daily culling & workflow**

  - **Flexible selection & instant keyboard marking**: 0–5 stars, colors, and pick/reject flags (`Shift`+`P` / `Shift`+`X`), in the grid or fullscreen (`Alt`+key to mark and advance), plus **lossless rotation** and **20-step Undo (`Ctrl+Z`)**.
  - **Side-by-side Compare**: up to 4 photos at once with synchronized or unlinked zoom/pan and per-shot rating or deletion.
  - **Hierarchical keywords, titles & descriptions**: editable tree, staged batch changes (`Unify`, `Ctrl+Enter`) or auto-apply.
  - Apply **author and copyright metadata** quickly with presets
  - **Rich filtering**: combine (or exclude with `Alt`) ratings, colors, picks, keywords, dates/calendar, filenames, people, face count, camera, lens, focal length, shutter speed, aperture, ISO, flash, format, and geolocation.

- 📚 **Virtual & Smart Albums**
  Organize with virtual folders, manual albums (without duplicating files), and **nestable smart albums** based on saved filters—a smart album placed inside another album inherits and refines its parent's rules.

- 🛠️ **Complete toolkit & customizable UI**
  Choose square, framed, **justified** (uncropped), or waterfall layouts; adjustable text, thumbnail, and panel sizes; dark/light themes; fullscreen info overlay; **live histogram & clipped shadows/highlights**; **batch resize** (keeping color profiles, metadata, and rotating face regions to match); per-type **"Open with"**; **Collection Statistics**; slideshow; and a full task queue manager with pause/cancel/ETA.

See [Screenshots](#screenshots) for a closer look.  
Available languages: 🇬🇧 *English* and 🇫🇷 *French* (more welcome!).

---

### License & Disclaimer

Distributed under the **GNU General Public License v3.0** (GPL-3.0). See the [LICENSE](LICENSE) file.

Optional components downloaded on request (never bundled in the installer), under their own licenses:

- **YuNet** (face detection, OpenCV Zoo): MIT License.
- **SFace** (face recognition, OpenCV Zoo): Apache License 2.0.
- **SigLIP 2** (`google/siglip2-base-patch16-224`, ONNX export by `onnx-community`), content search model: Apache License 2.0.
- **ONNX Runtime** (Microsoft), runs the face and content search models: MIT License.

Maps and places:

- Map tiles and style from [OpenFreeMap](https://openfreemap.org) (MIT), vector tiles by [OpenMapTiles](https://openmaptiles.org) (code BSD 3-Clause, design CC BY 4.0), map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). The style is based on `maputnik/osm-liberty` and `openmaptiles/dark-matter-gl-style` (BSD 3-Clause code, CC BY 4.0 design), with Maki icons (CC0) and Noto Sans glyphs (SIL OFL 1.1). Details in [`LICENSES.md`](src-tauri/resources/map-style/LICENSES.md).
- Place search by Nominatim, on OpenStreetMap data (ODbL).

Photos from Lorem Picsum / Unsplash.

Designed and developed by alexh3o, sped up with the precious help of Claude & friends.

---

### Screenshots

![Batch keywording beside the photo grid](webpage/screenshots/main_view_light.jpg "Batch keywording")

*Main View* (navigation, filters, preview & info panels can be enabled or disabled, thumbnails can be resized to a narrow column)

![Faces Review](/webpage/screenshots/faces_review.jpg "Faces Review")

*Faces Review* (after detection and recognition, recognized faces can be confirmed or changed in batches and others set manually)

![Display Options](/webpage/screenshots/display_options.jpg "Display Options")
*Display Options* (dark/light theme, thumbnails size & layout, sorting, group separators...)



![EXIF metadata](/webpage/screenshots/exif_panel.jpg "EXIF metadata")
*EXIF metadata display*

![Thumbnails only](/webpage/screenshots/thumbnails-only.jpg "Thumbnails only")
*Thumbnails only* (scroll with mouse wheel or grab and slide!)

![Fullscreen rating](/webpage/screenshots/fullscreen.jpg "Fullscreen rating")
*Fullscreen* (press R to toggle rating bar, D to toggle photo information)

<table>
  <tr>
    <td><img title="Rating & Color tag panel" src="/webpage/screenshots/labels_panel.jpg" alt="Rating & Color tag panel" height="200" /></td>
    <td><img title="Rating & Color tag bar" src="/webpage/screenshots/labels_bar.jpg" alt="Rating & Color tag bar" height="200" /></td>
  </tr>
</table>

*Edit rating & color tag* for one photo or a selection

![Compare Mode](/webpage/screenshots/compare.jpg "Compare Mode")
*Compare Mode* (zoom them all together, unlink to zoom or move a single one, rate or delete independently)

![Actions & Selection](/webpage/screenshots/selection_actions.jpg "Actions & Selection")
*Flexible selection & Actions* (several groups of consecutive and non-consecutive photos, using `Ctrl` and `Shift` + clicks)

![Batch resizing](/webpage/screenshots/resize_action.jpg "Batch resizing")
*Batch resizing*

![Integrity Check Report](/webpage/screenshots/integrity_check_report_fr.jpg "Integrity Check Report")
*Integrity Check* scans a folder for corrupted files and lets you decide what to do. It generates missing thumbnails at the same time.

![Shortcuts](/webpage/screenshots/shortcuts_guide.jpg "Shortcuts")
*Shortcuts*

<table>
  <tr>
    <td><img title="Rating filters" src="/webpage/screenshots/filters_rating.jpg" alt="Rating filters" height="200" /></td>
    <td><img title="Keywords & filename filters" src="/webpage/screenshots/filters_words.jpg" alt="Keywords & filename filters" height="200" /></td>
    <td><img title="Rating, color tag, filename, keywords and flexible date filters" src="/webpage/screenshots/filters_active_folded.jpg" alt="Rating, color tag, filename, keywords and flexible date filters" height="200" /></td>
  </tr>
</table>

*Flexible filters* (keywords, filenames, ratings, color tags and dates, with a flexible text or calendar input)

<table>
  <tr>
    <td><img title="Folders settings" src="/webpage/screenshots/settings_data.jpg" alt="Folders settings" height="300" /></td>
    <td><img title="Display settings" src="/webpage/screenshots/sort_options.jpg" alt="Display settings" height="300" /></td>
    <td><img title="Open with... settings" src="/webpage/screenshots/settings_private_photos_fr.jpg" alt="Private photos settings" height="300" /></td>
  </tr>
</table>

*Settings* (data folder, sort options,private photos...)

---

<p align="center">
  <a href="#photoboggan">Top</a> | <a href="#screenshots">Screenshots</a>
</p>
