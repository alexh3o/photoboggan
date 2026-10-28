use std::fs;
use std::path::Path;
use std::io::Read;
use exif::{Context, In, Reader, Tag, Value};

#[derive(Default)]
pub struct ExifMetadata {
    pub date_taken: String,
    pub aperture: String,
    pub shutter_speed: String,
    pub iso: i32,
    pub focal_length: String,
    pub manufacturer: String,
    pub camera_model: String,
    pub lens_model: String,
    pub width: i32,
    pub height: i32,
    pub rating: i32,
    pub color_flag: String,
    pub keywords: String,
    // Mots-clés hiérarchiques actifs lus dans le fichier : un chemin par mot-clé (ex. ["Lieux", "France", "Paris"]), voir parse_hierarchical_keywords.
    pub keyword_paths: Vec<Vec<String>>,
    /// Titre retenu : la première source non vide dans l'ordre de priorité réglé (voir TITLE_SOURCE_IDS).
    pub title: String,
    /// Description retenue (colonne `caption` de la base) : la première source non vide dans l'ordre de priorité réglé (voir DESCRIPTION_SOURCE_IDS).
    pub caption: String,
    /// Valeur de chaque source de titre et de description, utile à la vérification après écriture.
    pub text_sources: TextSources,
    /// Note de chaque source (en étoiles, 0 à 5), dans l'ordre de RATING_SOURCE_IDS.
    pub rating_sources: [Option<i32>; 5],
    /// Couleur de chaque source (clé de couleur), dans l'ordre de COLOR_SOURCE_IDS.
    pub color_sources: [Option<&'static str>; 3],
    /// Orientation EXIF et zones de visage (voir faces.rs).
    pub faces: crate::faces::PhotoFaces,
}

fn xmp_value(xml: &str, names: &[&str]) -> Option<String> {
    for name in names {
        // XMP is XML; accept both rdf attributes and element values, including
        // arbitrary namespace prefixes used by metadata editors.
        let mut search_from = 0;
        while let Some(rel) = xml[search_from..].find(name) {
            let start = search_from + rel;
            let before_ok = start == 0 || !xml.as_bytes()[start - 1].is_ascii_alphanumeric();
            let after = start + name.len();
            let after_ok = xml.as_bytes().get(after).is_some_and(|b| *b == b'=' || *b == b'>' || b.is_ascii_whitespace());
            if before_ok && after_ok {
                let tail = &xml[after..];
                let tail = tail.trim_start();
                if tail.starts_with('=') {
                    let value = tail[1..].trim_start();
                    if let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'') {
                        let body = &value[quote.len_utf8()..];
                        if let Some(end) = body.find(quote) { return Some(body[..end].to_string()); }
                    }
                } else if let Some(open_end) = tail.find('>') {
                    let value = tail[open_end + 1..].trim_start();
                    if let Some(end) = value.find('<') { return Some(value[..end].trim().to_string()); }
                }
            }
            search_from = after;
            if search_from >= xml.len() { break; }
        }
    }
    None
}

const JPEG_XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn find_jpeg_xmp_segment(data: &[u8]) -> Option<(usize, usize, usize)> {
    if data.len() < 4 || data[0..2] != [0xff, 0xd8] { return None; }
    let mut pos = 2;
    while pos + 4 <= data.len() {
        let marker_start = pos;
        if data[pos] != 0xff { return None; }
        while pos < data.len() && data[pos] == 0xff { pos += 1; }
        if pos >= data.len() { return None; }
        let marker = data[pos];
        pos += 1;
        if marker == 0xda || marker == 0xd9 { break; }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) { continue; }
        if pos + 2 > data.len() { return None; }
        let length = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
        if length < 2 || pos + length > data.len() { return None; }
        let segment_end = pos + length;
        let payload_start = pos + 2;
        if marker == 0xe1 && data[payload_start..segment_end].starts_with(JPEG_XMP_HEADER) {
            return Some((marker_start, segment_end, payload_start + JPEG_XMP_HEADER.len()));
        }
        pos = segment_end;
    }
    None
}

fn read_embedded_jpeg_xmp(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut data = Vec::new();
    file.take(4 * 1024 * 1024).read_to_end(&mut data).ok()?;
    let (_, segment_end, packet_start) = find_jpeg_xmp_segment(&data)?;
    std::str::from_utf8(&data[packet_start..segment_end]).ok().map(str::to_string)
}

/// Paquet XMP intégré au fichier : segment APP1 d'un JPEG, ou item XMP d'un HEIC / HEIF.
fn read_embedded_xmp(path: &Path) -> Option<String> {
    // Vidéo : pas de paquet XMP intégré lu (inutile et coûteux sur un gros fichier), seul le sidecar compte.
    if crate::video::is_video_path(path) { return None; }
    if crate::heif::is_heif_path(path) { crate::heif::read_xmp(path) } else { read_embedded_jpeg_xmp(path) }
}

/// Champs lus dans les segments d'un JPEG : IPTC (mots-clés 2:25, titre ObjectName 2:05, description Caption 2:120) et commentaire JPEG (COM).
#[derive(Default)]
struct JpegFields {
    keywords: Vec<String>,
    object_name: Option<String>,
    caption: Option<String>,
    comment: Option<String>,
}

/// Texte d'un champ binaire : UTF-8 s'il est valide, sinon Latin-1 (anciens commentaires JPEG).
fn text_from_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes.iter().map(|byte| char::from(*byte)).collect(),
    }
}

fn read_jpeg_fields(path: &Path) -> JpegFields {
    let mut fields = JpegFields::default();
    let Ok(file) = fs::File::open(path) else { return fields; };
    let mut bytes = Vec::new();
    if file.take(16 * 1024 * 1024).read_to_end(&mut bytes).is_err() { return fields; }
    if bytes.len() < 4 || bytes[0..2] != [0xff, 0xd8] { return fields; }
    let mut pos = 2;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xff { break; }
        while pos < bytes.len() && bytes[pos] == 0xff { pos += 1; }
        if pos >= bytes.len() { break; }
        let marker = bytes[pos]; pos += 1;
        if marker == 0xda || marker == 0xd9 { break; }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) { continue; }
        if pos + 2 > bytes.len() { break; }
        let segment_len = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
        if segment_len < 2 || pos + segment_len > bytes.len() { break; }
        let data = &bytes[pos + 2..pos + segment_len];
        if marker == 0xfe && fields.comment.is_none() {
            fields.comment = clean_text(&text_from_bytes(data));
        }
        if marker == 0xed && data.starts_with(b"Photoshop 3.0\0") {
            let mut p = 14;
            while p + 12 <= data.len() && &data[p..p + 4] == b"8BIM" {
                let resource = u16::from_be_bytes([data[p + 4], data[p + 5]]);
                p += 6;
                let name_len = data[p] as usize;
                p += 1 + name_len;
                if (1 + name_len) % 2 != 0 { p += 1; }
                if p + 4 > data.len() { break; }
                let resource_len = u32::from_be_bytes([data[p], data[p+1], data[p+2], data[p+3]]) as usize;
                p += 4;
                if p + resource_len > data.len() { break; }
                if resource == 0x0404 {
                    let iptc = &data[p..p + resource_len];
                    let mut q = 0;
                    while q + 5 <= iptc.len() {
                        if iptc[q] != 0x1c { q += 1; continue; }
                        let record = iptc[q + 1]; let dataset = iptc[q + 2];
                        let mut value_len = u16::from_be_bytes([iptc[q + 3], iptc[q + 4]]) as usize;
                        let mut header = 5;
                        if value_len & 0x8000 != 0 {
                            let n = (value_len & 0x7fff) as usize;
                            if n == 0 || n > 4 || q + 5 + n > iptc.len() { break; }
                            value_len = 0;
                            for byte in &iptc[q + 5..q + 5 + n] { value_len = (value_len << 8) | *byte as usize; }
                            header += n;
                        }
                        if q + header + value_len > iptc.len() { break; }
                        let value = &iptc[q + header..q + header + value_len];
                        if record == 2 && dataset == 25 {
                            let word = String::from_utf8_lossy(value).trim().to_string();
                            if !word.is_empty() && !fields.keywords.contains(&word) { fields.keywords.push(word); }
                        } else if record == 2 && dataset == 5 && fields.object_name.is_none() {
                            fields.object_name = clean_text(&String::from_utf8_lossy(value));
                        } else if record == 2 && dataset == 120 && fields.caption.is_none() {
                            fields.caption = clean_text(&String::from_utf8_lossy(value));
                        }
                        q += header + value_len;
                    }
                }
                p += resource_len;
                if resource_len % 2 != 0 { p += 1; }
            }
        }
        pos += segment_len;
    }
    fields
}

