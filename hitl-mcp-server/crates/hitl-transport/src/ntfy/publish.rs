use crate::crypto;
use crate::ntfy::http::{http_client, REQUEST_TIMEOUT};
use crate::types::{
    AnswerMessage, DismissNotificationMessage, HitlConfig, RestoreNotificationMessage,
};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const MAX_PUBLISH_ATTEMPTS: usize = 4;
const RETRY_BUDGET: Duration = Duration::from_secs(20);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
const NTFY_DEFAULT_BURST: usize = 60;
const NTFY_DEFAULT_REFILL: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum PublishPriority {
    Retry,
    Single,
    Bulk,
}

#[derive(Clone, Copy)]
struct Waiter {
    id: u64,
    priority: PublishPriority,
}

struct LimiterState {
    tokens: usize,
    next_refill: tokio::time::Instant,
    cooldown_until: tokio::time::Instant,
    next_waiter_id: u64,
    waiters: VecDeque<Waiter>,
}

/// Process-wide ntfy visitor pacing. State is shared by URL origin, while each
/// waiter reserves only the permit it is about to use.
struct PublishLimiter {
    capacity: usize,
    refill: Duration,
    state: Mutex<LimiterState>,
    changed: tokio::sync::Notify,
}

impl PublishLimiter {
    fn with_limits(capacity: usize, refill: Duration) -> Self {
        let now = tokio::time::Instant::now();
        Self {
            capacity,
            refill,
            state: Mutex::new(LimiterState {
                tokens: capacity,
                next_refill: now + refill,
                cooldown_until: now,
                next_waiter_id: 0,
                waiters: VecDeque::new(),
            }),
            changed: tokio::sync::Notify::new(),
        }
    }

    fn refill(&self, state: &mut LimiterState, now: tokio::time::Instant) {
        if now < state.next_refill {
            return;
        }
        let elapsed = now.duration_since(state.next_refill);
        let intervals = 1 + elapsed.as_nanos() / self.refill.as_nanos();
        state.next_refill += self.refill * (intervals.min(u32::MAX as u128) as u32);
        if state.tokens < self.capacity {
            state.tokens = self
                .capacity
                .min(state.tokens.saturating_add(intervals as usize));
        }
    }

    async fn acquire(self: &Arc<Self>, priority: PublishPriority) {
        let id = {
            let mut state = self.state.lock().unwrap();
            let id = state.next_waiter_id;
            state.next_waiter_id = state.next_waiter_id.wrapping_add(1);
            state.waiters.push_back(Waiter { id, priority });
            id
        };
        let mut registration = WaiterRegistration {
            limiter: self.clone(),
            id: Some(id),
        };

        loop {
            let notified = self.changed.notified();
            let decision = {
                let mut state = self.state.lock().unwrap();
                let now = tokio::time::Instant::now();
                self.refill(&mut state, now);
                let selected = state
                    .waiters
                    .iter()
                    .enumerate()
                    .min_by_key(|(index, waiter)| (waiter.priority, *index))
                    .map(|(_, waiter)| waiter.id);
                if now >= state.cooldown_until && state.tokens > 0 && selected == Some(id) {
                    state.tokens -= 1;
                    state.waiters.retain(|waiter| waiter.id != id);
                    None
                } else {
                    Some(state.cooldown_until.max(state.next_refill))
                }
            };

            let Some(wake_at) = decision else {
                registration.id = None;
                self.changed.notify_waiters();
                return;
            };
            tokio::select! {
                _ = tokio::time::sleep_until(wake_at) => {}
                _ = notified => {}
            }
        }
    }

    fn apply_rate_limit(&self, delay: Duration) {
        let mut state = self.state.lock().unwrap();
        let cooldown = tokio::time::Instant::now() + delay;
        state.tokens = 0;
        state.cooldown_until = state.cooldown_until.max(cooldown);
        state.next_refill = state.next_refill.max(state.cooldown_until);
        drop(state);
        self.changed.notify_waiters();
    }
}

struct WaiterRegistration {
    limiter: Arc<PublishLimiter>,
    id: Option<u64>,
}

impl Drop for WaiterRegistration {
    fn drop(&mut self) {
        let Some(id) = self.id else { return };
        self.limiter
            .state
            .lock()
            .unwrap()
            .waiters
            .retain(|waiter| waiter.id != id);
        self.limiter.changed.notify_waiters();
    }
}

