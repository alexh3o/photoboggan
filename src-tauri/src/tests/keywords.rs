//! Tests de l'arbre des mots-clés et de leur association aux photos (keywords.rs) : le fichier fait foi, l'arbre ne rétrécit jamais.

use super::*;
use crate::test_support::*;

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// Mots-clés actifs d'une photo, sous forme de chemins « A > B > C ».
fn active_paths(conn: &Connection, photo_id: i64) -> Vec<String> {
    let nodes: HashMap<i64, (i64, String)> = conn
        .prepare("SELECT id, parent_id, name FROM keyword_nodes").unwrap()
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))).unwrap()
        .map(|row| row.unwrap()).collect();
    let mut result: Vec<String> = conn
        .prepare("SELECT keyword_id FROM photo_keywords WHERE photo_id = ?1").unwrap()
        .query_map(params![photo_id], |row| row.get::<_, i64>(0)).unwrap()
        .map(|id| node_path(&nodes, id.unwrap()).unwrap().join(" > ")).collect();
    result.sort();
    result
}

#[test]
fn nodes_are_unique_per_parent_ignoring_case() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let paris = ensure_node(&conn, 0, "Paris").unwrap();
    assert_eq!(ensure_node(&conn, 0, " paris ").unwrap(), paris);
    let france = ensure_node(&conn, 0, "France").unwrap();
    assert_ne!(ensure_node(&conn, france, "Paris").unwrap(), paris, "même nom sous un autre parent = autre mot-clé");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM keyword_nodes"), 3);
}

#[test]
fn only_the_leaf_is_active_and_the_file_wins() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    let other = insert_photo(&conn, "C:/P/b.jpg");

    assert!(store_photo_keywords(&conn, &[("C:/P/a.jpg".into(), paths(&[&["Lieux", "France", "Paris"]])), ("C:/P/b.jpg".into(), paths(&[&["Lieux"]]))]));
    assert_eq!(active_paths(&conn, photo), ["Lieux > France > Paris"]);
    assert_eq!(active_paths(&conn, other), ["Lieux"]);

    // Relecture du fichier : ses mots-clés remplacent ceux de la base ; l'arbre, lui, n'est jamais élagué.
    assert!(store_photo_keywords(&conn, &[("C:/P/a.jpg".into(), paths(&[&["Animaux"], &[], &["Animaux"]]))]));
    assert_eq!(active_paths(&conn, photo), ["Animaux"]);
    assert_eq!(active_paths(&conn, other), ["Lieux"], "une autre photo ne doit pas bouger");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM keyword_nodes"), 4);
}

#[test]
fn written_keyword_ids_are_those_stored_after_reading() {
    // Ce que run_write renvoie au panneau (KeywordWritten::keyword_ids) : les mots-clés actifs relus, pas ceux demandés.
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    insert_photo(&conn, "C:/P/b.jpg");
    assert!(store_photo_keywords(&conn, &[
        ("C:/P/a.jpg".into(), paths(&[&["Personnes", "Alice"], &["Lieux"]])),
        ("C:/P/b.jpg".into(), paths(&[&["Autre"]])),
    ]));
    let alice = ensure_node(&conn, ensure_node(&conn, 0, "Personnes").unwrap(), "Alice").unwrap();
    let lieux = ensure_node(&conn, 0, "Lieux").unwrap();
    let mut expected = vec![alice, lieux];
    expected.sort_unstable();
    assert_eq!(photo_keyword_ids(&conn, photo).unwrap(), expected, "seuls les derniers niveaux, et seulement ceux de cette photo");
    assert!(store_photo_keywords(&conn, &[("C:/P/a.jpg".into(), Vec::new())]));
    assert!(photo_keyword_ids(&conn, photo).unwrap().is_empty());
}

#[test]
fn unknown_photo_is_skipped_without_failing_the_batch() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    assert!(store_photo_keywords(&conn, &[("C:/P/absente.jpg".into(), paths(&[&["X"]])), ("C:/P/a.jpg".into(), paths(&[&["Y"]]))]));
    assert_eq!(active_paths(&conn, photo), ["Y"]);
    assert!(store_photo_keywords(&conn, &[]));
}

