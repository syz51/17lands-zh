use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use mtga_card_cache::{
    db::{Reader, Writer},
    http::{self, ReadPool},
    install,
    model::CardRecord,
    paths, runtime,
};
use std::{
    fs::File,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::PathBuf,
};

#[derive(Parser)]
#[command(about = "Local read-only Chinese card cache")]
struct Args {
    #[arg(
        long,
        global = true,
        help = "Database path (default: platform user data directory/17lands-zh/cards.sqlite)"
    )]
    db: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, env = "CARD_CACHE_LISTEN", default_value = http::LISTEN_ADDRESS)]
        listen: SocketAddr,
        #[arg(long, env = "CARD_CACHE_ALLOWED_HOSTS", value_delimiter = ',')]
        allowed_hosts: Vec<String>,
    },
    Status,
    /// Check the complete upstream dataset now if due; --force overrides daily scheduling.
    Refresh {
        #[arg(long)]
        force: bool,
        #[arg(long)]
        archive: Option<PathBuf>,
    },
    /// Atomically publish a UTF-8 JSONL file of normalized CardRecord values.
    Import {
        file: PathBuf,
    },
    /// Install and start a user LaunchAgent (macOS only).
    Install {
        #[arg(long)]
        dry_run: bool,
    },
    /// Stop and remove the user LaunchAgent; preserve the database and binary.
    Uninstall {
        #[arg(long)]
        dry_run: bool,
    },
}
fn main() -> Result<()> {
    let args = Args::parse();
    // Lifecycle commands enforce their platform contract before resolving user paths.
    match args.command {
        Command::Install { dry_run } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&install::install(args.db.as_deref(), dry_run)?)?
            );
            return Ok(());
        }
        Command::Uninstall { dry_run } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&install::uninstall(args.db.as_deref(), dry_run)?)?
            );
            return Ok(());
        }
        _ => {}
    }
    let database = args.db.map(Ok).unwrap_or_else(paths::default_database)?;
    match args.command {
        Command::Status => {
            let reader = Reader::open(&database)?;
            let mut status = serde_json::to_value(reader.status()?)?;
            status["journal_mode"] = reader.journal_mode()?.into();
            status["database_bytes"] = std::fs::metadata(&database)?.len().into();
            println!("{}", serde_json::to_string_pretty(&status)?);
        }
        Command::Import { file } => {
            let mut writer = Writer::open(database)?;
            let file = BufReader::new(File::open(file)?);
            let revision = writer.publish_snapshot(|sink| {
                for (line_number, line) in file.lines().enumerate() {
                    let line = line?;
                    if line.trim().is_empty() {
                        continue;
                    }
                    let card: CardRecord = serde_json::from_str(&line)
                        .with_context(|| format!("JSONL line {}", line_number + 1))?;
                    sink.insert(&card)?;
                }
                Ok(())
            })?;
            println!("published revision {revision}");
        }
        Command::Refresh { force, archive } => {
            let mut writer = Writer::open(&database)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&runtime::refresh_once(
                    &mut writer,
                    &database,
                    force,
                    archive.as_deref()
                )?)?
            );
        }
        Command::Serve {
            listen,
            allowed_hosts,
        } => {
            ensure!(
                listen.ip().is_loopback() || !allowed_hosts.is_empty(),
                "non-loopback listening requires explicit --allowed-hosts"
            );
            let writer = Writer::open(&database)?;
            let pool = ReadPool::open(&database, http::READERS)?;
            let app = http::router_with_hosts(pool, &allowed_hosts)?;
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .max_blocking_threads(http::READERS)
                .enable_all()
                .build()?;
            runtime.block_on(async {
                let listener = tokio::net::TcpListener::bind(listen).await?;
                let _refresh_worker = runtime::start_worker(writer, database)?;
                eprintln!("card-cache listening on http://{listen}");
                http::serve(listener, app, async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await
            })?;
        }
        Command::Install { .. } | Command::Uninstall { .. } => unreachable!(),
    }
    Ok(())
}
