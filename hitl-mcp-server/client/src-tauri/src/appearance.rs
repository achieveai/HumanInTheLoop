// Shared by both desktop hosts via #[path], keeping Tauri out of hitl-transport.
use hitl_transport::{
    appearance::{self, Theme},
    paths::hitl_dir,
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    theme: Theme,
    warning: Option<String>,
}

struct State {
    snapshot: Snapshot,
    dirty: bool,
    ever_dark: bool,
}
struct CurrentTheme(AtomicBool);

fn read() -> Result<Theme, String> {
    appearance::load(&hitl_dir()?)
}

pub fn initial() -> (Theme, Option<String>) {
    match read() {
        Ok(theme) => (theme, None),
        Err(error) => {
            log::warn!("{error}");
            (Theme::Light, Some(error))
        }
    }
}

pub fn window_builder<'a>(
    app: &tauri::AppHandle,
    builder: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>,
) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    let theme = match read() {
        Ok(theme) => theme,
        Err(error) => {
            log::warn!("Could not initialize window appearance: {error}");
            if app.state::<CurrentTheme>().0.load(Ordering::Relaxed) {
                Theme::Dark
            } else {
                Theme::Light
            }
        }
    };
    let script = format!(
        "if(window===window.top && /^(tauri:|https?:)$/.test(location.protocol) && \
        (location.hostname==='localhost'||location.hostname==='tauri.localhost')) \
        window.__HITL_THEME__={};",
        serde_json::to_string(&theme).expect("theme enum serializes")
    );
    let builder = builder.initialization_script(script);
    if theme == Theme::Dark {
        builder
            .theme(Some(tauri::Theme::Dark))
            .background_color(tauri::webview::Color(27, 32, 40, 255))
    } else {
        builder
    }
}

fn reconcile(app: &tauri::AppHandle, requested: Option<Theme>) -> Result<Snapshot, String> {
    let state = app.state::<Mutex<State>>();
    let mut state = state.lock().map_err(|_| "Appearance state lock failed")?;
    if let Some(theme) = requested {
        appearance::save(&hitl_dir()?, theme)?;
    }
    let previous = state.snapshot.clone();
    match read() {
        Ok(theme) => {
            state.snapshot = Snapshot {
                theme,
                warning: None,
            }
        }
        Err(error) => state.snapshot.warning = Some(error),
    }
    app.state::<CurrentTheme>()
        .0
        .store(state.snapshot.theme == Theme::Dark, Ordering::Relaxed);
    if previous != state.snapshot || state.dirty {
        let dark = state.snapshot.theme == Theme::Dark;
        state.ever_dark |= dark;
        let mut failures = Vec::new();
        if state.ever_dark {
            for window in app.webview_windows().values() {
                #[cfg(desktop)]
                {
                    if let Err(error) =
                        window.set_theme(if dark { Some(tauri::Theme::Dark) } else { None })
                    {
                        failures.push(error.to_string());
                    }
                    if let Err(error) = window.set_background_color(if dark {
                        Some(tauri::webview::Color(27, 32, 40, 255))
                    } else {
                        None
                    }) {
                        failures.push(error.to_string());
                    }
                }
            }
        }
        state.dirty = !failures.is_empty();
        if !failures.is_empty() {
            state.snapshot.warning = Some(format!(
                "Appearance saved, but a window could not update: {}",
                failures.join("; ")
            ));
        }
        if let Err(error) = app.emit("appearance-changed", &state.snapshot) {
            state.dirty = true;
            state.snapshot.warning = Some(format!("Could not deliver appearance update: {error}"));
        }
        if previous.warning != state.snapshot.warning {
            if let Some(warning) = &state.snapshot.warning {
                log::warn!("{warning}");
            }
        }
    }
    Ok(state.snapshot.clone())
}

#[tauri::command]
pub async fn get_appearance(app: tauri::AppHandle) -> Result<Snapshot, String> {
    reconcile(&app, None)
}

#[tauri::command]
pub async fn set_appearance(app: tauri::AppHandle, theme: Theme) -> Result<Snapshot, String> {
    reconcile(&app, Some(theme))
}

pub fn setup(app: &tauri::AppHandle) {
    let (theme, warning) = initial();
    app.manage(CurrentTheme(AtomicBool::new(theme == Theme::Dark)));
    app.manage(Mutex::new(State {
        snapshot: Snapshot { theme, warning },
        dirty: false,
        ever_dark: theme == Theme::Dark,
    }));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if let Err(error) = reconcile(&handle, None) {
                log::warn!("{error}");
            }
        }
    });
}
