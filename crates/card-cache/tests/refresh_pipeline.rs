use anyhow::Result;
use flate2::{Compression, write::GzEncoder};
use mtga_card_cache::{
    db::{Reader, Writer},
    model::{FaceSide, ImageKind, Language},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};

// Also compile independently while the server worker owns lib.rs integration.
mod model {
    pub use mtga_card_cache::model::*;
}
#[allow(dead_code)]
#[path = "../src/refresh.rs"]
mod refresh;
use refresh::{ReleaseDescriptor, import_with_catalog};

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const O: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const F: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

fn archive(files: Vec<(&str, Vec<u8>)>) -> Result<(Vec<u8>, ReleaseDescriptor)> {
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut tar = tar::Builder::new(encoder);
    for (name, bytes) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, name, bytes.as_slice())?;
    }
    let bytes = tar.into_inner()?.finish()?;
    let release=ReleaseDescriptor {tag:"data-fixture".into(),asset_url:"https://github.com/HeliumOctahelide/magic-cards-zhs/releases/download/data-fixture/magic-cards-zhs-data-fixture.tar.gz".into(),sha256:Sha256::digest(&bytes).iter().map(|b|format!("{b:02x}")).collect(),compressed_size:bytes.len() as u64};
    Ok((bytes, release))
}
fn copy_rows(rows: Vec<Value>) -> Vec<u8> {
    rows.into_iter()
        .map(|r| r.to_string().replace('\\', "\\\\") + "\n")
        .collect::<String>()
        .into_bytes()
}
fn bulk(id: &str, uuid: &str, idx: i64, face: &str, layout: &str) -> Value {
    json!({"uuid":uuid,"scryfall_id":id,"face_index":idx,"face_oracle_id":face,"oracle_id":O,"name":"A // B","set_code":"FRA","collector_number":"15","layout":layout})
}
fn fixtures(extra_bulk: Vec<Value>) -> Result<(Vec<u8>, ReleaseDescriptor, Vec<u8>)> {
    let mut cards = vec![bulk(A, A, -1, F, "normal"), bulk(B, B, -1, F, "normal")];
    cards.extend(extra_bulk);
    let (bytes, release) = archive(vec![
        (
            "./zhs_oracle.json",
            copy_rows(vec![
                json!({"face_oracle_id":F,"translated_name":"明境复还","translated_type":"法术","translated_text":"第一行\\n\"引文\"","name_source":"MTGZH","text_source":"MTGZH"}),
            ]),
        ),
        (
            "./zhs_card.json",
            copy_rows(vec![
                json!({"card_id":A,"face_name":null,"name":"旧译名","type_line":"法术","text":"旧文字","source":"Chinese Simplified"}),
            ]),
        ),
        ("./scryfall_card.json", copy_rows(cards)),
    ])?;
    let page=json!({"count":1,"page":1,"page_size":1000,"total_pages":1,"items":[{"id":A,"oracle_id":O,"face_oracle_id":F,"zhs_image_uris":{"large":format!("https://images.mtgch.com/zhs/large/front/1/1/{A}.webp")},"other_faces":[]}]}).to_string().into_bytes();
    Ok((bytes, release, page))
}

#[test]
fn complete_snapshot_joins_copy_text_and_maps_alternate_identity() -> Result<()> {
    let (bytes, release, page) = fixtures(vec![])?;
    let mut cards = Vec::new();
    let report = import_with_catalog(&release, bytes.as_slice(), [page.as_slice()], &mut |card| {
        cards.push(card);
        Ok(())
    })?;
    assert_eq!(report.card_count, 2);
    assert_eq!(report.oracle_translation_rows, 1);
    assert_eq!(report.exact_image_faces, 1);
    assert_eq!(report.alternate_image_faces, 1);
    assert_eq!(cards[0].faces[0].name.as_deref(), Some("明境复还"));
    assert_eq!(
        cards[0].faces[0].rules_text.as_deref(),
        Some("第一行\n\"引文\"")
    );
    assert!(cards[0].faces[0].source.contains("MTGZH"));
    assert!(
        cards[0].faces[0]
            .source_url
            .as_deref()
            .unwrap()
            .contains("data-fixture")
    );
    assert_eq!(cards[1].printing_id, B);
    assert_eq!(cards[1].faces[0].image_kind, ImageKind::Alternate);
    assert_eq!(cards[1].faces[0].localized_printing_id.as_deref(), Some(A));
    let mut second = Vec::new();
    let again = import_with_catalog(&release, bytes.as_slice(), [page.as_slice()], &mut |card| {
        second.push(card);
        Ok(())
    })?;
    assert_eq!(report.source_revision, again.source_revision);
    Ok(())
}

