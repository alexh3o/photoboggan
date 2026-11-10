//! Statistics of the catalogue for the "Collection statistics" window (stats.js).
//!
//! Read-only: every figure comes from the `photos`, `photo_keywords`, `keyword_nodes`, `faces`, `persons` and `photo_embeddings` tables, computed
//! in one blocking pass over `photos` plus a few grouped queries on the photos that pass the filters.
//!
//! Filters (all optional, combined with AND): a period (two days, YYYYMMDD, given by the interface which owns the calendar arithmetic), cameras
//! (labels as the camera filter shows them), root folders (ids of the `folders` table) and file extensions (the interface turns the format
//! choices, which it owns, into a list of extensions). Without a period every photo counts, dated or not; with one, only the photos whose date
//! taken falls inside it do (a photo without a usable date cannot be placed in a period).
//!
//! The time chart is returned day by day (non-empty days only): the interface groups it by day, week, month, year or decade, so changing the
//! granularity needs no new request.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::State;

use crate::db::DbPool;
use crate::AppState;

/// Length of the keyword ranking.
const KEYWORD_TOP_COUNT: usize = 15;
/// Length of the ranking of people (by number of faces).
const PERSON_TOP_COUNT: usize = 5;

/// What to count. Every list empty and no period = the whole catalogue.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StatsFilter {
    /// First and last day of the period (YYYYMMDD, included); either may be absent.
    pub since: Option<u32>,
    pub until: Option<u32>,
    /// Camera labels (see `camera_label`), compared without regard to case.
    pub cameras: Vec<String>,
    /// Ids of root folders (`folders` table): the photos below them.
    pub folders: Vec<i64>,
    /// Lower-case extensions without the dot ("jpg", "arw").
    pub extensions: Vec<String>,
    /// Also count the photos analysed by the content search (only asked while that feature is on).
    pub with_analysis: bool,
}

/// A name and the number of photos it appears on.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedItem {
    pub name: String,
    pub count: i64,
}

/// A keyword: its own name (the last level of its path), the path of its ancestors (empty at the first level) and its photo count.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedKeyword {
    pub name: String,
    pub path: String,
    pub count: i64,
}

/// Photos of one day: `key` is YYYYMMDD.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub key: u32,
    pub count: i64,
}

/// Photos and bytes of one file extension ("" = no extension).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStat {
    pub extension: String,
    pub count: i64,
    pub size: i64,
}

