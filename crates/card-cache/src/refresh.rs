//! Provider ingestion. Only a writer's publication callback may consume these records.
//!
//! mtgch's public API directs bulk consumers to magic-cards-zhs (CC BY-SA 4.0).
//! The release is a tar.gz of PostgreSQL COPY-text escaped JSONL, not a JSON array.
//! Chinese images are taken only from the API's declared image inventory; no URL
//! is invented from a printing UUID. Other printings use an explicit same-face,
//! same-Oracle alternate. The bulk contains zhs; this does not promise full zht.
use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, BufRead, BufReader, Read},
    path::Path,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use flate2::read::MultiGzDecoder;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::model::{CardRecord, FaceSide, ImageKind, Language, LocalizedFace, printing_id};

pub const RELEASE_API: &str =
    "https://api.github.com/repos/HeliumOctahelide/magic-cards-zhs/releases/latest";
pub const DATA_REPOSITORY: &str = "https://github.com/HeliumOctahelide/magic-cards-zhs";
pub const DATA_LICENSE: &str =
    "https://github.com/HeliumOctahelide/magic-cards-zhs/blob/main/LICENSE-CC-BY-SA.txt";
pub const IMAGE_CATALOG: &str = "https://mtgch.com/api/v2/result";
const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_EXPANDED: u64 = 1024 * 1024 * 1024;
const MAX_LINE: usize = 2 * 1024 * 1024;
const MAX_PAGE: u64 = 32 * 1024 * 1024;
const MAX_PAGES: u64 = 1000;
const USER_AGENT: &str = "mtga-card-cache/0.1 (local Chinese card display)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseDescriptor {
    pub tag: String,
    pub asset_url: String,
    pub sha256: String,
    pub compressed_size: u64,
}

impl ReleaseDescriptor {
    /// Identifies only the immutable bulk asset. The live image catalog can change
    /// independently, so this identity alone must NOT skip a daily catalog check.
    pub fn identity(&self) -> String {
        format!("mtgch:{}:{}", self.tag, self.sha256)
    }

    pub fn same_release(&self, previous: &str) -> bool {
        self.identity() == previous
    }

