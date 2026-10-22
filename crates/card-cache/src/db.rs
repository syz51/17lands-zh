use crate::model::*;
use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use std::{
    fs::{File, OpenOptions},
    path::Path,
    time::Duration,
};

pub const REFRESH_SECONDS: i64 = 86_400;
pub const RETRY_SECONDS: i64 = 3_600;
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS generations(id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL, card_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cache_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), current_generation INTEGER REFERENCES generations(id), last_attempt INTEGER, last_success INTEGER, next_refresh INTEGER, refresh_state TEXT NOT NULL, last_error TEXT);
INSERT OR IGNORE INTO cache_state(singleton,refresh_state) VALUES(1,'never');
CREATE TABLE IF NOT EXISTS source_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE, source_revision TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oracles(generation INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE, oracle_id TEXT NOT NULL, PRIMARY KEY(generation,oracle_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS printings(generation INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE, printing_id TEXT NOT NULL, oracle_id TEXT, english_name TEXT NOT NULL, set_code TEXT NOT NULL, collector_number TEXT NOT NULL, layout TEXT NOT NULL, PRIMARY KEY(generation,printing_id), FOREIGN KEY(generation,oracle_id) REFERENCES oracles(generation,oracle_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS faces(generation INTEGER NOT NULL, printing_id TEXT NOT NULL, face TEXT NOT NULL CHECK(face IN ('front','back')), PRIMARY KEY(generation,printing_id,face), FOREIGN KEY(generation,printing_id) REFERENCES printings(generation,printing_id) ON DELETE CASCADE) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS provenance(id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_url TEXT NOT NULL, UNIQUE(source,source_url));
CREATE TABLE IF NOT EXISTS localized_faces(generation INTEGER NOT NULL, printing_id TEXT NOT NULL, face TEXT NOT NULL, lang TEXT NOT NULL CHECK(lang IN ('zhs','zht')), name TEXT, type_line TEXT, rules_text TEXT, image_url TEXT, image_kind TEXT NOT NULL CHECK(image_kind IN ('exact','alternate','unavailable')), localized_printing_id TEXT, provenance_id INTEGER NOT NULL REFERENCES provenance(id), PRIMARY KEY(generation,printing_id,face,lang), FOREIGN KEY(generation,printing_id,face) REFERENCES faces(generation,printing_id,face) ON DELETE CASCADE) WITHOUT ROWID;
PRAGMA user_version=1;
"#;

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(2))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;")?;
    conn.set_prepared_statement_cache_capacity(12);
    Ok(())
}
pub fn now_seconds() -> i64 {
    jiff::Timestamp::now().as_second()
}
fn timestamp(value: i64) -> Result<String> {
    Ok(jiff::Timestamp::from_second(value)?.to_string())
}

/// Sole write capability. Keep this object on the refresh OS thread for its entire lifetime.
pub struct Writer {
    // Fields drop in declaration order: close SQLite before releasing the writer lock.
    conn: Connection,
    _lock: WriterLock,
}

struct WriterLock(File);

impl Drop for WriterLock {
    fn drop(&mut self) {
        // A concurrent process spawn may temporarily inherit the descriptor.
        // Closing only our File would keep flock held until that child execs.
        let _ = FileExt::unlock(&self.0);
    }
}
impl Writer {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        lock.try_lock_exclusive()
            .context("card-cache writer already running (exclusive lock)")?;
        let lock = WriterLock(lock);
        let conn = Connection::open(path)?;
        configure(&conn)?;
        let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        ensure!(mode == "wal", "WAL unavailable");
        conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=8388608;")?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!(
            version <= SCHEMA_VERSION,
            "database schema newer than this server"
        );
        conn.execute_batch(SCHEMA)?;
        conn.execute("UPDATE cache_state SET refresh_state='failed',last_error='previous refresh interrupted' WHERE refresh_state='refreshing'", [])?;
        Ok(Self { conn, _lock: lock })
    }
    pub fn status(&self) -> Result<Status> {
        read_status(&self.conn)
    }
    pub fn refresh_due_at(&self, now: i64) -> Result<bool> {
        let next: Option<i64> =
            self.conn
                .query_row("SELECT next_refresh FROM cache_state", [], |r| r.get(0))?;
        Ok(next.is_none_or(|next| now >= next))
    }
    pub fn mark_attempt_at(&mut self, now: i64) -> Result<()> {
        self.conn.execute("UPDATE cache_state SET last_attempt=?1,next_refresh=max(coalesce(last_success+?2,0),?1+?3),refresh_state='refreshing',last_error=NULL", params![now,REFRESH_SECONDS,RETRY_SECONDS])?;
        Ok(())
    }
    pub fn last_attempt_at(&self) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row("SELECT last_attempt FROM cache_state", [], |r| r.get(0))?)
    }
    /// Identity of the provider release backing the CURRENT published generation.
    pub fn source_revision(&self) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT source_revision FROM source_state WHERE generation=(SELECT current_generation FROM cache_state)", [], |r|r.get(0)).optional()?)
    }
    /// Call after successful publication. Publishing another generation invalidates it.
    pub fn set_source_revision(&mut self, revision: &str) -> Result<()> {
        ensure!(
            !revision.is_empty() && revision.len() <= 4096,
            "invalid source revision"
        );
        let changed=self.conn.execute("INSERT INTO source_state(singleton,generation,source_revision) SELECT 1,g.id,?1 FROM cache_state s JOIN generations g ON g.id=s.current_generation WHERE g.card_count>0 ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,source_revision=excluded.source_revision", [revision])?;
        ensure!(
            changed == 1,
            "cannot associate a source release with an empty cache"
        );
        Ok(())
    }
    /// Caller has rechecked the upstream release identity; no card rows are rewritten.
    pub fn mark_source_checked(&mut self, revision: &str) -> Result<()> {
        self.mark_source_checked_at(revision, now_seconds())
    }
    pub fn mark_source_checked_at(&mut self, revision: &str, now: i64) -> Result<()> {
        let changed=self.conn.execute("UPDATE cache_state SET last_success=?1,next_refresh=?1+?2,refresh_state='idle',last_error=NULL WHERE current_generation IN (SELECT generation FROM source_state WHERE source_revision=?3)", params![now,REFRESH_SECONDS,revision])?;
        ensure!(
            changed == 1,
            "source identity does not match a published snapshot"
        );
        Ok(())
    }
    pub fn mark_failed(&mut self, message: &str) -> Result<()> {
        let message: String = message.chars().take(2000).collect();
        self.conn.execute(
            "UPDATE cache_state SET refresh_state='failed',last_error=?1",
            [message],
        )?;
        Ok(())
    }
    pub fn publish_snapshot<F>(&mut self, load: F) -> Result<String>
    where
        F: FnOnce(&mut SnapshotSink<'_>) -> Result<()>,
    {
        self.publish_snapshot_at(now_seconds(), load)
    }
    pub fn publish_snapshot_at<F>(&mut self, now: i64, load: F) -> Result<String>
    where
        F: FnOnce(&mut SnapshotSink<'_>) -> Result<()>,
    {
        self.mark_attempt_at(now)?;
        let result = self.publish_inner(now, load);
        if let Err(error) = &result {
            self.mark_failed(&format!("{error:#}"))?;
        }
        result
    }
    fn publish_inner<F>(&mut self, now: i64, load: F) -> Result<String>
    where
        F: FnOnce(&mut SnapshotSink<'_>) -> Result<()>,
    {
        let tx = self.conn.transaction()?;
        let generation: i64 =
            tx.query_row("SELECT coalesce(max(id),0)+1 FROM generations", [], |r| {
                r.get(0)
            })?;
        tx.execute(
            "INSERT INTO generations(id,updated_at) VALUES(?1,?2)",
            params![generation, timestamp(now)?],
        )?;
        let mut sink = SnapshotSink {
            tx: &tx,
            generation,
            count: 0,
            poisoned: false,
        };
        load(&mut sink)?;
        ensure!(!sink.poisoned, "snapshot contains a rejected record");
        ensure!(sink.count > 0, "refusing empty snapshot");
        tx.execute(
            "UPDATE generations SET card_count=?1 WHERE id=?2",
            params![sink.count, generation],
        )?;
        tx.execute("UPDATE cache_state SET current_generation=?1,last_success=?2,next_refresh=?2+?3,refresh_state='idle',last_error=NULL", params![generation,now,REFRESH_SECONDS])?;
        tx.execute("DELETE FROM generations WHERE id<>?1", [generation])?;
        tx.execute(
            "DELETE FROM provenance WHERE id NOT IN (SELECT provenance_id FROM localized_faces)",
            [],
        )?;
        tx.commit()?;
        // Passive checkpoint never waits for active read snapshots. WAL remains valid while readers finish.
        if let Err(error) = self.conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);") {
            eprintln!("card-cache passive checkpoint postponed: {error}");
        }
        Ok(generation.to_string())
    }
}