/// Contenu XMP utile d'un fichier (paquet intégré, puis sidecar pour ce qui manque).
#[derive(Default)]
struct ParsedXmp {
    /// Sources XMP de la note, dans l'ordre de RATING_SOURCE_IDS (les trois premières).
    ratings: [Option<i32>; 3],
    /// Sources XMP de la couleur, dans l'ordre de COLOR_SOURCE_IDS.
    colors: [Option<&'static str>; 3],
    keywords: String,
    keyword_paths: Vec<Vec<String>>,
    /// Sources XMP du titre, dans l'ordre de TITLE_SOURCE_IDS (les deux premières).
    titles: [Option<String>; 2],
    /// Sources XMP de la description, dans l'ordre de DESCRIPTION_SOURCE_IDS (les quatre premières).
    descriptions: [Option<String>; 4],
    /// Zones de visage (None : lecture des visages désactivée).
    face_regions: Option<Vec<crate::faces::FaceRegion>>,
}

fn parse_xmp(path: &Path) -> ParsedXmp {
    let mut sources = Vec::new();
    // digiKam can use either `photo.jpg.xmp` or the compatible `photo.xmp` name.
    sources.push(std::path::PathBuf::from(format!("{}.xmp", path.display())));
    if let Some(stem) = path.file_stem() {
        if let Some(parent) = path.parent() { sources.push(parent.join(stem).with_extension("xmp")); }
    }
    let mut keywords = Vec::new();
    let mut hierarchical: Vec<Vec<String>> = Vec::new();
    let mut ratings: [Option<i32>; 3] = Default::default();
    let mut colors: [Option<&'static str>; 3] = Default::default();
    let mut titles: [Option<String>; 2] = Default::default();
    let mut descriptions: [Option<String>; 4] = Default::default();
    // Zones de visage : celles du paquet intégré, sinon celles du sidecar (pas de mélange des deux).
    let read_faces = crate::faces::reading_enabled();
    let mut face_regions: Vec<crate::faces::FaceRegion> = Vec::new();
    // Note, couleur, titre et description : chaque source manquante du paquet intégré est cherchée dans le sidecar.
    let mut read_sources = |xml: &str| {
        for (slot, value) in ratings.iter_mut().zip(xmp_ratings(xml)) {
            if slot.is_none() { *slot = value; }
        }
        for (slot, value) in colors.iter_mut().zip(xmp_colors(xml)) {
            if slot.is_none() { *slot = value; }
        }
        for (slot, name) in titles.iter_mut().zip(XMP_TITLE_PROPERTIES) {
            if slot.is_none() { *slot = xmp_text(xml, name); }
        }
        for (slot, name) in descriptions.iter_mut().zip(XMP_DESCRIPTION_PROPERTIES) {
            if slot.is_none() { *slot = xmp_text(xml, name); }
        }
    };
    // The image itself is the source of truth when it contains an XMP packet.
    if let Some(embedded) = read_embedded_xmp(path) {
        keywords = parse_xmp_subjects(&embedded);
        hierarchical = parse_hierarchical_keywords(&embedded);
        if read_faces { face_regions = crate::faces::parse_regions(&embedded); }
        read_sources(&embedded);
    }
    for source in sources {
        if let Ok(text) = fs::read_to_string(source) {
            if keywords.is_empty() { keywords = parse_xmp_subjects(&text); }
            if hierarchical.is_empty() { hierarchical = parse_hierarchical_keywords(&text); }
            if read_faces && face_regions.is_empty() { face_regions = crate::faces::parse_regions(&text); }
            read_sources(&text);
        }
    }
    ParsedXmp {
        ratings,
        colors,
        keywords: keywords.join(", "),
        keyword_paths: hierarchical,
        titles,
        descriptions,
        face_regions: read_faces.then_some(face_regions),
    }
}

// ---------------------------------------------------------------------------
// Titre et description : plusieurs sources par fichier, la première non vide dans l'ordre de priorité réglé (Paramètres, onglet Métadonnées)
// l'emporte. Toutes sont écrites (voir write_metadata et exiftool.rs).
// ---------------------------------------------------------------------------

/// Sources du titre (identifiants côté interface), ordre par défaut : XMP dc:title, XMP acdsee:caption, IPTC ObjectName, EXIF XPTitle.
pub const TITLE_SOURCE_IDS: [&str; 4] = ["xmp-dc", "xmp-acdsee", "iptc", "exif-xp"];
/// Sources de la description, ordre par défaut : XMP dc:description, exif:UserComment, tiff:ImageDescription, acdsee:notes, commentaire JPEG,
/// EXIF ImageDescription, EXIF UserComment, EXIF XPComment, IPTC Caption.
pub const DESCRIPTION_SOURCE_IDS: [&str; 9] = ["xmp-dc", "xmp-exif", "xmp-tiff", "xmp-acdsee", "jpeg-comment", "exif-image", "exif-user-comment", "exif-xp", "iptc"];
const XMP_TITLE_PROPERTIES: [&str; 2] = ["dc:title", "acdsee:caption"];
const XMP_DESCRIPTION_PROPERTIES: [&str; 4] = ["dc:description", "exif:UserComment", "tiff:ImageDescription", "acdsee:notes"];
/// Sources de la note, ordre par défaut : XMP xmp:Rating, MicrosoftPhoto:Rating, acdsee:rating, EXIF Rating, EXIF RatingPercent.
pub const RATING_SOURCE_IDS: [&str; 5] = ["xmp", "microsoft", "acdsee", "exif", "exif-percent"];
/// Sources de la couleur, ordre par défaut : XMP xmp:Label, digiKam:ColorLabel, photoshop:Urgency.
pub const COLOR_SOURCE_IDS: [&str; 3] = ["xmp-label", "digikam", "urgency"];
static RATING_PRIORITY: std::sync::RwLock<[usize; 5]> = std::sync::RwLock::new([0, 1, 2, 3, 4]);
static COLOR_PRIORITY: std::sync::RwLock<[usize; 3]> = std::sync::RwLock::new([0, 1, 2]);
static TITLE_PRIORITY: std::sync::RwLock<[usize; 4]> = std::sync::RwLock::new([0, 1, 2, 3]);
static DESCRIPTION_PRIORITY: std::sync::RwLock<[usize; 9]> = std::sync::RwLock::new([0, 1, 2, 3, 4, 5, 6, 7, 8]);

/// Valeur de chaque source, dans l'ordre de TITLE_SOURCE_IDS et DESCRIPTION_SOURCE_IDS (None : absente ou vide).
#[derive(Default, Clone, Debug)]
pub struct TextSources {
    pub title: [Option<String>; 4],
    pub description: [Option<String>; 9],
}

/// Indices de `order` dans `ids` : chaque identifiant doit y figurer une fois.
pub(crate) fn order_indices<const N: usize>(ids: &[&str; N], order: &[String]) -> Result<[usize; N], String> {
    if order.len() != N { return Err("invalid_order".to_string()); }
    let mut indices = [0usize; N];
    for (rank, id) in order.iter().enumerate() {
        let Some(index) = ids.iter().position(|known| *known == id.as_str()) else { return Err("invalid_order".to_string()); };
        if indices[..rank].contains(&index) { return Err("invalid_order".to_string()); }
        indices[rank] = index;
    }
    Ok(indices)
}

/// Règle l'ordre de priorité à la lecture d'un type de métadonnée (`kind` : « keywords », « title », « description », « rating », « color »
/// ou « faces ») : `order` liste une fois chacun des identifiants de ses sources (HIERARCHY_IDS, TITLE_SOURCE_IDS, DESCRIPTION_SOURCE_IDS,
/// RATING_SOURCE_IDS, COLOR_SOURCE_IDS, faces::REGION_SOURCE_IDS), du plus au moins prioritaire. Il s'applique aux prochaines lectures de fichiers (scan, relecture, synchronisation).
pub fn set_read_priority(kind: &str, order: &[String]) -> Result<(), String> {
    fn store<T>(lock: &std::sync::RwLock<T>, value: T) {
        *lock.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
    }
    match kind {
        "keywords" => store(&HIERARCHY_PRIORITY, order_indices(&HIERARCHY_IDS, order)?),
        "title" => store(&TITLE_PRIORITY, order_indices(&TITLE_SOURCE_IDS, order)?),
        "description" => store(&DESCRIPTION_PRIORITY, order_indices(&DESCRIPTION_SOURCE_IDS, order)?),
        "rating" => store(&RATING_PRIORITY, order_indices(&RATING_SOURCE_IDS, order)?),
        "color" => store(&COLOR_PRIORITY, order_indices(&COLOR_SOURCE_IDS, order)?),
        "faces" => store(&crate::faces::REGION_PRIORITY, order_indices(&crate::faces::REGION_SOURCE_IDS, order)?),
        _ => return Err("invalid_kind".to_string()),
    }
    Ok(())
}

/// Première source non vide dans l'ordre de priorité.
fn resolve_text<const N: usize>(values: &[Option<String>; N], priority: &[usize; N]) -> String {
    priority.iter().find_map(|index| values[*index].clone()).unwrap_or_default()
}

/// Texte nettoyé : fins de ligne unifiées (`\n`), caractères nuls et espaces de début et de fin retirés ; None s'il ne reste rien
/// (Capture One écrit par exemple une description faite d'espaces).
pub(crate) fn clean_text(text: &str) -> Option<String> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n").replace('\0', "");
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Titre : une seule ligne.
pub(crate) fn clean_title(text: &str) -> Option<String> {
    clean_text(&text.replace(['\r', '\n'], " "))
}

/// Descriptions par défaut d'appareils photo, sans intérêt : ignorées dans EXIF ImageDescription.
const CAMERA_DEFAULT_DESCRIPTIONS: [&str; 6] = ["OLYMPUS DIGITAL CAMERA", "SONY DSC", "DIGITAL CAMERA", "KONICA MINOLTA DIGITAL CAMERA", "MINOLTA DIGITAL CAMERA", "SAMSUNG DIGITAL CAMERA"];

pub(crate) fn clean_exif_description(text: &str) -> Option<String> {
    clean_text(text).filter(|value| !CAMERA_DEFAULT_DESCRIPTIONS.iter().any(|junk| value.eq_ignore_ascii_case(junk)))
}

/// Propriété texte d'un paquet XMP (`qualified_name`, ex. « dc:title ») : attribut, élément simple, ou liste de langues (`rdf:Alt`, valeur
/// `x-default` ou à défaut la première). None si absente ou vide.
fn xmp_text(xml: &str, qualified_name: &str) -> Option<String> {
    let opening = format!("<{qualified_name}");
    let mut from = 0;
    while let Some(relative) = xml[from..].find(&opening) {
        let start = from + relative;
        let name_end = start + opening.len();
        from = name_end;
        if !xml.as_bytes().get(name_end).is_some_and(|byte| *byte == b'>' || *byte == b'/' || byte.is_ascii_whitespace()) { continue; }
        let tag_end = xml_tag_end(xml, start)?;
        if xml.as_bytes()[tag_end - 1] == b'/' { return None; }
        let closing = format!("</{qualified_name}>");
        let close = tag_end + 1 + xml[tag_end + 1..].find(&closing)?;
        let body = &xml[tag_end + 1..close];
        if !body.contains("<rdf:li") { return clean_text(&decode_xml_entities(body)); }
        // Liste de langues : x-default, sinon la première entrée.
        let mut first: Option<String> = None;
        let mut rest = body;
        while let Some(li) = rest.find("<rdf:li") {
            let Some(li_tag_end) = rest[li..].find('>').map(|end| li + end) else { break; };
            let tag = &rest[li..li_tag_end];
            if tag.ends_with('/') { rest = &rest[li_tag_end + 1..]; continue; }
            let Some(item_end) = rest[li_tag_end + 1..].find("</rdf:li>").map(|end| li_tag_end + 1 + end) else { break; };
            let value = decode_xml_entities(&rest[li_tag_end + 1..item_end]);
            if tag.contains("x-default") { return clean_text(&value); }
            if first.is_none() { first = Some(value); }
            rest = &rest[item_end + "</rdf:li>".len()..];
        }
        return first.and_then(|value| clean_text(&value));
    }
    // Forme attribut : qualified_name="valeur" sur rdf:Description.
    let attribute = format!(" {qualified_name}=");
    let start = xml.find(&attribute)? + attribute.len();
    let quote = xml[start..].chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let body = &xml[start + 1..];
    let end = body.find(quote)?;
    clean_text(&decode_xml_entities(&body[..end]))
}

/// Champ EXIF « XP » de Windows (XPTitle, XPComment, XPKeywords) : UTF-16 little-endian terminé par un zéro, en type Byte ou Undefined.
fn exif_xp_text(field: &exif::Field) -> Option<String> {
    let bytes = match &field.value {
        Value::Byte(bytes) => bytes,
        Value::Undefined(bytes, _) => bytes,
        _ => return None,
    };
    let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).take_while(|unit| *unit != 0).collect();
    Some(String::from_utf16_lossy(&units))
}

/// EXIF UserComment : 8 octets de jeu de caractères (« ASCII », « UNICODE » = UTF-16 dans l'ordre d'octets du fichier, zéros = non précisé)
/// puis le texte.
fn exif_user_comment(field: &exif::Field, little_endian: bool) -> Option<String> {
    let Value::Undefined(bytes, _) = &field.value else { return None; };
    if bytes.len() < 8 { return None; }
    let (code, text) = bytes.split_at(8);
    if code == b"UNICODE\0" {
        let units: Vec<u16> = text.chunks_exact(2)
            .map(|pair| if little_endian { u16::from_le_bytes([pair[0], pair[1]]) } else { u16::from_be_bytes([pair[0], pair[1]]) })
            .collect();
        return clean_text(&String::from_utf16_lossy(&units));
    }
    if code.starts_with(b"JIS") { return None; }
    clean_text(&text_from_bytes(text))
}

/// Couleur (clé stockée en base) -> valeur écrite dans xmp:Label.
const COLOR_LABELS: [(&str, &str); 9] = [
    ("red", "Red"), ("orange", "Orange"), ("yellow", "Yellow"), ("green", "Green"), ("blue", "Blue"),
    ("magenta", "Magenta"), ("grey", "Grey"), ("black", "Black"), ("white", "White"),
];

/// Convertit une valeur xmp:Label en clé de couleur (« none » si vide ou non reconnue, ex. « Approved »).
/// Lecture tolérante : insensible à la casse, « Gray » = « Grey », « Purple » (Lightroom) = « magenta ».
pub fn normalize_color_flag(label: &str) -> &'static str {
    match xml_unescape(label).trim().to_ascii_lowercase().as_str() {
        "red" => "red",
        "orange" => "orange",
        "yellow" => "yellow",
        "green" => "green",
        "blue" => "blue",
        "magenta" | "purple" => "magenta",
        "grey" | "gray" => "grey",
        "black" => "black",
        "white" => "white",
        _ => "none",
    }
}

/// Valeur à écrire dans xmp:Label pour une couleur : `Ok(None)` pour « none » (le label est retiré).
pub fn label_for_color_flag(flag: &str) -> Result<Option<&'static str>, String> {
    let normalized = normalize_color_flag(flag);
    if normalized == "none" {
        return if matches!(flag.trim().to_ascii_lowercase().as_str(), "" | "none") { Ok(None) } else { Err(format!("Couleur inconnue : {flag}")) };
    }
    Ok(COLOR_LABELS.iter().find(|(key, _)| *key == normalized).map(|(_, label)| *label))
}

/// Note en étoiles d'un pourcentage Microsoft (1, 25, 50, 75, 99 pour 1 à 5 étoiles ; valeurs intermédiaires arrondies à l'étoile la plus proche).
fn stars_from_percent(percent: i32) -> i32 {
    match percent {
        i32::MIN..=0 => 0,
        1..=12 => 1,
        13..=37 => 2,
        38..=62 => 3,
        63..=87 => 4,
        _ => 5,
    }
}

/// Couleur d'un numéro digiKam ColorLabel ou Photoshop Urgency (même table qu'à l'écriture, voir color_to_urgency_and_digikam) ; 0 = aucune.
fn color_from_number(number: i32) -> Option<&'static str> {
    match number {
        1 => Some("red"),
        2 => Some("orange"),
        3 => Some("yellow"),
        4 => Some("green"),
        5 => Some("blue"),
        6 => Some("magenta"),
        7 => Some("grey"),
        8 => Some("black"),
        9 => Some("white"),
        _ => None,
    }
}

/// Notes XMP d'un paquet, dans l'ordre de RATING_SOURCE_IDS : xmp:Rating (préfixe ancien « xap » accepté), MicrosoftPhoto:Rating (pourcentage),
/// acdsee:rating. Une note « rejetée » (-1) compte comme 0.
fn xmp_ratings(xml: &str) -> [Option<i32>; 3] {
    let number = |names: &[&str]| xmp_value(xml, names).and_then(|value| value.trim().parse::<i32>().ok());
    [
        number(&["xmp:Rating", "xap:Rating"]).map(|rating| rating.clamp(0, 5)),
        number(&["MicrosoftPhoto:Rating"]).map(stars_from_percent),
        number(&["acdsee:rating"]).map(|rating| rating.clamp(0, 5)),
    ]
}

/// Couleurs XMP d'un paquet, dans l'ordre de COLOR_SOURCE_IDS : xmp:Label (nom de couleur ; un libellé qui n'est pas une couleur est ignoré),
/// digiKam:ColorLabel, photoshop:Urgency (numéros).
fn xmp_colors(xml: &str) -> [Option<&'static str>; 3] {
    let number = |names: &[&str]| xmp_value(xml, names).and_then(|value| value.trim().parse::<i32>().ok());
    [
        xmp_value(xml, &["xmp:Label", "xap:Label"]).map(|label| normalize_color_flag(&label)).filter(|color| *color != "none"),
        number(&["digiKam:ColorLabel", "digikam:ColorLabel"]).and_then(color_from_number),
        number(&["photoshop:Urgency"]).and_then(color_from_number),
    ]
}

/// Mots-clés à plat d'un paquet XMP (dc:subject).
fn parse_xmp_subjects(xml: &str) -> Vec<String> {
    let mut keywords = Vec::new();
    if let Some(start) = xml.find("<dc:subject") {
        if let Some(open_end) = xml[start..].find('>') {
            let body_start = start + open_end + 1;
            if let Some(close_rel) = xml[body_start..].find("</dc:subject>") {
                let body = &xml[body_start..body_start + close_rel];
                let mut rest = body;
                while let Some(li) = rest.find("<rdf:li") {
                    let Some(end_open) = rest[li..].find('>') else { break; };
                    let item_start = li + end_open + 1;
                    let Some(end_item) = rest[item_start..].find("</rdf:li>") else { break; };
                    let item = xml_unescape(rest[item_start..item_start + end_item].trim());
                    if !item.is_empty() && !keywords.contains(&item) { keywords.push(item); }
                    rest = &rest[item_start + end_item + 9..];
                }
            }
        }
    }
    keywords
}

/// Éléments `rdf:li` de la première propriété XMP de nom local `local_name` (ex. « TagsList »), quel que soit le préfixe de namespace utilisé
/// par le logiciel qui a écrit le fichier (digiKam, digikam…). Casse du nom ignorée. Liste vide si la propriété est absente ou vide.
fn xmp_list_items(xml: &str, local_name: &str) -> Vec<String> {
    let lower = xml.to_ascii_lowercase(); // mêmes positions que `xml` : seuls les caractères ASCII changent
    let needle = format!(":{}", local_name.to_ascii_lowercase());
    let bytes = lower.as_bytes();
    let mut from = 0;
    while let Some(relative) = lower[from..].find(&needle) {
        let colon = from + relative;
        let name_end = colon + needle.len();
        from = name_end;
        // Doit être une balise ouvrante : « <préfixe:Nom ».
        let mut prefix_start = colon;
        while prefix_start > 0 && (bytes[prefix_start - 1].is_ascii_alphanumeric() || bytes[prefix_start - 1] == b'_' || bytes[prefix_start - 1] == b'-') { prefix_start -= 1; }
        if prefix_start == colon || prefix_start == 0 || bytes[prefix_start - 1] != b'<' { continue; }
        // Le nom doit se terminer là (pas « TagsListX »).
        match bytes.get(name_end) {
            Some(b'>') | Some(b'/') => {}
            Some(next) if next.is_ascii_whitespace() => {}
            _ => continue,
        }
        let Some(open_end_relative) = lower[name_end..].find('>') else { break; };
        let open_end = name_end + open_end_relative;
        if bytes[open_end - 1] == b'/' { continue; } // propriété vide : <digiKam:TagsList/>
        let closing = format!("</{}{}", &lower[prefix_start..colon], needle);
        let Some(close_relative) = lower[open_end + 1..].find(&closing) else { continue; };
        let body = &xml[open_end + 1..open_end + 1 + close_relative];
        let mut items = Vec::new();
        let mut rest = body;
        while let Some(li) = rest.find("<rdf:li") {
            let Some(tag_end) = rest[li..].find('>') else { break; };
            let item_start = li + tag_end + 1;
            let Some(item_end) = rest[item_start..].find("</rdf:li>") else { break; };
            let item = xml_unescape(rest[item_start..item_start + item_end].trim());
            if !item.is_empty() { items.push(item); }
            rest = &rest[item_start + item_end + "</rdf:li>".len()..];
        }
        if !items.is_empty() { return items; }
    }
    Vec::new()
}

