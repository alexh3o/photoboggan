# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line / Done

- [x] *feat* `duplicates`: inform user when launching a long search necessiting a hash scan
- [x] *feat* `duplicates`: pass in same queue as semantic, low priority
- [x] *perf* `duplicates`: save per chunks of 128 to protect progress from crashes
- [x] *feat* `duplicates`: mark failing files for exclusion and report them in log + report
- [x] *perf* `duplicates`: keep hashes valid when file is modified in photoboggan
- [x] *perf* `duplicates`: option to calculate hashes during semantic
- [x] *perf* `duplicates`: option to calculate hashes during integrity check
- [x] *perf* `duplicates`: pause pro-active compute when a search is launched
- [x] *feat* `duplicates`: option to include/exclude RAW on detail search
- [x] *refactor* `duplicates`: better info in toasts and task modal
- [x] *feat* `duplicates`: add duplicates scan info in statistics
- [x] *feat* `list`: add duplicates exact hash column
- [x] *fix* `semantic`: count analyzed photos that have been modified and expired
- [x] *feat* `duplicates`: add section in settings (progress, pro-active launch, deletion, compute hash on new photos)
- [x] *refactor* `duplicates`: identical scan results always take a bit of time and only appear in a short toast that can be missed
- [x] *style* `update`: make available update notification toast more visible and persistent
- [x] *fix* `update`: respect option to not incldue beta even on beta version; allow check now when automatic update is off
- [ ] *feat* `duplicates`: prefilter duplicates search targets to reduce scan/ search time
- [ ] *fix* `semantic`: some field are mentionned as non content analyzed but skipped during analyze (videos without thumbas)
- [x] *fix* `duplicates`: list columns don't mention expired hashes
- [x] *fix* `duplicates`: text is malformed in pro-active scan launch (raw qty)
- [x] *style* `font_size`: have a consistent text size through app (problem on some dialogs)
- [x] *refactor* `dupplicates`: "compute similarity hashes during content analysis" option now only appears if content analysis is enabled

## 💡 Ideas / Longer term / On hold / Secondary

- [ ] *feat*: `metadata` **lens metadata writing** (for manual / old lenses) with autocompletion
- [ ] *feat*: `metadata` **exif time shift** (to fix bad camera settings afterwards)
- [ ] *feat*: `scripts` **user scripts/recipes** (launch integration with selected scans and actions, ex: integrity + thumbs + faces + phash + content analysis)
- [ ] *feat*: `grid` option to hide RAW by default
- [ ] *feat*: `applications` handle open with programs for selections with multiple photos (scripts...)
- [ ] *fix*: `metadata` xmp sidecars are not synced as image embedded metadata when modified
- [ ] *feat*: `metadata`allow writing to xmp sidecar
- [ ] *chore*: `semantic` add content search score setting filter to recipes

## ⚖️ Undecided

- [ ] *feat*: `help` app tour
- [ ] *feat*: `collection` add "scan for new items" to accelerate discovery of new elements
- [ ] *feat*: `UI` conditional clickable path line (breadcrumb) on top when left panel is closed
- [ ] *feat*: `files` prevent deletion of photos with stars
- [ ] *feat*: `files` **sd card** import
- [ ] *feat*: `UI` specific info panel display when multiple photos are selected
- [ ] *refactor*: `semantic` allow larger scores
- [ ] *feat*: `collection` database data dashboard (hash, phash, face scanned, content analyzed, thumbnails)

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
