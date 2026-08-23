//! File logging to `~/.hitl/client.log`.
//!
//! `main.rs:1` carries `#![windows_subsystem = "windows"]`, which detaches the
//! process from a console — so every `eprintln!` in this crate wrote to a
//! discarded stderr on the primary platform. A failure to decrypt, an
//! unrecognized message type, a window that never opened: all invisible, with
//! no way for the user to find out what happened. Everything routes through
//! `log` now and lands in a file the tray can open.
//!
//! stderr is still written as well, so `cargo run` and `cargo test` behave as
//! they always did.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use log::{LevelFilter, Metadata, Record};

/// Past this size the log is rotated to `client.log.1` (one generation kept).
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Path of the current log file, or `None` if there is nowhere to keep state.
pub fn log_path() -> Option<PathBuf> {
    hitl_transport::paths::hitl_dir().ok().map(|dir| dir.join("client.log"))
}

fn rotated_path(path: &std::path::Path) -> PathBuf {
    let mut rotated = path.as_os_str().to_os_string();
    rotated.push(".1");
    PathBuf::from(rotated)
}

struct FileLogger {
    path: PathBuf,
    /// `None` once the file could not be opened — a broken log must never take
    /// the client down with it, and retrying on every record would be worse.
    file: Mutex<Option<File>>,
}

impl FileLogger {
    fn open(path: &std::path::Path) -> Option<File> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        OpenOptions::new().create(true).append(true).open(path).ok()
    }

    /// Swap in a fresh file once the current one grows past the cap.
    fn rotate_if_needed(&self, file: &mut Option<File>) {
        let too_big = file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .is_some_and(|m| m.len() > MAX_LOG_BYTES);
        if !too_big {
            return;
        }

        *file = None; // drop the handle first; Windows will not rename an open file
        let _ = std::fs::rename(&self.path, rotated_path(&self.path));
        *file = Self::open(&self.path);
    }
}

impl log::Log for FileLogger {
    fn enabled(&self, _metadata: &Metadata) -> bool {
        true // the global max level filter already gates this
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let line = format!(
            "{} {:<5} [{}] {}\n",
            format_timestamp(now_millis()),
            record.level(),
            record.target(),
            record.args()
        );

        eprint!("{line}");

        if let Ok(mut file) = self.file.lock() {
            self.rotate_if_needed(&mut file);
            if let Some(handle) = file.as_mut() {
                let _ = handle.write_all(line.as_bytes());
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock() {
            if let Some(handle) = file.as_mut() {
                let _ = handle.flush();
            }
        }
    }
}

/// Install the file logger. Call once, first thing in `main()`.
///
/// `HITL_LOG` overrides the level (`trace`/`debug`/`info`/`warn`/`error`).
pub fn init() {
    let Some(path) = log_path() else {
        return;
    };

    let level = std::env::var("HITL_LOG")
        .ok()
        .and_then(|v| v.parse::<LevelFilter>().ok())
        .unwrap_or(LevelFilter::Info);

    let logger = FileLogger {
        file: Mutex::new(FileLogger::open(&path)),
        path,
    };

    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(level);
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `2026-08-11T14:03:22.123Z` from unix milliseconds.
///
/// Hand-rolled rather than pulling in a date crate for one format string. The
/// log is read by a human hunting a failure, so a bare epoch would defeat the
/// point of writing it at all.
fn format_timestamp(unix_ms: u64) -> String {
    let secs = unix_ms / 1000;
    let millis = unix_ms % 1000;
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let second_of_day = secs % 86_400;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60,
        millis
    )
}

/// Days since the unix epoch → (year, month, day), proleptic Gregorian.
/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };

    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_a_known_instant_as_iso8601_utc() {
        // 2026-08-12T14:03:22.123Z
        assert_eq!(format_timestamp(1_786_543_402_123), "2026-08-12T14:03:22.123Z");
    }

    #[test]
    fn formats_the_epoch_itself() {
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn handles_leap_day_and_year_boundaries() {
        // 2024-02-29T00:00:00Z — a leap day the naive 365-day arithmetic misses.
        assert_eq!(format_timestamp(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        // 2023-12-31T23:59:59.999Z
        assert_eq!(format_timestamp(1_704_067_199_999), "2023-12-31T23:59:59.999Z");
        // 2000-03-01 — the century leap rule.
        assert_eq!(format_timestamp(951_868_800_000), "2000-03-01T00:00:00.000Z");
    }

    #[test]
    fn rotated_path_appends_a_generation_suffix() {
        let rotated = rotated_path(std::path::Path::new("/home/u/.hitl/client.log"));
        assert!(rotated.to_string_lossy().ends_with("client.log.1"));
    }

    #[test]
    fn rotation_replaces_the_file_once_it_exceeds_the_cap() {
        let dir = std::env::temp_dir().join(format!("hitl-log-test-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("client.log");

        let logger = FileLogger {
            file: Mutex::new(FileLogger::open(&path)),
            path: path.clone(),
        };

        {
            let mut file = logger.file.lock().unwrap();
            file.as_mut()
                .unwrap()
                .write_all(&vec![b'x'; (MAX_LOG_BYTES + 1) as usize])
                .unwrap();
            logger.rotate_if_needed(&mut file);
        }

        assert!(rotated_path(&path).exists(), "previous generation must be kept");
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            0,
            "the live log must start empty after a rotation"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