/// Chemins hiérarchiques d'une propriété XMP : chaque entrée (« A/B/C » ou « A|B|C ») devient la liste de ses niveaux.
/// Les entrées vides ou en double (casse ignorée) et les étiquettes internes de digiKam sont écartées.
fn hierarchy_paths(items: Vec<String>, separator: char) -> Vec<Vec<String>> {
    let mut paths: Vec<Vec<String>> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for item in items {
        let segments: Vec<String> = item.split(separator).map(|segment| segment.trim().to_string()).filter(|segment| !segment.is_empty()).collect();
        if segments.is_empty() { continue; }
        if segments[0].to_lowercase().starts_with("_digikam_internal_tags_") { continue; }
        let key = segments.join("\u{1}").to_lowercase();
        if seen.contains(&key) { continue; }
        seen.push(key);
        paths.push(segments);
    }
    paths
}

/// Schémas de mots-clés hiérarchiques en liste XMP : (propriété XMP, séparateur des niveaux). Dans l'ordre de HIERARCHY_IDS ;
/// le dernier identifiant (ACDSee) n'est pas une liste, voir acdsee_category_paths.
const HIERARCHY_SCHEMAS: [(&str, char); 4] = [("TagsList", '/'), ("hierarchicalSubject", '|'), ("CatalogSets", '|'), ("LastKeywordXMP", '/')];
/// Identifiants des schémas côté interface : digiKam (`digiKam:TagsList`), Lightroom (`lr:hierarchicalSubject`), Media Pro (`mediapro:CatalogSets`),
/// Microsoft Photo (`MicrosoftPhoto:LastKeywordXMP`), ACDSee (`acdsee:categories`).
const HIERARCHY_IDS: [&str; 5] = ["digikam", "lightroom", "mediapro", "microsoft", "acdsee"];
/// Ordre de priorité à la lecture : indices dans HIERARCHY_IDS, du plus au moins prioritaire. Réglable par l'utilisateur (Paramètres, onglet
/// Métadonnées) ; digiKam en premier tant que l'interface n'a rien envoyé.
static HIERARCHY_PRIORITY: std::sync::RwLock<[usize; 5]> = std::sync::RwLock::new([0, 1, 2, 3, 4]);

/// Mots-clés hiérarchiques d'un paquet XMP : le premier schéma qui contient des données, dans l'ordre de priorité réglé (par défaut digiKam,
/// puis Lightroom, Media Pro, Microsoft Photo, ACDSee), l'emporte ; les autres sont ignorés.
/// Chaque entrée est un mot-clé actif : seul son dernier niveau l'est (les ancêtres ne le sont que s'ils ont leur propre entrée).
fn parse_hierarchical_keywords(xml: &str) -> Vec<Vec<String>> {
    let priority = *HIERARCHY_PRIORITY.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    for index in priority {
        let paths = match HIERARCHY_SCHEMAS.get(index) {
            Some((local_name, separator)) => hierarchy_paths(xmp_list_items(xml, local_name), *separator),
            None => acdsee_category_paths(xml),
        };
        if !paths.is_empty() { return paths; }
    }
    Vec::new()
}

/// Décode les entités XML (`&lt;`, `&amp;`, `&#39;`…) en une seule passe : `&amp;lt;` donne `&lt;`, jamais `<`.
pub(crate) fn decode_xml_entities(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        let entity_end = rest[start..].find(';').filter(|end| *end <= 10).map(|end| start + end);
        let decoded = entity_end.and_then(|end| match &rest[start + 1..end] {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            code if code.starts_with("#x") => u32::from_str_radix(&code[2..], 16).ok().and_then(char::from_u32),
            code if code.starts_with('#') => code[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        });
        match (decoded, entity_end) {
            (Some(character), Some(end)) => { output.push(character); rest = &rest[end + 1..]; }
            _ => { output.push('&'); rest = &rest[start + 1..]; }
        }
    }
    output.push_str(rest);
    output
}

/// Catégories ACDSee : la propriété `acdsee:categories` contient, en texte, un arbre XML (échappé dans le paquet) :
/// `<Categories><Category Assigned="0">Lieux<Category Assigned="1">Paris</Category></Category></Categories>`.
/// Le nom d'une catégorie est le texte qui précède ses sous-catégories ; `Assigned="1"` marque un mot-clé actif (même modèle que l'arbre
/// de l'application : les niveaux intermédiaires ne sont actifs que s'ils sont eux-mêmes attribués). Renvoie un chemin par catégorie attribuée.
fn acdsee_category_paths(xml: &str) -> Vec<Vec<String>> {
    let Some(value) = xmp_value(xml, &["acdsee:categories"]) else { return Vec::new(); };
    let tree = decode_xml_entities(&value);
    // Pile des catégories ouvertes : (nom, attribuée, nom terminé).
    let mut stack: Vec<(String, bool, bool)> = Vec::new();
    let mut paths: Vec<Vec<String>> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut rest = tree.as_str();
    loop {
        let (text, tag_start) = match rest.find('<') {
            Some(position) => (&rest[..position], Some(position)),
            None => (rest, None),
        };
        if let Some(top) = stack.last_mut() {
            if !top.2 { top.0.push_str(text); }
        }
        let Some(tag_start) = tag_start else { break; };
        // Une balise termine le nom de la catégorie ouverte : son chemin est enregistré si elle est attribuée.
        if stack.last().is_some_and(|top| !top.2) {
            let top = stack.last_mut().expect("pile non vide");
            top.0 = decode_xml_entities(top.0.trim());
            top.2 = true;
            if top.1 && stack.iter().all(|(name, _, _)| !name.is_empty()) {
                let segments: Vec<String> = stack.iter().map(|(name, _, _)| name.clone()).collect();
                let key = segments.join("\u{1}").to_lowercase();
                if !seen.contains(&key) {
                    seen.push(key);
                    paths.push(segments);
                }
            }
        }
        let Some(tag_end) = rest[tag_start..].find('>').map(|end| tag_start + end) else { break; };
        let tag = &rest[tag_start + 1..tag_end];
        rest = &rest[tag_end + 1..];
        if let Some(closing) = tag.strip_prefix('/') {
            if closing.trim().eq_ignore_ascii_case("Category") { stack.pop(); }
            continue;
        }
        let name_end = tag.find(|c: char| c.is_whitespace() || c == '/').unwrap_or(tag.len());
        if !tag[..name_end].eq_ignore_ascii_case("Category") || tag.ends_with('/') { continue; }
        let assigned = xml_attributes(&tag[name_end..]).iter().any(|(key, value)| key.eq_ignore_ascii_case("Assigned") && value.trim() == "1");
        stack.push((String::new(), assigned, false));
    }
    paths
}

/// Valeur de `acdsee:categories` (arbre XML en texte, voir acdsee_category_paths) pour les mots-clés actifs `paths` : chemins fusionnés en un seul
/// arbre (noms comparés sans la casse, dans l'ordre d'apparition), `Assigned="1"` sur chaque mot-clé actif, `0` sur les niveaux qui ne le sont pas.
pub(crate) fn acdsee_categories_value(paths: &[Vec<String>]) -> String {
    struct Node { name: String, assigned: bool, children: Vec<usize> }
    let mut nodes: Vec<Node> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    for segments in paths {
        let mut parent: Option<usize> = None;
        for segment in segments {
            let siblings = match parent { Some(index) => &nodes[index].children, None => &roots };
            let existing = siblings.iter().copied().find(|&index| nodes[index].name.to_lowercase() == segment.to_lowercase());
            let index = existing.unwrap_or_else(|| {
                nodes.push(Node { name: segment.clone(), assigned: false, children: Vec::new() });
                let index = nodes.len() - 1;
                match parent { Some(parent) => nodes[parent].children.push(index), None => roots.push(index) }
                index
            });
            parent = Some(index);
        }
        if let Some(index) = parent { nodes[index].assigned = true; }
    }
    fn write_node(nodes: &[Node], index: usize, output: &mut String) {
        let node = &nodes[index];
        output.push_str(&format!("<Category Assigned=\"{}\">{}", u8::from(node.assigned), xml_escape_text(&node.name).replace('"', "&quot;")));
        for child in &node.children { write_node(nodes, *child, output); }
        output.push_str("</Category>");
    }
    let mut output = String::from("<Categories>");
    for root in roots { write_node(&nodes, root, &mut output); }
    output.push_str("</Categories>");
    output
}

/// Ajoute aux mots-clés à plat (`meta.keywords`) le nom des mots-clés hiérarchiques actifs, pour que le filtre et le panneau Info
/// les voient même quand le fichier n'a que le schéma hiérarchique.
fn add_hierarchical_leaves(meta: &mut ExifMetadata) {
    if meta.keyword_paths.is_empty() { return; }
    let mut words: Vec<String> = meta.keywords.split(", ").filter(|word| !word.is_empty()).map(str::to_string).collect();
    for segments in &meta.keyword_paths {
        if let Some(leaf) = segments.last() {
            if !words.contains(leaf) { words.push(leaf.clone()); }
        }
    }
    meta.keywords = words.join(", ");
}

fn xml_unescape(text: &str) -> String {
    text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&apos;", "'")
}

/// Lit les dimensions réelles dans l'en-tête du fichier (JPEG : marqueur SOF, PNG : IHDR).
/// Sert de secours quand les tags EXIF PixelXDimension/PixelYDimension sont absents.
fn read_image_dimensions(path: &Path) -> Option<(i32, i32)> {
    if crate::heif::is_heif_path(path) { return crate::heif::read_dimensions(path); }
    let mut data = Vec::new();
    fs::File::open(path).ok()?.take(4 * 1024 * 1024).read_to_end(&mut data).ok()?;
    if data.len() >= 24 && data[0..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]) as i32;
        let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]) as i32;
        return Some((width, height)).filter(|&(w, h)| w > 0 && h > 0);
    }
    if data.len() < 4 || data[0..2] != [0xff, 0xd8] { return None; }
    let mut pos = 2;
    while pos + 4 <= data.len() {
        if data[pos] != 0xff { return None; }
        while pos < data.len() && data[pos] == 0xff { pos += 1; }
        if pos >= data.len() { return None; }
        let marker = data[pos];
        pos += 1;
        if marker == 0xd9 || marker == 0xda { return None; }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) { continue; }
        if pos + 2 > data.len() { return None; }
        let length = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
        if length < 2 || pos + length > data.len() { return None; }
        let is_sof = (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
        if is_sof {
            if length < 7 { return None; }
            let height = u16::from_be_bytes([data[pos + 3], data[pos + 4]]) as i32;
            let width = u16::from_be_bytes([data[pos + 5], data[pos + 6]]) as i32;
            return Some((width, height)).filter(|&(w, h)| w > 0 && h > 0);
        }
        pos += length;
    }
    None
}

/// Date de la vidéo : celle du sidecar XMP (exif:DateTimeOriginal, xmp:CreateDate ou photoshop:DateCreated) si elle y figure,
/// sinon la date de modification du fichier (comme les logiciels photo quand un fichier n'a pas de date de prise de vue).
fn video_date_taken(path: &Path) -> String {
    let appended = std::path::PathBuf::from(format!("{}.xmp", path.display()));
    for source in [appended, path.with_extension("xmp")] {
        let Ok(text) = fs::read_to_string(source) else { continue; };
        let Some(raw) = xmp_value(&text, &["exif:DateTimeOriginal", "xmp:CreateDate", "photoshop:DateCreated"]) else { continue; };
        let value = xml_unescape(raw.trim());
        if value.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return if value.len() >= 19 && value.is_char_boundary(19) { value[..19].replace('T', " ") } else { value };
        }
    }
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .map(|time| chrono::DateTime::<chrono::Local>::from(time).format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default()
}

/// Remplit les champs XMP de `meta` (sources XMP de la note, de la couleur, du titre et de la description ; mots-clés).
fn apply_parsed_xmp(meta: &mut ExifMetadata, parsed: ParsedXmp) {
    meta.rating_sources[..3].copy_from_slice(&parsed.ratings);
    meta.color_sources = parsed.colors;
    meta.keywords = parsed.keywords;
    meta.keyword_paths = parsed.keyword_paths;
    meta.text_sources.title[..2].clone_from_slice(&parsed.titles);
    meta.text_sources.description[..4].clone_from_slice(&parsed.descriptions);
    meta.faces.regions = parsed.face_regions;
}

/// Note, couleur, titre et description retenus : la première source présente dans l'ordre de priorité réglé.
fn resolve_values(meta: &mut ExifMetadata) {
    let rating_priority = *lock_read(&RATING_PRIORITY);
    let color_priority = *lock_read(&COLOR_PRIORITY);
    let title_priority = *lock_read(&TITLE_PRIORITY);
    let description_priority = *lock_read(&DESCRIPTION_PRIORITY);
    meta.rating = rating_priority.iter().find_map(|index| meta.rating_sources[*index]).unwrap_or(0);
    meta.color_flag = color_priority.iter().find_map(|index| meta.color_sources[*index]).unwrap_or("none").to_string();
    meta.title = resolve_text(&meta.text_sources.title, &title_priority);
    meta.caption = resolve_text(&meta.text_sources.description, &description_priority);
}

