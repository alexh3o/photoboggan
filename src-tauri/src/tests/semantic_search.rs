//! Tests of the semantic searches: ranking, relative threshold and cap, stable order, scopes, index updates and release. Fake vectors
//! only, no model.
//!
//! Parity of the text search with the reference model is `#[ignore]`: run it with
//!   SEMANTIC_MODEL_DIR=<folder with text.onnx, tokenizer.json> cargo test semantic_search:: -- --ignored
//! (ONNX Runtime library: ORT_DYLIB_PATH, otherwise the `models/` folder of an installed application). The speed measure on 100,000
//! vectors is ignored too: `cargo test --release semantic_search::tests::speed -- --ignored --nocapture`.

use std::time::{Duration, Instant};

use rusqlite::{params, Connection};

use super::*;
use crate::semantic::{select_targets, stats, store_batch, vector_to_blob};
use crate::test_support::{insert_photo, onnx_runtime_library, semantic_model_dir, temp_catalog};

const DIM: usize = 4;

/// Unit vector of the plane (x, y) at `angle` radians: its cosine with (1, 0, 0, 0) is cos(angle).
fn at_angle(angle: f32) -> Vec<f32> {
    vec![angle.cos(), angle.sin(), 0.0, 0.0]
}

fn small_index(rows: &[(i64, Vec<f32>)]) -> Index {
    let mut index = Index::new("test-model", DIM);
    for (id, vector) in rows { index.upsert(*id, vector, (1, 1)); }
    index
}

fn ids(hits: &[Hit]) -> Vec<i64> {
    hits.iter().map(|hit| hit.photo_id).collect()
}

const ALL: &(dyn Fn(i64) -> bool + Sync) = &|_| true;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

#[test]
fn ranking_returns_the_best_photos_first() {
    let index = small_index(&[(1, at_angle(0.9)), (2, at_angle(0.1)), (3, at_angle(0.5)), (4, at_angle(1.4)), (5, at_angle(0.3))]);
    let query = at_angle(0.0);
    let ranking = index.rank(&query, ALL, 10);
    assert_eq!(ids(&ranking.hits), vec![2, 5, 3, 1, 4]);
    assert!(!ranking.capped);
    // Cosines are those of the half-float vectors: within half precision of the exact value.
    assert!((ranking.best.unwrap() - 0.1f32.cos()).abs() < 1e-3);
    for hit in &ranking.hits { assert_eq!(hit.prob, None); }
    // Top 2 only.
    let ranking = index.rank(&query, ALL, 2);
    assert_eq!((ids(&ranking.hits), ranking.capped), (vec![2, 5], true));
}

#[test]
fn equal_scores_keep_a_stable_order_even_across_the_cap() {
    // Five photos with the same vector, inserted out of order, and a better one.
    let mut rows: Vec<(i64, Vec<f32>)> = [40, 10, 50, 20, 30].iter().map(|&id| (id, at_angle(0.4))).collect();
    rows.push((99, at_angle(0.0)));
    let index = small_index(&rows);
    let query = at_angle(0.0);
    assert_eq!(ids(&index.rank(&query, ALL, 10).hits), vec![99, 10, 20, 30, 40, 50]);
    // The cap falls among the ties: the smallest ids are kept, every time.
    for _ in 0..5 { assert_eq!(ids(&index.rank(&query, ALL, 3).hits), vec![99, 10, 20]); }
}

#[test]
fn relative_threshold_keeps_the_photos_close_to_the_best() {
    let index = small_index(&[(1, at_angle(0.0)), (2, at_angle(0.2)), (3, at_angle(0.3)), (4, at_angle(0.6))]);
    // Cosines: 1.0, 0.980, 0.955, 0.825.
    let mut hits = index.rank(&at_angle(0.0), ALL, 10).hits;
    relevance_cut(&mut hits, 0.03);
    assert_eq!(ids(&hits), vec![1, 2]);
    let mut hits = index.rank(&at_angle(0.0), ALL, 10).hits;
    relevance_cut(&mut hits, 0.05);
    assert_eq!(ids(&hits), vec![1, 2, 3]);
    // Combined with the cap: the cap wins when it is tighter.
    let mut hits = index.rank(&at_angle(0.0), ALL, 2).hits;
    relevance_cut(&mut hits, 0.5);
    assert_eq!(ids(&hits), vec![1, 2]);
    // Δ = 0 keeps the ties of the best; an empty list stays empty.
    let mut hits = small_index(&[(1, at_angle(0.1)), (2, at_angle(0.1)), (3, at_angle(0.2))]).rank(&at_angle(0.0), ALL, 10).hits;
    relevance_cut(&mut hits, 0.0);
    assert_eq!(ids(&hits), vec![1, 2]);
    let mut empty: Vec<Hit> = Vec::new();
    relevance_cut(&mut empty, 0.03);
    assert!(empty.is_empty());
}

