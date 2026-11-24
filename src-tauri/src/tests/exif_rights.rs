//! Tests de l'auteur et des droits (exif.rs) : écriture XMP et IPTC d'un JPEG par le chemin interne, relecture, structure `CreatorContactInfo`
//! conservée, langues alternatives effacées, vérification après écriture. Fichiers synthétiques dans un dossier temporaire.
//! Les ordres de priorité sont globaux (partagés entre les tests) : ils ne sont pas modifiés ici, `resolve_text` est testé avec ses propres paramètres.

use super::*;
use crate::test_support::*;

const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
const TIFF_NS: &str = "http://ns.adobe.com/tiff/1.0/";
const PHOTOSHOP_NS: &str = "http://ns.adobe.com/photoshop/1.0/";
const XMP_RIGHTS_NS: &str = "http://ns.adobe.com/xap/1.0/rights/";
const IPTC_CORE_NS: &str = "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/";

fn update(author: &str, copyright: &str, credit: &str, usage_terms: &str, author_email: &str) -> MetadataUpdate {
    MetadataUpdate {
        author: Some(author.into()),
        copyright: Some(copyright.into()),
        credit: Some(credit.into()),
        usage_terms: Some(usage_terms.into()),
        author_email: Some(author_email.into()),
        ..Default::default()
    }
}

/// Paquet XMP vide dont le `rdf:Description` contient `children`.
fn packet_with(children: &str, namespaces: &[(&str, &str)]) -> String {
    insert_description_children(EMPTY_XMP_PACKET, children, namespaces).unwrap()
}

#[test]
fn authors_are_split_on_semicolons() {
    assert_eq!(split_authors(" Ada Lovelace ;; Bob ;"), vec!["Ada Lovelace".to_string(), "Bob".to_string()]);
    assert!(split_authors("  ;  ").is_empty());
    assert_eq!(MetadataUpdate { author: Some("A;B".into()), ..Default::default() }.author_list(), Some(vec!["A".to_string(), "B".to_string()]));
    assert_eq!(MetadataUpdate::default().author_list(), None);
}

#[test]
fn creator_contact_info_is_read_and_nested_attributes_are_supported() {
    let seed = packet_with(
        "<Iptc4xmpCore:CreatorContactInfo rdf:parseType=\"Resource\"><Iptc4xmpCore:CiAdrCity>Paris</Iptc4xmpCore:CiAdrCity>\
         <Iptc4xmpCore:CiTelWork>+33 1 23</Iptc4xmpCore:CiTelWork><Iptc4xmpCore:CiUrlWork>https://exemple.fr</Iptc4xmpCore:CiUrlWork><Iptc4xmpCore:CiEmailWork>a@b.fr</Iptc4xmpCore:CiEmailWork></Iptc4xmpCore:CreatorContactInfo>",
        &[("Iptc4xmpCore", IPTC_CORE_NS)],
    );
    let contact = parse_contact_info(&seed).unwrap();
    assert_eq!((contact.city.as_str(), contact.phone.as_str(), contact.url.as_str(), contact.email.as_str()), ("Paris", "+33 1 23", "https://exemple.fr", "a@b.fr"));

    let nested = packet_with(
        "<Iptc4xmpCore:CreatorContactInfo><rdf:Description Iptc4xmpCore:CiEmailWork=\"vieux@exemple.fr\" Iptc4xmpCore:CiAdrCtry=\"France\" Iptc4xmpCore:CiAdrPcode=\"75001\"/></Iptc4xmpCore:CreatorContactInfo>",
        &[("Iptc4xmpCore", IPTC_CORE_NS)],
    );
    let contact = parse_contact_info(&nested).unwrap();
    assert_eq!((contact.email.as_str(), contact.country.as_str(), contact.postal_code.as_str()), ("vieux@exemple.fr", "France", "75001"));
}

