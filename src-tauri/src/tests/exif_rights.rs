//! Tests de l'auteur et des droits (exif.rs) : écriture XMP et IPTC d'un JPEG par le chemin interne, relecture, structure `CreatorContactInfo`
//! conservée, langues alternatives effacées, vérification après écriture. Fichiers synthétiques dans un dossier temporaire.
//! Les ordres de priorité sont globaux (partagés entre les tests) : ils ne sont pas modifiés ici, `resolve_text` est testé avec ses propres paramètres.

use super::*;
use crate::test_support::*;

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
fn xmp_rights_are_written_in_every_scheme_and_read_back() {
    let xml = update_xmp_rights(EMPTY_XMP_PACKET, &update("Ada; Bob", "© 2026 Ada & Bob", "Agence <X>", "Usage libre", "ada@example.org"));
    assert!(xml.contains("<dc:creator><rdf:Seq><rdf:li>Ada</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>"), "{xml}");
    assert!(xml.contains("<tiff:Artist>Ada; Bob</tiff:Artist>"), "{xml}");
    assert!(xml.contains("<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">© 2026 Ada &amp; Bob</rdf:li></rdf:Alt></dc:rights>"), "{xml}");
    assert!(xml.contains("<tiff:Copyright><rdf:Alt><rdf:li xml:lang=\"x-default\">© 2026 Ada &amp; Bob</rdf:li>"), "{xml}");
    assert!(xml.contains("<photoshop:Credit>Agence &lt;X&gt;</photoshop:Credit>"), "{xml}");
    assert!(xml.contains("<xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang=\"x-default\">Usage libre</rdf:li>"), "{xml}");
    assert!(xml.contains("<Iptc4xmpCore:CiEmailWork>ada@example.org</Iptc4xmpCore:CiEmailWork>"), "{xml}");

    assert_eq!(xmp_creators(&xml).as_deref(), Some("Ada; Bob"));
    assert_eq!(xmp_text(&xml, "tiff:Artist").as_deref(), Some("Ada; Bob"));
    assert_eq!(xmp_text(&xml, "dc:rights").as_deref(), Some("© 2026 Ada & Bob"));
    assert_eq!(xmp_text(&xml, "tiff:Copyright").as_deref(), Some("© 2026 Ada & Bob"));
    assert_eq!(xmp_text(&xml, "photoshop:Credit").as_deref(), Some("Agence <X>"));
    assert_eq!(xmp_text(&xml, "xmpRights:UsageTerms").as_deref(), Some("Usage libre"));
    assert_eq!(parse_contact_info(&xml).map(|contact| contact.email).as_deref(), Some("ada@example.org"));
}

#[test]
fn fields_left_as_none_are_untouched_and_empty_fields_are_removed() {
    let full = update_xmp_rights(EMPTY_XMP_PACKET, &update("Ada", "© Ada", "Agence", "Libre", "ada@example.org"));
    // Only the credit is changed.
    let credit_only = update_xmp_rights(&full, &MetadataUpdate { credit: Some("Autre".into()), ..Default::default() });
    assert_eq!(xmp_text(&credit_only, "photoshop:Credit").as_deref(), Some("Autre"));
    assert_eq!(xmp_creators(&credit_only).as_deref(), Some("Ada"));
    assert_eq!(xmp_text(&credit_only, "xmpRights:UsageTerms").as_deref(), Some("Libre"));
    // Everything emptied: every scheme is removed, the contact structure included (it held only the e-mail).
    let emptied = update_xmp_rights(&full, &update("", "", "", "", ""));
    for name in ["dc:creator", "tiff:Artist", "dc:rights", "tiff:Copyright", "photoshop:Credit", "xmpRights:UsageTerms", "CreatorContactInfo"] {
        assert!(!emptied.contains(name), "{name} still there: {emptied}");
    }
    // Nothing to write and no packet: no packet is created.
    assert_eq!(update_xmp_rights("", &update("", "", "", "", "")), "");
    assert_eq!(update_xmp_rights("", &MetadataUpdate::default()), "");
}

#[test]
fn rights_replace_attribute_forms_written_by_other_software() {
    let xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" \
               xmlns:tiff=\"http://ns.adobe.com/tiff/1.0/\" xmlns:photoshop=\"http://ns.adobe.com/photoshop/1.0/\" tiff:Artist=\"Ancien\" photoshop:Credit=\"Vieux crédit\"/>\
               </rdf:RDF></x:xmpmeta>";
    assert_eq!(xmp_text(xml, "tiff:Artist").as_deref(), Some("Ancien"));
    let updated = update_xmp_rights(xml, &MetadataUpdate { author: Some("Nouveau".into()), credit: Some("Nouveau crédit".into()), ..Default::default() });
    assert!(!updated.contains("Ancien") && !updated.contains("Vieux"), "{updated}");
    assert_eq!(xmp_text(&updated, "tiff:Artist").as_deref(), Some("Nouveau"));
    assert_eq!(xmp_text(&updated, "photoshop:Credit").as_deref(), Some("Nouveau crédit"));
    assert_eq!(updated.matches("xmlns:photoshop=").count(), 1, "namespace declared twice: {updated}");
}

#[test]
fn other_languages_of_rights_and_usage_terms_are_erased_but_tiff_copyright_translations_are_kept() {
    let seed = packet_with(
        "<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">Old</rdf:li><rdf:li xml:lang=\"fr\">Ancien</rdf:li></rdf:Alt></dc:rights>\
         <tiff:Copyright><rdf:Alt><rdf:li xml:lang=\"x-default\">Old</rdf:li><rdf:li xml:lang=\"fr\">Ancien tiff</rdf:li></rdf:Alt></tiff:Copyright>\
         <xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang=\"x-default\">Old</rdf:li><rdf:li xml:lang=\"de\">Alt</rdf:li></rdf:Alt></xmpRights:UsageTerms>",
        &[("dc", DC_NS), ("tiff", TIFF_NS), ("xmpRights", XMP_RIGHTS_NS)],
    );
    let updated = update_xmp_rights(&seed, &MetadataUpdate { copyright: Some("New".into()), usage_terms: Some("Neuf".into()), ..Default::default() });
    assert!(!updated.contains("Ancien</rdf:li></rdf:Alt></dc:rights>") && !updated.contains(">Alt<"), "{updated}");
    assert_eq!(xml_dc_rights_languages(&updated), 1, "dc:rights must only keep x-default: {updated}");
    assert!(updated.contains("Ancien tiff"), "tiff:Copyright translation lost: {updated}");
    assert_eq!(xmp_text(&updated, "dc:rights").as_deref(), Some("New"));
    assert_eq!(xmp_text(&updated, "xmpRights:UsageTerms").as_deref(), Some("Neuf"));
    // Emptied: removed with every language.
    let removed = update_xmp_rights(&updated, &MetadataUpdate { copyright: Some(String::new()), ..Default::default() });
    assert!(!removed.contains("dc:rights") && !removed.contains("Ancien tiff"), "{removed}");
}

/// Number of `rdf:li` items of the `dc:rights` property.
fn xml_dc_rights_languages(xml: &str) -> usize {
    let start = xml.find("<dc:rights>").unwrap();
    let end = start + xml[start..].find("</dc:rights>").unwrap();
    xml[start..end].matches("<rdf:li").count()
}

#[test]
fn creator_contact_info_is_read_and_its_other_fields_are_kept() {
    let seed = packet_with(
        "<Iptc4xmpCore:CreatorContactInfo rdf:parseType=\"Resource\"><Iptc4xmpCore:CiAdrCity>Paris</Iptc4xmpCore:CiAdrCity>\
         <Iptc4xmpCore:CiTelWork>+33 1 23</Iptc4xmpCore:CiTelWork><Iptc4xmpCore:CiUrlWork>https://exemple.fr</Iptc4xmpCore:CiUrlWork></Iptc4xmpCore:CreatorContactInfo>",
        &[("Iptc4xmpCore", IPTC_CORE_NS)],
    );
    let contact = parse_contact_info(&seed).unwrap();
    assert_eq!((contact.city.as_str(), contact.phone.as_str(), contact.url.as_str(), contact.email.as_str()), ("Paris", "+33 1 23", "https://exemple.fr", ""));

    let with_email = update_xmp_rights(&seed, &MetadataUpdate { author_email: Some("a@b.fr".into()), ..Default::default() });
    let contact = parse_contact_info(&with_email).unwrap();
    assert_eq!((contact.city.as_str(), contact.phone.as_str(), contact.url.as_str(), contact.email.as_str()), ("Paris", "+33 1 23", "https://exemple.fr", "a@b.fr"));
    assert_eq!(with_email.matches("CreatorContactInfo rdf:parseType").count(), 1, "structure duplicated: {with_email}");

    // E-mail removed: the rest of the structure stays.
    let without = update_xmp_rights(&with_email, &MetadataUpdate { author_email: Some(String::new()), ..Default::default() });
    let contact = parse_contact_info(&without).unwrap();
    assert_eq!((contact.city.as_str(), contact.email.as_str()), ("Paris", ""));
}

#[test]
fn creator_contact_info_written_as_nested_description_attributes_is_read_and_rewritten() {
    let seed = packet_with(
        "<Iptc4xmpCore:CreatorContactInfo><rdf:Description Iptc4xmpCore:CiEmailWork=\"vieux@exemple.fr\" Iptc4xmpCore:CiAdrCtry=\"France\" Iptc4xmpCore:CiAdrPcode=\"75001\"/></Iptc4xmpCore:CreatorContactInfo>",
        &[("Iptc4xmpCore", IPTC_CORE_NS)],
    );
    let contact = parse_contact_info(&seed).unwrap();
    assert_eq!((contact.email.as_str(), contact.country.as_str(), contact.postal_code.as_str()), ("vieux@exemple.fr", "France", "75001"));
    let updated = update_xmp_rights(&seed, &MetadataUpdate { author_email: Some("neuf@exemple.fr".into()), ..Default::default() });
    let contact = parse_contact_info(&updated).unwrap();
    assert_eq!((contact.email.as_str(), contact.country.as_str(), contact.postal_code.as_str()), ("neuf@exemple.fr", "France", "75001"));
    assert!(!updated.contains("vieux@exemple.fr"), "{updated}");
}

#[test]
fn jpeg_rights_round_trip_through_xmp_and_iptc_without_touching_pixels() {
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(40, 30);
    let path = dir.path().join("a.jpg");
    fs::write(&path, &original).unwrap();
    let long_credit = "Crédit très long qui dépasse largement les trente-deux octets de l'IPTC";
    let rights = update("Ada Lovelace; Bob", "© 2026 Ada Lovelace", long_credit, "Usage libre avec mention", "ada@example.org");
    write_metadata_internal(&path.to_string_lossy(), &rights).unwrap();

    let written = fs::read(&path).unwrap();
    assert_eq!(scan_data(&written), scan_data(&original), "les données d'image ont changé");
    let meta = read_exif(&path);
    assert_eq!(meta.rights.author, "Ada Lovelace; Bob");
    assert_eq!(meta.rights.copyright, "© 2026 Ada Lovelace");
    assert_eq!(meta.rights.credit, long_credit);
    assert_eq!(meta.rights.usage_terms, "Usage libre avec mention");
    assert_eq!(meta.rights.author_email, "ada@example.org");
    let sources = &meta.rights_sources;
    assert_eq!((sources.author[0].as_deref(), sources.author[1].as_deref(), sources.author[2].as_deref()), (Some("Ada Lovelace; Bob"), Some("Ada Lovelace; Bob"), Some("Ada Lovelace; Bob")));
    assert_eq!((sources.copyright[0].as_deref(), sources.copyright[1].as_deref(), sources.copyright[2].as_deref()), (Some("© 2026 Ada Lovelace"), Some("© 2026 Ada Lovelace"), Some("© 2026 Ada Lovelace")));
    // IPTC Credit holds 32 bytes at most, the XMP value is whole.
    assert_eq!(sources.credit[0].as_deref(), Some(long_credit));
    let iptc_credit = sources.credit[1].as_deref().unwrap();
    assert!(iptc_credit.len() <= 32 && long_credit.starts_with(iptc_credit), "{iptc_credit}");
    // The internal writer never writes the EXIF block.
    assert_eq!((sources.author[3].as_deref(), sources.copyright[3].as_deref()), (None, None));

    // Emptied: every source is cleared.
    write_metadata_internal(&path.to_string_lossy(), &update("", "", "", "", "")).unwrap();
    let meta = read_exif(&path);
    assert_eq!(meta.rights, Rights::default());
    assert!(meta.rights_sources.author.iter().all(Option::is_none) && meta.rights_sources.copyright.iter().all(Option::is_none));
    assert_eq!(scan_data(&fs::read(&path).unwrap()), scan_data(&original));
}

#[test]
fn iptc_by_lines_are_one_dataset_per_author_and_other_datasets_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.jpg");
    fs::write(&path, jpeg_bytes(16, 16)).unwrap();
    // A title and keywords first: the rights write must leave them (and the character set declaration) alone.
    let first = MetadataUpdate { title: Some("Titre".into()), keywords: Some(paths(&[&["Paris"]])), ..Default::default() };
    write_metadata_internal(&path.to_string_lossy(), &first).unwrap();
    write_metadata_internal(&path.to_string_lossy(), &MetadataUpdate { author: Some("Ada; Bob; Zoé".into()), ..Default::default() }).unwrap();
    let meta = read_exif(&path);
    assert_eq!(meta.title, "Titre");
    assert_eq!(meta.keywords, "Paris");
    assert_eq!(meta.rights_sources.author[2].as_deref(), Some("Ada; Bob; Zoé"));
    // Raw datasets: three By-line (2:80) entries.
    let data = fs::read(&path).unwrap();
    let datasets = jpeg_segments(&data)
        .filter(|segment| segment.marker == 0xed)
        .flat_map(|segment| {
            let (resources, _) = parse_photoshop_resources(&segment.content(&data)[PHOTOSHOP_HEADER.len()..]);
            resources.into_iter().filter(|resource| resource.id == IPTC_RESOURCE_ID).flat_map(|resource| parse_iptc_datasets(&resource.data).unwrap())
        })
        .collect::<Vec<_>>();
    assert_eq!(datasets.iter().filter(|dataset| dataset.record == 2 && dataset.dataset == 80).count(), 3);
    let numbers: Vec<u8> = datasets.iter().filter(|dataset| dataset.record == 2).map(|dataset| dataset.dataset).collect();
    let mut sorted_numbers = numbers.clone();
    sorted_numbers.sort();
    assert_eq!(numbers, sorted_numbers, "IPTC datasets out of order");
}

#[test]
fn rights_are_written_to_a_sidecar_for_other_formats_and_verified() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.png");
    fs::write(&path, png_bytes(8, 8)).unwrap();
    let rights = update("Ada", "© Ada", "Agence", "Libre", "ada@example.org");
    write_metadata_internal(&path.to_string_lossy(), &rights).unwrap();
    assert!(dir.path().join("p.png.xmp").is_file(), "the rights went to the sidecar");
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