#[test]
fn rows_can_be_replaced_and_removed() {
    let mut index = small_index(&[(1, at_angle(0.0)), (2, at_angle(0.5)), (3, at_angle(1.0))]);
    index.upsert(3, &at_angle(0.1), (2, 2)); // photo 3 analysed again (new file version)
    assert!(index.is_up_to_date(3, (2, 2)) && !index.is_up_to_date(3, (1, 1)));
    index.remove(1); // the last row moves into its place
    index.remove(42); // unknown: nothing happens
    assert_eq!(index.len(), 2);
    assert_eq!(ids(&index.rank(&at_angle(0.0), ALL, 10).hits), vec![3, 2]);
    assert!((index.vector(2).unwrap()[0] - 0.5f32.cos()).abs() < 1e-3);
    assert_eq!(index.vector(1), None);
    assert!(index.is_up_to_date(3, (2, 2)) && index.is_up_to_date(2, (1, 1)) && !index.is_up_to_date(1, (1, 1)));
    index.remove(3);
    index.remove(2);
    assert_eq!((index.len(), index.rank(&at_angle(0.0), ALL, 10).best), (0, None));
}

#[test]
fn many_rows_are_scored_like_one_by_one() {
    // More rows than one rayon block, with the model size: the parallel result is the plain dot product of the stored halves.
    let dim = 768;
    let mut index = Index::new("test-model", dim);
    let vector = |seed: usize| -> Vec<f32> {
        let mut vector: Vec<f32> = (0..dim).map(|i| ((i * 7 + seed * 13) % 101) as f32 / 101.0 - 0.5).collect();
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        vector.iter_mut().for_each(|v| *v /= norm);
        vector
    };
    for id in 0..5000 { index.upsert(id as i64, &vector(id), (1, 1)); }
    let query = vector(77);
    let ranking = index.rank(&query, &|id| id % 2 == 0, MAX_RESULTS);
    assert_eq!(ranking.hits.len(), MAX_RESULTS);
    assert!(ranking.capped);
    assert!(ranking.hits.iter().all(|hit| hit.photo_id % 2 == 0));
    assert!(ranking.hits.windows(2).all(|pair| rank_order(&pair[0], &pair[1]) == std::cmp::Ordering::Less));
    for hit in ranking.hits.iter().step_by(97) {
        let row = index.vector(hit.photo_id).unwrap();
        let expected: f32 = row.iter().zip(&query).map(|(a, b)| a * b).sum();
        assert!((hit.cos - expected).abs() < 1e-5, "{} vs {expected}", hit.cos);
    }
}

#[test]
fn probability_follows_the_model_constants() {
    let model = active_model();
    // sigmoid(0) at the cosine where the logit is zero.
    let neutral = -model.logit_bias / model.logit_scale;
    assert!((probability(neutral, model) - 0.5).abs() < 1e-4);
    // logit(0.10) = 11.267 − 16.772 = −5.505: p ≈ 0.0040; logit(0.14) ≈ −1.00: p ≈ 0.27 (§15.3: best matches give 0.000 to 0.36).
    assert!((probability(0.10, model) - 0.0040).abs() < 2e-4, "{}", probability(0.10, model));
    assert!((probability(0.14, model) - 0.27).abs() < 0.01, "{}", probability(0.14, model));
    assert!(probability(0.14, model) > probability(0.10, model));
}

