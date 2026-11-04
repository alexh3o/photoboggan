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
    // Un fichier plus fin que le zoom 15 est plafonné à 15 (plus fin que les niveaux gérés).
    conn.execute("INSERT INTO tiles VALUES (16, 0, 0, x'00')", []).unwrap();
    drop(conn);
    assert_eq!(inspect_mbtiles(&empty).unwrap(), (15, Some([2.2, 48.8, 2.4, 48.9])));
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
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, x, y), TileAnswer::Private(Vec::new()));
    // Tuile hors zone : None, l'interface peut la demander au fournisseur.
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, far_x, far_y), TileAnswer::Outside);
    assert!(zones[0].shape.contains_location(48.8566, 2.3522));

    // Fichier présent : la tuile vient du disque ; une tuile manquante reste vide (aucun repli).
    let conn = create_mbtiles(&dir.path().join("maison.mbtiles"), "Maison", 14).unwrap();
    conn.execute("INSERT INTO tiles VALUES (14, ?1, ?2, x'0102')", (x, tms_row(14, y))).unwrap();
    drop(conn);
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, x, y), TileAnswer::Private(vec![1, 2]));
    let neighbour = shape_neighbour(x, y);
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, neighbour.0, neighbour.1), TileAnswer::Private(Vec::new()));

    // Zone supprimée : plus aucune tuile privée.
    catalog.execute("DELETE FROM private_zones", []).unwrap();
    let zones = load_zones(&catalog).unwrap();
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, x, y), TileAnswer::Outside);
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
    let zone = |id, max_zoom, geometry: ZoneGeometry| LoadedZone { id, file: String::new(), max_zoom, private: true, shape: ZoneShape::new(&geometry) };
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

#[test]
fn offline_zones_serve_their_tiles_and_let_missing_ones_be_fetched() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = rusqlite::Connection::open_in_memory().unwrap();
    init_schema(&catalog).unwrap();
    let paris = serde_json::to_string(&paris_circle(1000.0)).unwrap();
    let wide = serde_json::to_string(&paris_circle(20_000.0)).unwrap();
    // Zones existantes sans réglage : privées par défaut.
    catalog.execute("INSERT INTO private_zones (id, name, geometry, max_zoom) VALUES (1, 'Carte', ?1, 12)", [&wide]).unwrap();
    assert!(load_zones(&catalog).unwrap()[0].private);
    catalog.execute("UPDATE private_zones SET private = 0", []).unwrap();
    let (x, y) = tile_of(48.8566, 2.3522, 14);
    let (x12, y12) = tile_of(48.8566, 2.3522, 12);
    let conn = create_mbtiles(&dir.path().join("carte.mbtiles"), "Carte", 12).unwrap();
    conn.execute("INSERT INTO tiles VALUES (12, ?1, ?2, x'0303')", (x12, tms_row(12, y12))).unwrap();
    drop(conn);
    let mut files = HashMap::new();

    // Carte hors ligne seule : tuile du disque si présente ; au-delà du niveau téléchargé, manquante (l'interface peut la demander).
    let zones = load_zones(&catalog).unwrap();
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 12, x12, y12), TileAnswer::Offline(Some(vec![3, 3])));
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, x, y), TileAnswer::Offline(None));
    // Un lieu dans une carte hors ligne n'est pas privé.
    assert_eq!(private_zoom_in(&zones, 48.8566, 2.3522), None);

    // Zone privée qui recoupe la carte hors ligne : elle l'emporte (jamais de demande au fournisseur), la tuile reste lue sur le disque.
    catalog.execute("INSERT INTO private_zones (id, name, geometry, max_zoom) VALUES (2, 'Maison', ?1, 14)", [&paris]).unwrap();
    let zones = load_zones(&catalog).unwrap();
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 12, x12, y12), TileAnswer::Private(vec![3, 3]));
    assert_eq!(private_tile_in(&zones, &mut files, dir.path(), 14, x, y), TileAnswer::Private(Vec::new()));
    assert_eq!(private_zoom_in(&zones, 48.8566, 2.3522), Some(14));
}

#[test]
fn style_resources_prefer_the_downloaded_copy_over_the_bundled_one() {
    let dir = tempfile::tempdir().unwrap();
    let (downloaded, bundled) = (dir.path().join("downloaded"), dir.path().join("bundled"));
    for (root, text) in [(&downloaded, "telecharge"), (&bundled, "embarque")] {
        std::fs::create_dir_all(root.join("styles")).unwrap();
        std::fs::write(root.join("styles").join("dark.json"), text).unwrap();
    }
    std::fs::write(bundled.join("styles").join("liberty.json"), "embarque seul").unwrap();
    let parts = |text: &[&str]| text.iter().map(|part| part.to_string()).collect::<Vec<_>>();

    // Copie téléchargée présente : elle l'emporte ; absente d'un fichier : le style embarqué le fournit.
    assert_eq!(style_resource(&downloaded, Some(&bundled), &parts(&["styles", "dark.json"])).unwrap(), b"telecharge");
    assert_eq!(style_resource(&downloaded, Some(&bundled), &parts(&["styles", "liberty.json"])).unwrap(), b"embarque seul");
    // Copie supprimée (« Revenir au style d'origine ») : le style embarqué.
    std::fs::remove_dir_all(&downloaded).unwrap();
    assert_eq!(style_resource(&downloaded, Some(&bundled), &parts(&["styles", "dark.json"])).unwrap(), b"embarque");
    // Rien nulle part : absent.
    assert_eq!(style_resource(&downloaded, Some(&bundled), &parts(&["styles", "inconnu.json"])), None);
    assert_eq!(style_resource(&downloaded, None, &parts(&["styles", "dark.json"])), None);
}

