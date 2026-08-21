//! Everything a HITL host application needs to talk to ntfy, and nothing that
//! ties it to a desktop.
//!
//! Deliberately free of `tauri`, `rodio`, `urlencoding` and the `windows`
//! crates: this is the half of the old `hitl-client` a mobile build could
//! compile. Side effects leave through the [`ntfy::NtfySink`] trait rather than
//! being performed here, and this crate never installs a global logger — that
//! is the binary's job.

pub mod chunking;
pub mod config;
pub mod crypto;
pub mod payload;
pub mod types;
