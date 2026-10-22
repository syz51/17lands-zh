use mtga_card_cache::{
    db::{REFRESH_SECONDS, RETRY_SECONDS, Reader, Writer},
    model::*,
};
use std::{
    sync::{Arc, Barrier, mpsc},
    thread,
    time::Duration,
};
use tempfile::TempDir;

const ID: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const ORACLE: &str = "33333333-3333-4333-8333-333333333333";
fn face(side: FaceSide, lang: Language, name: &str) -> LocalizedFace {
    LocalizedFace {
        face: side,
        lang,
        name: Some(name.into()),
        type_line: Some("生物".into()),
        rules_text: Some("飞行".into()),
        image_url: Some("https://cards.scryfall.io/normal/front/1/1/image.jpg".into()),
        image_kind: ImageKind::Exact,
        source: "fixture".into(),
        source_url: Some("https://example.com/source".into()),
        localized_printing_id: None,
    }
}
fn card(name: &str) -> CardRecord {
    CardRecord {
        printing_id: ID.into(),
        oracle_id: Some(ORACLE.into()),
        english_name: name.into(),
        set_code: "tst".into(),
        collector_number: "1".into(),
        layout: "transform".into(),
        faces: vec![
            face(FaceSide::Front, Language::Zhs, "正面"),
            face(FaceSide::Back, Language::Zhs, "背面"),
            face(FaceSide::Front, Language::Zht, "正體"),
            face(FaceSide::Back, Language::Zht, "背體"),
        ],
    }
}
fn setup() -> (TempDir, std::path::PathBuf, Writer) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("cards.sqlite");
    let writer = Writer::open(&path).unwrap();
    (dir, path, writer)
}
#[test]
fn languages_faces_and_alternate_preserve_requested_identity() {
    let (_dir, path, mut writer) = setup();
    let mut record = card("English");
    record.faces[0].image_kind = ImageKind::Alternate;
    record.faces[0].localized_printing_id = Some(OTHER.into());
    writer
        .publish_snapshot_at(100, |sink| sink.insert(&record))
        .unwrap();
    let mut reader = Reader::open(path).unwrap();
    assert_eq!(reader.journal_mode().unwrap(), "wal");
    let response = reader.cards(&[ID.into()], Language::Zhs).unwrap();
    let found = &response.cards[0];
    assert_eq!(found.printing_id, ID);
    assert_eq!(found.oracle_id.as_deref(), Some(ORACLE));
    assert_eq!(found.faces.len(), 2);
    assert_eq!(found.faces[0].name_zh.as_deref(), Some("正面"));
    assert_eq!(found.faces[0].image_kind, ImageKind::Alternate);
    assert_eq!(found.faces[1].image_kind, ImageKind::Exact);
    assert_eq!(found.faces[1].face, FaceSide::Back);
    let traditional = reader.cards(&[ID.into()], Language::Zht).unwrap();
    assert_eq!(
        traditional.cards[0].faces[0].name_zh.as_deref(),
        Some("正體")
    );
    assert_eq!(
        traditional.cards[0].faces[1].name_zh.as_deref(),
        Some("背體")
    );
}
#[test]
fn missing_localization_does_not_reuse_other_language_or_face() {
    let (_dir, path, mut writer) = setup();
    let mut record = card("English");
    record.faces.truncate(1);
    writer.publish_snapshot(|s| s.insert(&record)).unwrap();
    let mut reader = Reader::open(path).unwrap();
    let simplified = reader.cards(&[ID.into()], Language::Zhs).unwrap();
    assert_eq!(
        simplified.cards[0].faces[1].image_kind,
        ImageKind::Unavailable
    );
    let traditional = reader.cards(&[ID.into()], Language::Zht).unwrap();
    assert!(
        traditional.cards[0]
            .faces
            .iter()
            .all(|face| face.name_zh.is_none() && face.image_url.is_none())
    );
}
#[test]
fn empty_failed_and_swallowed_insert_errors_never_publish() {
    let (_dir, path, mut writer) = setup();
    writer
        .publish_snapshot_at(100, |sink| sink.insert(&card("old")))
        .unwrap();
    assert!(
        writer
            .publish_snapshot_at(200, |sink| {
                sink.insert(&card("partial"))?;
                anyhow::bail!("truncated download")
            })
            .is_err()
    );
    assert!(writer.publish_snapshot_at(300, |_| Ok(())).is_err());
    assert!(
        writer
            .publish_snapshot_at(400, |sink| {
                sink.insert(&card("duplicate"))?;
                let _ = sink.insert(&card("duplicate"));
                Ok(())
            })
            .is_err()
    );
    let mut reader = Reader::open(&path).unwrap();
    let response = reader.cards(&[ID.into()], Language::Zhs).unwrap();
    assert_eq!(response.revision, "1");
    assert_eq!(response.cards[0].english_name, "old");
    let status = reader.status().unwrap();
    assert_eq!(status.refresh_state, "failed");
    assert!(status.last_error.is_some());
    assert_eq!(writer.last_attempt_at().unwrap(), Some(400));
    drop(writer);
    let reopened = Writer::open(path).unwrap();
    assert_eq!(reopened.status().unwrap().revision, "1");
    assert_eq!(reopened.last_attempt_at().unwrap(), Some(400));
}
#[test]
fn concurrent_publication_provides_complete_old_or_new_batches() {
    let (_dir, path, mut writer) = setup();
    writer
        .publish_snapshot(|sink| {
            sink.insert(&card("old"))?;
            let mut second = card("old");
            second.printing_id = OTHER.into();
            sink.insert(&second)
        })
        .unwrap();
    let barrier = Arc::new(Barrier::new(5));
    let (staged_tx, staged_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let writer_thread = thread::spawn(move || {
        writer
            .publish_snapshot(|sink| {
                sink.insert(&card("new"))?;
                staged_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                let mut second = card("new");
                second.printing_id = OTHER.into();
                sink.insert(&second)
            })
            .unwrap();
    });
    staged_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let readers: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let mut reader = Reader::open(path).unwrap();
                let old = reader
                    .cards(&[ID.into(), OTHER.into()], Language::Zhs)
                    .unwrap();
                assert_eq!(old.revision, "1");
                assert!(old.cards.iter().all(|c| c.english_name == "old"));
                barrier.wait();
                for _ in 0..100 {
                    let batch = reader
                        .cards(&[ID.into(), OTHER.into()], Language::Zhs)
                        .unwrap();
                    assert_eq!(batch.cards.len(), 2);
                    assert!(batch.missing.is_empty());
                    let expected = if batch.revision == "1" {
                        "old"
                    } else {
                        assert_eq!(batch.revision, "2");
                        "new"
                    };
                    assert!(batch.cards.iter().all(|c| c.english_name == expected));
                }
            })
        })
        .collect();
    barrier.wait();
    release_tx.send(()).unwrap();
    writer_thread.join().unwrap();
    for reader in readers {
        reader.join().unwrap();
    }
    assert_eq!(Reader::open(path).unwrap().status().unwrap().revision, "2");
}
#[test]
fn writer_lock_is_exclusive_across_processes_and_released_on_drop() {
    let (_dir, path, writer) = setup();
    assert!(Writer::open(&path).is_err());
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_mtga-card-cache"))
        .args(["import", "--db"])
        .arg(&path)
        .arg("missing.jsonl")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("exclusive lock"));
    drop(writer);
    assert!(Writer::open(path).is_ok());
}
#[test]
fn persistent_daily_schedule_backoff_and_interrupted_attempt() {
    let (_dir, path, mut writer) = setup();
    assert!(writer.refresh_due_at(1).unwrap());
    writer
        .publish_snapshot_at(100, |sink| sink.insert(&card("initial")))
        .unwrap();
    assert!(!writer.refresh_due_at(100 + REFRESH_SECONDS - 1).unwrap());
    assert!(writer.refresh_due_at(100 + REFRESH_SECONDS).unwrap());
    writer.mark_attempt_at(100 + REFRESH_SECONDS).unwrap();
    drop(writer);
    let mut writer = Writer::open(path).unwrap();
    assert_eq!(writer.status().unwrap().refresh_state, "failed");
    assert!(
        !writer
            .refresh_due_at(100 + REFRESH_SECONDS + RETRY_SECONDS - 1)
            .unwrap()
    );
    assert!(
        writer
            .refresh_due_at(100 + REFRESH_SECONDS + RETRY_SECONDS)
            .unwrap()
    );
    writer
        .publish_snapshot_at(100 + REFRESH_SECONDS + RETRY_SECONDS, |s| {
            s.insert(&card("fresh"))
        })
        .unwrap();
    assert_eq!(writer.status().unwrap().refresh_state, "idle");
}
#[test]
fn invalid_input_cannot_inject_sql_or_publish_forged_alternates() {
    let (_dir, path, mut writer) = setup();
    let mut record = card("Robert'); DROP TABLE printings;--");
    writer
        .publish_snapshot(|sink| sink.insert(&record))
        .unwrap();
    let mut reader = Reader::open(path).unwrap();
    assert_eq!(
        reader.cards(&[ID.into()], Language::Zhs).unwrap().cards[0].english_name,
        record.english_name
    );
    assert!(
        reader
            .cards(&["'; DROP TABLE printings;--".into()], Language::Zhs)
            .is_err()
    );
    record.faces[0].image_kind = ImageKind::Alternate;
    assert!(
        writer
            .publish_snapshot(|sink| sink.insert(&record))
            .is_err()
    );
    assert_eq!(reader.status().unwrap().revision, "1");
}
#[test]
fn reads_do_not_change_refresh_metadata_or_database() {
    let (_dir, path, mut writer) = setup();
    writer
        .publish_snapshot_at(100, |s| s.insert(&card("stable")))
        .unwrap();
    let mut reader = Reader::open(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    for _ in 0..10 {
        reader
            .cards(&[OTHER.into(), ID.into()], Language::Zht)
            .unwrap();
        reader.status().unwrap();
    }
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert_eq!(writer.last_attempt_at().unwrap(), Some(100));
}
#[test]
fn unchanged_source_check_persists_freshness_without_generation_rewrite() {
    let (_dir, path, mut writer) = setup();
    assert!(writer.set_source_revision("release1:hash").is_err());
    assert!(writer.mark_source_checked_at("release1:hash", 100).is_err());
    writer
        .publish_snapshot_at(100, |s| s.insert(&card("release1")))
        .unwrap();
    writer.set_source_revision("release1:hash").unwrap();
    writer.mark_attempt_at(100 + REFRESH_SECONDS).unwrap();
    assert!(
        writer
            .mark_source_checked_at("wrong", 101 + REFRESH_SECONDS)
            .is_err()
    );
    writer
        .mark_source_checked_at("release1:hash", 102 + REFRESH_SECONDS)
        .unwrap();
    let status = writer.status().unwrap();
    assert_eq!(status.revision, "1");
    assert_eq!(status.refresh_state, "idle");
    assert!(
        !writer
            .refresh_due_at(102 + 2 * REFRESH_SECONDS - 1)
            .unwrap()
    );
    let mut reader = Reader::open(&path).unwrap();
    assert_eq!(
        reader.cards(&[ID.into()], Language::Zhs).unwrap().cards[0].updated_at,
        jiff::Timestamp::from_second(100).unwrap().to_string()
    );
    drop(writer);
    let mut writer = Writer::open(path).unwrap();
    assert_eq!(
        writer.source_revision().unwrap().as_deref(),
        Some("release1:hash")
    );
    writer
        .publish_snapshot_at(103 + REFRESH_SECONDS, |s| s.insert(&card("release2")))
        .unwrap();
    assert_eq!(writer.source_revision().unwrap(), None);
    assert!(writer.mark_source_checked("release1:hash").is_err());
}
