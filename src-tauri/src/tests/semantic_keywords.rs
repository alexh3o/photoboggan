//! Tests of the keyword suggestions: scores, thresholds, exclusions, invalidation, gating. Fake vectors only, no model.
//!
//! The measure that chose the score and the thresholds (§23) reads a copy of a real catalogue and needs the model; it is ignored and never
//! runs in CI. Run it in release mode (it scores every photo against every keyword):
//!   SEMANTIC_CATALOG=<copy of photos_library.db> SEMANTIC_MODEL_DIR=<model folder> \
//!   cargo test --release semantic_keywords::tests::measure -- --ignored --nocapture
//! Never point SEMANTIC_CATALOG at the catalogue of the application: copy it (with its -wal and -shm files) first. It is opened read-only.
//! The speed measure on 100,000 synthetic photos is ignored too: `cargo test --release semantic_keywords::tests::speed -- --ignored --nocapture`.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OpenFlags};

use super::*;
use crate::semantic::{blob_to_vector, normalise_query, select_targets, store_batch, Outcome, TextEncoder};
use crate::semantic_search::{Hit, IDLE_RELEASE};
use crate::test_support::{insert_photo, onnx_runtime_library, semantic_model_dir, temp_catalog};

const MODEL: &str = "siglip2-base-p16-224";

/// Unit vector of the model size in the plane of its two first axes: its cosine with `model_vector(0.0)` is cos(angle).
fn model_vector(angle: f32) -> Vec<f32> {
    let mut vector = vec![0f32; active_model().embed_dim];
    vector[0] = angle.cos();
    vector[1] = angle.sin();
    vector
}

/// Unit vector along axis `axis` (cosine 0 with the vectors of other axes).
fn axis_vector(axis: usize) -> Vec<f32> {
    let mut vector = vec![0f32; active_model().embed_dim];
    vector[axis] = 1.0;
    vector
}

fn add_photo(conn: &Connection, path: &str) -> i64 {
    let id = insert_photo(conn, path);
    conn.execute("UPDATE photos SET file_size = 1, modified = 1 WHERE id = ?1", [id]).unwrap();
    id
}

/// Stores the embedding of a photo, as a scan does, and tells the cache.
fn analyse(conn: &Connection, cache: &SearchCache, id: i64, vector: Vec<f32>) {
    let target = select_targets(conn, MODEL, Some(&[id]), None, false).unwrap().pop().unwrap();
    let results = [(&target, Outcome::Embedded(vector))];
    store_batch(conn, MODEL, &results).unwrap();
    cache.on_batch_stored(MODEL, &results);
}

/// Photo analysed with `vector`.
fn photo(conn: &Connection, cache: &SearchCache, name: &str, vector: Vec<f32>) -> i64 {
    let id = add_photo(conn, &format!("C:/photos/{name}.jpg"));
    analyse(conn, cache, id, vector);
    id
}

/// Keyword `name` under `parent` (0: first level).
fn keyword(conn: &Connection, parent: i64, name: &str) -> i64 {
    crate::keywords::ensure_node(conn, parent, name).unwrap()
}

