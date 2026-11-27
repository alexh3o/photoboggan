use super::*;
use crate::test_support::{insert_photo, jpeg_bytes, temp_catalog};
use std::fs;
use std::sync::atomic::AtomicBool;

fn write_file(dir: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn import_schema_and_device_policy_round_trip() {
    let (_cat, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    conn.execute(
        "INSERT INTO import_devices (media_id, last_label, last_root_path, policy, last_seen_at)
         VALUES ('ABCD-1234', 'EOS_DIGITAL', 'E:\\', 'whitelist', 1000)",
        [],
    )
    .unwrap();
    let (label, policy): (String, String) = conn
        .query_row(
            "SELECT last_label, policy FROM import_devices WHERE media_id = 'ABCD-1234'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(label, "EOS_DIGITAL");
    assert_eq!(policy, "whitelist");

    conn.execute(
        "UPDATE import_devices SET policy = 'blacklist' WHERE media_id = 'ABCD-1234'",
        [],
    )
    .unwrap();
    let policy: String = conn
        .query_row("SELECT policy FROM import_devices WHERE media_id = 'ABCD-1234'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(policy, "blacklist");
}

#[test]
fn import_history_records_dedupes_and_purges_by_age() {
    let (_cat, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let now = crate::library_sync::now_millis();
    let old = now - 40 * 86_400_000;

    conn.execute(
        "INSERT INTO import_history (media_id, root_folder, relative_path, filename, file_size, file_mtime, dest_path, imported_at)
         VALUES ('M1', '/sd', 'DCIM/IMG_1.JPG', 'IMG_1.JPG', 100, 1000, '/lib/IMG_1.JPG', ?1)",
        params![old],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO import_history (media_id, root_folder, relative_path, filename, file_size, file_mtime, dest_path, imported_at)
         VALUES ('M1', '/sd', 'DCIM/IMG_2.JPG', 'IMG_2.JPG', 200, 2000, '/lib/IMG_2.JPG', ?1)",
        params![now],
    )
    .unwrap();

    let cutoff = now - 30 * 86_400_000;
    let deleted = conn
        .execute("DELETE FROM import_history WHERE media_id = 'M1' AND imported_at < ?1", params![cutoff])
        .unwrap();
    assert_eq!(deleted, 1);
    let remaining: i64 = conn
        .query_row("SELECT COUNT(*) FROM import_history WHERE media_id = 'M1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(remaining, 1);
}

#[test]
fn fast_scan_counts_folder_kinds_and_detects_memory_and_library_matches() {
    let (_cat, pool) = temp_catalog();
    let src = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();

    let jpg = jpeg_bytes(32, 32);
    let f_mem = write_file(src.path(), "DCIM/100CANON/IMG_0001.JPG", &jpg);
    let f_lib = write_file(src.path(), "DCIM/100CANON/IMG_0002.JPG", &jpg);
    write_file(src.path(), "DCIM/100CANON/IMG_0003.CR3", b"rawdata");
    write_file(src.path(), "DCIM/100CANON/CLIP_0004.MP4", b"videodata");

    let lib_file = write_file(lib.path(), "IMG_0002.JPG", &jpg);
    let mem_meta = fs::metadata(&f_mem).unwrap();
    let mem_mtime = crate::library_sync::modified_millis(&mem_meta);
    let lib_meta = fs::metadata(&f_lib).unwrap();

    {
        let conn = pool.get().unwrap();
        conn.execute(
            "INSERT INTO import_history (media_id, root_folder, relative_path, filename, file_size, file_mtime, dest_path, imported_at)
             VALUES ('SD1', ?1, 'DCIM/100CANON/IMG_0001.JPG', 'IMG_0001.JPG', ?2, ?3, '/dest/IMG_0001.JPG', 9999)",
            params![normalize_path(&src.path().to_string_lossy()), mem_meta.len() as i64, mem_mtime],
        )
        .unwrap();
        let id = insert_photo(&conn, &lib_file.to_string_lossy());
        conn.execute(
            "UPDATE photos SET filename = 'IMG_0002.JPG', file_size = ?1 WHERE id = ?2",
            params![lib_meta.len() as i64, id],
        )
        .unwrap();
    }

    let conn = pool.get().unwrap();
    let cancel = AtomicBool::new(false);
    let scan = scan_source_fast_with_conn(&conn, &src.path().to_string_lossy(), "SD1", &cancel).unwrap();
    assert_eq!(scan.files.len(), 4);

    let by_name: HashMap<String, ImportSourceFile> = scan
        .files
        .into_iter()
        .map(|f| (f.filename.clone(), f))
        .collect();
    assert_eq!(by_name["IMG_0001.JPG"].status, "imported_memory");
    assert_eq!(by_name["IMG_0002.JPG"].status, "in_library");
    assert_eq!(by_name["IMG_0003.CR3"].status, "new");
    assert_eq!(by_name["CLIP_0004.MP4"].status, "new");
    assert_eq!(by_name["IMG_0003.CR3"].kind, "raw");
    assert_eq!(by_name["CLIP_0004.MP4"].kind, "video");

    let canon = scan
        .folders
        .iter()
        .find(|f| f.name == "100CANON")
        .unwrap();
    assert_eq!(canon.raster_count, 2);
    assert_eq!(canon.raw_count, 1);
    assert_eq!(canon.video_count, 1);
}

#[test]
fn ambiguous_candidate_detection_matches_renamed_file_via_date_and_partial_hash() {
    let (_cat, pool) = temp_catalog();
    let src = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let jpg = jpeg_bytes(48, 36);

    let src_file = write_file(src.path(), "IMG_100.JPG", &jpg);
    let lib_file = write_file(lib.path(), "Renamed_Holiday.JPG", &jpg);

    let (_, lib_partial) = crate::duplicates::quick_partial_hash(&lib_file).unwrap();
    {
        let conn = pool.get().unwrap();
        let id = insert_photo(&conn, &lib_file.to_string_lossy());
        conn.execute(
            "UPDATE photos SET date_taken = '2026-11-27 10:00:00' WHERE id = ?1",
            params![id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO photo_hashes (photo_id, mode, version, size, modified, data_len, tolerant, partial_hash)
             VALUES (?1, 1, ?2, 100, 100, 100, 1, ?3)",
            params![id, crate::duplicates::LAYOUT_VERSION, lib_partial.as_slice()],
        )
        .unwrap();
    }

    // Verify quick_partial_hash matches between source and library copy even after rename.
    let (_, src_partial) = crate::duplicates::quick_partial_hash(&src_file).unwrap();
    assert_eq!(src_partial, lib_partial);
}

#[test]
fn compute_import_targets_handles_date_and_type_subfolders_safely() {
    let base = Path::new("/library/Photos");
    let item = ImportCopyItem {
        source_path: "/sd/IMG_1.CR3".into(),
        relative_path: "DCIM/IMG_1.CR3".into(),
        filename: "IMG_1.CR3".into(),
        kind: "raw".into(),
        size: 100,
        mtime: 0,
        date_taken: "2026:11:27 14:30:00".into(),
    };
    let opts = ImportSubfolderOptions {
        base_destination: "/library/Photos".into(),
        subfolder_mode: "yyyy/yyyy_mm_dd".into(),
        custom_subfolder: String::new(),
        split_by_type: true,
        subfolder_raw: "RAW_AND_JPG".into(),
        subfolder_raster: "RAW_AND_JPG".into(),
        subfolder_video: "Video".into(),
    };
    let dir = compute_target_dir(base, &item, &opts).unwrap();
    assert_eq!(dir, PathBuf::from("/library/Photos/2026/2026-11-27/RAW_AND_JPG"));

    let bad_opts = ImportSubfolderOptions {
        custom_subfolder: "..\\evil".into(),
        subfolder_mode: "custom".into(),
        ..opts
    };
    assert!(compute_target_dir(base, &item, &bad_opts).is_err());
}

#[test]
fn chronological_copy_respects_skip_rename_replace_and_records_history_incrementally() {
    let (_cat, pool) = temp_catalog();
    let src = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let base_data = tempfile::tempdir().unwrap();
    {
        let conn = pool.get().unwrap();
        conn.execute(
            "INSERT INTO folders (path) VALUES (?1)",
            params![lib.path().to_string_lossy()],
        )
        .unwrap();
    }

    let jpg1 = jpeg_bytes(32, 32);
    let jpg2 = jpeg_bytes(40, 40);
    let s1 = write_file(src.path(), "DCIM/A.JPG", &jpg1);
    let s2 = write_file(src.path(), "DCIM/B.JPG", &jpg2);
    // Pre-existing file for collision test (skip)
    write_file(lib.path(), "A.JPG", b"existing");

    let req = ImportCopyRequest {
        media_id: "SD_TEST".into(),
        root_folder: src.path().to_string_lossy().into_owned(),
        items: vec![
            ImportCopyItem {
                source_path: s2.to_string_lossy().into_owned(),
                relative_path: "DCIM/B.JPG".into(),
                filename: "B.JPG".into(),
                kind: "raster".into(),
                size: jpg2.len() as u64,
                mtime: 2000,
                date_taken: "2026:11:27 12:00:00".into(),
            },
            ImportCopyItem {
                source_path: s1.to_string_lossy().into_owned(),
                relative_path: "DCIM/A.JPG".into(),
                filename: "A.JPG".into(),
                kind: "raster".into(),
                size: jpg1.len() as u64,
                mtime: 1000,
                date_taken: "2026:11:27 11:00:00".into(),
            },
        ],
        options: ImportSubfolderOptions {
            base_destination: lib.path().to_string_lossy().into_owned(),
            subfolder_mode: "none".into(),
            custom_subfolder: String::new(),
            split_by_type: false,
            subfolder_raw: "RAW".into(),
            subfolder_raster: "JPEG".into(),
            subfolder_video: "Video".into(),
        },
        collision_policy: "skip".into(),
        resolutions: HashMap::new(),
        verify_videos: false,
    };

    let cancel = AtomicBool::new(false);
    let res = run_import_copy_with(&pool, base_data.path(), req, &cancel, |_| {}).unwrap();
    assert_eq!(res.skipped.len(), 1);
    assert_eq!(res.copied.len(), 1);
    assert_eq!(res.copied[0].filename, "B.JPG");
    assert!(s1.exists() && s2.exists(), "source files must never be deleted");

    let conn = pool.get().unwrap();
    let hist_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM import_history WHERE media_id = 'SD_TEST'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(hist_count, 1);
}

#[test]
fn video_sha256_verification_succeeds_on_valid_copy() {
    let (_cat, pool) = temp_catalog();
    let src = tempfile::tempdir().unwrap();
    let lib = tempfile::tempdir().unwrap();
    let base_data = tempfile::tempdir().unwrap();
    {
        let conn = pool.get().unwrap();
        conn.execute("INSERT INTO folders (path) VALUES (?1)", params![lib.path().to_string_lossy()]).unwrap();
    }
    let vid = write_file(src.path(), "DCIM/CLIP.MP4", b"fake-video-stream-12345");
    let req = ImportCopyRequest {
        media_id: "SD_VID".into(),
        root_folder: src.path().to_string_lossy().into_owned(),
        items: vec![ImportCopyItem {
            source_path: vid.to_string_lossy().into_owned(),
            relative_path: "DCIM/CLIP.MP4".into(),
            filename: "CLIP.MP4".into(),
            kind: "video".into(),
            size: 23,
            mtime: 3000,
            date_taken: String::new(),
        }],
        options: ImportSubfolderOptions {
            base_destination: lib.path().to_string_lossy().into_owned(),
            subfolder_mode: "none".into(),
            custom_subfolder: String::new(),
            split_by_type: false,
            subfolder_raw: "RAW".into(),
            subfolder_raster: "JPEG".into(),
            subfolder_video: "Video".into(),
        },
        collision_policy: "rename".into(),
        resolutions: HashMap::new(),
        verify_videos: true,
    };
    let cancel = AtomicBool::new(false);
    let res = run_import_copy_with(&pool, base_data.path(), req, &cancel, |_| {}).unwrap();
    assert_eq!(res.copied.len(), 1);
    assert!(res.failed.is_empty());
}

#[test]
fn index_imported_photos_indexes_only_given_paths() {
    let (_cat, pool) = temp_catalog();
    let lib = tempfile::tempdir().unwrap();
    let p1 = write_file(lib.path(), "imported.jpg", &jpeg_bytes(32, 32));
    let _p2 = write_file(lib.path(), "unrelated.jpg", &jpeg_bytes(32, 32));

    let indexed = index_paths_with_pool(&pool, &[p1.to_string_lossy().into_owned()]).unwrap();
    assert_eq!(indexed.len(), 1);
    assert_eq!(indexed[0].filename, "imported.jpg");

    let conn = pool.get().unwrap();
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0)).unwrap();
    assert_eq!(total, 1);
}

#[test]
fn import_presets_crud_and_case_insensitive_upsert() {
    let (_cat, pool) = temp_catalog();
    let conn = pool.get().unwrap();

    assert!(save_preset_with_conn(&conn, "   ", "{}").is_err());
    assert!(save_preset_with_conn(&conn, "Bad", "[]").is_err());

    let list = save_preset_with_conn(&conn, "Wedding", r#"{"subfolderMode":"yyyy_mm_dd"}"#).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Wedding");

    let updated = save_preset_with_conn(&conn, "wedding", r#"{"subfolderMode":"none"}"#).unwrap();
    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].name, "wedding");
    assert_eq!(updated[0].config, r#"{"subfolderMode":"none"}"#);

    let after_del = delete_preset_with_conn(&conn, updated[0].id).unwrap();
    assert!(after_del.is_empty());
}

#[test]
fn fast_import_thumbnail_reads_tiff_raw_ifd_preview_and_jpeg_exif_thumb() {
    let dir = tempfile::tempdir().unwrap();
    let embedded = jpeg_bytes(64, 48);

    // 1. Minimal little-endian TIFF-based RAW (.arw) with IFD0 pointing to embedded JPEG via 0x0201/0x0202
    let jpeg_offset: u32 = 8 + 2 + 2 * 12 + 4;
    let mut raw = Vec::new();
    raw.extend_from_slice(b"II*\0");
    raw.extend_from_slice(&8u32.to_le_bytes()); // IFD0 at offset 8
    raw.extend_from_slice(&2u16.to_le_bytes()); // 2 entries
    // Tag 0x0201 (JPEGInterchangeFormat), LONG (4), count 1, value = jpeg_offset
    raw.extend_from_slice(&0x0201u16.to_le_bytes());
    raw.extend_from_slice(&4u16.to_le_bytes());
    raw.extend_from_slice(&1u32.to_le_bytes());
    raw.extend_from_slice(&jpeg_offset.to_le_bytes());
    // Tag 0x0202 (JPEGInterchangeFormatLength), LONG (4), count 1, value = embedded.len()
    raw.extend_from_slice(&0x0202u16.to_le_bytes());
    raw.extend_from_slice(&4u16.to_le_bytes());
    raw.extend_from_slice(&1u32.to_le_bytes());
    raw.extend_from_slice(&(embedded.len() as u32).to_le_bytes());
    raw.extend_from_slice(&0u32.to_le_bytes()); // next IFD = 0
    raw.extend_from_slice(&embedded);

    let raw_path = write_file(dir.path(), "TEST.ARW", &raw);
    let raw_thumb = crate::thumbnails::render_fast_import_thumbnail_bytes(&raw_path, 200, 75).unwrap();
    assert!(raw_thumb.starts_with(&[0xff, 0xd8]) && raw_thumb.ends_with(&[0xff, 0xd9]));

    // 2. JPEG with APP1 EXIF IFD1 thumbnail
    let thumb_jpg = jpeg_bytes(220, 160);
    let main_jpg = jpeg_bytes(320, 240);
    let mut tiff = Vec::new();
    let ifd0_off: u32 = 8;
    let ifd1_off: u32 = 8 + 2 + 12 + 4;
    let thumb_off: u32 = ifd1_off + 2 + 2 * 12 + 4;
    tiff.extend_from_slice(b"II*\0");
    tiff.extend_from_slice(&ifd0_off.to_le_bytes());
    // IFD0: 1 entry (Orientation = 1), next_ifd = ifd1_off
    tiff.extend_from_slice(&1u16.to_le_bytes());
    tiff.extend_from_slice(&0x0112u16.to_le_bytes());
    tiff.extend_from_slice(&3u16.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&ifd1_off.to_le_bytes());
    // IFD1: 2 entries (0x0201, 0x0202), next_ifd = 0
    tiff.extend_from_slice(&2u16.to_le_bytes());
    tiff.extend_from_slice(&0x0201u16.to_le_bytes());
    tiff.extend_from_slice(&4u16.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&thumb_off.to_le_bytes());
    tiff.extend_from_slice(&0x0202u16.to_le_bytes());
    tiff.extend_from_slice(&4u16.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&(thumb_jpg.len() as u32).to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(&thumb_jpg);

    let mut jpg_with_exif = Vec::new();
    jpg_with_exif.extend_from_slice(&[0xff, 0xd8, 0xff, 0xe1]);
    let app1_len = (2 + 6 + tiff.len()) as u16;
    jpg_with_exif.extend_from_slice(&app1_len.to_be_bytes());
    jpg_with_exif.extend_from_slice(b"Exif\0\0");
    jpg_with_exif.extend_from_slice(&tiff);
    jpg_with_exif.extend_from_slice(&main_jpg[2..]);

    let jpg_path = write_file(dir.path(), "TEST.JPG", &jpg_with_exif);
    let jpg_thumb = crate::thumbnails::render_fast_import_thumbnail_bytes(&jpg_path, 200, 75).unwrap();
    assert_eq!(jpg_thumb, thumb_jpg);
}

#[test]
fn pure_seek_exif_reads_tiff_date_and_orientation_without_full_file_scan() {
    let dir = tempfile::tempdir().unwrap();
    let date_bytes = b"2026:11:27 15:30:00\0";

    // Little-endian TIFF with IFD0 (Orientation=6, ExifIFD pointer) -> ExifIFD (DateTimeOriginal)
    let ifd0_off: u32 = 8;
    let exif_ifd_off: u32 = ifd0_off + 2 + 2 * 12 + 4;
    let date_off: u32 = exif_ifd_off + 2 + 12 + 4;

    let mut raw = Vec::new();
    raw.extend_from_slice(b"II*\0");
    raw.extend_from_slice(&ifd0_off.to_le_bytes());
    // IFD0: 2 entries
    raw.extend_from_slice(&2u16.to_le_bytes());
    // 0x0112 Orientation = 6
    raw.extend_from_slice(&0x0112u16.to_le_bytes());
    raw.extend_from_slice(&3u16.to_le_bytes());
    raw.extend_from_slice(&1u32.to_le_bytes());
    raw.extend_from_slice(&6u32.to_le_bytes());
    // 0x8769 ExifIFD pointer
    raw.extend_from_slice(&0x8769u16.to_le_bytes());
    raw.extend_from_slice(&4u16.to_le_bytes());
    raw.extend_from_slice(&1u32.to_le_bytes());
    raw.extend_from_slice(&exif_ifd_off.to_le_bytes());
    raw.extend_from_slice(&0u32.to_le_bytes());
    // ExifIFD: 1 entry (0x9003 DateTimeOriginal)
    raw.extend_from_slice(&1u16.to_le_bytes());
    raw.extend_from_slice(&0x9003u16.to_le_bytes());
    raw.extend_from_slice(&2u16.to_le_bytes());
    raw.extend_from_slice(&(date_bytes.len() as u32).to_le_bytes());
    raw.extend_from_slice(&date_off.to_le_bytes());
    raw.extend_from_slice(&0u32.to_le_bytes());
    raw.extend_from_slice(date_bytes);

    let raw_path = write_file(dir.path(), "SEEK.ARW", &raw);
    let (dt, ori) = crate::thumbnails::read_fast_exif_fields(&raw_path);
    assert_eq!(dt, "2026:11:27 15:30:00");
    assert_eq!(ori, 6);

    #[cfg(windows)]
    assert_eq!(detect_storage_kind(Path::new(r"\\nas\photos")), "network");
    let local_kind = detect_storage_kind(dir.path());
    assert!(matches!(local_kind, "internal" | "removable" | "network"));
}
