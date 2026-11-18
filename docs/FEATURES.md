# Vision

I've been taking photos as a passionate amateur and then a passionate dad for 25 years. To me, photos need to be organized & prepared before entering a collection so they can be found again, but this is a repetitive & time consuming process. Ideally, computer time should be spent more for enjoying & exploring your photo collection than working on it.

So photoboggan is made for the hobbyist and family photographer and intends to be (or offer):

- **Smooth**: no feature was allowed to impact fluidity
- **Photos first** visually: unobstructed views, no distracting effects
- **Flexible UI** organization 
- Respectful of **privacy**
- Capable of handling **200k+ photo collections**
- Fastest workflow to **enter photos in an organized collection**
  - Rate & cull
  - Face tag
  - Geotag
- Fastest possible UI to **view and find** your photos
- **Safe for the photo files**
  - **Atomic writes** for metadata edits
  - **Error handling & recovery** (restores the initial file, warns if restoring cannot be done so you can manually recover the temp file)
  - **Image pixel data is never touched, written, or recompressed** — photoboggan only edits metadata parts (or sidecars)
  - Warnings or blockers during file/folder operations (existing files, trashless drives, hidden private photos...)
- More serious than its name suggests

---

# Features

## Browsing, Viewing & Formats

- **200k+ photo collections**, staying nearly instant after initial indexing thanks to:
  - 50k max thumbnails pagination
  - SQLite (WAL) database
  - 256-subfolder thumbnail caching
  - Rust backend & pure vanilla JS frontend
- **Multiple formats**: standard raster images, **HEIC/HEIF**, **RAW** (embedded JPEGs only, never demosaiced), and **videos** (OS/ffmpeg thumbnail only, no in-app fullscreen playback)
- **Fast mouse scrolling** (mousewheel or hold and release) with scroll position indicator
- **Preview & fullscreen views** with instant 1:1 zoom & pan, gradual zoom, optional face boxes, **histogram**, **highlight/shadow clippings**, and optional info overlay
- **Compare mode** for 2 to 4 photos with synchronized zoom & pan (toggleable anytime) and direct sub-selection to rate or delete
- **Slideshow** with configurable options
- **Find RAW** matching your JPEG, with tunable pattern rules to fit your folder organization
- **Disk synchronization** at startup, on window focus, and lazily when missing files are encountered

## Selection, Rating & Culling

- **Flexible massive selections**: combine and chain multiple `Ctrl` or `Shift` + Clicks in any direction to add individual photos or multiple ranges
- **Fast rating & culling**: star rating, color labels, and pick/reject flags via rating bars, keyboard shortcuts, and optional auto-advance
- Emphasize selection on hover by optionally darkening unselected photos

## Organization: Folders, Albums & Keywords

- **Virtual albums**:
  - Manual albums (user-picked photos)
  - Smart albums (dynamically updated from saved filter criteria)
  - Virtual folders to organize albums
  - **Nested smart albums** inside manual or smart albums to filter down further
- **Fast keywording workflow**: hierarchical keyword tree with batch editing that respects untouched keywords on individual photos
- **Title & description** editing (single or batch)
- **Batch author & copyright info**, with quick creation and recall of author presets
- Quick search directly inside the Folders, Albums, and People sidebar blocks

## Filtering & Search

- **Multi-criteria filtering** (with include/exclude tags and autocomplete):
  - Filename & file format
  - Keywords (presence or absence)
  - Location (visible map bounds)
  - Rating, color label & pick flag
  - Exposure settings: aperture, shutter speed, ISO, focal length, flash
  - Gear: camera & lens
  - Author
  - People in the photo
  - Date ranges via calendar picker or fast & flexible direct date-range input
- **Content analysis & search** with **SigLIP 2** *(optional, 100% local AI, disabled by default; requires an initial scan — a few hours for 100k+ photos)*:
  - Natural-language **text search** (with relevance cut slider)
  - **Find similar images** (same place, type of photo, mood...)
  - **Keyword suggestions** based on similar keyworded photos (remembering rejected suggestions)
- **Duplicate & similar photo search** *(requires initial pHash/hash scan)*:
  - **Exact duplicates** (same pixel data, metadata excluded)
  - **Very similar photos** (perceptual hash, with optional burst exclusion)
  - **Duplicates by filename**

