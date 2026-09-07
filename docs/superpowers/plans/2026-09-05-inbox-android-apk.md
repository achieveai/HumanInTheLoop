# Inbox Android APK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Produce a locally installable ARM64 Inbox APK for the user's Pixel 10 and a repeatable build command.

**Architecture:** Reuse the existing Inbox Rust and JavaScript implementation. Initialize mobile app-private storage before any config/database access, expose validated first-run connection setup, and package with Tauri's generated Android host.

**Tech Stack:** Tauri 2, Rust, vanilla JavaScript, Playwright, Android SDK, NDK r28 or newer.

**Spec:** docs/superpowers/specs/2026-08-21-inbox-mobile-design.md

## Global Constraints

- Android only; personal sideload only. Minimum target is API 26 (Android 8).
- No background service. ntfy's own Android app remains the alerting channel.
- No wire-schema change, no PROTOCOL_VERSION bump.
- The archivist is an optimization, not a dependency.
- Settings accept topicId and a 64-hex encryptionKey, stored app-private; never embed real credentials in assets or logs.
- Preserve desktop behavior and the existing responsive layout, optimistic actions, review, filtering, and pane controls.
- Reuse existing code; no enhanced/v2 copies. Move main.rs implementation to lib.rs, leaving a thin desktop entry.
- No source or toolchain work on B:. Authoritative workspace remains the previously selected C: copy on design/llm-inbox.
- One source implementer at a time. Toolchain provisioning is independent and owns no project source.
- Signing choice and SDK license acceptance require the pending HITL answers. Do not publish/push or install on a physical device without authority.

### Task 1: Portable Inbox entry and first-run connection

**Status:** Complete and independently reviewed. Final verification: 176 native tests, 207 browser tests, desktop binary check. Execution evidence and review reports are in scratchpad/conversation_memories/dismissed_notification_reading_pane/android-progress.md. Changes are not committed or pushed.

**Files:** Modify inbox/src-tauri/{Cargo.toml,src/main.rs}, create src/lib.rs by moving existing main.rs contents, create src/settings.rs for connection validation/storage, modify inbox/src/{inbox.js,index.html,inbox.css}, create src/settings.js and tests/settings.spec.ts. Paths are under hitl-mcp-server. Change tauri.conf.json only if mobile startup requires an override; generated host/minSDK configuration belongs to Task2. Modify shared transport only if necessary for safe connection lifecycle, and document why.

**Interfaces:** Rust commands `get_connection_settings` return `{mobile, configured, topicId}` without returning the key; `save_connection_settings` consumes `{topicId, encryptionKey}`. Preserve all existing invoke commands. Desktop startup does not require settings and keeps its existing path. Mobile setup sets transport path before opening Store. Saving cannot start duplicate subscription tasks or mix messages between different topics. For the first version, changing an already configured topic may be rejected with a clear reinstall/reset instruction instead of introducing destructive account switching.

- [ ] Write focused Rust tests that reject blank/invalid topic and wrong-length/nonhex keys, verify valid config roundtrip in a temp directory and no key in public settings response. Record expected failure before implementation.
- [ ] Write Playwright tests for missing config opening setup, valid save, failed save preserving entered values with an inline error, configured startup bypassing setup, and desktop compatibility. Use the existing harness and actual settings module.
- [ ] Move existing startup and tests into a library, keeping desktop `fn main() { hitl_inbox_lib::run(); }`. Add `[lib] name = "hitl_inbox_lib"; crate-type = ["staticlib", "cdylib", "rlib"]` in valid TOML and `#[cfg_attr(mobile, tauri::mobile_entry_point)] pub fn run()`.
- [ ] Use Tauri setup to initialize app-private mobile path, Store, and services. Guard WebView2 flags with Windows cfg. An unconfigured phone must render setup without repeated missing-config retry/log spam. A successful first save must begin exactly one subscription/capture pipeline and refresh the Inbox.
- [ ] Implement a labelled password input for the encryption key and topic input in a native HTML dialog using current design tokens; clear secret input on successful save/close. Make settings reachable on the phone, error handling accessible, and preserve desktop test mocks that do not implement the new command.
- [ ] Run `cargo test -p hitl-inbox --lib` using C: target path, and `npx playwright test` from inbox. Self-review and write the report with RED/GREEN evidence. No commit until root review.

### Task 2: Android host and build integration

**Files:** Generate inbox/src-tauri/gen/android via installed Tauri CLI; edit generated Gradle/manifest/MainActivity only where required. Add inbox/scripts/build-android.ps1 and inbox Android build documentation. Adjust Cargo TLS dependency configuration only if cross-build establishes it necessary.

**Interfaces:** Consumes Task 1's library/mobile entry and `panes.back()` from layout.js. Build script uses JAVA_HOME, ANDROID_HOME, NDK_HOME and calls existing sync then Tauri Android build for aarch64. No credentials in script/project. Generated host remains reproducible and source-controlled as required by Tauri.

- [ ] Verify SDK/JDK/NDK installations and explicit license authorization; initialize Android project through `npx --no-install tauri android init --ci` (check CLI help for supported flags).
- [ ] Set minSdk 26, ARM64 target, recent SDK and NDK r28+, 16 KB-compatible Gradle packaging. Disable backups for app-private key data and require encrypted network transport.
- [ ] Wire Android Back to pane navigation using the supported Tauri/WebView mechanism, dismissing setup/modal before leaving; root/list may background/exit normally. Add browser navigation tests; keep settings and detail actions usable at narrow widths and system insets.
- [ ] Create repeatable PowerShell build script validating required paths before invoking `npx --no-install tauri android build --debug --apk --target aarch64 --ci` for the debug choice. If user selects release, follow explicit key setup authorization and never commit key/password.
- [ ] Build APK; diagnose compiler failures with focused fixes, recording evidence. Verify package ID, min SDK, ABI, signature, ZIP alignment and each native ELF's load alignment using Android tools.
- [ ] Document exact build/install commands, key setup, alert/history limits and debug signing limitations. Copy APK to durable local artifacts/android path and report SHA256. No claim of physical-device testing without observed evidence.

### Task 3: Independent review and regression gate

**Files:** Review package and reports in conversation scratchpad; only fixes to Task 1/2 owned files.

- [ ] Reviewer reads complete diff and task reports; give separate spec and code-quality verdicts. Check startup ordering, lifecycle uniqueness, secret exposure, Android back, manifest security, compatibility and desktop preservation.
- [ ] Return actionable findings to the original implementer as one scoped fix dispatch; verify affected tests again.
- [ ] Run final Inbox browser/native tests and APK inspection on final source; record build and test notifications through HITL.
- [ ] Deliver the artifact path and reproducible build command, clearly separating compiled/inspected evidence from phone testing.