#[test]
fn database_failure_is_reported_not_swallowed() {
    // Base sans aucune table : l'enregistrement doit échouer proprement (faux), sans panique ni demi-lot.
    let conn = Connection::open_in_memory().unwrap();
    assert!(!store_photo_keywords(&conn, &[("C:/P/a.jpg".into(), paths(&[&["X"]]))]));
}

#[test]
fn name_validation() {
    assert_eq!(validate_name("  Paris ").unwrap(), "Paris");
    for bad in ["", "   ", "a/b", "a|b", "a,b"] { assert_eq!(validate_name(bad), Err("invalid_name".to_string()), "{bad:?}"); }
    assert_eq!(name_key("  ÉTÉ "), "été");
}

// ---------------------------------------------------------------------------
// Batch writes (run_write, run_rename, run_delete) on real synthetic JPEG/PNG files, using a local test stub so the fast suite runs without ExifTool.
// ---------------------------------------------------------------------------

fn test_write_stub(image_path: &str, update: &crate::exif::MetadataUpdate) -> std::io::Result<()> {
    let path = Path::new(image_path);
    if !path.is_file() { return Err(crate::exif::image_gone(path)); }
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or_default().to_ascii_lowercase();
    let is_jpeg = matches!(ext.as_str(), "jpg" | "jpeg");
    let target_sidecar = (!is_jpeg).then(|| crate::exif::sidecar_target(path));
    let current_xml = if is_jpeg {
        let data = std::fs::read(path)?;
        crate::exif::jpeg_segments(&data)
            .find(|s| s.marker == 0xe1 && s.content(&data).starts_with(b"http://ns.adobe.com/xap/1.0/\0"))
            .and_then(|s| std::str::from_utf8(&s.content(&data)[29..]).ok().map(str::to_string))
            .unwrap_or_default()
    } else {
        let target = target_sidecar.as_ref().unwrap();
        std::fs::read_to_string(target.seed.as_deref().unwrap_or(&target.path)).unwrap_or_default()
    };
    let meta = crate::exif::read_exif(path);
    let kw_paths = update.keywords.clone().unwrap_or(meta.keyword_paths);
    let title = update.clean_title().unwrap_or(meta.title);
    let authors = update.author_list().unwrap_or_else(|| crate::exif::split_authors(&meta.rights.author));
    let copyright = update.clean_copyright().unwrap_or(meta.rights.copyright);
    let credit = update.clean_credit().unwrap_or(meta.rights.credit);
    let terms = update.clean_usage_terms().unwrap_or(meta.rights.usage_terms);
    let email = update.clean_author_email().unwrap_or(meta.rights.author_email);
    let has_any = !kw_paths.is_empty() || !title.is_empty() || !authors.is_empty() || !copyright.is_empty() || !credit.is_empty() || !terms.is_empty() || !email.is_empty();
    if current_xml.is_empty() && !has_any { return Ok(()); }
    let mut body = String::new();
    if !kw_paths.is_empty() {
        let items: String = kw_paths.iter().map(|s| format!("<rdf:li>{}</rdf:li>", s.join("/"))).collect();
        body.push_str(&format!("<digiKam:TagsList><rdf:Seq>{items}</rdf:Seq></digiKam:TagsList>"));
    }
    if !title.is_empty() { body.push_str(&format!("<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">{title}</rdf:li></rdf:Alt></dc:title><acdsee:caption>{title}</acdsee:caption>")); }
    if !authors.is_empty() {
        let items: String = authors.iter().map(|a| format!("<rdf:li>{a}</rdf:li>")).collect();
        body.push_str(&format!("<dc:creator><rdf:Seq>{items}</rdf:Seq></dc:creator><tiff:Artist>{}</tiff:Artist>", authors.join("; ")));
    }
    if !copyright.is_empty() {
        body.push_str(&format!("<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">{copyright}</rdf:li></rdf:Alt></dc:rights><tiff:Copyright><rdf:Alt><rdf:li xml:lang=\"x-default\">{copyright}</rdf:li></rdf:Alt></tiff:Copyright>"));
    }
    if !credit.is_empty() { body.push_str(&format!("<photoshop:Credit>{credit}</photoshop:Credit>")); }
    if !terms.is_empty() { body.push_str(&format!("<xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang=\"x-default\">{terms}</rdf:li></rdf:Alt></xmpRights:UsageTerms>")); }
    if !email.is_empty() { body.push_str(&format!("<Iptc4xmpCore:CreatorContactInfo rdf:parseType=\"Resource\"><Iptc4xmpCore:CiEmailWork>{email}</Iptc4xmpCore:CiEmailWork></Iptc4xmpCore:CreatorContactInfo>")); }
    let xml = format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:digiKam=\"http://www.digikam.org/ns/1.0/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:acdsee=\"http://ns.acdsee.com/iptc/1.0/\" xmlns:tiff=\"http://ns.adobe.com/tiff/1.0/\" xmlns:photoshop=\"http://ns.adobe.com/photoshop/1.0/\" xmlns:xmpRights=\"http://ns.adobe.com/xap/1.0/rights/\" xmlns:Iptc4xmpCore=\"http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/\">{body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    );
    if is_jpeg {
        let data = std::fs::read(path)?;
        let header = b"http://ns.adobe.com/xap/1.0/\0";
        let len = (2 + header.len() + xml.len()) as u16;
        let mut seg = vec![0xff, 0xe1];
        seg.extend_from_slice(&len.to_be_bytes());
        seg.extend_from_slice(header);
        seg.extend_from_slice(xml.as_bytes());
        let out = match crate::exif::jpeg_segments(&data).find(|s| s.marker == 0xe1 && s.content(&data).starts_with(header)) {
            Some(s) => [&data[..s.start], seg.as_slice(), &data[s.end..]].concat(),
            None => [&data[..2], seg.as_slice(), &data[2..]].concat(),
        };
        std::fs::write(path, out)
    } else {
        std::fs::write(&target_sidecar.unwrap().path, xml)
    }
}

fn write_env(dir: &Path) -> WriteEnv {
    let cache_dirs = crate::ImageCacheDirs { thumbnails: dir.join("thumbnails"), raw_previews: dir.join("raw_previews") };
    std::fs::create_dir_all(&cache_dirs.thumbnails).unwrap();
    std::fs::create_dir_all(&cache_dirs.raw_previews).unwrap();
    WriteEnv { cache_dirs, progress: Box::new(|_| {}), write: test_write_stub }
}

/// A synthetic JPEG in `dir`, catalogued: (photo id, path).
fn catalogued_jpeg(conn: &Connection, dir: &Path, name: &str) -> (i64, String) {
    let path = dir.join(name);
    std::fs::write(&path, jpeg_bytes(32, 24)).unwrap();
    let path = path.to_string_lossy().into_owned();
    (insert_photo(conn, &path), path)
}

fn file_paths(path: &str) -> Vec<String> {
    let mut result: Vec<String> = crate::exif::read_exif(Path::new(path)).keyword_paths.iter().map(|segments| segments.join(" > ")).collect();
    result.sort();
    result
}

fn item(photo_id: i64, path: &str, keyword_ids: Option<Vec<i64>>) -> KeywordWriteItem {
    KeywordWriteItem { photo_id, path: path.to_string(), keyword_ids, title: None, description: None, author: None, copyright: None, credit: None, usage_terms: None, author_email: None, faces: None, gps: None }
}

#[test]
fn run_write_writes_the_file_then_stores_what_it_reads_back() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let paris = ensure_node(&conn, ensure_node(&conn, 0, "Lieux").unwrap(), "Paris").unwrap();
    let pixels = scan_data(&std::fs::read(&path).unwrap()).to_vec();

    // Keywords only: the title check (text_mismatch) follows the global writer setting, which a fast test must not change.
    let result = run_write(&write_env(dir.path()), &pool, vec![item(photo, &path, Some(vec![paris]))], None).unwrap();
    assert!(result.failed.is_empty(), "{:?}", result.failed.iter().map(|f| &f.error).collect::<Vec<_>>());
    assert_eq!(result.written.len(), 1);
    assert_eq!(result.written[0].keyword_ids, vec![paris]);
    assert_eq!(file_paths(&path), ["Lieux > Paris"]);
    assert_eq!(active_paths(&conn, photo), ["Lieux > Paris"]);
    let stored: String = conn.query_row("SELECT keywords FROM photos WHERE id = ?1", params![photo], |row| row.get(0)).unwrap();
    assert!(stored.contains("Paris"), "photos.keywords comes from the re-read file");
    assert_eq!(scan_data(&std::fs::read(&path).unwrap()), pixels.as_slice(), "image data untouched");
}

#[test]
fn run_write_fails_a_photo_with_an_unknown_keyword_or_outside_the_catalogue() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let before = std::fs::read(&path).unwrap();

    let result = run_write(&write_env(dir.path()), &pool, vec![item(photo, &path, Some(vec![9999])), item(4242, "C:/absent.jpg", Some(Vec::new()))], None).unwrap();
    assert!(result.written.is_empty());
    assert_eq!(result.failed.len(), 2);
    assert_eq!(std::fs::read(&path).unwrap(), before, "an unknown keyword must not silently drop the others from the file");
}

#[test]
fn rename_updates_the_tree_then_rewrites_every_file_carrying_the_keyword_or_a_descendant() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let (other, other_path) = catalogued_jpeg(&conn, dir.path(), "b.jpg");
    let places = ensure_node(&conn, 0, "Lieux").unwrap();
    let paris = ensure_node(&conn, places, "Paris").unwrap();
    let env = write_env(dir.path());
    run_write(&env, &pool, vec![item(photo, &path, Some(vec![paris])), item(other, &other_path, Some(vec![places]))], None).unwrap();

    let result = run_rename(&env, &pool, places, "Endroits".into(), None).unwrap();
    assert!(result.failed.is_empty());
    assert_eq!(result.written.len(), 2);
    assert_eq!(file_paths(&path), ["Endroits > Paris"]);
    assert_eq!(file_paths(&other_path), ["Endroits"]);
    assert_eq!(active_paths(&conn, photo), ["Endroits > Paris"]);
    assert_eq!(run_rename(&env, &pool, places, "a/b".into(), None).err().as_deref(), Some("invalid_name"));
    ensure_node(&conn, 0, "Autre").unwrap();
    assert_eq!(run_rename(&env, &pool, places, " autre ".into(), None).err().as_deref(), Some("duplicate"));
}

