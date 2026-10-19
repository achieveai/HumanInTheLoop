//! A Start-menu shortcut that carries the Inbox's app id, so Windows pops its
//! toasts up instead of filing them away.
//!
//! Windows shows a desktop app's toast banner only when the app id the toast
//! is sent under sits on an indexed Start-menu shortcut. Without one, the
//! toast still lands in the notification centre, silently, and `show()`
//! reports success. Seen on one Windows 11 machine: a toast under
//! `com.hitl.inbox` went to the centre with no banner until this shortcut
//! existed, while PowerShell's own (shortcut-backed) id popped up throughout.
//!
//! The MSI installs that shortcut for every user (Tauri's WiX template sets
//! `System.AppUserModel.ID` on it). A bare `hitl-inbox.exe` has none, so this
//! adds a per-user one, the same as the MSI's, when the MSI's is absent.

use std::path::{Path, PathBuf};

fn programs(base: &Path) -> PathBuf {
    base.join(r"Microsoft\Windows\Start Menu\Programs")
}

/// Make sure a Start-menu shortcut carries `app_id`. Returns the shortcut it
/// created, or `None` when one was already there.
///
/// Leaves an existing shortcut alone: the MSI's is the right one, and a user's
/// own is theirs. Windows indexes a new shortcut within a few seconds, so the
/// toast that triggers this may still arrive silently.
pub fn ensure_shortcut(product: &str, app_id: &str) -> Result<Option<PathBuf>, String> {
    let all_users = std::env::var_os("ProgramData").map(PathBuf::from);
    let user = std::env::var_os("APPDATA").map(PathBuf::from).ok_or("APPDATA is not set")?;
    let exe = std::env::current_exe().map_err(|e| format!("could not find this exe: {e}"))?;
    ensure_shortcut_in(all_users.as_deref(), &user, &exe, product, app_id)
}

/// [`ensure_shortcut`] against given `%ProgramData%` and `%APPDATA%` folders.
fn ensure_shortcut_in(
    all_users: Option<&Path>,
    user: &Path,
    exe: &Path,
    product: &str,
    app_id: &str,
) -> Result<Option<PathBuf>, String> {
    // The MSI's: `Programs\<product>\<product>.lnk`, for all users.
    if all_users.is_some_and(|dir| programs(dir).join(product).join(format!("{product}.lnk")).exists()) {
        return Ok(None);
    }
    let lnk = programs(user).join(format!("{product}.lnk"));
    if lnk.exists() {
        return Ok(None);
    }
    if let Some(dir) = lnk.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    create(&lnk, exe, app_id).map_err(|e| format!("could not create {}: {e}", lnk.display()))?;
    Ok(Some(lnk))
}

fn create(lnk: &Path, exe: &Path, app_id: &str) -> windows::core::Result<()> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, SHStrDupW, ShellLink};

    // SAFETY: plain COM calls on a thread this function initialises and
    // uninitialises itself; the PROPVARIANT owns one CoTaskMem string, freed
    // by PropVariantClear.
    unsafe {
        let initialised = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe.as_os_str()))?;
            if let Some(dir) = exe.parent() {
                link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
            }

            let store: IPropertyStore = link.cast()?;
            let mut value = PROPVARIANT::default();
            let inner = &mut *value.Anonymous.Anonymous;
            inner.vt = VT_LPWSTR;
            inner.Anonymous.pwszVal = SHStrDupW(&HSTRING::from(app_id))?;
            let set = store.SetValue(&PKEY_AppUserModel_ID, &value).and_then(|()| store.Commit());
            let _ = PropVariantClear(&mut value);
            set?;

            link.cast::<IPersistFile>()?.Save(&HSTRING::from(lnk.as_os_str()), true)
        })();
        if initialised {
            CoUninitialize();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The app id a shortcut carries, read back the way the shell reads it.
    fn app_id_of(lnk: &Path) -> String {
        use windows::core::{Interface, HSTRING};
        use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STGM_READ};
        use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
        use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            link.cast::<IPersistFile>().unwrap().Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).unwrap();
            let value = link.cast::<IPropertyStore>().unwrap().GetValue(&PKEY_AppUserModel_ID).unwrap();
            value.Anonymous.Anonymous.Anonymous.pwszVal.to_string().unwrap()
        }
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hitl-start-menu-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_bare_exe_gets_a_shortcut_carrying_its_app_id_once() {
        let (all, user) = (temp(), temp());
        let exe = std::env::current_exe().unwrap();

        let lnk = ensure_shortcut_in(Some(&all), &user, &exe, "HITL Inbox", "com.hitl.inbox").unwrap().unwrap();
        assert_eq!(lnk, programs(&user).join("HITL Inbox.lnk"));
        assert_eq!(app_id_of(&lnk), "com.hitl.inbox");
        // There already: left alone.
        assert_eq!(ensure_shortcut_in(Some(&all), &user, &exe, "HITL Inbox", "com.hitl.inbox").unwrap(), None);

        for dir in [all, user] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn the_msi_shortcut_means_nothing_to_add() {
        let (all, user) = (temp(), temp());
        let installed = programs(&all).join("HITL Inbox");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join("HITL Inbox.lnk"), b"").unwrap();

        let exe = std::env::current_exe().unwrap();
        assert_eq!(ensure_shortcut_in(Some(&all), &user, &exe, "HITL Inbox", "com.hitl.inbox").unwrap(), None);
        assert!(!programs(&user).exists());

        for dir in [all, user] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}
