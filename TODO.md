# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *feat*: `search` private folders to optionally exclude from searches (similar x2, semantic search, keywords)
- [ ] *feat*: `grid` implement pages for 50k+ views
- [x] *feat*: `faces` `filters` add filter for photos with/without faces data, or with number of faces (0=>x)
- [x] *feat*: `infos` add folder in infos when all photos is selected
- [ ] *feat*: `tree` reorder root folders
- [ ] *feat*: `tree` add folder search
- [x] *fix*: `faces` cannot pass faces from filtered to unknown
- [x] *fix*: `keywords` problem with " ' " in keywords, can't read it the same as written, writing seems to fail
- [ ] *feat*: `keywords` write keywords when typing enter in empty keyword input field
- [ ] *fix*: `keywords` keywords fail dialog shows No/Retry/Show: "No" is unclear
- [x] *feat*: `infos` add folder info in album photos too
- [ ] *feat*: `semantic` differentiate never analysed from analysed but modified photos

## 💡 Ideas / Longer term / On hold

- [ ] *feat*: `UI` specific info panel display when multiple photos are selected
- [ ] *feat*: `tasks` task to popup action to see progress
- [ ] *fix*: `keywords` fail to write keyword (to be reproduced)
- [ ] *fix*: add "scan for new items" ? big folders, when do they see new elements

## ⚖️ Undecided

- [ ] *feat*: `help` app tour
- [ ] *feat*: `semantic` offer a way to reanalyse content already analyzed ?

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
