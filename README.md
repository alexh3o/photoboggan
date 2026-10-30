<p align="center">
  <img src="/screenshots/logo256.png" alt="photoboggan" width="128" />
</p>

<h1 align="center">photoboggan</h1>

<p align="center">
  <em>Managing and exploring your photos<br/>Fast and Enjoyable</em>
</p>

---

### Why photoboggan?

photoboggan was created for amateur, family and hobby photo collections, for those who love their photos but don't want to spend too much time on the computer except for watching them again. I regularly use and appreciate the excellent [digiKam](https://www.digikam.org/), but for daily **sorting**, culling **after** a weekend, or simply **browsing** pictures, it often feels a bit heavy and its interface can be somewhat austere.

My photo collection grew to the opposite of my patience to organize an always growing quantity of photos. I wanted a **simple**, **fast** and **pleasant** solution to compare, select, sort, rate and keyword my photos so I can enjoy them after.

**photoboggan** is not designed to have every possible feature, it intends to be and stay reactive and enjoyable.

📖 **[User guide](docs/USER_GUIDE.md)** · 🗺️ [Roadmap (TODO)](TODO.md)

---

### App & Platform Status

⚠️ The application is young and should be considered in <u>beta</u> stage. Use it at your own risk and make sure you **have a healthy, complete backup of your photos**. That said, the safety of photo files is the non-negotiable feature (see below).

- **Windows**: tested, stable and used daily.
- **Linux (.deb)**: tested a bit, seems functional, have a try and tell me!
  - *Known issues*: no trash, cannot move window by title bar
- **macOS & other Linux packages**: not provided yet, but builds can easily be made if testers are interested. Feel free to open an issue!

