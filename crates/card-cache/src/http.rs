//! Read-only HTTP: no writer, downloader, or upstream client is reachable from this module.
use crate::{
    db::Reader,
    model::{Language, SCHEMA_VERSION, printing_id},
};
use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::{Body, HttpBody},
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinSet};

pub const LISTEN_ADDRESS: &str = "127.0.0.1:17317";
pub const READERS: usize = 4;
pub const MAX_CONNECTIONS: usize = 32;
pub const MAX_URI_BYTES: usize = 8192;

#[derive(Clone)]
pub struct ReadPool {
    readers: Arc<Mutex<Vec<Reader>>>,
    permits: Arc<Semaphore>,
    requests: Arc<Semaphore>,
}
impl ReadPool {
    /// Open before entering the runtime, or from a blocking thread.
    pub fn open(path: impl AsRef<Path>, count: usize) -> Result<Self> {
        ensure!(
            (1..=8).contains(&count),
            "reader pool must contain 1..=8 readers"
        );
        let readers = (0..count)
            .map(|_| Reader::open(path.as_ref()))
            .collect::<Result<_>>()?;
        Ok(Self {
            readers: Arc::new(Mutex::new(readers)),
            permits: Arc::new(Semaphore::new(count)),
            requests: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        })
    }
    async fn read(&self, query: Query) -> std::result::Result<Payload, ApiError> {
        let request = self
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy())?;
        let permit =
            tokio::time::timeout(Duration::from_secs(2), self.permits.clone().acquire_owned())
                .await
                .map_err(|_| ApiError::busy())?
                .map_err(|_| ApiError::busy())?;
        let readers = self.readers.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _request = request;
            let mut reader = readers.lock().map_err(|_| anyhow::anyhow!("reader pool poisoned"))?.pop().context("reader pool exhausted")?;
            let result = match query {
                Query::Health => reader.status().map(|_| json!({"schema_version":SCHEMA_VERSION,"ok":true})),
                Query::Status => reader.status().and_then(|s| Ok(serde_json::to_value(s)?)),
                Query::Cards { ids,lang,single } => reader.cards(&ids,lang).and_then(|mut result| {
                    if single {
                        if let Some(card) = result.cards.pop() { Ok(json!({"schema_version":SCHEMA_VERSION,"revision":result.revision,"card":card})) }
                        else { Ok(json!({"schema_version":SCHEMA_VERSION,"revision":result.revision,"error":{"code":"not_found","message":"printing not present in published snapshot"}})) }
                    } else { Ok(serde_json::to_value(result)?) }
                }),
            };
            readers.lock().map_err(|_| anyhow::anyhow!("reader pool poisoned"))?.push(reader);
            result.and_then(|value| {
                let status=if value.get("error").is_some() {StatusCode::NOT_FOUND} else {StatusCode::OK};
                let bytes=serde_json::to_vec(&value)?;
                let digest=Sha256::digest(&bytes);
                let etag=format!("\"{}\"",digest.iter().map(|byte|format!("{byte:02x}")).collect::<String>());
                Ok(Payload{bytes,etag,status})
            })
        }).await.map_err(|_| ApiError::database())?.map_err(|error| {
            eprintln!("card-cache read failed: {error:#}"); ApiError::database()
        })
    }
}
enum Query {
    Health,
    Status,
    Cards {
        ids: Vec<String>,
        lang: Language,
        single: bool,
    },
}
struct Payload {
    bytes: Vec<u8>,
    etag: String,
    status: StatusCode,
}
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}
impl ApiError {
    fn bad(message: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            message,
        }
    }
    fn busy() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "busy",
            message: "all read connections are busy; retry shortly",
        }
    }
    fn database() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "database_unavailable",
            message: "published cache is unavailable",
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status,axum::Json(json!({"schema_version":SCHEMA_VERSION,"error":{"code":self.code,"message":self.message}}))).into_response();
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        if self.status == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, header::HeaderValue::from_static("1"));
        }
        response
    }
}

pub fn router(pool: ReadPool) -> Router {
    Router::new().fallback(dispatch).with_state(pool)
}
async fn dispatch(State(pool): State<ReadPool>, request: Request) -> Response {
    match handle(pool, request).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}