#[test]
fn delete_removes_the_subtree_from_the_files_and_the_tree() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let places = ensure_node(&conn, 0, "Lieux").unwrap();
    let paris = ensure_node(&conn, places, "Paris").unwrap();
    let animals = ensure_node(&conn, 0, "Animaux").unwrap();
    let env = write_env(dir.path());
    run_write(&env, &pool, vec![item(photo, &path, Some(vec![paris, animals]))], None).unwrap();

    let result = run_delete(&env, &pool, places, None).unwrap();
    assert!(result.deleted);
    assert_eq!(file_paths(&path), ["Animaux"]);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM keyword_nodes"), 1, "the keyword and its descendants leave the tree");
    assert_eq!(run_delete(&env, &pool, places, None).err().as_deref(), Some("unknown_keyword"));
}

#[test]
fn delete_keeps_the_keyword_when_a_file_could_not_be_rewritten() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let places = ensure_node(&conn, 0, "Lieux").unwrap();
    let env = write_env(dir.path());
    run_write(&env, &pool, vec![item(photo, &path, Some(vec![places]))], None).unwrap();
    // A second photo carries the keyword but its file is gone: its write fails.
    let gone = insert_photo(&conn, &dir.path().join("gone.jpg").to_string_lossy());
    assert!(store_photo_keywords(&conn, &[(dir.path().join("gone.jpg").to_string_lossy().into_owned(), paths(&[&["Lieux"]]))]));

    let result = run_delete(&env, &pool, places, None).unwrap();
    assert!(!result.deleted);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].photo_id, gone);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM keyword_nodes"), 1, "kept: a file still carries it");
    assert!(file_paths(&path).is_empty(), "the file that could be rewritten no longer carries it");
}


