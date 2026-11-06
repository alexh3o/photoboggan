# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *docs*: `dev` technical documentation
- [x] *chore*: `dev` unlink dev and build settings
- [ ] *chore*: `installer` customize images and text
- [x] *feat*: `tasks` add time spent and remaining in taskQueue
- [x] *feat*: `filters` add erase button per filter category
- [x] *fix*: `storage` put thumbs in subfolders to avoid big collection issues
- [x] *fix*: `tasks` warn of running tasks when quitting
- [x] *refactor*: `UI` move qty of dispplayed photos to filters title bar (always visible)
- [x] *feat*: `dupes` find duplicates by name (regex), exact hash, phash with new modal
- [x] *feat*: `UI` display descriptions & titles in fullscreen
- [x] *feat*: `metadata` internal metadata writer activated => no exif reading option
- [x] *style*: `metadata` display clearly source of metadata formats in order lists (XMP / IPTC / EXIF)
- [x] *feat*: `internet` check and inform of **available update** on github (on hold, needs official releases)
- [ ] double click to fold/unfold folders

## 💡 Ideas / Longer term / On hold

- [x] *feat*: `raw` Find RAW with datetime and camera model
- [x] *refactor*: `UI` group manufacturer and model in camera on side panel metadata
- [ ] *fix*: `UI` **resizing app window to a small size** does not go well
- [x] *perf*: `Safety` improve integrity check - currently gets only 8/11 corrupted sample set
- [ ] *test*: `UI` verify UI on 1080 resolution
- [ ] *feat*: `UI` specific info panel display when multiple photos are selected
- [x] *feat*: `tasks` Close toast that are in current tasks when opening task modal
- [ ] *feat*: stats in a stat modal from settings

## ⚖️ Undecided

- [ ] *feat*: `help` app tour
- [ ] *feat*: cancellations everywhere
- [ ] *refactor*: `UI` improve toasts placement / visibility

## ❄️ Cold storage

- [ ] *feat*: `metadata` international title and description
- [ ] *feat*: `Controls` **keyboard shortcuts** customizing
- [ ] *feat*: `Controls` Add **mouse settings** screen
- [ ] *feat*: `faces` selectively create a face thumbnail (for low resolution faces, with min resolution setting)
- [ ] *feat*: `formats` live photos
- [ ] *fix*:  `maps` imported mbtiles are shaped as rectangles, multizones and shapes are not respected => precision improved but not 100% fixed,  do not use as private meanwhile
- [ ] *feat*: `duplicates` manage duplicates folder actions like in dupeguru
- [x] *perf*: `Safety` improve integrity check - currently gets 10/11 corrupted sample set: solution but with maintenance impact

## ❌ Ruled out

- [ ] *feat*: `faces` **better resolution for faces** view thumbnails : can be demanding on storage with big collections, goes against staying light principle
- [ ] *feat*: `editing` **Image editing**, cropping : not a goal of the app
- [ ] *fix*: `dev` vulnerability npm audit detected by claude: dev problem only
- [ ] *feat*: `maps` add world map download with user chosen level, host on github: lower levels are already taken with mbtiles, so it's less useful
- [ ] *feat*: `faces` resize / move face area => just delete and add again

## 🧪 To be tested & potential bugs to be confirmed

- [ ] `linux` Test Linux Release
- [ ] `backup` restoring data from data folder
- [x] `maps` handling of photos in 2 zones, eventually with different level
- [ ] `thumbnails` Check effect of 50 000 max photos in the grid: is it and actual issue in usage ?
- [ ] `thumbnails` Some thumbnails don't load, but passing mouse over them instantly displays them: dev only ?
