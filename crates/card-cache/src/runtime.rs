//! One refresh owner, durable daily scheduling, and a bounded immutable archive cache.
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    db::{Writer, now_seconds},
    refresh::{self, RefreshReport, ReleaseDescriptor},
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, Serialize)]
pub struct RefreshOutcome {
    pub outcome: &'static str,
    pub revision: String,
    pub source_revision: Option<String>,
    pub report: Option<RefreshReport>,
}

fn archive_matches(path: &Path, release: &ReleaseDescriptor) -> Result<bool> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() != release.compressed_size {
        return Ok(false);
    }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(hex(&digest.finalize()).eq_ignore_ascii_case(&release.sha256))
}

fn cached_archive(
    directory: &Path,
    release: &ReleaseDescriptor,
    supplied: Option<&Path>,
) -> Result<PathBuf> {
    ensure!(
        release.sha256.len() == 64 && release.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid archive digest"
    );
    ensure!(
        (1..=256 * 1024 * 1024).contains(&release.compressed_size),
        "archive outside size limit"
    );
    fs::create_dir_all(directory)?;
    let path = directory.join(format!("{}.tar.gz", release.sha256.to_ascii_lowercase()));
    if archive_matches(&path, release)? {
        return Ok(path);
    }
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    if let Some(supplied) = supplied {
        ensure!(
            archive_matches(supplied, release)?,
            "provided archive does not match latest release size/SHA256"
        );
        std::io::copy(&mut File::open(supplied)?, &mut staged)?;
    } else {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .ip_family(ureq::config::IpFamily::Ipv4Only)
            .timeout_global(Some(Duration::from_secs(300)))
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_body(Some(Duration::from_secs(60)))
            .build()
            .into();
        let mut response = agent
            .get(&release.asset_url)
            .header(
                "User-Agent",
                "mtga-card-cache/0.1 (local Chinese card display)",
            )
            .header("Accept", "application/octet-stream")
            .call()?;
        let copied = std::io::copy(
            &mut response
                .body_mut()
                .as_reader()
                .take(release.compressed_size + 1),
            &mut staged,
        )?;
        ensure!(
            copied == release.compressed_size,
            "download size does not match published release"
        );
    }
    staged.flush()?;
    ensure!(
        archive_matches(staged.path(), release)?,
        "archive SHA256 mismatch"
    );
    staged.as_file().sync_all()?;
    staged.persist(&path).map_err(|error| error.error)?;
    Ok(path)
}

pub fn refresh_once(
    writer: &mut Writer,
    database: &Path,
    force: bool,
    supplied_archive: Option<&Path>,
) -> Result<RefreshOutcome> {
    if !force && !writer.refresh_due_at(now_seconds())? {
        return Ok(RefreshOutcome {
            outcome: "not_due",
            revision: writer.status()?.revision,
            source_revision: writer.source_revision()?,
            report: None,
        });
    }
    // Persist retry policy BEFORE networking, so process restarts cannot create a retry storm.
    writer.mark_attempt_at(now_seconds())?;
    let result = (|| -> Result<RefreshOutcome> {
        let release = refresh::resolve_latest()?;
        let directory = database.parent().unwrap_or(Path::new(".")).join("upstream");
        let archive = cached_archive(&directory, &release, supplied_archive)?;
        // Archive parsing and rate-limited image inventory happen on a scratch database,
        // before opening the short publication transaction on the live database.
        let prepared = refresh::prepare_archive(&archive, &release)?;
        let source_revision = prepared.source_revision();
        if writer.source_revision()?.as_deref() == Some(&source_revision) {
            writer.mark_source_checked(&source_revision)?;
            return Ok(RefreshOutcome {
                outcome: "unchanged",
                revision: writer.status()?.revision,
                source_revision: Some(source_revision),
                report: None,
            });
        }
        let mut report = None;
        let revision = writer.publish_snapshot(|sink| {
            report = Some(prepared.emit(&mut |card| sink.insert(&card))?);
            Ok(())
        })?;
        writer.set_source_revision(&source_revision)?;
        // Only this owner touches the archive cache, and only known hash-named files
        // are evicted after a successful publication. Dataset snapshots remain in SQLite.
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let removable = name.strip_suffix(".tar.gz").is_some_and(|hash| {
                    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
                });
                if removable && entry.path() != archive {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(RefreshOutcome {
            outcome: "published",
            revision,
            source_revision: Some(source_revision),
            report,
        })
    })();
    if let Err(error) = &result {
        writer.mark_failed(&format!("{error:#}"))?;
    }
    result
}

/// The returned handle holds the only writable connection for the server's lifetime.
/// OS process exit terminates an in-progress refresh; SQLite rolls it back and the
/// persisted attempt schedules the next retry. No HTTP request can invoke this worker.
pub fn start_worker(mut writer: Writer, database: PathBuf) -> Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("card-cache-refresh".into())
        .spawn(move || {
            loop {
                match refresh_once(&mut writer, &database, false, None) {
                    Ok(outcome) if outcome.outcome != "not_due" => {
                        match serde_json::to_string(&outcome) {
                            Ok(json) => eprintln!("card-cache refresh {json}"),
                            Err(error) => eprintln!("card-cache refresh report failed: {error}"),
                        }
                    }
                    Err(error) => eprintln!("card-cache refresh failed: {error:#}"),
                    _ => {}
                }
                std::thread::sleep(Duration::from_secs(60));
            }
        })
        .context("could not start the unique refresh worker")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_cache_reuses_only_complete_matching_content() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let input = directory.path().join("input.bin");
        fs::write(&input, b"immutable archive bytes")?;
        let release = ReleaseDescriptor {
            tag: "test".into(),
            asset_url: "https://invalid.example/never-called".into(),
            sha256: hex(&Sha256::digest(b"immutable archive bytes")),
            compressed_size: b"immutable archive bytes".len() as u64,
        };
        let cache = directory.path().join("cache");
        let path = cached_archive(&cache, &release, Some(&input))?;
        assert!(archive_matches(&path, &release)?);
        fs::remove_file(&input)?;
        assert_eq!(cached_archive(&cache, &release, None)?, path);
        fs::write(&path, b"different archive bytes")?;
        assert!(!archive_matches(&path, &release)?);
        Ok(())
    }
}