fn lock_read<T>(lock: &std::sync::RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Métadonnées d'une vidéo : note, couleur et mots-clés du sidecar XMP (`video.mp4.xmp` ou `video.xmp`) et date. Le fichier vidéo lui-même
/// n'est pas lu : ni EXIF, ni IPTC, ni dimensions (l'interface apprend le ratio depuis la miniature).
fn read_video_metadata(path: &Path) -> ExifMetadata {
    let mut meta = ExifMetadata::default();
    apply_parsed_xmp(&mut meta, parse_xmp(path));
    add_hierarchical_leaves(&mut meta);
    resolve_values(&mut meta);
    meta.date_taken = video_date_taken(path);
    meta.faces.regions = None; // vidéos exclues de la gestion des visages
    meta
}

pub fn read_exif(path: &Path) -> ExifMetadata {
    if crate::video::is_video_path(path) { return read_video_metadata(path); }
    let mut meta = ExifMetadata::default();
    apply_parsed_xmp(&mut meta, parse_xmp(path));
    let mut keywords: Vec<String> = meta.keywords.split(", ").filter(|s| !s.is_empty()).map(str::to_string).collect();
    let jpeg = read_jpeg_fields(path);
    for word in jpeg.keywords { if !keywords.contains(&word) { keywords.push(word); } }
    meta.keywords = keywords.join(", ");
    meta.text_sources.title[2] = jpeg.object_name;
    meta.text_sources.description[4] = jpeg.comment;
    meta.text_sources.description[8] = jpeg.caption;
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => { resolve_values(&mut meta); return meta; }
    };

    let mut bufreader = std::io::BufReader::new(&file);
    let exifreader = Reader::new();

    let mut xp_keywords: Vec<String> = Vec::new();
    if let Ok(exif) = exifreader.read_from_container(&mut bufreader) {
        // XPKeywords (EXIF, mots-clés de l'Explorateur Windows) : texte UTF-16 terminé par un zéro, mots séparés par « ; ».
        if let Some(text) = exif.get_field(Tag(Context::Tiff, 0x9c9e), In::PRIMARY).and_then(exif_xp_text) {
            xp_keywords = text.split(';').map(|word| word.trim().to_string()).filter(|word| !word.is_empty()).collect();
        }
        // Note EXIF de Windows : Rating (étoiles) et RatingPercent.
        meta.rating_sources[3] = exif.get_field(Tag(Context::Tiff, 0x4746), In::PRIMARY).and_then(|field| field.value.get_uint(0)).map(|rating| (rating as i32).clamp(0, 5));
        meta.rating_sources[4] = exif.get_field(Tag(Context::Tiff, 0x4749), In::PRIMARY).and_then(|field| field.value.get_uint(0)).map(|percent| stars_from_percent(percent as i32));
        // Titre et description EXIF : XPTitle, ImageDescription, UserComment, XPComment.
        meta.text_sources.title[3] = exif.get_field(Tag(Context::Tiff, 0x9c9b), In::PRIMARY).and_then(exif_xp_text).and_then(|text| clean_title(&text));
        if let Some(field) = exif.get_field(Tag::ImageDescription, In::PRIMARY) {
            if let Value::Ascii(ref parts) = field.value {
                let bytes: Vec<u8> = parts.iter().flatten().copied().collect();
                meta.text_sources.description[5] = clean_exif_description(&text_from_bytes(&bytes));
            }
        }
        meta.text_sources.description[6] = exif.get_field(Tag::UserComment, In::PRIMARY).and_then(|field| exif_user_comment(field, exif.little_endian()));
        meta.text_sources.description[7] = exif.get_field(Tag(Context::Tiff, 0x9c9c), In::PRIMARY).and_then(exif_xp_text).and_then(|text| clean_text(&text));
        if let Some(field) = exif.get_field(Tag::DateTimeOriginal, In::PRIMARY) {
            meta.date_taken = field.display_value().with_unit(&exif).to_string();
        }
        if let Some(field) = exif.get_field(Tag::FNumber, In::PRIMARY) {
            let value = field.display_value().to_string();
            meta.aperture = format!("f/{}", value.trim().trim_start_matches("f/"));
        }
        if let Some(field) = exif.get_field(Tag::ExposureTime, In::PRIMARY) {
            let value = field.display_value().to_string();
            meta.shutter_speed = format!("{} s", value.trim().trim_end_matches('s').trim_end());
        }
        if let Some(field) = exif.get_field(Tag::PhotographicSensitivity, In::PRIMARY) {
            if let Value::Short(ref v) = field.value {
                if !v.is_empty() { meta.iso = v[0] as i32; }
            }
        }
        if let Some(field) = exif.get_field(Tag::FocalLength, In::PRIMARY) {
            meta.focal_length = format!("{}", field.display_value().with_unit(&exif));
        }
        // --- Récupération du Fabricant (Make) ---
        if let Some(field) = exif.get_field(Tag::Make, In::PRIMARY) {
            meta.manufacturer = field.display_value().with_unit(&exif).to_string().trim_matches('"').trim().to_string();
        }
        if let Some(field) = exif.get_field(Tag::Model, In::PRIMARY) {
            let raw_model = field.display_value().with_unit(&exif).to_string();
            // Supprime les guillemets englobants s'il y en a
            meta.camera_model = raw_model.trim_matches('"').trim().to_string();
        }
        if let Some(field) = exif.get_field(Tag::LensModel, In::PRIMARY) {
            meta.lens_model = field.display_value().with_unit(&exif).to_string().trim_matches('"').trim().to_string();
        }
        if let Some(field) = exif.get_field(Tag::PixelXDimension, In::PRIMARY) {
            if let Some(value) = field.value.get_uint(0) { meta.width = value as i32; }
        }
        if let Some(field) = exif.get_field(Tag::PixelYDimension, In::PRIMARY) {
            if let Some(value) = field.value.get_uint(0) { meta.height = value as i32; }
        }
        // Orientation EXIF : les zones de visage sont dans le repère de l'image stockée, l'interface l'applique pour les afficher.
        meta.faces.orientation = exif.get_field(Tag::Orientation, In::PRIMARY)
            .and_then(|field| field.value.get_uint(0))
            .filter(|value| (1..=8).contains(value))
            .unwrap_or(1);
    }
    // XPKeywords : ajoutés aux mots-clés à plat, sans doublon ; puis noms des mots-clés hiérarchiques actifs.
    if !xp_keywords.is_empty() {
        let mut merged: Vec<String> = meta.keywords.split(", ").filter(|word| !word.is_empty()).map(str::to_string).collect();
        for word in xp_keywords { if !merged.contains(&word) { merged.push(word); } }
        meta.keywords = merged.join(", ");
    }
    add_hierarchical_leaves(&mut meta);
    resolve_values(&mut meta);
    if crate::heif::is_heif_path(path) {
        // Dimensions affichées (rotation du conteneur appliquée) : celles de l'EXIF sont celles du capteur.
        if let Some((width, height)) = crate::heif::read_dimensions(path) {
            meta.width = width;
            meta.height = height;
        }
        // Le décodeur HEIC applique déjà la rotation du conteneur : l'orientation EXIF ne doit pas l'être une seconde fois (voir heif.rs).
        meta.faces.orientation = 1;
    }
    if meta.width <= 0 || meta.height <= 0 {
        if let Some((width, height)) = read_image_dimensions(path) {
            meta.width = width;
            meta.height = height;
        }
    }
    meta
}

fn update_xmp_rating(xml: &str, rating: i32) -> String {
    let rating = rating.clamp(0, 5);
    let mut updated = xml.to_string();
    let microsoft_rating = match rating { 0 => 0, 1 => 1, 2 => 25, 3 => 50, 4 => 75, _ => 99 };
    for (name, value) in [("xmp:Rating", rating), ("acdsee:rating", rating), ("MicrosoftPhoto:Rating", microsoft_rating)] {
        let value = value.to_string();
        let opening = format!("<{name}");
        let closing = format!("</{name}>");
        let mut search_from = 0;
        let mut found_element = false;
        while let Some(relative) = updated[search_from..].find(&opening) {
            let start = search_from + relative;
            let Some(open_end_relative) = updated[start..].find('>') else { break; };
            let content_start = start + open_end_relative + 1;
            let Some(close_relative) = updated[content_start..].find(&closing) else { break; };
            let content_end = content_start + close_relative;
            if !found_element {
                updated.replace_range(content_start..content_end, &value);
                found_element = true;
                search_from = content_start + value.len() + closing.len();
            } else {
                updated.replace_range(start..content_end + closing.len(), "");
                search_from = start;
            }
        }
        if found_element { continue; }

        let mut found_attribute = false;
        if let Some(start) = updated.find(&name) {
            let mut pos = start + name.len();
            while updated.as_bytes().get(pos).is_some_and(|b| b.is_ascii_whitespace()) { pos += 1; }
            if updated.as_bytes().get(pos) == Some(&b'=') {
                pos += 1;
                while updated.as_bytes().get(pos).is_some_and(|b| b.is_ascii_whitespace()) { pos += 1; }
                if let Some(quote @ (b'\'' | b'"')) = updated.as_bytes().get(pos).copied() {
                    let value_start = pos + 1;
                    if let Some(end_relative) = updated.as_bytes()[value_start..].iter().position(|b| *b == quote) {
                        updated.replace_range(value_start..value_start + end_relative, &value);
                        found_attribute = true;
                    }
                }
            }
        }
        if found_attribute { continue; }

        if let Some(description) = updated.find("<rdf:Description") {
            if let Some(open_end_relative) = updated[description..].find('>') {
                let mut insert_at = description + open_end_relative;
                if insert_at > description && updated.as_bytes()[insert_at - 1] == b'/' { insert_at -= 1; }
                let namespace = match name {
                    "xmp:Rating" if !updated.contains("xmlns:xmp=") => " xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"",
                    "acdsee:rating" if !updated.contains("xmlns:acdsee=") => " xmlns:acdsee=\"http://ns.acdsee.com/iptc/1.0/\"",
                    "MicrosoftPhoto:Rating" if !updated.contains("xmlns:MicrosoftPhoto=") => " xmlns:MicrosoftPhoto=\"http://ns.microsoft.com/photo/1.0/\"",
                    _ => "",
                };
                updated.insert_str(insert_at, &format!("{namespace} {name}=\"{value}\""));
            }
        }
    }
    if updated.is_empty() || !updated.contains("rdf:Description") {
        format!("<?xpacket begin=\"﻿\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:acdsee=\"http://ns.acdsee.com/iptc/1.0/\" xmlns:MicrosoftPhoto=\"http://ns.microsoft.com/photo/1.0/\" xmp:Rating=\"{rating}\" acdsee:rating=\"{rating}\" MicrosoftPhoto:Rating=\"{microsoft_rating}\"/></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>")
    } else { updated }
}

const EMPTY_XMP_PACKET: &str = "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"/></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";