#[test]
fn queries_with_nothing_to_search_for_are_refused() {
    let model = active_model();
    for query in ["", "   ", "?!", " ... ", "« … »", "-_-"] {
        assert_eq!(prepare_query(query, model).unwrap_err(), EMPTY_QUERY_ERROR, "{query:?}");
    }
    assert_eq!(prepare_query("  Plage  ", model).unwrap(), "this is a photo of plage.");
    assert_eq!(prepare_query("🎂", model).unwrap(), "this is a photo of 🎂.");
    assert_eq!(prepare_query("été", model).unwrap(), "this is a photo of été.");
    assert_eq!(prepare_query("people eating at a table", model).unwrap(), "people eating at a table");
}

// ---------------------------------------------------------------------------
// Search on a catalogue
// ---------------------------------------------------------------------------

const MODEL: &str = "siglip2-base-p16-224";

/// Unit vector of the model size, in the plane of its two first axes.
fn model_vector(angle: f32) -> Vec<f32> {
    let mut vector = vec![0f32; active_model().embed_dim];
    vector[0] = angle.cos();
    vector[1] = angle.sin();
    vector
}

fn add_photo(conn: &Connection, path: &str) -> i64 {
    let id = insert_photo(conn, path);
    conn.execute("UPDATE photos SET file_size = 1, modified = 1 WHERE id = ?1", [id]).unwrap();
    id
}

fn target(conn: &Connection, id: i64) -> Target {
    select_targets(conn, MODEL, Some(&[id]), None, false).unwrap().pop().unwrap()
}

/// Stores the embedding of a photo, as a scan does, and tells the cache.
fn analyse(conn: &Connection, cache: &SearchCache, id: i64, angle: f32) {
    let results = [(&target(conn, id), Outcome::Embedded(model_vector(angle)))];
    store_batch(conn, MODEL, &results).unwrap();
    cache.on_batch_stored(MODEL, &results);
}

fn open() -> Result<(), String> {
    Ok(())
}

fn text(cache: &SearchCache, conn: &Connection, scope: &SearchScope) -> SearchResults {
    search(cache, conn, active_model(), Query::Vector(&model_vector(0.0)), scope, None, open).unwrap()
}

fn result_ids(results: &SearchResults) -> Vec<i64> {
    ids(&results.results)
}

/// Text search on a scope, checking that its `pending` count is the one of get_semantic_stats (the scan's rule) for the same scope.
fn checked(cache: &SearchCache, conn: &Connection, scope: &SearchScope) -> SearchResults {
    let results = text(cache, conn, scope);
    let expected = stats(conn, scope.photo_ids.as_deref(), scope.folder.as_deref(), scope.recursive, scope.skip_raw).unwrap();
    assert_eq!(results.pending, expected.pending, "{scope:?}");
    results
}

