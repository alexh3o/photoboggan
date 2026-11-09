//! Tests of faces.rs: reading face regions from XMP packets (MWG written by ExifTool or Exiv2, Microsoft, priority, unnamed faces).
//! Database side: tests/faces_db.rs.

use super::*;

#[test]
fn reads_mwg_written_by_exiftool_as_top_left() {
    let xml = r#"<rdf:Description rdf:about='' xmlns:mwg-rs='http://www.metadataworkinggroup.com/schemas/regions/' xmlns:stArea='http://ns.adobe.com/xmp/sType/Area#'>
  <mwg-rs:Regions rdf:parseType='Resource'><mwg-rs:RegionList><rdf:Bag><rdf:li rdf:parseType='Resource'>
   <mwg-rs:Area rdf:parseType='Resource'><stArea:h>0.2</stArea:h><stArea:unit>normalized</stArea:unit><stArea:w>0.1</stArea:w><stArea:x>0.5</stArea:x><stArea:y>0.4</stArea:y></mwg-rs:Area>
   <mwg-rs:Name>birdy</mwg-rs:Name><mwg-rs:Type>Face</mwg-rs:Type></rdf:li></rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions></rdf:Description>"#;
    let regions = mwg_regions(xml);
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].name.as_deref(), Some("birdy"));
    assert!((regions[0].x - 0.45).abs() < 1e-9 && (regions[0].y - 0.3).abs() < 1e-9);
}

#[test]
fn reads_mwg_written_by_exiv2_in_attributes() {
    let xml = r#"<rdf:Description rdf:about="" xmlns:mwg-rs="http://www.metadataworkinggroup.com/schemas/regions/" xmlns:stArea="http://ns.adobe.com/xmp/sType/Area#" xmlns:x="adobe:ns:meta/">
  <mwg-rs:Regions rdf:parseType="Resource"><mwg-rs:RegionList><rdf:Bag>
   <rdf:li><rdf:Description mwg-rs:Name="Jean &amp; Co" mwg-rs:Type="Face"><mwg-rs:Area stArea:x="0.5" stArea:y="0.5" stArea:w="0.2" stArea:h="0.2" stArea:unit="normalized"/></rdf:Description></rdf:li>
   <rdf:li><rdf:Description mwg-rs:Type="Focus"><mwg-rs:Area stArea:x="0.5" stArea:y="0.5" stArea:w="0.2" stArea:h="0.2" stArea:unit="normalized"/></rdf:Description></rdf:li>
  </rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions></rdf:Description>"#;
    let regions = mwg_regions(xml);
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].name.as_deref(), Some("Jean & Co"));
    assert!((regions[0].x - 0.4).abs() < 1e-9);
}

#[test]
fn reads_microsoft_rectangle_and_respects_priority() {
    let xml = r#"<rdf:Description xmlns:MP='http://ns.microsoft.com/photo/1.2/' xmlns:MPRI='http://ns.microsoft.com/photo/1.2/t/RegionInfo#' xmlns:MPReg='http://ns.microsoft.com/photo/1.2/t/Region#'>
  <MP:RegionInfo rdf:parseType='Resource'><MPRI:Regions><rdf:Bag><rdf:li rdf:parseType='Resource'>
   <MPReg:PersonDisplayName>birdy</MPReg:PersonDisplayName><MPReg:Rectangle>0.71164, 0.242312, 0.099537, 0.144097</MPReg:Rectangle>
  </rdf:li></rdf:Bag></MPRI:Regions></MP:RegionInfo></rdf:Description>"#;
    let regions = mp_regions(xml);
    assert_eq!(regions.len(), 1);
    assert!((regions[0].x - 0.71164).abs() < 1e-9 && (regions[0].h - 0.144097).abs() < 1e-9);
    // Aucun MWG dans ce paquet : le format suivant (Microsoft) est retenu.
    assert_eq!(parse_regions(xml), regions);
}

#[test]
fn keeps_unnamed_faces() {
    let xml = r#"<rdf:Description xmlns:mwg-rs='http://www.metadataworkinggroup.com/schemas/regions/' xmlns:stArea='http://ns.adobe.com/xmp/sType/Area#'>
  <mwg-rs:Regions rdf:parseType='Resource'><mwg-rs:RegionList><rdf:Bag><rdf:li rdf:parseType='Resource'>
   <mwg-rs:Area rdf:parseType='Resource'><stArea:h>0.2</stArea:h><stArea:w>0.1</stArea:w><stArea:x>0.5</stArea:x><stArea:y>0.4</stArea:y></mwg-rs:Area>
   <mwg-rs:Type>Face</mwg-rs:Type></rdf:li></rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions></rdf:Description>"#;
    let regions = mwg_regions(xml);
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].name, None);
}
