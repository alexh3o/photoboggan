# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [x] *feat*: `UI`memorize open panels when closing app, reopen them + thumbnails
- [x] *feat*: `UI`darken non selected photos when hovering over selection
- [x] *feat*: **search by filename**
- [ ] *style*: `UI`add **UI/text size** setting
  => set text types
- [x] *feat*: `UI` hotkey to display shortcuts guide
- [x] *feat*: `UI`add **optional displays on full screen** (filename, date, exif, rank)
- [x] *fix*: **adding two folders** while first one is still scanning queues them but the name of the last one is displayed with first one's completion percentage
  => do not overlay toasts, put last action on hold
- [x] *feat*: display video thumbnails and open them with OS chosen app
- [x] *feat*: do not delete folders if files other than those displayed by photoboggan are present, only delete the displayed files

## 💡 Ideas / Longer term / On hold

- [ ] *feat*: `UI`add selection panel close button, to close panel and deselect all pictures
- [x] *feat*: `Video`remove resize command on videos
- [x] *feat*: allow **stopping a running scan**
- [ ] *feat*: handle info panel display when multiple photos are selected
  - [ ] keep some for last image: filename, basic exif, filesize
  - [ ] keywords: first common and second non common keywords ina  different color
  - [ ] range of exif speed,iso, aperture
  - [ ] number of different cameras and lenses
  - [ ] range of date taken
  - [ ] average filesize
  - [ ] number of files instead of filename
  - [ ] range of pixel sizes instead of dimensions
  - [ ] hide description
  - [ ] average rating
- [x] *style*: `UI` make **filters more compact**
- [x] *feat*: `UI` **click on a keyword to search** that keyword, ctrl modifier to add it to the searched keywords
- [x] *feat*: `UI` **shortcuts** for left panel, info panel
- [ ] *feat*: `UI`action & **shortcuts** to **toggle toolbar**
- [x] *style*: `UI` **remember window position and size** through restarts
- [ ] *feat*: `Controls` **keyboard shortcuts** customizing
- [ ] *feat*: `Controls` "**Open with**" keyboard shortcuts
- [ ] *perf*: add more **photos to cache** to improve felt full screen navigation speed
- [ ] *feat*: `UI` add **zoom value** display (optional)
- [x] *chore*: Add **Linux** release
  - [ ] *fix*: **No trash** available (but it mentions deletion is definitive)
  - [ ] *fix*: **Cannot move window** by title bar
  - [ ] *revert*: non working fix for "cannot move window by title bar"
  - [ ] **Test** linux release
- [ ] *feat*: Allow **keywords management & file write** (HARD)
  - [ ] Implement **tree structure** matching **existing pictures**, handle **active/inactive keywords** in each branch, implement vizualisation **per picture, per pictures & collection**
  - [ ] Allow **adding keyword** in tree
  - [ ] Allow adding and removing keywords, writing files in all existing formats
  - [ ] Handle **multiplicity of tags** in structure
- [ ] *feat*: Add **mouse settings** screen
- [ ] *feat*: add **total photo quantity** as well as quantity per root folder and drive" in "About" screen
- [ ] *fix*: `UI` **resizing app window to a small size** does not go well. Panels become narrow & unreadable while thumbnails keep their width.
  => set a minimal size for window and for each panel

## ⚖️ Undecided

- [x] *feat*: **heic / heif** image format support
- [ ] *feat*: [HARD] **Face recognition** (heavy & unlikely)
- [ ] *feat*: **integrity scan** to detect corrupted files
  - [ ] specific view or action,
  - [ ] group within missing thumbnails generation)
  - [ ] include raw partially: embedded tyhumbnail extraction
- [ ] *feat*: `needs_internet` **Map screen**
- [ ] *feat*: `needs_internet` add a **map widget** in info panel
- [ ] *feat*: `needs_internet` check and inform of **available update** on github (on hold, needs official releases)

## ❌ Not planned (use "Open with...")

- [ ] **Image editing**, cropping...

## 🧪 To be tested & potential bugs to be confirmed

- [ ] Test Linux Release
- [x] Ensure moving files is safe
- [x] Ensure writing files is safe
- [ ] Restoring data from data folder
- [ ] *fix*: thumbnails size setting doesn't persist through update