#[test]
fn missing_image_remains_text_only_and_empty_catalog_is_explicit() -> Result<()> {
    let (bytes, release, _) = fixtures(vec![])?;
    let page = json!({"count":0,"page":1,"page_size":1000,"total_pages":0,"items":[]}).to_string();
    let mut cards = Vec::new();
    let report = import_with_catalog(&release, bytes.as_slice(), [page.as_bytes()], &mut |card| {
        cards.push(card);
        Ok(())
    })?;
    assert_eq!(report.unavailable_image_faces, 2);
    assert!(
        cards
            .iter()
            .all(|c| c.faces[0].image_url.is_none() && c.faces[0].name.is_some())
    );
    Ok(())
}

#[test]
fn truncated_malformed_and_duplicate_sources_never_emit() -> Result<()> {
    let (bytes, release, page) = fixtures(vec![])?;
    for length in [0, bytes.len() / 2, bytes.len() - 5] {
        let mut emitted = 0;
        assert!(
            import_with_catalog(&release, &bytes[..length], [page.as_slice()], &mut |_| {
                emitted += 1;
                Ok(())
            })
            .is_err()
        );
        assert_eq!(emitted, 0);
    }
    let mut wrong = release.clone();
    wrong.sha256 = "0".repeat(64);
    assert!(
        import_with_catalog(
            &wrong,
            bytes.as_slice(),
            [page.as_slice()],
            &mut |_| panic!("digest failed before emit")
        )
        .is_err()
    );
    let (duplicate, release, page) = fixtures(vec![bulk(A, A, -1, F, "normal")])?;
    assert!(
        import_with_catalog(
            &release,
            duplicate.as_slice(),
            [page.as_slice()],
            &mut |_| panic!("duplicate must fail before emit")
        )
        .is_err()
    );
    let (bad, release) = archive(vec![
        ("zhs_oracle.json", b"{not json}\n".to_vec()),
        ("zhs_card.json", b"{}\n".to_vec()),
        ("scryfall_card.json", b"{}\n".to_vec()),
    ])?;
    assert!(
        import_with_catalog(
            &release,
            bad.as_slice(),
            [page.as_slice()],
            &mut |_| panic!("malformed must fail before emit")
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn incomplete_or_inconsistent_catalog_never_emits() -> Result<()> {
    let (bytes, release, page) = fixtures(vec![])?;
    let mut data: Value = serde_json::from_slice(&page)?;
    data["count"] = json!(1001);
    data["total_pages"] = json!(2);
    assert!(
        import_with_catalog(
            &release,
            bytes.as_slice(),
            [data.to_string().as_bytes()],
            &mut |_| panic!("partial page")
        )
        .is_err()
    );
    assert!(
        import_with_catalog::<_, Cursor<Vec<u8>>>(&release, bytes.as_slice(), [], &mut |_| panic!(
            "missing catalog"
        ))
        .is_err()
    );
    data = serde_json::from_slice(&page)?;
    data["items"][0]["zhs_image_uris"]["large"] = json!("https://evil.invalid/image.webp");
    assert!(
        import_with_catalog(
            &release,
            bytes.as_slice(),
            [data.to_string().as_bytes()],
            &mut |_| panic!("untrusted URL")
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn oversized_line_and_missing_tar_footer_are_rejected_before_emit() -> Result<()> {
    let (bytes, release, page) = fixtures(vec![])?;
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(bytes.as_slice()).read_to_end(&mut raw)?;
    let used = raw.iter().rposition(|b| *b != 0).unwrap() + 1;
    raw.truncate(used.div_ceil(512) * 512);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw)?;
    let truncated = encoder.finish()?;
    let mut descriptor = release;
    descriptor.compressed_size = truncated.len() as u64;
    descriptor.sha256 = Sha256::digest(&truncated)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(
        import_with_catalog(
            &descriptor,
            truncated.as_slice(),
            [page.as_slice()],
            &mut |_| panic!("missing tar end marker")
        )
        .is_err()
    );
    let (bytes, release) = archive(vec![("zhs_oracle.json", vec![b' '; 2 * 1024 * 1024 + 1])])?;
    assert!(
        import_with_catalog(
            &release,
            bytes.as_slice(),
            [page.as_slice()],
            &mut |_| panic!("oversized line")
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn live_catalog_changes_revision_and_sink_errors_propagate() -> Result<()> {
    let (bytes, release, page) = fixtures(vec![])?;
    let first = import_with_catalog(&release, bytes.as_slice(), [page.as_slice()], &mut |_| {
        Ok(())
    })?;
    let mut changed: Value = serde_json::from_slice(&page)?;
    changed["items"][0]["zhs_image_uris"]["large"] = json!(format!(
        "https://images.mtgch.com/zhs/large/front/1/1/{A}.webp?ts=2"
    ));
    let second = import_with_catalog(
        &release,
        bytes.as_slice(),
        [changed.to_string().as_bytes()],
        &mut |_| Ok(()),
    )?;
    assert_ne!(first.source_revision, second.source_revision);
    let result = import_with_catalog(&release, bytes.as_slice(), [page.as_slice()], &mut |_| {
        anyhow::bail!("sink failure")
    });
    assert!(result.unwrap_err().to_string().contains("sink failure"));
    Ok(())
}

#[test]
fn writer_retains_previous_good_revision_when_source_fails() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("cards.sqlite");
    let mut writer = Writer::open(&path)?;
    let (bytes, release, page) = fixtures(vec![])?;
    writer.publish_snapshot(|sink| {
        import_with_catalog(&release, bytes.as_slice(), [page.as_slice()], &mut |card| {
            sink.insert(&card)
        })?;
        Ok(())
    })?;
    let mut reader = Reader::open(&path)?;
    let before = reader.status()?;
    let result = writer.publish_snapshot(|sink| {
        import_with_catalog(
            &release,
            &bytes[..bytes.len() - 5],
            [page.as_slice()],
            &mut |card| sink.insert(&card),
        )?;
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(reader.status()?.revision, before.revision);
    assert_eq!(
        reader.cards(&[B.into()], Language::Zhs)?.cards[0].faces[0].image_kind,
        ImageKind::Alternate
    );
    Ok(())
}

#[test]
fn split_components_share_front_but_transform_preserves_back() -> Result<()> {
    let c = "33333333-3333-4333-8333-333333333333";
    let d = "44444444-4444-4444-8444-444444444444";
    let records = vec![
        bulk(c, "55555555-5555-4555-8555-555555555555", 0, F, "split"),
        bulk(c, "66666666-6666-4666-8666-666666666666", 1, F, "split"),
        bulk(d, "77777777-7777-4777-8777-777777777777", 0, F, "transform"),
        bulk(d, "88888888-8888-4888-8888-888888888888", 1, F, "transform"),
    ];
    let (bytes, release, page) = fixtures(records)?;
    let mut cards = Vec::new();
    import_with_catalog(&release, bytes.as_slice(), [page.as_slice()], &mut |card| {
        cards.push(card);
        Ok(())
    })?;
    let split = cards.iter().find(|card| card.printing_id == c).unwrap();
    assert_eq!(split.faces.len(), 1);
    let transform = cards.iter().find(|card| card.printing_id == d).unwrap();
    assert_eq!(transform.faces.len(), 2);
    assert_eq!(transform.faces[1].face, FaceSide::Back);
    Ok(())
}

#[test]
#[ignore = "live mtgch catalog and existing local release; set MTGCH_ARCHIVE"]
fn verify_real_release_and_fra() -> Result<()> {
    let path = std::env::var("MTGCH_ARCHIVE")?;
    let release=ReleaseDescriptor { tag:"data-2026-10-18".into(),asset_url:"https://github.com/HeliumOctahelide/magic-cards-zhs/releases/download/data-2026-10-18/magic-cards-zhs-data-2026-10-18.tar.gz".into(),sha256:"09f5a743c581e210903b7f91ea246052489523139d0fc8d8f75c33d279d02ecc".into(),compressed_size:77881697 };
    let mut found_fra = false;
    let mut found_plains = false;
    let started = std::time::Instant::now();
    let report = refresh::import_archive(&path, &release, &mut |card| {
        if card.printing_id == "9e72f397-2384-40f1-882b-f627664d97df" {
            println!("FRA: {}", serde_json::to_string(&card)?);
            assert!(card.faces[0].name.is_some());
            found_fra = true;
        }
        if card.printing_id == "d5955c78-83ec-43d1-b7d6-214ab5d32ff2" {
            println!("Plains: {}", serde_json::to_string(&card)?);
            assert!(card.faces[0].image_kind != ImageKind::Exact);
            assert!(card.faces[0].name.is_some());
            found_plains = true;
        }
        Ok(())
    })?;
    assert!(found_fra && found_plains);
    assert!(report.card_count > 100_000);
    println!(
        "elapsed={:?}\n{}",
        started.elapsed(),
        serde_json::to_string_pretty(&report)?
    );
    Ok(())
}
