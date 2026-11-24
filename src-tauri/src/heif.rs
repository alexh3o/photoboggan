//! Support HEIC / HEIF (conteneur ISO BMFF : photos d'iPhone, d'Android récents, `.hif` de Canon…).
//!
//! - Décodage des pixels : crate `heic-rs` (Rust pur, sans bibliothèque native à distribuer). Elle applique déjà les rotations
//!   et miroirs du conteneur (`irot` / `imir`) : l'orientation EXIF des HEIC ne doit donc PAS être réappliquée.
//! - Lecture : dimensions, paquet XMP intégré au fichier, profil ICC, EXIF (l'EXIF est lu par `kamadak-exif` dans exif.rs).
//! - Écriture : le paquet XMP de l'image principale est remplacé par la version modifiée (note, couleur, mots-clés, titre, description, zones de
//!   visage…), créé s'il n'existe pas, sans toucher aux pixels ni à l'EXIF. Le fichier n'est remplacé qu'après une vérification complète du résultat (voir `verify`) ; si la structure
//!   du fichier sort de ce que l'on sait modifier sans risque, `Outcome::Unsupported` est renvoyé et l'appelant utilise un sidecar.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

pub const EXTENSIONS: [&str; 3] = ["heic", "heif", "hif"];
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const XMP_TYPES: [&str; 2] = ["application/rdf+xml", "application/xmp+xml"];

pub fn is_heif_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// Fichiers jusqu'à cette taille gardés en mémoire pour la lecture suivante du même fil (voir read_all).
const CACHE_MAX_BYTES: u64 = 32 * 1024 * 1024;

struct CachedFile { path: PathBuf, len: u64, modified: Option<SystemTime>, bytes: Arc<Vec<u8>> }

thread_local! {
    /// Dernier fichier lu par ce fil : un scan lit les dimensions, le XMP, l'EXIF puis les pixels d'une même photo l'un après l'autre.
    static LAST_READ: RefCell<Option<CachedFile>> = const { RefCell::new(None) };
}

/// Contenu du fichier (limité à MAX_FILE_BYTES). Le dernier fichier lu par le fil est gardé s'il fait moins de CACHE_MAX_BYTES et reste valable
/// tant que sa taille et sa date de modification ne changent pas : une photo n'est plus relue en entier à chaque lecture partielle.
fn read_all(path: &Path) -> Option<Arc<Vec<u8>>> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_FILE_BYTES { return None; }
    let modified = metadata.modified().ok();
    let cached = LAST_READ.with(|last| {
        last.borrow().as_ref().filter(|file| file.path == path && file.len == metadata.len() && file.modified == modified).map(|file| file.bytes.clone())
    });
    if cached.is_some() { return cached; }
    let bytes = Arc::new(fs::read(path).ok()?);
    if metadata.len() <= CACHE_MAX_BYTES && modified.is_some() {
        LAST_READ.with(|last| *last.borrow_mut() = Some(CachedFile { path: path.to_path_buf(), len: metadata.len(), modified, bytes: bytes.clone() }));
    }
    Some(bytes)
}

// ---------------------------------------------------------------------------
// Lecture des pixels
// ---------------------------------------------------------------------------

pub struct Decoded {
    pub rgb: Vec<u8>,
    pub width: usize,
    pub height: usize,
    /// Profil de couleur intégré (les iPhone écrivent du Display P3).
    pub icc: Option<Vec<u8>>,
}

/// Décode la photo en RGB 8 bits, rotations du conteneur appliquées.
pub fn decode(path: &Path) -> Result<Decoded, String> {
    let bytes = read_all(path).ok_or("Unreadable or too large HEIF file")?;
    let image = heic_rs::decode(&bytes, &heic_rs::DecodeOptions::default()).map_err(|e| format!("HEIC decoding failed: {e}"))?;
    if image.layout != heic_rs::PixelLayout::Rgb8 { return Err("Disposition de pixels HEIC inattendue".into()); }
    let (width, height) = (image.width as usize, image.height as usize);
    if width == 0 || height == 0 || image.data.len() != width * height * 3 { return Err("Inconsistent HEIC dimensions".into()); }
    let icc = icc_profile(&bytes);
    Ok(Decoded { rgb: image.data, width, height, icc })
}

fn icc_profile(bytes: &[u8]) -> Option<Vec<u8>> {
    let ctx = heic_rs::context::Context::open(bytes).ok()?;
    let props = ctx.props(ctx.meta.primary).ok()?;
    ctx.icc(&props).map(|icc| icc.to_vec())
}

/// JPEG pleine résolution (qualité 90, profil ICC conservé) pour l'affichage : le webview ne sait pas lire le HEIC.
pub fn preview_jpeg(path: &Path) -> Result<Vec<u8>, String> {
    let decoded = decode(path)?;
    if decoded.width > u16::MAX as usize || decoded.height > u16::MAX as usize { return Err("Image trop grande pour le JPEG".into()); }
    let mut output = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut output, 90);
    if let Some(icc) = &decoded.icc {
        // Un profil refusé n'empêche pas l'affichage : l'aperçu est servi sans lui (couleurs moins fidèles), l'échec est tracé.
        if let Err(error) = encoder.add_icc_profile(icc) { eprintln!("HEIF preview of {} written without its colour profile: {error}", path.display()); }
    }
    encoder.encode(&decoded.rgb, decoded.width as u16, decoded.height as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| format!("Encodage JPEG impossible : {e}"))?;
    Ok(output)
}