fn limiter_for(url: &str) -> Arc<PublishLimiter> {
    static LIMITERS: OnceLock<Mutex<HashMap<String, Arc<PublishLimiter>>>> = OnceLock::new();
    let key = reqwest::Url::parse(url)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| url.to_string());
    let mut limiters = LIMITERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if let Some(limiter) = limiters.get(&key) {
        return limiter.clone();
    }
    let limiter = Arc::new(PublishLimiter::with_limits(
        NTFY_DEFAULT_BURST,
        NTFY_DEFAULT_REFILL,
    ));
    limiters.insert(key, limiter.clone());
    limiter
}

fn retry_after(value: Option<&reqwest::header::HeaderValue>, now: SystemTime) -> Option<Duration> {
    let value = value?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    httpdate::parse_http_date(value)
        .ok()?
        .duration_since(now)
        .ok()
}

fn retryable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status.is_server_error()
}

async fn publish_prepared(
    client: &reqwest::Client,
    url: &str,
    body: String,
    initial_priority: PublishPriority,
) -> Result<(), Box<dyn std::error::Error>> {
    let limiter = limiter_for(url);
    limiter.acquire(initial_priority).await;
    let started = tokio::time::Instant::now();
    let mut backoff = Duration::from_millis(250);
    for attempt in 0..MAX_PUBLISH_ATTEMPTS {
        let remaining = RETRY_BUDGET.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err("ntfy delivery could not be confirmed within the retry budget".into());
        }
        if attempt > 0
            && tokio::time::timeout(remaining, limiter.acquire(PublishPriority::Retry))
                .await
                .is_err()
        {
            return Err("ntfy delivery could not be confirmed within the retry budget".into());
        }
        let remaining = RETRY_BUDGET.saturating_sub(started.elapsed());
        let request = client
            .post(url)
            .header("Content-Type", "application/json")
            .body(body.clone())
            .send();
        let response = match tokio::time::timeout(remaining, request).await {
            Ok(response) => response,
            Err(_) => {
                return Err("ntfy delivery could not be confirmed within the retry budget".into())
            }
        };
        match response {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) if retryable_status(response.status()) => {
                let status = response.status();
                let server_delay = retry_after(
                    response.headers().get(reqwest::header::RETRY_AFTER),
                    SystemTime::now(),
                );
                let fallback = if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    Duration::from_secs(5)
                } else {
                    backoff
                };
                // Different payloads get a small deterministic spread so a
                // batch does not wake every retry on the same millisecond.
                let jitter = Duration::from_millis(
                    (body
                        .bytes()
                        .fold(attempt as u64, |sum, byte| sum + byte as u64)
                        % 250)
                        + 1,
                );
                let delay = server_delay.unwrap_or(fallback).saturating_add(jitter);
                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    // Every peer sees server feedback, even when this request
                    // has no retry budget left to wait out the cooldown.
                    limiter.apply_rate_limit(delay);
                }
                let remaining = RETRY_BUDGET.saturating_sub(started.elapsed());
                if attempt + 1 == MAX_PUBLISH_ATTEMPTS || delay > remaining {
                    return Err(format!("ntfy publish failed after retries: {status}").into());
                }
                if status != reqwest::StatusCode::TOO_MANY_REQUESTS {
                    tokio::time::sleep(delay).await;
                }
            }
            Ok(response) => {
                return Err(format!("ntfy publish failed: {}", response.status()).into())
            }
            Err(error) if error.is_timeout() || error.is_connect() => {
                let remaining = RETRY_BUDGET.saturating_sub(started.elapsed());
                if attempt + 1 == MAX_PUBLISH_ATTEMPTS || backoff > remaining {
                    return Err(format!(
                        "ntfy delivery could not be confirmed after retries: {error}"
                    )
                    .into());
                }
                tokio::time::sleep(backoff).await;
            }
            Err(error) => return Err(error.into()),
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
    unreachable!()
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
    let client = http_client(Some(REQUEST_TIMEOUT), None);
    publish_message_with_client_priority(
        &client,
        config,
        &serde_json::to_string(msg)?,
        encrypted,
        PublishPriority::Single,
    )
    .await
}

/// Publish a dismissal using a caller-owned client.
pub async fn publish_dismiss_notification_with_client(
    client: &reqwest::Client,
    config: &HitlConfig,
    msg: &DismissNotificationMessage,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    publish_message_with_client(client, config, &serde_json::to_string(msg)?, encrypted).await
}

/// Publish a restore-notification message to ntfy.
/// If `encrypted` is true and config has an encryption key, the message is encrypted.
pub async fn publish_restore_notification(
    config: &HitlConfig,
    msg: &RestoreNotificationMessage,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = http_client(Some(REQUEST_TIMEOUT), None);
    publish_message_with_client_priority(
        &client,
        config,
        &serde_json::to_string(msg)?,
        encrypted,
        PublishPriority::Single,
    )
    .await
}