#[test]
fn rights_are_read_from_a_sidecar_and_verified() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.png");
    fs::write(&path, png_bytes(8, 8)).unwrap();
    let xmp = packet_with(
        "<dc:creator><rdf:Seq><rdf:li>Ada</rdf:li></rdf:Seq></dc:creator>\
         <tiff:Artist>Ada</tiff:Artist>\
         <dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">© Ada</rdf:li></rdf:Alt></dc:rights>\
         <tiff:Copyright><rdf:Alt><rdf:li xml:lang=\"x-default\">© Ada</rdf:li></rdf:Alt></tiff:Copyright>\
         <photoshop:Credit>Agence</photoshop:Credit>\
         <xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang=\"x-default\">Libre</rdf:li></rdf:Alt></xmpRights:UsageTerms>\
         <Iptc4xmpCore:CreatorContactInfo rdf:parseType=\"Resource\"><Iptc4xmpCore:CiEmailWork>ada@example.org</Iptc4xmpCore:CiEmailWork></Iptc4xmpCore:CreatorContactInfo>",
        &[("dc", DC_NS), ("tiff", TIFF_NS), ("photoshop", PHOTOSHOP_NS), ("xmpRights", XMP_RIGHTS_NS), ("Iptc4xmpCore", IPTC_CORE_NS)],
    );
    fs::write(dir.path().join("p.png.xmp"), xmp).unwrap();
    let rights = update("Ada", "© Ada", "Agence", "Libre", "ada@example.org");
    let meta = read_exif(&path);
    assert_eq!(meta.rights.author, "Ada");
    assert_eq!(meta.rights.author_email, "ada@example.org");
    assert_eq!(text_mismatch(&path, &rights, &meta), None);
    // A different request is reported, with the source that differs.
    let other = update("Zoé", "© Ada", "Agence", "Libre", "ada@example.org");
    let message = text_mismatch(&path, &other, &meta).expect("mismatch not detected");
    assert!(message.contains("Auteur") && message.contains("xmp-dc"), "{message}");
    let other = MetadataUpdate { author_email: Some("autre@example.org".into()), ..Default::default() };
    assert!(text_mismatch(&path, &other, &meta).is_some_and(|message| message.contains("E-mail")));
    // Fields not requested are not checked.
    assert_eq!(text_mismatch(&path, &MetadataUpdate { title: None, ..Default::default() }, &meta), None);
}

#[test]
fn rights_priority_picks_the_first_source_that_has_a_value() {
    let values = [None, Some("B".to_string()), Some("C".to_string()), None];
    assert_eq!(resolve_text(&values, &[0, 1, 2, 3]), "B");
    assert_eq!(resolve_text(&values, &[2, 1, 0, 3]), "C");
    assert_eq!(resolve_text(&values, &[0, 3, 0, 3]), "");
}

#[test]
fn read_order_of_the_rights_fields_is_validated() {
    // Invalid requests change nothing (the priorities are global, shared with the other tests).
    for kind in ["author", "copyright", "credit", "usageTerms", "authorEmail"] {
        assert_eq!(set_read_priority(kind, &["inconnu".to_string()]), Err("invalid_order".to_string()), "{kind}");
        assert_eq!(set_read_priority(kind, &[]), Err("invalid_order".to_string()), "{kind}");
    }
    let doubled = vec!["xmp-dc".to_string(), "xmp-dc".to_string(), "iptc".to_string(), "exif".to_string()];
    assert_eq!(set_read_priority("author", &doubled), Err("invalid_order".to_string()));
    assert_eq!(set_read_priority("rights", &[]), Err("invalid_kind".to_string()));
    // Default orders: the sources of the specification, in order.
    assert_eq!(AUTHOR_SOURCE_IDS, ["xmp-dc", "xmp-tiff", "iptc", "exif"]);
    assert_eq!(COPYRIGHT_SOURCE_IDS, ["xmp-dc", "xmp-tiff", "iptc", "exif"]);
    assert_eq!(CREDIT_SOURCE_IDS, ["xmp-photoshop", "iptc"]);
}