/// Dimensions affichées (après rotation du conteneur).
pub fn read_dimensions(path: &Path) -> Option<(i32, i32)> {
    let bytes = read_all(path)?;
    let info = heic_rs::probe(&bytes).ok()?;
    Some((info.width as i32, info.height as i32)).filter(|&(w, h)| w > 0 && h > 0)
}

/// Bloc EXIF au format d'un segment JPEG APP1 (`Exif\0\0` + TIFF), pour recopie dans un JPEG.
pub fn exif_app1_payload(path: &Path) -> Option<Vec<u8>> {
    let bytes = read_all(path)?;
    let ctx = heic_rs::context::Context::open(&bytes).ok()?;
    let tiff = ctx.exif(ctx.meta.primary).ok()??;
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(tiff);
    Some(payload)
}

// ---------------------------------------------------------------------------
// Analyse du conteneur (positions des champs, nécessaires pour modifier le fichier sur place)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct BoxRef { kind: [u8; 4], start: usize, header: usize, end: usize }
impl BoxRef { fn payload(&self) -> usize { self.start + self.header } }

fn be16(d: &[u8], p: usize) -> Option<u16> { Some(u16::from_be_bytes(d.get(p..p + 2)?.try_into().ok()?)) }
fn be32(d: &[u8], p: usize) -> Option<u32> { Some(u32::from_be_bytes(d.get(p..p + 4)?.try_into().ok()?)) }
fn be64(d: &[u8], p: usize) -> Option<u64> { Some(u64::from_be_bytes(d.get(p..p + 8)?.try_into().ok()?)) }
fn uint(d: &[u8], p: usize, size: usize) -> Option<u64> {
    match size { 0 => Some(0), 1 => d.get(p).map(|v| *v as u64), 2 => be16(d, p).map(u64::from), 4 => be32(d, p).map(u64::from), 8 => be64(d, p), _ => None }
}
fn cstr(d: &[u8], p: usize, limit: usize) -> Option<(String, usize)> {
    let end = p + d.get(p..limit)?.iter().position(|b| *b == 0)?;
    Some((String::from_utf8_lossy(&d[p..end]).into_owned(), end + 1))
}

fn children(d: &[u8], from: usize, to: usize) -> Option<Vec<BoxRef>> {
    let mut list = Vec::new();
    let mut p = from;
    while p + 8 <= to {
        let size = be32(d, p)? as u64;
        let kind: [u8; 4] = d.get(p + 4..p + 8)?.try_into().ok()?;
        let (header, end) = match size {
            0 => (8, to as u64),
            1 => (16, p as u64 + be64(d, p + 8)?), // taille sur 64 bits : la boîte a une taille connue
            s => (8, p as u64 + s),
        };
        let end = usize::try_from(end).ok()?;
        if end > to || end < p + header { return None; }
        list.push(BoxRef { kind, start: p, header, end });
        p = end;
    }
    Some(list)
}

struct Extent { off: u64, len: u64 }
struct Loc { id: u32, cm: u8, base: u64, extents: Vec<Extent> }
struct Infe { id: u32, kind: [u8; 4], content_type: String }
struct Layout {
    iref: Option<(BoxRef, u8)>, idat: Option<BoxRef>, primary: u32,
    infe: Vec<Infe>, locs: Vec<Loc>,
}

