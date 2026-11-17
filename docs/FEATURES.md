# Spirit

I've been taking photos as a passionnate amateur and then a passionate dad for 25 years. To me, photos need to be organized & prepared before entering a collection so they can be found again, but this is a repetitive & time consuming process. Ideally, computer time should be spent more for enjoying & exploring your photo collection than working on it.

So photoboggan was made for the hobbyist and family photographer to be

- **smooth**, no feature was allowed to have an impact on fluidity

- **photos first** visually: unobstructed views, no distracting effects

- **flexible UI** organization

- respectful of your **privacy**

- capable of handling 200k+ photo collections

- fastest workflow to **enter photos in an organized collection**

  - rate & cull

  - face tag

  - geotag

- Fastest possible UI to **view and find** your photos

- **File safety**

  - **atomic writings** for metadata writes

  - error handling (restore initial file, warn if restoring cannot be done so you manually rename the ".tmp" original stuck file)

  - **image part of the files is never touched, written, recompressed**, photoboggan only edits metadata parts of files

  - warnings or blockers during file/folder operations in cases of existing files, invisible files...

- more serious than its name suggests

# Features

- Fast scrolling by mouse, hold and release

- Faces (optional, disabled by default)

  - Detection with YuNet, 100% local AI

  - Recognition with SFace, 100% local AI, with multi centroids per person to accomodate with age variation through life

- Maps (optional, disabled by default):

  - See your photos on a map

  - Drop photos on the map to add them geolocation

  - Download map zones to cache them, so no provider sees your repeated calls for tiles afterwards

  - Erase geolocation

- Content analysis with SigLIP, optional & 100% local AI (disabled by default, needs a initial scan - a few hours for 100k+ photos)

  - Scan photos to enter their content in database

  - Search by text

  - Find similar images (same place, same type of photo, same mood...)

  - Suggests keywords by looking at similar photos that are keyworded

- Duplicates search (needs an initial scan to calculate phash)

  - Exact duplicates (same file)

  - Very similar looking photo

- File operations

  - Batch resize to folder

  - Batch copy

  - Batch rotate (lossless, through metadata as image fileparts are never modifeid by photoboggan)

  - Renaming (batch renaming to come)

  - Show in OS explorer

  - Show in its folder (when view from albums / search results, whole collectioon views)

- Private Photos feature: quickly hide/unhide photos by user chosen criteria sets that can cumulated, so you avoid embarassing yourself

  - Path folders or strings in paths

  - keywords

  - date ranges

- Open with and editable list of applications, user determined by file type (Raster / RAW / Video)

- Integrity check scan to check files for potential corruption

- Quickly attribute rate (stars), color label, pick flag with rating bars, skeyboard shortcuts, possible automatic advance...

- Filter your collection by

  - filename & file format

  - keywords (presence or absence)

  - location (though visible map)

  - rating, color & pick labels

  - Exposure settings: aperture, shutter speed, iso speed, focal length, flash

  - Gear: camera, lens

  - Author

  - People in the photo

  - Date ranges with a calendar pick or a fast and flexible direct date range input

- See mutliple image formats including RAW (embedded jpegs only) and videos (OS thumbnail only, no fullscreen in-app)

- Find RAW file matching your jpeg, with tunable settings to match your personal organization

- Everything happens almost instantly after initial chores (first scan, thumbnail generation, content analysis, face detection) - except integrity scan

- Flexible UI, every screen (main view, map mode, people and faces review modes - not fullscreen) can enable/disable

  - photo info / keywords / description panel

  - library & filters panel

  - preview panel

  - toolbar

- Flexible display, choose

  - thumbnails layout (masonry, justified, square cropped)

  - thumbnails size and spacing

  - sorting criteria (date taken, modified, filename)

  - dark or light theme

  - text fonts

  - sizing of text and elements

  - size of any panel

  - emphasize selection on hover by darkening other photos

- Shortcuts everywhere

- **Fast keywording workflow**, possible by batch while respecting untouched keywords

- Batch add **author and copyright info, quickly create and recall author presets**

- Handles 200k+ photo collection, thanks to

  - 50k max thumbnails pagination,

  - SQLite database

  - 256 subfolders thumbnail caching

  - Rust backend, pure vanilla JS frontend

- **Priority to UI responsiveness**, all significant operations are queued and at low priority

- **Task queue** for longer operations

- **Fast and sure face recognition processing screen**

  - Recognized faces sorted by algorithm certainty so you know when to focus

  - Recognition learns and adjusts instantly from your picks

  - Go fast with batch operations on faces, keyword shorcuts

  - Always have access to photo preview to put faces in context

- **Metadata writting embedded in files**, to choose between

  - with exiftool, recommended as it is the gold standard and can write into all formats (XMP, IPTC, EXIF)

  - with internal writer, faster and native, but limited to XMP & IPTC (some EXIF writings can present risk for file integrity, and therefore are never written or erased at the moment - )

- **Metadata read from main formats (IPTC/EXIF/XMP) and schemes** (digikam, lightroom, microsoft...) with user editable reading priority

- **Preview and fullscreen photo views with instant 1:1 zoom & pan**, gradual zoom and optional face visualization, histogram, highlight / shadow clippings, optional info display

- **Compare** mode for 2 to 4 photos with synchronized zoom & pan, which can be desyncrhonized at any time, easy subselection to rate or delete

- **Flexible controls to allow fast and massive selections**: combine and chain multiple Ctrl or Shift + Clicks in any direction to add individaul photos or multiple groups of photos

- Choose database, thumbnails, private maps **storage location** (choose a SSD!)

- User chosen thumbnails cache resolution (higher is better for face review workflow ease)

- **Offline mode** can be enabled so connection is ever made to the outside, while still allowing all core features by a manual download of

  - AI models for faces 

  - AI model for content analysis and search

  - Map files can be downloaded

- In app shortcut guide & tools information through tooltips

- Automatic version update availability check (except in Offline Mode)

- Slideshow

- Collection **statistics**, see your photos in numbers through gear, exposure settings, date ranges, ratings, time...

- **Virtual albums**

  - Manual: user picked photos

  - Smart: dynamically evolving thanks to filters

  And smart albums can be nested into other albums, smart or manual, to filter down more
