use std::collections::{HashSet, VecDeque};
use futures_util::StreamExt;
use reqwest::Client;
use tauri::{AppHandle, Emitter, Manager};

use crate::chunking::ChunkAssembler;
use crate::config::load_config;
use crate::crypto;
use crate::payload::{self, PayloadError};
use crate::payload_store;
use crate::tray;
use crate::types::{
    AnswerMessage, AttachmentRef, CancelReviewMessage, ChunkMessage, DismissNotificationMessage,
    HitlConfig, MessageEnvelope, NotificationMessage, PlanPayloadRef, PlanReviewAckMessage,
    PlanReviewBody, PlanReviewMessage, PlanReviewResponseBody, PlanReviewResponseMessage,
    QuestionMessage, SUPPORTED_PROTOCOL_VERSION,
};

/// How many recently-dispatched message IDs to remember for reconnect de-dup.
/// A reconnect replays at most one ntfy cache window, so this is generous.
const SEEN_ID_CAPACITY: usize = 512;

/// How long to wait for a TCP connection and TLS handshake.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Ceiling on a whole request/response for the short calls: publish, cache poll.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Attachments are megabytes over whatever link the human is on, so they get
/// longer than a publish — but still a bound.
const ATTACHMENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// A subscription is a long poll: it is *supposed* to stay open for hours, so
/// it gets no overall deadline. This bounds the gap between reads instead.
/// ntfy sends a keepalive roughly every 45 s, so silence this long is a dead
/// connection rather than a quiet one.
const STREAM_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Build an HTTP client with an actual deadline on it.
///
/// `Client::new()` has neither a request timeout nor a connect timeout. A host
/// that completes the handshake and then sends nothing hangs the caller
/// forever — and `dispatch_message` is awaited inline inside the stream loop,
/// so one such host stops every future message from being dispatched while the
/// tray still reports "Connected". Nothing in this module may use the default.
fn http_client(timeout: Option<std::time::Duration>, read_timeout: Option<std::time::Duration>) -> Client {
    let mut builder = Client::builder().connect_timeout(CONNECT_TIMEOUT);
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    if let Some(read_timeout) = read_timeout {
        builder = builder.read_timeout(read_timeout);
    }

    builder.build().unwrap_or_else(|e| {
        // Only fails if the TLS backend cannot initialize, in which case an
        // un-timed-out client is the lesser problem — but say so.
        log::error!("Could not build an HTTP client with timeouts: {}", e);
        Client::new()
    })
}

/// Run work off the dispatch path so a slow network cannot stall the stream.
///
/// The `JoinHandle` is awaited rather than dropped: dropping it swallows a
/// panic, which is exactly how a dead subscription becomes invisible.
fn spawn_detached<F>(what: &'static str, work: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        if let Err(e) = tauri::async_runtime::spawn(work).await {
            log::error!("{} task did not finish: {}", what, e);
        }
    });
}

/// Start listening to ntfy for incoming question messages.
/// First polls cached messages to find pending (unanswered) questions,
/// then subscribes to live messages going forward.
pub async fn subscribe_loop(app: AppHandle) {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            log::error!("HITL config error: {}", e);
            return;
        }
    };

    let base_url = format!(
        "{}/{}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id
    );

    // Monotonic, and started before the cache poll so the live subscription
    // covers the gap. Deliberately not a wall-clock timestamp: ntfy resolves
    // the relative `since` against its own clock, so ours never enters into it.
    let started = std::time::Instant::now();

    // Phase 1: Poll all cached messages once, then process
    log::info!("Fetching cached messages to find pending questions...");
    let cached_body = fetch_cached_body(&base_url).await;
    let answered_ids = extract_answered_ids(&cached_body, &config);
    log::info!("Found {} settled questions and reviews in cache", answered_ids.len());

    // One de-dup set for both phases. The cache replay and the live stream
    // overlap by design, so a question seen in the cache must not re-dispatch
    // the moment the subscription opens.
    let mut seen = SeenIds::with_capacity(SEEN_ID_CAPACITY);

    // Show any pending (unanswered) questions from cache
    show_pending_from_cache(&app, &config, &cached_body, &answered_ids, &mut seen).await;

    // Phase 2: Subscribe to live messages (from just before cache poll to avoid gaps)
    //
    // `since_ts` used to be captured once and reused verbatim on every
    // reconnect, so a blip during a multi-hour block re-fetched the whole
    // session's history — with no de-dup, re-popping windows the user had
    // already answered. State that has to survive a reconnect lives here now,
    // including the chunk assembler: it was constructed inside subscribe_live,
    // so a reconnect mid-group discarded the fragments already collected and
    // the group could never complete.
    let mut state = LiveState {
        assembler: ChunkAssembler::new(),
        seen,
        started,
        last_event_ts: None,
    };
    log::info!("Subscribing to live ntfy messages from {}", base_url);

    loop {
        let live_url = format!("{}/json?since={}", base_url, state.since_param());
        match subscribe_live(&app, &config, &live_url, &mut state).await {
            Ok(()) => log::warn!("ntfy stream ended, reconnecting in 5s..."),
            Err(e) => log::warn!("ntfy error: {}, reconnecting in 5s...", e),
        }
        app.state::<tray::AppState>().mark_connected(false);
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// Fetch all cached messages from ntfy as a single body string.
async fn fetch_cached_body(base_url: &str) -> String {
    let poll_url = format!("{}/json?since=all&poll=1", base_url);

    let client = http_client(Some(REQUEST_TIMEOUT), None);
    let response = match client
        .get(&poll_url)
        .header("Accept", "application/x-ndjson")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            log::warn!("Cache poll returned {}", r.status());
            return String::new();
        }
        Err(e) => {
            log::warn!("Cache poll failed: {}", e);
            return String::new();
        }
    };

    response.text().await.unwrap_or_default()
}

/// Try to decrypt a raw message string.
/// Returns Some((json_string, was_encrypted)) on success, or None if the message
/// should be skipped (encrypted but no key, or decryption failed).
fn try_decrypt(raw: &str, config: &HitlConfig) -> Option<(String, bool)> {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) {
        if crypto::is_encrypted(&parsed) {
            if let Some(ref key) = config.encryption_key {
                match crypto::decrypt_value(&parsed, key) {
                    Ok(decrypted) => return Some((decrypted, true)),
                    Err(e) => {
                        log::warn!("Failed to decrypt message: {}", e);
                        return None;
                    }
                }
            } else {
                log::warn!("Received encrypted message but no encryptionKey configured — skipping");
                return None;
            }
        }
    }
    Some((raw.to_string(), false))
}

/// If `decrypted` is a chunk fragment, feed it to the assembler and only return
/// Some(..) once its group is fully reassembled — re-running decryption on the
/// recovered body, since it may itself be an encrypted envelope. Non-chunk
/// messages pass through unchanged.
fn resolve_chunked_message(
    decrypted: &str,
    was_encrypted: bool,
    config: &HitlConfig,
    assembler: &mut ChunkAssembler,
) -> Option<(String, bool)> {
    if let Ok(chunk) = serde_json::from_str::<ChunkMessage>(decrypted) {
        if chunk.msg_type == "chunk" {
            let reassembled = assembler.feed(chunk)?;
            return try_decrypt(&reassembled, config);
        }
    }
    Some((decrypted.to_string(), was_encrypted))
}

/// Pull the message body, ntfy's own attachment metadata, and the event time
/// off one raw event line.
///
/// All three readers previously kept only `message` and discarded the rest of
/// the event, which left an attachment-backed payload with nowhere to arrive —
/// the attachment URL exists only on the ntfy envelope, never inside our own
/// message, because it is assigned by the PUT. `time` is what lets a reconnect
/// resume from the last event actually processed instead of replaying the whole
/// session from the timestamp the client happened to start at.
fn parse_ntfy_event(line: &str) -> Option<NtfyEvent> {
    let event: serde_json::Value = serde_json::from_str(line).ok()?;
    let message = event.get("message")?.as_str()?.to_string();

    let attachment = event
        .get("attachment")
        .and_then(|a| serde_json::from_value::<AttachmentRef>(a.clone()).ok())
        .filter(|a| !a.url.is_empty());

    let time = event.get("time").and_then(|t| t.as_u64()).unwrap_or(0);

    Some(NtfyEvent {
        message,
        attachment,
        time,
    })
}

/// One decoded ntfy event line.
struct NtfyEvent {
    message: String,
    attachment: Option<AttachmentRef>,
    /// Unix seconds, as assigned by ntfy. 0 when the event omitted it.
    time: u64,
}

/// Bounded record of the message IDs already dispatched on this run.
///
/// `subscribe_live` had no de-dup at all — only the cache path filtered, via
/// `answered_ids`. Since a reconnect now resumes from the last processed event
/// time (and `since=` is inclusive), the boundary event arrives twice on every
/// reconnect. Without this, a blip re-pops a window the user already dealt with.
///
/// Bounded because a client stays up for weeks; the eviction order is insertion
/// order, which is the order ntfy delivers in.
struct SeenIds {
    order: VecDeque<String>,
    ids: HashSet<String>,
    capacity: usize,
}

impl SeenIds {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            order: VecDeque::with_capacity(capacity),
            ids: HashSet::with_capacity(capacity),
            capacity,
        }
    }

    /// Record `id` and report whether it is new. An empty id is never recorded —
    /// `messageId` is `#[serde(default)]`, so a malformed message yields "", and
    /// suppressing every later one of those would be worse than a duplicate.
    fn insert(&mut self, id: &str) -> bool {
        if id.is_empty() {
            return true;
        }
        if !self.ids.insert(id.to_string()) {
            return false;
        }

        self.order.push_back(id.to_string());
        if self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.ids.remove(&evicted);
            }
        }
        true
    }
}

