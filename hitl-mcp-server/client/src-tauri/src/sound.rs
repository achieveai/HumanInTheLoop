use std::io::Cursor;

use rodio::{Decoder, OutputStream, Sink};

const NOTIFICATION_WAV: &[u8] = include_bytes!("../../../sounds/notification.wav");

/// Returns true if the current session is a local console (not RDP/remote).
fn is_local_console() -> bool {
    #[cfg(target_os = "windows")]
    {
        // SM_REMOTESESSION (0x1000) is non-zero when running in a remote desktop session
        const SM_REMOTESESSION: i32 = 0x1000;
        let result = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(SM_REMOTESESSION) };
        result == 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows, assume local
        true
    }
}

/// Play the notification doorbell sound.
/// Uses higher volume on local console, lower on remote/RDP sessions.
pub fn play_notification() {
    std::thread::spawn(|| {
        let volume = if is_local_console() { 0.4 } else { 0.25 };

        let Ok((_stream, stream_handle)) = OutputStream::try_default() else {
            log::warn!("Failed to open audio output");
            return;
        };

        let Ok(sink) = Sink::try_new(&stream_handle) else {
            log::warn!("Failed to create audio sink");
            return;
        };

        let cursor = Cursor::new(NOTIFICATION_WAV);
        let Ok(source) = Decoder::new(cursor) else {
            log::warn!("Failed to decode notification sound");
            return;
        };

        sink.set_volume(volume);
        sink.append(source);
        sink.sleep_until_end();
    });
}