/// Photos per range of one shooting parameter. `known`: photos that have the parameter (the others are in no range).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Distribution {
    pub known: i64,
    pub bins: Vec<RankedItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShootingStats {
    pub focal: Distribution,
    pub aperture: Distribution,
    pub shutter: Distribution,
    pub iso: Distribution,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStats {
    /// Photos counted and their total size in bytes.
    pub photos: i64,
    pub total_size: i64,
    /// Per extension, most photos first.
    pub extensions: Vec<ExtensionStat>,
    /// Photos per rating: index = number of stars, 0 = unrated.
    pub ratings: Vec<i64>,
    /// Photos per colour flag and per pick flag, as stored ("none" included); the interface decides which to show.
    pub colors: Vec<RankedItem>,
    pub picks: Vec<RankedItem>,
    /// Photos per day (non-empty days, ascending) and, of those counted, how many have a usable date taken.
    pub days: Vec<Bucket>,
    pub dated_photos: i64,
    /// Photos with GPS coordinates (latitude and longitude both known, as in the geolocation filter).
    pub geolocated_photos: i64,
    pub keywords: Vec<RankedKeyword>,
    /// Photos that carry at least one keyword.
    pub keyword_photos: i64,
    /// Faces shown by the interface and distinct people attributed to them, and the people with the most faces (see `face_stats`).
    pub faces: i64,
    pub persons: i64,
    pub top_persons: Vec<RankedItem>,
    pub shooting: ShootingStats,
    /// Photos analysed by the content search; None when not asked.
    pub analysed_photos: Option<i64>,
}

/// Values offered by the filters of the window, over the whole catalogue.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOptions {
    pub cameras: Vec<RankedItem>,
    pub folders: Vec<FolderOption>,
    pub extensions: Vec<RankedItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderOption {
    pub id: i64,
    pub path: String,
    pub count: i64,
}

/// Days of a month (Gregorian leap years).
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// Date taken of a photo as YYYYMMDD, or None when the text holds no usable date.
/// Same reading as `extractTimeKey` (main.js), which the grid and the date filter use: the first "YYYY?MM?DD" of the text, each "?" being
/// at most one non-digit character ("2026:08:12 14:30:00", "2026-08-12T14:30:00", "20260812"…). Stricter on one point: a month or day
/// that does not exist, or a year outside 1900-2200 (clock never set, garbage), is no date, so it never makes a chart column.
fn date_key(text: &str) -> Option<u32> {
    let bytes = text.as_bytes();
    let digits = |from: usize, count: usize| -> Option<u32> {
        let slice = bytes.get(from..from + count)?;
        slice.iter().all(u8::is_ascii_digit).then(|| slice.iter().fold(0, |value, byte| value * 10 + u32::from(byte - b'0')))
    };
    let skip_separator = |at: usize| if bytes.get(at).is_some_and(|byte| !byte.is_ascii_digit()) { at + 1 } else { at };
    for start in 0..bytes.len() {
        let Some(year) = digits(start, 4) else { continue };
        let at = skip_separator(start + 4);
        let Some(month) = digits(at, 2) else { continue };
        let at = skip_separator(at + 2);
        let Some(day) = digits(at, 2) else { continue };
        // First structural match decides, as in the interface.
        let valid = (1900..=2200).contains(&year) && (1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day);
        return valid.then_some(year * 10000 + month * 100 + day);
    }
    None
}

/// Fixed ranges of a shooting parameter, in display order. `edges` are the lower bounds (included) of every range but the first, ascending,
/// so there is one more label than edges. Ranges are fixed (not adapted to the data) so two periods can be compared.
struct Scale {
    labels: &'static [&'static str],
    edges: &'static [f64],
    /// Display from the largest value to the smallest (shutter: slow speeds first).
    descending: bool,
}

/// Focal length, compared in whole mm as the filter does.
const FOCAL: Scale = Scale {
    labels: &["< 16 mm", "16–24 mm", "25–35 mm", "36–70 mm", "71–135 mm", "136–300 mm", "> 300 mm"],
    edges: &[16.0, 25.0, 36.0, 71.0, 136.0, 301.0],
    descending: false,
};
/// F-number, compared to the tenth as the filter does.
const APERTURE: Scale = Scale {
    labels: &["≤ f/1.4", "f/1.5–2", "f/2.1–2.8", "f/2.9–4", "f/4.1–5.6", "f/5.7–8", "f/8.1–11", "> f/11"],
    edges: &[1.5, 2.1, 2.9, 4.1, 5.7, 8.1, 11.1],
    descending: false,
};
/// Exposure time in seconds. Each edge is the speed itself minus 0.5 %, the filter's tolerance for unreduced fractions and EXIF rounding
/// (1/4000, 1/1000, 1/250, 1/60, 1/15, 1 s). A range includes its slower bound: 1/60 s is in "1/60 – 1/15 s".
const SHUTTER: Scale = Scale {
    labels: &["< 1/4000 s", "1/4000 – 1/1000 s", "1/1000 – 1/250 s", "1/250 – 1/60 s", "1/60 – 1/15 s", "1/15 – 1 s", "≥ 1 s"],
    edges: &[0.000_248_75, 0.000_995, 0.003_98, 0.016_583_333, 0.066_333_333, 0.995],
    descending: true,
};
const ISO: Scale = Scale {
    labels: &["≤ 100", "101–200", "201–400", "401–800", "801–1600", "1601–3200", "3201–6400", "> 6400"],
    edges: &[101.0, 201.0, 401.0, 801.0, 1601.0, 3201.0, 6401.0],
    descending: false,
};

/// Counts of the photos counted per range of a scale.
struct Histogram {
    scale: &'static Scale,
    counts: Vec<i64>,
    known: i64,
}

