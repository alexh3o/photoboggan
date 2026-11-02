//! Tests de la recherche de lieux (place_search.rs) : encodage de la requête et lecture de la réponse. Aucun accès au réseau.

use super::*;

#[test]
fn query_is_percent_encoded() {
    assert_eq!(percent_encode("Saint-Étienne, 42"), "Saint-%C3%89tienne%2C%2042");
    assert_eq!(percent_encode("a&b=c"), "a%26b%3Dc");
}

#[test]
fn places_are_read_from_the_provider_answer() {
    let body = br#"[
        {"lat": "48.8588897", "lon": "2.3200410", "display_name": "Paris, France"},
        {"lat": "abc", "lon": "2.0", "display_name": "coordonnees illisibles"},
        {"lat": "95.0", "lon": "2.0", "display_name": "hors limites"},
        {"lat": "-31.9", "lon": "115.8", "display_name": "Perth"}
    ]"#;
    let places = parse_places(body).unwrap();
    assert_eq!(places.len(), 2);
    assert_eq!(places[0], Place { name: "Paris, France".to_string(), lat: 48.8588897, lon: 2.3200410 });
    assert_eq!(places[1].name, "Perth");
    assert!(parse_places(b"pas du json").is_err());
}