## People & Faces *(optional, 100% local AI, disabled by default)*

- **Detection with YuNet** and **recognition with SFace**, supporting multiple centroids per person to accommodate age variation through life
- **Fast, reliable face review workflow**:
  - Recognized faces sorted by algorithm certainty so you know where to focus
  - Recognition learns and adjusts instantly from your confirmations
  - Batch operations & keyboard shortcuts
  - Available photo preview panel to keep faces in context
- **Group unknown faces** automatically (clustering) and draw **manual face regions**
- Person aliases, cover photos, undoable person merges, and conflict resolution when syncing people with keywords

## Maps & Geolocation *(optional, disabled by default)*

- View geotagged photos on an interactive map (with bundled light/dark styles)
- **Drag & drop** photos onto the map to geotag them
- **Place search** *(when online)*
- **Erase geolocation** (with local backup in the catalogue to allow restore)
- **Download map zones** into local caches (MBTiles) so providers never see repeated tile requests
- **Private zones**: strictly offline map tiles that never fall back to remote tile providers

## Privacy ("Private Photos")

- Quickly hide/unhide photos across the entire app (grid, counts, albums, duplicates, faces) without modifying files on disk
- Cumulative, user-defined criteria sets combining:
  - Folder paths or substrings in paths
  - Keywords
  - Date ranges
- Optional **shield lock** to prevent quick toggling outside Settings
- Safety blocker preventing folder deletion while privacy sets are active

## Metadata Engine & File Safety

- **Embedded metadata writing**, selectable between:
  - **ExifTool** (recommended & default): writes XMP, IPTC, and EXIF across formats
  - **Internal native writer**: faster Rust writer limited to XMP & IPTC (never writes/erases risky EXIF tags)
- **Metadata reading** across major standards (EXIF, IPTC, XMP) and schemas (digiKam, Lightroom, Media Pro, Microsoft, ACDSee...) with user-editable per-field reading priority
- **Safe sidecar targeting** (avoids overwriting shared sidecars in RAW+JPEG / RAW+DNG pairs, logs conflicts)
- **Atomic writes**, **post-write verification** (every write is re-read and checked), and **ExifTool failure recovery** with detailed logs
- Full metadata inspector & file-dates details

## File Operations & Maintenance

- **Batch copy & move** (via dialogs or drag-and-drop onto folders, carrying sidecars safely and optionally verifying cross-drive moves)
- **Batch resize** to a folder
- **Batch lossless rotation** (no recompression, via orientation metadata only; pixel data is never modified)
- **Undo** support for quick corrections)
- **Renaming** *(batch renaming to come)*
- **Delete to OS trash** (with upfront warnings when a drive has no trash and deletion will be permanent)
- **Open with**: editable list of external apps per file type (Raster / RAW / Video)
- **Show in OS explorer** and **Show in its folder** (from albums, search results, or whole-collection views)
- **Integrity check scan** to detect corrupted files
- **Collection statistics**: explore your library by gear, exposure settings, date ranges, ratings, and time

## Interface, Performance & Offline Control

- **Flexible workspace** on every screen (main, map, people, and face review views — except fullscreen): toggle and resize the info/keywords/description panel, library/filters panel, preview panel, and toolbar
- **Flexible display**: masonry, justified, or square-cropped thumbnails; adjustable size & spacing; sort by date taken, modified, or filename; dark or light theme; custom fonts, UI/text scaling, selection/button colors
- **Shortcuts everywhere**, with an **in-app shortcut guide** and informative tooltips
- **UI responsiveness first**: all heavy operations run at low priority in a cancellable/pausable **task queue** (with background content analysis auto-pausing for foreground tasks)
- **Customizable storage location** for database, thumbnails, previews, models, and offline maps (choose an SSD!), plus configurable thumbnail cache resolution & quality
- **100% Offline mode**: blocks all outbound requests while keeping all core & AI features usable via manual import of face models, content analysis models, and map zones
- **In-app update checker** with SHA-256 verified downloads *(disabled in Offline mode)*
- Available in **English and French** (Windows & Linux)