/// Fichier MBTiles de test : une tuile vide par (zoom, x, y) donné.
fn mbtiles_with(path: &Path, max_zoom: u8, tiles: &[(u8, u32, u32)]) {
    let conn = create_mbtiles(path, "Forme", max_zoom).unwrap();
    for (z, x, y) in tiles {
        conn.execute("INSERT INTO tiles VALUES (?1, ?2, ?3, X'00')", (z, x, tms_row(*z, *y))).unwrap();
    }
}

#[test]
fn imported_file_shape_follows_its_tiles() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("iles.mbtiles");
    // Un L de trois tuiles et une île lointaine, au zoom 5 ; une tuile du zoom 0 pour tout le monde.
    mbtiles_with(&path, 5, &[(0, 0, 0), (5, 2, 2), (5, 3, 2), (5, 2, 3), (5, 20, 25)]);
    let shape = mbtiles_footprint(&path, 5).unwrap();
    assert_eq!(shape, ZoneGeometry::Tiles { zoom: 5, rows: vec![[2, 2, 3], [3, 2, 2], [25, 20, 20]] });

    let zone = ZoneShape::new(&shape);
    assert!(zone.intersects_tile(5, 3, 2));
    assert!(!zone.intersects_tile(5, 3, 3), "le coin manquant du L n'est pas dans la zone");
    assert!(zone.intersects_tile(7, 12, 8), "tuile plus fine : jugée par son ancêtre");
    assert!(zone.intersects_tile(3, 0, 0), "tuile plus large : elle contient des tuiles de la zone");
    assert!(!zone.intersects_tile(3, 7, 7));
    // Le centre de la tuile (5, 20, 25) est dans la zone, un point du rectangle englobant entre les deux îles non.
    let (lat, lon) = (0.0, 0.0);
    assert!(!zone.contains_location(lat, lon));

    // Deux contours, sans arête entre tuiles voisines : le L a 6 sommets (7 points, anneau fermé), l'île 4 (5 points).
    let outline = shape.outline().unwrap();
    assert_eq!(outline.len(), 2);
    let mut sizes: Vec<usize> = outline.iter().map(|polygon| polygon[0].len()).collect();
    sizes.sort_unstable();
    assert_eq!(sizes, vec![5, 7]);
}

#[test]
fn imported_file_shape_keeps_holes_and_survives_serialization() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("anneau.mbtiles");
    let ring: Vec<(u8, u32, u32)> = (4..7).flat_map(|x| (4..7).map(move |y| (4u8, x, y))).filter(|&(_, x, y)| (x, y) != (5, 5)).collect();
    mbtiles_with(&path, 4, &ring);
    let shape = mbtiles_footprint(&path, 4).unwrap();
    let outline = shape.outline().unwrap();
    assert_eq!(outline.len(), 1);
    assert_eq!(outline[0].len(), 2, "un contour extérieur et un trou");

    let zone = ZoneShape::new(&shape);
    assert!(!zone.intersects_tile(4, 5, 5), "le trou n'est pas dans la zone");
    assert!(zone.intersects_tile(4, 4, 4));
    let again: ZoneGeometry = serde_json::from_str(&serde_json::to_string(&shape).unwrap()).unwrap();
    assert_eq!(again, shape);
}

#[test]
fn imported_file_without_usable_tiles_has_no_shape() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vide.mbtiles");
    mbtiles_with(&path, 5, &[]);
    assert!(mbtiles_footprint(&path, 5).is_none());
    assert!(ZoneGeometry::Tiles { zoom: 5, rows: vec![[40, 0, 0]] }.validate().is_err(), "rangée hors de la grille");
}

#[test]
fn a_large_tile_shape_stays_cheap_to_build() {
    // ≈ 150 000 tuiles au zoom 14 en escalier (coupe de côte) : forme, couverture et contour doivent rester rapides.
    let rows: Vec<[u32; 3]> = (0..400u32).map(|i| [6000 + i, 8000 + i / 2, 8000 + i / 2 + 380]).collect();
    let shape = ZoneGeometry::Tiles { zoom: 14, rows };
    assert!(shape.validate().is_ok());
    let started = std::time::Instant::now();
    let zone = ZoneShape::new(&shape);
    let outline = shape.outline().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(3), "forme trop lente : {:?}", started.elapsed());
    assert_eq!(outline.len(), 1);
    assert!(zone.intersects_tile(14, 8100, 6100));
    assert!(!zone.intersects_tile(14, 100, 100));
    eprintln!("forme de 150 000 tuiles : {:?}", started.elapsed());
}