Downloads are on the [Releases page](https://github.com/alexh3o/photoboggan/releases).

---

### Core Strengths

- 📁 **Zero-copy**: no proprietary library, no import, no duplicate files. It works directly on your existing folders on disk.

- 🛡️ **Files are SAFE**: only metadata is ever written; photoboggan never touches the image data. Every write goes through a temporary file before replacing the original, so a file is never left half-written. Moves between drives are **verified by checksum** before the original is deleted (can be turned off in the settings). An **integrity check** detects corrupted files (JPEG, HEIC, WebP, PNG, RAW).

  💾 And everything is **local, no cloud**: nothing is sent to the internet, and an offline mode blocks even the optional face-model download.

- ⚡ **Built for SPEED**: fast thumbnail generation, then nothing stops you from scrolling as fast as you want. All heavy tasks run in the background without lag.
  **Fast RAW previews**: instead of CPU-heavy demosaicing, the embedded JPEG is extracted in milliseconds. It can be low resolution, but it makes browsing instant.

- ⭐ **ORGANISE (sort, compare, rate, filter, move...)** in a breeze

  - ✅ **Flexible selection**: multiple and non-contiguous photos (`Ctrl` / `Shift` + click), in any order and direction.
  - **Fast keyboard rating**: colors and 0 to 5 stars in a snap with the number keys, in the grid or in fullscreen.
  - ⚖️ **Side-by-side comparison**: up to 4 photos at once, with synchronized or unlinked zoom/pan. Rate or delete per shot.
  - **Filter** by rating, color, keywords, dates, filenames, people.

- 🏷️ **Hierarchical keywords, titles and descriptions**: build an editable keyword tree, tag one photo or a whole selection, and write them to the files when you are ready. Keywords are read and written in the formats used by digiKam, Lightroom, ACDSee, Microsoft and Media Pro, with their order of priority being configurable.

- 🙂 **People (face recognition)**: optional, 100% local. Faces are detected and suggested, you confirm or correct them, then write them to the files as standard face regions. Filter your collection by person.

- 🔁 **Interoperability, leave anytime**: ratings, color labels, keywords, titles and faces are written in standard embedded XMP/IPTC (JPEG), or in companion `.xmp` sidecars for RAW, PNG and other files that can't hold metadata. Your changes are recognized by digiKam, Lightroom and the OS file manager. Writing is done by the embedded [ExifTool](https://exiftool.org) or by an internal writer, at your choice.

- 🖥️ **Flexible UI**: choose text, thumbnails and panels size, thumbnails layout (square, justified, masonry), the panels to display, fullscreen infos or an unobstructed view. Dark or light theme.

- 🛠️ **Comprehensive toolkit**: batch resizing, moving and copying, "open with" your chosen external programs, EXIF viewer, clipboard support, system trash integration, exhaustive shortcuts (with a built-in guide)...

See <a href="#screenshots">Screenshots</a> for more detail.

Available languages: 🇬🇧 *English* and 🇫🇷 *French*, more to come if there is interest.

---

### License & Disclaimer

Distributed under the **GNU General Public License v3.0** (GPL-3.0). See the [LICENSE](LICENSE) file.
Photos from Lorem Picsum / Unsplash.

Designed and developed by alexh3o, sped up with the precious help of Claude & Gemini.

---

### Screenshots

![/ima](/screenshots/faces_review.jpg)

*Faces Review* (after detection and recognition, recognized faces can be confirmed or changed in batches and others set manually)

![Display Options](/screenshots/display_options_en.jpg "Display Options")
*Display Options* (dark/light theme, thumbnails size & layout, sorting, group separators...)

![Main View](/screenshots/main_view_complete.jpg "Main View")
*Main View* (navigation, filters, preview & info panels can be enabled or disabled, thumbnails can be resized to a narrow column)

![EXIF metadata](/screenshots/exif_panel.jpg "EXIF metadata")
*EXIF metadata display*

![Thumbnails only](/screenshots/thumbnails-only.jpg "Thumbnails only")
*Thumbnails only* (scroll with mouse wheel or grab and slide!)

![Fullscreen rating](/screenshots/fullscreen-rating.jpg "Fullscreen rating")
*Fullscreen rating* (press R to toggle rating bar, D to toggle photo information)



<table>
  <tr>
    <td><img title="Rating & Color tag panel" src="/screenshots/labels_panel.jpg" alt="Rating & Color tag panel" height="200" /></td>
    <td><img title="Rating & Color tag bar" src="/screenshots/labels_bar.jpg" alt="Rating & Color tag bar" height="200" /></td>
  </tr>
</table>

*Edit rating & color tag* for one photo or a selection

![Compare Mode](/screenshots/compare.jpg "Compare Mode")
*Compare Mode* (zoom them all together, unlink to zoom or move a single one, rate or delete independently)

![Actions & Selection](/screenshots/selection_actions.jpg "Actions & Selection")
*Flexible selection & Actions* (several groups of consecutive and non-consecutive photos, using `Ctrl` and `Shift` + clicks)

![Batch resizing](/screenshots/resize_action.jpg "Batch resizing")
*Batch resizing*

![Integrity Check Report](/screenshots/integrity_check_report_fr.jpg "Integrity Check Report")
*Integrity Check* scans a folder for corrupted files and lets you decide what to do. It generates missing thumbnails at the same time.

![Shortcuts](/screenshots/shortcuts_guide.jpg "Shortcuts")
*Shortcuts*

<table>
  <tr>
    <td><img title="Rating filters" src="/screenshots/filters_rating.jpg" alt="Rating filters" height="200" /></td>
    <td><img title="Keywords & filename filters" src="/screenshots/filters_words.jpg" alt="Keywords & filename filters" height="200" /></td>
    <td><img title="Rating, color tag, filename, keywords and flexible date filters" src="/screenshots/filters_active_folded.jpg" alt="Rating, color tag, filename, keywords and flexible date filters" height="200" /></td>
  </tr>
</table>

*Flexible filters* (keywords, filenames, ratings, color tags and dates, with a flexible text or calendar input)

<table>
  <tr>
    <td><img title="Folders settings" src="/screenshots/settings_data_en.jpg" alt="Folders settings" width="300" /></td>
    <td><img title="Display settings" src="/screenshots/settings_display.jpg" alt="Display settings" width="300" /></td>
    <td><img title="Open with... settings" src="/screenshots/settings_openwith_en.jpg" alt="Open with... settings" width="300" /></td>
  </tr>
</table>

*Settings* (data folder, photo folders, external programs, language, display...)

---

<p align="center">
  <a href="#photoboggan">Top</a> | <a href="#screenshots">Screenshots</a>
</p>