/// State that must survive a reconnect.
///
/// The chunk assembler used to be constructed inside `subscribe_live`, so any
/// blip midway through a chunk group silently discarded the fragments already
/// received and the group could never complete.
struct LiveState {
    assembler: ChunkAssembler,
    seen: SeenIds,
    /// When this client started subscribing. Monotonic, so it is unaffected by
    /// an NTP correction or a suspend/resume.
    started: std::time::Instant,
    /// Highest event time actually observed — **ntfy's clock, never ours**.
    /// `None` until an event arrives.
    last_event_ts: Option<u64>,
}

impl LiveState {
    /// The `since=` value for the next subscribe.
    fn since_param(&self) -> String {
        since_param(self.last_event_ts, self.started.elapsed().as_secs())
    }

    fn observe(&mut self, event_time: u64) {
        if event_time == 0 {
            return; // an event ntfy gave no time for tells us nothing
        }
        if self.last_event_ts.is_none_or(|ts| event_time > ts) {
            self.last_event_ts = Some(event_time);
        }
    }
}

/// How far before the subscription's start to resume from, covering the cache
/// poll that happens first.
const RESUME_MARGIN_SECS: u64 = 10;

/// Nothing older than the ntfy cache window is retrievable anyway.
const RESUME_MAX_SECS: u64 = 12 * 60 * 60;

/// Build the `since=` query value without ever mixing two clocks.
///
/// The old code seeded this from the **local** wall clock and then `max()`-ed
/// it against ntfy's **server** timestamps. A laptop running five minutes fast
/// pinned the value in the future permanently: every `max` kept the local seed,
/// and on the first reconnect ntfy was asked for messages newer than a time
/// that had not happened yet, so everything published during the disconnect was
/// never delivered. Invisible until exactly the moment it mattered.
///
/// So: once an event has been seen, resume from that event's own server
/// timestamp. Until then, hand ntfy a *relative* duration and let it resolve
/// against the only clock that matters — its own.
fn since_param(last_event_ts: Option<u64>, elapsed_secs: u64) -> String {
    match last_event_ts {
        Some(ts) => ts.to_string(),
        None => format!("{}s", (elapsed_secs + RESUME_MARGIN_SECS).min(RESUME_MAX_SECS)),
    }
}

/// Clip a string to `max_chars` characters without splitting one.
///
/// `String::truncate` counts bytes and panics if the cut lands inside a
/// character. The strings clipped here are relay-supplied error bodies — a
/// localized proxy error page is exactly the input that carries a multi-byte
/// character, and the panic would land inside `submit_plan_review`, leaving the
/// review window stuck on "submitting…" with the human's comments unrecoverable.
fn clip_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// The first 8 characters of an id, on a char boundary, prefixed for the window
/// it addresses. Windows are found by label, so both the creating and the
/// closing side must derive it identically.
fn window_label(prefix: &str, id: &str) -> String {
    let cut = id
        .char_indices()
        .nth(8)
        .map(|(i, _)| i)
        .unwrap_or(id.len());
    format!("{}-{}", prefix, &id[..cut])
}

/// Extract the IDs of questions and reviews the cache shows are already settled.
///
/// Answers settle questions; a response or a cancellation settles a review.
/// Without the latter two, every client start would re-open a review window for
/// a plan that was reviewed hours ago — and, past the 3 h attachment expiry,
/// re-open it as "plan expired".
fn extract_answered_ids(body: &str, config: &HitlConfig) -> HashSet<String> {
    let mut answered = HashSet::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        let Some(event) = parse_ntfy_event(line) else { continue };
        let Some((decrypted, _)) = try_decrypt(&event.message, config) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&decrypted) else { continue };

        // Read the settling id straight off the parsed value rather than via
        // the concrete type. A message whose full shape this build cannot parse
        // still settles its target — and not recording it would re-open that
        // window on every single client start, forever.
        let settles = match value.get("type").and_then(|t| t.as_str()) {
            Some("answer") => value.get("questionId"),
            Some("plan_review_response") | Some("cancel_review") => value.get("reviewId"),
            _ => None,
        };

        if let Some(id) = settles.and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            answered.insert(id.to_string());
        }
    }
    answered
}

/// Decrypt every cached line and reassemble any chunked messages, in order.
fn decrypt_and_reassemble_cache(
    body: &str,
    config: &HitlConfig,
) -> Vec<(String, bool, Option<AttachmentRef>)> {
    let mut assembler = ChunkAssembler::new();
    let mut messages = Vec::new();

    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        if let Some(event) = parse_ntfy_event(line) {
            if let Some((decrypted, was_encrypted)) = try_decrypt(&event.message, config) {
                if let Some((resolved, resolved_encrypted)) =
                    resolve_chunked_message(&decrypted, was_encrypted, config, &mut assembler)
                {
                    messages.push((resolved, resolved_encrypted, event.attachment));
                }
            }
        }
    }

    messages
}

/// Show pending (unanswered) questions from the already-fetched cache body.
///
/// Routes through the same dispatch as live messages rather than keeping a
/// second, subtly-different type chain — the two used to disagree about which
/// types they recognized.
async fn show_pending_from_cache(
    app: &AppHandle,
    config: &HitlConfig,
    body: &str,
    answered_ids: &HashSet<String>,
    seen: &mut SeenIds,
) {
    if body.is_empty() { return; }

    for (decrypted, was_encrypted, attachment) in decrypt_and_reassemble_cache(body, config) {
        dispatch_message(
            app,
            config,
            &decrypted,
            was_encrypted,
            attachment,
            Origin::Cache { answered_ids, seen },
        )
        .await;
    }
}