pub struct SnapshotSink<'a> {
    tx: &'a Transaction<'a>,
    generation: i64,
    count: u64,
    poisoned: bool,
}
impl SnapshotSink<'_> {
    pub fn insert(&mut self, record: &CardRecord) -> Result<()> {
        let result = self.insert_inner(record);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn insert_inner(&mut self, record: &CardRecord) -> Result<()> {
        let id = printing_id(&record.printing_id)?;
        let oracle = record.oracle_id.as_deref().map(printing_id).transpose()?;
        ensure!(
            !record.english_name.is_empty() && record.english_name.len() <= 1024,
            "invalid english_name"
        );
        ensure!(
            record.set_code.len() <= 32
                && record.collector_number.len() <= 64
                && record.layout.len() <= 64,
            "card fields too large"
        );
        ensure!(
            record.faces.len() <= 4,
            "at most two faces in two languages"
        );
        if let Some(oracle) = &oracle {
            self.tx
                .prepare_cached("INSERT OR IGNORE INTO oracles VALUES(?1,?2)")?
                .execute(params![self.generation, oracle])?;
        }
        self.tx
            .prepare_cached("INSERT INTO printings VALUES(?1,?2,?3,?4,?5,?6,?7)")?
            .execute(params![
                self.generation,
                id,
                oracle,
                record.english_name,
                record.set_code,
                record.collector_number,
                record.layout
            ])?;
        self.tx
            .prepare_cached("INSERT INTO faces VALUES(?1,?2,'front')")?
            .execute(params![self.generation, id])?;
        if record.faces.iter().any(|f| f.face == FaceSide::Back)
            || matches!(
                record.layout.as_str(),
                "transform" | "modal_dfc" | "double_faced_token" | "reversible_card" | "meld"
            )
        {
            self.tx
                .prepare_cached("INSERT INTO faces VALUES(?1,?2,'back')")?
                .execute(params![self.generation, id])?;
        }
        for face in &record.faces {
            for text in [
                &face.name,
                &face.type_line,
                &face.rules_text,
                &face.image_url,
                &face.source_url,
            ]
            .into_iter()
            .flatten()
            {
                ensure!(text.len() <= 32_768, "localized field too large");
            }
            ensure!(
                !face.source.is_empty() && face.source.len() <= 256,
                "invalid provenance"
            );
            let localized_id = face
                .localized_printing_id
                .as_deref()
                .map(printing_id)
                .transpose()?;
            match face.image_kind {
                ImageKind::Unavailable => {
                    ensure!(face.image_url.is_none(), "unavailable image must be null")
                }
                ImageKind::Exact => ensure!(face.image_url.is_some(), "exact image requires URL"),
                ImageKind::Alternate => ensure!(
                    face.image_url.is_some()
                        && oracle.is_some()
                        && localized_id.as_ref().is_some_and(|other| other != &id),
                    "alternate requires distinct localized UUID and oracle identity"
                ),
            }
            if let Some(image) = &face.image_url {
                let url = url::Url::parse(image)?;
                ensure!(
                    url.scheme() == "https"
                        && url.host_str().is_some()
                        && url.username().is_empty()
                        && url.password().is_none(),
                    "image requires HTTPS URL without credentials"
                );
            }
            self.tx
                .prepare_cached(
                    "INSERT OR IGNORE INTO provenance(source,source_url) VALUES(?1,?2)",
                )?
                .execute(params![
                    face.source,
                    face.source_url.as_deref().unwrap_or("")
                ])?;
            self.tx.prepare_cached("INSERT INTO localized_faces VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,(SELECT id FROM provenance WHERE source=?11 AND source_url=?12))")?.execute(params![self.generation,id,face.face.as_str(),face.lang.as_str(),face.name,face.type_line,face.rules_text,face.image_url,face.image_kind.as_str(),localized_id,face.source,face.source_url.as_deref().unwrap_or("")])?;
        }
        self.count += 1;
        Ok(())
    }
}