#[test]
fn scopes_limit_the_results_and_count_the_photos_not_analysed() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let a = add_photo(&conn, r"C:\photos\a.jpg");
    let b = add_photo(&conn, r"C:\photos\2024\b.jpg");
    let c = add_photo(&conn, r"C:\photosbis\c.jpg");
    let raw = add_photo(&conn, r"C:\photos\d.cr2");
    add_photo(&conn, r"C:\photos\not-analysed.jpg");
    for (id, angle) in [(a, 0.3), (b, 0.1), (c, 0.0), (raw, 0.2)] { analyse(&conn, &cache, id, angle); }

    let folder = |recursive| SearchScope { folder: Some("C:/photos".into()), recursive, ..SearchScope::default() };
    let results = checked(&cache, &conn, &folder(false));
    assert_eq!((result_ids(&results), results.total, results.pending), (vec![raw, a], 3, 1));
    let results = checked(&cache, &conn, &folder(true));
    assert_eq!((result_ids(&results), results.total, results.pending), (vec![b, raw, a], 4, 1));
    let results = checked(&cache, &conn, &SearchScope { photo_ids: Some(vec![a, c]), ..SearchScope::default() });
    assert_eq!(result_ids(&results), vec![c, a]);
    let results = checked(&cache, &conn, &SearchScope::default());
    assert_eq!((result_ids(&results), results.total, results.pending, results.capped), (vec![c, b, raw, a], 5, 1, false));
    // Text results carry their probability, computed from their cosine.
    for hit in &results.results { assert_eq!(hit.prob, Some(probability(hit.cos, active_model()))); }
    assert_eq!(results.best, Some(results.results[0].cos));

    // A RAW file waiting for its analysis is not counted when RAW files are left out; analysed RAW files are still searched.
    let unanalysed_raw = add_photo(&conn, r"C:\photos\e.nef");
    let results = checked(&cache, &conn, &SearchScope { skip_raw: true, ..SearchScope::default() });
    assert_eq!((results.total, results.pending, results.results.len()), (6, 1, 4));
    let results = checked(&cache, &conn, &SearchScope::default());
    assert_eq!(results.pending, 2);
    let _ = unanalysed_raw;

    // A photo whose file changed since its analysis is still found (its embedding stays until the next analysis) and is pending.
    conn.execute("UPDATE photos SET modified = 2 WHERE id = ?1", [a]).unwrap();
    let results = checked(&cache, &conn, &SearchScope::default());
    assert_eq!((results.results.len(), results.pending), (4, 3));

    // Rows of a photo that left the catalogue are never returned, even before the clean-up.
    conn.execute("DELETE FROM photos WHERE id = ?1", [c]).unwrap();
    assert_eq!(result_ids(&checked(&cache, &conn, &SearchScope::default())), vec![b, raw, a]);

    // A photo that failed for its current version is not pending; once its file changes, it is again.
    let broken = add_photo(&conn, "C:/photos/broken.jpg");
    let pending = checked(&cache, &conn, &SearchScope::default()).pending;
    store_batch(&conn, MODEL, &[(&target(&conn, broken), Outcome::Failed("unreadable".into()))]).unwrap();
    assert_eq!(checked(&cache, &conn, &SearchScope::default()).pending, pending - 1);
    conn.execute("UPDATE photos SET modified = 9 WHERE id = ?1", [broken]).unwrap();
    assert_eq!(checked(&cache, &conn, &SearchScope::default()).pending, pending);
}

#[test]
fn image_search_leaves_the_query_photo_out() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let a = add_photo(&conn, "C:/photos/a.jpg");
    let b = add_photo(&conn, "C:/photos/b.jpg");
    let c = add_photo(&conn, "C:/photos/c.jpg");
    let d = add_photo(&conn, "C:/photos/d.jpg");
    for (id, angle) in [(a, 0.0), (b, 0.5), (c, 0.1)] { analyse(&conn, &cache, id, angle); }
    let results = search(&cache, &conn, active_model(), Query::Photo(a), &SearchScope::default(), None, open).unwrap();
    assert_eq!(result_ids(&results), vec![c, b]);
    assert_eq!(results.best, Some(results.results[0].cos));
    assert!(results.results.iter().all(|hit| hit.prob.is_none()));
    // With a relevance Δ: cosines 0.995 and 0.878, Δ = 0.03 keeps the first.
    let results = search(&cache, &conn, active_model(), Query::Photo(a), &SearchScope::default(), Some(0.03), open).unwrap();
    assert_eq!(result_ids(&results), vec![c]);
    // A photo without embedding cannot be the query.
    let error = search(&cache, &conn, active_model(), Query::Photo(d), &SearchScope::default(), None, open).unwrap_err();
    assert_eq!(error, PHOTO_NOT_ANALYSED_ERROR);
    // The query photo may be outside the scope.
    let scope = SearchScope { photo_ids: Some(vec![b, c]), ..SearchScope::default() };
    assert_eq!(result_ids(&search(&cache, &conn, active_model(), Query::Photo(a), &scope, None, open).unwrap()), vec![c, b]);
}

