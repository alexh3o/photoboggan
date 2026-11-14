//! Photos privées : ensembles de confidentialité. Un ensemble actif masque, partout où le backend lit le catalogue, les photos qui répondent
//! à AU MOINS UN de ses critères (OU entre critères) :
//! - parties de chemin de dossier : élément complet (« confidential » = `/Confidential/`, pas `/notConfidential/`) ou partiel (sous-chaîne
//!   du chemin du dossier). Le nom du fichier n'est jamais comparé ;
//! - mots-clés : correspondance exacte avec un mot-clé actif de la photo (dernier niveau, voir keywords.rs) ;
//! - plages de dates inclusives : date de prise de vue, ou à défaut date du fichier (voir `date_taken_digits` / `file_date_digits`).
//! Tous les textes se comparent sans tenir compte de la casse (ASCII dans le chemin : `lower` de SQLite ; Unicode pour les mots-clés).
//!
//! L'ensemble ACTIF est une donnée de l'interface (réglages en localStorage), envoyée ici au démarrage et à chaque changement
//! (`set_privacy_sets`), comme les autres réglages gardés en statique côté Rust : il repart vide à chaque lancement, donc rien n'est masqué
//! tant que l'interface ne l'a pas envoyé. Le test SQL (`visible_condition`) ne contient aucun paramètre : les textes sont insérés comme
//! littéraux (apostrophes doublées), ce qui permet de l'ajouter à n'importe quelle requête sans renuméroter ses paramètres.

use serde::Deserialize;
use std::sync::RwLock;

/// Un critère de chemin : texte (la casse et les « / » de bord sont normalisés ici), complet (élément de chemin entier) ou partiel (sous-chaîne).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PathCriterion {
    pub text: String,
    pub partial: bool,
}

/// Plage de dates inclusive. Bornes au format `YYYYMMDDHHmmss` (une date incomplète couvre toute sa période : « 2024 » va du 1er janvier
/// 2024 à la fin de l'année) ; une borne vide est ouverte.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct DateRange {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacySet {
    pub paths: Vec<PathCriterion>,
    pub keywords: Vec<String>,
    pub date_ranges: Vec<DateRange>,
}

impl PrivacySet {
    /// Sans critère exploitable, l'ensemble ne masque rien.
    fn is_empty(&self) -> bool {
        self.paths.iter().all(|path| clean_path_text(&path.text).is_empty())
            && self.keywords.iter().all(|keyword| keyword.trim().is_empty())
            && self.date_ranges.iter().all(|range| digits(&range.start).is_empty() && digits(&range.end).is_empty())
    }
}

static ACTIVE: RwLock<Option<PrivacySet>> = RwLock::new(None);