/// Auteur et droits : écrits dans le sidecar d'un PNG (la vérification d'un JPEG dépend du réglage global d'écriture, qu'un test rapide ne change pas),
/// relus, puis enregistrés en base et renvoyés à l'interface. Une écriture qui ne les mentionne pas les laisse tels quels ; une chaîne vide les retire.
#[test]
fn run_write_stores_the_rights_read_back_in_the_catalog() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let png = dir.path().join("a.png");
    std::fs::write(&png, png_bytes(8, 8)).unwrap();
    let path = png.to_string_lossy().into_owned();
    let photo = insert_photo(&conn, &path);
    let env = write_env(dir.path());
    let errors = |result: &KeywordWriteResult| result.failed.iter().map(|failure| failure.error.clone()).collect::<Vec<_>>();

    let request = KeywordWriteItem {
        author: Some("Ada; Bob".into()),
        copyright: Some("© 2026 Ada".into()),
        credit: Some("Agence".into()),
        usage_terms: Some("Usage libre".into()),
        author_email: Some("ada@example.org".into()),
        ..item(photo, &path, None)
    };
    let result = run_write(&env, &pool, vec![request], None).unwrap();
    assert!(result.failed.is_empty(), "{:?}", errors(&result));
    let returned = &result.written[0].rights;
    assert_eq!((returned.author.as_str(), returned.copyright.as_str(), returned.credit.as_str()), ("Ada; Bob", "© 2026 Ada", "Agence"));
    assert_eq!((returned.usage_terms.as_str(), returned.author_email.as_str()), ("Usage libre", "ada@example.org"));
    let expected = crate::rights::PhotoRights {
        photo_id: photo,
        author: "Ada; Bob".into(),
        copyright: "© 2026 Ada".into(),
        credit: "Agence".into(),
        usage_terms: "Usage libre".into(),
        author_email: "ada@example.org".into(),
    };
    assert_eq!(crate::rights::photo_rights(&conn, &[photo]).unwrap(), vec![expected.clone()]);
    // The list of photos only carries the author.
    let listed = crate::db::get_photos(&pool, 0, 10, None, true).unwrap();
    assert_eq!((listed[0].author.as_str(), listed[0].copyright.as_str()), ("Ada; Bob", ""));

    // A write that does not mention the rights leaves them as they are.
    let title_only = KeywordWriteItem { title: Some("Titre".into()), ..item(photo, &path, None) };
    let result = run_write(&env, &pool, vec![title_only], None).unwrap();
    assert!(result.failed.is_empty(), "{:?}", errors(&result));
    assert_eq!(crate::rights::photo_rights(&conn, &[photo]).unwrap(), vec![expected]);

    // Emptied fields are removed from the file and from the catalog.
    let clear = KeywordWriteItem {
        author: Some(String::new()),
        copyright: Some(String::new()),
        credit: Some(String::new()),
        usage_terms: Some(String::new()),
        author_email: Some(String::new()),
        ..item(photo, &path, None)
    };
    let result = run_write(&env, &pool, vec![clear], None).unwrap();
    assert!(result.failed.is_empty(), "{:?}", errors(&result));
    let cleared = crate::rights::photo_rights(&conn, &[photo]).unwrap();
    assert_eq!(cleared, vec![crate::rights::PhotoRights { photo_id: photo, author: String::new(), copyright: String::new(), credit: String::new(), usage_terms: String::new(), author_email: String::new() }]);
    assert_eq!(crate::db::get_photos(&pool, 0, 10, None, true).unwrap()[0].author, "");
}