pub struct Reader {
    conn: Connection,
}
impl Reader {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        configure(&conn)?;
        conn.execute_batch("PRAGMA query_only=ON;")?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!(version == SCHEMA_VERSION, "database schema unavailable");
        Ok(Self { conn })
    }
    pub fn status(&self) -> Result<Status> {
        read_status(&self.conn)
    }
    pub fn journal_mode(&self) -> Result<String> {
        Ok(self
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))?)
    }
    pub fn cards(&mut self, ids: &[String], lang: Language) -> Result<CardsResponse> {
        ensure!(ids.len() <= 100, "maximum batch is 100 IDs");
        let ids: Vec<String> = ids
            .iter()
            .map(|id| printing_id(id))
            .collect::<Result<_>>()?;
        let tx = self.conn.transaction()?;
        let status = read_status(&tx)?;
        let generation = status.revision.parse::<i64>()?;
        let mut cards = Vec::new();
        let mut missing = Vec::new();
        for id in ids {
            let card = tx.prepare_cached("SELECT p.oracle_id,p.english_name,p.set_code,p.collector_number,p.layout,g.updated_at FROM printings p JOIN generations g ON g.id=p.generation WHERE p.generation=?1 AND p.printing_id=?2")?.query_row(params![generation,id], |r| Ok(Card { printing_id:id.clone(),oracle_id:r.get(0)?,english_name:r.get(1)?,set_code:r.get(2)?,collector_number:r.get(3)?,layout:r.get(4)?,faces:Vec::new(),updated_at:r.get(5)? })).optional()?;
            if let Some(mut card) = card {
                let mut stmt = tx.prepare_cached("SELECT f.face,l.name,l.type_line,l.rules_text,l.image_url,coalesce(l.image_kind,'unavailable'),coalesce(p.source,'unavailable'),nullif(p.source_url,'') FROM faces f LEFT JOIN localized_faces l ON l.generation=f.generation AND l.printing_id=f.printing_id AND l.face=f.face AND l.lang=?3 LEFT JOIN provenance p ON p.id=l.provenance_id WHERE f.generation=?1 AND f.printing_id=?2 ORDER BY CASE f.face WHEN 'front' THEN 0 ELSE 1 END")?;
                card.faces = stmt
                    .query_map(params![generation, id, lang.as_str()], |r| {
                        let side: String = r.get(0)?;
                        let kind: String = r.get(5)?;
                        Ok(Face {
                            face: if side == "front" {
                                FaceSide::Front
                            } else {
                                FaceSide::Back
                            },
                            name_zh: r.get(1)?,
                            type_line_zh: r.get(2)?,
                            oracle_text_zh: r.get(3)?,
                            image_url: r.get(4)?,
                            image_kind: match kind.as_str() {
                                "exact" => ImageKind::Exact,
                                "alternate" => ImageKind::Alternate,
                                _ => ImageKind::Unavailable,
                            },
                            source: r.get(6)?,
                            source_url: r.get(7)?,
                        })
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                cards.push(card);
            } else {
                missing.push(id);
            }
        }
        tx.commit()?;
        Ok(CardsResponse {
            schema_version: SCHEMA_VERSION,
            revision: status.revision,
            cards,
            missing,
        })
    }
}
fn read_status(conn: &Connection) -> Result<Status> {
    let (generation,count,success,next,state,error): (i64,u64,Option<i64>,Option<i64>,String,Option<String>) = conn.query_row("SELECT coalesce(s.current_generation,0),coalesce(g.card_count,0),s.last_success,s.next_refresh,s.refresh_state,s.last_error FROM cache_state s LEFT JOIN generations g ON g.id=s.current_generation WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    if generation < 0 {
        bail!("invalid database generation");
    }
    Ok(Status {
        schema_version: SCHEMA_VERSION,
        revision: generation.to_string(),
        ready: count > 0,
        card_count: count,
        last_success_at: success.map(timestamp).transpose()?,
        next_refresh_at: next.map(timestamp).transpose()?,
        refresh_state: state,
        last_error: error,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn writer_drop_releases_lock_while_duplicate_descriptor_remains_open() {
        let directory = tempfile::TempDir::new().unwrap();
        let path = directory.path().join("cards.sqlite");
        let writer = Writer::open(&path).unwrap();
        // dup and fork retain the same open file description and flock.
        // Keep a duplicate alive to reproduce the pre-exec inheritance window
        // deterministically, without forking a multithreaded test process.
        let inherited = writer._lock.0.try_clone().unwrap();
        assert!(Writer::open(&path).is_err());

        drop(writer);
        let reopened = Writer::open(&path).unwrap();
        drop(inherited);
        assert!(Writer::open(&path).is_err());
        drop(reopened);
        assert!(Writer::open(path).is_ok());
    }
}
