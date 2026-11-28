//! Batch rename (F2 on several photos, see docs/development/modules/photo-operations.md).
//!
//! The interface (src/batch-rename.js) evaluates the recipe and sends, for each photo, the new name WITHOUT the extension: this module never replays
//! the recipe, it re-checks every name (the interface is never trusted), plans the batch, then runs it.
//!
//! Planning (`plan_batch`, no effect on the disk): a photo that cannot be renamed is left out with a stable code, the rest of the batch goes on.
//! Collisions are compared ignoring case: two files of the batch to the same name, a target taken by a file of the batch that keeps its name, or by
//! an existing file outside the batch: NONE of the files concerned is renamed. Swaps and chains (A to B while B to C) are allowed: the execution
//! orders the renames and, when needed, parks a file under a temporary name.
//! XMP sidecars follow their photo. The shared sidecar `photo.xmp` is moved once if every file that reads it is renamed to the same name, copied
//! otherwise (as when a single photo is renamed); if two sidecars of different origin reach the same name, or if the name is already taken by an
//! existing file, the sidecars concerned take the `photo.ext.xmp` format.
//!
//! Execution (`execute`): a "unit" is the photo plus its sidecar, rolled back as a whole if the sidecar fails. A stop request is honoured between
//! two units (never while a file is parked). The catalogue path, and the thumbnail and RAW preview of the cache (named after the path) follow the
//! photo; the other data (albums, keywords, faces, duplicates, semantic analysis...) is tied to the photo id, size and modification date, which a
//! rename does not change.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::AppState;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RenameItem {
    pub path: String,
    /// New name without the extension (the file's extension is kept as it is).
    pub new_name: String,
}

/// Photo not renamed. `code`: `invalid_name`, `not_found`, `not_tracked`, duplicate, `too_long`, collision, exists, `sidecar_exists`, `sidecar_taken`, io, catalog.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RenameFailure {
    pub path: String,
    pub code: String,
    pub detail: String,
}

#[derive(Serialize)]
pub struct RenameBatchResult {
    pub renamed: Vec<crate::MovedFile>,
    pub unchanged: usize,
    pub failed: Vec<RenameFailure>,
    /// Photos not handled because the user stopped the task.
    pub not_processed: usize,
}

#[derive(Serialize, Debug)]
pub struct PreviewStatus {
    pub path: String,
    /// ok, unchanged ou error.
    pub status: String,
    pub code: String,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// Length limits
// ---------------------------------------------------------------------------

pub(crate) const MAX_NAME_UNITS: usize = 255;

/// Length as the file system counts it: UTF-16 units on Windows, bytes elsewhere.
pub(crate) fn text_units(text: &str) -> usize {
    if cfg!(windows) { text.encode_utf16().count() } else { text.len() }
}

/// Windows: 259 characters for the whole path (`MAX_PATH` minus the terminator), without assuming that long paths are enabled.
pub(crate) fn max_path_units() -> usize {
    if cfg!(windows) { 259 } else { 4095 }
}

pub(crate) fn exceeds_limits(dir: &Path, name: &str, max_name: usize, max_path: usize) -> bool {
    text_units(name) > max_name || text_units(&dir.to_string_lossy()) + 1 + text_units(name) > max_path
}

pub(crate) fn too_long(dir: &Path, name: &str) -> bool {
    exceeds_limits(dir, name, MAX_NAME_UNITS, max_path_units())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Key = (String, String);

/// Path comparable ignoring case and separator style.
fn norm(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn dir_key(dir: &Path) -> String {
    norm(dir).trim_end_matches('/').to_string()
}

/// (name without extension, extension): a leading dot does not start an extension (as in `Path::file_stem`).
fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index + 1..]),
        _ => (name, ""),
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

fn appended_sidecar(image: &Path) -> PathBuf {
    PathBuf::from(format!("{}.xmp", image.display()))
}

/// Lower-case names of a folder, read once.
fn dir_names<'a>(cache: &'a mut HashMap<String, HashSet<String>>, dir: &Path) -> &'a HashSet<String> {
    cache.entry(dir_key(dir)).or_insert_with(|| {
        fs::read_dir(dir)
            .map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().to_lowercase()).collect())
            .unwrap_or_default()
    })
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Cand {
    index: usize,
    path: String,
    source: PathBuf,
    parent: PathBuf,
    cur_name: String,
    new_file_name: String,
    target: PathBuf,
}

fn cur_key(c: &Cand) -> Key {
    (dir_key(&c.parent), c.cur_name.to_lowercase())
}