    fn validate(&self) -> Result<()> {
        ensure!(
            !self.tag.is_empty() && self.tag.len() < 128,
            "invalid release tag"
        );
        ensure!(
            self.sha256.len() == 64 && self.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "release lacks SHA256 digest"
        );
        ensure!(
            self.compressed_size > 0 && self.compressed_size <= MAX_ARCHIVE,
            "release archive size outside bound"
        );
        ensure!(
            self.asset_url.starts_with(
                "https://github.com/HeliumOctahelide/magic-cards-zhs/releases/download/"
            ) && self.asset_url.ends_with(".tar.gz"),
            "unexpected release asset URL"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshReport {
    pub release: ReleaseDescriptor,
    /// Includes bulk digest AND actual image catalog contents, for no-rewrite checks.
    pub source_revision: String,
    pub card_count: u64,
    pub bulk_face_rows: u64,
    pub oracle_translation_rows: u64,
    pub printed_translation_rows: u64,
    pub chinese_text_faces: u64,
    pub exact_image_faces: u64,
    pub alternate_image_faces: u64,
    pub unavailable_image_faces: u64,
    pub image_catalog_cards: u64,
    pub language_scope: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}
#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

struct HttpClient {
    agent: ureq::Agent,
    last_request: Option<Instant>,
    started: Instant,
}
impl HttpClient {
    fn agent() -> ureq::Agent {
        ureq::Agent::config_builder()
            // DNS64/NAT64 currently times out on this machine; both providers
            // publish reachable IPv4. TLS verification remains enabled.
            .ip_family(ureq::config::IpFamily::Ipv4Only)
            .timeout_global(Some(Duration::from_secs(90)))
            .timeout_resolve(Some(Duration::from_secs(10)))
            .timeout_connect(Some(Duration::from_secs(5)))
            .timeout_recv_body(Some(Duration::from_secs(30)))
            .build()
            .into()
    }
    fn new() -> Self {
        Self {
            agent: Self::agent(),
            last_request: None,
            started: Instant::now(),
        }
    }
    fn get(&mut self, url: &str, accept: &str) -> Result<ureq::http::Response<ureq::Body>> {
        // mtgch /result: 60/IP/minute, including cached responses. Fail rather
        // than loop on 429; the writer persists retry backoff across restarts.
        for attempt in 1..=3 {
            ensure!(
                self.started.elapsed() < Duration::from_secs(20 * 60),
                "provider refresh exceeded 20 minute budget"
            );
            if let Some(last) = self.last_request
                && let Some(wait) = Duration::from_millis(1100).checked_sub(last.elapsed())
            {
                thread::sleep(wait);
            }
            self.last_request = Some(Instant::now());
            let request = self
                .agent
                .get(url)
                .header("User-Agent", USER_AGENT)
                .header("Accept", accept);
            let request = if accept.contains("json") {
                request.header("Accept-Encoding", "gzip")
            } else {
                request
            };
            match request.call() {
                Ok(response) => return Ok(response),
                Err(error) => {
                    let transient = matches!(
                        error,
                        ureq::Error::Timeout(_)
                            | ureq::Error::HostNotFound
                            | ureq::Error::Io(_)
                            | ureq::Error::ConnectionFailed
                            | ureq::Error::StatusCode(500..=599)
                    );
                    if !transient || attempt == 3 {
                        return Err(error)
                            .with_context(|| format!("provider request failed: {url}"));
                    }
                    eprintln!("provider request retry {attempt}/3: {error}; {url}");
                    self.agent = Self::agent();
                }
            }
        }
        unreachable!()
    }
    fn json<T: DeserializeOwned>(&mut self, url: &str, max: u64) -> Result<T> {
        for attempt in 1..=3 {
            let mut response = self.get(url, "application/json")?;
            match json_response(&mut response, max) {
                Ok(value) => return Ok(value),
                Err(error) => {
                    let transient = error
                        .downcast_ref::<serde_json::Error>()
                        .is_some_and(|e| e.is_io() || e.is_eof());
                    if !transient || attempt == 3 {
                        return Err(error)
                            .with_context(|| format!("provider JSON body failed: {url}"));
                    }
                    eprintln!("provider body retry {attempt}/3: {error}; {url}");
                    self.agent = Self::agent();
                }
            }
        }
        unreachable!()
    }
}

pub fn resolve_latest() -> Result<ReleaseDescriptor> {
    let mut client = HttpClient::new();
    let mut response = client.get(RELEASE_API, "application/vnd.github+json")?;
    let release: GithubRelease = json_response(&mut response, 1024 * 1024)?;
    let mut assets = release.assets.into_iter().filter(|asset| {
        asset.name.starts_with("magic-cards-zhs-data-") && asset.name.ends_with(".tar.gz")
    });
    let asset = assets.next().context("release has no data archive")?;
    ensure!(
        assets.next().is_none(),
        "release has ambiguous data archives"
    );
    let descriptor = ReleaseDescriptor {
        tag: release.tag_name,
        asset_url: asset.browser_download_url,
        sha256: asset
            .digest
            .and_then(|d| d.strip_prefix("sha256:").map(str::to_owned))
            .context("release asset has no SHA256 digest")?,
        compressed_size: asset.size,
    };
    descriptor.validate()?;
    Ok(descriptor)
}

pub fn download(emit: &mut dyn FnMut(CardRecord) -> Result<()>) -> Result<RefreshReport> {
    download_release(&resolve_latest()?, emit)
}

pub fn download_release(
    release: &ReleaseDescriptor,
    emit: &mut dyn FnMut(CardRecord) -> Result<()>,
) -> Result<RefreshReport> {
    let mut client = HttpClient::new();
    let mut response = client.get(&release.asset_url, "application/octet-stream")?;
    let mut stage = Stage::new()?;
    stage.archive(release, response.body_mut().as_reader())?;
    stage.fetch_catalog(&mut client)?;
    stage.emit(release, emit)
}

/// Reuse a downloaded immutable archive; its entire size and SHA256 are checked
/// again. The image inventory is fetched fresh each time, even for the same tag.
pub fn import_archive(
    path: impl AsRef<Path>,
    release: &ReleaseDescriptor,
    emit: &mut dyn FnMut(CardRecord) -> Result<()>,
) -> Result<RefreshReport> {
    prepare_archive(path, release)?.emit(emit)
}

/// A complete validated provider snapshot, held in a temporary on-disk SQLite
/// database before opening the production publication transaction.
pub struct PreparedSnapshot {
    stage: Stage,
    release: ReleaseDescriptor,
}
impl PreparedSnapshot {
    pub fn source_revision(&self) -> String {
        self.stage.source_revision(&self.release)
    }
    pub fn emit(mut self, emit: &mut dyn FnMut(CardRecord) -> Result<()>) -> Result<RefreshReport> {
        self.stage.emit(&self.release, emit)
    }
}

pub fn prepare_archive(
    path: impl AsRef<Path>,
    release: &ReleaseDescriptor,
) -> Result<PreparedSnapshot> {
    let mut stage = Stage::new()?;
    stage.archive(release, File::open(path.as_ref())?)?;
    stage.fetch_catalog(&mut HttpClient::new())?;
    Ok(PreparedSnapshot {
        stage,
        release: release.clone(),
    })
}

/// Offline equivalent of the production pipeline. Pages must form a complete,
/// consistent catalog, including an explicit empty catalog page if there are no
/// images. Nothing reaches `emit` until every input and digest has validated.
pub fn import_with_catalog<R: Read, P: Read>(
    release: &ReleaseDescriptor,
    archive: R,
    pages: impl IntoIterator<Item = P>,
    emit: &mut dyn FnMut(CardRecord) -> Result<()>,
) -> Result<RefreshReport> {
    let mut stage = Stage::new()?;
    stage.archive(release, archive)?;
    for page in pages {
        stage.catalog_page(json_bounded(page, MAX_PAGE)?)?;
    }
    stage.emit(release, emit)
}

/// Read errors instead of treating a size cap as a successful artificial EOF.
struct Bounded<R> {
    inner: R,
    remaining: u64,
}
impl<R: Read> Read for Bounded<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let limit = buf.len().min(self.remaining.saturating_add(1) as usize);
        let read = self.inner.read(&mut buf[..limit])?;
        if read as u64 > self.remaining {
            return Err(io::Error::other("provider body exceeds size bound"));
        }
        self.remaining -= read as u64;
        Ok(read)
    }
}
fn json_bounded<T: DeserializeOwned>(reader: impl Read, max: u64) -> Result<T> {
    serde_json::from_reader(BufReader::new(Bounded {
        inner: reader,
        remaining: max,
    }))
    .context("invalid provider JSON")
}
fn json_response<T: DeserializeOwned>(
    response: &mut ureq::http::Response<ureq::Body>,
    max: u64,
) -> Result<T> {
    let encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    match encoding {
        "" | "identity" => json_bounded(response.body_mut().as_reader(), max),
        "gzip" => json_bounded(MultiGzDecoder::new(response.body_mut().as_reader()), max),
        _ => bail!("unsupported provider Content-Encoding"),
    }
}
struct Hashed<R> {
    inner: R,
    digest: Sha256,
    bytes: u64,
}
impl<R: Read> Read for Hashed<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.digest.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
}
struct Expanded<R> {
    inner: R,
    bytes: u64,
    trailing_zeros: u64,
}
impl<R: Read> Read for Expanded<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.bytes += n as u64;
        if self.bytes > MAX_EXPANDED {
            return Err(io::Error::other("decompressed archive exceeds bound"));
        }
        if let Some(last) = buf[..n].iter().rposition(|b| *b != 0) {
            self.trailing_zeros = (n - last - 1) as u64;
        } else {
            self.trailing_zeros += n as u64;
        }
        Ok(n)
    }
}

