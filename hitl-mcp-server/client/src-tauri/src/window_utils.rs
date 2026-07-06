//! Show a window without letting it steal OS keyboard focus.
//!
//! On Windows, Tauri's `Window::show()` maps to Win32 `ShowWindow(hwnd, SW_SHOW)`,
//! which activates the window regardless of the `.focused(false)` builder flag —
//! that flag only governs the window's state at creation, not later `show()` calls.
//! We call `ShowWindow(hwnd, SW_SHOWNOACTIVATE)` directly so dialogs and
//! notifications don't yank focus away from whatever the user is typing in.

#[cfg(windows)]
pub fn show_window_no_activate(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};

    let hwnd = window.hwnd()?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn show_window_no_activate(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.show()
}
