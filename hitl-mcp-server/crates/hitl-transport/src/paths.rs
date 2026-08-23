//! Where this device keeps its HITL state.
//!
//! Every path in this crate used to start from `dirs::home_dir().join(".hitl")`,
//! which is two assumptions wearing one coat: that a home directory exists, and
//! that the application is allowed to write beside it. Android grants neither —
//! `dirs::home_dir()` returns `None` there, so the old `config_path()` did not
//! merely resolve badly, it panicked on the `.expect`.
//!
//! Resolution order, most explicit first:
//!
//!   1. [`set_hitl_dir`] — the host told us. Android's shell does this at
//!      startup with the app-data directory the platform handed it.
//!   2. `HITL_HOME` — the environment told us. This is also how a test gets a
//!      disposable directory, which matters more than it looks: on Windows
//!      `dirs::home_dir()` resolves through `SHGetKnownFolderPath` and ignores
//!      `HOME`/`USERPROFILE`, so without this there is no way to point the code
//!      somewhere safe.
//!   3. `~/.hitl` — the desktop default, unchanged.
//!
//! The host injects rather than this crate discovering, because discovering
//! would mean depending on `tauri` to reach an `AppHandle`, and this crate is
//! deliberately free of it (see the crate docs).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Overrides the platform default. Also the test seam.
pub const HOME_ENV: &str = "HITL_HOME";

static INJECTED: OnceLock<PathBuf> = OnceLock::new();

/// Tell the library where state lives, before anything reads it.
///
/// Returns `Err` with the already-set value if called twice. Second calls are a
/// programming error rather than a race to win: two different directories would
/// mean the config was read from one place and the drafts written to another,
/// and silently keeping the first would hide that.
pub fn set_hitl_dir(dir: PathBuf) -> Result<(), PathBuf> {
    INJECTED.set(dir)
}

/// The directory holding `config.json`, the databases and `drafts/`.
///
/// Does not create anything — callers that write use [`ensure_hitl_dir`].
pub fn hitl_dir() -> Result<PathBuf, String> {
    if let Some(dir) = INJECTED.get() {
        return Ok(dir.clone());
    }
    if let Some(dir) = std::env::var_os(HOME_ENV) {
        let dir = PathBuf::from(dir);
        if dir.as_os_str().is_empty() {
            return Err(format!("{HOME_ENV} is set but empty"));
        }
        return Ok(dir);
    }
    default_dir().ok_or_else(|| {
        format!(
            "could not determine where to keep HITL state: no home directory, \
             and neither an injected path nor {HOME_ENV} was provided"
        )
    })
}

/// [`hitl_dir`], created if it does not exist.
pub fn ensure_hitl_dir() -> Result<PathBuf, String> {
    let dir = hitl_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A named file inside the state directory, with the directory created.
pub fn in_hitl_dir(name: impl AsRef<Path>) -> Result<PathBuf, String> {
    Ok(ensure_hitl_dir()?.join(name))
}

#[cfg(target_os = "android")]
fn default_dir() -> Option<PathBuf> {
    // There is no sensible default: an Android app's writable directory is
    // assigned by the platform and handed to the shell, which must pass it to
    // `set_hitl_dir`. Guessing a path here would produce one that exists and
    // cannot be written to, which fails later and less clearly than this does.
    None
}

#[cfg(not(target_os = "android"))]
fn default_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".hitl"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises the environment across these tests.
    ///
    /// The environment is per-process, not per-test, and cargo runs tests in
    /// parallel by default. Without this lock the desktop-default case reads
    /// whatever `HITL_HOME` a concurrent test happens to have set mid-flight,
    /// which is not hypothetical: it is how this was first caught.
    ///
    /// `INJECTED` is deliberately not exercised here. A `OnceLock` set by one
    /// test would leak into every other test in the binary — which is exactly
    /// the property that makes it the right type for the real thing.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_env<T>(value: Option<&str>, f: impl FnOnce() -> T) -> T {
        // A panicking test poisons the lock; the guard still hands back the
        // environment, so recovering keeps one failure from cascading into
        // every later case.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os(HOME_ENV);
        match value {
            Some(v) => std::env::set_var(HOME_ENV, v),
            None => std::env::remove_var(HOME_ENV),
        }
        let out = f();
        match previous {
            Some(v) => std::env::set_var(HOME_ENV, v),
            None => std::env::remove_var(HOME_ENV),
        }
        out
    }

    #[test]
    fn the_env_var_wins_over_the_platform_default() {
        with_env(Some("/tmp/scratch-hitl"), || {
            assert_eq!(hitl_dir().unwrap(), PathBuf::from("/tmp/scratch-hitl"));
        });
    }

    #[test]
    fn an_empty_env_var_is_an_error_rather_than_the_current_directory() {
        // `PathBuf::from("")` joins to a bare relative name, so honouring it
        // would scatter `config.json` into whatever the working directory
        // happened to be.
        with_env(Some(""), || {
            assert!(hitl_dir().is_err());
        });
    }

    #[test]
    #[cfg(not(target_os = "android"))]
    fn the_desktop_default_is_still_dot_hitl_beside_home() {
        with_env(None, || {
            let dir = hitl_dir().unwrap();
            assert!(dir.ends_with(".hitl"), "got {}", dir.display());
        });
    }

    #[test]
    fn a_named_file_lands_inside_the_directory() {
        let tmp = std::env::temp_dir().join("hitl-paths-test");
        let _ = std::fs::remove_dir_all(&tmp);
        with_env(Some(tmp.to_str().unwrap()), || {
            let path = in_hitl_dir("config.json").unwrap();
            assert_eq!(path, tmp.join("config.json"));
            assert!(tmp.is_dir(), "the directory should have been created");
        });
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
