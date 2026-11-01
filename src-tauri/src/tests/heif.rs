//! Tests de non-régression de l'écriture XMP dans les conteneurs HEIC / HEIF (heif.rs).
//! Aucun vrai HEIC : un conteneur minimal est fabriqué à la main (ftyp, meta, mdat). Son image n'est pas décodable, ce qui est voulu :
//! le garde-fou « le résultat doit rester vérifiable par le décodeur » doit alors refuser la réécriture et laisser le fichier intact.

use super::*;

/// Boîte ISO BMFF : taille sur 32 bits, type, contenu.
fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

fn infe(id: u16, kind: &[u8; 4], content_type: &str) -> Vec<u8> {
    let mut payload = vec![2, 0, 0, 0];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&[0, 0]);
    payload.extend_from_slice(kind);
    payload.push(0); // nom vide
    if kind == b"mime" {
        payload.extend_from_slice(content_type.as_bytes());
        payload.push(0);
    }
    bx(b"infe", &payload)
}

/// HEIC minimal : image 1 (« hvc1 », données factices) et, si `xmp` est fourni, item 2 (XMP) rattaché à l'image par une référence `cdsc`.
fn synthetic_heif(xmp: Option<&str>) -> Vec<u8> {
    const IMAGE: &[u8] = b"FAKE-IMAGE-DATA!";
    let ftyp = bx(b"ftyp", b"heic\0\0\0\0mif1");
    let build = |image_offset: u32, xmp_offset: u32| {
        let mut items = vec![infe(1, b"hvc1", "")];
        if xmp.is_some() { items.push(infe(2, b"mime", "application/rdf+xml")); }
        let mut iinf = vec![0, 0, 0, 0];
        iinf.extend_from_slice(&(items.len() as u16).to_be_bytes());
        for item in &items { iinf.extend_from_slice(item); }

        let mut iloc = vec![0, 0, 0, 0, 0x44, 0x00];
        iloc.extend_from_slice(&(items.len() as u16).to_be_bytes());
        for (id, offset, length) in std::iter::once((1u16, image_offset, IMAGE.len() as u32)).chain(xmp.map(|x| (2u16, xmp_offset, x.len() as u32))) {
            iloc.extend_from_slice(&id.to_be_bytes());
            iloc.extend_from_slice(&[0, 0, 0, 1]); // data_reference_index, extent_count
            iloc.extend_from_slice(&offset.to_be_bytes());
            iloc.extend_from_slice(&length.to_be_bytes());
        }

        let mut meta = vec![0, 0, 0, 0];
        meta.extend_from_slice(&bx(b"pitm", &[0, 0, 0, 0, 0, 1]));
        meta.extend_from_slice(&bx(b"iinf", &iinf));
        meta.extend_from_slice(&bx(b"iloc", &iloc));
        if xmp.is_some() {
            let mut cdsc = vec![0, 2, 0, 1, 0, 1]; // de l'item 2, vers 1 cible : l'item 1
            cdsc = bx(b"cdsc", &cdsc);
            meta.extend_from_slice(&bx(b"iref", &[&[0u8, 0, 0, 0][..], &cdsc].concat()));
        }
        bx(b"meta", &meta)
    };
    let meta_len = build(0, 0).len();
    let data_start = (ftyp.len() + meta_len + 8) as u32;
    let meta = build(data_start, data_start + IMAGE.len() as u32);
    let mut mdat = IMAGE.to_vec();
    if let Some(x) = xmp { mdat.extend_from_slice(x.as_bytes()); }
    [ftyp, meta, bx(b"mdat", &mdat)].concat()
}

const XMP: &str = "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmp:Rating=\"2\"/></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";

fn leftovers(dir: &Path) -> usize {
    fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with("-tmp")).count()
}

#[test]
fn xmp_is_read_from_a_synthetic_container() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.heic");
    fs::write(&path, synthetic_heif(Some(XMP))).unwrap();
    assert_eq!(read_xmp(&path).as_deref(), Some(XMP));
    fs::write(dir.path().join("b.heic"), synthetic_heif(None)).unwrap();
    assert_eq!(read_xmp(&dir.path().join("b.heic")), None);
}