impl Histogram {
    fn new(scale: &'static Scale) -> Self {
        debug_assert_eq!(scale.labels.len(), scale.edges.len() + 1);
        Self { scale, counts: vec![0; scale.labels.len()], known: 0 }
    }

    /// A photo without the parameter (None) is in no range.
    fn add(&mut self, value: Option<f64>) {
        let Some(value) = value else { return };
        self.known += 1;
        self.counts[self.scale.edges.iter().take_while(|edge| value >= **edge).count()] += 1;
    }

    fn finish(self) -> Distribution {
        let mut bins: Vec<RankedItem> = self.scale.labels.iter().zip(self.counts).map(|(label, count)| RankedItem { name: (*label).to_string(), count }).collect();
        if self.scale.descending {
            bins.reverse();
        }
        Distribution { known: self.known, bins }
    }
}

/// `^\d+(?:[.,]\d+)?$` as a number (the interface's `parseDecimal`).
fn parse_decimal(text: &str) -> Option<f64> {
    let (whole, fraction) = match text.split_once(|c| c == '.' || c == ',') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|part| !digits(part)) {
        return None;
    }
    format!("{whole}.{}", fraction.unwrap_or("0")).parse().ok()
}

fn without_spaces(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Focal length in mm: the leading number of "50 mm", "50.0 mm" (like the filter's `parseFloat`).
fn parse_focal(text: &str) -> Option<f64> {
    let mut seen_dot = false;
    let number: String = text
        .trim()
        .chars()
        .take_while(|c| match c {
            '0'..='9' => true,
            '.' if !seen_dot => {
                seen_dot = true;
                true
            }
            _ => false,
        })
        .collect();
    number.parse::<f64>().ok().filter(|value| *value > 0.0)
}

/// F-number of "f/2.8", "F2.8" or "2.8".
fn parse_aperture(text: &str) -> Option<f64> {
    let compact = without_spaces(text);
    let number = match compact.strip_prefix('f').or_else(|| compact.strip_prefix('F')) {
        Some(rest) => rest.strip_prefix('/').unwrap_or(rest),
        None => compact.as_str(),
    };
    parse_decimal(number).filter(|value| *value > 0.0)
}

/// Exposure time in seconds: "1/250" (also unreduced, "10/2500"), or "2" / "2.5" above one second; a trailing "s" is accepted.
fn parse_shutter(text: &str) -> Option<f64> {
    let compact = without_spaces(text);
    let clean = compact.strip_suffix('s').or_else(|| compact.strip_suffix('S')).unwrap_or(&compact);
    let value = match clean.split_once('/') {
        Some((numerator, denominator)) => {
            let (numerator, denominator) = (parse_decimal(numerator)?, parse_decimal(denominator)?);
            if denominator > 0.0 {
                numerator / denominator
            } else {
                return None;
            }
        }
        None => parse_decimal(clean)?,
    };
    (value > 0.0).then_some(value)
}

/// Camera label of the interface (`cameraLabel`, shooting-filters.js): make and model, the make dropped when the model already starts with it
/// ("Canon" + "Canon EOS R5" -> "Canon EOS R5"), so the camera filter of this window offers the same names as the one of the filter panel.
fn camera_label(make: &str, model: &str) -> String {
    let (make, model) = (make.trim(), model.trim());
    let brand = make.split_whitespace().next().unwrap_or("").to_lowercase();
    if model.is_empty() {
        make.to_string()
    } else if make.is_empty() || (!brand.is_empty() && model.to_lowercase().starts_with(&brand)) {
        model.to_string()
    } else {
        format!("{make} {model}")
    }
}

/// Lower-case extension of a path without the dot ("" when it has none).
fn extension_of(path: &str) -> String {
    let name = path.rsplit(|c| c == '/' || c == '\\').next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Path compared without regard to case or separator kind (Windows paths may mix them).
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// Prefix every photo below a root folder starts with: the folder, normalised, ending with one separator.
fn folder_prefix(path: &str) -> String {
    format!("{}/", normalize_path(path).trim_end_matches('/'))
}

/// A JSON array of ids, for `json_each` (one bound parameter instead of thousands).
fn ids_json(ids: &[i64]) -> String {
    format!("[{}]", ids.iter().map(i64::to_string).collect::<Vec<_>>().join(","))
}

/// SQL condition restricting `column` (a photo id) to the photos counted, and its bound parameter. `ids`: those photos passed as one JSON array;
/// None: the whole catalogue, the condition is simply true and nothing is bound.
fn period_scope(column: &str, ids: Option<&[i64]>) -> (String, Vec<rusqlite::types::Value>) {
    match ids {
        Some(ids) => (format!("{column} IN (SELECT value FROM json_each(?1))"), vec![ids_json(ids).into()]),
        None => ("1".to_string(), Vec::new()),
    }
}

/// Faces, distinct people and the people with the most faces, on the photos counted. Only faces the interface shows count: not ignored, not
/// marked "not a face", not rejected by the size / confidence filters. A person counts when at least one such face is attributed to them
/// (`person_id`, set for confirmed faces and for faces attributed by recognition; a mere suggestion is not an attribution). Hidden people are
/// left out of the ranking, as they are from the people list.
fn face_stats(conn: &Connection, ids: Option<&[i64]>) -> rusqlite::Result<(i64, i64, Vec<RankedItem>)> {
    let (scope, bound) = period_scope("f.photo_id", ids);
    let (faces, persons) = conn.query_row(
        &format!(
            "SELECT COUNT(*), COUNT(DISTINCT f.person_id) FROM faces f JOIN photos p ON p.id = f.photo_id
             WHERE f.state NOT IN ('ignored', 'not_face', 'filtered') AND {scope}"
        ),
        rusqlite::params_from_iter(bound.iter()),
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let mut statement = conn.prepare(&format!(
        "SELECT pe.name, COUNT(*) AS used FROM faces f JOIN photos p ON p.id = f.photo_id JOIN persons pe ON pe.id = f.person_id
         WHERE f.state NOT IN ('ignored', 'not_face', 'filtered') AND pe.hidden = 0 AND {scope}
         GROUP BY f.person_id ORDER BY used DESC, pe.name LIMIT {PERSON_TOP_COUNT}"
    ))?;
    let top = statement
        .query_map(rusqlite::params_from_iter(bound.iter()), |row| Ok(RankedItem { name: row.get(0)?, count: row.get(1)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((faces, persons, top))
}

/// Photos analysed by the content search (embedding of the active model), among the photos counted.
fn analysed_count(conn: &Connection, ids: Option<&[i64]>) -> rusqlite::Result<i64> {
    let (scope, mut bound) = period_scope("e.photo_id", ids);
    bound.push(crate::semantic_models::active_model().id.to_string().into());
    let sql = format!("SELECT COUNT(*) FROM photo_embeddings e JOIN photos p ON p.id = e.photo_id WHERE e.model_id = ?{} AND {scope}", bound.len());
    match conn.query_row(&sql, rusqlite::params_from_iter(bound.iter()), |row| row.get(0)) {
        // The table is created with the first analysis: before it, nothing is analysed.
        Err(rusqlite::Error::SqliteFailure(_, Some(message))) if message.contains("no such table") => Ok(0),
        other => other,
    }
}

/// Name and ancestors path of a keyword node, or None if the node no longer exists.
fn keyword_name_and_path(conn: &Connection, id: i64) -> rusqlite::Result<Option<(String, String)>> {
    let mut names = Vec::new();
    let mut current = id;
    // The depth guard only protects against a damaged tree (a loop); real paths are a few levels deep.
    while current != 0 && names.len() < 64 {
        let node = conn
            .prepare_cached("SELECT parent_id, name FROM keyword_nodes WHERE id = ?1")?
            .query_row(params![current], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .optional()?;
        let Some((parent, name)) = node else { break };
        names.push(name);
        current = parent;
    }
    if names.is_empty() {
        return Ok(None);
    }
    let name = names.remove(0);
    names.reverse();
    Ok(Some((name, names.join(" / "))))
}

/// Most given keywords and the number of photos with at least one keyword. `ids`: the photos counted; None: the whole catalogue.
/// Keywords come from the link table (the last level of each path, as the keyword panel and filters count them), not from the text column.
fn keyword_stats(conn: &Connection, ids: Option<&[i64]>) -> rusqlite::Result<(Vec<RankedKeyword>, i64)> {
    let (scope, bound) = period_scope("pk.photo_id", ids);
    let with_keywords: i64 = conn.query_row(
        &format!("SELECT COUNT(DISTINCT pk.photo_id) FROM photo_keywords pk JOIN photos p ON p.id = pk.photo_id WHERE {scope}"),
        rusqlite::params_from_iter(bound.iter()),
        |row| row.get(0),
    )?;
    // Ties are broken by id so the ranking is stable from one call to the next.
    let mut statement = conn.prepare(&format!(
        "SELECT pk.keyword_id, COUNT(*) AS used FROM photo_keywords pk JOIN photos p ON p.id = pk.photo_id
         WHERE {scope} GROUP BY pk.keyword_id ORDER BY used DESC, pk.keyword_id LIMIT {KEYWORD_TOP_COUNT}"
    ))?;
    let ranked: Vec<(i64, i64)> = statement
        .query_map(rusqlite::params_from_iter(bound.iter()), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut keywords = Vec::new();
    for (id, count) in ranked {
        if let Some((name, path)) = keyword_name_and_path(conn, id)? {
            keywords.push(RankedKeyword { name, path, count });
        }
    }
    Ok((keywords, with_keywords))
}

/// The filters of a request, ready to test a photo against.
struct Selection {
    since: Option<u32>,
    until: Option<u32>,
    /// Lower-case camera labels.
    cameras: HashSet<String>,
    /// Folder prefixes (`folder_prefix`); `None` = no folder filter.
    folders: Option<Vec<String>>,
    extensions: HashSet<String>,
}

impl Selection {
    fn dated(&self) -> bool {
        self.since.is_some() || self.until.is_some()
    }

    /// True when some filter narrows the catalogue (then the keyword, face and analysis queries are limited to the photos kept).
    fn restricts(&self) -> bool {
        self.dated() || !self.cameras.is_empty() || self.folders.is_some() || !self.extensions.is_empty()
    }
}

fn selection_of(conn: &Connection, filter: &StatsFilter) -> rusqlite::Result<Selection> {
    let folders = if filter.folders.is_empty() {
        None
    } else {
        let mut statement = conn.prepare("SELECT path FROM folders WHERE id IN (SELECT value FROM json_each(?1))")?;
        let paths = statement.query_map(params![ids_json(&filter.folders)], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut prefixes: Vec<String> = paths.iter().map(|path| folder_prefix(path)).collect();
        // Folders asked for but no longer in the catalogue: nothing matches (not "everything").
        if prefixes.is_empty() {
            prefixes.push("\u{0}/".to_string());
        }
        Some(prefixes)
    };
    Ok(Selection {
        since: filter.since,
        until: filter.until,
        cameras: filter.cameras.iter().map(|label| label.trim().to_lowercase()).collect(),
        folders,
        extensions: filter.extensions.iter().map(|extension| extension.trim().trim_start_matches('.').to_lowercase()).collect(),
    })
}

fn compute(pool: &DbPool, filter: &StatsFilter) -> Result<CollectionStats, String> {
    let conn = pool.get().map_err(|error| error.to_string())?;
    compute_with(&conn, filter).map_err(|error| error.to_string())
}

fn compute_with(conn: &Connection, filter: &StatsFilter) -> rusqlite::Result<CollectionStats> {
    let selection = selection_of(conn, filter)?;
    let restricted = selection.restricts();

    let mut photos = 0i64;
    let mut total_size = 0i64;
    let mut dated_photos = 0i64;
    let mut geolocated_photos = 0i64;
    let (mut focal, mut aperture, mut shutter, mut iso) = (Histogram::new(&FOCAL), Histogram::new(&APERTURE), Histogram::new(&SHUTTER), Histogram::new(&ISO));
    let mut by_extension: HashMap<String, (i64, i64)> = HashMap::new();
    let mut ratings = vec![0i64; 6];
    let mut colors: HashMap<String, i64> = HashMap::new();
    let mut picks: HashMap<String, i64> = HashMap::new();
    let mut days: BTreeMap<u32, i64> = BTreeMap::new();
    // Ids of the photos kept, for the grouped queries below; only needed when a filter narrows the catalogue.
    let mut ids: Vec<i64> = Vec::new();

    let mut statement = conn.prepare(
        "SELECT id, date_taken, manufacturer, camera_model, gps_lat IS NOT NULL AND gps_lon IS NOT NULL, aperture, shutter_speed, focal_length, iso,
                path, file_size, rating, color_flag, pick_flag FROM photos",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let path = row.get::<_, Option<String>>(9)?.unwrap_or_default();
        let extension = extension_of(&path);
        if !selection.extensions.is_empty() && !selection.extensions.contains(&extension) {
            continue;
        }
        if let Some(prefixes) = &selection.folders {
            let normalized = normalize_path(&path);
            if !prefixes.iter().any(|prefix| normalized.starts_with(prefix.as_str())) {
                continue;
            }
        }
        if !selection.cameras.is_empty() {
            let make = row.get::<_, Option<String>>(2)?.unwrap_or_default();
            let model = row.get::<_, Option<String>>(3)?.unwrap_or_default();
            if !selection.cameras.contains(&camera_label(&make, &model).to_lowercase()) {
                continue;
            }
        }
        let key = row.get::<_, Option<String>>(1)?.as_deref().and_then(date_key);
        if selection.dated() {
            // A photo without a usable date is outside every period.
            let Some(key) = key else { continue };
            if selection.since.is_some_and(|since| key < since) || selection.until.is_some_and(|until| key > until) {
                continue;
            }
        }
        if restricted {
            ids.push(row.get(0)?);
        }

        photos += 1;
        let size = row.get::<_, Option<i64>>(10)?.unwrap_or(0).max(0);
        total_size += size;
        let entry = by_extension.entry(extension).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += size;
        if let Some(key) = key {
            dated_photos += 1;
            *days.entry(key).or_insert(0) += 1;
        }
        if row.get::<_, bool>(4)? {
            geolocated_photos += 1;
        }
        ratings[row.get::<_, Option<i64>>(11)?.unwrap_or(0).clamp(0, 5) as usize] += 1;
        for (column, counts) in [(12usize, &mut colors), (13usize, &mut picks)] {
            let flag = row.get::<_, Option<String>>(column)?.unwrap_or_default().trim().to_lowercase();
            *counts.entry(if flag.is_empty() { "none".to_string() } else { flag }).or_insert(0) += 1;
        }
        // Same readings and precision as the shooting filters: focal in whole mm, f-number to the tenth.
        focal.add(row.get::<_, Option<String>>(7)?.as_deref().and_then(parse_focal).map(f64::round));
        aperture.add(row.get::<_, Option<String>>(5)?.as_deref().and_then(parse_aperture).map(|value| (value * 10.0).round() / 10.0));
        shutter.add(row.get::<_, Option<String>>(6)?.as_deref().and_then(parse_shutter));
        iso.add(row.get::<_, Option<f64>>(8)?.filter(|value| *value > 0.0).map(f64::round));
    }

    let scope_ids = restricted.then_some(ids.as_slice());
    let (keywords, keyword_photos) = keyword_stats(conn, scope_ids)?;
    let (faces, persons, top_persons) = face_stats(conn, scope_ids)?;
    let analysed_photos = if filter.with_analysis { Some(analysed_count(conn, scope_ids)?) } else { None };

    let mut extensions: Vec<ExtensionStat> = by_extension.into_iter().map(|(extension, (count, size))| ExtensionStat { extension, count, size }).collect();
    extensions.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.extension.cmp(&b.extension)));
    let ranked = |counts: HashMap<String, i64>| {
        let mut items: Vec<RankedItem> = counts.into_iter().map(|(name, count)| RankedItem { name, count }).collect();
        items.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        items
    };
    Ok(CollectionStats {
        photos,
        total_size,
        extensions,
        ratings,
        colors: ranked(colors),
        picks: ranked(picks),
        days: days.into_iter().map(|(key, count)| Bucket { key, count }).collect(),
        dated_photos,
        geolocated_photos,
        keywords,
        keyword_photos,
        faces,
        persons,
        top_persons,
        shooting: ShootingStats { focal: focal.finish(), aperture: aperture.finish(), shutter: shutter.finish(), iso: iso.finish() },
        analysed_photos,
    })
}

fn filter_options(pool: &DbPool) -> Result<FilterOptions, String> {
    let conn = pool.get().map_err(|error| error.to_string())?;
    filter_options_with(&conn).map_err(|error| error.to_string())
}

fn filter_options_with(conn: &Connection) -> rusqlite::Result<FilterOptions> {
    // Cameras: grouped in SQL, then merged by label (two make / model pairs can give the same label).
    let mut cameras: HashMap<String, (String, i64)> = HashMap::new();
    let mut statement = conn.prepare("SELECT manufacturer, camera_model, COUNT(*) FROM photos GROUP BY manufacturer, camera_model")?;
    let groups = statement.query_map([], |row| {
        Ok((row.get::<_, Option<String>>(0)?.unwrap_or_default(), row.get::<_, Option<String>>(1)?.unwrap_or_default(), row.get::<_, i64>(2)?))
    })?;
    for group in groups {
        let (make, model, count) = group?;
        let label = camera_label(&make, &model);
        if label.is_empty() {
            continue;
        }
        cameras.entry(label.to_lowercase()).or_insert_with(|| (label.clone(), 0)).1 += count;
    }

    // Root folders and extensions: one pass over the paths.
    let mut folder_statement = conn.prepare("SELECT id, path FROM folders ORDER BY path")?;
    let mut folders: Vec<(FolderOption, String)> = folder_statement
        .query_map([], |row| Ok(FolderOption { id: row.get(0)?, path: row.get(1)?, count: 0 }))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|folder| {
            let prefix = folder_prefix(&folder.path);
            (folder, prefix)
        })
        .collect();
    let mut extension_counts: HashMap<String, i64> = HashMap::new();
    let mut path_statement = conn.prepare("SELECT path FROM photos")?;
    let mut paths = path_statement.query([])?;
    while let Some(row) = paths.next()? {
        let path = row.get::<_, Option<String>>(0)?.unwrap_or_default();
        let normalized = normalize_path(&path);
        for (folder, prefix) in folders.iter_mut() {
            if normalized.starts_with(prefix.as_str()) {
                folder.count += 1;
            }
        }
        let extension = extension_of(&path);
        if !extension.is_empty() {
            *extension_counts.entry(extension).or_insert(0) += 1;
        }
    }

    let by_count = |a: &RankedItem, b: &RankedItem| b.count.cmp(&a.count).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let mut cameras: Vec<RankedItem> = cameras.into_values().map(|(name, count)| RankedItem { name, count }).collect();
    cameras.sort_by(by_count);
    let mut extensions: Vec<RankedItem> = extension_counts.into_iter().map(|(name, count)| RankedItem { name, count }).collect();
    extensions.sort_by(by_count);
    Ok(FilterOptions { cameras, folders: folders.into_iter().map(|(folder, _)| folder).collect(), extensions })
}

/// Statistics of the collection for a set of filters (see `StatsFilter`).
#[tauri::command]
pub async fn get_collection_stats(state: State<'_, AppState>, filter: StatsFilter) -> Result<CollectionStats, String> {
    let pool = state.pool();
    tokio::task::spawn_blocking(move || compute(&pool, &filter)).await.map_err(|error| error.to_string())?
}

/// Cameras, root folders and extensions of the catalogue, with their photo counts: what the filters of the window offer.
#[tauri::command]
pub async fn get_stats_filter_options(state: State<'_, AppState>) -> Result<FilterOptions, String> {
    let pool = state.pool();
    tokio::task::spawn_blocking(move || filter_options(&pool)).await.map_err(|error| error.to_string())?
}