#[derive(Deserialize)]
struct OracleTranslation {
    face_oracle_id: String,
    translated_name: Option<String>,
    translated_type: Option<String>,
    translated_text: Option<String>,
    name_source: Option<String>,
    text_source: Option<String>,
}
#[derive(Deserialize)]
struct PrintedTranslation {
    card_id: String,
    name: Option<String>,
    face_name: Option<String>,
    type_line: Option<String>,
    text: Option<String>,
    source: Option<String>,
}
#[derive(Deserialize)]
struct BulkFace {
    uuid: String,
    scryfall_id: String,
    face_index: i64,
    oracle_id: Option<String>,
    face_oracle_id: Option<String>,
    name: String,
    set_code: String,
    collector_number: String,
    layout: String,
}
#[derive(Deserialize)]
struct CatalogPage {
    count: u64,
    page: u64,
    page_size: u64,
    total_pages: u64,
    items: Vec<CatalogFace>,
}
#[derive(Deserialize, Serialize)]
struct CatalogFace {
    id: String,
    oracle_id: Option<String>,
    face_oracle_id: Option<String>,
    #[serde(default)]
    zhs_image_uris: Option<ImageUris>,
    #[serde(default)]
    zhs_image_url: Option<String>,
    #[serde(default)]
    other_faces: Vec<CatalogFace>,
}
#[derive(Deserialize, Serialize)]
struct ImageUris {
    #[serde(default)]
    large: Option<String>,
    #[serde(default)]
    normal: Option<String>,
}

