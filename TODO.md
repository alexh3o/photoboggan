# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *docs*: technical documentation
- [x] *feat*: `maps` choose privacy or not on downloaded maps. No further zoom if private
- [ ] *feat*: `maps` additional "get missing maps online" setting if zone is not private
- [x] *feat*: `maps` UI to edit photos location
- [x] *feat*: `maps` add filter with/without geolocation
- [x] *fix*: `map` map widget becomes unreadable on small info panel width, if there are many keywords for instance
- [ ] *refactor*: `maps` offer to write faces when leaving review faces screen
- [x] *fix*: `maps` "la carte ne peut pas s'afficher sur cet ordinateur (webgl indisponible)" (when coming from non offline cached or non geolocated photo to offline available zoned photo, solved by F5)
- [ ] *chore*: `dev` unlink dev and build settings
- [ ] *feat*: virtual albums
- [ ] *feat*: filter albums

## 💡 Ideas / Longer term / On hold

- [ ] *feat*: Find RAW with datetime and camera model
- [ ] *feat*: `Controls` "**Open with**" keyboard shortcuts
- [ ] *feat*: `faces` selectively create a face thumbnail (for low resolution faces, with min resolution setting)
- [x] *chore*: Add **Linux** release
  - [ ] **Test** linux release (more)
- [ ] *fix*: `UI` **resizing app window to a small size** does not go well
- [ ] *perf*: `Safety` improve integrity check - currently gets only 8/11 corrupted sample set
- [ ] *test*: `UI` verify UI on 1080 resolution
- [ ] *feat*: `UI` specific info panel display when multiple photos are selected
- [ ] *fix*: vulnerability npm audit detected by claude

## ⚖️ Undecided

- [x] *feat*: `internet` **Map screen**
- [x] *feat*: `internet` add a **map widget** in info panel
- [ ] *feat*: `internet` check and inform of **available update** on github (on hold, needs official releases)
- [ ] *feat*: `help` app tour
- [ ] *feat*: `faces` resize / move face area
- [ ] *feat*: `maps` add world map download with user chosen level, host on github
- [ ] *fix*:  `maps` imported mbtiles are shaped as rectangles, multizones and shapes are not respected (do not use as private meanwhile)
- [ ] *feat*: find duplicates
- [ ] *feat*: slideshow
- [ ] *feat*: stats
- [ ] *feat*: histogram
- [ ] *feat*: cancellations verywhere

## ❄️ Cold storage

- [ ] *feat*: `metadata` international title and description
- [ ] *feat*: `Controls` **keyboard shortcuts** customizing
- [ ] *feat*: `Controls` Add **mouse settings** screen
- [ ] *feat*: `formats` live photos

## ❌ Ruled out

- [ ] *feat*: `faces` **better resolution for faces** view thumbnails : can be demanding on storage with big collections, goes against staying light principle
- [ ] *feat*: **Image editing**, cropping : not a goal of the app

## 🧪 To be tested & potential bugs to be confirmed

- [ ] Test Linux Release
- [ ] Restoring data from data folder
- [ ] `maps` handling of photos in 2 zones, eventually with different level