/// Publish a restoration using a caller-owned client.
pub async fn publish_restore_notification_with_client(
    client: &reqwest::Client,
    config: &HitlConfig,
    msg: &RestoreNotificationMessage,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    publish_message_with_client(client, config, &serde_json::to_string(msg)?, encrypted).await
}

/// Publish a raw JSON message to ntfy, optionally encrypting it.
pub async fn publish_message(
    config: &HitlConfig,
    body: &str,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = http_client(Some(REQUEST_TIMEOUT), None);
    publish_message_with_client_priority(&client, config, body, encrypted, PublishPriority::Single)
        .await
}

/// Publish raw JSON with a caller-owned client so a bounded local batch can
/// reuse one connection pool without changing the ntfy wire protocol.
pub async fn publish_message_with_client(
    client: &reqwest::Client,
    config: &HitlConfig,
    body: &str,
    encrypted: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    publish_message_with_client_priority(client, config, body, encrypted, PublishPriority::Bulk)
        .await
}

async fn publish_message_with_client_priority(
    client: &reqwest::Client,
    config: &HitlConfig,
    body: &str,
    encrypted: bool,
    priority: PublishPriority,
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

    // Encryption happens once: retries reuse the exact bytes and therefore the
    // same application event identity and ciphertext.
    publish_prepared(client, &url, final_body, priority).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[test]
    fn limiter_is_shared_by_origin_but_not_unrelated_hosts() {
        let first = limiter_for("https://ntfy.example/topic-a");
        let sibling = limiter_for("https://ntfy.example/topic-b");
        let unrelated = limiter_for("https://other.example/topic-a");

        assert!(Arc::ptr_eq(&first, &sibling));
        assert!(!Arc::ptr_eq(&first, &unrelated));
    }

    #[tokio::test(start_paused = true)]
    async fn exhausted_allowance_is_shared_and_refills_after_elapsed_time() {
        let limiter = Arc::new(PublishLimiter::with_limits(1, Duration::from_secs(5)));
        limiter.acquire(PublishPriority::Bulk).await;

        let waiting = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(PublishPriority::Bulk).await }
        });
        tokio::task::yield_now().await;
        assert!(
            !waiting.is_finished(),
            "a second batch shared the exhausted allowance"
        );

        tokio::time::advance(Duration::from_secs(4)).await;
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "allowance refilled too early");
        tokio::time::advance(Duration::from_secs(1)).await;
        waiting.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn idle_full_bucket_does_not_carry_an_extra_refill() {
        let limiter = Arc::new(PublishLimiter::with_limits(2, Duration::from_secs(5)));
        tokio::time::advance(Duration::from_secs(10)).await;
        limiter.acquire(PublishPriority::Bulk).await;
        limiter.acquire(PublishPriority::Bulk).await;

        let third = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(PublishPriority::Bulk).await }
        });
        tokio::task::yield_now().await;
        assert!(
            !third.is_finished(),
            "an idle full bucket allowed more than its exact capacity"
        );

        tokio::time::advance(Duration::from_secs(5)).await;
        third.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn shared_cooldown_blocks_siblings_and_prioritizes_rate_limited_retry() {
        let limiter = Arc::new(PublishLimiter::with_limits(1, Duration::from_secs(5)));
        limiter.acquire(PublishPriority::Bulk).await;
        limiter.apply_rate_limit(Duration::from_secs(5));

        let order = Arc::new(Mutex::new(Vec::new()));
        let bulk = tokio::spawn({
            let limiter = limiter.clone();
            let order = order.clone();
            async move {
                limiter.acquire(PublishPriority::Bulk).await;
                order.lock().unwrap().push("bulk");
            }
        });
        tokio::task::yield_now().await;
        let retry = tokio::spawn({
            let limiter = limiter.clone();
            let order = order.clone();
            async move {
                limiter.acquire(PublishPriority::Retry).await;
                order.lock().unwrap().push("retry");
            }
        });
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_secs(4)).await;
        tokio::task::yield_now().await;
        assert!(
            order.lock().unwrap().is_empty(),
            "a sibling sent during cooldown"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        retry.await.unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["retry"]);
        tokio::time::advance(Duration::from_secs(5)).await;
        bulk.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn single_send_does_not_wait_behind_queued_bulk_work() {
        let limiter = Arc::new(PublishLimiter::with_limits(1, Duration::from_secs(5)));
        limiter.acquire(PublishPriority::Bulk).await;
        let order = Arc::new(Mutex::new(Vec::new()));

        let bulk = tokio::spawn({
            let limiter = limiter.clone();
            let order = order.clone();
            async move {
                limiter.acquire(PublishPriority::Bulk).await;
                order.lock().unwrap().push("bulk");
            }
        });
        tokio::task::yield_now().await;
        let single = tokio::spawn({
            let limiter = limiter.clone();
            let order = order.clone();
            async move {
                limiter.acquire(PublishPriority::Single).await;
                order.lock().unwrap().push("single");
            }
        });
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_secs(5)).await;
        single.await.unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["single"]);
        tokio::time::advance(Duration::from_secs(5)).await;
        bulk.await.unwrap();
    }

    fn response_server(statuses: Vec<&'static str>) -> (String, Arc<Mutex<Vec<Vec<u8>>>>) {
        response_server_with_retry(
            statuses
                .into_iter()
                .map(|status| (status, (status == "429 Too Many Requests").then_some("0")))
                .collect(),
        )
    }

    fn response_server_with_retry(
        responses: Vec<(&'static str, Option<&'static str>)>,
    ) -> (String, Arc<Mutex<Vec<Vec<u8>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let recorded = bodies.clone();
        std::thread::spawn(move || {
            for (status, retry_after) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 4096];
                loop {
                    let count = stream.read(&mut chunk).unwrap();
                    request.extend_from_slice(&chunk[..count]);
                    let header_end = request.windows(4).position(|part| part == b"\r\n\r\n");
                    let Some(header_end) = header_end else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + length {
                        recorded
                            .lock()
                            .unwrap()
                            .push(request[header_end + 4..header_end + 4 + length].to_vec());
                        break;
                    }
                }
                let retry = retry_after
                    .map(|value| format!("Retry-After: {value}\r\n"))
                    .unwrap_or_default();
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\n{retry}Connection: close\r\n\r\n"
                )
                .unwrap();
            }
        });
        (format!("http://{address}"), bodies)
    }

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let seconds = reqwest::header::HeaderValue::from_static("7");
        assert_eq!(
            retry_after(Some(&seconds), now),
            Some(Duration::from_secs(7))
        );
        let date = reqwest::header::HeaderValue::from_str(&httpdate::fmt_http_date(
            now + Duration::from_secs(11),
        ))
        .unwrap();
        assert_eq!(retry_after(Some(&date), now), Some(Duration::from_secs(11)));
    }

    #[test]
    fn only_rate_limit_timeout_and_server_statuses_retry() {
        assert!(retryable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_status(reqwest::StatusCode::REQUEST_TIMEOUT));
        assert!(retryable_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(!retryable_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!retryable_status(reqwest::StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn rate_limit_retries_the_exact_prepared_bytes() {
        let (base, bodies) = response_server(vec!["429 Too Many Requests", "200 OK"]);
        let config = HitlConfig {
            ntfy_url: base,
            topic_id: "topic".into(),
            encryption_key: Some("11".repeat(32)),
            ..HitlConfig::default()
        };
        let client = http_client(Some(Duration::from_secs(2)), None);

        publish_message_with_client(&client, &config, "{\"messageId\":\"stable\"}", true)
            .await
            .unwrap();

        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0], bodies[1]);
    }

    #[tokio::test]
    async fn permanent_client_error_is_not_retried() {
        let (base, bodies) = response_server(vec!["400 Bad Request"]);
        let config = HitlConfig {
            ntfy_url: base,
            topic_id: "topic".into(),
            ..HitlConfig::default()
        };
        let client = http_client(Some(Duration::from_secs(2)), None);

        let error = publish_message_with_client(&client, &config, "{}", false)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("400"));
        assert_eq!(bodies.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn retry_after_larger_than_budget_is_not_retried_early() {
        let (base, bodies) =
            response_server_with_retry(vec![("429 Too Many Requests", Some("30"))]);
        let config = HitlConfig {
            ntfy_url: base,
            topic_id: "topic".into(),
            ..HitlConfig::default()
        };
        let client = http_client(Some(Duration::from_secs(2)), None);
        let started = tokio::time::Instant::now();

        let error = publish_message_with_client(&client, &config, "{}", false)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("after retries"));
        assert_eq!(bodies.lock().unwrap().len(), 1);
        assert!(started.elapsed() < Duration::from_secs(2));
        let limiter = limiter_for(&format!("{}/topic", config.ntfy_url));
        let state = limiter.state.lock().unwrap();
        assert_eq!(state.tokens, 0);
        assert!(state.cooldown_until > tokio::time::Instant::now());
    }
}
