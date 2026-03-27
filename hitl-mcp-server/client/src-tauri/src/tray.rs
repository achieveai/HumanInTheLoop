use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle,
};

/// Set up the system tray icon and menu.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let status = MenuItem::with_id(app, "status", "HITL — Connected", false, None::<&str>)?;
    let separator = MenuItem::with_id(app, "sep", "---", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&status, &separator, &quit])?;

    let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("HITL - Human in the Loop")
        .menu(&menu)
        .on_menu_event(|_app, event| match event.id.as_ref() {
            "quit" => {
                // Use process::exit instead of app.exit() because the RunEvent::ExitRequested
                // handler in main() calls prevent_exit() to keep the app alive when windows close.
                // app.exit(0) would trigger that handler and get blocked.
                std::process::exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