/// Écrit (`Some`) ou retire (`None`) xmp:Label, que le paquet l'exprime en élément ou en attribut,
/// sans toucher au reste du paquet XMP.
fn update_xmp_label(xml: &str, label: Option<&str>) -> String {
    let mut updated = xml.to_string();
    let name = "xmp:Label";
    let opening = format!("<{name}");
    let closing = format!("</{name}>");
    let mut placed = false;

    // Forme élément : <xmp:Label>Red</xmp:Label> (ou <xmp:Label/>). Les doublons sont supprimés.
    let mut search_from = 0;
    while let Some(relative) = updated[search_from..].find(&opening) {
        let start = search_from + relative;
        let after = start + opening.len();
        let boundary_ok = updated.as_bytes().get(after).is_some_and(|b| *b == b'>' || *b == b'/' || b.is_ascii_whitespace());
        if !boundary_ok { search_from = after; continue; }
        let Some(open_end_relative) = updated[start..].find('>') else { break; };
        let open_end = start + open_end_relative;
        if updated.as_bytes()[open_end - 1] == b'/' {
            match (label, placed) {
                (Some(value), false) => {
                    let element = format!("<{name}>{value}</{name}>");
                    updated.replace_range(start..open_end + 1, &element);
                    placed = true;
                    search_from = start + element.len();
                }
                _ => { updated.replace_range(start..open_end + 1, ""); search_from = start; }
            }
            continue;
        }
        let content_start = open_end + 1;
        let Some(close_relative) = updated[content_start..].find(&closing) else { break; };
        let content_end = content_start + close_relative;
        match (label, placed) {
            (Some(value), false) => {
                updated.replace_range(content_start..content_end, value);
                placed = true;
                search_from = content_start + value.len() + closing.len();
            }
            _ => { updated.replace_range(start..content_end + closing.len(), ""); search_from = start; }
        }
    }

    // Forme attribut : xmp:Label="Red"
    let mut search_from = 0;
    while let Some(relative) = updated[search_from..].find(name) {
        let start = search_from + relative;
        let name_end = start + name.len();
        let found = {
            let bytes = updated.as_bytes();
            let mut pos = name_end;
            while bytes.get(pos).is_some_and(|b| b.is_ascii_whitespace()) { pos += 1; }
            let mut result = None;
            if start > 0 && bytes[start - 1].is_ascii_whitespace() && bytes.get(pos) == Some(&b'=') {
                pos += 1;
                while bytes.get(pos).is_some_and(|b| b.is_ascii_whitespace()) { pos += 1; }
                if let Some(quote @ (b'"' | b'\'')) = bytes.get(pos).copied() {
                    let value_start = pos + 1;
                    if let Some(end_relative) = bytes[value_start..].iter().position(|b| *b == quote) {
                        let mut attribute_start = start;
                        while attribute_start > 0 && bytes[attribute_start - 1].is_ascii_whitespace() { attribute_start -= 1; }
                        result = Some((attribute_start, value_start, value_start + end_relative));
                    }
                }
            }
            result
        };
        let Some((attribute_start, value_start, value_end)) = found else { search_from = name_end; continue; };
        match (label, placed) {
            (Some(value), false) => {
                updated.replace_range(value_start..value_end, value);
                placed = true;
                search_from = value_start + value.len();
            }
            _ => { updated.replace_range(attribute_start..value_end + 1, ""); search_from = attribute_start; }
        }
    }

    // Absent : ajout en attribut du premier rdf:Description.
    if let (Some(value), false) = (label, placed) {
        if let Some(description) = updated.find("<rdf:Description") {
            if let Some(open_end_relative) = updated[description..].find('>') {
                let mut insert_at = description + open_end_relative;
                if insert_at > description && updated.as_bytes()[insert_at - 1] == b'/' { insert_at -= 1; }
                let namespace = if updated[..insert_at].contains("xmlns:xmp=") { "" } else { " xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"" };
                updated.insert_str(insert_at, &format!("{namespace} {name}=\"{value}\""));
            }
        }
    }
    updated
}

// Conversion des flags couleur standard vers digikam et photoshop (numériques)
pub(crate) fn color_to_urgency_and_digikam(flag: &str) -> Option<i32> {
    match normalize_color_flag(flag) {
        "red" => Some(1),
        "orange" => Some(2),
        "yellow" => Some(3),
        "green" => Some(4),
        "blue" => Some(5),
        "magenta" => Some(6),
        "grey" => Some(7),
        "black" => Some(8),
        "white" => Some(9),
        _ => None,
    }
}

fn update_photoshop_urgency(xml: &str, urgency: Option<i32>) -> String {
    let mut updated = xml.to_string();
    let name = "photoshop:Urgency";
    
    // Nettoyage préalable de l'attribut s'il existe déjà
    updated = remove_xmp_attribute(&updated, name);

    if let Some(val) = urgency {
        let val_str = val.to_string();
        if let Some(description) = updated.find("<rdf:Description") {
            if let Some(open_end_relative) = updated[description..].find('>') {
                let mut insert_at = description + open_end_relative;
                if insert_at > description && updated.as_bytes()[insert_at - 1] == b'/' { insert_at -= 1; }
                let namespace = if updated[..insert_at].contains("xmlns:photoshop=") { "" } else { " xmlns:photoshop=\"http://ns.adobe.com/photoshop/1.0/\"" };
                updated.insert_str(insert_at, &format!("{namespace} {name}=\"{val_str}\""));
            }
        }
    }
    updated
}

fn update_digikam_color_label(xml: &str, label_id: Option<i32>) -> String {
    let mut updated = xml.to_string();
    let name = "digikam:ColorLabel";
    
    // Nettoyage préalable
    updated = remove_xmp_attribute(&updated, name);

    if let Some(val) = label_id {
        let val_str = val.to_string();
        if let Some(description) = updated.find("<rdf:Description") {
            if let Some(open_end_relative) = updated[description..].find('>') {
                let mut insert_at = description + open_end_relative;
                if insert_at > description && updated.as_bytes()[insert_at - 1] == b'/' { insert_at -= 1; }
                let namespace = if updated[..insert_at].contains("xmlns:digikam=") { "" } else { " xmlns:digikam=\"http://www.digikam.org/ns/1.0/\"" };
                updated.insert_str(insert_at, &format!("{namespace} {name}=\"{val_str}\""));
            }
        }
    }
    updated
}

/// Helper pour supprimer un attribut XMP existant (ex: photoshop:Urgency ou digikam:ColorLabel)
fn remove_xmp_attribute(xml: &str, name: &str) -> String {
    let mut updated = xml.to_string();
    let mut search_from = 0;
    while let Some(relative) = updated[search_from..].find(name) {
        let start = search_from + relative;
        let name_end = start + name.len();
        let bytes = updated.as_bytes();
        let mut pos = name_end;
        while bytes.get(pos).is_some_and(|b| b.is_ascii_whitespace()) { pos += 1; }
        if start > 0 && bytes[start - 1].is_ascii_whitespace() && bytes.get(pos) == Some(&b'=') {
            pos += 1;
            while bytes.get(pos).is_some_and(|b| b.is_ascii_whitespace()) { pos += 1; }
            if let Some(quote @ (b'"' | b'\'')) = bytes.get(pos).copied() {
                let value_start = pos + 1;
                if let Some(end_relative) = bytes[value_start..].iter().position(|b| *b == quote) {
                    let mut attribute_start = start;
                    while attribute_start > 0 && bytes[attribute_start - 1].is_ascii_whitespace() { attribute_start -= 1; }
                    updated.replace_range(attribute_start..value_start + end_relative + 1, "");
                    search_from = attribute_start;
                    continue;
                }
            }
        }
        search_from = name_end;
    }
    updated
}

/// Applique uniquement ce qui est demandé : `rating` (`None` = note inchangée) et `label`
/// (`None` = label inchangé, `Some(None)` = label retiré, `Some(Some(v))` = label écrit).
fn update_xmp_metadata(xml: &str, rating: Option<i32>, label: Option<Option<&str>>) -> String {
    let mut updated = xml.to_string();
    if let Some(rating) = rating { updated = update_xmp_rating(&updated, rating); }
    if let Some(label) = label {
        if !updated.contains("rdf:Description") {
            if label.is_none() { return updated; }
            updated = EMPTY_XMP_PACKET.to_string();
        }
        // label xmp standard
        updated = update_xmp_label(&updated, label);
        // Couleurs dans Photoshop Urgency et digiKam ColorLabel
        let color_str = match label {
            Some(val) => val,
            None => "",
        };
        let urgency_val = if color_str.is_empty() { None } else { color_to_urgency_and_digikam(color_str) };
        updated = update_photoshop_urgency(&updated, urgency_val);
        updated = update_digikam_color_label(&updated, urgency_val);
    }
    updated
}

/// Writes xmp:Rating and/or xmp:Label into JPEG APP1 XMP, preserving the rest of the JPEG and its metadata.
/// Only the provided values are modified (see `update_xmp_metadata`).
/// HEIC / HEIF : le paquet XMP du fichier est modifié (ou créé) dans le conteneur, voir heif.rs ; sidecar seulement si la structure du fichier ne le permet pas.
/// Other image formats continue to use a sidecar because they have different container layouts.
/// En mode ExifTool (Paramètres), l'écriture est confiée à exiftool.rs (mêmes cibles et mêmes valeurs).
pub fn write_xmp_metadata(image_path: &str, rating: Option<i32>, label: Option<Option<&str>>) -> std::io::Result<()> {
    let path = Path::new(image_path);
    if crate::exiftool::is_enabled() { return crate::exiftool::write_rating_label(path, rating, label); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if matches!(extension.as_str(), "heic" | "heif" | "hif") {
        return match crate::heif::update_xmp(path, &|xml| update_xmp_metadata(xml, rating, label))? {
            crate::heif::Outcome::Written | crate::heif::Outcome::Unchanged => Ok(()),
            crate::heif::Outcome::Unsupported(_) => write_xmp_sidecar(path, rating, label),
        };
    }
    if extension != "jpg" && extension != "jpeg" {
        return write_xmp_sidecar(path, rating, label);
    }

    let data = fs::read(path)?;
    if data.len() < 2 || data[0..2] != [0xff, 0xd8] {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Le fichier n'est pas un JPEG valide"));
    }
    let packet = if let Some((segment_start, segment_end, packet_start)) = find_jpeg_xmp_segment(&data) {
        let packet = std::str::from_utf8(&data[packet_start..segment_end])
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "Le paquet XMP JPEG n'est pas en UTF-8"))?;
        let updated_packet = update_xmp_metadata(packet, rating, label);
        let mut payload = Vec::with_capacity(JPEG_XMP_HEADER.len() + updated_packet.len());
        payload.extend_from_slice(JPEG_XMP_HEADER);
        payload.extend_from_slice(updated_packet.as_bytes());
        let segment_length = payload.len() + 2;
        if segment_length > u16::MAX as usize {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Le paquet XMP dépasse la taille maximale d'un segment JPEG"));
        }
        let mut replacement = vec![0xff, 0xe1];
        replacement.extend_from_slice(&(segment_length as u16).to_be_bytes());
        replacement.extend_from_slice(&payload);
        let mut output = Vec::with_capacity(data.len() - (segment_end - segment_start) + replacement.len());
        output.extend_from_slice(&data[..segment_start]);
        output.extend_from_slice(&replacement);
        output.extend_from_slice(&data[segment_end..]);
        output
    } else {
        let packet = update_xmp_metadata("", rating, label);
        if packet.is_empty() { return Ok(()); } // rien à retirer d'un fichier sans XMP
        let mut payload = Vec::with_capacity(JPEG_XMP_HEADER.len() + packet.len());
        payload.extend_from_slice(JPEG_XMP_HEADER);
        payload.extend_from_slice(packet.as_bytes());
        let segment_length = payload.len() + 2;
        if segment_length > u16::MAX as usize {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Le paquet XMP dépasse la taille maximale d'un segment JPEG"));
        }
        let mut output = Vec::with_capacity(data.len() + payload.len() + 4);
        output.extend_from_slice(&data[..2]);
        output.extend_from_slice(&[0xff, 0xe1]);
        output.extend_from_slice(&(segment_length as u16).to_be_bytes());
        output.extend_from_slice(&payload);
        output.extend_from_slice(&data[2..]);
        output
    };

    let temp_path = Path::new(&format!("{}.photoboggan-tmp", path.display())).to_path_buf();
    fs::write(&temp_path, packet)?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Écriture des mots-clés hiérarchiques : XMP (dc:subject, digiKam, Lightroom, Media Pro, Microsoft) et IPTC des JPEG.
// Ce qui est actif dans l'arbre de l'application remplace le contenu de TOUS ces formats : les entrées absentes de l'arbre sont retirées.
// XPKeywords (EXIF) n'est pas écrit : il oblige à réécrire la structure TIFF de l'EXIF (risque pour les MakerNote).
// ---------------------------------------------------------------------------

const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
const DIGIKAM_NS: &str = "http://www.digikam.org/ns/1.0/";
const LIGHTROOM_NS: &str = "http://ns.adobe.com/lightroom/1.0/";
const MEDIAPRO_NS: &str = "http://ns.iview-multimedia.com/mediapro/1.0/";
const MICROSOFT_NS: &str = "http://ns.microsoft.com/photo/1.0/";
const ACDSEE_NS: &str = "http://ns.acdsee.com/iptc/1.0/";

fn xml_escape_text(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Retire tous les éléments XMP de nom local `local_name` (casse ignorée, préfixe quelconque, ou seulement `only_prefix` s'il est donné),
/// qu'ils soient écrits `<p:Nom>…</p:Nom>` ou `<p:Nom/>`.
fn remove_xmp_list_property(xml: &str, local_name: &str, only_prefix: Option<&str>) -> String {
    let needle = format!(":{}", local_name.to_ascii_lowercase());
    let mut updated = xml.to_string();
    let mut from = 0;
    loop {
        let lower = updated.to_ascii_lowercase();
        let Some(relative) = lower[from..].find(&needle) else { break; };
        let colon = from + relative;
        let name_end = colon + needle.len();
        let bytes = lower.as_bytes();
        let mut prefix_start = colon;
        while prefix_start > 0 && (bytes[prefix_start - 1].is_ascii_alphanumeric() || bytes[prefix_start - 1] == b'_' || bytes[prefix_start - 1] == b'-') { prefix_start -= 1; }
        let is_open_tag = prefix_start < colon && prefix_start > 0 && bytes[prefix_start - 1] == b'<';
        let ends_here = bytes.get(name_end) == Some(&b'>') || bytes.get(name_end) == Some(&b'/') || bytes.get(name_end).is_some_and(|byte| byte.is_ascii_whitespace());
        let prefix_ok = only_prefix.map_or(true, |wanted| &updated[prefix_start..colon] == wanted);
        if !(is_open_tag && ends_here && prefix_ok) { from = name_end; continue; }
        let Some(open_end_relative) = lower[name_end..].find('>') else { break; };
        let open_end = name_end + open_end_relative;
        let element_end = if bytes[open_end - 1] == b'/' {
            open_end + 1
        } else {
            let closing = format!("</{}{}", &lower[prefix_start..colon], needle);
            let Some(close_relative) = lower[open_end + 1..].find(&closing) else { from = name_end; continue; };
            let close_start = open_end + 1 + close_relative;
            let Some(close_end_relative) = lower[close_start..].find('>') else { break; };
            close_start + close_end_relative + 1
        };
        updated.replace_range(prefix_start - 1..element_end, "");
        from = prefix_start - 1;
    }
    updated
}

/// Élément XMP liste : `<nom><rdf:Bag><rdf:li>…</rdf:li></rdf:Bag></nom>` (ou `rdf:Seq`).
fn xmp_list_element(qualified_name: &str, container: &str, items: &[String]) -> String {
    let mut element = format!("<{qualified_name}><rdf:{container}>");
    for item in items {
        element.push_str("<rdf:li>");
        element.push_str(&xml_escape_text(item));
        element.push_str("</rdf:li>");
    }
    element.push_str(&format!("</rdf:{container}></{qualified_name}>"));
    element
}

/// Insère `children` à la fin du premier `rdf:Description` (rouvert s'il est auto-fermant), en déclarant les namespaces manquants sur cet élément.
fn insert_description_children(xml: &str, children: &str, namespaces: &[(&str, &str)]) -> Option<String> {
    let description = xml.find("<rdf:Description")?;
    let tag_end = xml_tag_end(xml, description)?;
    let open_tag = &xml[description..=tag_end];
    let self_closing = open_tag.ends_with("/>");
    let rdf_tag = xml.find("<rdf:RDF").and_then(|start| xml_tag_end(xml, start).map(|end| &xml[start..=end])).unwrap_or("");
    let mut declarations = String::new();
    for (prefix, uri) in namespaces {
        let declaration = format!("xmlns:{prefix}=");
        if !open_tag.contains(&declaration) && !rdf_tag.contains(&declaration) {
            declarations.push_str(&format!(" xmlns:{prefix}=\"{uri}\""));
        }
    }
    let mut output = String::with_capacity(xml.len() + children.len() + declarations.len() + 32);
    if self_closing {
        output.push_str(&xml[..description]);
        output.push_str(xml[description..tag_end - 1].trim_end());
        output.push_str(&declarations);
        output.push('>');
        output.push_str(children);
        output.push_str("</rdf:Description>");
        output.push_str(&xml[tag_end + 1..]);
    } else {
        let close = tag_end + 1 + xml[tag_end + 1..].find("</rdf:Description>")?;
        output.push_str(&xml[..tag_end]);
        output.push_str(&declarations);
        output.push('>');
        output.push_str(&xml[tag_end + 1..close]);
        output.push_str(children);
        output.push_str(&xml[close..]);
    }
    Some(output)
}

/// Remplace les mots-clés d'un paquet XMP par les mots-clés actifs `paths` (un chemin hiérarchique par mot-clé actif) :
/// `dc:subject` (noms seuls), `digiKam:TagsList` (A/B/C), `lr:hierarchicalSubject` (A|B|C), `mediapro:CatalogSets` (A|B|C),
/// `MicrosoftPhoto:LastKeywordXMP` (A/B/C) et `acdsee:categories` (arbre, voir acdsee_categories_value). Le reste du paquet n'est pas touché. Sans mot-clé, ces propriétés sont retirées.
/// Renvoie le paquet inchangé, ou vide s'il n'y a ni paquet ni mot-clé à écrire.
fn update_xmp_keywords(xml: &str, paths: &[Vec<String>]) -> String {
    let mut updated = xml.to_string();
    if !updated.contains("rdf:Description") {
        if paths.is_empty() { return updated; }
        updated = EMPTY_XMP_PACKET.to_string();
    }
    updated = remove_xmp_list_property(&updated, "subject", Some("dc"));
    for local_name in ["TagsList", "hierarchicalSubject", "CatalogSets", "LastKeywordXMP"] {
        updated = remove_xmp_list_property(&updated, local_name, None);
    }
    // Catégories ACDSee : élément simple (ou attribut) dont la valeur est l'arbre en texte.
    updated = remove_xmp_list_property(&updated, "categories", Some("acdsee"));
    updated = remove_xmp_attribute(&updated, "acdsee:categories");
    if paths.is_empty() { return updated; }

    let mut flat: Vec<String> = Vec::new();
    for segments in paths {
        if let Some(leaf) = segments.last() {
            if !flat.iter().any(|word| word.to_lowercase() == leaf.to_lowercase()) { flat.push(leaf.clone()); }
        }
    }
    let joined = |separator: &str| -> Vec<String> { paths.iter().map(|segments| segments.join(separator)).collect() };
    let children = [
        xmp_list_element("dc:subject", "Bag", &flat),
        xmp_list_element("digiKam:TagsList", "Seq", &joined("/")),
        xmp_list_element("lr:hierarchicalSubject", "Bag", &joined("|")),
        xmp_list_element("mediapro:CatalogSets", "Bag", &joined("|")),
        xmp_list_element("MicrosoftPhoto:LastKeywordXMP", "Bag", &joined("/")),
        format!("<acdsee:categories>{}</acdsee:categories>", xml_escape_text(&acdsee_categories_value(paths))),
    ].concat();
    let namespaces = [("dc", DC_NS), ("digiKam", DIGIKAM_NS), ("lr", LIGHTROOM_NS), ("mediapro", MEDIAPRO_NS), ("MicrosoftPhoto", MICROSOFT_NS), ("acdsee", ACDSEE_NS)];
    insert_description_children(&updated, &children, &namespaces).unwrap_or(updated)
}

/// Modifications de métadonnées à écrire dans un fichier : un champ `None` est laissé tel quel. Titre ou description vide : retiré de toutes
/// ses sources.
#[derive(Default, Clone, Debug)]
pub struct MetadataUpdate {
    /// Mots-clés actifs, un chemin hiérarchique par mot-clé (ex. ["Lieux", "France", "Paris"]).
    pub keywords: Option<Vec<Vec<String>>>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// Zones de visage (lot 4) : remplacent les zones MWG et Microsoft du fichier ; liste vide = zones retirées.
    pub regions: Option<RegionsUpdate>,
}

/// Zone de visage à écrire : coin haut-gauche et taille normalisés, repère de l'image STOCKÉE (avant orientation EXIF), nom (None : sans nom).
#[derive(Clone, Debug)]
pub struct RegionWrite {
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Zones de visage d'un fichier et dimensions de l'image stockée (`AppliedToDimensions` de MWG ; 0 : inconnues, non écrites).
#[derive(Clone, Debug)]
pub struct RegionsUpdate {
    pub regions: Vec<RegionWrite>,
    pub width: i64,
    pub height: i64,
}

impl MetadataUpdate {
    /// Titre à écrire, nettoyé (une ligne) ; chaîne vide pour le retirer.
    pub fn clean_title(&self) -> Option<String> {
        self.title.as_deref().map(|title| clean_title(title).unwrap_or_default())
    }

    /// Description à écrire, nettoyée ; chaîne vide pour la retirer.
    pub fn clean_description(&self) -> Option<String> {
        self.description.as_deref().map(|description| clean_text(description).unwrap_or_default())
    }

    /// Vrai si l'écriture ajoute au moins une valeur (sinon elle ne fait que retirer : un sidecar absent n'est pas créé).
    pub fn adds_values(&self) -> bool {
        self.keywords.as_ref().is_some_and(|paths| !paths.is_empty())
            || self.clean_title().is_some_and(|title| !title.is_empty())
            || self.clean_description().is_some_and(|description| !description.is_empty())
            || self.regions.as_ref().is_some_and(|update| !update.regions.is_empty())
    }
}

/// Noms à plat des mots-clés (dernier niveau de chaque chemin), sans doublon (casse ignorée) : dc:subject, IPTC, XPKeywords.
pub(crate) fn keyword_leaves(paths: &[Vec<String>]) -> Vec<String> {
    let mut leaves: Vec<String> = Vec::new();
    for segments in paths {
        if let Some(leaf) = segments.last() {
            if !leaves.iter().any(|word| word.to_lowercase() == leaf.to_lowercase()) { leaves.push(leaf.clone()); }
        }
    }
    leaves
}

const EXIF_NS: &str = "http://ns.adobe.com/exif/1.0/";
const TIFF_NS: &str = "http://ns.adobe.com/tiff/1.0/";

/// Élément XMP « liste de langues » réduit à la valeur par défaut : `<nom><rdf:Alt><rdf:li xml:lang="x-default">…</rdf:li></rdf:Alt></nom>`.
fn xmp_alt_element(qualified_name: &str, text: &str) -> String {
    format!("<{qualified_name}><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></{qualified_name}>", xml_escape_text(text))
}

/// Remplace le titre (dc:title, acdsee:caption) et/ou la description (dc:description, exif:UserComment, tiff:ImageDescription, acdsee:notes)
/// d'un paquet XMP. Les autres langues éventuelles de dc:title et dc:description sont retirées avec l'ancienne valeur.
fn update_xmp_texts(xml: &str, update: &MetadataUpdate) -> String {
    let title = update.clean_title();
    let description = update.clean_description();
    if title.is_none() && description.is_none() { return xml.to_string(); }
    let mut updated = xml.to_string();
    if !updated.contains("rdf:Description") {
        let adds = title.as_deref().is_some_and(|text| !text.is_empty()) || description.as_deref().is_some_and(|text| !text.is_empty());
        if !adds { return updated; }
        updated = EMPTY_XMP_PACKET.to_string();
    }
    let mut children = String::new();
    let mut namespaces: Vec<(&str, &str)> = Vec::new();
    if let Some(title) = &title {
        for (prefix, local_name) in [("dc", "title"), ("acdsee", "caption")] {
            updated = remove_xmp_list_property(&updated, local_name, Some(prefix));
            updated = remove_xmp_attribute(&updated, &format!("{prefix}:{local_name}"));
        }
        if !title.is_empty() {
            children.push_str(&xmp_alt_element("dc:title", title));
            children.push_str(&format!("<acdsee:caption>{}</acdsee:caption>", xml_escape_text(title)));
            namespaces.extend([("dc", DC_NS), ("acdsee", ACDSEE_NS)]);
        }
    }
    if let Some(description) = &description {
        for (prefix, local_name) in [("dc", "description"), ("exif", "UserComment"), ("tiff", "ImageDescription"), ("acdsee", "notes")] {
            updated = remove_xmp_list_property(&updated, local_name, Some(prefix));
            updated = remove_xmp_attribute(&updated, &format!("{prefix}:{local_name}"));
        }
        if !description.is_empty() {
            children.push_str(&xmp_alt_element("dc:description", description));
            children.push_str(&xmp_alt_element("exif:UserComment", description));
            children.push_str(&xmp_alt_element("tiff:ImageDescription", description));
            children.push_str(&format!("<acdsee:notes>{}</acdsee:notes>", xml_escape_text(description)));
            for namespace in [("dc", DC_NS), ("exif", EXIF_NS), ("tiff", TIFF_NS), ("acdsee", ACDSEE_NS)] {
                if !namespaces.contains(&namespace) { namespaces.push(namespace); }
            }
        }
    }
    if children.is_empty() { return updated; }
    insert_description_children(&updated, &children, &namespaces).unwrap_or(updated)
}

/// Paquet XMP mis à jour pour toutes les modifications demandées (mots-clés, titre, description).
fn update_xmp_all(xml: &str, update: &MetadataUpdate) -> String {
    let with_keywords = match &update.keywords {
        Some(paths) => update_xmp_keywords(xml, paths),
        None => xml.to_string(),
    };
    let with_texts = update_xmp_texts(&with_keywords, update);
    match &update.regions {
        Some(regions) => update_xmp_regions(&with_texts, regions),
        None => with_texts,
    }
}

// ---------------------------------------------------------------------------
// Zones de visage (lot 4) : MWG Regions et Microsoft Photo RegionInfo, mêmes champs que l'écriture par ExifTool (exiftool.rs).
// ACDSee n'est pas écrit tant que le repère de ses coordonnées n'est pas confirmé (spec §6.1).
// ---------------------------------------------------------------------------

const MWG_REGIONS_NS: &str = "http://www.metadataworkinggroup.com/schemas/regions/";
const ST_AREA_NS: &str = "http://ns.adobe.com/xmp/sType/Area#";
const ST_DIM_NS: &str = "http://ns.adobe.com/xap/1.0/sType/Dimensions#";
const MP_NS: &str = "http://ns.microsoft.com/photo/1.2/";
const MP_REGION_INFO_NS: &str = "http://ns.microsoft.com/photo/1.2/t/RegionInfo#";
const MP_REGION_NS: &str = "http://ns.microsoft.com/photo/1.2/t/Region#";

/// Remplace les zones de visage du paquet XMP : les structures MWG (`<préfixe>:Regions`) et Microsoft (`<préfixe>:RegionInfo`) existantes sont
/// retirées, quel que soit leur préfixe, puis les nouvelles sont ajoutées (aucune si la liste est vide). Coordonnées à 6 décimales :
/// MWG = centre de la zone, Microsoft = coin haut-gauche.
pub(crate) fn update_xmp_regions(xml: &str, update: &RegionsUpdate) -> String {
    let mut updated = xml.to_string();
    if !updated.contains("rdf:Description") {
        if update.regions.is_empty() { return updated; }
        updated = EMPTY_XMP_PACKET.to_string();
    }
    for prefix in crate::faces::namespace_prefixes(&updated, MWG_REGIONS_NS) {
        updated = remove_xmp_list_property(&updated, "Regions", Some(&prefix));
    }
    for prefix in crate::faces::namespace_prefixes(&updated, MP_NS) {
        updated = remove_xmp_list_property(&updated, "RegionInfo", Some(&prefix));
    }
    if update.regions.is_empty() { return updated; }
    let number = |value: f64| format!("{:.6}", value.clamp(0.0, 1.0));
    let mut mwg = String::from("<mwg-rs:Regions rdf:parseType=\"Resource\">");
    if update.width > 0 && update.height > 0 {
        mwg.push_str(&format!(
            "<mwg-rs:AppliedToDimensions rdf:parseType=\"Resource\"><stDim:w>{}</stDim:w><stDim:h>{}</stDim:h><stDim:unit>pixel</stDim:unit></mwg-rs:AppliedToDimensions>",
            update.width, update.height
        ));
    }
    mwg.push_str("<mwg-rs:RegionList><rdf:Bag>");
    let mut microsoft = String::from("<MP:RegionInfo rdf:parseType=\"Resource\"><MPRI:Regions><rdf:Bag>");
    for region in &update.regions {
        mwg.push_str(&format!(
            "<rdf:li rdf:parseType=\"Resource\"><mwg-rs:Area rdf:parseType=\"Resource\"><stArea:x>{}</stArea:x><stArea:y>{}</stArea:y><stArea:w>{}</stArea:w><stArea:h>{}</stArea:h><stArea:unit>normalized</stArea:unit></mwg-rs:Area>",
            number(region.x + region.w / 2.0), number(region.y + region.h / 2.0), number(region.w), number(region.h)
        ));
        if let Some(name) = &region.name { mwg.push_str(&format!("<mwg-rs:Name>{}</mwg-rs:Name>", xml_escape_text(name))); }
        mwg.push_str("<mwg-rs:Type>Face</mwg-rs:Type></rdf:li>");
        microsoft.push_str("<rdf:li rdf:parseType=\"Resource\">");
        if let Some(name) = &region.name { microsoft.push_str(&format!("<MPReg:PersonDisplayName>{}</MPReg:PersonDisplayName>", xml_escape_text(name))); }
        microsoft.push_str(&format!(
            "<MPReg:Rectangle>{}, {}, {}, {}</MPReg:Rectangle></rdf:li>",
            number(region.x), number(region.y), number(region.w), number(region.h)
        ));
    }
    mwg.push_str("</rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions>");
    microsoft.push_str("</rdf:Bag></MPRI:Regions></MP:RegionInfo>");
    let namespaces = [
        ("mwg-rs", MWG_REGIONS_NS), ("stArea", ST_AREA_NS), ("stDim", ST_DIM_NS),
        ("MP", MP_NS), ("MPRI", MP_REGION_INFO_NS), ("MPReg", MP_REGION_NS),
    ];
    insert_description_children(&updated, &format!("{mwg}{microsoft}"), &namespaces).unwrap_or(updated)
}

/// Zones de visage d'un fichier telles qu'il les contient (paquet intégré, sinon sidecar), quel que soit le réglage de lecture des visages :
/// sert à vérifier une écriture.
pub fn read_face_regions(path: &Path) -> Vec<crate::faces::FaceRegion> {
    if let Some(embedded) = read_embedded_xmp(path) {
        let regions = crate::faces::parse_regions(&embedded);
        if !regions.is_empty() { return regions; }
    }
    let appended = std::path::PathBuf::from(format!("{}.xmp", path.display()));
    let compatible = path.with_extension("xmp");
    [appended, compatible]
        .into_iter()
        .filter_map(|sidecar| fs::read_to_string(sidecar).ok())
        .map(|text| crate::faces::parse_regions(&text))
        .find(|regions| !regions.is_empty())
        .unwrap_or_default()
}

/// Redimensionnement avec rotation des pixels (resize.rs) : les zones de visage du paquet XMP subissent la même transformation que l'image
/// (orientation EXIF `orientation`), et `AppliedToDimensions` prend la taille de sortie. Sans zone, le paquet est rendu tel quel.
pub(crate) fn rotate_xmp_regions(xml: &str, orientation: u32, width: i64, height: i64) -> String {
    let regions = crate::faces::parse_regions(xml);
    if regions.is_empty() || orientation <= 1 { return xml.to_string(); }
    let rotated = regions
        .into_iter()
        .map(|region| {
            let [x, y, w, h] = crate::face_detect::orient_rect([region.x, region.y, region.w, region.h], orientation);
            RegionWrite { name: region.name, x, y, w, h }
        })
        .collect();
    update_xmp_regions(xml, &RegionsUpdate { regions: rotated, width, height })
}

/// JPEG dont les commentaires (segments COM) sont remplacés par un seul contenant `text` (aucun si `text` est vide), placé après les segments
/// APPn de l'en-tête. Le reste du fichier est recopié tel quel.
fn jpeg_replace_comment(data: &[u8], text: &str) -> std::io::Result<Vec<u8>> {
    if data.len() < 4 || data[0..2] != [0xff, 0xd8] { return Err(invalid_data("Le fichier n'est pas un JPEG valide")); }
    // Segments de l'en-tête jusqu'au début des données d'image (SOS) : (début, fin, marqueur).
    let mut segments: Vec<(usize, usize, u8)> = Vec::new();
    let mut pos = 2;
    while pos + 4 <= data.len() && data[pos] == 0xff {
        let marker = data[pos + 1];
        if marker == 0xda || marker == 0xd9 { break; }
        let length = u16::from_be_bytes([data[pos + 2], data[pos + 3]]) as usize;
        if length < 2 || pos + 2 + length > data.len() { return Err(invalid_data("Structure JPEG illisible")); }
        segments.push((pos, pos + 2 + length, marker));
        pos += 2 + length;
    }
    let mut comment = Vec::new();
    if !text.is_empty() {
        let bytes = truncate_utf8(text, 65533).as_bytes();
        comment.extend_from_slice(&[0xff, 0xfe]);
        comment.extend_from_slice(&((bytes.len() + 2) as u16).to_be_bytes());
        comment.extend_from_slice(bytes);
    }
    let insert_after = segments.iter().rposition(|(_, _, marker)| (0xe0..=0xef).contains(marker));
    let mut output = Vec::with_capacity(data.len() + comment.len());
    output.extend_from_slice(&data[..2]);
    if insert_after.is_none() { output.extend_from_slice(&comment); }
    for (index, (start, end, marker)) in segments.iter().enumerate() {
        if *marker != 0xfe { output.extend_from_slice(&data[*start..*end]); }
        if Some(index) == insert_after { output.extend_from_slice(&comment); }
    }
    output.extend_from_slice(&data[pos..]);
    Ok(output)
}

/// Position où insérer un nouveau segment APP : après les segments APP0 (JFIF) et APP1 Exif du début du fichier.
fn jpeg_insert_position(data: &[u8]) -> usize {
    let mut pos = 2;
    while pos + 4 <= data.len() && data[pos] == 0xff {
        let marker = data[pos + 1];
        let length = u16::from_be_bytes([data[pos + 2], data[pos + 3]]) as usize;
        if length < 2 || pos + 2 + length > data.len() { break; }
        let payload = &data[pos + 4..pos + 2 + length];
        if !(marker == 0xe0 || (marker == 0xe1 && payload.starts_with(&[b'E', b'x', b'i', b'f', 0, 0]))) { break; }
        pos += 2 + length;
    }
    pos
}

fn invalid_data(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.to_string())
}

/// JPEG dont le paquet XMP (segment APP1) est remplacé par `update(paquet actuel)` ; paquet créé si absent ; octets inchangés s'il n'y a rien à modifier.
fn jpeg_replace_xmp(data: &[u8], update: &dyn Fn(&str) -> String) -> std::io::Result<Vec<u8>> {
    let build_segment = |packet: &str| -> std::io::Result<Vec<u8>> {
        let mut payload = Vec::with_capacity(JPEG_XMP_HEADER.len() + packet.len());
        payload.extend_from_slice(JPEG_XMP_HEADER);
        payload.extend_from_slice(packet.as_bytes());
        let length = payload.len() + 2;
        if length > u16::MAX as usize { return Err(invalid_data("Le paquet XMP dépasse la taille maximale d'un segment JPEG")); }
        let mut segment = vec![0xff, 0xe1];
        segment.extend_from_slice(&(length as u16).to_be_bytes());
        segment.extend_from_slice(&payload);
        Ok(segment)
    };
    if let Some((segment_start, segment_end, packet_start)) = find_jpeg_xmp_segment(data) {
        let packet = std::str::from_utf8(&data[packet_start..segment_end]).map_err(|_| invalid_data("Le paquet XMP JPEG n'est pas en UTF-8"))?;
        let updated = update(packet);
        if updated == packet { return Ok(data.to_vec()); }
        let segment = build_segment(&updated)?;
        let mut output = Vec::with_capacity(data.len() + segment.len());
        output.extend_from_slice(&data[..segment_start]);
        output.extend_from_slice(&segment);
        output.extend_from_slice(&data[segment_end..]);
        Ok(output)
    } else {
        let packet = update("");
        if packet.is_empty() { return Ok(data.to_vec()); }
        let segment = build_segment(&packet)?;
        let at = jpeg_insert_position(data);
        let mut output = Vec::with_capacity(data.len() + segment.len());
        output.extend_from_slice(&data[..at]);
        output.extend_from_slice(&segment);
        output.extend_from_slice(&data[at..]);
        Ok(output)
    }
}

// « Photoshop 3.0 » suivi d'un octet nul.
const PHOTOSHOP_HEADER: &[u8] = &[80, 104, 111, 116, 111, 115, 104, 111, 112, 32, 51, 46, 48, 0];
const IPTC_RESOURCE_ID: u16 = 0x0404;

/// Segment APP13 « Photoshop 3.0 » : (début du segment, fin, début de son contenu).
fn find_jpeg_photoshop_segment(data: &[u8]) -> Option<(usize, usize, usize)> {
    if data.len() < 4 || data[0..2] != [0xff, 0xd8] { return None; }
    let mut pos = 2;
    while pos + 4 <= data.len() {
        let marker_start = pos;
        if data[pos] != 0xff { return None; }
        while pos < data.len() && data[pos] == 0xff { pos += 1; }
        if pos >= data.len() { return None; }
        let marker = data[pos];
        pos += 1;
        if marker == 0xda || marker == 0xd9 { break; }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) { continue; }
        if pos + 2 > data.len() { return None; }
        let length = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
        if length < 2 || pos + length > data.len() { return None; }
        let segment_end = pos + length;
        if marker == 0xed && data[pos + 2..segment_end].starts_with(PHOTOSHOP_HEADER) { return Some((marker_start, segment_end, pos + 2)); }
        pos = segment_end;
    }
    None
}

struct PhotoshopResource { id: u16, name: Vec<u8>, data: Vec<u8> }

/// Ressources « 8BIM » d'un segment Photoshop (contenu après l'en-tête), plus les octets éventuels qui les suivent, conservés tels quels.
fn parse_photoshop_resources(payload: &[u8]) -> (Vec<PhotoshopResource>, Vec<u8>) {
    let mut resources = Vec::new();
    let mut p = 0;
    while p + 12 <= payload.len() && &payload[p..p + 4] == b"8BIM" {
        let id = u16::from_be_bytes([payload[p + 4], payload[p + 5]]);
        let name_length = payload[p + 6] as usize;
        let name_start = p + 7;
        let mut q = name_start + name_length;
        if (1 + name_length) % 2 != 0 { q += 1; }
        if q + 4 > payload.len() { break; }
        let size = u32::from_be_bytes([payload[q], payload[q + 1], payload[q + 2], payload[q + 3]]) as usize;
        let data_start = q + 4;
        if data_start + size > payload.len() { break; }
        resources.push(PhotoshopResource { id, name: payload[name_start..name_start + name_length].to_vec(), data: payload[data_start..data_start + size].to_vec() });
        p = data_start + size;
        if size % 2 != 0 { p += 1; }
    }
    let trailer = payload.get(p..).map(|rest| rest.to_vec()).unwrap_or_default();
    (resources, trailer)
}

struct IptcDataset { record: u8, dataset: u8, raw: Vec<u8>, value: Vec<u8> }

/// Jeux de données d'un bloc IPTC-IIM ; `None` si le bloc est mal formé (il n'est alors pas modifié).
fn parse_iptc_datasets(iptc: &[u8]) -> Option<Vec<IptcDataset>> {
    let mut datasets = Vec::new();
    let mut q = 0;
    while q < iptc.len() {
        if iptc[q..].iter().all(|byte| *byte == 0) { break; } // remplissage final
        if iptc[q] != 0x1c || q + 5 > iptc.len() { return None; }
        let record = iptc[q + 1];
        let dataset = iptc[q + 2];
        let mut value_length = u16::from_be_bytes([iptc[q + 3], iptc[q + 4]]) as usize;
        let mut header = 5;
        if value_length & 0x8000 != 0 {
            let count = value_length & 0x7fff;
            if count == 0 || count > 4 || q + 5 + count > iptc.len() { return None; }
            value_length = 0;
            for byte in &iptc[q + 5..q + 5 + count] { value_length = (value_length << 8) | *byte as usize; }
            header += count;
        }
        if q + header + value_length > iptc.len() { return None; }
        datasets.push(IptcDataset { record, dataset, raw: iptc[q..q + header + value_length].to_vec(), value: iptc[q + header..q + header + value_length].to_vec() });
        q += header + value_length;
    }
    Some(datasets)
}

pub(crate) fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes { return text; }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) { end -= 1; }
    &text[..end]
}