#[test]
fn the_index_follows_what_the_scan_writes() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let a = add_photo(&conn, "C:/photos/a.jpg");
    let b = add_photo(&conn, "C:/photos/b.jpg");
    let c = add_photo(&conn, "C:/photos/c.jpg");
    analyse(&conn, &cache, a, 0.5); // no index yet: nothing to update
    assert!(!cache.is_loaded());
    assert_eq!(result_ids(&text(&cache, &conn, &SearchScope::default())), vec![a]);
    assert_eq!(cache.loads.load(Ordering::Relaxed), 1);

    // A batch stored while the index is loaded updates it in place: new photo, photo analysed again, photo that now fails.
    analyse(&conn, &cache, b, 0.2);
    analyse(&conn, &cache, a, 0.0);
    assert_eq!(result_ids(&text(&cache, &conn, &SearchScope::default())), vec![a, b]);
    let failed = [(&target(&conn, b), Outcome::Failed("unreadable".into()))];
    store_batch(&conn, MODEL, &failed).unwrap();
    cache.on_batch_stored(MODEL, &failed);
    assert_eq!(result_ids(&text(&cache, &conn, &SearchScope::default())), vec![a]);
    assert_eq!(cache.loads.load(Ordering::Relaxed), 1, "updated in place, not reloaded");

    // A batch of another model only marks the index outdated: rebuilt from the database by the next search.
    let other = [(&target(&conn, c), Outcome::Embedded(model_vector(0.0)))];
    store_batch(&conn, MODEL, &other).unwrap();
    cache.on_batch_stored("other-model", &other);
    assert_eq!(result_ids(&text(&cache, &conn, &SearchScope::default())), vec![a, c]);
    assert_eq!(cache.loads.load(Ordering::Relaxed), 2);

    // Data deleted: the index is dropped, and the next search finds nothing.
    crate::semantic::delete_data(&conn).unwrap();
    cache.invalidate();
    assert!(!cache.is_loaded());
    assert_eq!(text(&cache, &conn, &SearchScope::default()).results, Vec::new());
}

#[test]
fn a_batch_stored_while_the_index_is_built_is_not_lost() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let a = add_photo(&conn, "C:/photos/a.jpg");
    let b = add_photo(&conn, "C:/photos/b.jpg");
    analyse(&conn, &cache, a, 0.0);
    // The build reads the rows, then a batch is stored and announced before the index is installed.
    let built = cache
        .with_index(
            active_model(),
            || {
                let index = Index::load(&conn, MODEL, active_model().embed_dim);
                analyse(&conn, &cache, b, 0.1);
                index
            },
            |index| index.len(),
        )
        .unwrap();
    assert_eq!(built, 1);
    // The installed index is outdated: the next search rebuilds it and finds b.
    assert_eq!(result_ids(&text(&cache, &conn, &SearchScope::default())), vec![a, b]);
    assert_eq!(cache.loads.load(Ordering::Relaxed), 2);
}

#[test]
fn damaged_rows_are_left_out_of_the_index() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let a = add_photo(&conn, "C:/photos/a.jpg");
    let b = add_photo(&conn, "C:/photos/b.jpg");
    conn.execute(
        "INSERT INTO photo_embeddings (photo_id, model_id, file_size, file_mtime, vec) VALUES (?1, ?2, 1, 1, ?3), (?4, ?2, 1, 1, ?5)",
        params![a, MODEL, vector_to_blob(&model_vector(0.0)), b, vec![0u8; 10]],
    )
    .unwrap();
    assert_eq!(Index::load(&conn, MODEL, active_model().embed_dim).unwrap().len(), 1);
}

#[test]
fn the_index_is_released_after_a_while_without_search() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(Duration::from_millis(300));
    let a = add_photo(&conn, "C:/photos/a.jpg");
    analyse(&conn, &cache, a, 0.0);
    cache.touch();
    text(&cache, &conn, &SearchScope::default());
    assert!(cache.is_loaded());
    // Searches more often than the delay keep it.
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(700) {
        cache.touch();
        std::thread::sleep(Duration::from_millis(50));
        assert!(cache.is_loaded(), "released while in use");
    }
    // Then idle: released once, and the task is no longer armed.
    let started = Instant::now();
    while cache.is_loaded() {
        assert!(started.elapsed() < Duration::from_secs(5), "never released");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(started.elapsed() >= Duration::from_millis(200), "released too early");
    while lock(&cache.timer).armed {
        assert!(started.elapsed() < Duration::from_secs(5), "task still armed");
        std::thread::sleep(Duration::from_millis(10));
    }
    // A new search loads it again and arms a new release.
    cache.touch();
    text(&cache, &conn, &SearchScope::default());
    assert!(cache.is_loaded() && lock(&cache.timer).armed);
    cache.release();
    assert!(!cache.is_loaded());
}

