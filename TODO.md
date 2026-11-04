# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *docs*: technical documentation
- [x] *refactor*: `faces` offer to write faces when leaving review faces screen
- [ ] *chore*: `dev` unlink dev and build settings
- [x] *feat*: add option to remove star ratings when copying or resizing, enabled by default (exiftools only)
- [x] *fix*: map doesn't load, photo locations still placed
- [x] *feat*: `maps` embed default map style
- [x] *refactor*: `maps` rearrange settings modal with new maps tab
- [x] *fix*: `UI` mask uncomplete display (text only flash before UI loads)

## 💡 Ideas / Longer term / On hold

- [ ] *feat*: Find RAW with datetime and camera model
- [ ] *refactor*: `UI` group manufacturer and model in camera on side panel metadata
- [x] *feat*: `Controls` "**Open with**" keyboard shortcuts
- [ ] *feat*: `faces` selectively create a face thumbnail (for low resolution faces, with min resolution setting)
- [x] *chore*: Add **Linux** release
  - [ ] **Test** linux release (more)
- [ ] *fix*: `UI` **resizing app window to a small size** does not go well
- [ ] *perf*: `Safety` improve integrity check - currently gets only 8/11 corrupted sample set
- [ ] *test*: `UI` verify UI on 1080 resolution
- [ ] *feat*: `UI` specific info panel display when multiple photos are selected

## ⚖️ Undecided

- [ ] *feat*: `internet` check and inform of **available update** on github (on hold, needs official releases)
- [ ] *feat*: `help` app tour
- [ ] *feat*: `faces` resize / move face area
- [ ] *feat*: find duplicates
- [ ] *feat*: slideshow
- [ ] *feat*: stats
- [ ] *feat*: histogram
- [ ] *feat*: cancellations everywhere
- [ ] *feat*: internal metadata writer activated => no exif reading
- [ ] *fix*:  `maps` imported mbtiles are shaped as rectangles, multizones and shapes are not respected (do not use as private meanwhile)
- [ ] *refactor*: `UI` improve toasts placement / visibility

## ❄️ Cold storage

- [ ] *feat*: `metadata` international title and description
- [ ] *feat*: `Controls` **keyboard shortcuts** customizing
- [ ] *feat*: `Controls` Add **mouse settings** screen
- [ ] *feat*: `formats` live photos

## ❌ Ruled out

- [ ] *feat*: `faces` **better resolution for faces** view thumbnails : can be demanding on storage with big collections, goes against staying light principle
- [ ] *feat*: **Image editing**, cropping : not a goal of the app
- [ ] *fix*: vulnerability npm audit detected by claude: dev problem only
- [ ] *feat*: `maps` add world map download with user chosen level, host on github: lower levels are already taken with mbtiles, so it's less useful

## 🧪 To be tested & potential bugs to be confirmed

- [ ] Test Linux Release
- [ ] Restoring data from data folder
- [ ] `maps` handling of photos in 2 zones, eventually with different level
- [ ] Check effect of 50000 max photos in the grid: is it visible in usage ?