#[derive(Default)]
struct Counts {
    bulk: u64,
    oracle: u64,
    printed: u64,
}
struct Stage {
    // SQLite's unnamed on-disk temporary DB is automatically deleted on close.
    // Fixed page cache and temp_store=FILE bound memory during indexed joins.
    conn: Connection,
    counts: Counts,
    catalog_total: Option<u64>,
    catalog_pages: u64,
    catalog_seen: u64,
    catalog_page_size: u64,
    catalog_last: u64,
    catalog_hash: Sha256,
}
impl Stage {
    fn source_revision(&self, release: &ReleaseDescriptor) -> String {
        format!(
            "{}:images:{}",
            release.identity(),
            hex(&self.catalog_hash.clone().finalize())
        )
    }
    fn new() -> Result<Self> {
        let conn = Connection::open("")?;
        conn.execute_batch("PRAGMA temp_store=FILE; PRAGMA cache_size=-8192;
            CREATE TABLE oracle_text(face_id TEXT PRIMARY KEY,name TEXT,type_line TEXT,rules TEXT,source TEXT) WITHOUT ROWID;
            CREATE TABLE printed_text(uuid TEXT PRIMARY KEY,name TEXT,type_line TEXT,rules TEXT,source TEXT) WITHOUT ROWID;
            CREATE TABLE bulk(uuid TEXT PRIMARY KEY,id TEXT NOT NULL,idx INTEGER NOT NULL,face_id TEXT,oracle_id TEXT,name TEXT NOT NULL,set_code TEXT NOT NULL,cn TEXT NOT NULL,layout TEXT NOT NULL) WITHOUT ROWID;
            CREATE UNIQUE INDEX bulk_identity ON bulk(id,idx);
            CREATE INDEX bulk_face ON bulk(face_id,oracle_id);
            CREATE TABLE images(id TEXT NOT NULL,face_id TEXT NOT NULL,oracle_id TEXT,side TEXT NOT NULL,url TEXT NOT NULL,PRIMARY KEY(id,face_id,side)) WITHOUT ROWID;
            CREATE INDEX image_face ON images(face_id,oracle_id,side);
            CREATE TABLE catalog_ids(id TEXT PRIMARY KEY) WITHOUT ROWID;
            BEGIN;")?;
        Ok(Self {
            conn,
            counts: Counts::default(),
            catalog_total: None,
            catalog_pages: 0,
            catalog_seen: 0,
            catalog_page_size: 0,
            catalog_last: 0,
            catalog_hash: Sha256::new(),
        })
    }

    fn archive(&mut self, release: &ReleaseDescriptor, reader: impl Read) -> Result<()> {
        release.validate()?;
        let hashed = Hashed {
            inner: Bounded {
                inner: reader,
                remaining: MAX_ARCHIVE,
            },
            digest: Sha256::new(),
            bytes: 0,
        };
        let decoder = Expanded {
            inner: MultiGzDecoder::new(hashed),
            bytes: 0,
            trailing_zeros: 0,
        };
        let mut archive = tar::Archive::new(decoder);
        let mut files = BTreeSet::new();
        let mut expanded = 0_u64;
        for entry in archive.entries()? {
            let mut entry = entry.context("invalid or truncated tar entry")?;
            let path = entry.path()?.into_owned();
            if entry.header().entry_type().is_dir() {
                continue;
            }
            ensure!(
                entry.header().entry_type().is_file(),
                "unexpected non-file in data archive"
            );
            expanded = expanded
                .checked_add(entry.size())
                .context("archive size overflow")?;
            ensure!(expanded <= MAX_EXPANDED, "expanded archive exceeds bound");
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .context("invalid archive filename")?;
            ensure!(
                files.insert(name.to_owned()),
                "duplicate archive file {name}"
            );
            if matches!(
                name,
                "zhs_oracle.json" | "zhs_card.json" | "scryfall_card.json"
            ) {
                self.lines(name, &mut entry)?;
            } else {
                io::copy(&mut entry, &mut io::sink())?;
            }
        }
        // tar stops at its zero terminator before the gzip trailer. Drain and
        // validate CRC/truncation; only zero padding is allowed after tar EOF.
        let mut decoder = archive.into_inner();
        let mut tail = [0_u8; 8192];
        let mut trailing = 0;
        loop {
            let n = decoder.read(&mut tail).context("invalid gzip trailer")?;
            if n == 0 {
                break;
            }
            trailing += n;
            ensure!(
                trailing <= 1024 * 1024 && tail[..n].iter().all(|v| *v == 0),
                "unexpected data after tar terminator"
            );
        }
        ensure!(
            decoder.trailing_zeros >= 1024,
            "missing complete tar end marker"
        );
        let hashed = decoder.inner.into_inner();
        ensure!(
            hashed.bytes == release.compressed_size,
            "archive size does not match release"
        );
        ensure!(
            hex(&hashed.digest.finalize()).eq_ignore_ascii_case(&release.sha256),
            "archive SHA256 mismatch"
        );
        for required in ["zhs_oracle.json", "zhs_card.json", "scryfall_card.json"] {
            ensure!(
                files.contains(required),
                "missing archive member {required}"
            );
        }
        ensure!(
            self.counts.bulk > 0 && self.counts.oracle > 0 && self.counts.printed > 0,
            "empty bulk component"
        );
        eprintln!(
            "mtgch bulk verified: {} face rows, {} Oracle translations, {} printed translations",
            self.counts.bulk, self.counts.oracle, self.counts.printed
        );
        Ok(())
    }

    fn lines(&mut self, name: &str, reader: impl Read) -> Result<()> {
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        let mut line_number = 0;
        loop {
            bytes.clear();
            // take is intentional per-line, and checked before parsing, so a
            // malicious line cannot grow read_until's allocation without bound.
            let n = reader
                .by_ref()
                .take((MAX_LINE + 1) as u64)
                .read_until(b'\n', &mut bytes)?;
            if n == 0 {
                break;
            }
            line_number += 1;
            ensure!(
                n <= MAX_LINE,
                "{name}:{line_number}: record exceeds size bound"
            );
            ensure!(
                bytes.last() == Some(&b'\n'),
                "{name}:{line_number}: missing record terminator"
            );
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            ensure!(!bytes.is_empty(), "{name}:{line_number}: empty record");
            let decoded = copy_text_decode(&bytes)
                .with_context(|| format!("{name}:{line_number}: COPY escaping"))?;
            self.row(name, &decoded)
                .with_context(|| format!("{name}:{line_number}: invalid data"))?;
        }
        Ok(())
    }

    fn row(&mut self, name: &str, bytes: &[u8]) -> Result<()> {
        match name {
            "zhs_oracle.json" => {
                let r: OracleTranslation = serde_json::from_slice(bytes)?;
                let id = printing_id(&r.face_oracle_id)?;
                let source = format!(
                    "name={};text={}",
                    r.name_source.as_deref().unwrap_or("unspecified"),
                    r.text_source.as_deref().unwrap_or("unspecified")
                );
                self.conn
                    .prepare_cached("INSERT INTO oracle_text VALUES(?1,?2,?3,?4,?5)")?
                    .execute(params![
                        id,
                        clean(r.translated_name),
                        clean(r.translated_type),
                        clean(r.translated_text),
                        source
                    ])?;
                self.counts.oracle += 1;
            }
            "zhs_card.json" => {
                let r: PrintedTranslation = serde_json::from_slice(bytes)?;
                self.conn
                    .prepare_cached("INSERT INTO printed_text VALUES(?1,?2,?3,?4,?5)")?
                    .execute(params![
                        printing_id(&r.card_id)?,
                        clean(r.face_name.or(r.name)),
                        clean(r.type_line),
                        clean(r.text),
                        r.source
                    ])?;
                self.counts.printed += 1;
            }
            "scryfall_card.json" => {
                let r: BulkFace = serde_json::from_slice(bytes)?;
                ensure!((-1..=16).contains(&r.face_index), "unsupported face index");
                ensure!(
                    !r.name.is_empty() && !r.set_code.is_empty() && !r.layout.is_empty(),
                    "missing printing identity"
                );
                self.conn
                    .prepare_cached("INSERT INTO bulk VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)")?
                    .execute(params![
                        printing_id(&r.uuid)?,
                        printing_id(&r.scryfall_id)?,
                        r.face_index,
                        r.face_oracle_id.as_deref().map(printing_id).transpose()?,
                        r.oracle_id.as_deref().map(printing_id).transpose()?,
                        r.name,
                        r.set_code.to_ascii_lowercase(),
                        r.collector_number,
                        r.layout
                    ])?;
                self.counts.bulk += 1;
            }
            _ => bail!("unsupported data member"),
        }
        Ok(())
    }

    fn fetch_catalog(&mut self, client: &mut HttpClient) -> Result<()> {
        for page in 1..=MAX_PAGES {
            let mut url = url::Url::parse(IMAGE_CATALOG)?;
            url.query_pairs_mut().extend_pairs([
                // A tautology over a non-null boolean includes tokens/art cards,
                // even if a future product has a null/negative mana value.
                ("q", "is:extra or -is:extra"),
                ("view", "1"),
                ("page_size", "1000"),
                ("unique", "oracle_id"),
                ("prefer", "default,chinese,newest"),
                ("include_extras", "true"),
                ("order", "name"),
                ("dir", "asc"),
                ("page", &page.to_string()),
            ]);
            self.catalog_page(client.json(url.as_str(), MAX_PAGE)?)?;
            eprintln!(
                "mtgch Chinese image catalog: page {}/{}, {} representatives",
                self.catalog_last, self.catalog_pages, self.catalog_seen
            );
            if self.catalog_last >= self.catalog_pages {
                return Ok(());
            }
        }
        bail!("image catalog exceeds page bound")
    }

    fn catalog_page(&mut self, page: CatalogPage) -> Result<()> {
        ensure!(
            page.page == self.catalog_last + 1,
            "out-of-order image catalog page"
        );
        ensure!(
            page.page_size > 0
                && page.page_size <= 1000
                && page.items.len() as u64 <= page.page_size
                && page.total_pages <= MAX_PAGES,
            "invalid image catalog pagination"
        );
        ensure!(
            page.total_pages == page.count.div_ceil(page.page_size),
            "inconsistent catalog page count"
        );
        if let Some(total) = self.catalog_total {
            ensure!(
                total == page.count
                    && self.catalog_pages == page.total_pages
                    && self.catalog_page_size == page.page_size,
                "image catalog changed while paginating"
            );
        } else {
            self.catalog_total = Some(page.count);
            self.catalog_pages = page.total_pages;
            self.catalog_page_size = page.page_size;
        }
        let expected = page
            .count
            .saturating_sub((page.page - 1) * page.page_size)
            .min(page.page_size);
        ensure!(
            page.items.len() as u64 == expected,
            "incomplete image catalog page"
        );
        for item in page.items {
            let id = printing_id(&item.id)?;
            self.conn
                .execute("INSERT INTO catalog_ids VALUES(?1)", [&id])
                .context("duplicate representative in catalog; pagination unstable")?;
            self.catalog_hash.update(serde_json::to_vec(&item)?);
            self.catalog_hash.update(b"\n");
            self.catalog_face(&item, 0)?;
            self.catalog_seen += 1;
        }
        self.catalog_last = page.page;
        Ok(())
    }

    fn catalog_face(&self, face: &CatalogFace, depth: usize) -> Result<()> {
        ensure!(
            depth <= 16 && face.other_faces.len() <= 16,
            "excessive catalog faces"
        );
        let image = face
            .zhs_image_uris
            .as_ref()
            .and_then(|u| u.large.as_ref().or(u.normal.as_ref()))
            .or(face.zhs_image_url.as_ref());
        if let Some(image) = image {
            let id = printing_id(&face.id)?;
            let face_id = face
                .face_oracle_id
                .as_deref()
                .context("image has no face identity")?;
            let face_id = printing_id(face_id)?;
            let oracle = face.oracle_id.as_deref().map(printing_id).transpose()?;
            let url = url::Url::parse(image)?;
            ensure!(
                url.scheme() == "https"
                    && url.host_str() == Some("images.mtgch.com")
                    && url.path().starts_with("/zhs/")
                    && url.username().is_empty()
                    && url.password().is_none()
                    && image.len() <= 2048,
                "unexpected Chinese image URL"
            );
            // Validate that provider URL identifies this exact printing. We do
            // not infer availability or substitute English image_uris.
            ensure!(
                url.path().ends_with(&format!("/{id}.webp")),
                "image printing identity mismatch"
            );
            let side = if url.path().contains("/back/") {
                "back"
            } else {
                ensure!(url.path().contains("/front/"), "image has no physical face");
                "front"
            };
            self.conn.execute(
                "INSERT OR IGNORE INTO images VALUES(?1,?2,?3,?4,?5)",
                params![id, face_id, oracle, side, image],
            )?;
        }
        for other in &face.other_faces {
            self.catalog_face(other, depth + 1)?;
        }
        Ok(())
    }

    fn emit(
        &mut self,
        release: &ReleaseDescriptor,
        emit: &mut dyn FnMut(CardRecord) -> Result<()>,
    ) -> Result<RefreshReport> {
        ensure!(
            self.catalog_total == Some(self.catalog_seen)
                && self.catalog_last >= self.catalog_pages,
            "incomplete image catalog"
        );
        self.conn.execute_batch("COMMIT;")?;
        let mut report = RefreshReport {
            release:release.clone(),source_revision:self.source_revision(release),
            card_count:0,bulk_face_rows:self.counts.bulk,oracle_translation_rows:self.counts.oracle,printed_translation_rows:self.counts.printed,
            chinese_text_faces:0,exact_image_faces:0,alternate_image_faces:0,unavailable_image_faces:0,image_catalog_cards:self.catalog_seen,
            language_scope:"All available zhs translations in the mtgch bulk release; per-Oracle declared zhs image representatives; no full zht dataset".into(),
        };
        let mut stmt = self.conn.prepare("SELECT b.id,b.oracle_id,b.name,b.set_code,b.cn,b.layout,b.idx,b.face_id,
            coalesce(o.name,p.name),coalesce(o.type_line,p.type_line),coalesce(o.rules,p.rules),o.source,p.source
            FROM bulk b LEFT JOIN oracle_text o ON o.face_id=b.face_id LEFT JOIN printed_text p ON p.uuid=b.uuid ORDER BY b.id,b.idx")?;
        let mut rows = stmt.query([])?;
        let mut current: Option<CardRecord> = None;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            if current.as_ref().is_some_and(|c| c.printing_id != id) {
                finish_record(current.take().unwrap(), emit, &mut report)?;
            }
            if current.is_none() {
                current = Some(CardRecord {
                    printing_id: id.clone(),
                    oracle_id: row.get(1)?,
                    english_name: row.get(2)?,
                    set_code: row.get(3)?,
                    collector_number: row.get(4)?,
                    layout: row.get(5)?,
                    faces: Vec::new(),
                });
            }
            let card = current.as_mut().unwrap();
            let idx: i64 = row.get(6)?;
            let side = if idx > 0 && physical_back(&card.layout) {
                FaceSide::Back
            } else {
                FaceSide::Front
            };
            let face_id: Option<String> = row.get(7)?;
            let image: Option<(String, String)> = if let Some(face_id) = face_id.as_deref() {
                self.conn.query_row("SELECT id,url FROM images WHERE face_id=?1 AND side=?4 AND (id=?2 OR (oracle_id=?3 AND ?3 IS NOT NULL)) ORDER BY (id=?2) DESC,id LIMIT 1",params![face_id,id,card.oracle_id,side.as_str()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?
            } else {
                None
            };
            let (image_url, image_kind, localized_printing_id) = match image {
                Some((other, url)) if other == id => (Some(url), ImageKind::Exact, None),
                Some((other, url)) => (Some(url), ImageKind::Alternate, Some(other)),
                None => (None, ImageKind::Unavailable, None),
            };
            let source: Option<String> = row.get(11)?;
            let printed_source: Option<String> = row.get(12)?;
            let face = LocalizedFace {
                face: side,
                lang: Language::Zhs,
                name: row.get(8)?,
                type_line: row.get(9)?,
                rules_text: row.get(10)?,
                image_url,
                image_kind,
                localized_printing_id,
                source: format!(
                    "mtgch/magic-cards-zhs {}; {}; printed={}; Chinese image: mtgch API representative inventory; CC-BY-SA-4.0",
                    release.tag,
                    source
                        .as_deref()
                        .unwrap_or("Oracle translation unavailable"),
                    printed_source.as_deref().unwrap_or("unspecified")
                ),
                source_url: Some(format!("{DATA_REPOSITORY}/releases/tag/{}", release.tag)),
            };
            if let Some(existing) = card.faces.iter_mut().find(|f| f.face == side) {
                // Split/adventure/prepare components share the physical front.
                append_component(&mut existing.name, face.name);
                append_component(&mut existing.type_line, face.type_line);
                append_component(&mut existing.rules_text, face.rules_text);
                if existing.image_url.is_none() {
                    existing.image_url = face.image_url;
                    existing.image_kind = face.image_kind;
                    existing.localized_printing_id = face.localized_printing_id;
                }
            } else {
                card.faces.push(face);
            }
        }
        if let Some(card) = current {
            finish_record(card, emit, &mut report)?;
        }
        ensure!(report.card_count > 0, "empty output snapshot");
        Ok(report)
    }
}

fn finish_record(
    card: CardRecord,
    emit: &mut dyn FnMut(CardRecord) -> Result<()>,
    report: &mut RefreshReport,
) -> Result<()> {
    for face in &card.faces {
        if face.name.is_some() || face.type_line.is_some() || face.rules_text.is_some() {
            report.chinese_text_faces += 1;
        }
        match face.image_kind {
            ImageKind::Exact => report.exact_image_faces += 1,
            ImageKind::Alternate => report.alternate_image_faces += 1,
            ImageKind::Unavailable => report.unavailable_image_faces += 1,
        }
    }
    emit(card)?;
    report.card_count += 1;
    if report.card_count.is_multiple_of(10_000) {
        eprintln!("mtgch normalized {} printings", report.card_count);
    }
    Ok(())
}
fn physical_back(layout: &str) -> bool {
    matches!(
        layout,
        "transform" | "modal_dfc" | "reversible_card" | "double_faced_token" | "art_series"
    )
}
fn append_component(target: &mut Option<String>, other: Option<String>) {
    if let Some(other) = other {
        if let Some(target) = target {
            if *target != other {
                target.push_str("\n//\n");
                target.push_str(&other);
            }
        } else {
            *target = Some(other);
        }
    }
}
fn clean(value: Option<String>) -> Option<String> {
    value
        .filter(|s| !s.is_empty())
        .map(|s| s.replace("\\n", "\n").replace("\\r", "\r"))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode the documented PostgreSQL COPY text layer before parsing JSON.
/// Unknown, dangling and physical control escapes are rejected, not repaired.
fn copy_text_decode(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        let b = bytes[cursor];
        cursor += 1;
        if b == b'\\' {
            let escaped = *bytes.get(cursor).context("dangling COPY backslash")?;
            cursor += 1;
            // row_to_json's output has no physical tabs/newlines, so COPY only
            // needs to escape its backslashes. Refuse unexpected encodings.
            ensure!(escaped == b'\\', "unexpected COPY escape");
            out.push(b'\\');
        } else {
            out.push(b);
        }
    }
    Ok(out)
}
