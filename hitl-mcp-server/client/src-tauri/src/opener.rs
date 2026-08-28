//! Handing a path or a URL to the OS.
//!
//! Deliberately not `tauri-plugin-opener`: adding it would mean editing
//! `capabilities/default.json`, and `tauri-plugin-shell`'s `open` — the thing
//! this crate already carries — is deprecated. Spawning the platform opener
//! directly costs one `Command` and no new dependency.
//!
//! Nothing here goes through a shell. `Command::new(opener).arg(x)` passes `x`
//! as a single argument, so `&`, `|` and friends are inert. That is a property
//! of this module worth preserving: routing through `cmd /C start` would both
//! reintroduce shell parsing and flash a console window at a process built with
//! `#![windows_subsystem = "windows"]`.
//!
//! The URL validation `open_external` relies on lives in
//! `hitl_transport::url` — pure, and shared with anything else that would want
//! the same allowlist without also linking a process spawn.

use std::ffi::OsStr;

use hitl_transport::url::validate_external_url;

#[cfg(target_os = "windows")]
const OPENER: &str = "explorer.exe";
#[cfg(target_os = "macos")]
const OPENER: &str = "open";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const OPENER: &str = "xdg-open";

/// Hand `target` to the platform's opener.
pub fn spawn<S: AsRef<OsStr>>(target: S) -> Result<(), String> {
    let target = target.as_ref();

    // explorer.exe reports a non-zero exit even when it succeeds, so only a
    // failure to spawn at all is worth reporting.
    std::process::Command::new(OPENER)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{OPENER} could not open {}: {e}", target.to_string_lossy()))
}

/// Tauri command: open a URL from the plan in the system browser.
///
/// Used by the click-to-load image placeholder, which cannot fetch remote
/// images itself because the CSP forbids it.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if let Err(e) = validate_external_url(&url) {
        log::warn!("Blocked open_external: {} ({:?})", e, url);
        return Err(e);
    }

    log::info!("Opening {} externally", url);
    spawn(&url)
}
