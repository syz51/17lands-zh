use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use mtga_card_cache::{
    db::Writer,
    http::{self, ReadPool},
    model::*,
};
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;
const ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
fn record(name: &str) -> CardRecord {
    CardRecord {
        printing_id: ID.into(),
        oracle_id: None,
        english_name: name.into(),
        set_code: "tst".into(),
        collector_number: "1".into(),
        layout: "normal".into(),
        faces: vec![LocalizedFace {
            face: FaceSide::Front,
            lang: Language::Zhs,
            name: Some("测试".into()),
            type_line: None,
            rules_text: None,
            image_url: None,
            image_kind: ImageKind::Unavailable,
            source: "fixture".into(),
            source_url: None,
            localized_printing_id: None,
        }],
    }
}
fn setup(ready: bool) -> (TempDir, Writer, Router) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("cards.sqlite");
    let mut writer = Writer::open(&path).unwrap();
    if ready {
        writer
            .publish_snapshot_at(100, |sink| sink.insert(&record("old")))
            .unwrap();
    }
    let app = http::router(ReadPool::open(path, http::READERS).unwrap());
    (dir, writer, app)
}
async fn get(app: Router, uri: &str) -> axum::response::Response {
    app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}
async fn json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap()).unwrap()
}
#[tokio::test]
async fn empty_is_healthy_and_status_distinguishes_not_ready() {
    let (_dir, _writer, app) = setup(false);
    assert_eq!(get(app.clone(), "/healthz").await.status(), StatusCode::OK);
    let status = json(get(app.clone(), "/v1/status").await).await;
    assert_eq!(status["ready"], false);
    assert_eq!(status["card_count"], 0);
    assert_eq!(status["revision"], "0");
    let missing = get(app, &format!("/v1/cards/{ID}")).await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(json(missing).await["error"]["code"], "not_found");
}
#[tokio::test]
async fn strict_ids_language_query_and_batch_limits_are_json_errors() {
    let (_dir, _writer, app) = setup(true);
    let mut uris = vec![
        "/v1/cards/garbage".to_string(),
        "/v1/cards/aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa".into(),
        "/v1/cards?ids=';DROP%20TABLE%20printings;--".into(),
        format!("/v1/cards?ids={ID}&lang=en"),
        format!("/v1/cards?ids={ID}&lang=zhs&lang=zht"),
        "/v1/cards?ids=".into(),
        "/v1/cards?ids=%QQ".into(),
        "/v1/cards?ids=%FF".into(),
        format!("/v1/cards/{ID}?ids={ID}"),
        "/v1/status?unused=1".into(),
    ];
    uris.push(format!("/v1/cards?ids={}", vec![ID; 101].join(",")));
    for uri in uris {
        let response = get(app.clone(), &uri).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(json(response).await["schema_version"], 1);
    }
    let response = get(
        app.clone(),
        &format!("/v1/cards?ids={}&lang=zhs", vec![ID; 100].join(",")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await["cards"].as_array().unwrap().len(), 100);
    assert_eq!(
        get(app, &format!("/v1/cards/{}", ID.to_uppercase()))
            .await
            .status(),
        StatusCode::OK
    );
}
#[tokio::test]
async fn methods_bodies_host_and_uri_are_bounded() {
    let (_dir, _writer, app) = setup(true);
    for (request, expected) in [
        (
            Request::builder()
                .method("POST")
                .uri("/v1/status")
                .body(Body::empty())
                .unwrap(),
            StatusCode::METHOD_NOT_ALLOWED,
        ),
        (
            Request::builder()
                .uri("/v1/status")
                .header(header::CONTENT_LENGTH, "1")
                .body(Body::from("x"))
                .unwrap(),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            Request::builder()
                .uri("/v1/status")
                .header(header::TRANSFER_ENCODING, "chunked")
                .body(Body::empty())
                .unwrap(),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            Request::builder()
                .uri("/v1/status")
                .header(header::HOST, "evil.example:17317")
                .body(Body::empty())
                .unwrap(),
            StatusCode::BAD_REQUEST,
        ),
        (
            Request::builder()
                .uri(format!("/v1/cards?ids={}", "a".repeat(9000)))
                .body(Body::empty())
                .unwrap(),
            StatusCode::URI_TOO_LONG,
        ),
    ] {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), expected);
        assert!(json(response).await["error"]["code"].is_string());
    }
    assert_eq!(get(app, "/unknown").await.status(), StatusCode::NOT_FOUND);
}
#[tokio::test]
async fn etags_match_representation_and_change_atomically_with_generation() {
    let (_dir, mut writer, app) = setup(true);
    let uri = format!("/v1/cards/{ID}");
    let first = get(app.clone(), &uri).await;
    let etag = first.headers()[header::ETAG].clone();
    assert_eq!(json(first).await["revision"], "1");
    let conditional = Request::builder()
        .uri(&uri)
        .header(
            header::IF_NONE_MATCH,
            format!("W/{}, \"other\"", etag.to_str().unwrap()),
        )
        .body(Body::empty())
        .unwrap();
    let unchanged = app.clone().oneshot(conditional).await.unwrap();
    assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(to_bytes(unchanged.into_body(), 100).await.unwrap().len(), 0);
    let other_language = get(app.clone(), &format!("{uri}?lang=zht")).await;
    assert_ne!(other_language.headers()[header::ETAG], etag);
    let checked = tokio::task::spawn_blocking(move || {
        writer
            .publish_snapshot_at(200, |sink| sink.insert(&record("new")))
            .unwrap();
        writer
    })
    .await
    .unwrap();
    let changed = app
        .oneshot(
            Request::builder()
                .uri(&uri)
                .header(header::IF_NONE_MATCH, etag.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(changed.status(), StatusCode::OK);
    assert_ne!(changed.headers()[header::ETAG], etag);
    let changed = json(changed).await;
    assert_eq!(changed["revision"], "2");
    assert_eq!(changed["card"]["english_name"], "new");
    drop(checked);
}

#[tokio::test]
async fn proxy_hosts_must_be_explicit_and_do_not_enable_cors_or_writes() {
    let (dir, _writer, _) = setup(true);
    let app = http::router_with_hosts(
        ReadPool::open(dir.path().join("cards.sqlite"), 1).unwrap(),
        &["cards.example.com".into()],
    )
    .unwrap();
    for (host, expected) in [
        ("cards.example.com", StatusCode::OK),
        ("CARDS.EXAMPLE.COM", StatusCode::OK),
        ("127.0.0.1:17317", StatusCode::OK),
        ("other.example.com", StatusCode::BAD_REQUEST),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .header(header::HOST, host)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }
    for host in ["*", "user@cards.example.com", "cards.example.com/path", ""] {
        assert!(
            http::router_with_hosts(
                ReadPool::open(dir.path().join("cards.sqlite"), 1).unwrap(),
                &[host.into()]
            )
            .is_err()
        );
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sixteen_simultaneous_normal_requests_all_succeed() {
    let (_dir, _writer, app) = setup(true);
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(16));
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let app = app.clone();
        let barrier = barrier.clone();
        tasks.spawn(async move {
            barrier.wait().await;
            get(app, &format!("/v1/cards?ids={}", vec![ID; 100].join(",")))
                .await
                .status()
        });
    }
    while let Some(result) = tasks.join_next().await {
        assert_eq!(result.unwrap(), StatusCode::OK);
    }
}
#[tokio::test]
async fn head_conditional_and_batch_missing_have_expected_shape() {
    let (_dir, _writer, app) = setup(true);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri("/v1/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_ne!(response.headers()[header::CONTENT_LENGTH], "0");
    assert!(
        to_bytes(response.into_body(), 100)
            .await
            .unwrap()
            .is_empty()
    );
    let missing = "00000000-0000-0000-0000-000000000000";
    let batch = json(get(app, &format!("/v1/cards?ids={ID},{missing}")).await).await;
    assert_eq!(batch["cards"].as_array().unwrap().len(), 1);
    assert_eq!(batch["missing"][0], missing);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_http_socket_uses_bounded_transport_and_can_shutdown() {
    use std::io::{Read, Write};
    let (_dir, _writer, app) = setup(true);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(http::serve(listener, app, async {
        let _ = shutdown_rx.await;
    }));
    let response = tokio::task::spawn_blocking(move || {
        let mut socket = std::net::TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        socket
            .write_all(
                b"GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1:17317\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        response
    })
    .await
    .unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("\"ready\":true"));
    assert!(
        response
            .to_ascii_lowercase()
            .contains("content-type: application/json")
    );
    shutdown_tx.send(()).unwrap();
    server.await.unwrap().unwrap();
}