#[test]
fn unverifiable_rewrite_is_refused_and_the_file_is_untouched() {
    let dir = tempfile::tempdir().unwrap();
    for (name, xmp) in [("avec.heic", Some(XMP)), ("sans.heic", None)] {
        let original = synthetic_heif(xmp);
        let path = dir.path().join(name);
        fs::write(&path, &original).unwrap();
        let outcome = update_xmp(&path, &|xml| if xml.is_empty() { XMP.to_string() } else { xml.replace("xmp:Rating=\"2\"", "xmp:Rating=\"5\"") }).unwrap();
        assert!(matches!(outcome, Outcome::Unsupported(_)), "{name} : {outcome:?}");
        assert_eq!(fs::read(&path).unwrap(), original, "{name} a été modifié");
    }
    assert_eq!(leftovers(dir.path()), 0);
}

#[test]
fn unchanged_packet_reports_unchanged_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let original = synthetic_heif(Some(XMP));
    let path = dir.path().join("a.heic");
    fs::write(&path, &original).unwrap();
    assert_eq!(update_xmp(&path, &|xml| xml.to_string()).unwrap(), Outcome::Unchanged);
    assert_eq!(fs::read(&path).unwrap(), original);
    // Rien à retirer d'un fichier sans XMP.
    let bare = dir.path().join("b.heic");
    fs::write(&bare, synthetic_heif(None)).unwrap();
    assert_eq!(update_xmp(&bare, &|_| String::new()).unwrap(), Outcome::Unchanged);
}

#[test]
fn garbage_and_truncated_containers_are_refused_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let full = synthetic_heif(Some(XMP));
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("vide", Vec::new()),
        ("texte", b"ceci n'est pas un HEIC".to_vec()),
        ("coupe-meta", full[..full.len() / 3].to_vec()),
        ("coupe-fin", full[..full.len() - 5].to_vec()),
        ("boite-geante", [&[0xff, 0xff, 0xff, 0xff][..], b"meta", &[0; 16]].concat()),
    ];
    for (name, bytes) in cases {
        let path = dir.path().join(format!("{name}.heic"));
        fs::write(&path, &bytes).unwrap();
        let outcome = update_xmp(&path, &|_| XMP.to_string()).unwrap();
        assert!(matches!(outcome, Outcome::Unsupported(_)), "{name} : {outcome:?}");
        assert_eq!(fs::read(&path).unwrap(), bytes, "{name} a été modifié");
        assert_eq!(read_xmp(&path), None);
    }
    assert_eq!(leftovers(dir.path()), 0);
}

#[test]
fn sequences_with_a_moov_box_are_not_parsed() {
    let mut bytes = synthetic_heif(Some(XMP));
    bytes.extend_from_slice(&bx(b"moov", b""));
    assert!(parse(&bytes).is_none());
}

#[test]
fn box_walker_rejects_overflowing_sizes() {
    let ok = bx(b"free", b"1234");
    assert_eq!(children(&ok, 0, ok.len()).unwrap().len(), 1);
    let mut too_big = ok.clone();
    too_big[..4].copy_from_slice(&100u32.to_be_bytes());
    assert!(children(&too_big, 0, too_big.len()).is_none());
    let mut too_small = ok.clone();
    too_small[..4].copy_from_slice(&4u32.to_be_bytes());
    assert!(children(&too_small, 0, too_small.len()).is_none());
}

#[test]
fn padding_keeps_the_packet_trailer_last_and_the_exact_length() {
    let padded = pad_packet(XMP, XMP.len() + 40);
    assert_eq!(padded.len(), XMP.len() + 40);
    assert!(padded.ends_with(b"<?xpacket end=\"w\"?>"));
    assert_eq!(pad_packet(XMP, 3), XMP.as_bytes(), "jamais de coupe d'un paquet trop long");
}

#[test]
fn heif_extensions_are_recognised() {
    for name in ["a.heic", "a.HEIF", "a.hif"] { assert!(is_heif_path(Path::new(name)), "{name}"); }
    assert!(!is_heif_path(Path::new("a.jpg")));
}