/// Modifications IPTC : mots-clés (2:25, plusieurs), titre ObjectName (2:05), description Caption (2:120) ; `None` = inchangé, valeur vide = retiré.
#[derive(Default)]
struct IptcChanges<'a> {
    keywords: Option<&'a [String]>,
    object_name: Option<&'a str>,
    caption: Option<&'a str>,
}

impl IptcChanges<'_> {
    /// Nouveaux jeux de données (numéro, valeur), coupés à la longueur maximale de la norme (64 octets ; 2000 pour la description).
    fn datasets(&self) -> Vec<(u8, &str)> {
        let mut values: Vec<(u8, &str)> = Vec::new();
        if let Some(name) = self.object_name.filter(|text| !text.is_empty()) { values.push((5, truncate_utf8(name, 64))); }
        for keyword in self.keywords.unwrap_or_default() { values.push((25, truncate_utf8(keyword, 64))); }
        if let Some(caption) = self.caption.filter(|text| !text.is_empty()) { values.push((120, truncate_utf8(caption, 2000))); }
        values.retain(|(_, value)| !value.is_empty());
        values
    }
}

/// Nouveau bloc IPTC : les jeux de données concernés par `changes` sont remplacés, tout le reste est recopié tel quel.
/// Des valeurs non ASCII déclarent le jeu de caractères UTF-8 (1:90) s'il n'est pas déjà déclaré. `None` : le bloc est laissé intact
/// (illisible, ou déclaré dans un autre jeu de caractères que l'UTF-8 alors que des valeurs non ASCII doivent y entrer).
fn iptc_with(existing: Option<&[u8]>, changes: &IptcChanges) -> Option<Vec<u8>> {
    let mut datasets = match existing { Some(bytes) => parse_iptc_datasets(bytes)?, None => Vec::new() };
    let replaced: Vec<u8> = [(changes.object_name.is_some(), 5u8), (changes.keywords.is_some(), 25), (changes.caption.is_some(), 120)]
        .into_iter().filter(|(changed, _)| *changed).map(|(_, number)| number).collect();
    datasets.retain(|dataset| !(dataset.record == 2 && replaced.contains(&dataset.dataset)));
    let values = changes.datasets();
    const UTF8_ESCAPE: [u8; 3] = [0x1b, 0x25, 0x47];
    if values.iter().any(|(_, value)| !value.is_ascii()) {
        match datasets.iter().find(|dataset| dataset.record == 1 && dataset.dataset == 90) {
            Some(declared) => { if declared.value != UTF8_ESCAPE { return None; } }
            None => datasets.insert(0, IptcDataset { record: 1, dataset: 90, raw: vec![0x1c, 1, 90, 0, 3, 0x1b, 0x25, 0x47], value: UTF8_ESCAPE.to_vec() }),
        }
    }
    // Chaque nouveau jeu de données est placé dans l'ordre des numéros, après ceux de même numéro déjà placés.
    for (number, value) in values {
        let bytes = value.as_bytes();
        let mut raw = vec![0x1c, 2, number];
        raw.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        raw.extend_from_slice(bytes);
        let at = datasets.iter().position(|dataset| (dataset.record, dataset.dataset) > (2, number)).unwrap_or(datasets.len());
        datasets.insert(at, IptcDataset { record: 2, dataset: number, raw, value: Vec::new() });
    }
    Some(datasets.into_iter().flat_map(|dataset| dataset.raw).collect())
}

