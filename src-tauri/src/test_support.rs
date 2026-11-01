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