fn parse(d: &[u8]) -> Option<Layout> {
    let tops = children(d, 0, d.len())?;
    if tops.iter().any(|b| &b.kind == b"moov") { return None; } // séquences : offsets absolus ailleurs, non gérés
    let meta = *tops.iter().find(|b| &b.kind == b"meta")?;
    let kids = children(d, meta.payload() + 4, meta.end)?;
    let find = |k: &[u8; 4]| kids.iter().find(|b| &b.kind == k).copied();

    let pitm = find(b"pitm")?;
    let primary = if *d.get(pitm.payload())? == 0 { be16(d, pitm.payload() + 4)? as u32 } else { be32(d, pitm.payload() + 4)? };

    let iinf = find(b"iinf")?;
    let iinf_count_size = if *d.get(iinf.payload())? == 0 { 2 } else { 4 };
    let iinf_count_pos = iinf.payload() + 4;
    let mut infe = Vec::new();
    for b in children(d, iinf_count_pos + iinf_count_size, iinf.end)? {
        if &b.kind != b"infe" { continue; }
        let ver = *d.get(b.payload())?;
        let mut p = b.payload() + 4;
        if ver >= 2 {
            let id = if ver >= 3 { let v = be32(d, p)?; p += 4; v } else { let v = be16(d, p)? as u32; p += 2; v };
            p += 2;
            let kind: [u8; 4] = d.get(p..p + 4)?.try_into().ok()?;
            p += 4;
            let (_, next) = cstr(d, p, b.end)?;
            let content_type = if &kind == b"mime" { cstr(d, next, b.end)?.0 } else { String::new() };
            infe.push(Infe { id, kind, content_type });
        } else {
            let id = be16(d, p)? as u32;
            p += 4;
            let (_, next) = cstr(d, p, b.end)?;
            infe.push(Infe { id, kind: *b"    ", content_type: cstr(d, next, b.end)?.0 });
        }
    }

    let iloc = find(b"iloc")?;
    let iloc_ver = *d.get(iloc.payload())?;
    if iloc_ver > 2 { return None; }
    let mut p = iloc.payload() + 4;
    let sizes = *d.get(p)?;
    let (off_size, len_size) = ((sizes >> 4) as usize, (sizes & 15) as usize);
    let sizes2 = *d.get(p + 1)?;
    let base_size = (sizes2 >> 4) as usize;
    let idx_size = if iloc_ver >= 1 { (sizes2 & 15) as usize } else { 0 };
    p += 2;
    let iloc_count_size = if iloc_ver < 2 { 2 } else { 4 };
    let count = uint(d, p, iloc_count_size)?;
    p += iloc_count_size;
    let mut locs = Vec::new();
    for _ in 0..count {
        let id = if iloc_ver < 2 { let v = be16(d, p)? as u32; p += 2; v } else { let v = be32(d, p)?; p += 4; v };
        let cm = if iloc_ver >= 1 { let v = (be16(d, p)? & 0xf) as u8; p += 2; v } else { 0 };
        p += 2;
        let base = uint(d, p, base_size)?;
        p += base_size;
        let ext_count = be16(d, p)?;
        p += 2;
        let mut extents = Vec::new();
        for _ in 0..ext_count {
            p += idx_size;
            let off = uint(d, p, off_size)?;
            p += off_size;
            let len = uint(d, p, len_size)?;
            p += len_size;
            extents.push(Extent { off, len });
        }
        locs.push(Loc { id, cm, base, extents });
    }
    if p > iloc.end { return None; }

    let iref = find(b"iref").map(|b| (b, d.get(b.payload()).copied().unwrap_or(0)));
    Some(Layout { iref, idat: find(b"idat"), primary, infe, locs })
}

fn read_item(d: &[u8], lay: &Layout, loc: &Loc) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    for e in &loc.extents {
        if e.len == 0 { return None; }
        let start = usize::try_from(loc.base.checked_add(e.off)?).ok()?;
        let start = match loc.cm { 0 => start, 1 => lay.idat?.payload().checked_add(start)?, _ => return None };
        out.extend_from_slice(d.get(start..start.checked_add(usize::try_from(e.len).ok()?)?)?);
    }
    Some(out)
}

/// Pour chaque item qui en décrit d'autres (références `cdsc` du bloc `iref`) : les items décrits.
fn described_items(d: &[u8], lay: &Layout) -> std::collections::HashMap<u32, Vec<u32>> {
    let mut links: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    let Some((iref, version)) = lay.iref else { return links; };
    let Some(entries) = children(d, iref.payload() + 4, iref.end) else { return links; };
    let id_size = if version == 0 { 2 } else { 4 };
    for entry in entries.iter().filter(|entry| &entry.kind == b"cdsc") {
        let at = entry.payload();
        let (Some(from), Some(count)) = (uint(d, at, id_size), be16(d, at + id_size)) else { continue; };
        let targets = (0..count as usize).filter_map(|index| uint(d, at + id_size + 2 + index * id_size, id_size)).map(|id| id as u32);
        links.entry(from as u32).or_default().extend(targets);
    }
    links
}

/// Item XMP de l'image principale. Un HEIC d'Apple en contient plusieurs : celui du gain map HDR décrit l'image auxiliaire, pas la photo ; le prendre
/// (c'était le premier du fichier) faisait lire et modifier le mauvais paquet. Un item XMP rattaché (`cdsc`) à une autre image est ignoré ;
/// un item sans rattachement est pris pour celui du fichier.
fn xmp_item<'a>(d: &[u8], lay: &'a Layout) -> Option<(&'a Infe, &'a Loc)> {
    let links = described_items(d, lay);
    let infe = lay.infe.iter().find(|i| {
        &i.kind == b"mime"
            && XMP_TYPES.iter().any(|t| i.content_type.starts_with(t))
            && links.get(&i.id).is_none_or(|targets| targets.contains(&lay.primary))
    })?;
    Some((infe, lay.locs.iter().find(|l| l.id == infe.id)?))
}

fn xmp_text(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
    std::str::from_utf8(&bytes[..end]).ok().map(str::to_string)
}

/// Paquet XMP intégré au fichier, s'il y en a un.
pub fn read_xmp(path: &Path) -> Option<String> {
    let data = read_all(path)?;
    let lay = parse(&data)?;
    let (_, loc) = xmp_item(&data, &lay)?;
    xmp_text(&read_item(&data, &lay, loc)?)
}

#[cfg(test)]
#[path = "tests/heif.rs"]
mod tests;
