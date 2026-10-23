# 📋 Todo List & Ideas - Photoboggan

## 🚀 Next in line

- [ ] *feat*: add **total photo quantity** as well as quantity per root folder and drive" in "About" screen
- [ ] *feat*: memorize open panels when closing app, reopen them + thumbnails
- [ ] *feat*: darken non selected photos when hovering over selection
- [x] *feat*: **search by filename**
- [ ] *style*: add **UI/text size** setting
  => set text types
- [ ] *feat*: hotkey to display shortcuts guide
- [x] *feat*: add **optional displays on full screen** (filename, date, exif, rank)
- [ ] *fix*: **Resizing app window to a small size** does not go well. Panels become narrow & unreadable while thumbnails keep their width.
  => set a minimal size for window and for each panel
- [ ] *fix*: **adding two folders** while first one is still scanning queues them but the name of the last one is displayed with first one's completion percentage
  => do not overlay toasts, put last action on hold

## 💡 Ideas / longer term / on hold

- [ ] *feat*: add selection panel close button, to close panel and deselect all pictures
- [ ] *feat*: allow **stopping a running scan**
- [x] *style*: make **filters more compact**
- [ ] *feat*: **click on a keyword to search** that keyword, ctrl modifier to add it to the searched keywords
- [ ] *feat*: **shortcuts** for left panel, toolbar (non restart persistent), keys modal
- [ ] *style*: **remember window position and size** through restarts
- [ ] *feat*: **keyboard shortcuts** customizing
- [ ] *feat*: "**Open with**" keyboard shortcuts
- [ ] *perf*: add more **photos to cache** to improve felt full screen navigation speed
- [ ] *feat*: add **zoom value** display (optional)
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
- [ ] *feat*: check and inform of **available update** on github (on hold, needs official releases)
- [ ] *feat*: Add **mouse settings** screen

## ⚖️ Undecided

- [ ] *feat*: **heic / heif** image format support
- [ ] *feat*: [HARD] **Face recognition** (heavy & unlikely)
- [ ] *feat*: jpeg **integrity scan** (specific view)
- [ ] *feat*: [NEEDS_INTERNET] **Map screen** (needs internet)
- [ ] *feat*: [NEEDS_INTERNET] add a **map widget** in info panel

## ❌ Not planned (use "Open with...")

- [ ] **Image editing**, cropping...

## 🧪 To be tested

- [ ] Test Linux Release
- [ ] Ensure moving files is safe
- [ ] Ensure writing files is safe
- [ ] Restoring data from data folder
- [ ] Check settings persist when updating
