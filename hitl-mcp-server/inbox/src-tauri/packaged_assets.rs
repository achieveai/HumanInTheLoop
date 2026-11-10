use std::{fs, io, path::Path};

pub const RUNTIME_FILES: &[&str] = &[
    "dark-mode.css",
    "detail-shell.js",
    "diagram-renderer.html",
    "diagram-renderer.js",
    "diagrams.css",
    "diagrams.js",
    "icons.js",
    "inbox.css",
    "inbox.js",
    "index.html",
    "layout.js",
    "notifications.js",
    "pane-agents.js",
    "pane-detail.js",
    "pane-list.js",
    "pane-thread.js",
    "panes.js",
    "participants.js",
    "render-agent-message.js",
    "render-handoff.js",
    "render-notification.js",
    "render-question.js",
    "render-review.js",
    "reply.js",
    "review.css",
    "review.js",
    "settings.js",
    "share.js",
    "work-document.css",
    "work-document.js",
];

pub fn stage_runtime_assets(source: &Path, output: &Path) -> io::Result<()> {
    // Only the dedicated generated output is passed by build.rs.
    if output.exists() { fs::remove_dir_all(output)?; }
    fs::create_dir_all(output)?;
    for name in RUNTIME_FILES { fs::copy(source.join(name), output.join(name))?; }
    copy_directory(&source.join("vendor"), &output.join("vendor"))
}
fn copy_directory(source: &Path, output: &Path) -> io::Result<()> {
    fs::create_dir_all(output)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "symlink in runtime assets")); }
        if entry.file_type()?.is_dir() { copy_directory(&entry.path(), &output.join(entry.file_name()))?; }
        else { fs::copy(entry.path(), output.join(entry.file_name()))?; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn runtime_assets_include_nested_vendor_but_exclude_local_history_and_probes() {
        let base = std::env::temp_dir().join(format!("hitl-assets-test-{}", std::process::id()));
        let source = base.join("src");
        let output = base.join("dist");
        fs::create_dir_all(source.join("vendor/nested")).unwrap();
        fs::create_dir_all(&output).unwrap();
        for file in RUNTIME_FILES {
            fs::write(source.join(file), b"runtime").unwrap();
        }
        fs::write(source.join("vendor/nested/renderer.js"), b"vendor").unwrap();
        for file in ["harness-fixture.json", "inbox-harness.html", "probe-reviews.html", "debug.js"] {
            fs::write(source.join(file), b"private local data").unwrap();
            fs::write(output.join(file), b"stale private data").unwrap();
        }
        stage_runtime_assets(&source, &output).unwrap();
        assert!(output.join("index.html").is_file());
        assert!(output.join("vendor/nested/renderer.js").is_file());
        for file in ["harness-fixture.json", "inbox-harness.html", "probe-reviews.html", "debug.js"] {
            assert!(!output.join(file).exists(), "packaged {file}");
            assert!(source.join(file).exists(), "modified source {file}");
        }
        fs::remove_dir_all(&base).unwrap();
    }
}
