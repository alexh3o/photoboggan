use std::fs;
use std::path::Path;
use std::io::Read;
use exif::{In, Reader, Tag, Value};

#[derive(Default)]
pub struct ExifMetadata {
    pub date_taken: String,
    pub aperture: String,
    pub shutter_speed: String,
    pub iso: i32,
    pub focal_length: String,
    pub camera_model: String,
    pub width: i32,
    pub height: i32,
    pub rating: i32,
    pub color_flag: String,
    pub keywords: String,
    pub caption: String,
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

fn read_iptc_fields(path: &Path) -> (Vec<String>, String) {
    let Ok(file) = fs::File::open(path) else { return (Vec::new(), String::new()); };
    let mut bytes = Vec::new();
    if file.take(16 * 1024 * 1024).read_to_end(&mut bytes).is_err() { return (Vec::new(), String::new()); }
    if bytes.len() < 4 || bytes[0..2] != [0xff, 0xd8] { return (Vec::new(), String::new()); }
    let mut result = Vec::new();
    let mut caption = String::new();
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
                        if record == 2 && dataset == 25 {
                            let word = String::from_utf8_lossy(&iptc[q + header..q + header + value_len]).trim().to_string();
                            if !word.is_empty() && !result.contains(&word) { result.push(word); }
                        } else if record == 2 && dataset == 120 && caption.is_empty() {
                            caption = String::from_utf8_lossy(&iptc[q + header..q + header + value_len]).trim().to_string();
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
    (result, caption)
}

fn parse_xmp(path: &Path) -> (i32, String, String) {
    let mut sources = Vec::new();
    // digiKam can use either `photo.jpg.xmp` or the compatible `photo.xmp` name.
    sources.push(std::path::PathBuf::from(format!("{}.xmp", path.display())));
    if let Some(stem) = path.file_stem() {
        if let Some(parent) = path.parent() { sources.push(parent.join(stem).with_extension("xmp")); }
    }
    let mut rating = None;
    let mut keywords = Vec::new();
    // The image itself is the source of truth when it contains an XMP packet.
    if let Some(embedded) = read_embedded_jpeg_xmp(path) {
        let (found_rating, found_keywords) = parse_xmp_text(&embedded);
        rating = found_rating;
        keywords = found_keywords;
    }
    for source in sources {
        if rating.is_some() && !keywords.is_empty() { break; }
        if let Ok(text) = fs::read_to_string(source) {
            let (found_rating, found_keywords) = parse_xmp_text(&text);
            if rating.is_none() { rating = found_rating; }
            if keywords.is_empty() { keywords = found_keywords; }
        }
    }
    (rating.unwrap_or(0).clamp(0, 5), "none".to_string(), keywords.join(", "))
}

fn parse_xmp_text(xml: &str) -> (Option<i32>, Vec<String>) {
    let rating = xmp_value(xml, &["xmp:Rating", "Rating"])
        .and_then(|v| v.parse::<i32>().ok());
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
    (rating, keywords)
}

fn xml_unescape(text: &str) -> String {
    text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&apos;", "'")
}

/// Lit les dimensions réelles dans l'en-tête du fichier (JPEG : marqueur SOF, PNG : IHDR).
/// Sert de secours quand les tags EXIF PixelXDimension/PixelYDimension sont absents.
fn read_image_dimensions(path: &Path) -> Option<(i32, i32)> {
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

pub fn read_exif(path: &Path) -> ExifMetadata {
    let mut meta = ExifMetadata::default();
    (meta.rating, meta.color_flag, meta.keywords) = parse_xmp(path);
    let mut keywords: Vec<String> = meta.keywords.split(", ").filter(|s| !s.is_empty()).map(str::to_string).collect();
    let (iptc_keywords, caption) = read_iptc_fields(path);
    for word in iptc_keywords { if !keywords.contains(&word) { keywords.push(word); } }
    meta.keywords = keywords.join(", ");
    meta.caption = caption;
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return meta,
    };
    
    let mut bufreader = std::io::BufReader::new(&file);
    let exifreader = Reader::new();
    
    if let Ok(exif) = exifreader.read_from_container(&mut bufreader) {
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
        if let Some(field) = exif.get_field(Tag::Model, In::PRIMARY) {
            meta.camera_model = field.display_value().with_unit(&exif).to_string();
        }
        if let Some(field) = exif.get_field(Tag::PixelXDimension, In::PRIMARY) {
            if let Some(value) = field.value.get_uint(0) { meta.width = value as i32; }
        }
        if let Some(field) = exif.get_field(Tag::PixelYDimension, In::PRIMARY) {
            if let Some(value) = field.value.get_uint(0) { meta.height = value as i32; }
        }
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

/// Writes xmp:Rating into JPEG APP1 XMP, preserving the rest of the JPEG and its metadata.
/// Other image formats continue to use a sidecar because they have different container layouts.
pub fn write_rating_metadata(image_path: &str, rating: i32) -> std::io::Result<()> {
    let path = Path::new(image_path);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if extension != "jpg" && extension != "jpeg" {
        return write_xmp_sidecar(path, rating);
    }

    let data = fs::read(path)?;
    if data.len() < 2 || data[0..2] != [0xff, 0xd8] {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Le fichier n'est pas un JPEG valide"));
    }
    let packet = if let Some((segment_start, segment_end, packet_start)) = find_jpeg_xmp_segment(&data) {
        let packet = std::str::from_utf8(&data[packet_start..segment_end])
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "Le paquet XMP JPEG n'est pas en UTF-8"))?;
        let updated_packet = update_xmp_rating(packet, rating);
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
        let packet = update_xmp_rating("", rating);
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

    let temp_path = Path::new(&format!("{}.photofile-tmp", path.display())).to_path_buf();
    fs::write(&temp_path, packet)?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

fn write_xmp_sidecar(image_path: &Path, rating: i32) -> std::io::Result<()> {
    let appended = std::path::PathBuf::from(format!("{}.xmp", image_path.display()));
    let compatible = image_path.file_stem().and_then(|stem| image_path.parent().map(|parent| parent.join(stem).with_extension("xmp")));
    let sidecar = if appended.exists() { appended }
        else if let Some(path) = compatible.filter(|path| path.exists()) { path }
        else { appended };
    let xml = match fs::read_to_string(&sidecar) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    fs::write(sidecar, update_xmp_rating(&xml, rating))
}