/// Tags the photos with the keyword, as a file read does (the suggestions are told).
fn tag(conn: &Connection, keyword_id: i64, photos: &[i64]) {
    for photo in photos { conn.execute("INSERT OR IGNORE INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo, keyword_id]).unwrap(); }
    on_keywords_changed();
}

fn open() -> Result<(), String> {
    Ok(())
}

/// The text score must not be needed.
fn no_text(_: &str) -> Result<Vec<f32>, String> {
    panic!("the name should not be encoded")
}

fn hit_ids(hits: &[Hit]) -> Vec<i64> {
    hits.iter().map(|hit| hit.photo_id).collect()
}

fn suggested(found: &PhotoSuggestions) -> Vec<i64> {
    found.suggestions.iter().map(|suggestion| suggestion.keyword_id).collect()
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

#[test]
fn nearest_mean_and_spread_of_the_examples() {
    let values = [0.1f32, 0.9, 0.5, 0.7, 0.3, 0.8];
    assert!((mean_of_nearest(values.iter().copied(), 5).unwrap() - (0.9 + 0.8 + 0.7 + 0.5 + 0.3) / 5.0).abs() < 1e-6);
    assert!((mean_of_nearest(values.iter().copied(), 2).unwrap() - 0.85).abs() < 1e-6);
    // Fewer values than k: all of them.
    assert!((mean_of_nearest([0.4f32, 0.6].into_iter(), 5).unwrap() - 0.5).abs() < 1e-6);
    assert_eq!(mean_of_nearest(std::iter::empty(), 5), None);
    assert_eq!(spread(&[1, 2, 3], 5), vec![1, 2, 3]);
    assert_eq!(spread(&(0..10).collect::<Vec<i64>>(), 4), vec![0, 2, 5, 7]);
}

#[test]
fn the_examples_score_is_the_mean_of_the_nearest_examples_not_the_centroid() {
    // Six examples: four along x, two along z. A photo along z is as close to its keyword as a photo along x would be to the centroid's side,
    // which the centroid (mostly x) would miss.
    let model = active_model();
    let examples: Vec<Vec<f32>> = vec![axis_vector(0), axis_vector(0), axis_vector(0), axis_vector(0), axis_vector(2), axis_vector(2)];
    let mut index = Index::new(&model.id, model.embed_dim);
    index.upsert(1, &axis_vector(0), (1, 1));
    index.upsert(2, &axis_vector(2), (1, 1));
    index.upsert(3, &axis_vector(5), (1, 1));
    index.upsert(4, &model_vector(0.5), (1, 1));
    let ranking = index.rank_nearest(&examples, &|id| id != 4, 10);
    assert_eq!(hit_ids(&ranking.hits), vec![1, 2, 3]);
    // Photo 1: the five nearest are four x (1.0) and one z (0.0): 0.8. Photo 2: two z (1.0) and three x (0.0): 0.4. Photo 3: nothing.
    let scores: Vec<f32> = ranking.hits.iter().map(|hit| hit.cos).collect();
    assert!((scores[0] - 0.8).abs() < 1e-3 && (scores[1] - 0.4).abs() < 1e-3 && scores[2].abs() < 1e-3, "{scores:?}");
    assert!(ranking.hits.iter().all(|hit| hit.prob.is_none()));
    // The centroid would put photo 2 at cos((0,0,1), (2,0,1)/√5) = 0.447 and photo 1 at 0.894: same order here, but the nearest score
    // does not depend on how many examples sit elsewhere once a cluster has 5 of them.
    let more: Vec<Vec<f32>> = (0..20).map(|_| axis_vector(0)).chain((0..5).map(|_| axis_vector(2))).collect();
    let ranking = index.rank_nearest(&more, &|id| id == 2, 10);
    assert!((ranking.hits[0].cos - 1.0).abs() < 1e-3, "a full cluster of 5 gives the full score");
}

#[test]
fn the_candidate_threshold_follows_the_spread_of_the_examples() {
    // Five examples at angles 0, 0.1, 0.2, 0.3 and 1.0: each against the four others (mean of all four, fewer than NEAREST).
    let angles = [0.0f32, 0.1, 0.2, 0.3, 1.0];
    let examples: Vec<Vec<f32>> = angles.iter().map(|&angle| model_vector(angle)).collect();
    let mut own: Vec<f32> = angles
        .iter()
        .map(|&a| angles.iter().filter(|&&b| b != a).map(|&b| (a - b).cos()).sum::<f32>() / 4.0)
        .collect();
    own.sort_by(|a, b| a.total_cmp(b));
    // q = 0.1 of five values: the first one (nearest rank), here the outlier at 1.0; q = 0.5: the median.
    assert!((own_threshold(&examples, 0.1).unwrap() - own[0]).abs() < 1e-5);
    assert!((own_threshold(&examples, 0.5).unwrap() - own[2]).abs() < 1e-5);
    assert_eq!(own_threshold(&examples[..1], 0.1), None);
}

// ---------------------------------------------------------------------------
// Keyword → photos
// ---------------------------------------------------------------------------

#[test]
fn candidates_by_examples_leave_out_tagged_and_dismissed_photos() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let model = active_model();
    // Examples at angles 0 to 0.4: each scores ~0.963 against the others at worst (the threshold); a photo at 0.2 scores 0.990, at
    // 0.35 0.979, at 1.2 ~0.4.
    let vectors: Vec<Vec<f32>> = (0..5).map(|i| model_vector(0.1 * i as f32)).collect();
    let examples: Vec<i64> = vectors.iter().enumerate().map(|(i, vector)| photo(&conn, &cache, &format!("tagged{i}"), vector.clone())).collect();
    let close = photo(&conn, &cache, "close", model_vector(0.2));
    let dismissed = photo(&conn, &cache, "dismissed", model_vector(0.2));
    let far = photo(&conn, &cache, "far", model_vector(1.2));
    let other_folder = add_photo(&conn, "C:/other/close.jpg");
    analyse(&conn, &cache, other_folder, model_vector(0.35));
    add_photo(&conn, "C:/photos/not-analysed.jpg");
    let sea = keyword(&conn, 0, "Sea");
    tag(&conn, sea, &examples);
    assert_eq!(reject(&conn, &[dismissed], sea).unwrap(), 1);

    let found = keyword_candidates(&cache, &conn, model, sea, &SearchScope::default(), &mut no_text, open).unwrap();
    assert_eq!((found.kind, found.examples), (ScoreKind::Examples, 5));
    assert!((found.threshold - own_threshold(&vectors, CANDIDATE_QUANTILE).unwrap()).abs() < 1e-3);
    assert!((found.threshold - 0.963).abs() < 2e-3, "{}", found.threshold);
    assert_eq!(hit_ids(&found.search.results), vec![close, other_folder], "the far photo is under the threshold");
    assert_eq!(found.search.best, Some(found.search.results[0].cos));
    assert!(found.search.results.iter().all(|hit| hit.prob.is_none() && hit.cos >= found.threshold));
    // `total` and `pending` describe the scope, excluded photos included.
    assert_eq!((found.search.total, found.search.pending), (10, 1));
    // A folder scope.
    let scope = SearchScope { folder: Some("C:/photos".into()), ..SearchScope::default() };
    let found = keyword_candidates(&cache, &conn, model, sea, &scope, &mut no_text, open).unwrap();
    assert_eq!(hit_ids(&found.search.results), vec![close]);
    let _ = far;
}

#[test]
fn a_keyword_with_fewer_than_five_analysed_photos_is_matched_by_its_name() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let model = active_model();
    let tagged: Vec<i64> = (0..4).map(|i| photo(&conn, &cache, &format!("tagged{i}"), model_vector(0.0))).collect();
    let fifth = add_photo(&conn, "C:/photos/tagged-not-analysed.jpg");
    // Text cosines: 0.5 (kept), 0.08 (kept), 0.05 (under the text threshold).
    let half = photo(&conn, &cache, "half", model_vector(0.5f32.acos()));
    let low = photo(&conn, &cache, "low", model_vector(0.08f32.acos()));
    photo(&conn, &cache, "weak", model_vector(0.05f32.acos()));
    let place = keyword(&conn, 0, "Places");
    let beach = keyword(&conn, place, "Sandy  Beach");
    let mut all = tagged.clone();
    all.push(fifth);
    tag(&conn, beach, &all);

    let mut fed: Vec<String> = Vec::new();
    let mut embed = |text: &str| {
        fed.push(text.to_string());
        Ok(model_vector(0.0))
    };
    let found = keyword_candidates(&cache, &conn, model, beach, &SearchScope::default(), &mut embed, open).unwrap();
    assert_eq!((found.kind, found.examples, found.threshold), (ScoreKind::Text, 4, TEXT_THRESHOLD));
    // The leaf name alone, normalised as a text query (§23.2: the parent name does not help).
    assert_eq!(fed, vec!["this is a photo of sandy beach.".to_string()]);
    assert_eq!(hit_ids(&found.search.results), vec![half, low]);
    for hit in &found.search.results { assert_eq!(hit.prob, Some(crate::semantic_search::probability(hit.cos, model))); }

    // The name is read at each request: a renamed keyword is encoded under its new name.
    conn.execute("UPDATE keyword_nodes SET name = 'Shore' WHERE id = ?1", [beach]).unwrap();
    fed.clear();
    let mut embed = |text: &str| {
        fed.push(text.to_string());
        Ok(model_vector(0.0))
    };
    keyword_candidates(&cache, &conn, model, beach, &SearchScope::default(), &mut embed, open).unwrap();
    assert_eq!(fed, vec!["this is a photo of shore.".to_string()]);

    // Once the fifth tagged photo is analysed, its examples are used and the name is no longer encoded.
    analyse(&conn, &cache, fifth, model_vector(0.0));
    let found = keyword_candidates(&cache, &conn, model, beach, &SearchScope::default(), &mut no_text, open).unwrap();
    assert_eq!((found.kind, found.examples), (ScoreKind::Examples, 5));
}

#[test]
fn candidates_errors_and_gating() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let model = active_model();
    let error = keyword_candidates(&cache, &conn, model, 999, &SearchScope::default(), &mut no_text, open).unwrap_err();
    assert_eq!(error, UNKNOWN_KEYWORD_ERROR);
    // Feature disabled (the tests never enable it): refused before the index is built, nothing kept in memory.
    let sea = keyword(&conn, 0, "Sea");
    let error = keyword_candidates(&cache, &conn, model, sea, &SearchScope::default(), &mut no_text, ensure_enabled).unwrap_err();
    assert_eq!(error, "semantic_disabled");
    assert!(!cache.is_loaded());
    // A name with nothing to encode.
    let odd = keyword(&conn, 0, "?!");
    photo(&conn, &cache, "a", model_vector(0.0));
    let error = keyword_candidates(&cache, &conn, model, odd, &SearchScope::default(), &mut no_text, open).unwrap_err();
    assert_eq!(error, crate::semantic_search::EMPTY_QUERY_ERROR);
}