/// JPEG dont les jeux de données IPTC concernés par `changes` sont remplacés. Les autres ressources Photoshop et jeux de données IPTC sont
/// conservés ; le segment est créé s'il n'existe pas et qu'il y a des valeurs à écrire, et retiré s'il devient vide.
fn jpeg_replace_iptc(data: &[u8], changes: &IptcChanges) -> std::io::Result<Vec<u8>> {
    let segment = find_jpeg_photoshop_segment(data);
    let (mut resources, trailer) = match segment {
        Some((_, end, payload_start)) => parse_photoshop_resources(&data[payload_start + PHOTOSHOP_HEADER.len()..end]),
        None => (Vec::new(), Vec::new()),
    };
    let existing: Option<Vec<u8>> = resources.iter().find(|resource| resource.id == IPTC_RESOURCE_ID).map(|resource| resource.data.clone());
    if existing.is_none() && changes.datasets().is_empty() { return Ok(data.to_vec()); }
    let Some(new_iptc) = iptc_with(existing.as_deref(), changes) else { return Ok(data.to_vec()); };
    if existing.as_deref() == Some(new_iptc.as_slice()) { return Ok(data.to_vec()); }

    resources.retain(|resource| resource.id != IPTC_RESOURCE_ID);
    if !new_iptc.is_empty() {
        let at = resources.iter().position(|resource| resource.id > IPTC_RESOURCE_ID).unwrap_or(resources.len());
        resources.insert(at, PhotoshopResource { id: IPTC_RESOURCE_ID, name: Vec::new(), data: new_iptc });
    }
    if resources.is_empty() && trailer.is_empty() {
        // Plus rien à garder dans le segment : il est retiré.
        return Ok(match segment {
            Some((start, end, _)) => [&data[..start], &data[end..]].concat(),
            None => data.to_vec(),
        });
    }
    let mut payload = PHOTOSHOP_HEADER.to_vec();
    for resource in &resources {
        payload.extend_from_slice(b"8BIM");
        payload.extend_from_slice(&resource.id.to_be_bytes());
        payload.push(resource.name.len() as u8);
        payload.extend_from_slice(&resource.name);
        if (1 + resource.name.len()) % 2 != 0 { payload.push(0); }
        payload.extend_from_slice(&(resource.data.len() as u32).to_be_bytes());
        payload.extend_from_slice(&resource.data);
        if resource.data.len() % 2 != 0 { payload.push(0); }
    }
    payload.extend_from_slice(&trailer);
    let length = payload.len() + 2;
    if length > u16::MAX as usize { return Err(invalid_data("Le bloc IPTC dépasse la taille maximale d'un segment JPEG")); }
    let mut new_segment = vec![0xff, 0xed];
    new_segment.extend_from_slice(&(length as u16).to_be_bytes());
    new_segment.extend_from_slice(&payload);
    Ok(match segment {
        Some((start, end, _)) => [&data[..start], new_segment.as_slice(), &data[end..]].concat(),
        None => {
            let at = jpeg_insert_position(data);
            [&data[..at], new_segment.as_slice(), &data[at..]].concat()
        }
    })
}

fn write_file_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp_path = std::path::PathBuf::from(format!("{}.photoboggan-tmp", path.display()));
    fs::write(&temp_path, bytes)?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

/// JPEG : XMP, IPTC et commentaire réécrits en une seule fois (écriture atomique), le reste du fichier (pixels, EXIF…) est recopié tel quel.
fn write_jpeg_metadata(path: &Path, update: &MetadataUpdate) -> std::io::Result<()> {
    let data = fs::read(path)?;
    if data.len() < 2 || data[0..2] != [0xff, 0xd8] { return Err(invalid_data("Le fichier n'est pas un JPEG valide")); }
    let mut output = jpeg_replace_xmp(&data, &|xml| update_xmp_all(xml, update))?;
    let leaves = update.keywords.as_deref().map(keyword_leaves);
    let title = update.clean_title();
    let description = update.clean_description();
    let changes = IptcChanges { keywords: leaves.as_deref(), object_name: title.as_deref(), caption: description.as_deref() };
    output = jpeg_replace_iptc(&output, &changes)?;
    if let Some(description) = &description { output = jpeg_replace_comment(&output, description)?; }
    if output == data { return Ok(()); }
    write_file_atomically(path, &output)
}

/// Sidecar XMP d'une image : `photo.ext.xmp` s'il existe, sinon `photo.xmp` (nom compatible digiKam) s'il existe, sinon `photo.ext.xmp` à créer.
/// Renvoie aussi s'il existe déjà.
pub(crate) fn sidecar_target(image_path: &Path) -> (std::path::PathBuf, bool) {
    let appended = std::path::PathBuf::from(format!("{}.xmp", image_path.display()));
    if appended.exists() { return (appended, true); }
    let compatible = image_path.file_stem().and_then(|stem| image_path.parent().map(|parent| parent.join(stem).with_extension("xmp")));
    match compatible.filter(|path| path.exists()) {
        Some(path) => (path, true),
        None => (appended, false),
    }
}