/// Subscribe to live (new) messages from ntfy.
///
/// `state` outlives the call so a reconnect resumes rather than restarts.
async fn subscribe_live(
    app: &AppHandle,
    config: &HitlConfig,
    url: &str,
    state: &mut LiveState,
) -> Result<(), Box<dyn std::error::Error>> {
    // No overall timeout: this request is meant to stay open. The read timeout
    // is what distinguishes a quiet connection from a dead one.
    let client = http_client(None, Some(STREAM_READ_TIMEOUT));
    let response = client
        .get(url)
        .header("Accept", "application/x-ndjson")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(format!("ntfy returned {}", response.status()).into());
    }

    app.state::<tray::AppState>().mark_connected(true);

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            if let Some(event) = parse_ntfy_event(&line) {
                // Advance before dispatching: a message that fails to decode is
                // still a message we do not want re-delivered on every retry.
                state.observe(event.time);
                app.state::<tray::AppState>().mark_message();

                if let Some((decrypted, was_encrypted)) = try_decrypt(&event.message, config) {
                    if let Some((final_body, final_encrypted)) = resolve_chunked_message(
                        &decrypted,
                        was_encrypted,
                        config,
                        &mut state.assembler,
                    ) {
                        dispatch_message(
                            app,
                            config,
                            &final_body,
                            final_encrypted,
                            event.attachment,
                            Origin::Live {
                                seen: &mut state.seen,
                            },
                        )
                        .await;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Where a message came from.
///
/// Cached messages are replayed on every startup, so they must not resurrect
/// ephemeral UI or re-show a question that has already been answered. Dispatch
/// consults this instead of keeping a second, subtly-different type chain —
/// the live and cache chains used to disagree about which types they handled.
enum Origin<'a> {
    /// `seen` suppresses the redelivery a reconnect necessarily produces:
    /// `since=` is inclusive, so the boundary event arrives again every time.
    Live { seen: &'a mut SeenIds },
    Cache {
        answered_ids: &'a HashSet<String>,
        seen: &'a mut SeenIds,
    },
}

impl Origin<'_> {
    /// The de-dup set, whichever origin this is.
    ///
    /// Both arms carry the same set. De-dup that depended on which origin a
    /// message arrived from left the cache path with none at all — and the
    /// cache can hold the same messageId twice, because a publish whose
    /// response was lost gets retried against an ntfy that already stored it.
    fn seen(&mut self) -> &mut SeenIds {
        match self {
            Origin::Live { seen } => seen,
            Origin::Cache { seen, .. } => seen,
        }
    }
}

/// Route one decrypted, fully-reassembled message to its handler.
///
/// Envelope-first: the concrete type is chosen by `type`, not guessed by trying
/// four `serde_json::from_str` calls in sequence. The old chain had no terminal
/// branch, so any message it could not parse vanished — no window, no log — and
/// a blocked agent would wait forever for an answer that could never arrive.
async fn dispatch_message(
    app: &AppHandle,
    config: &HitlConfig,
    raw: &str,
    was_encrypted: bool,
    attachment: Option<AttachmentRef>,
    mut origin: Origin<'_>,
) {
    let env = match serde_json::from_str::<MessageEnvelope>(raw) {
        Ok(env) => env,
        Err(e) => {
            log::warn!("Undecodable message envelope: {}", e);
            return;
        }
    };

    if !origin.seen().insert(&env.message_id) {
        log::debug!(
            "Skipping {} {} — already dispatched this run",
            env.msg_type,
            env.message_id
        );
        return;
    }

    match version_verdict(env.version(), &env.msg_type) {
        VersionVerdict::Handle => {}
        VersionVerdict::ShowUpgradePanel => {
            log::warn!(
                "Message {} ({}) declares protocolVersion {} but this client supports {} — \
                 showing the upgrade panel",
                env.message_id,
                env.msg_type,
                env.version(),
                SUPPORTED_PROTOCOL_VERSION
            );
            show_upgrade_required(app, &env, raw);
            return;
        }
        VersionVerdict::Ignore => {
            log::warn!(
                "Message {} ({}) declares protocolVersion {} but this client supports {} — \
                 ignoring, nothing is waiting on it",
                env.message_id,
                env.msg_type,
                env.version(),
                SUPPORTED_PROTOCOL_VERSION
            );
            return;
        }
    }

    match env.msg_type.as_str() {
        "question" => match serde_json::from_str::<QuestionMessage>(raw) {
            Ok(question) => {
                if let Origin::Cache { answered_ids, .. } = origin {
                    if answered_ids.contains(&question.message_id) {
                        return;
                    }
                    log::info!("Showing pending question from cache: {}", question.message_id);
                } else {
                    log::info!("Received question: {}", question.message_id);
                }
                show_question(app, config, &question, was_encrypted);
            }
            Err(e) => log::error!("question {} parse failed: {}", env.message_id, e),
        },

        "answer" => {
            // Cached answers are exactly what extract_answered_ids already
            // consumed; replaying them would emit dismissals for windows that
            // were never opened.
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<AnswerMessage>(raw) {
                Ok(answer) => {
                    log::info!(
                        "Received answer for question {}: from {}",
                        answer.question_id, answer.responded_from
                    );

                    if let Err(e) = app.emit("dismiss-question", &answer) {
                        log::error!("Failed to emit dismiss-question: {}", e);
                    }

                    // Only the dialog raised for THIS question. The label is
                    // derived, not searched, precisely so an answer can never
                    // reach a review window: a review holds minutes of typed
                    // comments and closing it would discard every one of them.
                    let label = window_label("dialog", &answer.question_id);
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.close();
                    }
                }
                Err(e) => log::error!("answer {} parse failed: {}", env.message_id, e),
            }
        }

        "notification" => {
            // Cached notifications are intentionally skipped — they're ephemeral.
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<NotificationMessage>(raw) {
                Ok(notification) => show_notification(app, config, &notification, was_encrypted),
                Err(e) => log::error!("notification {} parse failed: {}", env.message_id, e),
            }
        }

        "dismiss_notification" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<DismissNotificationMessage>(raw) {
                Ok(dismiss) => {
                    log::info!(
                        "Received dismiss for notification {}: from {}",
                        dismiss.notification_id, dismiss.dismissed_from
                    );

                    if let Some(win) = app.get_webview_window("notifications") {
                        if let Err(e) = win.emit("remove-notification", &dismiss.notification_id) {
                            log::error!("Failed to emit remove-notification: {}", e);
                        }
                    }
                }
                Err(e) => log::error!("dismiss_notification {} parse failed: {}", env.message_id, e),
            }
        }

        // The agent has (or has not) actually read a response we published.
        // Handing it to the waiting submit call is the whole point of C-12.
        "plan_review_ack" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<PlanReviewAckMessage>(raw) {
                Ok(ack) => app.state::<AckWaiters>().deliver(ack),
                Err(e) => log::error!("plan_review_ack {} parse failed: {}", env.message_id, e),
            }
        }

        "plan_review" => match serde_json::from_str::<PlanReviewMessage>(raw) {
            Ok(review) => {
                if let Origin::Cache { answered_ids, .. } = origin {
                    if answered_ids.contains(&review.message_id) {
                        return;
                    }
                    log::info!("Showing pending review from cache: {}", review.message_id);
                } else {
                    log::info!(
                        "Received plan_review {} (revision {}, {})",
                        review.message_id,
                        review.revision,
                        review.display_path
                    );
                }
                // Off the dispatch path. This is the one handler that makes a
                // network call — the attachment download — and dispatch is
                // awaited inline inside the stream loop, so awaiting it here
                // would let one slow or hung host stop every later message
                // from being dispatched at all.
                let app = app.clone();
                let config = config.clone();
                spawn_detached("plan_review", async move {
                    handle_plan_review(&app, &config, &review, was_encrypted, attachment).await;
                });
            }
            Err(e) => log::error!("plan_review {} parse failed: {}", env.message_id, e),
        },

        // Somebody finished this review — possibly on another device.
        //
        // Emit, never close. A review window holds however many minutes of
        // typed comments the human has invested; closing it here would discard
        // all of them. The window decides for itself what to show.
        "plan_review_response" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<PlanReviewResponseMessage>(raw) {
                Ok(response) => {
                    // Our own submission comes back over the same stream. The
                    // window that sent it is already showing its own outcome.
                    if response.responded_from == config.device_name {
                        return;
                    }
                    log::info!(
                        "Review {} was answered on {} ({})",
                        response.review_id,
                        response.responded_from,
                        response.verdict
                    );
                    app.state::<OutstandingReviews>().settle(&response.review_id);
                    notify_review_window(app, &response.review_id, "review-superseded", &response);
                }
                Err(e) => log::error!(
                    "plan_review_response {} parse failed: {}",
                    env.message_id,
                    e
                ),
            }
        }

        // The agent will never read this review. Tell the window so it can say
        // so and keep the typed comments as a draft rather than lose them.
        "cancel_review" => {
            if matches!(origin, Origin::Cache { .. }) {
                return;
            }
            match serde_json::from_str::<CancelReviewMessage>(raw) {
                Ok(cancel) => {
                    log::info!(
                        "Review {} cancelled by the agent: {}",
                        cancel.review_id,
                        cancel.reason
                    );
                    app.state::<OutstandingReviews>().settle(&cancel.review_id);
                    notify_review_window(app, &cancel.review_id, "review-cancelled", &cancel);
                }
                Err(e) => log::error!("cancel_review {} parse failed: {}", env.message_id, e),
            }
        }

        // Only reachable when `resolve_chunked_message` could NOT parse the
        // fragment as a `ChunkMessage` — a parsed one is either held for its
        // group or dispatched as the reassembled body, and never arrives here
        // still typed "chunk". So this arm means a fragment was dropped, and
        // its whole group will now expire incomplete.
        "chunk" => log::warn!(
            "Chunk fragment {} could not be parsed as a fragment and was dropped; \
             its group will never complete",
            env.message_id
        ),

        other => log::warn!(
            "Unrecognized message type '{}' (id {})",
            other, env.message_id
        ),
    }
}

/// Emit an event to the review window for `review_id`, if one is open.
///
/// Deliberately narrow: it can only ever address a `review-*` label, so nothing
/// routed through here can reach a `dialog-*` window and close it.
fn notify_review_window<T: serde::Serialize + Clone>(
    app: &AppHandle,
    review_id: &str,
    event: &str,
    payload: &T,
) {
    let label = window_label("review", review_id);
    let Some(window) = app.get_webview_window(&label) else {
        log::debug!("No open window '{}' for {}", label, event);
        return;
    };

    if let Err(e) = window.emit(event, payload.clone()) {
        log::error!("Failed to emit {} to {}: {}", event, label, e);
    }
}

/// Why a plan body could not be produced for the review window.
///
/// Every variant has to reach the human as words. A review that renders as a
/// blank window is indistinguishable from a client that is simply broken, and
/// the agent is blocked on the other end either way.
#[derive(Debug)]
enum ReviewBodyError {
    /// The attachment URL could not be fetched at all.
    Network(String),
    /// The reference said `attachment` but the ntfy event carried no metadata,
    /// so there is nothing to fetch.
    NoAttachment,
    Payload(PayloadError),
}

impl ReviewBodyError {
    /// Stable discriminant for the window's error panel. The strings are a
    /// contract with `review.js`, not a log format.
    fn kind(&self) -> &'static str {
        match self {
            ReviewBodyError::Network(_) => "unavailable",
            ReviewBodyError::NoAttachment => "missing",
            ReviewBodyError::Payload(PayloadError::Expired) => "expired",
            ReviewBodyError::Payload(PayloadError::HashMismatch { .. }) => "hash_mismatch",
            ReviewBodyError::Payload(PayloadError::Decrypt(_)) => "decrypt",
            ReviewBodyError::Payload(PayloadError::MissingData) => "missing",
            ReviewBodyError::Payload(
                PayloadError::Base64(_)
                | PayloadError::Gunzip(_)
                | PayloadError::Json(_)
                | PayloadError::TooLarge { .. }
                // Encode-side only; `decode_payload` never produces this, but
                // the match must stay exhaustive over `PayloadError`.
                | PayloadError::TooLargeToSubmit,
            ) => "corrupt",
        }
    }
}

impl std::fmt::Display for ReviewBodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReviewBodyError::Network(e) => write!(f, "could not fetch the plan attachment: {e}"),
            ReviewBodyError::NoAttachment => write!(
                f,
                "the plan says its body is an attachment but the message carried no attachment"
            ),
            ReviewBodyError::Payload(e) => write!(f, "{e}"),
        }
    }
}

/// Download an ntfy attachment as a string.
///
/// A 404 is the expected outcome, not an anomaly: ntfy expires attachments
/// after 3 h but keeps messages for 12 h, and `show_pending_from_cache` polls
/// `since=all` on every client start. Any review older than 3 h replays against
/// a dead URL.
async fn download_attachment(url: &str) -> Result<String, ReviewBodyError> {
    let response = http_client(Some(ATTACHMENT_TIMEOUT), None)
        .get(url)
        .send()
        .await
        .map_err(|e| ReviewBodyError::Network(e.to_string()))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND
        || response.status() == reqwest::StatusCode::GONE
    {
        return Err(ReviewBodyError::Payload(PayloadError::Expired));
    }
    if !response.status().is_success() {
        return Err(ReviewBodyError::Network(format!(
            "ntfy returned {}",
            response.status()
        )));
    }

    response
        .text()
        .await
        .map_err(|e| ReviewBodyError::Network(e.to_string()))
}

/// Fetch (if needed), decrypt, gunzip and hash-verify a plan-review body.
async fn download_and_decode(
    body_ref: Option<&PlanPayloadRef>,
    attachment: Option<&AttachmentRef>,
    config: &HitlConfig,
) -> Result<PlanReviewBody, ReviewBodyError> {
    let body_ref = body_ref.ok_or(ReviewBodyError::Payload(PayloadError::MissingData))?;

    let cipher = if body_ref.kind == "attachment" {
        let attachment = attachment.ok_or(ReviewBodyError::NoAttachment)?;
        download_attachment(&attachment.url).await?
    } else {
        body_ref
            .data
            .clone()
            .ok_or(ReviewBodyError::Payload(PayloadError::MissingData))?
    };

    payload::decode_payload(cipher.trim(), config.encryption_key.as_deref(), &body_ref.content_hash)
        .map_err(ReviewBodyError::Payload)
}