// ---------------------------------------------------------------------------
// Photo → keywords
// ---------------------------------------------------------------------------

/// Five photos analysed near `angle` and tagged with a new leaf `name` under `parent`.
fn tagged_leaf(conn: &Connection, cache: &SearchCache, parent: i64, name: &str, angle: f32) -> i64 {
    let id = keyword(conn, parent, name);
    let photos: Vec<i64> = (0..5).map(|i| photo(conn, cache, &format!("{name}{i}"), model_vector(angle + 0.01 * i as f32))).collect();
    tag(conn, id, &photos);
    id
}

#[test]
fn suggestions_of_a_photo_keep_eligible_leaves_above_the_threshold() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let model = active_model();
    let nature = keyword(&conn, 0, "Nature");
    let sea = tagged_leaf(&conn, &cache, nature, "sea", 0.0);
    let mountain = tagged_leaf(&conn, &cache, nature, "mountain", 1.2); // cos ≈ 0.36 with the query: under the threshold
    // A leaf with four photos only, a parent tagged directly, the keyword of a person: never suggested.
    let few = keyword(&conn, 0, "few");
    let few_photos: Vec<i64> = (0..4).map(|i| photo(&conn, &cache, &format!("few{i}"), model_vector(0.0))).collect();
    tag(&conn, few, &few_photos);
    let all: Vec<i64> = (0..6).map(|i| photo(&conn, &cache, &format!("nature{i}"), model_vector(0.0))).collect();
    tag(&conn, nature, &all);
    let alice = tagged_leaf(&conn, &cache, 0, "Alice", 0.0);
    conn.execute("INSERT INTO persons (name, name_key, keyword_node_id) VALUES ('Alice', 'alice', ?1)", [alice]).unwrap();

    let query = photo(&conn, &cache, "query", model_vector(0.02));
    let found = photo_suggestions(&cache, &conn, model, query, open).unwrap();
    assert_eq!(suggested(&found), vec![sea]);
    assert_eq!(found.eligible, 3, "sea, mountain and the person's keyword have five analysed photos");
    let suggestion = &found.suggestions[0];
    assert_eq!(suggestion.examples, 5);
    assert!(suggestion.score >= SUGGESTION_THRESHOLD && suggestion.score <= 1.001, "{}", suggestion.score); // half floats: may pass 1 slightly
    let _ = mountain;

    // Dismissed: no longer suggested for this photo, still for another one.
    assert_eq!(reject(&conn, &[query], sea).unwrap(), 1);
    assert!(photo_suggestions(&cache, &conn, model, query, open).unwrap().suggestions.is_empty());
    let other = photo(&conn, &cache, "other", model_vector(0.03));
    assert_eq!(suggested(&photo_suggestions(&cache, &conn, model, other, open).unwrap()), vec![sea]);
    // Carried: not suggested either.
    tag(&conn, sea, &[other]);
    assert!(photo_suggestions(&cache, &conn, model, other, open).unwrap().suggestions.is_empty());

    // A photo without embedding, or not in the catalogue.
    let pending = add_photo(&conn, "C:/photos/pending.jpg");
    assert_eq!(photo_suggestions(&cache, &conn, model, pending, open).unwrap_err(), PHOTO_NOT_ANALYSED_ERROR);
    assert_eq!(photo_suggestions(&cache, &conn, model, 9999, open).unwrap_err(), PHOTO_NOT_ANALYSED_ERROR);
}

#[test]
fn at_most_five_suggestions_best_first() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let model = active_model();
    // Seven leaves, the further from the query the later they are created.
    let leaves: Vec<i64> = (0..7).map(|i| tagged_leaf(&conn, &cache, 0, &format!("leaf{i}"), 0.05 * i as f32)).collect();
    let query = photo(&conn, &cache, "query", model_vector(0.0));
    let found = photo_suggestions(&cache, &conn, model, query, open).unwrap();
    assert_eq!(suggested(&found), leaves[..5].to_vec());
    assert!(found.suggestions.windows(2).all(|pair| pair[0].score >= pair[1].score));
}

#[test]
fn a_model_built_during_a_keyword_write_is_not_kept_after_its_commit() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let writer = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let model = active_model();
    let sea = keyword(&conn, 0, "sea");
    let photos: Vec<i64> = (0..4).map(|i| photo(&conn, &cache, &format!("sea{i}"), model_vector(0.0))).collect();
    tag(&conn, sea, &photos);
    photo(&conn, &cache, "sea4", model_vector(0.0));
    let query = photo(&conn, &cache, "query", model_vector(0.01));
    let fifth_link = [("C:/photos/sea4.jpg".to_string(), vec![vec!["sea".to_string()]])];

    // The write inside the transaction announces nothing (the generation is global: other tests may bump it, so a few attempts; an
    // announcement before the commit would fail every one of them).
    let quiet = (0..20).any(|_| {
        writer.execute_batch("BEGIN").unwrap();
        let before = keywords_generation();
        crate::keywords::store_photo_keywords_in(&writer, &fifth_link).unwrap();
        let after = keywords_generation();
        writer.execute_batch("ROLLBACK").unwrap();
        before == after
    });
    assert!(quiet, "the generation changed before the commit");

    // A file read stores a fifth link in its transaction; a request builds the model before the commit (it reads the old links).
    writer.execute_batch("BEGIN").unwrap();
    crate::keywords::store_photo_keywords_in(&writer, &fifth_link).unwrap();
    assert!(photo_suggestions(&cache, &conn, model, query, open).unwrap().suggestions.is_empty());
    writer.execute_batch("COMMIT").unwrap();
    on_keywords_changed(); // what the callers of store_photo_keywords_in do after their commit
    assert_eq!(suggested(&photo_suggestions(&cache, &conn, model, query, open).unwrap()), vec![sea], "the model of the old links was kept");
}

