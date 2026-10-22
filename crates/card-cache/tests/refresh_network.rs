//! Opt-in small connectivity probe; never enumerates the full catalog.
use std::{
    io::Read,
    net::ToSocketAddrs,
    time::{Duration, Instant},
};
#[test]
#[ignore = "live diagnostic: at most two single-card requests"]
fn provider_address_families() -> anyhow::Result<()> {
    println!(
        "mtgch addresses: {:?}",
        ("mtgch.com", 443).to_socket_addrs()?.collect::<Vec<_>>()
    );
    for family in [
        ureq::config::IpFamily::Ipv6Only,
        ureq::config::IpFamily::Ipv4Only,
    ] {
        let agent = ureq::Agent::config_builder()
            .ip_family(family)
            .timeout_global(Some(Duration::from_secs(20)))
            .timeout_connect(Some(Duration::from_secs(5)))
            .timeout_recv_body(Some(Duration::from_secs(10)))
            .build()
            .new_agent();
        let start = Instant::now();
        let response = agent
            .get("https://mtgch.com/api/v2/result?q=set%3Afra&view=1&page_size=1")
            .header(
                "User-Agent",
                "mtga-card-cache/0.1 (connectivity diagnostic)",
            )
            .header("Accept", "application/json")
            .header("Accept-Encoding", "gzip")
            .call();
        match response {
            Ok(mut response) => {
                println!(
                    "{family:?}: status={} encoding={:?}, elapsed={:?}",
                    response.status(),
                    response.headers().get("content-encoding"),
                    start.elapsed()
                );
                let mut buf = Vec::new();
                let read = response
                    .body_mut()
                    .as_reader()
                    .take(128 * 1024)
                    .read_to_end(&mut buf);
                println!(
                    "{family:?}: bytes={}, result={read:?}, elapsed={:?}",
                    buf.len(),
                    start.elapsed()
                );
            }
            Err(error) => println!("{family:?}: {error}, elapsed={:?}", start.elapsed()),
        }
    }
    Ok(())
}