#[test]
fn disabling_or_deleting_releases_the_memory_and_the_scan_updates_the_index() {
    // The only test using the cache of the application (global state).
    let model = active_model();
    let cache = cache();
    let load = || -> Result<Index, String> {
        let mut index = Index::new(&model.id, model.embed_dim);
        index.upsert(1, &model_vector(0.0), (1, 1));
        Ok(index)
    };
    cache.with_index(model, load, |_| ()).unwrap();
    // Disabling the feature (set_semantic_enabled(false)) releases the index.
    crate::semantic::on_disabled();
    assert!(!cache.is_loaded());
    // A batch stored by a scan reaches the loaded index through the hook of the scan.
    cache.with_index(model, load, |_| ()).unwrap();
    let target = Target {
        photo_id: 2,
        path: "C:/photos/b.jpg".into(),
        size: 1,
        mtime: 1,
        standing: crate::semantic::Standing::Pending,
        stored_key: None,
        key: None,
    };
    on_batch_stored(&model.id, &[(&target, Outcome::Embedded(model_vector(0.1)))]);
    let loads = cache.loads.load(Ordering::Relaxed);
    assert_eq!(cache.with_index(model, || unreachable!("reloaded"), |index| index.len()).unwrap(), 2);
    assert_eq!(cache.loads.load(Ordering::Relaxed), loads);
    // Data deleted: dropped.
    invalidate();
    assert!(!cache.is_loaded());
    // Model deleted: no text query can hold the text model while the files are removed.
    without_text_model(|| assert!(cache.text.try_lock().is_err()));
    assert!(cache.text.try_lock().unwrap().is_none());
}

#[test]
fn searches_refuse_while_the_feature_is_disabled() {
    // The tests never enable the feature: the gate refuses before the index is built, and nothing stays in memory.
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let error = search(&cache, &conn, active_model(), Query::Vector(&model_vector(0.0)), &SearchScope::default(), None, ensure_enabled).unwrap_err();
    assert_eq!(error, "semantic_disabled");
    assert!(!cache.is_loaded());
}

// ---------------------------------------------------------------------------
// Speed (ignored: run in release)
// ---------------------------------------------------------------------------

#[test]
#[ignore = "speed measure on 100,000 synthetic vectors: run with --release --nocapture"]
fn speed_of_a_search_on_100000_photos() {
    let model = active_model();
    let dim = model.embed_dim;
    let count = 100_000;
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    };
    let mut random_vector = || {
        let mut vector: Vec<f32> = (0..dim).map(|_| next()).collect();
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        vector.iter_mut().for_each(|v| *v /= norm);
        vector
    };

    // Catalogue of 100,000 analysed photos in 100 folders.
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let started = Instant::now();
    let transaction = conn.unchecked_transaction().unwrap();
    for id in 0..count {
        let path = format!("C:/photos/{:03}/p{id}.jpg", id % 100);
        transaction
            .execute("INSERT INTO photos (path, filename, file_size, modified) VALUES (?1, ?2, 1, 1)", params![path, format!("p{id}.jpg")])
            .unwrap();
        let photo_id = transaction.last_insert_rowid();
        transaction
            .execute(
                "INSERT INTO photo_embeddings (photo_id, model_id, file_size, file_mtime, vec) VALUES (?1, ?2, 1, 1, ?3)",
                params![photo_id, MODEL, vector_to_blob(&random_vector())],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
    println!("catalogue of {count} photos written in {:?}", started.elapsed());

    let cache = SearchCache::new(IDLE_RELEASE);
    let query = random_vector();
    let started = Instant::now();
    let index = Index::load(&conn, MODEL, dim).unwrap();
    println!("index load from SQLite: {:?} ({} rows, {} MB)", started.elapsed(), index.len(), index.vectors.len() * 2 / 1_000_000);

    // Ranking alone, best of 10.
    let mut best_rank = Duration::MAX;
    for _ in 0..10 {
        let started = Instant::now();
        let ranking = index.rank(&query, ALL, MAX_RESULTS);
        best_rank = best_rank.min(started.elapsed());
        assert_eq!(ranking.hits.len(), MAX_RESULTS);
    }
    println!("ranking of {count} × {dim} (whole library, cap {MAX_RESULTS}): {best_rank:?} (best of 10)");
    drop(index);

    // Whole search: first one (builds the index), then the next ones (scope query + ranking).
    let started = Instant::now();
    text(&cache, &conn, &SearchScope::default());
    println!("first search, whole library (index built): {:?}", started.elapsed());
    for (label, scope) in [
        ("whole library", SearchScope::default()),
        ("one folder of 1,000 photos", SearchScope { folder: Some("C:/photos/042".into()), ..SearchScope::default() }),
    ] {
        let mut best = Duration::MAX;
        for _ in 0..5 {
            let started = Instant::now();
            let results = search(&cache, &conn, model, Query::Vector(&query), &scope, None, open).unwrap();
            best = best.min(started.elapsed());
            assert!(!results.results.is_empty());
        }
        println!("next searches, {label}: {best:?} (best of 5)");
    }
    assert!(best_rank < Duration::from_millis(60), "ranking took {best_rank:?}");
}

// ---------------------------------------------------------------------------
// Parity with the reference model (needs the model files)
// ---------------------------------------------------------------------------

fn reference() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/semantic_reference.json")).expect("semantic_reference.json")
}

