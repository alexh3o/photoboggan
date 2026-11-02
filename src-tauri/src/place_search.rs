//! Recherche d'un lieu par son nom (mode Carte, champ de recherche de la barre de la carte), pour aller y placer la carte.
//!
//! Fournisseur : Nominatim (OpenStreetMap), sans clé. Sa politique d'usage demande un User-Agent propre à l'application, au plus une requête par
//! seconde et aucune saisie automatique : la recherche n'est lancée qu'à la validation. Tout ce qui dépend du fournisseur (adresse, format de la
//! réponse) est réuni ici : en changer, c'est modifier `SEARCH_URL` et `parse_places`. La requête part du backend (jamais de la WebView) et est
//! refusée en mode hors ligne, comme les autres accès au réseau.

use serde::Serialize;
use std::time::Duration;

const SEARCH_URL: &str = "https://nominatim.openstreetmap.org/search";
const MAX_RESULTS: usize = 6;
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct Place {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

/// Texte encodé pour une adresse (tout octet hors lettres, chiffres et « -_.~ » est codé « %XX »).
fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) { out.push(byte as char); } else { out.push_str(&format!("%{byte:02X}")); }
    }
    out
}

/// Lieux d'une réponse JSON de Nominatim (`format=jsonv2`) ; les entrées sans coordonnées valides sont ignorées.
fn parse_places(body: &[u8]) -> Result<Vec<Place>, String> {
    let entries: Vec<serde_json::Value> = serde_json::from_slice(body).map_err(|error| format!("Réponse du service de recherche illisible : {error}"))?;
    let number = |entry: &serde_json::Value, key: &str| entry.get(key).and_then(|value| value.as_str()).and_then(|text| text.parse::<f64>().ok());
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let (lat, lon) = crate::exif::valid_gps(number(entry, "lat")?, number(entry, "lon")?)?;
            let name = entry.get("display_name").and_then(|value| value.as_str()).unwrap_or_default().to_string();
            Some(Place { name, lat, lon })
        })
        .take(MAX_RESULTS)
        .collect())
}

/// Lieux correspondant au texte. Erreur « internet_disabled » en mode hors ligne.
#[tauri::command]
pub async fn search_places(query: String) -> Result<Vec<Place>, String> {
    let query = query.trim().to_string();
    if query.is_empty() { return Ok(Vec::new()); }
    if !crate::face_models::internet_allowed() { return Err("internet_disabled".to_string()); }
    tokio::task::spawn_blocking(move || {
        let url = format!("{SEARCH_URL}?q={}&format=jsonv2&limit={MAX_RESULTS}", percent_encode(&query));
        let response = ureq::get(&url)
            .header("User-Agent", &format!("photoboggan/{} (place search)", env!("CARGO_PKG_VERSION")))
            .config()
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(15)))
            .http_status_as_error(false)
            .build()
            .call()
            .map_err(|error| error.to_string())?;
        if response.status().as_u16() != 200 { return Err(format!("HTTP {}", response.status().as_u16())); }
        let body = response.into_body().with_config().limit(MAX_RESPONSE_BYTES).read_to_vec().map_err(|error| error.to_string())?;
        parse_places(&body)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "tests/place_search.rs"]
mod tests;
