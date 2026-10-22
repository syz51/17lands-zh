//! Loopback-only reproducible HTTP load probe, one new connection per request.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let address: SocketAddr = args
        .first()
        .map(String::as_str)
        .unwrap_or("127.0.0.1:17317")
        .parse()?;
    let path = args
        .get(1)
        .map(String::as_str)
        .unwrap_or("/v1/status")
        .to_owned();
    let concurrency: usize = args.get(2).map(String::as_str).unwrap_or("16").parse()?;
    let per_worker: usize = args.get(3).map(String::as_str).unwrap_or("100").parse()?;
    if !address.ip().is_loopback()
        || !path.starts_with('/')
        || path.contains(['\r', '\n'])
        || !(1..=256).contains(&concurrency)
        || !(1..=10_000).contains(&per_worker)
    {
        return Err(
            "expected loopback address, HTTP path, concurrency1..256, requests/worker1..10000"
                .into(),
        );
    }
    let barrier = Arc::new(Barrier::new(concurrency + 1));
    let mut workers = Vec::new();
    for _ in 0..concurrency {
        let barrier = Arc::clone(&barrier);
        let path = path.clone();
        workers.push(std::thread::spawn(move || {
            let mut durations = Vec::with_capacity(per_worker);
            let mut failures = 0usize;
            let mut response_bytes = 0usize;
            barrier.wait();
            for _ in 0..per_worker {
                let started = Instant::now();
                let request = || -> std::io::Result<Vec<u8>> {
                    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
                    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
                    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
                    write!(
                        stream,
                        "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
                    )?;
                    let mut bytes = Vec::new();
                    stream.take(4 * 1024 * 1024).read_to_end(&mut bytes)?;
                    Ok(bytes)
                };
                match request() {
                    Ok(bytes) if bytes.starts_with(b"HTTP/1.1 200 ") => {
                        response_bytes += bytes.len()
                    }
                    _ => failures += 1,
                }
                durations.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            (durations, failures, response_bytes)
        }));
    }
    let started = Instant::now();
    barrier.wait();
    let mut durations = Vec::with_capacity(concurrency * per_worker);
    let mut failures = 0;
    let mut response_bytes = 0;
    for worker in workers {
        let (samples, failed, bytes) = worker.join().map_err(|_| "load worker panicked")?;
        durations.extend(samples);
        failures += failed;
        response_bytes += bytes;
    }
    let elapsed = started.elapsed().as_secs_f64();
    durations.sort_by(f64::total_cmp);
    let percentile = |fraction: f64| {
        durations[((durations.len() as f64 * fraction).ceil() as usize).saturating_sub(1)]
    };
    println!(
        "{{\"concurrency\":{concurrency},\"requests\":{},\"failed\":{failures},\"elapsed_seconds\":{elapsed:.6},\"requests_per_second\":{:.2},\"p50_ms\":{:.3},\"p95_ms\":{:.3},\"p99_ms\":{:.3},\"response_bytes\":{response_bytes},\"new_connection_per_request\":true}}",
        durations.len(),
        durations.len() as f64 / elapsed,
        percentile(0.50),
        percentile(0.95),
        percentile(0.99)
    );
    if failures > 0 {
        return Err("HTTP load probe had failures".into());
    }
    Ok(())
}
