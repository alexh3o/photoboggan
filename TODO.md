# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [x] *feat*: `metadata` manage pick label optionnaly
- [x] *feat*: `faces` allow always show faces in faces review preview
- [x] *fix*: `metadata` delete xmp sidecars when deleting file
- [x] *refactor*: `faces` group "undo the merge of"
- [x] *fix*: RAW portrait orientation issues in thumbnail and/or preview and/or fullscreen
- [x] *refactor*: `files` copy silently creates second copy if filename exists
- [x] *feat*: `files` rename file
- [x] *feat*: `faces` more action on various views for faces
- [ ] *docs*: technical documentation
- [x] *feat*: `faces` add "add a face" context menu, with a toast indicating to start drawing a rectangle
- [x] *feat*: `faces` add faces display options in context menu
- [x] *feat*: `faces` option to display areas of ignored and not a face, in context menu
- [x] *feat*: `UI` option to display files quantity in folder tree
- [x] *refactor*: `UI` design critique of keywords context menu
- [x] *feat*: `maps` choose privacy or not on downloaded maps. No further zoom if private
- [ ] *feat*: `maps` additional "get missing maps online" setting if zone is not private
- [ ] *feat*: `maps` UI to edit photos location
- [x] *feat*: `maps` add filter with/without geolocation
- [ ] *fix*: `map` map widget becomes unreadable on small info panel width, if there are many keywords for instance
- [ ] *refactor*: `maps` offer to write faces when leaving review faces screen
- [ ] *fix*: `maps` "la carte ne peut pas s'afficher sur cet ordinateur (webgl indisponible)" (when coming from non offline cached or non geolocated photo to offline available zoned photo, solved by F5)
- [ ] *chore*: `dev` unlink dev and build settings

## 💡 Ideas / Longer term / On hold

- [x] *style*: `UI` make star rating filter in filters more visual
- [ ] *feat*: `Controls` "**Open with**" keyboard shortcuts
- [ ] *feat*: `faces` selectively create a face thumbnail (for low resolution faces, with min resolution setting)
- [x] *chore*: Add **Linux** release
  - [x] *fix*: **No trash** available (but it mentions deletion is definitive)
  - [x] *fix*: **Cannot move window** by title bar
  - [ ] **Test** linux release (more)
- [ ] *fix*: `UI` **resizing app window to a small size** does not go well
- [ ] *perf*: `Safety` improve integrity check - currently gets only 8/11 corrupted sample set
- [ ] *test*: `UI` verify UI on 1080 resolution
- [ ] *feat*: `UI` specific info panel display when multiple photos are selected*
- [ ] *fix*: vulnerability npm audit detected by claude

## ⚖️ Undecided

- [ ] *feat*: `internet` **Map screen**
- [x] *feat*: `internet` add a **map widget** in info panel
- [ ] *feat*: `internet` check and inform of **available update** on github (on hold, needs official releases)
- [ ] *feat*: `help` app tour
- [ ] *feat*: `faces` resize / move face area
- [ ] *feat*: `maps` add world map download with user chosen level, host on github
- [ ] *fix*:  `maps` imported mbtiles are shaped as rectangles, multizones and shapes are not respected (do not use as private meanwhile)

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