fn floats(value: &serde_json::Value) -> Vec<f32> {
    value.as_array().expect("array").iter().map(|item| item.as_f64().expect("number") as f32).collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let dot: f64 = a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum();
    let norm = |v: &[f32]| v.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
    dot / (norm(a) * norm(b))
}

/// The text search computes the same embeddings as the reference model, and its scores against the reference images (stored as half
/// floats, as in the application) are the reference cosines. Tolerance: 1e-3, the error bound of a dot product of unit vectors when one of
/// them is rounded to half precision (relative error 2^-11 per component).
#[test]
#[ignore = "needs the SigLIP 2 model"]
fn text_search_scores_match_the_reference() {
    let model = active_model();
    let dir = semantic_model_dir();
    let reference = reference();
    let images: Vec<Vec<f32>> = reference["images"].as_array().unwrap().iter().map(|image| floats(&image["embedding"])).collect();
    let mut index = Index::new(&model.id, model.embed_dim);
    for (id, embedding) in images.iter().enumerate() { index.upsert(id as i64, embedding, (1, 1)); }

    let cache = SearchCache::new(IDLE_RELEASE);
    let load = || {
        let environment = crate::onnx_runtime::environment(&onnx_runtime_library())?;
        TextEncoder::load(&environment, &dir.join("text.onnx"), &dir.join("tokenizer.json"), model, text_threads())
    };
    let started = Instant::now();
    cache.embed_text(load, "warm-up").expect("text encoder");
    println!("text encoder loaded in {:?} (tokenizer and model in parallel)", started.elapsed());

    for text in reference["texts"].as_array().unwrap() {
        let fed = prepare_query(text["raw"].as_str().unwrap(), model).expect("query");
        assert_eq!(fed, text["fed"].as_str().unwrap());
        let started = Instant::now();
        let vector = cache.embed_text(|| unreachable!("already loaded"), &fed).expect("embedding");
        let elapsed = started.elapsed();
        let expected = floats(&text["embedding"]);
        let similarity = cosine(&vector, &expected);
        assert!(similarity >= 0.999, "{fed:?}: cos = {similarity}");
        let ranking = index.rank(&vector, ALL, 10);
        assert_eq!(ranking.hits.len(), images.len());
        for hit in &ranking.hits {
            let reference_cos = cosine(&expected, &images[hit.photo_id as usize]);
            assert!((hit.cos as f64 - reference_cos).abs() <= 1e-3, "{fed:?} / image {}: {} vs {reference_cos}", hit.photo_id, hit.cos);
        }
        println!("{fed:?}: cos with the reference {similarity:.6}, encoded in {elapsed:?}, best image {} ({:.4})", ranking.hits[0].photo_id, ranking.hits[0].cos);
    }
    // §15.7: the red disc (image 2) is the best match of "a red circle".
    let vector = cache.embed_text(|| unreachable!(), &prepare_query("a red circle", model).unwrap()).unwrap();
    assert_eq!(index.rank(&vector, ALL, 1).hits[0].photo_id, 2);
    // Released with the index: the encoder is loaded again by the next query.
    cache.release();
    assert!(lock(&cache.text).is_none());
}