fn target_key(c: &Cand) -> Key {
    (dir_key(&c.parent), c.new_file_name.to_lowercase())
}

#[derive(Clone, Debug)]
pub(crate) struct SidecarOp {
    pub from: PathBuf,
    pub to: PathBuf,
    /// Copy (the original sidecar stays, another file still reads it) or move.
    pub copy: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Planned {
    pub path: String,
    pub source: PathBuf,
    pub target: PathBuf,
    pub sidecar: Option<SidecarOp>,
    /// Original sidecar shared by several photos: the copies are made before the move.
    pub group: Option<String>,
    pub waits_for_copies: bool,
}

#[derive(Debug)]
pub(crate) struct Plan {
    pub planned: Vec<Planned>,
    /// Paths whose name does not change.
    pub unchanged: Vec<String>,
    /// In the order of the items received.
    pub failed: Vec<RenameFailure>,
}

struct SidecarPlan {
    op: Option<SidecarOp>,
    group: Option<String>,
    waits: bool,
}

enum SidecarKind {
    None,
    /// `photo.ext.xmp`, the photo's own sidecar.
    Own(PathBuf),
    /// `photo.xmp`, read by every file of the same name without extension.
    Compat(PathBuf),
}

/// Sidecars of the photos still in the batch. Returns their plan (by item index) or, if some photos must be left out, those failures
/// (the caller then plans the whole batch again without them).
fn plan_sidecars(active: &[&Cand], cache: &mut HashMap<String, HashSet<String>>) -> (HashMap<usize, SidecarPlan>, Vec<(usize, &'static str, String)>) {
    let mut failures: Vec<(usize, &'static str, String)> = Vec::new();
    let mut plans: HashMap<usize, SidecarPlan> = HashMap::new();
    let active_cur: HashSet<Key> = active.iter().map(|c| cur_key(c)).collect();

    let kinds: Vec<SidecarKind> = active
        .iter()
        .map(|c| {
            let appended = appended_sidecar(&c.source);
            if appended.is_file() {
                return SidecarKind::Own(appended);
            }
            let compat = c.source.with_extension("xmp");
            if compat.is_file() { SidecarKind::Compat(compat) } else { SidecarKind::None }
        })
        .collect();

    // Shared sidecars, grouped by original file.
    let mut group_order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (PathBuf, Vec<usize>)> = HashMap::new();
    for (position, kind) in kinds.iter().enumerate() {
        if let SidecarKind::Compat(from) = kind {
            let key = norm(from);
            if !groups.contains_key(&key) {
                group_order.push(key.clone());
                groups.insert(key.clone(), (from.clone(), Vec::new()));
            }
            if let Some(group) = groups.get_mut(&key) { group.1.push(position); }
        }
    }
    // Is every file that reads the shared sidecar renamed by this batch?
    let mut fully_moved: HashMap<String, bool> = HashMap::new();
    for key in &group_order {
        let first = active[groups[key].1[0]];
        let stem = split_name(&first.cur_name).0.to_lowercase();
        let dir = dir_key(&first.parent);
        let readers: Vec<String> = dir_names(cache, &first.parent)
            .iter()
            .filter(|name| {
                let (name_stem, extension) = split_name(name);
                name_stem == stem && extension != "xmp"
            })
            .cloned()
            .collect();
        fully_moved.insert(key.clone(), readers.iter().all(|name| active_cur.contains(&(dir.clone(), name.clone()))));
    }
    // Sidecars that leave their name during the batch.
    let mut vacated: HashSet<String> = HashSet::new();
    for kind in &kinds {
        match kind {
            SidecarKind::Own(from) => { vacated.insert(norm(from)); }
            SidecarKind::Compat(from) => {
                if fully_moved.get(&norm(from)).copied().unwrap_or(false) { vacated.insert(norm(from)); }
            }
            SidecarKind::None => {}
        }
    }
    let occupied = |path: &Path| path.exists() && !vacated.contains(&norm(path));

    // Who claims which sidecar name (distinct sources).
    let mut claims: HashMap<String, HashSet<String>> = HashMap::new();
    for (position, kind) in kinds.iter().enumerate() {
        let c = active[position];
        match kind {
            SidecarKind::Own(from) => { claims.entry(norm(&appended_sidecar(&c.target))).or_default().insert(norm(from)); }
            SidecarKind::Compat(from) => { claims.entry(norm(&c.target.with_extension("xmp"))).or_default().insert(norm(from)); }
            SidecarKind::None => {}
        }
    }

    // Final name of each sidecar.
    let mut finals: Vec<Option<(PathBuf, PathBuf)>> = vec![None; active.len()];
    for (position, kind) in kinds.iter().enumerate() {
        let c = active[position];
        let (from, to) = match kind {
            SidecarKind::Own(from) => (from.clone(), appended_sidecar(&c.target)),
            SidecarKind::Compat(from) => {
                let compat_to = c.target.with_extension("xmp");
                // Two sidecars of different origin to the same name, or a name already taken: "photo.ext.xmp" format.
                let contested = claims.get(&norm(&compat_to)).is_some_and(|sources| sources.len() > 1) || occupied(&compat_to);
                (from.clone(), if contested { appended_sidecar(&c.target) } else { compat_to })
            }
            SidecarKind::None => {
                // No sidecar: the photo must not adopt another one lying under its new name.
                if occupied(&appended_sidecar(&c.target)) {
                    failures.push((c.index, "sidecar_taken", file_name_of(&appended_sidecar(&c.target))));
                    continue;
                }
                let compat_to = c.target.with_extension("xmp");
                if occupied(&compat_to) {
                    let new_stem = split_name(&c.new_file_name).0.to_lowercase();
                    let dir = dir_key(&c.parent);
                    let stays = dir_names(cache, &c.parent).iter().any(|name| {
                        let (name_stem, extension) = split_name(name);
                        name_stem == new_stem && extension != "xmp" && !active_cur.contains(&(dir.clone(), name.clone()))
                    });
                    let joined = active.iter().any(|other| other.index != c.index && dir_key(&other.parent) == dir && split_name(&other.new_file_name).0.to_lowercase() == new_stem);
                    if !stays && !joined {
                        failures.push((c.index, "sidecar_taken", file_name_of(&compat_to)));
                    }
                }
                continue;
            }
        };
        let name = file_name_of(&to);
        if too_long(&c.parent, &name) {
            failures.push((c.index, "too_long", name));
            continue;
        }
        if occupied(&to) {
            failures.push((c.index, "sidecar_exists", name));
            continue;
        }
        finals[position] = Some((from, to));
    }
    if !failures.is_empty() { return (plans, failures); }

    // Operations: own sidecars (always moved), then shared sidecars.
    for (position, kind) in kinds.iter().enumerate() {
        if let (SidecarKind::Own(_), Some((from, to))) = (kind, &finals[position]) {
            plans.insert(active[position].index, SidecarPlan { op: Some(SidecarOp { from: from.clone(), to: to.clone(), copy: false }), group: None, waits: false });
        }
    }
    for key in &group_order {
        let (from, members) = &groups[key];
        let full = fully_moved.get(key).copied().unwrap_or(false);
        let mut targets: Vec<String> = Vec::new();
        for &position in members {
            let name = norm(&finals[position].as_ref().expect("final name").1);
            if !targets.contains(&name) { targets.push(name); }
        }
        let last = targets.len() - 1;
        let mut carried: HashSet<String> = HashSet::new();
        for &position in members {
            let to = finals[position].as_ref().expect("final name").1.clone();
            let name = norm(&to);
            if !carried.insert(name.clone()) {
                plans.insert(active[position].index, SidecarPlan { op: None, group: None, waits: false });
                continue;
            }
            // Every reader leaves: the last name gets the sidecar itself, the others a copy. Otherwise, copies only.
            let rank = targets.iter().position(|target| *target == name).unwrap_or(0);
            let copy = !(full && rank == last);
            plans.insert(
                active[position].index,
                SidecarPlan { op: Some(SidecarOp { from: from.clone(), to, copy }), group: Some(key.clone()), waits: !copy && targets.len() > 1 },
            );
        }
    }
    (plans, failures)
}

/// Plans the batch (nothing is changed on the disk).
pub(crate) fn plan_batch(items: &[RenameItem]) -> Plan {
    let mut early: Vec<(usize, RenameFailure)> = Vec::new();
    let mut unchanged: Vec<String> = Vec::new();
    let mut cands: Vec<Cand> = Vec::new();
    let mut staying: HashSet<Key> = HashSet::new(); // files of the batch that keep their name
    let mut seen: HashSet<String> = HashSet::new();

    for (index, item) in items.iter().enumerate() {
        let failure = |code: &str, detail: String| RenameFailure { path: item.path.clone(), code: code.to_string(), detail };
        let source = PathBuf::from(&item.path);
        // The name of a file that is really there stays taken, even if this photo cannot be renamed (a catalogue row without file blocks nothing).
        if let Some(parent) = source.parent().filter(|_| source.is_file()) {
            staying.insert((dir_key(parent), file_name_of(&source).to_lowercase()));
        }
        // A path given twice: only the first one is handled.
        if !seen.insert(norm(&source)) {
            early.push((index, failure("duplicate", String::new())));
            continue;
        }
        let stem = match crate::validate_new_name(&item.new_name) {
            Ok(stem) => stem.to_string(),
            Err(error) => { early.push((index, failure("invalid_name", error))); continue; }
        };
        let Some(parent) = source.parent().map(Path::to_path_buf) else {
            early.push((index, failure("not_found", String::new())));
            continue;
        };
        if !source.is_file() {
            early.push((index, failure("not_found", String::new())));
            continue;
        }
        let new_file_name = match source.extension() {
            Some(extension) => format!("{stem}.{}", extension.to_string_lossy()),
            None => stem,
        };
        if too_long(&parent, &new_file_name) {
            early.push((index, failure("too_long", new_file_name)));
            continue;
        }
        let target = parent.join(&new_file_name);
        if target == source {
            unchanged.push(item.path.clone());
            continue;
        }
        let cur_name = file_name_of(&source);
        cands.push(Cand { index, path: item.path.clone(), source, parent, cur_name, new_file_name, target });
    }
    // Names of the batch's files as they are now: a file that is leaving its name (renamed by the batch) frees it, the others keep it.
    // Candidates are taken out of `staying` here and put back when they fail.
    let candidate_keys: HashSet<Key> = cands.iter().map(cur_key).collect();
    staying.retain(|key| !candidate_keys.contains(key));
    let batch_current: HashSet<Key> = staying.iter().cloned().chain(candidate_keys.iter().cloned()).collect();

    let mut cache: HashMap<String, HashSet<String>> = HashMap::new();
    let mut dead: HashMap<usize, (&'static str, String)> = HashMap::new();
    let sidecar_plans = loop {
        // Collisions, until stable: a file left out keeps its name and can block another one.
        loop {
            let active: Vec<&Cand> = cands.iter().filter(|c| !dead.contains_key(&c.index)).collect();
            let mut target_count: HashMap<Key, usize> = HashMap::new();
            for c in &active { *target_count.entry(target_key(c)).or_insert(0) += 1; }
            let mut keeping: HashSet<Key> = staying.clone();
            for c in cands.iter().filter(|c| dead.contains_key(&c.index)) { keeping.insert(cur_key(c)); }
            let mut newly: Vec<(usize, &'static str, String)> = Vec::new();
            for c in &active {
                let target = target_key(c);
                let own = cur_key(c);
                if target_count.get(&target).copied().unwrap_or(0) > 1
                    || (target != own && keeping.contains(&target))
                {
                    newly.push((c.index, "collision", c.new_file_name.clone()));
                } else if target != own && !batch_current.contains(&target) && dir_names(&mut cache, &c.parent).contains(&target.1) {
                    newly.push((c.index, "exists", c.new_file_name.clone()));
                }
            }
            if newly.is_empty() { break; }
            for (index, code, detail) in newly { dead.insert(index, (code, detail)); }
        }
        let active: Vec<&Cand> = cands.iter().filter(|c| !dead.contains_key(&c.index)).collect();
        let (plans, failures) = plan_sidecars(&active, &mut cache);
        if failures.is_empty() { break plans; }
        for (index, code, detail) in failures { dead.insert(index, (code, detail)); }
    };

    let mut planned = Vec::new();
    let mut failed: Vec<(usize, RenameFailure)> = early;
    for c in &cands {
        if let Some((code, detail)) = dead.get(&c.index) {
            failed.push((c.index, RenameFailure { path: c.path.clone(), code: code.to_string(), detail: detail.clone() }));
            continue;
        }
        let plan = sidecar_plans.get(&c.index);
        planned.push(Planned {
            path: c.path.clone(),
            source: c.source.clone(),
            target: c.target.clone(),
            sidecar: plan.and_then(|plan| plan.op.clone()),
            group: plan.and_then(|plan| plan.group.clone()),
            waits_for_copies: plan.is_some_and(|plan| plan.waits),
        });
    }
    failed.sort_by_key(|(index, _)| *index);
    Plan { planned, unchanged, failed: failed.into_iter().map(|(_, failure)| failure).collect() }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Progress and stop: the task of the queue in production, nothing in the tests.
pub(crate) trait Hooks {
    fn cancelled(&self) -> bool;
    fn advance(&mut self, size: u64);
}

pub(crate) struct Outcome {
    pub renamed: Vec<(String, String)>,
    pub failed: Vec<RenameFailure>,
    pub not_processed: usize,
}

struct Unit {
    path: String,
    /// Path of the catalogue row right now: the original one, or the temporary name while the photo is parked (the row follows the file,
    /// otherwise two photos swapping their names would want the same key).
    db_path: String,
    source: PathBuf,
    target: PathBuf,
    sidecar: Option<SidecarOp>,
    group: Option<String>,
    waits: bool,
    /// Where the photo is right now (its original name, or a temporary name while it is parked).
    img_at: PathBuf,
    sidecar_at: Option<PathBuf>,
    parked: bool,
    old_thumbnail: Option<PathBuf>,
    old_raw_preview: Option<PathBuf>,
    size: u64,
}

enum Step {
    Done,
    Wait,
    Failed(&'static str, String),
}

fn is_already_exists(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists
}

/// Tries the unit: the photo takes its new name together with its sidecar, or nothing changes.
fn try_unit(unit: &mut Unit) -> Step {
    // Same per-file lock as metadata writes: a write in progress ends before the rename.
    let _write_guard = crate::exiftool::path_lock(&unit.source);
    if unit.target.exists() { return Step::Wait; } // taken (maybe by a file of the batch that is leaving), or the same file with another case
    if let Some(sidecar) = &unit.sidecar {
        if sidecar.to.exists() { return Step::Wait; }
    }
    if let Err(error) = crate::reserve_new_file(&unit.target) {
        return if is_already_exists(&error) { Step::Wait } else { Step::Failed("io", error.to_string()) };
    }
    if let Some(sidecar) = &unit.sidecar {
        if let Err(error) = crate::reserve_new_file(&sidecar.to) {
            let _ = fs::remove_file(&unit.target);
            return if is_already_exists(&error) { Step::Wait } else { Step::Failed("io", error.to_string()) };
        }
    }
    let previous_img_at = unit.img_at.clone();
    if let Err(error) = fs::rename(&unit.img_at, &unit.target) {
        let _ = fs::remove_file(&unit.target);
        if let Some(sidecar) = &unit.sidecar { let _ = fs::remove_file(&sidecar.to); }
        return Step::Failed("io", error.to_string());
    }
    if let Some(sidecar) = &unit.sidecar {
        let result = if sidecar.copy {
            crate::copy_atomically_to_reserved(&sidecar.from, &sidecar.to)
        } else {
            fs::rename(unit.sidecar_at.as_ref().unwrap_or(&sidecar.from), &sidecar.to)
        };
        if let Err(error) = result {
            let _ = fs::remove_file(&sidecar.to);
            // Return the photo to where it was before this step, never overwriting a file now at `unit.source` (e.g. after a swap).
            unit.img_at = if !previous_img_at.exists() && fs::rename(&unit.target, &previous_img_at).is_ok() {
                previous_img_at
            } else {
                unit.target.clone()
            };
            return Step::Failed("io", error.to_string());
        }
    }
    Step::Done
}

/// Sets the unit aside under a temporary name in the same folder (photo and moved sidecar), to break a swap or a case-only change.
fn park(unit: &mut Unit, counter: &mut usize, conn: &rusqlite::Connection) -> Result<(), String> {
    let _write_guard = crate::exiftool::path_lock(&unit.source);
    let parent = unit.source.parent().map(Path::to_path_buf).ok_or("Dossier introuvable")?;
    // The temporary name keeps the extension (the photo stays a photo for the catalogue) and its moved sidecar becomes its own `.xmp`: if the
    // application were killed while a file is parked, the photo would still be there, with its metadata, under this name.
    let extension = unit.source.extension().map(|extension| format!(".{}", extension.to_string_lossy())).unwrap_or_default();
    let image_temp = loop {
        *counter += 1;
        let candidate = parent.join(format!(".photoboggan-rename-{}-{}{}", std::process::id(), *counter, extension));
        match crate::reserve_new_file(&candidate) {
            Ok(()) => break candidate,
            Err(error) if is_already_exists(&error) => {}
            Err(error) => return Err(error.to_string()),
        }
    };
    if let Err(error) = fs::rename(&unit.img_at, &image_temp) {
        let _ = fs::remove_file(&image_temp);
        return Err(error.to_string());
    }
    let previous = std::mem::replace(&mut unit.img_at, image_temp);
    let moved_sidecar = unit.sidecar.as_ref().filter(|sidecar| !sidecar.copy).map(|sidecar| sidecar.from.clone());
    let mut sidecar_temp = None;
    if let Some(from) = moved_sidecar {
        let temp = appended_sidecar(&unit.img_at); // img_at is the temporary photo name here
        if let Err(error) = crate::reserve_new_file(&temp) {
            let _ = fs::rename(&unit.img_at, &previous);
            unit.img_at = previous;
            return Err(error.to_string());
        }
        let current = unit.sidecar_at.clone().unwrap_or(from);
        if let Err(error) = fs::rename(&current, &temp) {
            let _ = fs::remove_file(&temp);
            let _ = fs::rename(&unit.img_at, &previous);
            unit.img_at = previous;
            return Err(error.to_string());
        }
        sidecar_temp = Some(temp);
    }
    // The catalogue row follows the file.
    let temp_path = unit.img_at.to_string_lossy().into_owned();
    if let Err(error) = conn.execute("UPDATE photos SET path = ?1 WHERE path = ?2", params![temp_path, unit.db_path]) {
        if let (Some(temp), Some(sidecar)) = (&sidecar_temp, unit.sidecar.as_ref()) {
            let _ = fs::rename(temp, unit.sidecar_at.as_ref().unwrap_or(&sidecar.from));
        }
        let _ = fs::rename(&unit.img_at, &previous);
        unit.img_at = previous;
        return Err(error.to_string());
    }
    unit.db_path = temp_path;
    if sidecar_temp.is_some() { unit.sidecar_at = sidecar_temp; }
    unit.parked = true;
    Ok(())
}

/// Puts a parked unit back under its own name; otherwise says where it stayed.
fn restore(unit: &mut Unit, conn: &rusqlite::Connection) -> Option<String> {
    let mut left_at: Option<String> = None;
    if unit.img_at != unit.source && unit.img_at.exists() {
        if !unit.source.exists() && fs::rename(&unit.img_at, &unit.source).is_ok() {
            unit.img_at = unit.source.clone();
            if unit.db_path != unit.path {
                let _ = conn.execute("UPDATE photos SET path = ?1 WHERE path = ?2", params![unit.path, unit.db_path]);
                unit.db_path = unit.path.clone();
            }
        } else {
            let current_path = unit.img_at.to_string_lossy().into_owned();
            if unit.db_path != current_path {
                let new_name = file_name_of(&unit.img_at);
                if conn
                    .execute("UPDATE photos SET path = ?1, filename = ?2 WHERE path = ?3", params![current_path, new_name, unit.db_path])
                    .is_ok()
                {
                    unit.db_path.clone_from(&current_path);
                }
            }
            left_at = Some(current_path);
        }
    }
    if let (Some(current), Some(sidecar)) = (unit.sidecar_at.clone(), unit.sidecar.as_ref()) {
        if current != sidecar.from && current.exists() && (sidecar.from.exists() || fs::rename(&current, &sidecar.from).is_err()) {
            left_at.get_or_insert_with(|| current.to_string_lossy().into_owned());
        }
    }
    left_at
}

/// Catalogue and caches after a successful rename.
fn commit(unit: &Unit, conn: &rusqlite::Connection, thumbnails_dir: &Path, raw_previews_dir: &Path) -> Result<(), String> {
    let new_path = unit.target.to_string_lossy().into_owned();
    // The cache files are named after the path: they follow the photo (size and date are unchanged by a rename).
    crate::carry_cache_file(unit.old_thumbnail.clone(), crate::thumbnail_cache_file(thumbnails_dir, &new_path).ok());
    crate::carry_cache_file(unit.old_raw_preview.clone(), crate::raw_preview_cache_file(raw_previews_dir, &new_path).ok());
    let new_name = file_name_of(&unit.target);
    let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    // A row of the new path can only be a leftover (the file was not there): the photo keeps its own row, hence its id.
    transaction.execute("DELETE FROM photos WHERE path = ?", params![new_path]).map_err(|error| error.to_string())?;
    transaction
        .execute("UPDATE photos SET path = ?1, filename = ?2 WHERE path = ?3", params![new_path, new_name, unit.db_path])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub(crate) fn execute(plan: Plan, conn: &rusqlite::Connection, thumbnails_dir: &Path, raw_previews_dir: &Path, hooks: &mut dyn Hooks) -> Outcome {
    let mut outcome = Outcome { renamed: Vec::new(), failed: plan.failed, not_processed: 0 };
    let mut pending: Vec<Unit> = plan
        .planned
        .into_iter()
        .map(|planned| Unit {
            old_thumbnail: crate::thumbnail_cache_file(thumbnails_dir, &planned.path).ok(),
            old_raw_preview: crate::raw_preview_cache_file(raw_previews_dir, &planned.path).ok(),
            size: fs::metadata(&planned.source).map_or(0, |metadata| metadata.len()),
            img_at: planned.source.clone(),
            sidecar_at: None,
            parked: false,
            db_path: planned.path.clone(),
            path: planned.path,
            source: planned.source,
            target: planned.target,
            sidecar: planned.sidecar,
            group: planned.group,
            waits: planned.waits_for_copies,
        })
        .collect();
    let mut park_counter = 0usize;

    'batch: while !pending.is_empty() {
        let mut progressed = false;
        let mut index = 0;
        while index < pending.len() {
            // Stop requested: the next photos stay as they are (never while a photo is parked under a temporary name).
            if hooks.cancelled() && !pending.iter().any(|unit| unit.parked) {
                outcome.not_processed = pending.len();
                break 'batch;
            }
            let copies_first = pending[index].waits
                && pending.iter().enumerate().any(|(other, unit)| other != index && unit.group == pending[index].group && unit.sidecar.as_ref().is_some_and(|sidecar| sidecar.copy));
            let step = if copies_first { Step::Wait } else { try_unit(&mut pending[index]) };
            match step {
                Step::Wait => index += 1,
                Step::Done => {
                    let unit = pending.remove(index);
                    match commit(&unit, conn, thumbnails_dir, raw_previews_dir) {
                        Ok(()) => outcome.renamed.push((unit.path.clone(), unit.target.to_string_lossy().into_owned())),
                        Err(error) => outcome.failed.push(RenameFailure { path: unit.path.clone(), code: "catalog".into(), detail: error }),
                    }
                    hooks.advance(unit.size);
                    progressed = true;
                }
                Step::Failed(code, detail) => {
                    let mut unit = pending.remove(index);
                    let left_at = restore(&mut unit, conn);
                    outcome.failed.push(RenameFailure { path: unit.path.clone(), code: code.into(), detail: left_at.map(|at| format!("{detail} ({at})")).unwrap_or(detail) });
                    hooks.advance(unit.size);
                    progressed = true;
                }
            }
        }
        if progressed { continue; }
        // Nothing can move: a swap or a case-only change. One photo is parked under a temporary name, which frees its name.
        if let Some(position) = pending.iter().position(|unit| !unit.parked) {
            if let Err(error) = park(&mut pending[position], &mut park_counter, conn) {
                let unit = pending.remove(position);
                outcome.failed.push(RenameFailure { path: unit.path.clone(), code: "io".into(), detail: error });
                hooks.advance(unit.size);
            }
        } else {
            // Every remaining photo is parked and none can move (a name taken meanwhile): they go back to their own name.
            for mut unit in pending.drain(..) {
                let left_at = restore(&mut unit, conn);
                outcome.failed.push(RenameFailure { path: unit.path.clone(), code: "exists".into(), detail: left_at.unwrap_or_else(|| file_name_of(&unit.target)) });
                hooks.advance(unit.size);
            }
            break;
        }
    }
    outcome
}

struct TaskHooks<'a>(&'a mut crate::FileTaskProgress);

impl Hooks for TaskHooks<'_> {
    fn cancelled(&self) -> bool { self.0.cancelled() }
    fn advance(&mut self, size: u64) { self.0.advance(size) }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Photos of the batch known to the catalogue; the others are failures.
fn split_tracked(conn: &rusqlite::Connection, items: Vec<RenameItem>) -> (Vec<RenameItem>, Vec<RenameFailure>) {
    let mut tracked = Vec::with_capacity(items.len());
    let mut failed = Vec::new();
    for item in items {
        let known: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE path = ?)", params![item.path], |row| row.get(0))
            .unwrap_or(false);
        if known { tracked.push(item); } else { failed.push(RenameFailure { path: item.path, code: "not_tracked".into(), detail: String::new() }); }
    }
    (tracked, failed)
}

/// Preview: what the batch would do, photo by photo, without changing anything (collisions with files on the disk, path length, sidecars...).
#[tauri::command(async)]
pub fn preview_rename_batch(state: State<'_, AppState>, items: Vec<RenameItem>) -> Result<Vec<PreviewStatus>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let order: Vec<String> = items.iter().map(|item| item.path.clone()).collect();
    let (tracked, untracked) = split_tracked(&conn, items);
    let plan = plan_batch(&tracked);
    let mut statuses: HashMap<String, PreviewStatus> = HashMap::new();
    for planned in &plan.planned {
        statuses.insert(planned.path.clone(), PreviewStatus { path: planned.path.clone(), status: "ok".into(), code: String::new(), detail: String::new() });
    }
    for path in &plan.unchanged {
        statuses.insert(path.clone(), PreviewStatus { path: path.clone(), status: "unchanged".into(), code: String::new(), detail: String::new() });
    }
    for failure in plan.failed.into_iter().chain(untracked) {
        statuses.entry(failure.path.clone()).or_insert(PreviewStatus { path: failure.path, status: "error".into(), code: failure.code, detail: failure.detail });
    }
    Ok(order.into_iter().filter_map(|path| statuses.remove(&path)).collect())
}

/// Renames the batch. Started by the task queue (`task_id`) beyond a few photos: progress published, stop possible between two photos
/// (the photos already renamed stay renamed: the interface offers to undo them).
#[tauri::command(async)]
pub fn rename_photos(app: tauri::AppHandle, state: State<'_, AppState>, items: Vec<RenameItem>, task_id: Option<String>) -> Result<RenameBatchResult, String> {
    // The semantic scan waits: it would read photos at the paths they are leaving.
    let _priority = crate::runtime::PriorityGuard::new();
    let paths: Vec<String> = items.iter().map(|item| item.path.clone()).collect();
    let mut progress = crate::FileTaskProgress::new(app, task_id, &paths);
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let (tracked, untracked) = split_tracked(&conn, items);
    let mut plan = plan_batch(&tracked);
    plan.failed.extend(untracked);
    let unchanged = plan.unchanged.len();
    // Photos that will not be touched count as done for the progress bar.
    for path in plan.unchanged.iter().chain(plan.failed.iter().map(|failure| &failure.path)) {
        progress.advance(fs::metadata(path).map_or(0, |metadata| metadata.len()));
    }
    let outcome = execute(plan, &conn, &state.thumbnails_dir(), &state.raw_previews_dir(), &mut TaskHooks(&mut progress));
    Ok(RenameBatchResult {
        renamed: outcome.renamed.into_iter().map(|(from, to)| crate::MovedFile { from, to }).collect(),
        unchanged,
        failed: outcome.failed,
        not_processed: outcome.not_processed,
    })
}

// ---------------------------------------------------------------------------
// Saved recipes
// ---------------------------------------------------------------------------

const MAX_PRESET_NAME: usize = 100;
const MAX_PRESET_STEPS: usize = 200_000;

pub fn init_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS rename_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE,
            steps TEXT NOT NULL DEFAULT '[]'
        )",
        [],
    )?;
    Ok(())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RenamePreset {
    pub id: i64,
    pub name: String,
    /// Steps of the recipe, as JSON (the format is the one of src/batch-rename.js).
    pub steps: String,
}

fn list_presets(conn: &rusqlite::Connection) -> Result<Vec<RenamePreset>, String> {
    let mut statement = conn.prepare("SELECT id, name, steps FROM rename_presets ORDER BY name_key").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok(RenamePreset { id: row.get(0)?, name: row.get(1)?, steps: row.get(2)? }))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

/// Saves a recipe (same name, ignoring case: it is replaced) and returns the list.
fn save_preset(conn: &rusqlite::Connection, name: &str, steps: &str) -> Result<Vec<RenamePreset>, String> {
    let name = name.trim();
    if name.is_empty() { return Err("empty_name".into()); }
    if name.chars().count() > MAX_PRESET_NAME { return Err("name_too_long".into()); }
    if steps.len() > MAX_PRESET_STEPS || !steps.trim_start().starts_with('[') { return Err("invalid_steps".into()); }
    conn.execute(
        "INSERT INTO rename_presets (name, name_key, steps) VALUES (?1, ?2, ?3)
         ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, steps = excluded.steps",
        params![name, name.to_lowercase(), steps],
    )
    .map_err(|error| error.to_string())?;
    list_presets(conn)
}

fn delete_preset(conn: &rusqlite::Connection, id: i64) -> Result<Vec<RenamePreset>, String> {
    conn.execute("DELETE FROM rename_presets WHERE id = ?", params![id]).map_err(|error| error.to_string())?;
    list_presets(conn)
}

#[tauri::command(async)]
pub fn list_rename_presets(state: State<'_, AppState>) -> Result<Vec<RenamePreset>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    list_presets(&conn)
}

#[tauri::command(async)]
pub fn save_rename_preset(state: State<'_, AppState>, name: String, steps: String) -> Result<Vec<RenamePreset>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    save_preset(&conn, &name, &steps)
}

#[tauri::command(async)]
pub fn delete_rename_preset(state: State<'_, AppState>, id: i64) -> Result<Vec<RenamePreset>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    delete_preset(&conn, id)
}

#[cfg(test)]
#[path = "tests/batch_rename.rs"]
mod tests;