/// Resolve a plan-review body and raise its window.
///
/// The window opens either way. A failure to decode is rendered as a named
/// state — "the plan expired, ask the agent to resend" — never as nothing.
async fn handle_plan_review(
    app: &AppHandle,
    config: &HitlConfig,
    review: &PlanReviewMessage,
    was_encrypted: bool,
    attachment: Option<AttachmentRef>,
) {
    let decoded =
        download_and_decode(review.body.as_ref(), attachment.as_ref(), config).await;

    if let Err(e) = &decoded {
        log::warn!(
            "plan_review {} body unavailable ({}): {}",
            review.message_id,
            e.kind(),
            e
        );
    }

    show_review(app, config, review, decoded, was_encrypted);
}

/// Build the JSON the review window reads via `take_window_payload`.
///
/// The wire message's `body` is a `PlanPayloadRef` describing where the payload
/// lives; the window has no use for that, so it is replaced in place with the
/// decoded `{content, diff}` — or with `null` plus a populated `_error`.
///
/// `_draft` is the read half of `save_review_draft`: there is no second command
/// for it, because the window already takes its payload exactly once and this
/// is that payload.
fn review_window_payload(
    review: &PlanReviewMessage,
    decoded: &Result<PlanReviewBody, ReviewBodyError>,
    was_encrypted: bool,
    device_name: &str,
    draft: Option<crate::drafts::ReviewDraft>,
) -> String {
    let mut payload = serde_json::to_value(review).unwrap_or_default();

    if let Some(obj) = payload.as_object_mut() {
        match decoded {
            Ok(body) => {
                obj.insert("body".into(), serde_json::to_value(body).unwrap_or_default());
                obj.insert("_error".into(), serde_json::Value::Null);
            }
            Err(e) => {
                obj.insert("body".into(), serde_json::Value::Null);
                obj.insert(
                    "_error".into(),
                    serde_json::json!({ "kind": e.kind(), "message": e.to_string() }),
                );
            }
        }
        obj.insert("_wasEncrypted".into(), serde_json::Value::Bool(was_encrypted));
        obj.insert("_device".into(), serde_json::Value::String(device_name.to_string()));
        obj.insert(
            "_draft".into(),
            draft
                .map(|d| serde_json::to_value(d).unwrap_or_default())
                .unwrap_or(serde_json::Value::Null),
        );
    }

    serde_json::to_string(&payload).unwrap_or_default()
}

/// What the protocol-version gate decides to do with a message.
#[derive(Debug, PartialEq, Eq)]
enum VersionVerdict {
    /// This build understands the wire shape; dispatch normally.
    Handle,
    /// Too new, and a human is waiting on it — say so on screen.
    ShowUpgradePanel,
    /// Too new, but nothing human-facing is blocked on it.
    Ignore,
}

/// Decide what a message's `protocolVersion` means for this build.
///
/// A-7: silently ignoring a message this client cannot read is the exact
/// failure the version field was added to prevent — a bumped release would
/// leave every agent blocked forever on a request the human never sees.
///
/// The default for a too-new message is therefore to show the panel, including
/// for message types this build has never heard of, since a future
/// human-facing type would otherwise vanish. Only the settlement types are
/// exempt: they resolve something rather than ask for it, so nothing waits on
/// them, and one panel per ack during a version mismatch would bury the one
/// panel that matters.
fn version_verdict(version: u32, msg_type: &str) -> VersionVerdict {
    if version <= SUPPORTED_PROTOCOL_VERSION {
        return VersionVerdict::Handle;
    }

    match msg_type {
        "answer" | "plan_review_response" | "plan_review_ack" | "cancel_review"
        | "dismiss_notification" | "chunk" => VersionVerdict::Ignore,
        _ => VersionVerdict::ShowUpgradePanel,
    }
}

/// Open a window that says this client is too old to read the message.
///
/// Only the two fields the panel renders are forwarded. A message from a
/// future protocol is precisely the case where this build's reading of the
/// rest cannot be trusted, so none of it is passed on.
fn show_upgrade_required(app: &AppHandle, env: &MessageEnvelope, raw: &str) {
    let label = window_label("review", &env.message_id);

    if let Some(window) = app.get_webview_window(&label) {
        let _ = crate::window_utils::show_window_no_activate(&window);
        return;
    }

    let display_path = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get("displayPath").and_then(|p| p.as_str()).map(String::from))
        .unwrap_or_default();

    let payload = serde_json::json!({
        "messageId": env.message_id,
        "protocolVersion": env.version(),
        "displayPath": display_path,
    });
    payload_store::put(app, &label, payload.to_string());

    match build_review_window(app, &label, "Plan review — update required") {
        Ok(window) => {
            log::info!("Upgrade-required window created: {}", label);
            if let Err(e) = crate::window_utils::show_window_no_activate(&window) {
                log::error!("Failed to show upgrade window {}: {}", label, e);
            }
        }
        Err(e) => {
            app.state::<payload_store::PayloadStore>().take(&label);
            log::error!("Failed to create upgrade window: {}", e);
        }
    }
}

/// The size a review window would like to be, before the display gets a say.
const REVIEW_PREFERRED_SIZE: (f64, f64) = (1280.0, 900.0);
/// Below this the two-pane layout stops being usable.
const REVIEW_MIN_SIZE: (f64, f64) = (720.0, 520.0);

/// Shrink the preferred size to something that actually fits on screen.
///
/// E-9. 1280x900 is taller than a 1366x768 laptop display, and `.center()` then
/// pushes the overflow off both edges — including the verdict footer, which is
/// the bottom-most element by design (E-12), leaving a reviewer able to read
/// the plan and unable to act on it.
fn fit_to_work_area(preferred: (f64, f64), min: (f64, f64), available: (f64, f64)) -> (f64, f64) {
    let fit = |preferred: f64, min: f64, available: f64| {
        if available <= 0.0 {
            return preferred; // no usable monitor information
        }
        // A display smaller than the minimum takes the display: a window sized
        // past the screen edge is the very thing being fixed.
        preferred.min(available).max(min.min(available))
    };

    (
        fit(preferred.0, min.0, available.0),
        fit(preferred.1, min.1, available.1),
    )
}

fn review_window_size(app: &AppHandle) -> (f64, f64) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        log::debug!("No monitor information available; using the preferred window size");
        return REVIEW_PREFERRED_SIZE;
    };

    // The work area excludes the taskbar and dock, which is what the window
    // has to share the screen with.
    let area = monitor
        .work_area()
        .size
        .to_logical::<f64>(monitor.scale_factor());

    fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (area.width, area.height))
}

/// The review window shell, shared by a real review and the upgrade panel.
fn build_review_window(
    app: &AppHandle,
    label: &str,
    title: &str,
) -> tauri::Result<tauri::WebviewWindow> {
    let (width, height) = review_window_size(app);

    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("review.html".into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(REVIEW_MIN_SIZE.0, REVIEW_MIN_SIZE.1)
        .center()
        .resizable(true)
        // Decorated and not on top, both opposite to show_question: a review
        // window is worked in alongside an editor, and decorations are what give
        // the webview its find-in-page.
        .decorations(true)
        .always_on_top(false)
        .visible(false)
        .focused(false)
        .build()
}

/// Create and show the review window for a plan.
///
/// Deliberately unlike `show_question`: a review is read for minutes, not
/// glanced at, so it is large, decorated (which is what gives it find-in-page)
/// and explicitly NOT always-on-top.
fn show_review(
    app: &AppHandle,
    config: &HitlConfig,
    review: &PlanReviewMessage,
    decoded: Result<PlanReviewBody, ReviewBodyError>,
    was_encrypted: bool,
) {
    let label = window_label("review", &review.message_id);

    // The cache replay and the live stream overlap by design, so the same
    // review can arrive twice. Raising the existing window is right; rebuilding
    // it would discard whatever the human has already typed.
    if let Some(window) = app.get_webview_window(&label) {
        log::info!("Review window {} is already open", label);
        let _ = crate::window_utils::show_window_no_activate(&window);
        return;
    }

    if config.sound_enabled {
        crate::sound::play_notification();
    }

    app.state::<OutstandingReviews>()
        .remember(&review.message_id, &review.snapshot_hash);

    payload_store::put(
        app,
        &label,
        review_window_payload(
            review,
            &decoded,
            was_encrypted,
            &config.device_name,
            crate::drafts::load_for_window(
                &review.plan_id,
                &review.message_id,
                &review.snapshot_hash,
            ),
        ),
    );

    let title = if review.display_path.is_empty() {
        "Plan review".to_string()
    } else {
        format!("Plan review — {}", review.display_path)
    };

    match build_review_window(app, &label, &title) {
        Ok(window) => {
            log::info!("Review window created: {}", label);
            if let Err(e) = crate::window_utils::show_window_no_activate(&window) {
                log::error!("Failed to show review window {}: {}", label, e);
            }
        }
        Err(e) => {
            // The payload would otherwise sit in the store forever.
            app.state::<payload_store::PayloadStore>().take(&label);
            log::error!("Failed to create review window: {}", e);
        }
    }
}

/// Show (or update) the notifications window for an incoming notification.
fn show_notification(
    app: &AppHandle,
    config: &HitlConfig,
    notification: &NotificationMessage,
    was_encrypted: bool,
) {
    log::info!("Received notification: {}", notification.message_id);

    if config.sound_enabled {
        crate::sound::play_notification();
    }

    // Build a payload that includes the encrypted flag for the frontend
    let mut payload = serde_json::to_value(notification).unwrap_or_default();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("_wasEncrypted".to_string(), serde_json::Value::Bool(was_encrypted));
    }
    let notification_json = serde_json::to_string(&payload).unwrap_or_default();
    let label = "notifications";

    if let Some(win) = app.get_webview_window(label) {
        if let Err(e) = win.emit("add-notification", &notification_json) {
            log::error!("Failed to emit add-notification: {}", e);
        }
        let _ = crate::window_utils::show_window_no_activate(&win);
        return;
    }

    let encoded = urlencoding::encode(&notification_json);
    let url_str = format!("notifications.html?notification={}", encoded);

    match tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url_str.into()))
        .title("Notifications")
        .inner_size(400.0, 500.0)
        .center()
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .build()
    {
        Ok(_) => log::info!("Notifications window created"),
        Err(e) => log::error!("Failed to create notifications window: {}", e),
    }
}

