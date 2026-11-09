# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *docs*: `dev` technical documentation
- [ ] *feat*: `scan` allow pausing
- [x] *feat*: `semantic` add filter for scanned / unscanned photos
  - [x] done for thumbnails
  - [ ] to do for faces (add option to generate while recognizing)
- [ ] *perf*: `semantic``thumbnails``faces`organize workflow and synergies
- [x] *feat*: `semantic` irregular progress of scan, seems stuck at times
- [x] *feat*: `semantic` share search box with keywords search
- [ ] *feat*: `semantic` keywords for which suggestion cannot be done under it's keyword path
- [ ] *feat*: `thumbnails` option to keep loading folder thumbnails out of sight
- [ ] *fix*:  `semantic` `UI` issues with search box when window width is small
- [ ] *style*:  `semantic` `UI` make search settings view clearer with betterseparation between raw and semantic
- [ ] *feat*: `editing` rotate
- [ ] *fix*: `keywords` fail to write keyword
- [ ] *feat*: `keywords` open keyword panel directly on input zone

## 💡 Ideas / Longer term / On hold

- [ ] *feat*: `UI` specific info panel display when multiple photos are selected
- [ ] *feat*: `stats` stats in a stat modal from settings
- [ ] *feat*: `tasks` task to popup action to see progress
- [ ] *perf*: `thumbnails` more compressed thumbnails

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
- [ ] *feat*: `people` return button when going into someone's photos from its badge: people button does it

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
