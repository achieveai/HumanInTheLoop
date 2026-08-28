//! `hitl-archivist` — the headless recorder.
//!
//! Subscribes to the same ntfy topic every HITL client does and writes every
//! event to a local SQLite log, forever. It opens no window, plays no sound and
//! decides nothing; the whole of its behaviour is "write down what arrived, and
//! capture the attachment bodies before ntfy drops them".
//!
//! It is an **optimization, not a dependency** (spec §11). Every client works
//! with this process stopped — it simply cannot see further back than ntfy's
//! own cache window. Nothing here is on anyone's critical path.

mod archive;
mod fetcher;
mod http;
mod sink;

use std::sync::Arc;

use hitl_transport::config::load_config;
use hitl_transport::ntfy::subscribe::subscribe_loop;
use hitl_transport::status::ConnectionStatus;

use crate::archive::Archive;
use crate::sink::ArchivistSink;

/// Where the archive lives. Beside `config.json`, whose security posture it
/// inherits: both hold decrypted material in the home directory (spec §11).
///
/// `HITL_ARCHIVIST_DB` overrides it. That exists so a live run can be pointed
/// somewhere disposable: `dirs::home_dir()` on Windows resolves through
/// `SHGetKnownFolderPath` and ignores `HOME`/`USERPROFILE`, so there is
/// otherwise no way to try this binary without writing to the real home.
fn archive_path() -> Result<std::path::PathBuf, String> {
    if let Some(path) = std::env::var_os("HITL_ARCHIVIST_DB") {
        let path = std::path::PathBuf::from(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        return Ok(path);
    }

    hitl_transport::paths::in_hitl_dir("archive.db")
}

fn init_logging() {
    // `HITL_LOG` matches the client's convention, so one habit covers both.
    env_logger::Builder::from_env(env_logger::Env::new().filter_or("HITL_LOG", "info")).init();
}

#[tokio::main]
async fn main() {
    init_logging();

    if let Err(e) = run().await {
        log::error!("{e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let config = load_config()?;
    let path = archive_path()?;
    let archive = Arc::new(Archive::open(&path)?);
    log::info!(
        "archive at {} holds {} events",
        path.display(),
        archive.count_events().unwrap_or(-1)
    );

    // Bodies are fetched off the subscribe loop, not on it: the sink must not
    // block (a 60 s attachment timeout would stall every later event behind
    // it), so the job is raised the instant the event is recorded and this task
    // picks it straight up. See `ArchivistSink::capture_body_of`.
    let (jobs_tx, jobs_rx) = tokio::sync::mpsc::unbounded_channel();
    let fetcher = tokio::spawn(fetcher::run(
        archive.clone(),
        jobs_rx,
        config.encryption_key.clone(),
    ));

    let addr = http::bind_addr(
        std::env::var("HITL_ARCHIVIST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(http::DEFAULT_PORT),
    );
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("could not bind the backfill server to {addr}: {e}"))?;
    log::info!("backfill on http://{addr}/events?since=<seq>");
    // One `Archive` — one connection, one set of counters. Opening the file
    // twice would give the backfill server a second connection whose stats
    // always read zero.
    let served = archive.clone();
    let server = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, http::router(served)).await {
            log::error!("backfill server stopped: {e}");
        }
    });

    let sink = ArchivistSink::new(archive, jobs_tx, config.encryption_key.clone());
    let status = ConnectionStatus::default();

    // `subscribe_loop` never returns: it reconnects forever. Ctrl-C, or the
    // service manager stopping us, is the only way out.
    tokio::select! {
        _ = subscribe_loop(&sink, &status) => {}
        _ = tokio::signal::ctrl_c() => log::info!("shutting down"),
    }

    server.abort();
    fetcher.abort();
    Ok(())
}