/// Create and show a dialog window for a question.
fn show_question(app: &AppHandle, config: &HitlConfig, question: &QuestionMessage, encrypted: bool) {
    let label = window_label("dialog", &question.message_id);

    // The same reasoning as show_review, and it applies just as hard here: the
    // cache replay and the live stream overlap by design, and the cache itself
    // can hold the same messageId twice. Rebuilding is not merely wasteful —
    // the failed build's cleanup below would take the payload back out of the
    // store while the first window's webview is still loading and about to
    // read it, leaving a permanent "could not load the question" panel on a
    // question nothing can now answer.
    if let Some(window) = app.get_webview_window(&label) {
        log::info!("Dialog window {} is already open", label);
        let _ = crate::window_utils::show_window_no_activate(&window);
        return;
    }

    if config.sound_enabled {
        crate::sound::play_notification();
    }

    let question_json = serde_json::to_string(question).unwrap_or_default();

    // The whole question used to be URL-encoded into the query string, which
    // does not survive a large payload and leaks content into anything that
    // logs URLs. `encrypted` stays on the URL: it is a flag, not content.
    payload_store::put(app, &label, question_json);
    let url_str = format!("index.html?encrypted={}", encrypted);

    match tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(url_str.into()),
    )
    .title("HITL")
    .inner_size(768.0, 768.0)
    .center()
    .resizable(true)
    .decorations(false)
    .always_on_top(true)
    .visible(false)
    .focused(false)
    .build()
    {
        Ok(_) => log::info!("Dialog window created: {}", label),
        Err(e) => {
            app.state::<payload_store::PayloadStore>().take(&label);
            log::error!("Failed to create dialog window: {}", e);
        }
    }
}

/// Publish an answer message to ntfy.
/// If `encrypted` is true and config has an encryption key, the message is encrypted.
pub async fn publish_answer(
    config: &HitlConfig,
    answer: &AnswerMessage,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    publish_message(config, &serde_json::to_string(answer)?, encrypted).await
}

/// Publish a dismiss-notification message to ntfy.
/// If `encrypted` is true and config has an encryption key, the message is encrypted.
pub async fn publish_dismiss_notification(
    config: &HitlConfig,
    msg: &DismissNotificationMessage,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    publish_message(config, &serde_json::to_string(msg)?, encrypted).await
}

/// Publish a raw JSON message to ntfy, optionally encrypting it.
async fn publish_message(
    config: &HitlConfig,
    body: &str,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!(
        "{}/{}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id
    );

    let final_body = if encrypted {
        if let Some(ref key) = config.encryption_key {
            crypto::encrypt(body, key).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?
        } else {
            body.to_string()
        }
    } else {
        body.to_string()
    };

    let client = http_client(Some(REQUEST_TIMEOUT), None);
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(final_body)
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(format!("ntfy publish failed: {}", response.status()).into());
    }

    Ok(())
}

// -----------------------------------------------------------
// Plan review submission (W2.7)
// -----------------------------------------------------------

/// Ceiling for the `X-Message` header carrying the outer message alongside an
/// attachment PUT.
///
/// Measured against ntfy.sh: 7317 bytes succeeded, 16317 returned nginx's
/// `Request Header Or Cookie Too Large`. The real limit is nginx's 8 KB
/// `large_client_header_buffers`, not ntfy — so half of it is the margin
/// against a proxy configured smaller. Our encrypted metadata is ~600-900
/// bytes, roughly 20 % of this budget.
const X_MESSAGE_MAX_BYTES: usize = 4096;

/// How long a submitting window waits to learn the agent actually read it.
const ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// What the review window learns about its own submission.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewSubmitResult {
    /// "received" — the agent decoded it · "lost" — the agent could not, re-offer
    /// the draft · "unacknowledged" — no answer within ACK_TIMEOUT, keep the draft.
    pub status: String,
    pub response_id: String,
    pub reason: Option<String>,
}

struct AckWaiter {
    review_id: String,
    response_id: String,
    tx: tokio::sync::oneshot::Sender<PlanReviewAckMessage>,
}

/// Reviews this client has shown and that nobody has settled yet.
///
/// Closing a review window resolves nothing (D-7) — the agent stays blocked —
/// so entries are removed when the review is actually settled, not when its
/// window goes away. That is what lets the tray release an agent whose window
/// the user closed hours ago.
#[derive(Default)]
pub struct OutstandingReviews(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl OutstandingReviews {
    fn remember(&self, review_id: &str, snapshot_hash: &str) {
        if let Ok(mut open) = self.0.lock() {
            open.insert(review_id.to_string(), snapshot_hash.to_string());
        }
    }

    fn settle(&self, review_id: &str) {
        if let Ok(mut open) = self.0.lock() {
            open.remove(review_id);
        }
    }

    /// Every unsettled review, as `(reviewId, snapshotHash)`.
    pub fn snapshot(&self) -> Vec<(String, String)> {
        self.0
            .lock()
            .map(|open| open.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    }
}

/// Submissions waiting to hear back from the agent.
///
/// Without this the window shows "submitted" the instant the PUT returns — even
/// though the response attachment can expire (3 h) before a reconnecting server
/// ever reads it, at which point the human's review is simply gone and nobody
/// knows.
#[derive(Default)]
pub struct AckWaiters(std::sync::Mutex<Vec<AckWaiter>>);

/// Does this ack answer the submission identified by these ids?
///
/// `responseId` is the precise answer; `reviewId` is the fallback for an ack
/// published by a server that could not decode far enough to learn which
/// response it was — exactly the `status:"lost"` case, which is the one the
/// window most needs to hear about.
fn ack_matches(ack: &PlanReviewAckMessage, review_id: &str, response_id: &str) -> bool {
    if !ack.response_id.is_empty() {
        return ack.response_id == response_id;
    }
    !ack.review_id.is_empty() && ack.review_id == review_id
}

impl AckWaiters {
    fn register(
        &self,
        review_id: &str,
        response_id: &str,
    ) -> tokio::sync::oneshot::Receiver<PlanReviewAckMessage> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut waiters) = self.0.lock() {
            waiters.push(AckWaiter {
                review_id: review_id.to_string(),
                response_id: response_id.to_string(),
                tx,
            });
        }
        rx
    }

    fn forget(&self, response_id: &str) {
        if let Ok(mut waiters) = self.0.lock() {
            waiters.retain(|w| w.response_id != response_id);
        }
    }

    fn deliver(&self, ack: PlanReviewAckMessage) {
        let Ok(mut waiters) = self.0.lock() else { return };
        let Some(index) = waiters
            .iter()
            .position(|w| ack_matches(&ack, &w.review_id, &w.response_id))
        else {
            log::debug!(
                "plan_review_ack for review {} response {} matched no pending submission",
                ack.review_id,
                ack.response_id
            );
            return;
        };

        let waiter = waiters.remove(index);
        let _ = waiter.tx.send(ack);
    }
}

/// Publish a plan-review response, spilling the body to an ntfy attachment when
/// it does not fit inline.
///
/// One ntfy message either way (C-1): with an attachment the outer message
/// rides in the `X-Message` header of the same PUT.
async fn publish_review_response(
    config: &HitlConfig,
    response: &PlanReviewResponseMessage,
    attachment_cipher: Option<&str>,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let outer = serde_json::to_string(response)?;

    let Some(cipher) = attachment_cipher else {
        return publish_message(config, &outer, encrypted).await;
    };

    let wire = if encrypted {
        match config.encryption_key.as_ref() {
            Some(key) => crypto::encrypt(&outer, key)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?,
            None => outer,
        }
    } else {
        outer
    };

    if wire.len() > X_MESSAGE_MAX_BYTES {
        return Err(format!(
            "review metadata is {} bytes, over the {} byte X-Message budget",
            wire.len(),
            X_MESSAGE_MAX_BYTES
        )
        .into());
    }

    // Random hex, never anything derived from the plan: `Filename` is echoed
    // back as plaintext ntfy metadata, outside our encryption (F-9).
    let filename = format!("{}.bin", uuid::Uuid::new_v4().simple());
    let url = format!(
        "{}/{}",
        config.ntfy_url.trim_end_matches('/'),
        config.topic_id
    );

    let http = http_client(Some(ATTACHMENT_TIMEOUT), None);
    let sent = http
        .put(&url)
        .header("Filename", &filename)
        .header("X-Message", &wire)
        .header("Content-Type", "application/octet-stream")
        .body(cipher.to_string())
        .send()
        .await?;

    if !sent.status().is_success() {
        let status = sent.status();
        // Deliberately not parsed: an oversized header is answered by nginx
        // with HTML, not ntfy's {code,http,error,link} envelope, and a JSON
        // parse error on top of the real failure helps nobody.
        let body = clip_chars(&sent.text().await.unwrap_or_default(), 200);
        return Err(format!("ntfy attachment upload failed: {status} — {body}").into());
    }

    Ok(())
}