/// Sets the modification date of `path` one hour back (so a sidecar written now is strictly newer, whatever the clock resolution).
fn backdate(path: &Path) {
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap();
}

/// A keyword write on a format that writes to a sidecar (PNG: `a.png.xmp`) never touches the image file, so `photos.modified` (its own mtime, the
/// sync's witness) must not move; `photos.effective_modified` follows the sidecar and is returned to the interface (`KeywordWritten`).
/// Removing a keyword from an image that has no sidecar writes nothing: the effective date stays the image's.
#[test]
fn a_sidecar_write_moves_the_effective_date_but_never_the_image_date() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let png = dir.path().join("a.png");
    std::fs::write(&png, png_bytes(8, 8)).unwrap();
    backdate(&png);
    let path = png.to_string_lossy().into_owned();
    let before = std::fs::read(&png).unwrap();
    let photo = insert_photo(&conn, &path);
    let image_date = crate::library_sync::modified_millis(&std::fs::metadata(&png).unwrap());
    conn.execute("UPDATE photos SET modified = ?1, effective_modified = ?1 WHERE id = ?2", params![image_date, photo]).unwrap();
    let dates = || -> (i64, i64) { conn.query_row("SELECT modified, effective_modified FROM photos WHERE id = ?1", params![photo], |row| Ok((row.get(0)?, row.get(1)?))).unwrap() };
    let paris = ensure_node(&conn, 0, "Paris").unwrap();
    let env = write_env(dir.path());

    // Removal only, no sidecar: nothing is written, the effective date stays the image's.
    let removal = run_write(&env, &pool, vec![item(photo, &path, Some(Vec::new()))], None).unwrap();
    assert!(removal.failed.is_empty(), "{:?}", removal.failed.iter().map(|f| &f.error).collect::<Vec<_>>());
    assert!(!Path::new(&format!("{path}.xmp")).exists(), "a removal alone creates no sidecar");
    assert_eq!(removal.written[0].effective_modified, image_date);
    assert_eq!(dates(), (image_date, image_date));

    // Adding a keyword creates the sidecar: only `effective_modified` moves, and the interface gets the same value.
    let added = run_write(&env, &pool, vec![item(photo, &path, Some(vec![paris]))], None).unwrap();
    assert!(added.failed.is_empty(), "{:?}", added.failed.iter().map(|f| &f.error).collect::<Vec<_>>());
    assert!(Path::new(&format!("{path}.xmp")).is_file());
    let sidecar_date = crate::library_sync::modified_millis(&std::fs::metadata(format!("{path}.xmp")).unwrap());
    assert!(sidecar_date > image_date);
    assert_eq!(added.written[0].effective_modified, sidecar_date);
    assert_eq!(dates(), (image_date, sidecar_date), "modified is still the image file's own mtime");
    assert_eq!(std::fs::read(&png).unwrap(), before, "the image file is never rewritten");
}

