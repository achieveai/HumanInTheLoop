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

use std::ffi::OsStr;

/// A URL longer than this is not something a human is going to click through.
const MAX_URL_BYTES: usize = 2048;

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

/// The characters RFC 3986 permits anywhere in a URI.
///
/// The interesting part is what this excludes: whitespace, every control
/// character, `"`, `<`, `>`, `\`, `^`, `` ` ``, `{`, `}` and `|`. So a
/// backslash — and with it any UNC path — cannot appear, and neither can a
/// newline that would let one argument look like two.
fn is_uri_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            '-' | '.' | '_' | '~' | ':' | '/' | '?' | '#' | '[' | ']' | '@'
                | '!' | '$' | '&' | '\'' | '(' | ')' | '*' | '+' | ',' | ';' | '=' | '%'
        )
}

fn strip_http_scheme(raw: &str) -> Option<&str> {
    ["https://", "http://"].into_iter().find_map(|prefix| {
        (raw.len() >= prefix.len() && raw[..prefix.len()].eq_ignore_ascii_case(prefix))
            .then(|| &raw[prefix.len()..])
    })
}

/// Reject anything that is not a plain `http(s)` URL.
///
/// This string came out of markdown in a plan file an LLM agent wrote, so it is
/// untrusted input on its way to a process spawn. The scheme allowlist is the
/// load-bearing check — it is what stops `file:///C:/Users/.../id_rsa` and
/// `javascript:` — and the character rules stop the argument being anything but
/// one argument.
pub fn validate_external_url(raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err("refusing to open an empty URL".to_string());
    }
    if raw.len() > MAX_URL_BYTES {
        return Err(format!("refusing to open a URL longer than {MAX_URL_BYTES} bytes"));
    }

    if let Some(bad) = raw.chars().find(|c| !is_uri_char(*c)) {
        return Err(format!(
            "refusing to open a URL containing {bad:?}, which is not valid in a URI"
        ));
    }

    // `%` must introduce a real percent-encoding. Without this, `%USERPROFILE%`
    // survives to explorer.exe, which expands environment strings — turning a
    // link in a plan file into a way to send the local username to a remote
    // host.
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return Err("refusing to open a URL with a malformed percent-escape".to_string());
            }
            i += 3;
        } else {
            i += 1;
        }
    }

    let rest = strip_http_scheme(raw)
        .ok_or_else(|| "refusing to open a URL that is not http:// or https://".to_string())?;

    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if !host.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err("refusing to open a URL with no host".to_string());
    }

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rejects(url: &str) {
        assert!(
            validate_external_url(url).is_err(),
            "should have refused to open {url:?}"
        );
    }

    fn accepts(url: &str) {
        assert!(
            validate_external_url(url).is_ok(),
            "should have opened {url:?}, got {:?}",
            validate_external_url(url)
        );
    }

    #[test]
    fn ordinary_links_open() {
        accepts("https://example.com");
        accepts("http://example.com");
        accepts("https://example.com/a/b.png");
        accepts("https://example.com:8443/a?b=c&d=e#frag");
        accepts("https://user@example.com/path");
        accepts("https://example.com/a%20b.png");
        accepts("https://192.168.1.4:3000/img.png");
    }

    #[test]
    fn the_scheme_is_matched_case_insensitively() {
        accepts("HTTPS://example.com");
        accepts("HtTp://example.com");
    }

    #[test]
    fn only_http_and_https_are_openable() {
        // The whole point: none of these should reach a process spawn.
        rejects("file:///C:/Users/me/.ssh/id_rsa");
        rejects("file:///etc/passwd");
        rejects("javascript:alert(1)");
        rejects("data:text/html,<script>alert(1)</script>");
        rejects("vbscript:msgbox(1)");
        rejects("mailto:someone@example.com");
        rejects("ftp://example.com/x");
        rejects("ms-msdt:/id");
        rejects("search-ms:query=x");
        rejects("shell:startup");
        rejects("//example.com/x");
        rejects("example.com");
        rejects("C:\\Windows\\System32\\calc.exe");
    }

    #[test]
    fn a_unc_path_cannot_be_smuggled_through() {
        rejects("\\\\attacker\\share\\payload.exe");
        // A backslash is not a URI character, so it cannot appear at all.
        rejects("https://example.com\\..\\..\\x");
    }

    #[test]
    fn arguments_cannot_be_split_or_quoted_apart() {
        rejects("https://example.com /c calc.exe");
        rejects("https://example.com\ncalc.exe");
        rejects("https://example.com\r\ncalc.exe");
        rejects("https://example.com\tcalc");
        rejects("https://example.com\"");
        rejects("https://exa\u{0000}mple.com");
    }

    #[test]
    fn shell_and_expansion_metacharacters_are_refused() {
        rejects("https://example.com|calc");
        rejects("https://example.com>out.txt");
        rejects("https://example.com<in.txt");
        rejects("https://example.com^calc");
        rejects("https://example.com`calc`");
        rejects("https://example.com{x}");
    }

    #[test]
    fn environment_expansion_cannot_survive_to_the_opener() {
        // explorer.exe expands %VAR%. A well-formed percent-escape needs two
        // hex digits, which `%USERPROFILE%` and friends do not have.
        rejects("https://evil.test/leak?u=%USERPROFILE%");
        rejects("https://evil.test/leak?u=%USERNAME%");
        rejects("https://example.com/%");
        rejects("https://example.com/%A");
        rejects("https://example.com/%ZZ");
        // But a genuine escape still works.
        accepts("https://example.com/%2Fa%3Fb");
    }

    #[test]
    fn a_url_needs_an_actual_host() {
        rejects("https://");
        rejects("http:///etc/passwd");
        rejects("https://?q=1");
        rejects("https://#frag");
        rejects("https://@");
    }

    #[test]
    fn absurdly_long_urls_are_refused() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
        rejects(&long);
    }

    #[test]
    fn non_ascii_is_refused_rather_than_guessed_at() {
        // Punycode is the browser's job; a raw IDN here would also let RTL
        // overrides and homoglyphs into the argument.
        rejects("https://exämple.com");
        rejects("https://example.com/\u{202E}gnp.exe");
    }

    #[test]
    fn an_empty_url_is_refused() {
        rejects("");
    }
}
