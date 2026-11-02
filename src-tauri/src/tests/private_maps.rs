//! Tests des zones privées (private_maps.rs) : géométrie des zones et des tuiles, fichiers MBTiles, règle par tuile, import, refus hors ligne.
//! Aucune requête réseau : les téléchargements sont testés avec Internet refusé (réglage par défaut tant que l'interface ne l'a pas envoyé).

use super::*;

fn paris_circle(radius: f64) -> ZoneGeometry {
    ZoneGeometry::Circle { lat: 48.8566, lon: 2.3522, radius }
}

/// Tuile (x, y) au zoom z qui contient le point.
fn tile_of(lat: f64, lon: f64, z: u8) -> (u32, u32) {
    let (x, y) = mercator(lat, lon);
    let count = f64::from(1u32 << z);
    ((x * count) as u32, (y * count) as u32)
}

#[test]
fn geometry_validation() {
    assert!(paris_circle(1000.0).validate().is_ok());
    assert!(paris_circle(10.0).validate().is_err());
    assert!(paris_circle(500_000.0).validate().is_err());
    assert!(ZoneGeometry::Circle { lat: 95.0, lon: 0.0, radius: 1000.0 }.validate().is_err());
    assert!(ZoneGeometry::Polygon { points: vec![[48.0, 2.0], [48.1, 2.0]] }.validate().is_err());
    assert!(ZoneGeometry::Polygon { points: vec![[48.0, 2.0], [48.1, 2.0], [48.1, 2.1]] }.validate().is_ok());
    // Format JSON échangé avec l'interface.
    let json = serde_json::to_string(&paris_circle(1000.0)).unwrap();
    assert_eq!(json, r#"{"kind":"circle","lat":48.8566,"lon":2.3522,"radius":1000.0}"#);
    let polygon: ZoneGeometry = serde_json::from_str(r#"{"kind":"polygon","points":[[1,2],[3,4],[5,6]]}"#).unwrap();
    assert_eq!(polygon, ZoneGeometry::Polygon { points: vec![[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]] });
}

#[test]
fn points_inside_and_outside_zones() {
    let circle = ZoneShape::new(&paris_circle(1000.0));
    assert!(circle.contains_location(48.8566, 2.3522));
    assert!(circle.contains_location(48.8566 + 0.008, 2.3522)); // ≈ 890 m au nord
    assert!(!circle.contains_location(48.8566 + 0.011, 2.3522)); // ≈ 1,2 km
    // Polygone concave (en U) : le creux n'est pas dans la zone.
    let u_shape = ZoneShape::new(&ZoneGeometry::Polygon {
        points: vec![[0.0, 0.0], [0.0, 3.0], [3.0, 3.0], [3.0, 2.0], [1.0, 2.0], [1.0, 1.0], [3.0, 1.0], [3.0, 0.0]],
    });
    assert!(u_shape.contains_location(0.5, 1.5));
    assert!(u_shape.contains_location(2.0, 0.5));
    assert!(!u_shape.contains_location(2.0, 1.5));
}

#[test]
fn tiles_covering_a_zone() {
    let shape = ZoneShape::new(&paris_circle(1000.0));
    let tiles = shape.covering_tiles(14);
    // Chaque niveau contient la tuile du centre ; les niveaux larges n'ont qu'une tuile.
    for z in 0..=14u8 {
        let (x, y) = tile_of(48.8566, 2.3522, z);
        assert!(tiles.contains(&(z, x, y)), "zoom {z}");
    }
    assert_eq!(tiles.iter().filter(|tile| tile.0 == 0).count(), 1);
    assert!(tiles.iter().filter(|tile| tile.0 == 14).count() >= 2);
    // Une tuile lointaine n'est pas couverte ; l'estimation suit le nombre de tuiles.
    let (x, y) = tile_of(43.3, 5.4, 14);
    assert!(!shape.intersects_tile(14, x, y));
    assert_eq!(estimate(&paris_circle(1000.0), 14).tiles, tiles.len());
    // Une zone de 50 km au niveau Rues dépasse la limite du fournisseur, pas au niveau Ville.
    assert!(!estimate(&paris_circle(60_000.0), 14).within_limits);
    assert!(estimate(&paris_circle(60_000.0), 12).within_limits);
    // Tuile entièrement à l'intérieur d'un grand polygone : couverte même sans sommet ni côté dedans.
    let big = ZoneShape::new(&ZoneGeometry::Polygon { points: vec![[40.0, -5.0], [40.0, 10.0], [52.0, 10.0], [52.0, -5.0]] });
    let (x, y) = tile_of(48.8566, 2.3522, 14);
    assert!(big.intersects_tile(14, x, y));
}

#[test]
fn mbtiles_store_rows_in_tms_order() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("zone.mbtiles");
    let conn = create_mbtiles(&path, "Test", 14).unwrap();
    conn.execute("INSERT INTO tiles VALUES (2, 1, ?1, ?2)", (tms_row(2, 0), vec![7u8, 8, 9])).unwrap();
    assert_eq!(tms_row(2, 0), 3);
    assert_eq!(read_tile(&conn, 2, 1, 0), Some(vec![7, 8, 9]));
    assert_eq!(read_tile(&conn, 2, 1, 3), None);
    drop(conn);
    let (max_zoom, bounds) = inspect_mbtiles(&path).unwrap();
    assert_eq!((max_zoom, bounds), (2, None));
}

#[test]
fn import_validation_refuses_non_vector_files() {
    let dir = tempfile::tempdir().unwrap();
    let text = dir.path().join("a.mbtiles");
    fs::write(&text, b"pas une base").unwrap();
    assert!(inspect_mbtiles(&text).is_err());
    // MBTiles raster (format png) : refusé.
    let raster = dir.path().join("raster.mbtiles");
    let conn = create_mbtiles(&raster, "Raster", 10).unwrap();
    conn.execute("UPDATE metadata SET value = 'png' WHERE name = 'format'", []).unwrap();
    conn.execute("INSERT INTO tiles VALUES (0, 0, 0, x'00')", []).unwrap();
    drop(conn);
    assert_eq!(inspect_mbtiles(&raster).unwrap_err(), "mbtiles_not_vector");
    // Vectoriel sans tuile : refusé ; avec bornes : bornes lues.
    let empty = dir.path().join("empty.mbtiles");
    let conn = create_mbtiles(&empty, "Vide", 14).unwrap();
    conn.execute("INSERT INTO metadata VALUES ('bounds', '2.2,48.8,2.4,48.9')", []).unwrap();
    assert!(inspect_mbtiles(&empty).is_err());
    conn.execute("INSERT INTO tiles VALUES (16, 0, 0, x'00')", []).unwrap();
    drop(conn);
    assert_eq!(inspect_mbtiles(&empty).unwrap(), (14, Some([2.2, 48.8, 2.4, 48.9])));
}

#[test]
fn tile_rule_serves_private_tiles_from_disk_and_never_falls_back() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = rusqlite::Connection::open_in_memory().unwrap();
    init_schema(&catalog).unwrap();
    let json = serde_json::to_string(&paris_circle(1000.0)).unwrap();
    catalog.execute("INSERT INTO private_zones (id, name, geometry, max_zoom) VALUES (7, 'Maison', ?1, 14)", [json]).unwrap();
    let zones = load_zones(&catalog).unwrap();
    let mut files = HashMap::new();
    let (x, y) = tile_of(48.8566, 2.3522, 14);
    let (far_x, far_y) = tile_of(43.3, 5.4, 14);

    // Zone sans fichier (pas encore téléchargée) : la tuile est déjà privée, et vide.
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, x, y), Some(Vec::new()));
    // Tuile hors zone : None, l'interface peut la demander au fournisseur.
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, far_x, far_y), None);
    assert!(zones[0].shape.contains_location(48.8566, 2.3522));

    // Fichier présent : la tuile vient du disque ; une tuile manquante reste vide (aucun repli).
    let conn = create_mbtiles(&dir.path().join("maison.mbtiles"), "Maison", 14).unwrap();
    conn.execute("INSERT INTO tiles VALUES (14, ?1, ?2, x'0102')", (x, tms_row(14, y))).unwrap();
    drop(conn);
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, x, y), Some(vec![1, 2]));
    let neighbour = shape_neighbour(x, y);
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, neighbour.0, neighbour.1), Some(Vec::new()));

    // Zone supprimée : plus aucune tuile privée.
    catalog.execute("DELETE FROM private_zones", []).unwrap();
    let zones = load_zones(&catalog).unwrap();
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, x, y), None);
}