/// Publish a review verdict and wait to hear that the agent read it.
///
/// Shared by the review window's submit button and the tray's cancel item.
pub async fn submit_review_response(
    app: &AppHandle,
    review_id: String,
    snapshot_hash: String,
    verdict: String,
    body: PlanReviewResponseBody,
    encrypted: bool,
) -> Result<PlanReviewSubmitResult, String> {
    let config = load_config().map_err(|e| e.to_string())?;
    let key = if encrypted {
        config.encryption_key.as_deref()
    } else {
        None
    };

    let encoded = match payload::encode_payload(&body, key) {
        Ok(encoded) => encoded,
        Err(e) => {
            // Logged with detail for us; returned as the plain `Display`
            // message, which for `TooLargeToSubmit` is already the
            // human-actionable text shown in the review window — nothing
            // about compressed bytes or gzip leaks through.
            log::warn!("Refused to submit review {review_id}: {e}");
            return Err(e.to_string());
        }
    };
    let response_id = uuid::Uuid::new_v4().to_string();

    let message = PlanReviewResponseMessage {
        msg_type: "plan_review_response".to_string(),
        message_id: response_id.clone(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        protocol_version: Some(SUPPORTED_PROTOCOL_VERSION),
        review_id: review_id.clone(),
        responded_from: config.device_name.clone(),
        verdict: verdict.clone(),
        snapshot_hash,
        body: Some(encoded.payload_ref.clone()),
    };

    let attachment_cipher = (encoded.payload_ref.kind == "attachment").then_some(encoded.cipher.as_str());

    // Register before publishing: an ack can arrive before the PUT's own
    // response does, and a waiter registered afterwards would miss it.
    let waiters = app.state::<AckWaiters>();
    let ack_rx = waiters.register(&review_id, &response_id);

    if let Err(e) = publish_review_response(&config, &message, attachment_cipher, encrypted).await {
        waiters.forget(&response_id);
        log::error!("Failed to publish review {} response: {}", review_id, e);
        return Err(e.to_string());
    }

    log::info!(
        "Published {} for review {} ({} payload, response {})",
        verdict,
        review_id,
        encoded.payload_ref.kind,
        response_id
    );

    // Settled from this client's point of view the moment it is on the wire:
    // the tray must not offer to cancel a review the human has just answered.
    app.state::<OutstandingReviews>().settle(&review_id);

    let result = match tokio::time::timeout(ACK_TIMEOUT, ack_rx).await {
        Ok(Ok(ack)) => {
            log::info!(
                "Review {} acknowledged: {}{}",
                review_id,
                ack.status,
                ack.reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default()
            );
            PlanReviewSubmitResult {
                status: ack.status,
                response_id,
                reason: ack.reason,
            }
        }
        // Sender dropped without sending — treat exactly like a timeout rather
        // than inventing a fourth state the window would have to handle.
        Ok(Err(_)) | Err(_) => {
            waiters.forget(&response_id);
            log::warn!(
                "Review {} was published but not acknowledged within {}s",
                review_id,
                ACK_TIMEOUT.as_secs()
            );
            PlanReviewSubmitResult {
                status: "unacknowledged".to_string(),
                response_id,
                reason: Some(format!(
                    "No acknowledgement from the agent within {}s. The review was published; keep the draft until it is confirmed.",
                    ACK_TIMEOUT.as_secs()
                )),
            }
        }
    };

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exact event shape returned by GET /{topic}/json, captured from ntfy.sh.
    const EVENT_WITH_ATTACHMENT: &str = r#"{"id":"abc","time":1786504137,"event":"message",
        "topic":"t","message":"{\"type\":\"plan_review\"}",
        "attachment":{"name":"qurRQchLV1Fb.bin","type":"application/octet-stream",
        "size":5000,"expires":1786514937,"url":"https://ntfy.sh/file/qurRQchLV1Fb.bin"}}"#;

    #[test]
    fn parse_ntfy_event_lifts_the_message_and_the_attachment() {
        let event = parse_ntfy_event(EVENT_WITH_ATTACHMENT).unwrap();

        assert_eq!(event.message, r#"{"type":"plan_review"}"#);
        assert_eq!(event.time, 1786504137);
        let att = event.attachment.expect("attachment metadata must survive the reader");
        assert_eq!(att.url, "https://ntfy.sh/file/qurRQchLV1Fb.bin");
        assert_eq!(att.name, "qurRQchLV1Fb.bin");
        assert_eq!(att.size, Some(5000));
        assert_eq!(att.expires, Some(1786514937));
    }

    #[test]
    fn parse_ntfy_event_yields_no_attachment_for_an_ordinary_message() {
        let line =
            r#"{"id":"abc","event":"message","topic":"t","message":"{\"type\":\"question\"}"}"#;

        let event = parse_ntfy_event(line).unwrap();
        assert_eq!(event.message, r#"{"type":"question"}"#);
        assert!(event.attachment.is_none());
        assert_eq!(event.time, 0, "a missing time must not look like a real one");
    }

    #[test]
    fn parse_ntfy_event_discards_attachment_metadata_with_no_url() {
        // Nothing can be fetched without a URL, so it must not look present.
        let line = r#"{"message":"{}","attachment":{"name":"x.bin","size":1}}"#;

        assert!(parse_ntfy_event(line).unwrap().attachment.is_none());
    }

    #[test]
    fn parse_ntfy_event_skips_events_that_carry_no_message() {
        // ntfy sends open and keepalive events on the same stream.
        assert!(parse_ntfy_event(r#"{"id":"abc","event":"keepalive","topic":"t"}"#).is_none());
        assert!(parse_ntfy_event("not json at all").is_none());
        assert!(parse_ntfy_event(r#"{"message":42}"#).is_none());
    }

    // --- Reconnect de-dup (W2.6 / C-14) ---

    #[test]
    fn seen_ids_reports_the_first_sighting_and_suppresses_the_rest() {
        let mut seen = SeenIds::with_capacity(8);

        assert!(seen.insert("msg-1"), "first sighting must dispatch");
        assert!(!seen.insert("msg-1"), "a reconnect replay must not dispatch");
        assert!(seen.insert("msg-2"));
    }

    #[test]
    fn seen_ids_never_suppresses_a_message_with_no_id() {
        // messageId is #[serde(default)], so a malformed message yields "".
        // Collapsing all of those into one would hide every later failure.
        let mut seen = SeenIds::with_capacity(8);

        assert!(seen.insert(""));
        assert!(seen.insert(""));
    }

    #[test]
    fn seen_ids_evicts_in_arrival_order_once_full() {
        let mut seen = SeenIds::with_capacity(2);
        seen.insert("a");
        seen.insert("b");
        seen.insert("c"); // evicts "a"

        assert!(seen.insert("a"), "the oldest id must have been evicted");
        assert!(!seen.insert("c"), "the newest ids must still be remembered");
        assert_eq!(seen.ids.len(), seen.order.len(), "the two views must not drift");
        assert!(seen.ids.len() <= 2, "the set must stay bounded");
    }

    #[test]
    fn seen_ids_reinsertion_does_not_duplicate_the_eviction_queue() {
        let mut seen = SeenIds::with_capacity(4);
        for _ in 0..10 {
            seen.insert("same");
        }

        assert_eq!(seen.order.len(), 1);
        assert_eq!(seen.ids.len(), 1);
    }

    // --- Window labels (W2.3 / W2.4) ---

    #[test]
    fn window_label_takes_the_first_eight_characters() {
        assert_eq!(
            window_label("dialog", "21ba33d7-08a8-4761-9abf-5f4e6ba364b1"),
            "dialog-21ba33d7"
        );
        assert_eq!(
            window_label("review", "21ba33d7-08a8-4761-9abf-5f4e6ba364b1"),
            "review-21ba33d7"
        );
    }

    #[test]
    fn window_label_distinguishes_a_review_from_a_dialog_with_the_same_id() {
        // The whole point of W2.4: an `answer` closes dialog-<id>, and that must
        // never be able to name the review window for the same id.
        let id = "abcdef01-2345";
        assert_ne!(window_label("dialog", id), window_label("review", id));
    }

    #[test]
    fn window_label_handles_short_and_multibyte_ids_without_panicking() {
        assert_eq!(window_label("dialog", "abc"), "dialog-abc");
        assert_eq!(window_label("dialog", ""), "dialog-");
        // Slicing [..8] on bytes would split these characters and panic.
        assert_eq!(window_label("review", "日本語のидентификатор"), "review-日本語のиден");
    }

    // --- Cache settlement (W2.8 / D-6) ---

    fn cache_line(message: &str) -> String {
        format!(
            r#"{{"id":"e","time":1,"event":"message","topic":"t","message":{}}}"#,
            serde_json::to_string(message).unwrap()
        )
    }

    #[test]
    fn answered_ids_covers_answers_responses_and_cancellations() {
        // A review settled hours ago must not re-open on the next client start —
        // past the 3 h attachment expiry it would re-open as "plan expired".
        let body = [
            cache_line(r#"{"type":"answer","questionId":"q-1"}"#),
            cache_line(r#"{"type":"plan_review_response","reviewId":"r-1"}"#),
            cache_line(r#"{"type":"cancel_review","reviewId":"r-2"}"#),
            cache_line(r#"{"type":"question","messageId":"q-2"}"#),
            cache_line(r#"{"type":"plan_review","messageId":"r-3"}"#),
        ]
        .join("\n");

        let settled = extract_answered_ids(&body, &HitlConfig::default());

        assert!(settled.contains("q-1"));
        assert!(settled.contains("r-1"));
        assert!(settled.contains("r-2"));
        assert!(!settled.contains("q-2"), "an unanswered question is not settled");
        assert!(!settled.contains("r-3"), "an unreviewed plan is not settled");
    }

    #[test]
    fn answered_ids_survives_junk_lines_in_the_cache_body() {
        let body = format!(
            "\n  \nnot json\n{}\n{}\n",
            cache_line("also not json"),
            cache_line(r#"{"type":"answer","questionId":"q-1"}"#)
        );

        assert!(extract_answered_ids(&body, &HitlConfig::default()).contains("q-1"));
    }

    // --- Review window payload (W2.2 / W2.3 / C-2 / C-4) ---

    fn a_review() -> PlanReviewMessage {
        serde_json::from_str(
            r#"{"type":"plan_review","messageId":"rev-12345678","timestamp":7,
                "protocolVersion":2,"context":"c","summary":"s","displayPath":"docs/plan.md",
                "planId":"p1","revision":2,"isNewPlan":false,"snapshotHash":"sha256:aa",
                "body":{"kind":"attachment","contentHash":"bb","contentLength":9}}"#,
        )
        .unwrap()
    }

    #[test]
    fn review_payload_replaces_the_body_ref_with_the_decoded_body() {
        let decoded = Ok(PlanReviewBody {
            content: "# Plan\nline two\n".to_string(),
            diff: "@@ -1 +1 @@\n".to_string(),
        });

        let json: serde_json::Value = serde_json::from_str(&review_window_payload(
            &a_review(),
            &decoded,
            true,
            "Kay9",
            None,
        ))
        .unwrap();

        // The window has no use for a PlanPayloadRef; it needs the plan.
        assert_eq!(json["body"]["content"], "# Plan\nline two\n");
        assert_eq!(json["body"]["diff"], "@@ -1 +1 @@\n");
        assert!(json["body"].get("contentHash").is_none());
        assert_eq!(json["_error"], serde_json::Value::Null);
        assert_eq!(json["_wasEncrypted"], true);
        assert_eq!(json["_device"], "Kay9");
        // Metadata the window renders around the plan must survive intact.
        assert_eq!(json["revision"], 2);
        assert_eq!(json["displayPath"], "docs/plan.md");
        assert_eq!(json["snapshotHash"], "sha256:aa");
    }

    #[test]
    fn review_payload_names_an_expired_attachment_rather_than_going_blank() {
        // Guaranteed to happen: attachments live 3 h, messages 12 h, and the
        // cache is replayed with since=all on every client start.
        let decoded = Err(ReviewBodyError::Payload(PayloadError::Expired));

        let json: serde_json::Value = serde_json::from_str(&review_window_payload(
            &a_review(),
            &decoded,
            true,
            "Kay9",
            None,
        ))
        .unwrap();

        assert_eq!(json["body"], serde_json::Value::Null);
        assert_eq!(json["_error"]["kind"], "expired");
        assert!(!json["_error"]["message"].as_str().unwrap().is_empty());
        // The window still gets everything it needs to say WHICH plan expired.
        assert_eq!(json["displayPath"], "docs/plan.md");
        assert_eq!(json["messageId"], "rev-12345678");
    }

    #[test]
    fn a_saved_draft_rides_back_in_on_the_window_payload() {
        // The read half of save_review_draft. There is no separate command for
        // it: the window takes its payload once, so the draft has to be in it.
        let decoded = Ok(PlanReviewBody {
            content: "# Plan\n".to_string(),
            diff: "@@ -1 +1 @@\n".to_string(),
        });
        let draft = crate::drafts::ReviewDraft {
            review_id: "rev-12345678".to_string(),
            plan_id: "plan-abc".to_string(),
            snapshot_hash: "sha256:aa".to_string(),
            overall_feedback: "half-written thought".to_string(),
            inline_comments: vec![],
            saved_at: 7,
        };

        let json: serde_json::Value = serde_json::from_str(&review_window_payload(
            &a_review(),
            &decoded,
            false,
            "Kay9",
            Some(draft),
        ))
        .unwrap();

        assert_eq!(json["_draft"]["overallFeedback"], "half-written thought");
        assert_eq!(json["_draft"]["planId"], "plan-abc");
    }

    #[test]
    fn no_draft_is_an_explicit_null_rather_than_a_missing_key() {
        let decoded = Ok(PlanReviewBody {
            content: "# Plan\n".to_string(),
            diff: String::new(),
        });

        let json: serde_json::Value = serde_json::from_str(&review_window_payload(
            &a_review(),
            &decoded,
            false,
            "Kay9",
            None,
        ))
        .unwrap();

        assert_eq!(json["_draft"], serde_json::Value::Null);
    }

    fn envelope(version: u32, msg_type: &str) -> VersionVerdict {
        version_verdict(version, msg_type)
    }

    #[test]
    fn the_resume_point_never_mixes_the_local_clock_with_ntfys() {
        // Before any event, resume is a duration ntfy resolves against its own
        // clock — our wall clock never enters the request at all.
        assert_eq!(since_param(None, 0), "10s");
        assert_eq!(since_param(None, 5), "15s");

        // Once an event has arrived, resume from its own server timestamp.
        assert_eq!(since_param(Some(1_786_543_402), 9_999), "1786543402");
    }

    #[test]
    fn a_fast_local_clock_cannot_pin_the_resume_point_in_the_future() {
        // The defect: seeding from local wall-clock time and max()-ing against
        // server timestamps. A laptop five minutes fast kept its own seed
        // forever, so after a reconnect ntfy was asked for messages newer than
        // a moment that had not happened yet — and everything published during
        // the disconnect was never delivered.
        let mut state = LiveState {
            assembler: ChunkAssembler::new(),
            seen: SeenIds::with_capacity(4),
            started: std::time::Instant::now(),
            last_event_ts: None,
        };

        // Server time, five minutes "behind" a fast local clock.
        state.observe(1_786_543_000);
        assert_eq!(state.since_param(), "1786543000");

        // A later server event advances it; an earlier one does not rewind it.
        state.observe(1_786_543_402);
        assert_eq!(state.since_param(), "1786543402");
        state.observe(1_786_542_000);
        assert_eq!(state.since_param(), "1786543402");
    }

    #[test]
    fn an_event_with_no_time_leaves_the_resume_point_alone() {
        let mut state = LiveState {
            assembler: ChunkAssembler::new(),
            seen: SeenIds::with_capacity(4),
            started: std::time::Instant::now(),
            last_event_ts: None,
        };

        state.observe(0);
        assert!(state.last_event_ts.is_none(), "0 is absence, not an instant");
        assert!(state.since_param().ends_with('s'), "still relative");
    }

    #[test]
    fn a_long_disconnect_before_any_event_is_capped_at_the_cache_window() {
        // Nothing older than ntfy's cache is retrievable, so asking for a week
        // only makes the URL silly.
        assert_eq!(since_param(None, 7 * 24 * 3600), format!("{RESUME_MAX_SECS}s"));
    }

    #[test]
    fn clipping_an_error_body_never_splits_a_character() {
        // The sibling of the window_label byte-slice panic. A localized proxy
        // error page with a multi-byte character straddling the cut used to
        // panic inside submit_plan_review, stranding the review window on
        // "submitting…" with the typed comments lost.
        let multibyte = "é".repeat(300);
        assert_eq!(clip_chars(&multibyte, 200).chars().count(), 200);

        // A cut landing mid-character in byte space is the case that panicked.
        let straddling = format!("{}日本語", "a".repeat(199));
        assert_eq!(clip_chars(&straddling, 200), format!("{}日", "a".repeat(199)));

        // Shorter than the limit, and empty, both pass through untouched.
        assert_eq!(clip_chars("short", 200), "short");
        assert_eq!(clip_chars("", 200), "");
        assert_eq!(clip_chars("日本語", 0), "");
    }

    #[test]
    fn every_http_client_in_this_module_carries_a_deadline() {
        // Not a style preference. `Client::new()` has no request timeout and no
        // connect timeout, and dispatch is awaited inline in the stream loop,
        // so a single host that accepts a connection and then goes quiet stops
        // every future message from being dispatched.
        for (timeout, read_timeout) in [
            (Some(REQUEST_TIMEOUT), None),
            (Some(ATTACHMENT_TIMEOUT), None),
            (None, Some(STREAM_READ_TIMEOUT)),
        ] {
            // Builds rather than falling back to the untimed default.
            let _ = http_client(timeout, read_timeout);
        }
    }

    #[test]
    fn the_subscription_read_timeout_outlives_an_ntfy_keepalive() {
        // ntfy sends a keepalive roughly every 45 s. A read timeout at or below
        // that would tear down a perfectly healthy subscription on a timer, and
        // the reconnect loop would hide it as a recurring "stream ended".
        const NTFY_KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(45);

        assert!(
            STREAM_READ_TIMEOUT > NTFY_KEEPALIVE * 2,
            "a subscription must tolerate at least two missed keepalives"
        );
        // And it must not be given an overall deadline: a long poll is supposed
        // to stay open for hours.
        assert!(CONNECT_TIMEOUT < REQUEST_TIMEOUT);
        assert!(ATTACHMENT_TIMEOUT >= REQUEST_TIMEOUT);
    }

    #[test]
    fn a_duplicate_message_is_dispatched_once_whichever_origin_it_arrives_from() {
        // The shipping AskUserQuestion break. De-dup used to apply only to the
        // live stream, so two identical events in the ntfy cache produced two
        // synchronous show_question calls microseconds apart. The second one's
        // failed window build tore the payload back out of the store while the
        // first window's webview was still loading — leaving a dead dialog on
        // a question nothing could then answer.
        let mut seen = SeenIds::with_capacity(8);
        let answered = HashSet::new();

        {
            let mut cache = Origin::Cache {
                answered_ids: &answered,
                seen: &mut seen,
            };
            assert!(cache.seen().insert("q-1"), "first sighting dispatches");
            assert!(
                !cache.seen().insert("q-1"),
                "a duplicate inside the cache must not dispatch twice"
            );
        }

        // Same set carries into the live phase: the cache replay and the
        // subscription overlap by design, so the handover must not re-dispatch.
        let mut live = Origin::Live { seen: &mut seen };
        assert!(
            !live.seen().insert("q-1"),
            "the cache/live overlap must not re-dispatch"
        );
        assert!(live.seen().insert("q-2"), "an unrelated message still dispatches");
    }

    #[test]
    fn a_supported_version_is_dispatched_normally() {
        for msg_type in ["question", "plan_review", "answer", "chunk"] {
            assert_eq!(envelope(SUPPORTED_PROTOCOL_VERSION, msg_type), VersionVerdict::Handle);
            assert_eq!(envelope(1, msg_type), VersionVerdict::Handle);
        }
    }

    #[test]
    fn a_too_new_message_a_human_is_waiting_on_reaches_the_window() {
        // A-7. The old gate logged and returned, so the panel review.js renders
        // could only be reached through a window Rust had already decided not
        // to open — a bumped protocol would leave the agent blocked forever on
        // a request nobody ever saw.
        let too_new = SUPPORTED_PROTOCOL_VERSION + 1;

        assert_eq!(envelope(too_new, "plan_review"), VersionVerdict::ShowUpgradePanel);
        assert_eq!(envelope(too_new, "question"), VersionVerdict::ShowUpgradePanel);
        assert_eq!(envelope(too_new, "notification"), VersionVerdict::ShowUpgradePanel);
    }

    #[test]
    fn an_unknown_future_message_type_still_reaches_the_window() {
        // The case this is actually for: a version bump that introduces a type
        // this build has never heard of. Defaulting to silence would recreate
        // the exact failure A-7 exists to prevent.
        assert_eq!(
            envelope(SUPPORTED_PROTOCOL_VERSION + 1, "plan_review_v2"),
            VersionVerdict::ShowUpgradePanel
        );
        assert_eq!(
            envelope(99, "something_invented_years_from_now"),
            VersionVerdict::ShowUpgradePanel
        );
    }

    #[test]
    fn a_too_new_settlement_message_is_ignored_without_a_window() {
        // These resolve something rather than ask for it, so nothing is
        // waiting. One panel per ack would bury the one panel that matters.
        let too_new = SUPPORTED_PROTOCOL_VERSION + 1;

        for msg_type in [
            "answer",
            "plan_review_response",
            "plan_review_ack",
            "cancel_review",
            "dismiss_notification",
            "chunk",
        ] {
            assert_eq!(
                envelope(too_new, msg_type),
                VersionVerdict::Ignore,
                "{msg_type} should not open a window"
            );
        }
    }

    #[test]
    fn a_review_window_fits_a_display_it_would_otherwise_overflow() {
        // E-9. 1366x768 is the case that breaks: 900 > 768, and .center() then
        // pushes the verdict footer off the bottom edge, leaving the plan
        // readable and unactionable.
        let (w, h) = fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (1366.0, 728.0));

        assert_eq!(w, 1280.0, "width already fits");
        assert_eq!(h, 728.0, "height must come down to the work area");
    }

    #[test]
    fn a_large_display_gets_the_preferred_size() {
        let (w, h) = fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (2560.0, 1400.0));

        assert_eq!((w, h), REVIEW_PREFERRED_SIZE);
    }

    #[test]
    fn a_narrow_display_shrinks_both_dimensions_independently() {
        let (w, h) = fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (1024.0, 1400.0));

        assert_eq!(w, 1024.0);
        assert_eq!(h, 900.0);
    }

    #[test]
    fn a_display_smaller_than_the_minimum_takes_the_display() {
        // Clamping up to the minimum would put the edges back off-screen,
        // which is the bug rather than the fix.
        let (w, h) = fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (640.0, 480.0));

        assert_eq!((w, h), (640.0, 480.0));
    }

    #[test]
    fn unusable_monitor_information_falls_back_to_the_preferred_size() {
        assert_eq!(
            fit_to_work_area(REVIEW_PREFERRED_SIZE, REVIEW_MIN_SIZE, (0.0, 0.0)),
            REVIEW_PREFERRED_SIZE
        );
    }

    #[test]
    fn review_body_error_kinds_are_distinct_and_stable() {
        // These strings are a contract with review.js, not a log format.
        let cases: Vec<(ReviewBodyError, &str)> = vec![
            (ReviewBodyError::Payload(PayloadError::Expired), "expired"),
            (
                ReviewBodyError::Payload(PayloadError::HashMismatch {
                    expected: "a".into(),
                    actual: "b".into(),
                }),
                "hash_mismatch",
            ),
            (ReviewBodyError::Payload(PayloadError::Decrypt("x".into())), "decrypt"),
            (ReviewBodyError::Payload(PayloadError::Gunzip("x".into())), "corrupt"),
            (ReviewBodyError::Payload(PayloadError::Base64("x".into())), "corrupt"),
            (ReviewBodyError::Payload(PayloadError::Json("x".into())), "corrupt"),
            (
                ReviewBodyError::Payload(PayloadError::TooLarge { limit: 1 }),
                "corrupt",
            ),
            (ReviewBodyError::Payload(PayloadError::MissingData), "missing"),
            (ReviewBodyError::NoAttachment, "missing"),
            (ReviewBodyError::Network("timeout".into()), "unavailable"),
        ];

        for (error, expected) in cases {
            assert_eq!(error.kind(), expected, "{error}");
            assert!(!error.to_string().is_empty(), "every state needs words");
        }
    }

    #[tokio::test]
    async fn decode_refuses_a_tampered_body_instead_of_rendering_half_a_plan() {
        let body = PlanReviewBody {
            content: "# Plan".to_string(),
            diff: String::new(),
        };
        let encoded = payload::encode_payload(&body, None).unwrap();

        let body_ref = PlanPayloadRef {
            kind: "inline".to_string(),
            data: Some(encoded.cipher.clone()),
            content_hash: "0".repeat(64), // not the hash of anything we sent
            content_length: encoded.payload_ref.content_length,
        };

        let err = download_and_decode(Some(&body_ref), None, &HitlConfig::default())
            .await
            .unwrap_err();

        assert_eq!(err.kind(), "hash_mismatch");
    }

    #[tokio::test]
    async fn decode_reports_missing_data_rather_than_an_empty_plan() {
        let config = HitlConfig::default();

        // No body ref at all.
        assert_eq!(
            download_and_decode(None, None, &config).await.unwrap_err().kind(),
            "missing"
        );

        // kind=inline but no data.
        let no_data = PlanPayloadRef {
            kind: "inline".to_string(),
            data: None,
            content_hash: String::new(),
            content_length: 0,
        };
        assert_eq!(
            download_and_decode(Some(&no_data), None, &config).await.unwrap_err().kind(),
            "missing"
        );

        // kind=attachment but the event carried no attachment metadata.
        let no_attachment = PlanPayloadRef {
            kind: "attachment".to_string(),
            data: None,
            content_hash: String::new(),
            content_length: 0,
        };
        assert_eq!(
            download_and_decode(Some(&no_attachment), None, &config).await.unwrap_err().kind(),
            "missing"
        );
    }

    #[tokio::test]
    async fn decode_round_trips_an_inline_body() {
        let body = PlanReviewBody {
            content: "# Plan\r\nCRLF must survive\r\n".to_string(),
            diff: "@@\n".to_string(),
        };
        let encoded = payload::encode_payload(&body, None).unwrap();

        let decoded = download_and_decode(
            Some(&encoded.payload_ref),
            None,
            &HitlConfig::default(),
        )
        .await
        .unwrap();

        assert_eq!(decoded.content, "# Plan\r\nCRLF must survive\r\n");
        assert_eq!(decoded.diff, "@@\n");
    }

    // --- Acknowledgement matching (W2.7 / C-12) ---

    fn ack(review_id: &str, response_id: &str, status: &str) -> PlanReviewAckMessage {
        serde_json::from_str(&format!(
            r#"{{"type":"plan_review_ack","reviewId":"{review_id}",
                 "responseId":"{response_id}","status":"{status}"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn ack_matches_on_response_id_when_the_server_knows_it() {
        assert!(ack_matches(&ack("r-1", "p-1", "received"), "r-1", "p-1"));
        assert!(
            !ack_matches(&ack("r-1", "p-2", "received"), "r-1", "p-1"),
            "a sibling device's response must not resolve our submission"
        );
    }

    #[test]
    fn ack_falls_back_to_review_id_when_the_response_could_not_be_identified() {
        // The status:"lost" case: the agent could not decode far enough to learn
        // which response it was. That is exactly the ack the window most needs.
        assert!(ack_matches(&ack("r-1", "", "lost"), "r-1", "p-1"));
    }

    #[test]
    fn ack_with_no_usable_id_matches_nothing() {
        assert!(!ack_matches(&ack("", "", "lost"), "r-1", "p-1"));
        assert!(!ack_matches(&ack("r-2", "", "lost"), "r-1", "p-1"));
    }

    #[test]
    fn ack_registry_delivers_once_and_forgets() {
        let waiters = AckWaiters::default();
        let mut rx = waiters.register("r-1", "p-1");

        waiters.deliver(ack("r-1", "p-1", "received"));
        assert_eq!(rx.try_recv().unwrap().status, "received");
        assert_eq!(waiters.0.lock().unwrap().len(), 0, "a delivered waiter must be dropped");

        // A duplicate ack must not panic or resurrect anything.
        waiters.deliver(ack("r-1", "p-1", "received"));
    }

    #[test]
    fn ack_registry_routes_to_the_right_concurrent_submission() {
        let waiters = AckWaiters::default();
        let mut first = waiters.register("r-1", "p-1");
        let mut second = waiters.register("r-2", "p-2");

        waiters.deliver(ack("r-2", "p-2", "lost"));

        assert_eq!(second.try_recv().unwrap().status, "lost");
        assert!(first.try_recv().is_err(), "the unrelated submission must still be waiting");
        assert_eq!(waiters.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn ack_registry_forget_removes_a_timed_out_submission() {
        let waiters = AckWaiters::default();
        let _rx = waiters.register("r-1", "p-1");
        waiters.forget("p-1");

        assert_eq!(waiters.0.lock().unwrap().len(), 0);
        waiters.deliver(ack("r-1", "p-1", "received")); // must not panic
    }

    #[tokio::test]
    async fn attachment_upload_refuses_an_oversized_x_message_before_calling_ntfy() {
        // Overflow is answered by nginx with HTML, not ntfy's JSON envelope, so
        // it must be caught here with a name rather than parsed out of a 400.
        let mut response: PlanReviewResponseMessage =
            serde_json::from_str(r#"{"type":"plan_review_response","reviewId":"r-1"}"#).unwrap();
        response.snapshot_hash = "x".repeat(X_MESSAGE_MAX_BYTES);

        let config = HitlConfig {
            ntfy_url: "http://127.0.0.1:1".to_string(), // must never be reached
            topic_id: "t".to_string(),
            ..HitlConfig::default()
        };

        let err = publish_review_response(&config, &response, Some("cipher"), false)
            .await
            .unwrap_err()
            .to_string();

        assert!(err.contains("X-Message budget"), "{err}");
    }
}
