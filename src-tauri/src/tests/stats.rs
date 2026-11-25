//! Tests for collection statistics coverage counts (content analysis and duplicate hashes).

use rusqlite::params;

use super::*;
use crate::duplicates::LAYOUT_VERSION;
use crate::phash::ALGO_VERSION;
use crate::test_support::{insert_photo, temp_catalog};

#[test]
fn coverage_stats_count_uptodate_expired_and_excluded_items() {
    let (_catalog, pool) = temp_catalog();
    {
        let conn = pool.get().unwrap();
        let jpg_ok = insert_photo(&conn, "C:/photos/ok.jpg");
        let jpg_expired = insert_photo(&conn, "C:/photos/expired.jpg");
        let _jpg_missing = insert_photo(&conn, "C:/photos/missing.jpg");
        let _raw_missing = insert_photo(&conn, "C:/photos/raw.cr2");
        let _vid = insert_photo(&conn, "C:/photos/clip.mp4");
        let model_id = crate::semantic_models::active_model().id.clone();

        for id in [jpg_ok, jpg_expired] {
            conn.execute("UPDATE photos SET file_size = 500, modified = 1000 WHERE id = ?1", params![id]).unwrap();
        }
        conn.execute(
            "INSERT INTO photo_embeddings (photo_id, model_id, file_size, file_mtime, vec) VALUES (?1, ?2, 500, 1000, X'00000000')",
            params![jpg_ok, model_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO photo_embeddings (photo_id, model_id, file_size, file_mtime, vec) VALUES (?1, ?2, 400, 1000, X'00000000')",
            params![jpg_expired, model_id],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO photo_hashes (photo_id, mode, version, size, modified, tolerant, data_len, full_hash) VALUES (?1, 1, ?2, 500, 1000, 1, 450, X'0011')",
            params![jpg_ok, LAYOUT_VERSION],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO photo_hashes (photo_id, mode, version, size, modified, tolerant, data_len, full_hash) VALUES (?1, 1, ?2, 400, 1000, 1, 350, X'0011')",
            params![jpg_expired, LAYOUT_VERSION],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO photo_phash (photo_id, size, modified, algo, flat, hashes) VALUES (?1, 500, 1000, ?2, 0, ?3)",
            params![jpg_ok, ALGO_VERSION, vec![0u8; 64]],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO photo_phash (photo_id, size, modified, algo, flat, hashes) VALUES (?1, 500, 1000, 0, 0, ?2)",
            params![jpg_expired, vec![0u8; 64]],
        )
        .unwrap();
    }

    let stats = compute(&pool, &StatsFilter { with_analysis: true, ..StatsFilter::default() }).unwrap();
    assert_eq!(stats.photos, 5);
    let analysis = stats.analysis.expect("analysis stats");
    assert_eq!(analysis, CoverageStats { eligible: 5, up_to_date: 1, expired: 1, excluded: 0 });
    assert_eq!(stats.exact_prepass, CoverageStats { eligible: 4, up_to_date: 1, expired: 1, excluded: 1 });
    assert_eq!(stats.exact_full, CoverageStats { eligible: 4, up_to_date: 1, expired: 1, excluded: 1 });
    assert_eq!(stats.similarity, CoverageStats { eligible: 4, up_to_date: 1, expired: 1, excluded: 1 });
}
