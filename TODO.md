# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *fix*: `keywords` keywords write fail dialog offers No / Retry / Show: "No" is unclear (=ignore)
- [ ] *fix*: `rename` add a delete all feature or authorize deleting more than filename length
- [x] *style*: `map` more visible dark map style
- [x] *feat*: `UI` display date modified and date created somewhere
- [ ] *fix*: `duplicates` similar images search (phash) seems stuck on big collections by lack of user info
- [x] *refactor*: `grid` date modified sorting must see metadata writes
- [x] *fix*: `UI` `duplicates` in dupes star ratings are below the thumbnail info band
- [ ] *perf*: `fullscreen` slight lag when changing photo
- [ ] *refactor*: `controls` swap (exif) & J (info panel) shortcuts

## 💡 Ideas / Longer term / On hold / Secondary

- [ ] *style*: `thumbnails` add rounded corners option (force small gap minimum)
- [ ] *fix*: `keywords` fail to write keyword (to be reproduced)
- [x] *feat*: `files` **batch renaming**
- [ ] *feat*: `metadata` **lens metadata writing** (for manual / old lenses) with autocompletion
- [ ] *feat*: `metadata` **exif time shift** (to fix bad camera settings afterwards)
- [ ] *feat*: `scripts` **user scripts/recipes** (launch integration with selected scans and actions, ex: integrity + thumbs + faces + phash + content analysis)
- [ ] *fix*: `tree` reordering root folders with grips in settings sometimes leaves them pending and needing a click confirmation
- [ ] *feat*: `grid` option to hide RAW by default
- [ ] *feat*: `applications` handle open with programs for selections with multiple photos (scripts...)

## ⚖️ Undecided

- [ ] *feat*: `help` app tour
- [ ] *feat*: `collection` add "scan for new items" to accelerate discovery of new elements
- [ ] *feat*: `UI` conditional clickable path line (breadcrumb) on top when left panel is closed
- [ ] *feat*: `files` prevent deletion of photos with stars
- [ ] *feat*: `files` **sd card*** import
- [ ] *feat*: `UI` specific info panel display when multiple photos are selected

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