#[test]
fn keyword_filter_tree_returns_nodes_and_active_ids() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let a = insert_photo(&conn, "C:/P/a.jpg");
    let places = ensure_node(&conn, 0, "Places").unwrap();
    let france = ensure_node(&conn, places, "France").unwrap();
    let paris = ensure_node(&conn, france, "Paris").unwrap();
    let _unused = ensure_node(&conn, places, "Spain").unwrap();
    conn.execute("INSERT INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![a, paris]).unwrap();

    let tree = keyword_filter_tree_in(&conn).unwrap();
    assert_eq!(tree.nodes.len(), 4);
    assert_eq!(tree.active_ids, vec![paris], "inactive parents and unused nodes are excluded from active_ids");
}

#[test]
fn keyword_descendant_photos_matches_strict_descendants_only() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo_paris = insert_photo(&conn, "C:/P/a.jpg");
    let photo_france = insert_photo(&conn, "C:/P/b.jpg");
    let photo_homonym = insert_photo(&conn, "C:/P/c.jpg");

    let places = ensure_node(&conn, 0, "Places").unwrap();
    let france = ensure_node(&conn, places, "France").unwrap();
    let places_paris = ensure_node(&conn, france, "Paris").unwrap();
    let _lyon = ensure_node(&conn, france, "Lyon").unwrap();
    let people = ensure_node(&conn, 0, "People").unwrap();
    let people_paris = ensure_node(&conn, people, "Paris").unwrap();

    conn.execute("INSERT INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo_paris, places_paris]).unwrap();
    conn.execute("INSERT INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo_france, france]).unwrap();
    conn.execute("INSERT INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo_homonym, people_paris]).unwrap();

    let result = keyword_descendant_photos_in(&conn, &["France".into(), "places".into(), "Paris".into()]).unwrap();
    assert_eq!(result.get("france").unwrap(), &vec![photo_paris], "France~ matches strict descendants only, not photo_france or People/Paris");
    assert_eq!(result.get("places").unwrap(), &vec![photo_paris, photo_france], "Places~ (case-insensitive) matches child and grandchild");
    assert!(result.get("paris").unwrap().is_empty(), "leaf keyword has no descendants");
}

#[test]
fn sidecar_mismatch_or_db_rollback_marks_photo_for_resync() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let png = dir.path().join("a.png");
    std::fs::write(&png, png_bytes(8, 8)).unwrap();
    let path = png.to_string_lossy().into_owned();
    let photo = insert_photo(&conn, &path);
    conn.execute("UPDATE photos SET file_size = 123 WHERE id = ?1", params![photo]).unwrap();
    let paris = ensure_node(&conn, 0, "Paris").unwrap();

    // 1. Stub writes wrong keyword -> mismatch -> file_size = -1.
    let mut mismatch_env = write_env(dir.path());
    mismatch_env.write = |image_path, _update| {
        std::fs::write(
            format!("{image_path}.xmp"),
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:digiKam=\"http://www.digikam.org/ns/1.0/\"><digiKam:TagsList><rdf:Seq><rdf:li>Wrong</rdf:li></rdf:Seq></digiKam:TagsList></rdf:Description></rdf:RDF></x:xmpmeta>",
        )
    };
    let res = run_write(&mismatch_env, &pool, vec![item(photo, &path, Some(vec![paris]))], None).unwrap();
    assert_eq!(res.failed.len(), 1);
    let file_size: i64 = conn.query_row("SELECT file_size FROM photos WHERE id = ?1", params![photo], |r| r.get(0)).unwrap();
    assert_eq!(file_size, -1, "mismatch on sidecar must mark photo for resync");

    // 2. DB transaction fails on commit/keyword insert -> rolled back AND file_size = -1 persists on conn.
    conn.execute("UPDATE photos SET file_size = 123 WHERE id = ?1", params![photo]).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_kw BEFORE INSERT ON photo_keywords BEGIN SELECT RAISE(ABORT, 'db failure'); END;").unwrap();
    let res = run_write(&write_env(dir.path()), &pool, vec![item(photo, &path, Some(vec![paris]))], None).unwrap();
    assert_eq!(res.failed.len(), 1);
    assert!(res.written.is_empty());
    let file_size_after_db_err: i64 = conn.query_row("SELECT file_size FROM photos WHERE id = ?1", params![photo], |r| r.get(0)).unwrap();
    assert_eq!(file_size_after_db_err, -1, "DB rollback after write must mark photo for resync");
}

#[test]
fn jpeg_erasure_masked_by_sidecar_reports_sidecar_conflict() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();

    // 1. JPEG with own .jpg.xmp holding a title -> erasure leaves JPEG clean, sidecar still has title -> own conflict.
    let own_jpg = dir.path().join("own.jpg");
    std::fs::write(&own_jpg, jpeg_bytes(16, 16)).unwrap();
    std::fs::write(
        dir.path().join("own.jpg.xmp"),
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:dc=\"http://purl.org/dc/elements/1.1/\" dc:title=\"Old Title\"/></rdf:RDF></x:xmpmeta>",
    )
    .unwrap();
    let own_path = own_jpg.to_string_lossy().into_owned();
    let own_id = insert_photo(&conn, &own_path);

    let mut env = write_env(dir.path());
    env.write = |image_path, _update| std::fs::write(image_path, jpeg_bytes(16, 16));
    let mut own_item = item(own_id, &own_path, None);
    own_item.title = Some(String::new());
    let res = run_write(&env, &pool, vec![own_item], None).unwrap();
    assert_eq!(res.failed.len(), 1);
    let conflict = res.failed[0].sidecar_conflict.as_ref().expect("own sidecar conflict expected");
    assert_eq!(conflict.sidecar_name, "own.jpg.xmp");
    assert!(!conflict.shared);

    // 2. JPEG paired with RAW sharing photo.xmp -> shared conflict.
    let pair_jpg = dir.path().join("pair.jpg");
    std::fs::write(&pair_jpg, jpeg_bytes(16, 16)).unwrap();
    std::fs::write(dir.path().join("pair.cr2"), b"raw").unwrap();
    std::fs::write(
        dir.path().join("pair.xmp"),
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:dc=\"http://purl.org/dc/elements/1.1/\" dc:description=\"Old Desc\"/></rdf:RDF></x:xmpmeta>",
    )
    .unwrap();
    let pair_path = pair_jpg.to_string_lossy().into_owned();
    let pair_id = insert_photo(&conn, &pair_path);
    let mut pair_item = item(pair_id, &pair_path, None);
    pair_item.description = Some(String::new());
    let res = run_write(&env, &pool, vec![pair_item], None).unwrap();
    assert_eq!(res.failed.len(), 1);
    let conflict = res.failed[0].sidecar_conflict.as_ref().expect("shared sidecar conflict expected");
    assert_eq!(conflict.sidecar_name, "pair.xmp");
    assert!(conflict.shared);
}