#[test]
fn suggestions_follow_the_keywords_and_the_analysis() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let model = active_model();
    let sea = keyword(&conn, 0, "sea");
    let photos: Vec<i64> = (0..4).map(|i| photo(&conn, &cache, &format!("sea{i}"), model_vector(0.0))).collect();
    tag(&conn, sea, &photos);
    let query = photo(&conn, &cache, "query", model_vector(0.01));
    assert!(photo_suggestions(&cache, &conn, model, query, open).unwrap().suggestions.is_empty());
    assert!(cache.suggestions().is_some(), "kept with the index");

    // A fifth photo tagged (a file read or written): the keyword becomes eligible.
    let fifth = photo(&conn, &cache, "sea4", model_vector(0.0));
    crate::keywords::store_photo_keywords(&conn, &[("C:/photos/sea4.jpg".to_string(), vec![vec!["sea".to_string()]])]);
    assert_eq!(suggested(&photo_suggestions(&cache, &conn, model, query, open).unwrap()), vec![sea]);

    // The analysis changes a tagged photo (new embedding far away): the model follows the index.
    for &id in &photos[..2] { analyse(&conn, &cache, id, model_vector(1.5)); }
    let found = photo_suggestions(&cache, &conn, model, query, open).unwrap();
    assert!(found.suggestions.is_empty(), "mean of 3 close and 2 far photos is under the threshold: {found:?}");
    for &id in &photos[..2] { analyse(&conn, &cache, id, model_vector(0.0)); }
    assert_eq!(suggested(&photo_suggestions(&cache, &conn, model, query, open).unwrap()), vec![sea]);

    // A child created under the keyword: it is no longer a leaf.
    keyword(&conn, sea, "north sea");
    on_keywords_changed(); // create_keyword does this (ensure_node does not)
    assert!(photo_suggestions(&cache, &conn, model, query, open).unwrap().suggestions.is_empty());

    // Deleted keyword: neither suggested nor kept in the dismissed suggestions.
    let lake = tagged_leaf(&conn, &cache, 0, "lake", 0.0);
    reject(&conn, &[fifth], lake).unwrap();
    assert_eq!(suggested(&photo_suggestions(&cache, &conn, model, query, open).unwrap()), vec![lake]);
    crate::keywords::delete_subtree(&pool, lake).unwrap();
    assert!(photo_suggestions(&cache, &conn, model, query, open).unwrap().suggestions.is_empty());
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM keyword_suggestion_rejections WHERE keyword_id = ?1", [lake], |row| row.get(0)).unwrap();
    assert_eq!(left, 0);

    // Data deleted, idle release: the model goes with the index.
    crate::semantic::delete_data(&conn).unwrap();
    cache.invalidate();
    assert!(cache.suggestions().is_none());
    assert_eq!(photo_suggestions(&cache, &conn, model, query, open).unwrap_err(), PHOTO_NOT_ANALYSED_ERROR);
    analyse(&conn, &cache, query, model_vector(0.0));
    photo_suggestions(&cache, &conn, model, query, open).unwrap();
    cache.release();
    assert!(cache.suggestions().is_none() && !cache.is_loaded());
}

#[test]
fn suggestions_refuse_while_the_feature_is_disabled() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let cache = SearchCache::new(IDLE_RELEASE);
    let id = add_photo(&conn, "C:/photos/a.jpg");
    assert_eq!(photo_suggestions(&cache, &conn, active_model(), id, ensure_enabled).unwrap_err(), "semantic_disabled");
    assert!(!cache.is_loaded() && cache.suggestions().is_none());
    assert_eq!(ensure_enabled().unwrap_err(), "semantic_disabled", "every command checks this first");
}

#[test]
fn dismissed_suggestions_are_recorded_once() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let a = add_photo(&conn, "C:/photos/a.jpg");
    let b = add_photo(&conn, "C:/photos/b.jpg");
    let sea = keyword(&conn, 0, "sea");
    assert_eq!(reject(&conn, &[a, b, 999], sea).unwrap(), 2, "a photo outside the catalogue is ignored");
    assert_eq!(reject(&conn, &[a], sea).unwrap(), 0);
    assert_eq!(reject(&conn, &[a], 999).unwrap_err(), UNKNOWN_KEYWORD_ERROR);
    crate::semantic::delete_data(&conn).unwrap();
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM keyword_suggestion_rejections", [], |row| row.get(0)).unwrap();
    assert_eq!(left, 0, "deleted with the analysis data");
}

// ---------------------------------------------------------------------------
// Speed (ignored: run in release)
// ---------------------------------------------------------------------------

