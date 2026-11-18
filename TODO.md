# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *fix*: `keywords` keywords write fail dialog offers No / Retry / Show: "No" is unclear
- [ ] *feat*: `semantic` differentiate never analysed from analysed but modified photos
- [ ] *feat*: `grid` option to hide RAW by default
- [ ] *style*: `map` alternative dark map style
- [x] *feat*: `UI` display date modified and created somewhere
- [ ] *fix*: `duplicates` similar images search (phash) seems stuck on big collections
- [x] *refactor*: `grid` date modified sorting must see metadata writes
- [x] *fix*: `UI` `duplicates` in dupes star ratings are below the thumbnail info band
- [ ] *fix*: `tree` reordering root folders in tree needs a click action after moving to register

## 💡 Ideas / Longer term / On hold

- [ ] *feat*: `UI` specific info panel display when multiple photos are selected
- [ ] *fix*: `keywords` fail to write keyword (to be reproduced)
- [ ] *feat*: `files` batch renaming
- [ ] *feat*: `files` sd card import
- [ ] *feat*: `viewing` instant zoom
- [x] *feat*: `metadata` copyright and creator writing
- [ ] *feat*: `metadata` lens metadata writing
- [ ] *feat*: `metadata` exif time shift
- [ ] *feat*: `files` prevent deletion of photos with stars
- [ ] *feat*: user scripts

## ⚖️ Undecided

- [ ] *feat*: `help` app tour
- [ ] *feat*: `semantic` offer a way to reanalyse content already analyzed ?
- [ ] *feat*: add "scan for new items" to accelerate discovery of new elements
- [ ] *feat*: `UI` conditional clickable path line (breadcrumb) on top when left panel is closed

## ❄️ Cold storage

- [ ] *feat*: `metadata` international title and description
- [ ] *feat*: `Controls` **keyboard shortcuts** customizing
- [ ] *feat*: `Controls` Add **mouse settings** screen
- [ ] *feat*: `faces` selectively create a face thumbnail (for low resolution faces, with min resolution setting)
- [ ] *feat*: `formats` live photos
- [ ] *fix*:  `maps` imported mbtiles are shaped as rectangles, multizones and shapes are not respected => precision improved but not 100% fixed,  do not use as private meanwhile
- [ ] *feat*: `duplicates` manage duplicates folder actions like in dupeguru
- [ ] *perf*: `Safety` improve integrity check - currently gets 10/11 corrupted sample set: solution known but with maintenance impact
- [ ] *feat*: `people` return button when going into someone's photos from its badge: people button does it
- [ ] *feat*: `thumbnails` option to keep loading folder thumbnails out of sight

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
- [ ] `thumbnails` Some thumbnails don't load, but passing mouse over them instantly displays them: dev only ?
