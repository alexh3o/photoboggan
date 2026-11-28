//! Tests des arguments `ExifTool` de l'auteur et des droits (exiftool.rs) : seuls les arguments sont vérifiés ici, `ExifTool` n'est pas lancé.
//! Un JPEG reçoit aussi l'IPTC et l'EXIF ; les autres formats (sidecar XMP) ne reçoivent que le XMP.

use super::*;
use crate::exif::MetadataUpdate;

fn rights(author: &str, copyright: &str, credit: &str, usage_terms: &str, author_email: &str) -> MetadataUpdate {
    MetadataUpdate {
        author: Some(author.into()),
        copyright: Some(copyright.into()),
        credit: Some(credit.into()),
        usage_terms: Some(usage_terms.into()),
        author_email: Some(author_email.into()),
        ..Default::default()
    }
}

fn has(args: &[String], expected: &str) -> bool {
    args.iter().any(|arg| arg == expected)
}

#[test]
fn a_jpeg_gets_xmp_iptc_and_exif_rights() {
    let args = metadata_args(Path::new("a.jpg"), &rights("Ada; Bob", "© 2026 Ada", "Agence", "Usage libre", "ada@example.org"));
    for expected in [
        "-XMP-dc:Creator=Ada", "-XMP-dc:Creator=Bob", "-XMP-tiff:Artist=Ada; Bob", "-IPTC:By-line=Ada", "-IPTC:By-line=Bob", "-EXIF:Artist=Ada; Bob",
        "-XMP-dc:Rights=© 2026 Ada", "-XMP-tiff:Copyright-x-default=© 2026 Ada", "-IPTC:CopyrightNotice=© 2026 Ada", "-EXIF:Copyright=(c) 2026 Ada",
        "-XMP-photoshop:Credit=Agence", "-IPTC:Credit=Agence", "-XMP-xmpRights:UsageTerms=Usage libre", "-XMP-iptcCore:CreatorWorkEmail=ada@example.org",
    ] {
        assert!(has(&args, expected), "missing {expected}: {args:?}");
    }
    // Non-ASCII values in IPTC declare UTF-8.
    assert!(has(&args, "-IPTC:CodedCharacterSet=UTF8"), "{args:?}");
}

#[test]
fn other_formats_only_get_xmp_rights() {
    let args = metadata_args(Path::new("p.png"), &rights("Ada", "© Ada", "Agence", "Libre", "ada@example.org"));
    assert!(has(&args, "-XMP-dc:Creator=Ada") && has(&args, "-XMP-dc:Rights=© Ada") && has(&args, "-XMP-iptcCore:CreatorWorkEmail=ada@example.org"));
    assert!(args.iter().all(|arg| !arg.starts_with("-IPTC:") && !arg.starts_with("-EXIF:")), "{args:?}");
}

#[test]
fn empty_values_delete_the_tags_and_missing_ones_are_left_alone() {
    let args = metadata_args(Path::new("a.jpg"), &rights("", "", "", "", ""));
    for expected in [
        "-XMP-dc:Creator=", "-XMP-tiff:Artist=", "-IPTC:By-line=", "-EXIF:Artist=", "-XMP-dc:Rights=", "-XMP-tiff:Copyright=", "-IPTC:CopyrightNotice=", "-EXIF:Copyright=",
        "-XMP-photoshop:Credit=", "-IPTC:Credit=", "-XMP-xmpRights:UsageTerms=", "-XMP-iptcCore:CreatorWorkEmail=",
    ] {
        assert!(has(&args, expected), "missing {expected}: {args:?}");
    }
    let untouched = metadata_args(Path::new("a.jpg"), &MetadataUpdate { credit: Some("Agence".into()), ..Default::default() });
    assert!(untouched.iter().all(|arg| !arg.contains("Creator") && !arg.contains("Rights") && !arg.contains("Artist") && !arg.contains("Copyright")), "{untouched:?}");
}

#[test]
fn iptc_values_are_cut_to_the_length_of_the_standard() {
    let long = "é".repeat(100); // 200 bytes
    let args = metadata_args(Path::new("a.jpg"), &rights(&long, &long, &long, "", ""));
    let value_of = |tag: &str| args.iter().find_map(|arg| arg.strip_prefix(&format!("-{tag}="))).unwrap_or_default().to_string();
    assert!(value_of("IPTC:By-line").len() <= 32 && !value_of("IPTC:By-line").is_empty());
    assert!(value_of("IPTC:Credit").len() <= 32 && !value_of("IPTC:Credit").is_empty());
    assert!(value_of("IPTC:CopyrightNotice").len() <= 128 && !value_of("IPTC:CopyrightNotice").is_empty());
    // XMP and EXIF are not cut.
    assert_eq!(value_of("XMP-photoshop:Credit"), long);
}