/// Tuile voisine encore dans la zone de 1 km (au zoom 14, une tuile fait ≈ 1,6 km à Paris : la zone en couvre au moins deux).
fn shape_neighbour(x: u32, y: u32) -> (u32, u32) {
    let shape = ZoneShape::new(&paris_circle(1000.0));
    [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)].into_iter().find(|(nx, ny)| shape.intersects_tile(14, *nx, *ny)).unwrap()
}

#[test]
fn download_is_refused_without_internet_and_sends_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = create_mbtiles(&dir.path().join("zone.mbtiles"), "Test", 14).unwrap();
    // Adresse injoignable : si une requête partait malgré le refus, elle échouerait et serait comptée comme tuile manquante.
    let cancel = AtomicBool::new(false);
    let mut calls = 0;
    let result = download_tiles(&mut conn, "http://127.0.0.1:9/{z}/{x}/{y}", &[(0, 0, 0), (1, 0, 0)], &cancel, &mut |_| calls += 1);
    assert_eq!(result.err().as_deref(), Some("internet_disabled"));
    assert_eq!(calls, 0, "aucune tuile ne doit avoir été demandée");
}

#[test]
fn resource_names_are_restricted() {
    assert_eq!(safe_component("Noto Sans Regular").as_deref(), Some("Noto Sans Regular"));
    assert_eq!(safe_component("sprite@2x.png").as_deref(), Some("sprite@2x.png"));
    assert!(safe_component("..").is_none());
    assert!(safe_component("a/b").is_none());
    assert!(safe_component("a\\b").is_none());
    assert!(safe_component("").is_none());
}

