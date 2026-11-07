# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *docs*: `dev` technical documentation
- [ ] *docs*: `installation` mention to grab exiftool
- [x] *fix*: `grid` 50k displayed photos stay the same when sorting in the opposite order
- [x] *fix*: `grid` clicking on a face from people can give empty results, probably due to 50k limit
- [ ] *feat*: `scan` allow pausing
- [x] *fix*: `UI` window title bar's minimize and maximize buttons don't highlight when hovering
- [x] *fix*: `tree` folders use empty folder logo while having files and showing count
- [ ] *feat*: `people` return button when going into someone's photos from its badge
- [ ] *feat*: `people` text filter in people view

## 💡 Ideas / Longer term / On hold

- [ ] *feat*: `UI` specific info panel display when multiple photos are selected
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
- [ ] *perf*: `Safety` improve integrity check - currently gets 10/11 corrupted sample set: solution known but with maintenance impact

## ❌ Ruled out

- [ ] *feat*: `faces` **better resolution for faces** view thumbnails : can be demanding on storage with big collections, goes against staying light principle
- [ ] *feat*: `editing` **Image editing**, cropping : not a goal of the app
- [ ] *fix*: `dev` vulnerability npm audit detected by claude: dev problem only
- [ ] *feat*: `maps` add world map download with user chosen level, host on github: lower levels are already taken with mbtiles, so it's less useful
- [ ] *feat*: `faces` resize / move face area => just delete and add again

---

# Tests & Notes

## 🧪 To be tested & potential bugs to be confirmed

- [ ] `linux` Test Linux Release
- [ ] `backup` restoring data from data folder
- [x] `thumbnails` Check effect of 50 000 max photos in the grid: is it and actual issue in usage ?
- [ ] `thumbnails` Some thumbnails don't load, but passing mouse over them instantly displays them: dev only ?
