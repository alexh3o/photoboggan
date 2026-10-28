

<p align="center">
  <img src="/screenshots/logo256.png" alt="photoboggan" width="128" />
</p>

<h1 align="center">photoboggan</h1>

<p align="center">
  <em>Managing and exploring your photos<br/>Fast and Enjoyable</em>
</p>

---

### Why photoboggan?

photoboggan was created for amateur, family and hobby photo collections, for those who love their photos but don't want to spend too much time on the compuer except for watching them again. I regularly use and appreciate the excellent [digiKam](https://www.digikam.org/), but for daily **sorting**, culling **after** a weekend, or simply **browsing** pictures, it often feels a bit heavy and its interface can be somewhat austere.

My photo collection grew to the opposite of my patience to organize an always growing quantity of photos. I wanted a **simple**, **fast** et **pleasant** solution to compare, select, sort, rate my photos so I can enjoy them after.

**photoboggan** 
is not designed to have every possible feature,
it intends to be and stay reactive and enjoyable

---

### App & Platform Status

⚠️ First, a word of warning: application is young should be considered in <u>beta</u> stage. Therefore, use at your own risk and ensure you **have a healthy complete backup of your photos**. That said, safety of photos is of course the non negotiable feature (see below).

- **Windows**: tested, stable and used daily.
- **Linux (.deb)**: Tested a bit, seems functional, have a try and tell me !
  - *Know issues*: no trash, cannot move window by title bar
- **macOS & other Linux packages**: Not provided by default yet, but builds can easily be made if testers are interested—feel free to open an issue!

The [TODO](TODO.md) list can give you an idea of the path ahead.

My focus is currently on keywords edition.

---

### Core Strengths

- 📁 **Zero-copy**: No proprietary library or duplicate files. It works directly on your existing folders on disk.

- 🛡️ **Files are SAFE**: during write operations, only metadata is modified; Photoboggan never touches the image data. Files are modified via a temporary file before being atomically replaced, ensuring foolproof writes. Furthermore, an **integrity check** can be launched to detect corrupted files (JPEG, HEIC, WebP, PNG, RAW).

  And all is💾 **Local, no clouds**: nothing is sent to the internet.

- ⚡ **Built for SPEED**: fast thumbnail generation and once it's done nothing stops you from scrolling as fast as you want. All tasks are handled so they don't induce lag or slowness.
  **Fast RAW previews**: Instead of CPU-heavy demosaicing, embedded JPEG is extracted in milliseconds. It can be low resolution, but it makes browsing instant.

- ⭐ **ORGANISE (Sort, compare, rate, filter, move...)** in a breeze

  - ✅ **Large-Scale FLEXIBLE SELECTION**: select multiple and non-contiguous photos (`Ctrl` / `Shift` + click), in any order & navigation direction.
  - **Fast keyboard rating**: Assign colors and  0 to 5 stars in a snap using number keys (`0`–`5`), in the grid or in fullscreen.
  - ⚖️ **Side-by-side COMPARISON**: Compare up to 4 photos at once (with synchronized or unlinked zoom/pan). Rate or delete per shot.
  - **Filter** by ratings, keywords, dates, filenames

- 🔁 **Interoperability, leave anytime**: Ratings and color flags are written directly into standard embedded JPEG XMP or companion `.xmp` sidecars for RAWs and files not supporting extra embedded metadata. Your changes are immediately recognized by digiKam, Lightroom, and OS file manager.

- 🖥️ **FLEXIBLE UI**: Choose text, thumbnails & panels size, thumbnails layout, panels to display, fullscreen infos or unobstructed view. Use the app in immersive fullscreen mode, in dark or light mode.

- 🛠️ **Comprehensive Toolkit**: Batch resizing, moving & copying, "open with" your chosen external programs, EXIF data viewer, clipboard support, system trash integration, exhaustive shortcuts...

See <a href="#screenshots">Screenshots</a> for some more detail.

Available languages are 🇬🇧 *english* and 🇫🇷 *french*, more to come if there is interest.

---

### License & Disclaimer

Distributed under the **GNU General Public License v3.0** (GPL-3.0). See the [LICENSE](LICENSE) file.
Photos from Lorem Picsum / Unsplash

Designed and developed by alexh3o, sped up with the precious help of Claude & Gemini.

</div>

---

### Screenshots

</div>

![test](/screenshots/display_options_en.jpg "Display Options")
*Display Options* (dark/light theme, thumbnails size & layout, sorting, group separators...)

![test](/screenshots/main_view_complete.jpg "Main View")
*Main View* (navigation, filters, preview & info panels can be enabled or disabled, thumbnails can be resized to a narrow column)

![test](/screenshots/exif_panel.jpg "EXIF metadata")
*EXIF metadata display*

![test](/screenshots/thumbnails-only.jpg "Thumbnails only")
*Thumbnails only* (scroll with mouse wheel or grab and slide !)

![test](/screenshots/fullscreen-rating.jpg "Fullscreen rating")
*Fullscreen rating* (press R to toggle rating bar, D to toggle photo information)

![test](/screenshots/rating_edition.jpg "Compare Mode")
*Edit rating & color tag* for one photo or a selection

![test](/screenshots/compare.jpg "Compare Mode")
*Compare Mode* (zoom them alltogether, unlink to zoom or move into a single one, rate or delete independently)

![Actions & Selection](/screenshots/selection_actions.jpg "Actions & Selection")
*Flexible selection & Actions* (selection can be done very flexibly with several pans of consecutive & non consecutive photos, using ctrl and shift + clicks)

![Batch resizing](/screenshots/resize_action.jpg "Batch resizing")
*Batch resizing*

![Integrity Check Report](/screenshots/integrity_check_report_fr.jpg "Integrity Check Report")
*Integrity Check* can scan a folder for corrupted files and let you decide what to do.  And it generates missing thumbnails at the same time.

![Shortcuts](/screenshots/shortcuts_guide.jpg "Shortcuts")
*Shortcuts*

<table>
  <tr>
    <td><img title="Rating filters" src="/screenshots/filters_rating.jpg" alt="Rating filters" height="200" /></td>
    <td><img title="Keywords & filename filters" src="/screenshots/filters_words.jpg" alt="Keywords & filename filters" height="200" /></td>
    <td><img title="Rating, color tag, filename, keywords and felxible date filters" src="/screenshots/filters_active_folded.jpg" alt="Rating, color tag, filename, keywords and felxible date filters" height="200" /></td>
  </tr>
</table>

*Flexible filters* (filter on keywords, filenames, ratings, color tags and dates with a flexible text or calendar input)

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
  <a href="#english">Top</a> | <a href="#screenshots">Screenshots</a>
</p>