#[test]
fn zone_file_names_follow_the_zone_name() {
    assert_eq!(zone_file_name("Maison").unwrap(), "maison.mbtiles");
    assert_eq!(zone_file_name("  Chez  les Parents ").unwrap(), "chez__les_parents.mbtiles");
    assert_eq!(zone_file_name("Été à Nice").unwrap(), "été_à_nice.mbtiles");
    assert_eq!(zone_file_name("a/b:c*?").unwrap(), "abc.mbtiles");
    assert_eq!(zone_file_name("fin. ").unwrap(), "fin.mbtiles");
    assert!(zone_file_name("???").is_err());
    assert!(zone_file_name("CON").is_err());
}

#[test]
fn zone_names_must_give_distinct_files() {
    let catalog = rusqlite::Connection::open_in_memory().unwrap();
    init_schema(&catalog).unwrap();
    let json = serde_json::to_string(&paris_circle(1000.0)).unwrap();
    catalog.execute("INSERT INTO private_zones (id, name, geometry, max_zoom) VALUES (1, 'Ma Maison', ?1, 14)", [json]).unwrap();
    assert_eq!(check_unique_name(&catalog, "ma maison", None).unwrap_err(), "zone_name_taken");
    assert_eq!(check_unique_name(&catalog, "MA_MAISON", None).unwrap_err(), "zone_name_taken");
    assert!(check_unique_name(&catalog, "Ma Maison", Some(1)).is_ok(), "la zone renommée peut garder son nom");
    assert!(check_unique_name(&catalog, "Bureau", None).is_ok());
}

#[test]
fn legacy_zone_files_are_renamed_after_their_zone() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = rusqlite::Connection::open_in_memory().unwrap();
    init_schema(&catalog).unwrap();
    let json = serde_json::to_string(&paris_circle(1000.0)).unwrap();
    catalog.execute("INSERT INTO private_zones (id, name, geometry, max_zoom) VALUES (3, 'Home', ?1, 14), (5, 'Work V', ?1, 14), (6, 'Déjà', ?1, 14)", [json]).unwrap();
    fs::write(dir.path().join("zone_3.mbtiles"), b"home").unwrap();
    fs::write(dir.path().join("zone_5.mbtiles"), b"work").unwrap();
    // Cible déjà présente : l'ancien fichier n'écrase rien.
    fs::write(dir.path().join("zone_6.mbtiles"), b"ancien").unwrap();
    fs::write(dir.path().join("déjà.mbtiles"), b"nouveau").unwrap();
    migrate_legacy_files(dir.path(), &catalog);
    assert_eq!(fs::read(dir.path().join("home.mbtiles")).unwrap(), b"home");
    assert_eq!(fs::read(dir.path().join("work_v.mbtiles")).unwrap(), b"work");
    assert!(!dir.path().join("zone_3.mbtiles").exists());
    assert_eq!(fs::read(dir.path().join("déjà.mbtiles")).unwrap(), b"nouveau");
    assert!(dir.path().join("zone_6.mbtiles").exists());
}

#[test]
fn overlapping_zones_give_the_finest_available_zoom() {
    let zone = |id, max_zoom, geometry: ZoneGeometry| LoadedZone { id, file: String::new(), max_zoom, shape: ZoneShape::new(&geometry) };
    // « Appart » (Ville, zoom 12) et « Maison » (Rues, zoom 14) se recoupent autour du centre de Paris.
    let zones = vec![zone(1, 12, paris_circle(3000.0)), zone(2, 14, ZoneGeometry::Circle { lat: 48.8566, lon: 2.37, radius: 2000.0 })];
    assert_eq!(private_zoom_in(&zones, 48.8566, 2.3522), Some(14), "intersection : le détail le plus fin");
    assert_eq!(private_zoom_in(&zones, 48.8566, 2.33), Some(12), "seulement dans la zone moins détaillée");
    assert_eq!(private_zoom_in(&zones, 48.8566, 2.39), Some(14));
    assert_eq!(private_zoom_in(&zones, 43.3, 5.4), None);
    // L'ordre des zones ne change rien.
    let reversed: Vec<LoadedZone> = zones.into_iter().rev().collect();
    assert_eq!(private_zoom_in(&reversed, 48.8566, 2.3522), Some(14));
}
