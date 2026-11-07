//! Tests de la vérification des mises à jour (update_check.rs) : lecture des versions et choix de la release dans une réponse GitHub. Aucun accès au réseau.

use super::*;

fn installed(text: &str) -> Version {
    parse_version(text).unwrap()
}

/// Réponse GitHub inspirée de celle du dépôt : release de modèles de visages, pré-releases, brouillon, stable récente.
const BODY: &str = r###"[
    {"tag_name": "v0.7.0-rc1", "draft": false, "prerelease": true, "body": "rc", "html_url": "https://x/v0.7.0-rc1", "published_at": "2026-11-06T10:00:00Z"},
    {"tag_name": "v0.8.0", "draft": true, "prerelease": false, "body": "brouillon", "html_url": "https://x/v0.8.0", "published_at": ""},
    {"tag_name": "v0.6.2", "draft": false, "prerelease": false, "body": "## Notes\n- correctif", "html_url": "https://x/v0.6.2", "published_at": "2026-11-04T23:09:14Z"},
    {"tag_name": "face-models-1", "draft": false, "prerelease": false, "body": "modèles", "html_url": "https://x/models", "published_at": ""},
    {"tag_name": "v0.5.0", "draft": false, "prerelease": false, "body": "", "html_url": "https://x/v0.5.0", "published_at": ""}
]"###;

#[test]
fn versions_are_parsed_from_tags_and_package_versions() {
    assert_eq!(parse_version("v0.6.2"), Some(Version { numbers: (0, 6, 2), pre: None }));
    assert_eq!(parse_version("0.6.2-beta"), Some(Version { numbers: (0, 6, 2), pre: Some("beta".to_string()) }));
    assert_eq!(parse_version("1.2.3-rc.1+build5"), Some(Version { numbers: (1, 2, 3), pre: Some("rc.1".to_string()) }));
    assert_eq!(parse_version("face-models-1"), None);
    assert_eq!(parse_version("v1.2"), None);
    assert_eq!(parse_version("v1.2.3.4"), None);
}

#[test]
fn numbers_are_compared_as_numbers_not_as_text() {
    // 0.10.0 est plus récente que 0.9.0 (une comparaison de texte dirait l'inverse).
    assert!(parse_version("0.10.0").unwrap().numbers > parse_version("0.9.0").unwrap().numbers);
}

#[test]
fn stable_installation_ignores_prereleases_drafts_and_non_app_releases() {
    let info = pick_latest(BODY.as_bytes(), &installed("0.5.0"), "0.5.0", false).unwrap();
    assert_eq!(info.latest, "0.6.2");
    assert!(info.update_available);
    assert!(!info.prerelease);
    assert_eq!(info.url, "https://x/v0.6.2");
    assert!(info.notes.contains("correctif"));
}

#[test]
fn up_to_date_installation_gets_no_update() {
    let info = pick_latest(BODY.as_bytes(), &installed("0.6.2"), "0.6.2", false).unwrap();
    assert_eq!(info.latest, "0.6.2");
    assert!(!info.update_available);
}

#[test]
fn prereleases_are_offered_on_request() {
    let info = pick_latest(BODY.as_bytes(), &installed("0.6.2"), "0.6.2", true).unwrap();
    assert_eq!(info.latest, "0.7.0");
    assert!(info.update_available);
    assert!(info.prerelease);
}

#[test]
fn beta_installation_gets_prereleases_without_asking() {
    let info = pick_latest(BODY.as_bytes(), &installed("0.6.2-beta"), "0.6.2-beta", false).unwrap();
    assert_eq!(info.latest, "0.7.0");
    assert!(info.update_available);
}

#[test]
fn beta_suffix_does_not_make_the_same_release_an_update() {
    // Le .deb Linux de la release v0.6.2 s'appelle 0.6.2-beta : ce n'est pas une mise à jour vers 0.6.2.
    let body = r#"[{"tag_name": "v0.6.2", "draft": false, "prerelease": false, "body": "", "html_url": "u", "published_at": ""}]"#;
    let info = pick_latest(body.as_bytes(), &installed("0.6.2-beta"), "0.6.2-beta", false).unwrap();
    assert!(!info.update_available);
}

#[test]
fn no_eligible_release_means_no_update_and_bad_json_is_an_error() {
    let info = pick_latest(b"[]", &installed("0.6.2"), "0.6.2", false).unwrap();
    assert!(!info.update_available);
    assert_eq!(info.latest, "0.6.2");
    assert!(pick_latest(b"pas du json", &installed("0.6.2"), "0.6.2", false).is_err());
}

// ---- Installeur : choix du fichier, téléchargement vérifié ----

const DIGEST: &str = "sha256:5391253da6f724d234f34012886779f2a3827a18f6190afda74f6246cd2b9cb3";
const PREFIX: &str = "https://github.com/alexh3o/photoboggan/releases/download/v0.7.0/";