fn read_active() -> Option<PrivacySet> {
    ACTIVE.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// Ensembles actifs (liste vide : confidentialité désactivée ou « Off »), envoyés par l'interface au démarrage et à chaque changement.
/// Leurs critères se cumulent : une photo est masquée dès qu'elle répond à un critère de l'un d'eux (le OU de tous les critères).
#[tauri::command]
pub fn set_privacy_sets(sets: Vec<PrivacySet>) {
    let mut merged = PrivacySet::default();
    for set in sets {
        merged.paths.extend(set.paths);
        merged.keywords.extend(set.keywords);
        merged.date_ranges.extend(set.date_ranges);
    }
    *ACTIVE.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = if merged.is_empty() { None } else { Some(merged) };
}

/// Vrai si un ensemble qui masque quelque chose est actif (sert à interdire la suppression de dossiers).
pub fn is_active() -> bool {
    read_active().is_some()
}

/// Clés de comparaison des mots-clés (même règle que `keywords::name_key` : espaces de bord retirés, minuscules).
fn keyword_keys(set: &PrivacySet) -> Vec<String> {
    let mut keys: Vec<String> = set.keywords.iter().map(|keyword| crate::keywords::name_key(keyword)).filter(|key| !key.is_empty()).collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Texte de critère de chemin : minuscules, « \ » devenu « / », « / » de bord retirés.
fn clean_path_text(text: &str) -> String {
    text.trim().to_lowercase().replace('\\', "/").trim_matches('/').to_string()
}

fn digits(text: &str) -> String {
    text.chars().filter(|character| character.is_ascii_digit()).collect()
}

/// Littéral SQL texte : apostrophes doublées, caractères NUL retirés.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\0', "").replace('\'', "''"))
}

/// Date de prise de vue réduite à 14 chiffres `YYYYMMDDHHmmss` (« 2024:05:01 12:00:00 », « 2024-05-01T12:00:00 »… ; complétée par des zéros).
fn date_taken_digits(prefix: &str) -> String {
    format!(
        "substr(replace(replace(replace(replace(substr({prefix}date_taken, 1, 19), '-', ''), ':', ''), ' ', ''), 'T', '') || '00000000000000', 1, 14)"
    )
}

/// Date du fichier au même format : date de création (`created`, ms depuis 1970) si elle est connue, sinon date de modification (`modified`) tant que
/// la collection n'a pas été relue depuis l'ajout de la colonne `created`.
fn file_date_digits(prefix: &str) -> String {
    format!(
        "(CASE WHEN COALESCE({prefix}created, 0) > 0 OR COALESCE({prefix}modified, 0) > 0 THEN strftime('%Y%m%d%H%M%S', \
         (CASE WHEN COALESCE({prefix}created, 0) > 0 THEN {prefix}created ELSE {prefix}modified END) / 1000, 'unixepoch', 'localtime') END)"
    )
}

/// Borne de début complétée à 14 chiffres par des zéros (« 2024 » → « 20240000000000 » : toute l'année est ≥).
fn pad_start(value: &str) -> String {
    format!("{value:0<14}").chars().take(14).collect()
}

/// Borne de fin complétée à 14 chiffres par des 9 (« 2024 » → « 20249999999999 » : toute l'année est ≤).
fn pad_end(value: &str) -> String {
    format!("{value:9<14}").chars().take(14).collect()
}

/// Test SQL « cette photo est privée » d'un ensemble, `prefix` étant celui des colonnes de `photos` (« » ou « p. »). None : rien à tester.
/// Chaque critère est enveloppé dans `COALESCE(…, 0)` : un NULL (photo sans date…) ne doit jamais faire disparaître la photo par `NOT (NULL)`.
fn private_test(set: &PrivacySet, prefix: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();

    // Dossier de la photo : chemin normalisé en minuscules et en « / », privé de son dernier segment (le nom du fichier).
    let normalized = format!("lower(replace({prefix}path, char(92), '/'))");
    let folder = format!("rtrim({normalized}, replace({normalized}, '/', ''))");
    for criterion in &set.paths {
        let text = clean_path_text(&criterion.text);
        if text.is_empty() {
            continue;
        }
        if criterion.partial {
            parts.push(format!("COALESCE(instr({folder}, {}) > 0, 0)", quote(&text)));
        } else {
            // « /texte/ » entier : le « / » ajouté devant le chemin permet de reconnaître aussi un premier niveau.
            parts.push(format!("COALESCE(instr('/' || {folder}, {}) > 0, 0)", quote(&format!("/{text}/"))));
        }
    }

    let keys = keyword_keys(set);
    if !keys.is_empty() {
        let list: Vec<String> = keys.iter().map(|key| quote(key)).collect();
        parts.push(format!(
            "EXISTS (SELECT 1 FROM photo_keywords pk JOIN keyword_nodes kn ON kn.id = pk.keyword_id WHERE pk.photo_id = {prefix}id AND kn.name_key IN ({}))",
            list.join(", ")
        ));
    }

    // Une photo datée se compare par sa date de prise de vue (même test que `db::DATED`), sinon par la date du fichier.
    let date = format!("(CASE WHEN {prefix}date_taken >= '1000' THEN {} ELSE {} END)", date_taken_digits(prefix), file_date_digits(prefix));
    for range in &set.date_ranges {
        let (start, end) = (digits(&range.start), digits(&range.end));
        let mut tests = Vec::new();
        if !start.is_empty() {
            tests.push(format!("{date} >= {}", quote(&pad_start(&start))));
        }
        if !end.is_empty() {
            tests.push(format!("{date} <= {}", quote(&pad_end(&end))));
        }
        if !tests.is_empty() {
            parts.push(format!("COALESCE({}, 0)", tests.join(" AND ")));
        }
    }

    if parts.is_empty() { None } else { Some(parts.join(" OR ")) }
}

/// Condition SQL à ajouter (avec AND) aux requêtes qui lisent `photos` : « les photos que l'ensemble actif ne masque pas ». Vaut « 1 » sans
/// ensemble actif. `prefix` : préfixe des colonnes (« » pour `photos` seule, « p. » pour une table aliasée `p`).
pub fn visible_condition(prefix: &str) -> String {
    match read_active().and_then(|set| private_test(&set, prefix)) {
        Some(test) => format!("NOT ({test})"),
        None => "1".to_string(),
    }
}

/// SQL des identifiants des personnes masquées : celles dont le mot-clé lié (`persons.keyword_node_id`) est un mot-clé de l'ensemble actif.
/// None si aucun mot-clé n'est masqué.
pub fn hidden_persons_sql() -> Option<String> {
    let keys = read_active().map(|set| keyword_keys(&set)).unwrap_or_default();
    if keys.is_empty() {
        return None;
    }
    let list: Vec<String> = keys.iter().map(|key| quote(key)).collect();
    Some(format!(
        "SELECT id FROM persons WHERE keyword_node_id IN (SELECT id FROM keyword_nodes WHERE name_key IN ({}))",
        list.join(", ")
    ))
}

/// Condition SQL « `column` (identifiant de personne) n'est pas une personne masquée » ; vaut « 1 » si aucune ne l'est.
pub fn visible_person_condition(column: &str) -> String {
    match hidden_persons_sql() {
        Some(sql) => format!("COALESCE({column} NOT IN ({sql}), 1)"),
        None => "1".to_string(),
    }
}

/// Le dossier (chemin du disque) est-il masqué par un critère de CHEMIN de l'ensemble actif ? Les dossiers dont toutes les photos sont masquées
/// par un mot-clé ou une date ne sont pas concernés : ils disparaissent de l'arbre parce qu'ils n'ont plus de photo, ou y restent en style
/// « dossier vide » si « Afficher les dossiers vides » est coché.
pub fn is_private_folder(path: &str) -> bool {
    let Some(set) = read_active() else { return false };
    let folder = format!("/{}/", path.trim().to_lowercase().replace('\\', "/").trim_matches('/'));
    set.paths.iter().any(|criterion| {
        let text = clean_path_text(&criterion.text);
        if text.is_empty() {
            false
        } else if criterion.partial {
            folder.contains(&text)
        } else {
            folder.contains(&format!("/{text}/"))
        }
    })
}

/// Mots-clés masqués par l'ensemble actif (clés en minuscules) : l'interface les retire des listes de filtres de mots-clés,
/// mais pas des panneaux de saisie.
#[tauri::command]
pub fn get_privacy_hidden_keywords() -> Vec<String> {
    read_active().map(|set| keyword_keys(&set)).unwrap_or_default()
}
