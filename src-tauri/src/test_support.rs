//! Aides communes aux tests (compilées uniquement par `cargo test`) : images synthétiques et recherche d'octets.
//! Aucun test ne touche à une vraie photo : tout est fabriqué en mémoire puis écrit dans un dossier temporaire.

/// JPEG synthétique (dégradé, donc des données d'image non triviales) de la taille demandée.
pub fn jpeg_bytes(width: u16, height: u16) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for y in 0..height {
        for x in 0..width {
            rgb.extend_from_slice(&[(x * 7 % 256) as u8, (y * 5 % 256) as u8, ((x + y) * 3 % 256) as u8]);
        }
    }
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, 90).encode(&rgb, width, height, jpeg_encoder::ColorType::Rgb).expect("JPEG encoding");
    out
}

/// PNG synthétique RVB 8 bits.
pub fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let rgb: Vec<u8> = (0..width * height * 3).map(|i| (i * 11 % 256) as u8).collect();
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("PNG header");
        writer.write_image_data(&rgb).expect("PNG data");
    }
    out
}

/// Données de l'image d'un JPEG : tout ce qui suit le marqueur SOS (0xFFDA). Doit rester identique octet pour octet après une écriture de métadonnées.
pub fn scan_data(jpeg: &[u8]) -> &[u8] {
    let at = jpeg.windows(2).position(|pair| pair == [0xff, 0xda]).expect("SOS marker");
    &jpeg[at..]
}

/// Vrai si `needle` figure telle quelle dans `haystack`.
pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

/// Insère un segment JPEG (marqueur + contenu) juste après SOI.
pub fn with_segment(jpeg: &[u8], marker: u8, payload: &[u8]) -> Vec<u8> {
    let length = (payload.len() + 2) as u16;
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xff, marker]);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&jpeg[2..]);
    out
}

/// Pixels décodés d'un JPEG (comparaison avant / après écriture).
pub fn decoded_pixels(jpeg: &[u8]) -> (Vec<u8>, u16, u16) {
    let mut decoder = jpeg_decoder::Decoder::new(jpeg);
    let pixels = decoder.decode().expect("JPEG decoding");
    let info = decoder.info().expect("JPEG info");
    (pixels, info.width, info.height)
}

/// Chemins `name` -> liste de chemins hiérarchiques (aide à la lecture des tests de mots-clés).
pub fn paths(list: &[&[&str]]) -> Vec<Vec<String>> {
    list.iter().map(|path| path.iter().map(|s| s.to_string()).collect()).collect()
}

/// Catalogue SQLite temporaire (même schéma et mêmes réglages que l'application). Le dossier est supprimé avec la valeur renvoyée.
pub fn temp_catalog() -> (tempfile::TempDir, crate::db::DbPool) {
    let dir = tempfile::tempdir().expect("temp dir");
    let pool = crate::db::init_db(&dir.path().join("catalog.db").to_string_lossy());
    (dir, pool)
}

/// Ligne minimale du catalogue (les autres colonnes gardent leur valeur par défaut ou NULL, comme dans un ancien catalogue).
pub fn insert_photo(conn: &rusqlite::Connection, path: &str) -> i64 {
    let filename = path.rsplit(['/', '\\']).next().unwrap_or(path);
    conn.execute("INSERT INTO photos (path, filename) VALUES (?1, ?2)", rusqlite::params![path, filename]).expect("insert photo");
    conn.last_insert_rowid()
}

/// Synthetic picture of soft blobs whose layout depends on `seed` (same relative layout at any size, so a resized copy is a faithful smaller version).
pub fn blobs_rgb(width: usize, height: usize, seed: u64) -> Vec<u8> {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    let mut next = move || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (state >> 33) as f32 / 2147483648.0
    };
    // (centre x, centre y, radius, red, green, blue) as fractions of the picture.
    let blobs: Vec<[f32; 6]> = (0..10).map(|_| [next(), next(), 0.08 + 0.2 * next(), next(), next(), next()]).collect();
    let mut rgb = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            let (fx, fy) = (x as f32 / width as f32, y as f32 / height as f32);
            let mut channels = [40f32; 3];
            for blob in &blobs {
                let weight = (-((fx - blob[0]).powi(2) + (fy - blob[1]).powi(2)) / (2.0 * blob[2] * blob[2])).exp();
                for (channel, value) in channels.iter_mut().zip(&blob[3..]) {
                    *channel += 200.0 * weight * value;
                }
            }
            rgb.extend(channels.iter().map(|value| value.clamp(0.0, 255.0) as u8));
        }
    }
    rgb
}

/// JPEG of an RGB picture at the given quality.
pub fn jpeg_from_rgb(rgb: &[u8], width: usize, height: usize, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality).encode(rgb, width as u16, height as u16, jpeg_encoder::ColorType::Rgb).expect("JPEG encoding");
    out
}

/// Picture turned a quarter turn clockwise (the result is `height` wide and `width` high).
pub fn rotate_quarter(rgb: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = vec![0u8; rgb.len()];
    for y in 0..height {
        for x in 0..width {
            let target = (x * height + (height - 1 - y)) * 3;
            out[target..target + 3].copy_from_slice(&rgb[(y * width + x) * 3..(y * width + x) * 3 + 3]);
        }
    }
    out
}

/// Picture mirrored left to right.
pub fn mirror(rgb: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = vec![0u8; rgb.len()];
    for y in 0..height {
        for x in 0..width {
            let target = (y * width + (width - 1 - x)) * 3;
            out[target..target + 3].copy_from_slice(&rgb[(y * width + x) * 3..(y * width + x) * 3 + 3]);
        }
    }
    out
}
