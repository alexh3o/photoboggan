# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line / Done

- [x] *fix*: `linux` deb update download works but opening the download with app manager does nothing
- [x] *fix*: `linux` deb update downloads to random folder instead of user's download folder
- [x] *feat*: `theme` option to follow system theme, enabled by default
- [x] *FEAT*: `list` list panel
- [x] *fix*: `fullscreen` V&H keys toasts are not displayed in fullscreen
- [x] *chore*: `locales` prepare code and add recipes to ease adding more locales later
- [x] *feat*: `locales` add spanish language
- [x] *docs*: `build` add source compilation instructions in README & BUILDING docs
- [x] *fix*: `locales` In french and spanish, "lancer/iniciar" is used instead of "début/inicio" in renaming modal, as english only needed one "start" key for both
- [x] *feat*: `filters` have map zone filter appear and be treated as a normal filter
- [x] *feat*: `thumbnail` option to add a visual badge on RAW files thumbnails
- [x] *feat*: `filters` accept keywords children even if the chosen one is not active
- [x] *feat*: `filters` add option to always include children in positive/negative keywords, and Ctrl key to disable it when entering new keyword
- [x] *refactor*: `histogram` allow clipping shadow/highlights display independantly of histogram display
- [x] *chore*: `language` add a recipe for languages implementation
- [x] *PERF*: `grid` accelerate thumbnails grid display when changing folders
- [x] *refactor*: `bundles` only one multilingual msi for windows instead of one per language
- [x] *chore*: `maintenability` reduce main.js size by export of parts to fullscreen.js, folder-tree.js, find-raw-mode.js, semantic-results.js, duplicates-view.js, drag-drop.js, preview-zoom.js, task-queue.js
- [x] *feat*: `lists` add format entries with resolution, orientation, ratio (1:1; 6:7; 4:3; 3:2; 16:10; 16:9 or ratio value if doesn't fit to 1%)
- [x] *refactor*: `metadata` remove internal writer for safety and ease of maintenance
- [x] *fix*: `metadata` show action from metadata fail dialog doesn't work if view has changed
- [x] *fix*:  `metadata` inform user when failed gps/title/description is due to this data remaining in a sidecar xmp

## 💡 Ideas / Longer term / On hold / Secondary

- [ ] *feat*: `metadata` **lens metadata writing** (for manual / old lenses) with autocompletion
- [ ] *feat*: `metadata` **exif time shift** (to fix bad camera settings afterwards)
- [ ] *feat*: `scripts` **user scripts/recipes** (launch integration with selected scans and actions, ex: integrity + thumbs + faces + phash + content analysis)
- [ ] *feat*: `grid` option to hide RAW by default
- [ ] *feat*: `applications` handle open with programs for selections with multiple photos (scripts...)
- [ ] *fix*: `toasts` blurry toasts when a modal is on top
- [ ] *fix*: `duplicates` similar images search (phash) seems stuck on big collections by lack of user info
- [x] *feat*: `undo` better ctrl+z info
- [ ] *fix*: `metadata` xmp sidecars are not synced as image embedded metadata when modified
- [ ] *feat*  `metadata` handle xmp sidecar leftovers (except if sidecar writing is implemented and active)
- [ ] *feat*: `metadata`allow writing to xmp sidecar

## ⚖️ Undecided

- [ ] *feat*: `help` app tour
- [ ] *feat*: `collection` add "scan for new items" to accelerate discovery of new elements
- [ ] *feat*: `UI` conditional clickable path line (breadcrumb) on top when left panel is closed
- [ ] *feat*: `files` prevent deletion of photos with stars
- [ ] *feat*: `files` **sd card** import
- [ ] *feat*: `UI` specific info panel display when multiple photos are selected
- [ ] *refactor*: `semantic` allow larger scores

## ❄️ Cold storage

- [ ] *feat*: `metadata` international title and description
- [ ] *feat*: `faces` selectively create a face thumbnail (for low resolution faces, with min resolution setting)
- [ ] *feat*: `formats` live photos
- [ ] *fix*:  `maps` imported mbtiles are shaped as rectangles, multizones and shapes are not respected => precision improved but not 100% fixed,  do not use as private meanwhile
- [ ] *feat*: `duplicates` manage duplicates folder actions like in dupeguru
- [ ] *perf*: `Safety` improve integrity check - currently gets 10/11 corrupted sample set: solution known but with maintenance impact
- [ ] *feat*: `people` return button when going into someone's photos from its badge: people button does it
- [ ] *feat*: `thumbnails` option to keep loading folder thumbnails out of sight
- [ ] *fix*: `tree` reordering root folders with grips in settings sometimes leaves them pending and needing a click confirmation => that's when dropping with the mouse pointer out of the reorder drag n drop zone
- [ ] *fix*: `keywords` fail to write keyword => to be reproduced

## ❌ Ruled out

- [ ] *feat*: `faces` **better resolution for faces** view thumbnails : can be demanding on storage with big collections, goes against staying light principle
- [ ] *feat*: `editing` **Image editing**, cropping : not a goal of the app
- [ ] *fix*: `dev` vulnerability npm audit detected by claude: dev problem only
- [ ] *feat*: `maps` add world map download with user chosen level, host on github: lower levels are already taken with mbtiles, so it's less useful
- [ ] *feat*: `faces` resize / move face area => just delete and add again
- [ ] *feat*: `Controls` **keyboard shortcuts** and **mouse controls** customizing: adds code & user support complexity
- [ ] *feat*: `Controls` Add **mouse settings** screen

---

# Tests & Notes

## 🧪 To be tested & potential bugs to be confirmed

- [ ] `linux` Test Linux Release
- [ ] `backup` restoring data from data folder
- [ ] `thumbnails` Some thumbnails don't load, but passing mouse over them instantly displays them: dev only ?