fn release_with_assets(assets: &[(&str, &str, &str)]) -> serde_json::Value {
    let list: Vec<serde_json::Value> = assets
        .iter()
        .map(|(name, url, digest)| serde_json::json!({"name": name, "browser_download_url": url, "size": 1000, "digest": digest}))
        .collect();
    serde_json::json!({"assets": list})
}

#[test]
fn windows_takes_the_english_msi_never_the_setup_exe_and_linux_takes_the_deb() {
    // The installer is a .msi (one per language, English first); a -setup.exe is no longer offered (see AGENTS.md, updates).
    let release = release_with_assets(&[
        ("photoboggan_0.7.0-beta_amd64.deb", &format!("{PREFIX}photoboggan_0.7.0-beta_amd64.deb"), DIGEST),
        ("photoboggan_0.7.0_x64_fr-FR.msi", &format!("{PREFIX}photoboggan_0.7.0_x64_fr-FR.msi"), DIGEST),
        ("photoboggan_0.7.0_x64_en-US.msi", &format!("{PREFIX}photoboggan_0.7.0_x64_en-US.msi"), DIGEST),
        ("photoboggan_0.7.0_x64-setup.exe", &format!("{PREFIX}photoboggan_0.7.0_x64-setup.exe"), DIGEST),
    ]);
    let windows = pick_asset(&release, "windows").unwrap();
    assert_eq!(windows.name, "photoboggan_0.7.0_x64_en-US.msi");
    assert!(windows.restarts);
    assert_eq!(pick_asset(&release, "linux").unwrap().name, "photoboggan_0.7.0-beta_amd64.deb");
    assert!(!pick_asset(&release, "linux").unwrap().restarts);
    assert_eq!(pick_asset(&release, "other"), None);

    // No English MSI: another language is taken. Only a -setup.exe: nothing (the dialog points to the GitHub page).
    let french_only = release_with_assets(&[("photoboggan_0.7.0_x64_fr-FR.msi", &format!("{PREFIX}photoboggan_0.7.0_x64_fr-FR.msi"), DIGEST)]);
    assert_eq!(pick_asset(&french_only, "windows").unwrap().name, "photoboggan_0.7.0_x64_fr-FR.msi");
    let setup_only = release_with_assets(&[("photoboggan_0.7.0_x64-setup.exe", &format!("{PREFIX}photoboggan_0.7.0_x64-setup.exe"), DIGEST)]);
    assert_eq!(pick_asset(&setup_only, "windows"), None);
}

#[test]
fn unsafe_or_unverifiable_assets_are_refused() {
    let good = format!("{PREFIX}app_en-US.msi");
    // Adresse hors du dépôt, somme absente ou mal formée, nom avec séparateur : aucun installeur.
    assert_eq!(pick_asset(&release_with_assets(&[("app_en-US.msi", "https://evil.example/app_en-US.msi", DIGEST)]), "windows"), None);
    assert_eq!(pick_asset(&release_with_assets(&[("app_en-US.msi", &good, "")]), "windows"), None);
    assert_eq!(pick_asset(&release_with_assets(&[("app_en-US.msi", &good, "sha256:abc")]), "windows"), None);
    assert_eq!(pick_asset(&release_with_assets(&[("../app_en-US.msi", &good, DIGEST)]), "windows"), None);
    assert!(pick_asset(&release_with_assets(&[("app_en-US.msi", &good, DIGEST)]), "windows").is_some());
}

fn sha_of(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

#[test]
fn download_is_kept_only_when_size_and_sha256_match() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![7u8; 600_000];
    let target = dir.path().join("setup.exe");
    let cancel = AtomicBool::new(false);

    let mut counted = 0u64;
    copy_verified(&mut std::io::Cursor::new(&data), &target, data.len() as u64, &sha_of(&data), &cancel, &mut |bytes| counted += bytes).unwrap();
    assert_eq!(counted, data.len() as u64);
    assert_eq!(fs::read(&target).unwrap(), data);
    assert_eq!(file_sha256(&target).unwrap(), sha_of(&data));

    // Mauvaise somme, fichier plus court ou plus long qu'annoncé : refusé, rien ne reste (ni installeur, ni .part).
    let bad = dir.path().join("bad.exe");
    for (size, sha) in [(data.len() as u64, sha_of(b"autre")), (data.len() as u64 + 1, sha_of(&data)), (data.len() as u64 - 1, sha_of(&data))] {
        let error = copy_verified(&mut std::io::Cursor::new(&data), &bad, size, &sha, &cancel, &mut |_| {}).unwrap_err();
        assert_eq!(error, "update_corrupted");
        assert!(!bad.exists() && !bad.with_extension("part").exists());
    }
}

#[test]
fn cancelled_download_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![1u8; 1000];
    let target = dir.path().join("setup.exe");
    let cancel = AtomicBool::new(true);
    let error = copy_verified(&mut std::io::Cursor::new(&data), &target, 1000, &sha_of(&data), &cancel, &mut |_| {}).unwrap_err();
    assert_eq!(error, "cancelled");
    assert!(!target.exists() && !target.with_extension("part").exists());
}