#[test]
#[ignore = "speed measure on 100,000 synthetic photos and 5,000 keywords: run with --release --nocapture"]
fn speed_of_the_suggestions_on_100000_photos() {
    let model = active_model();
    let dim = model.embed_dim;
    let (photos, keywords, per_photo) = (100_000usize, 5_000usize, 7usize);
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let started = Instant::now();
    let transaction = conn.unchecked_transaction().unwrap();
    for k in 0..keywords {
        transaction.execute("INSERT INTO keyword_nodes (parent_id, name, name_key) VALUES (0, ?1, ?1)", params![format!("k{k}")]).unwrap();
    }
    for id in 0..photos {
        let path = format!("C:/photos/{:03}/p{id}.jpg", id % 100);
        transaction.execute("INSERT INTO photos (path, filename, file_size, modified) VALUES (?1, ?2, 1, 1)", params![path, format!("p{id}.jpg")]).unwrap();
        let photo_id = transaction.last_insert_rowid();
        let mut vector: Vec<f32> = (0..dim).map(|_| (next() >> 40) as f32 / (1u64 << 24) as f32 - 0.5).collect();
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        vector.iter_mut().for_each(|v| *v /= norm);
        transaction
            .execute(
                "INSERT INTO photo_embeddings (photo_id, model_id, file_size, file_mtime, vec) VALUES (?1, ?2, 1, 1, ?3)",
                params![photo_id, MODEL, crate::semantic::vector_to_blob(&vector)],
            )
            .unwrap();
        // Keywords drawn with a skewed distribution: a few keywords carried by thousands of photos, most by a handful.
        for _ in 0..per_photo {
            let draw = (next() % 1_000_000) as f64 / 1_000_000.0;
            let keyword_id = 1 + ((draw * draw * draw) * keywords as f64) as i64;
            transaction.execute("INSERT OR IGNORE INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo_id, keyword_id]).unwrap();
        }
    }
    transaction.commit().unwrap();
    println!("catalogue of {photos} photos, {keywords} keywords, ~{per_photo} per photo written in {:?}", started.elapsed());

    let cache = SearchCache::new(IDLE_RELEASE);
    let started = Instant::now();
    let found = photo_suggestions(&cache, &conn, model, 42, open).unwrap();
    println!("first suggestions (index built, then the suggestion model): {:?}, {} eligible keywords", started.elapsed(), found.eligible);
    // Model alone, rebuilt on the loaded index.
    on_keywords_changed();
    let started = Instant::now();
    photo_suggestions(&cache, &conn, model, 43, open).unwrap();
    println!("suggestions after a keyword change (model rebuilt): {:?}", started.elapsed());
    let mut best = Duration::MAX;
    for id in 100..120 {
        let started = Instant::now();
        photo_suggestions(&cache, &conn, model, id, open).unwrap();
        best = best.min(started.elapsed());
    }
    println!("next suggestions: {best:?} (best of 20)");

    // Keyword → photos: the most carried keyword (examples capped at MAX_EXAMPLES) and a small one.
    for keyword_id in [1i64, 4_000] {
        let started = Instant::now();
        let found = keyword_candidates(&cache, &conn, model, keyword_id, &SearchScope::default(), &mut no_text, open).unwrap();
        println!(
            "candidates of a keyword with {} analysed photos: {:?} ({} results, kind {:?})",
            found.examples,
            started.elapsed(),
            found.search.results.len(),
            found.kind
        );
    }
    assert!(best < Duration::from_millis(40), "suggestions took {best:?}");
}

// ---------------------------------------------------------------------------
// Measure on a copy of a real catalogue (ignored)
// ---------------------------------------------------------------------------

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// A leaf of the keyword tree, with the analysed photos that carry it (indices into `Real::vectors`).
struct Leaf {
    name: String,
    parent: Option<String>,
    tagged: Vec<usize>,
}

struct Real {
    vectors: Vec<Vec<f32>>,
    /// Cosines between every pair of analysed photos (n × n).
    gram: Vec<f32>,
    leaves: Vec<Leaf>,
    /// Leaves carried by each analysed photo.
    by_photo: Vec<Vec<usize>>,
}

impl Real {
    fn g(&self, a: usize, b: usize) -> f32 {
        self.gram[a * self.vectors.len() + b]
    }
}

fn load_real(conn: &Connection) -> Real {
    let model = active_model();
    let mut ids: Vec<i64> = Vec::new();
    let mut vectors: Vec<Vec<f32>> = Vec::new();
    {
        let mut statement = conn
            .prepare("SELECT photo_id, vec FROM photo_embeddings WHERE model_id = ?1 AND photo_id IN (SELECT id FROM photos) ORDER BY photo_id")
            .unwrap();
        let mut rows = statement.query(params![model.id]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let blob: Vec<u8> = row.get(1).unwrap();
            if let Some(vector) = blob_to_vector(&blob, model.embed_dim) {
                ids.push(row.get(0).unwrap());
                vectors.push(vector);
            }
        }
    }
    let position: HashMap<i64, usize> = ids.iter().enumerate().map(|(index, id)| (*id, index)).collect();
    let nodes: Vec<(i64, i64, String)> = conn
        .prepare("SELECT id, parent_id, name FROM keyword_nodes")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let names: HashMap<i64, String> = nodes.iter().map(|(id, _, name)| (*id, name.clone())).collect();
    let parents: HashSet<i64> = nodes.iter().map(|(_, parent, _)| *parent).collect();
    let persons: HashSet<i64> = conn
        .prepare("SELECT keyword_node_id FROM persons WHERE keyword_node_id IS NOT NULL")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let mut leaf_of: HashMap<i64, usize> = HashMap::new();
    let mut leaves: Vec<Leaf> = Vec::new();
    for (id, parent, name) in &nodes {
        if parents.contains(id) || persons.contains(id) { continue; }
        leaf_of.insert(*id, leaves.len());
        leaves.push(Leaf { name: name.clone(), parent: names.get(parent).cloned(), tagged: Vec::new() });
    }
    let mut by_photo: Vec<Vec<usize>> = vec![Vec::new(); vectors.len()];
    let pairs: Vec<(i64, i64)> =
        conn.prepare("SELECT keyword_id, photo_id FROM photo_keywords").unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(Result::unwrap).collect();
    for (keyword, photo) in pairs {
        if let (Some(&leaf), Some(&photo)) = (leaf_of.get(&keyword), position.get(&photo)) {
            leaves[leaf].tagged.push(photo);
            by_photo[photo].push(leaf);
        }
    }
    let n = vectors.len();
    let gram: Vec<f32> = (0..n).into_par_iter().flat_map_iter(|a| (0..n).map(|b| dot(&vectors[a], &vectors[b])).collect::<Vec<_>>()).collect();
    Real { vectors, gram, leaves, by_photo }
}

/// Average precision of a ranking (true = a positive), over `positives` positives.
fn average_precision(ranked: &[bool], positives: usize) -> f64 {
    if positives == 0 { return 0.0; }
    let mut found = 0usize;
    let mut sum = 0f64;
    for (rank, positive) in ranked.iter().enumerate() {
        if *positive {
            found += 1;
            sum += found as f64 / (rank + 1) as f64;
        }
    }
    sum / positives as f64
}

/// Ranking quality of one query: average precision, precision of the first 10, precision at the number of positives (R-precision).
#[derive(Default, Clone, Copy)]
struct Quality {
    ap: f64,
    p10: f64,
    r_precision: f64,
}

fn quality(scored: &mut [(f32, bool)], positives: usize) -> Quality {
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let ranked: Vec<bool> = scored.iter().map(|(_, positive)| *positive).collect();
    let hits = |count: usize| ranked.iter().take(count).filter(|positive| **positive).count() as f64;
    Quality {
        ap: average_precision(&ranked, positives),
        p10: hits(10) / 10f64.min(ranked.len() as f64).max(1.0),
        r_precision: hits(positives) / positives.max(1) as f64,
    }
}

fn mean(values: &[Quality]) -> Quality {
    let count = values.len().max(1) as f64;
    Quality {
        ap: values.iter().map(|q| q.ap).sum::<f64>() / count,
        p10: values.iter().map(|q| q.p10).sum::<f64>() / count,
        r_precision: values.iter().map(|q| q.r_precision).sum::<f64>() / count,
    }
}

fn print_quality(label: &str, values: &[Quality]) {
    let m = mean(values);
    println!("  {label:<46} n={:<4} MAP {:.3}  P@10 {:.3}  R-prec {:.3}", values.len(), m.ap, m.p10, m.r_precision);
}

/// Precision and recall of "score ≥ t" over pooled (score, positive) pairs; `queries`: to show the mean count above t per query.
fn print_sweep(label: &str, pairs: &[(f32, bool)], thresholds: &[f32], queries: usize) {
    let positives = pairs.iter().filter(|(_, positive)| *positive).count().max(1);
    println!("  {label} ({} pairs, {positives} positives)", pairs.len());
    for &threshold in thresholds {
        let above: Vec<&(f32, bool)> = pairs.iter().filter(|(score, _)| *score >= threshold).collect();
        let hits = above.iter().filter(|(_, positive)| *positive).count();
        println!(
            "    t={threshold:>6.3}  precision {:.3}  recall {:.3}  above per query {:.2}",
            hits as f64 / above.len().max(1) as f64,
            hits as f64 / positives as f64,
            above.len() as f64 / queries.max(1) as f64
        );
    }
}

fn percentile(sorted: &[f32], q: f64) -> f32 {
    if sorted.is_empty() { return f32::NAN; }
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

/// Deterministic shuffle of the tagged photos of a keyword (by a hash of the photo index).
fn shuffled(tagged: &[usize]) -> Vec<usize> {
    let mut order = tagged.to_vec();
    order.sort_by_key(|&photo| (photo as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15).rotate_left(17));
    order
}

/// Mean of the `k` largest values.
fn mean_of_top(values: impl Iterator<Item = f32>, k: usize) -> f32 {
    let mut top: Vec<f32> = values.collect();
    top.sort_by(|a, b| b.total_cmp(a));
    top.truncate(k);
    if top.is_empty() { return f32::NEG_INFINITY; }
    top.iter().sum::<f32>() / top.len() as f32
}

const NEAREST: usize = 5;
const MIN_EXAMPLES: usize = 5;

/// Texts fed to the encoder for a leaf: A = its name, B = "name (parent)", C = "name (parent)" always in the template.
fn text_variants(leaf: &Leaf) -> [String; 3] {
    let model = active_model();
    let a = normalise_query(&leaf.name, model);
    match &leaf.parent {
        None => [a.clone(), a.clone(), a],
        Some(parent) => {
            let both = format!("{} ({parent})", leaf.name);
            let cleaned = both.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
            [a, normalise_query(&both, model), model.template.replacen("{}", &cleaned, 1)]
        }
    }
}

fn env_f32(name: &str, default: f32) -> f32 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
}

#[test]
#[ignore = "reads a copy of a real catalogue"]
fn measure_keyword_scores_on_a_catalogue_copy() {
    let path = std::env::var("SEMANTIC_CATALOG").expect("set SEMANTIC_CATALOG to a COPY of a catalogue (with its -wal and -shm files)");
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("catalogue copy");
    let started = Instant::now();
    let real = load_real(&conn);
    let n = real.vectors.len();
    let eligible: Vec<usize> = (0..real.leaves.len()).filter(|&k| real.leaves[k].tagged.len() >= MIN_EXAMPLES).collect();
    let half: Vec<usize> = eligible.iter().copied().filter(|&k| real.leaves[k].tagged.len() >= 2 * MIN_EXAMPLES).collect();
    println!(
        "catalogue: {n} analysed photos, {} leaves (persons left out), {} with >= {MIN_EXAMPLES} analysed examples, {} with >= {}; loaded in {:?}",
        real.leaves.len(),
        eligible.len(),
        half.len(),
        2 * MIN_EXAMPLES,
        started.elapsed()
    );

    // --- 0. The functions of the application on this catalogue: time of the first and next requests ---------------------------------
    let model = active_model();
    {
        let cache = SearchCache::new(IDLE_RELEASE);
        let photo_ids: Vec<i64> = conn
            .prepare("SELECT photo_id FROM photo_embeddings WHERE model_id = ?1 AND photo_id IN (SELECT id FROM photos) ORDER BY photo_id")
            .unwrap()
            .query_map(params![model.id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let started = Instant::now();
        let first = photo_suggestions(&cache, &conn, model, photo_ids[0], open).unwrap();
        println!("application: first photo suggestions {:?} (index and suggestion model built), {} eligible leaves", started.elapsed(), first.eligible);
        on_keywords_changed();
        let started = Instant::now();
        photo_suggestions(&cache, &conn, model, photo_ids[1], open).unwrap();
        println!("application: suggestions after a keyword change (model rebuilt) {:?}", started.elapsed());
        let started = Instant::now();
        let mut shown = 0usize;
        for &id in photo_ids.iter().take(200) { shown += photo_suggestions(&cache, &conn, model, id, open).unwrap().suggestions.len(); }
        println!(
            "application: next suggestions {:.2} ms per photo, {:.2} suggestions per photo (tagged keywords excluded)",
            started.elapsed().as_secs_f64() * 1000.0 / 200f64.min(photo_ids.len() as f64),
            shown as f64 / 200f64.min(photo_ids.len() as f64)
        );
        let biggest: i64 = conn
            .query_row(
                "SELECT pk.keyword_id FROM photo_keywords pk JOIN photo_embeddings e ON e.photo_id = pk.photo_id
                 WHERE NOT EXISTS (SELECT 1 FROM keyword_nodes c WHERE c.parent_id = pk.keyword_id)
                 GROUP BY pk.keyword_id ORDER BY COUNT(*) DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let started = Instant::now();
        let found = keyword_candidates(&cache, &conn, model, biggest, &SearchScope::default(), &mut no_text, open).unwrap();
        println!(
            "application: candidates of the most used leaf ({} examples): {:?}, {} results above {:.3}",
            found.examples,
            started.elapsed(),
            found.search.results.len(),
            found.threshold
        );
    }

    // --- Text embeddings of every leaf, three variants; encoding speed by batch size -------------------------------------------------
    let dir = semantic_model_dir();
    let threads: usize = std::env::var("SEMANTIC_TEXT_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    let started = Instant::now();
    let environment = crate::onnx_runtime::environment(&onnx_runtime_library()).expect("ONNX Runtime");
    let mut encoder = TextEncoder::load(&environment, &dir.join("text.onnx"), &dir.join("tokenizer.json"), model, threads).expect("text encoder");
    println!("text encoder loaded in {:?} ({threads} threads)", started.elapsed());
    // Every leaf name is encoded only with SEMANTIC_MEASURE_FULL=1 (~37 ms per text: minutes): the text score of part 3 needs them all.
    let full = std::env::var("SEMANTIC_MEASURE_FULL").is_ok_and(|value| value == "1");
    let variants: Vec<[String; 3]> = real.leaves.iter().map(text_variants).collect();
    let eligible_set: HashSet<usize> = eligible.iter().copied().collect();
    let mut unique: Vec<String> = variants
        .iter()
        .enumerate()
        .filter(|(k, _)| full || eligible_set.contains(k))
        .flat_map(|(_, v)| v.iter().cloned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    unique.sort();
    let mut texts: HashMap<String, Vec<f32>> = HashMap::new();
    let sample: Vec<String> = unique.iter().take(64).cloned().collect();
    for batch in [1usize, 8, 16, 32, 64] {
        let started = Instant::now();
        for chunk in sample.chunks(batch) {
            for (text, vector) in chunk.iter().zip(encoder.embed(chunk).unwrap()) { texts.insert(text.clone(), vector); }
        }
        println!("  batch {batch:>2}: {:.1} ms per text", started.elapsed().as_secs_f64() * 1000.0 / sample.len() as f64);
    }
    let batch: usize = std::env::var("SEMANTIC_TEXT_BATCH").ok().and_then(|v| v.parse().ok()).unwrap_or(32);
    let missing: Vec<String> = unique.iter().filter(|text| !texts.contains_key(*text)).cloned().collect();
    let started = Instant::now();
    for chunk in missing.chunks(batch) {
        for (text, vector) in chunk.iter().zip(encoder.embed(chunk).unwrap()) { texts.insert(text.clone(), vector); }
    }
    println!(
        "{} distinct texts encoded in {:?} (batch {batch}: {:.1} ms per text); leaf names alone: {} distinct texts",
        missing.len(),
        started.elapsed(),
        started.elapsed().as_secs_f64() * 1000.0 / missing.len().max(1) as f64,
        variants.iter().map(|v| v[0].clone()).collect::<HashSet<_>>().len()
    );
    drop(encoder);
    let text_vector = |leaf: usize, variant: usize| -> &Vec<f32> { &texts[&variants[leaf][variant]] };

    // --- 1. Keyword → photos, by examples: half of the tagged photos hidden (keywords with >= 10) ------------------------------------
    println!("\n1. keyword -> photos, examples, half of the tagged photos hidden ({} keywords)", half.len());
    for training_rule in ["half", "five"] {
        let mut centroid_quality = Vec::new();
        let mut nearest_quality = Vec::new();
        let mut text_quality: [Vec<Quality>; 3] = Default::default();
        let mut centroid_pairs = Vec::new();
        let mut nearest_pairs = Vec::new();
        let mut adaptive: Vec<(f32, bool, [f32; 3])> = Vec::new(); // score, positive, per-keyword thresholds at q = 0.1, 0.25, 0.5
        let mut adaptive_nearest: Vec<(f32, bool, [f32; 3])> = Vec::new();
        let mut training_self = Vec::new();
        for &k in &half {
            let order = shuffled(&real.leaves[k].tagged);
            let cut = if training_rule == "half" { order.len() / 2 } else { MIN_EXAMPLES };
            let training: Vec<usize> = order[..cut].to_vec();
            let held: HashSet<usize> = order[cut..].iter().copied().collect();
            let in_training: HashSet<usize> = training.iter().copied().collect();
            let sums: Vec<f32> = (0..n).map(|p| training.iter().map(|&i| real.g(p, i)).sum()).collect();
            let norm2: f32 = training.iter().map(|&i| sums[i]).sum();
            // Cosine of each training photo with the centroid of the others: the keyword's own spread.
            let mut own: Vec<f32> = training.iter().map(|&i| (sums[i] - real.g(i, i)) / (norm2 - 2.0 * sums[i] + real.g(i, i)).sqrt()).collect();
            own.sort_by(|a, b| a.total_cmp(b));
            training_self.extend(own.iter().copied());
            let thresholds = [percentile(&own, 0.1), percentile(&own, 0.25), percentile(&own, 0.5)];
            let candidates: Vec<usize> = (0..n).filter(|p| !in_training.contains(p)).collect();
            let mut centroid: Vec<(f32, bool)> = candidates.iter().map(|&p| (sums[p] / norm2.sqrt(), held.contains(&p))).collect();
            let mut nearest: Vec<(f32, bool)> =
                candidates.iter().map(|&p| (mean_of_top(training.iter().map(|&i| real.g(p, i)), NEAREST), held.contains(&p))).collect();
            for &(score, positive) in &centroid { adaptive.push((score, positive, thresholds)); }
            // Same for the nearest score: each training photo against the other training photos.
            let mut own_nearest: Vec<f32> = training
                .iter()
                .map(|&i| mean_of_top(training.iter().filter(|&&j| j != i).map(|&j| real.g(i, j)), NEAREST))
                .collect();
            own_nearest.sort_by(|a, b| a.total_cmp(b));
            let nearest_thresholds = [percentile(&own_nearest, 0.1), percentile(&own_nearest, 0.25), percentile(&own_nearest, 0.5)];
            for &(score, positive) in &nearest { adaptive_nearest.push((score, positive, nearest_thresholds)); }
            centroid_pairs.extend(centroid.iter().copied());
            nearest_pairs.extend(nearest.iter().copied());
            centroid_quality.push(quality(&mut centroid, held.len()));
            nearest_quality.push(quality(&mut nearest, held.len()));
            for variant in 0..3 {
                let t = text_vector(k, variant);
                let mut scored: Vec<(f32, bool)> = candidates.iter().map(|&p| (dot(&real.vectors[p], t), held.contains(&p))).collect();
                text_quality[variant].push(quality(&mut scored, held.len()));
            }
        }
        println!(" training = {training_rule}");
        print_quality("centroid", &centroid_quality);
        print_quality(&format!("mean of the {NEAREST} nearest"), &nearest_quality);
        for (variant, label) in ["text: name", "text: name (parent)", "text: name (parent), template"].iter().enumerate() {
            print_quality(label, &text_quality[variant]);
        }
        training_self.sort_by(|a, b| a.total_cmp(b));
        println!(
            "  cosine of a tagged photo with its keyword centroid (leave one out): p10 {:.3} p25 {:.3} median {:.3} p90 {:.3}",
            percentile(&training_self, 0.1),
            percentile(&training_self, 0.25),
            percentile(&training_self, 0.5),
            percentile(&training_self, 0.9)
        );
        let grid: Vec<f32> = (0..=12).map(|i| 0.55 + 0.025 * i as f32).collect();
        print_sweep("centroid, fixed threshold", &centroid_pairs, &grid, half.len());
        print_sweep(&format!("mean of the {NEAREST} nearest, fixed threshold"), &nearest_pairs, &grid, half.len());
        for (label, pairs) in [("centroid", &adaptive), ("5 nearest", &adaptive_nearest)] {
            for (slot, q) in [0.1, 0.25, 0.5].iter().enumerate() {
                let above: Vec<&(f32, bool, [f32; 3])> = pairs.iter().filter(|(score, _, t)| *score >= t[slot]).collect();
                let hits = above.iter().filter(|(_, positive, _)| *positive).count();
                let positives = pairs.iter().filter(|(_, positive, _)| *positive).count();
                println!(
                    "  {label}, per-keyword threshold = quantile {q} of its own photos: precision {:.3} recall {:.3} above per keyword {:.1}",
                    hits as f64 / above.len().max(1) as f64,
                    hits as f64 / positives.max(1) as f64,
                    above.len() as f64 / half.len() as f64
                );
            }
        }
    }

    // --- 2. Keyword → photos, by text only, as if the keywords had fewer than 5 examples ---------------------------------------------
    println!("\n2. keyword -> photos, text only, every photo of the catalogue, positives = all tagged photos ({} keywords)", eligible.len());
    for (variant, label) in ["name", "name (parent)", "name (parent), template"].iter().enumerate() {
        let mut values = Vec::new();
        let mut pairs = Vec::new();
        for &k in &eligible {
            let tagged: HashSet<usize> = real.leaves[k].tagged.iter().copied().collect();
            let t = text_vector(k, variant);
            let mut scored: Vec<(f32, bool)> = (0..n).map(|p| (dot(&real.vectors[p], t), tagged.contains(&p))).collect();
            pairs.extend(scored.iter().copied());
            values.push(quality(&mut scored, tagged.len()));
        }
        print_quality(label, &values);
        if variant == 0 {
            let grid: Vec<f32> = (0..=10).map(|i| 0.04 + 0.01 * i as f32).collect();
            print_sweep("text (name), fixed threshold", &pairs, &grid, eligible.len());
        }
    }

    // --- 3. Photo → keywords, each photo hidden from its keywords (leave one out), whole vocabulary ----------------------------------
    // Examples score when the keyword keeps >= 5 tagged photos without this one, text score (name) otherwise.
    println!("\n3. photo -> keywords, leave one out, {} leaves", real.leaves.len());
    let dim = model.embed_dim;
    let sums: HashMap<usize, (Vec<f32>, f32)> = eligible
        .iter()
        .map(|&k| {
            let mut sum = vec![0f32; dim];
            for &p in &real.leaves[k].tagged { for (slot, value) in sum.iter_mut().zip(&real.vectors[p]) { *slot += value; } }
            let norm2 = dot(&sum, &sum);
            (k, (sum, norm2))
        })
        .collect();
    let t_examples = env_f32("SEMANTIC_T_EXAMPLES", 0.75);
    let t_nearest = env_f32("SEMANTIC_T_NEAREST", 0.80);
    let t_text = env_f32("SEMANTIC_T_TEXT", 0.10);
    struct PhotoResult {
        examples: Vec<(f32, bool)>,
        nearest: Vec<(f32, bool)>,
        nearest_far: Vec<(f32, bool)>,
        text: Vec<(f32, bool)>,
        truth_examples: usize,
        truth_text: usize,
    }
    const NEAR_COPY: f32 = 0.95;
    let started = Instant::now();
    let results: Vec<PhotoResult> = (0..n)
        .into_par_iter()
        .filter(|&p| !real.by_photo[p].is_empty())
        .map(|p| {
            let carried: HashSet<usize> = real.by_photo[p].iter().copied().collect();
            let v = &real.vectors[p];
            let mut result =
                PhotoResult { examples: Vec::new(), nearest: Vec::new(), nearest_far: Vec::new(), text: Vec::new(), truth_examples: 0, truth_text: 0 };
            for (k, leaf) in real.leaves.iter().enumerate() {
                let tagged_here = carried.contains(&k);
                let examples = leaf.tagged.len() - usize::from(tagged_here);
                if examples >= MIN_EXAMPLES {
                    let (sum, norm2) = &sums[&k];
                    let mut d = dot(sum, v);
                    let mut norm2 = *norm2;
                    if tagged_here {
                        let self_dot = real.g(p, p);
                        norm2 -= 2.0 * d - self_dot;
                        d -= self_dot;
                    }
                    result.examples.push((d / norm2.sqrt(), tagged_here));
                    result.nearest.push((mean_of_top(leaf.tagged.iter().filter(|&&i| i != p).map(|&i| real.g(p, i)), NEAREST), tagged_here));
                    // Near copies of the photo (bursts, edits) left out: how much of the score comes from them.
                    let far = leaf.tagged.iter().filter(|&&i| i != p && real.g(p, i) < NEAR_COPY).map(|&i| real.g(p, i));
                    result.nearest_far.push((mean_of_top(far, NEAREST), tagged_here));
                    result.truth_examples += usize::from(tagged_here);
                } else if full {
                    result.text.push((dot(v, text_vector(k, 0)), tagged_here));
                    result.truth_text += usize::from(tagged_here);
                }
            }
            result
        })
        .collect();
    println!("  {} photos scored against every leaf in {:?}", results.len(), started.elapsed());
    fn examples_of(r: &PhotoResult) -> (&Vec<(f32, bool)>, usize) { (&r.examples, r.truth_examples) }
    fn nearest_of(r: &PhotoResult) -> (&Vec<(f32, bool)>, usize) { (&r.nearest, r.truth_examples) }
    fn nearest_far_of(r: &PhotoResult) -> (&Vec<(f32, bool)>, usize) { (&r.nearest_far, r.truth_examples) }
    fn text_of(r: &PhotoResult) -> (&Vec<(f32, bool)>, usize) { (&r.text, r.truth_text) }
    type Pick = fn(&PhotoResult) -> (&Vec<(f32, bool)>, usize);
    let top5 = |pick: Pick, threshold: f32| {
        let (mut precision, mut recall, mut shown, mut with_truth, mut counted) = (0f64, 0f64, 0usize, 0usize, 0usize);
        for result in &results {
            let (scored, truth) = pick(result);
            let mut sorted: Vec<(f32, bool)> = scored.iter().copied().filter(|(score, _)| *score >= threshold).collect();
            sorted.sort_by(|a, b| b.0.total_cmp(&a.0));
            sorted.truncate(5);
            let hits = sorted.iter().filter(|(_, positive)| *positive).count();
            if !sorted.is_empty() {
                precision += hits as f64 / sorted.len() as f64;
                counted += 1;
            }
            shown += sorted.len();
            if truth > 0 {
                recall += hits as f64 / truth.min(5) as f64;
                with_truth += 1;
            }
        }
        (precision / counted.max(1) as f64, recall / with_truth.max(1) as f64, shown as f64 / results.len() as f64)
    };
    let cases: [(&str, Pick, f32); 6] = [
        ("examples (centroid), no threshold", examples_of, f32::NEG_INFINITY),
        ("examples (centroid), threshold", examples_of, t_examples),
        ("examples (5 nearest), no threshold", nearest_of, f32::NEG_INFINITY),
        ("examples (5 nearest), threshold", nearest_of, t_nearest),
        ("text (name), no threshold", text_of, f32::NEG_INFINITY),
        ("text (name), threshold", text_of, t_text),
    ];
    for (label, pick, threshold) in cases {
        if !full && label.starts_with("text") { continue; }
        let (precision, recall, shown) = top5(pick, threshold);
        let shown_threshold = if threshold.is_finite() { format!(" (t = {threshold})") } else { String::new() };
        println!("  top 5, {label}{shown_threshold}: precision {precision:.3}  recall {recall:.3}  suggestions per photo {shown:.2}");
    }
    for (label, pick) in [("5 nearest", nearest_of as Pick), (&format!("5 nearest, near copies (cos >= {NEAR_COPY}) left out"), nearest_far_of as Pick)] {
        println!("  top 5, {label}, by threshold:");
        for threshold in [0.70f32, 0.75, 0.775, 0.80, 0.825, 0.85, 0.875, 0.90] {
            let (precision, recall, shown) = top5(pick, threshold);
            println!("    t={threshold:.3}  precision {precision:.3}  recall {recall:.3}  suggestions per photo {shown:.2}");
        }
    }
    let pooled = |pick: fn(&PhotoResult) -> &Vec<(f32, bool)>| -> Vec<(f32, bool)> { results.iter().flat_map(|r| pick(r).iter().copied()).collect() };
    let grid: Vec<f32> = (0..=12).map(|i| 0.55 + 0.025 * i as f32).collect();
    print_sweep("examples (centroid), every pair", &pooled(|r| &r.examples), &grid, results.len());
    print_sweep("examples (5 nearest), every pair", &pooled(|r| &r.nearest), &grid, results.len());
    if !full { return; }
    let grid: Vec<f32> = (0..=10).map(|i| 0.04 + 0.01 * i as f32).collect();
    print_sweep("text (name), every pair", &pooled(|r| &r.text), &grid, results.len());

    // Combined list: both kinds above their own threshold, ranked by the margin over it, top 5.
    let (mut precision, mut counted, mut shown, mut from_text) = (0f64, 0usize, 0usize, 0usize);
    for result in &results {
        let mut merged: Vec<(f32, bool, bool)> = result
            .examples
            .iter()
            .filter(|(score, _)| *score >= t_examples)
            .map(|(score, positive)| (score - t_examples, *positive, false))
            .chain(result.text.iter().filter(|(score, _)| *score >= t_text).map(|(score, positive)| ((score - t_text) * 4.0, *positive, true)))
            .collect();
        merged.sort_by(|a, b| b.0.total_cmp(&a.0));
        merged.truncate(5);
        if merged.is_empty() { continue; }
        precision += merged.iter().filter(|m| m.1).count() as f64 / merged.len() as f64;
        counted += 1;
        shown += merged.len();
        from_text += merged.iter().filter(|m| m.2).count();
    }
    println!(
        "  combined top 5 (t examples {t_examples}, t text {t_text}): precision {:.3}, suggestions per photo {:.2}, from text {:.0} %",
        precision / counted.max(1) as f64,
        shown as f64 / results.len() as f64,
        100.0 * from_text as f64 / shown.max(1) as f64
    );
}