/// Sidecar XMP (`photo.ext.xmp` ou `photo.xmp` existant) dont le contenu est remplacé par `update(contenu actuel)` ; créé si nécessaire.
fn write_xmp_sidecar_with(image_path: &Path, update: &dyn Fn(&str) -> String) -> std::io::Result<()> {
    let (sidecar, _) = sidecar_target(image_path);
    let xml = match fs::read_to_string(&sidecar) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let updated = update(&xml);
    if updated.is_empty() || updated == xml { return Ok(()); }
    write_file_atomically(&sidecar, updated.as_bytes())
}

/// Écrit les modifications `update` (mots-clés, titre, description) dans le fichier, en une seule écriture :
/// JPEG : XMP, IPTC et commentaire du fichier ; HEIC / HEIF : XMP du conteneur (sidecar si la structure ne le permet pas) ; autres formats et
/// vidéos : sidecar XMP. L'EXIF n'est jamais modifié par ce chemin interne.
/// En mode ExifTool (Paramètres), l'écriture est confiée à exiftool.rs (mêmes cibles, plus l'EXIF des JPEG : XPKeywords, XPTitle,
/// ImageDescription, UserComment, XPComment).
pub fn write_metadata(image_path: &str, update: &MetadataUpdate) -> std::io::Result<()> {
    let path = Path::new(image_path);
    if crate::exiftool::is_enabled() { return crate::exiftool::write_metadata(path, update); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    let xmp_update = |xml: &str| update_xmp_all(xml, update);
    if matches!(extension.as_str(), "heic" | "heif" | "hif") {
        return match crate::heif::update_xmp(path, &xmp_update)? {
            crate::heif::Outcome::Written | crate::heif::Outcome::Unchanged => Ok(()),
            crate::heif::Outcome::Unsupported(_) => write_xmp_sidecar_with(path, &xmp_update),
        };
    }
    if extension != "jpg" && extension != "jpeg" { return write_xmp_sidecar_with(path, &xmp_update); }
    write_jpeg_metadata(path, update)
}

/// Vérification après écriture du titre et de la description : chaque source écrite doit contenir la valeur demandée (coupée à la longueur
/// maximale du champ). None si tout est conforme, sinon la description de l'écart.
pub fn text_mismatch(path: &Path, update: &MetadataUpdate, meta: &ExifMetadata) -> Option<String> {
    let jpeg = matches!(path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("jpg" | "jpeg"));
    let with_exif = jpeg && crate::exiftool::is_enabled();
    if let Some(title) = update.clean_title() {
        let mut sources = vec![0, 1];
        if jpeg { sources.push(2); }
        if with_exif { sources.push(3); }
        for index in sources {
            let expected = if index == 2 { clean_title(truncate_utf8(&title, 64)) } else { clean_title(&title) };
            if meta.text_sources.title[index] != expected { return Some(format!("Titre relu différent ({})", TITLE_SOURCE_IDS[index])); }
        }
    }
    if let Some(description) = update.clean_description() {
        let mut sources = vec![0, 1, 2, 3];
        if jpeg { sources.extend([4, 8]); }
        if with_exif { sources.extend([5, 6, 7]); }
        for index in sources {
            let expected = match index {
                4 => clean_text(truncate_utf8(&description, 65533)),
                5 => clean_exif_description(&description),
                8 => clean_text(truncate_utf8(&description, 2000)),
                _ => clean_text(&description),
            };
            if meta.text_sources.description[index] != expected {
                return Some(format!("Description relue différente ({})", DESCRIPTION_SOURCE_IDS[index]));
            }
        }
    }
    None
}

fn write_xmp_sidecar(image_path: &Path, rating: Option<i32>, label: Option<Option<&str>>) -> std::io::Result<()> {
    let (sidecar, _) = sidecar_target(image_path);
    let xml = match fs::read_to_string(&sidecar) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let updated = update_xmp_metadata(&xml, rating, label);
    if updated.is_empty() { return Ok(()); } // rien à retirer d'un sidecar inexistant
    // --- Écriture atomique sécurisée ---
    let temp_path = Path::new(&format!("{}.photoboggan-tmp", sidecar.display())).to_path_buf();
    fs::write(&temp_path, updated)?;
    if let Err(error) = fs::rename(&temp_path, &sidecar) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Détail complet des métadonnées (fenêtre « Infos ») : EXIF, XMP et IPTC tels qu'ils sont dans le fichier.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct MetadataEntry {
    pub key: String,
    pub value: String,
}

#[derive(serde::Serialize, Default)]
pub struct MetadataDetails {
    pub file: Vec<MetadataEntry>,
    pub exif: Vec<MetadataEntry>,
    pub xmp: Vec<MetadataEntry>,
    pub iptc: Vec<MetadataEntry>,
}

const MAX_DETAIL_VALUE_CHARS: usize = 1000;

fn detail_entry(key: impl Into<String>, value: impl AsRef<str>) -> MetadataEntry {
    let value = value.as_ref().trim();
    let value = if value.chars().count() > MAX_DETAIL_VALUE_CHARS {
        format!("{}…", value.chars().take(MAX_DETAIL_VALUE_CHARS).collect::<String>())
    } else {
        value.to_string()
    };
    MetadataEntry { key: key.into(), value }
}

fn read_exif_entries(path: &Path) -> Vec<MetadataEntry> {
    let Ok(file) = fs::File::open(path) else { return Vec::new(); };
    let mut reader = std::io::BufReader::new(&file);
    let Ok(exif) = Reader::new().read_from_container(&mut reader) else { return Vec::new(); };
    let mut entries = Vec::new();
    for field in exif.fields() {
        // Miniature intégrée (IFD 1) et MakerNote (binaire propriétaire) écartés.
        if field.ifd_num != In::PRIMARY || field.tag == Tag::MakerNote { continue; }
        let value = field.display_value().with_unit(&exif).to_string();
        entries.push(detail_entry(field.tag.to_string(), value.trim_matches('"')));
    }
    entries
}

/// Paquet XMP du fichier : celui intégré au JPEG, sinon le sidecar (`photo.jpg.xmp` ou `photo.xmp`).
fn read_xmp_packet(path: &Path) -> Option<String> {
    if let Some(embedded) = read_embedded_xmp(path) { return Some(embedded); }
    let appended = std::path::PathBuf::from(format!("{}.xmp", path.display()));
    let compatible = path.with_extension("xmp");
    [appended, compatible].into_iter().find_map(|sidecar| fs::read_to_string(sidecar).ok())
}

/// Fin (position du `>`) de la balise XML qui commence en `start`, en ignorant les `>` des valeurs entre guillemets.
pub(crate) fn xml_tag_end(xml: &str, start: usize) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (offset, byte) in xml.as_bytes()[start..].iter().enumerate() {
        match (quote, *byte) {
            (Some(open), current) if current == open => quote = None,
            (None, b'"') | (None, b'\'') => quote = Some(*byte),
            (None, b'>') => return Some(start + offset),
            _ => {}
        }
    }
    None
}

fn xml_attributes(text: &str) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut rest = text;
    while let Some(equal) = rest.find('=') {
        let key = rest[..equal].trim().to_string();
        let after = rest[equal + 1..].trim_start();
        let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break; };
        let body = &after[1..];
        let Some(end) = body.find(quote) else { break; };
        if !key.is_empty() { result.push((key, body[..end].to_string())); }
        rest = &body[end + 1..];
    }
    result
}

/// Liste à plat les propriétés d'un paquet XMP : attributs de `rdf:Description` et éléments simples ;
/// les listes (`rdf:Bag`, `rdf:Seq`, `rdf:Alt`) sont jointes par des virgules et les structures imbriquées ignorées.
fn list_xmp_properties(xml: &str) -> Vec<MetadataEntry> {
    let mut entries = Vec::new();
    let mut pos = 0;
    let mut property: Option<String> = None;
    let mut items: Vec<String> = Vec::new();
    let mut text = String::new();
    while pos < xml.len() {
        let Some(relative) = xml[pos..].find('<') else { break; };
        text.push_str(&xml[pos..pos + relative]);
        let tag_start = pos + relative;
        if xml[tag_start..].starts_with("<!--") {
            pos = xml[tag_start..].find("-->").map_or(xml.len(), |end| tag_start + end + 3);
            continue;
        }
        let Some(tag_end) = xml_tag_end(xml, tag_start) else { break; };
        let inner = &xml[tag_start + 1..tag_end];
        pos = tag_end + 1;
        if inner.starts_with('?') || inner.starts_with('!') {
            text.clear();
            continue;
        }
        if let Some(closing) = inner.strip_prefix('/') {
            let name = closing.trim();
            if name == "rdf:li" {
                let value = xml_unescape(text.trim());
                if !value.is_empty() { items.push(value); }
            } else if property.as_deref() == Some(name) {
                let values = if items.is_empty() {
                    let value = xml_unescape(text.trim());
                    if value.is_empty() { Vec::new() } else { vec![value] }
                } else {
                    std::mem::take(&mut items)
                };
                if !values.is_empty() { entries.push(detail_entry(name, values.join(", "))); }
                property = None;
                items.clear();
            }
            text.clear();
            continue;
        }
        let self_closing = inner.ends_with('/');
        let body = inner.trim_end_matches('/');
        let name_end = body.find(char::is_whitespace).unwrap_or(body.len());
        let (name, attributes) = body.split_at(name_end);
        text.clear();
        if name == "rdf:Description" {
            for (key, value) in xml_attributes(attributes) {
                if key.starts_with("xmlns") || key == "rdf:about" { continue; }
                entries.push(detail_entry(key, xml_unescape(&value)));
            }
        } else if property.is_none() && !self_closing && !name.starts_with("rdf:") && !name.starts_with("x:") {
            property = Some(name.to_string());
            items.clear();
        }
    }
    entries
}

fn iptc_dataset_name(dataset: u8) -> String {
    let name = match dataset {
        5 => "ObjectName", 15 => "Category", 20 => "SupplementalCategories", 25 => "Keywords",
        40 => "SpecialInstructions", 55 => "DateCreated", 60 => "TimeCreated", 80 => "By-line",
        85 => "By-lineTitle", 90 => "City", 92 => "Sub-location", 95 => "Province-State",
        100 => "CountryCode", 101 => "CountryName", 103 => "OriginalTransmissionReference",
        105 => "Headline", 110 => "Credit", 115 => "Source", 116 => "CopyrightNotice",
        120 => "Caption-Abstract", 122 => "Writer-Editor",
        other => return format!("2:{other:03}"),
    };
    name.to_string()
}

/// Jeux de données IPTC (enregistrement 2) d'un bloc IPTC ; les valeurs répétées d'un même champ (mots-clés) sont regroupées.
fn collect_iptc_datasets(iptc: &[u8], grouped: &mut Vec<(u8, Vec<String>)>) {
    let mut q = 0;
    while q + 5 <= iptc.len() {
        if iptc[q] != 0x1c { q += 1; continue; }
        let record = iptc[q + 1];
        let dataset = iptc[q + 2];
        let mut value_len = u16::from_be_bytes([iptc[q + 3], iptc[q + 4]]) as usize;
        let mut header = 5;
        if value_len & 0x8000 != 0 {
            let n = value_len & 0x7fff;
            if n == 0 || n > 4 || q + 5 + n > iptc.len() { break; }
            value_len = 0;
            for byte in &iptc[q + 5..q + 5 + n] { value_len = (value_len << 8) | *byte as usize; }
            header += n;
        }
        if q + header + value_len > iptc.len() { break; }
        if record == 2 {
            let value = String::from_utf8_lossy(&iptc[q + header..q + header + value_len]).trim().to_string();
            if !value.is_empty() {
                match grouped.iter_mut().find(|item| item.0 == dataset) {
                    Some(item) => { if !item.1.contains(&value) { item.1.push(value); } }
                    None => grouped.push((dataset, vec![value])),
                }
            }
        }
        q += header + value_len;
    }
}

fn read_iptc_entries(path: &Path) -> Vec<MetadataEntry> {
    let Ok(file) = fs::File::open(path) else { return Vec::new(); };
    let mut bytes = Vec::new();
    if file.take(16 * 1024 * 1024).read_to_end(&mut bytes).is_err() { return Vec::new(); }
    if bytes.len() < 4 || bytes[0..2] != [0xff, 0xd8] { return Vec::new(); }
    let mut grouped: Vec<(u8, Vec<String>)> = Vec::new();
    let mut pos = 2;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xff { break; }
        while pos < bytes.len() && bytes[pos] == 0xff { pos += 1; }
        if pos >= bytes.len() { break; }
        let marker = bytes[pos];
        pos += 1;
        if marker == 0xda || marker == 0xd9 { break; }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) { continue; }
        if pos + 2 > bytes.len() { break; }
        let segment_len = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
        if segment_len < 2 || pos + segment_len > bytes.len() { break; }
        let data = &bytes[pos + 2..pos + segment_len];
        if marker == 0xed && data.starts_with(b"Photoshop 3.0\0") {
            let mut p = 14;
            while p + 12 <= data.len() && &data[p..p + 4] == b"8BIM" {
                let resource = u16::from_be_bytes([data[p + 4], data[p + 5]]);
                p += 6;
                let name_len = data[p] as usize;
                p += 1 + name_len;
                if (1 + name_len) % 2 != 0 { p += 1; }
                if p + 4 > data.len() { break; }
                let resource_len = u32::from_be_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]) as usize;
                p += 4;
                if p + resource_len > data.len() { break; }
                if resource == 0x0404 { collect_iptc_datasets(&data[p..p + resource_len], &mut grouped); }
                p += resource_len;
                if resource_len % 2 != 0 { p += 1; }
            }
        }
        pos += segment_len;
    }
    grouped.into_iter().map(|(dataset, values)| detail_entry(iptc_dataset_name(dataset), values.join(", "))).collect()
}

/// Tout ce que la fenêtre « Infos » affiche : fichier, EXIF, XMP et IPTC. Les clés `file` sont traduites côté interface.
pub fn read_metadata_details(path: &Path) -> MetadataDetails {
    let mut details = MetadataDetails::default();
    if let Ok(metadata) = fs::metadata(path) {
        details.file.push(detail_entry("path", path.display().to_string()));
        details.file.push(detail_entry("size", format!("{:.2} MB", metadata.len() as f64 / 1024.0 / 1024.0)));
    }
    if crate::video::is_video_path(path) {
        // Vidéo : seulement le sidecar XMP (pas d'EXIF, d'IPTC ni de dimensions à lire dans le fichier).
        if let Some(packet) = read_xmp_packet(path) { details.xmp = list_xmp_properties(&packet); }
        return details;
    }
    if let Some((width, height)) = read_image_dimensions(path) {
        details.file.push(detail_entry("dimensions", format!("{width} x {height} ({:.1} MP)", width as f64 * height as f64 / 1_000_000.0)));
    }
    details.exif = read_exif_entries(path);
    if let Some(packet) = read_xmp_packet(path) { details.xmp = list_xmp_properties(&packet); }
    details.iptc = read_iptc_entries(path);
    details
}