async fn handle(pool: ReadPool, request: Request) -> std::result::Result<Response, ApiError> {
    if request.uri().to_string().len() > MAX_URI_BYTES {
        return Err(ApiError {
            status: StatusCode::URI_TOO_LONG,
            code: "uri_too_long",
            message: "maximum URI length is 8192 bytes",
        });
    }
    if request.method() != axum::http::Method::GET && request.method() != axum::http::Method::HEAD {
        return Err(ApiError {
            status: StatusCode::METHOD_NOT_ALLOWED,
            code: "read_only",
            message: "only GET and HEAD are supported",
        });
    }
    if request
        .headers()
        .get(header::HOST)
        .is_some_and(|host| host.as_bytes() != LISTEN_ADDRESS.as_bytes())
    {
        return Err(ApiError::bad("Host must be 127.0.0.1:17317"));
    }
    if request.headers().contains_key(header::TRANSFER_ENCODING)
        || request
            .headers()
            .get(header::CONTENT_LENGTH)
            .is_some_and(|value| value.as_bytes() != b"0")
        || request.body().size_hint().upper().is_none_or(|n| n > 0)
    {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "body_not_allowed",
            message: "read endpoints do not accept request bodies",
        });
    }
    let query = parse_query(request.uri().path(), request.uri().query())?;
    let Payload {
        bytes,
        etag,
        status,
    } = pool.read(query).await?;
    let matched = status == StatusCode::OK && matches_etag(request.headers(), &etag);
    let length = bytes.len();
    let head = request.method() == axum::http::Method::HEAD;
    let mut response = Response::new(if matched || head {
        Body::empty()
    } else {
        Body::from(bytes)
    });
    *response.status_mut() = if matched {
        StatusCode::NOT_MODIFIED
    } else {
        status
    };
    let headers = response.headers_mut();
    headers.insert(
        header::ETAG,
        etag.parse().map_err(|_| ApiError::database())?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-cache"),
    );
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    if !matched {
        headers.insert(header::CONTENT_LENGTH, length.into());
    }
    Ok(response)
}
fn matches_etag(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|v| {
            let v = v.trim();
            v == "*" || v.strip_prefix("W/").unwrap_or(v) == etag
        })
}
fn parse_query(path: &str, query: Option<&str>) -> std::result::Result<Query, ApiError> {
    let mut ids = None;
    let mut language = None;
    if let Some(query) = query {
        // form_urlencoded is forgiving of invalid escapes; reject them before decoding.
        let bytes = query.as_bytes();
        for (i, &byte) in bytes.iter().enumerate() {
            if byte == b'%'
                && (i + 2 >= bytes.len()
                    || !bytes[i + 1].is_ascii_hexdigit()
                    || !bytes[i + 2].is_ascii_hexdigit())
            {
                return Err(ApiError::bad("invalid query encoding"));
            }
        }
        for (key, value) in url::form_urlencoded::parse(bytes) {
            match key.as_ref() {
                "lang" if language.is_none() => {
                    language = Some(match value.as_ref() {
                        "zhs" => Language::Zhs,
                        "zht" => Language::Zht,
                        _ => return Err(ApiError::bad("lang must be zhs or zht")),
                    })
                }
                "ids" if ids.is_none() => ids = Some(value.into_owned()),
                _ => return Err(ApiError::bad("unknown or duplicate query parameter")),
            }
        }
    }
    if path == "/healthz" || path == "/v1/status" {
        if ids.is_some() || language.is_some() {
            return Err(ApiError::bad("endpoint does not accept query parameters"));
        }
        return Ok(if path == "/healthz" {
            Query::Health
        } else {
            Query::Status
        });
    }
    let lang = language.unwrap_or(Language::Zhs);
    if path == "/v1/cards" {
        let ids = ids.ok_or_else(|| ApiError::bad("ids is required"))?;
        let values: Vec<_> = ids.split(',').collect();
        if values.is_empty() || values.len() > 100 {
            return Err(ApiError::bad("batch must contain 1..=100 UUIDs"));
        }
        let ids = values
            .into_iter()
            .map(|id| printing_id(id).map_err(|_| ApiError::bad("invalid printing UUID")))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        return Ok(Query::Cards {
            ids,
            lang,
            single: false,
        });
    }
    if let Some(id) = path.strip_prefix("/v1/cards/") {
        if ids.is_some() {
            return Err(ApiError::bad("single-card endpoint does not accept ids"));
        }
        let id = printing_id(id).map_err(|_| ApiError::bad("invalid printing UUID"))?;
        return Ok(Query::Cards {
            ids: vec![id],
            lang,
            single: true,
        });
    }
    Err(ApiError {
        status: StatusCode::NOT_FOUND,
        code: "not_found",
        message: "unknown endpoint",
    })
}

/// Bounded HTTP/1 transport. Public CLI always supplies the fixed loopback listener.
/// An injected listener/shutdown makes real socket integration testing possible.
pub async fn serve(
    listener: TcpListener,
    app: Router,
    shutdown: impl Future<Output = ()>,
) -> Result<()> {
    ensure!(
        listener.local_addr()?.ip().is_loopback(),
        "loopback listener required"
    );
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            biased;
            _=&mut shutdown=>break,
            _=tasks.join_next(), if !tasks.is_empty()=>{},
            next=async {
                let permit=connections.clone().acquire_owned().await.context("connection semaphore closed")?;
                let (socket,_)=listener.accept().await?;
                Ok::<_,anyhow::Error>((socket,permit))
            }=> {
                let (socket,permit)=next?;
                let service=TowerToHyperService::new(app.clone());
                tasks.spawn(async move {
                    let _permit=permit;
                    let mut builder=hyper::server::conn::http1::Builder::new();
                    builder.timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(10)).max_headers(32).max_buf_size(16_384);
                    let connection=builder.serve_connection(TokioIo::new(socket),service);
                    // Bounds slow clients and idle keep-alive lifetime, including response backpressure.
                    let _=tokio::time::timeout(Duration::from_secs(60),connection).await;
                });
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
