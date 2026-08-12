use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

use crate::crypto;
use crate::types::PlanPayloadRef;

/// Payload pipeline for the four plan-review message types ONLY — the mirror of
/// `server/src/payload.ts`.
///
///   plaintext   = base64( gzip( serde_json::to_string(body) ) )   // ASCII-safe
///   content_hash = sha256hex(plaintext)
///   cipher      = crypto::encrypt(plaintext, key)                 // existing envelope
///   kind        = cipher.len() <= PLAN_INLINE_THRESHOLD_BYTES ? inline : attachment
///
/// The base64 layer exists precisely so the shipping string-in/string-out crypto
/// works unchanged on gzip binary. No new crypto lives here.
///
/// The four shipping types (question / answer / notification /
/// dismiss_notification) must NOT go through this — they keep a byte-identical
/// wire format and stay wired to chunking.rs.

/// Ciphers at or under this size travel inline in the outer message; larger ones
/// become an ntfy attachment. Must match PLAN_INLINE_THRESHOLD_BYTES in
/// server/src/payload.ts.
pub const PLAN_INLINE_THRESHOLD_BYTES: usize = 2048;

/// Hard ceiling on what one payload may decompress to.
///
/// gzip reaches ~1000:1 on repetitive input, so an attachment of a few hundred
/// KB can expand to hundreds of MB. `read_to_string` on a `GzDecoder` grows its
/// buffer until the stream ends, so without a ceiling the decompressed size is
/// chosen by whoever produced the payload, not by us.
///
/// The server refuses plans over `PLAN_MAX_BYTES` (1 MB, `plan-file.ts`) and a
/// body carries at most a plan plus its diff, so 16 MB is roughly 8x the
/// largest legitimate payload — wide enough that no real plan is ever refused,
/// small enough that the worst case is a transient 16 MB allocation.
pub const MAX_DECOMPRESSED_BYTES: usize = 16 * 1024 * 1024;

/// Ceiling on the *compressed* size (raw gzip output, before base64) of a
/// plan-review response this client will attempt to submit.
///
/// Mirrors `PLAN_MAX_COMPRESSED_BYTES` in `server/src/payload.ts`, which the
/// server checks on the receiving end (`decodePayload`) against
/// `Buffer.from(plaintext, 'base64').byteLength` — the same quantity as
/// `gzipped.len()` here, before it is base64-encoded or encrypted. Checking
/// it here too means an oversized response is refused locally, before an
/// upload is spent on something the server is guaranteed to reject anyway.
/// Not derived from a shared source, and nothing enforces the two constants
/// staying equal — no build step or test compares the numeric values, only
/// this comment and the matching one in `payload.ts` name each other. A
/// divergence degrades to the pre-existing behaviour (the server rejects
/// what the client thought was small enough) rather than to corruption, so
/// this is deliberately not chased further; keep the two numbers equal by
/// hand when either changes.
pub const PLAN_MAX_COMPRESSED_BYTES: usize = 2 * 1024 * 1024;

/// Why a payload could not be turned back into its body.
///
/// Each variant maps to a distinct thing the review window must say. A hash
/// mismatch is a visible refusal and an expired attachment is "ask the agent to
/// resend" — neither may render as a blank window.
#[derive(Debug)]
pub enum PayloadError {
    /// The attachment is gone. ntfy keeps attachments 3 h but messages 12 h, so
    /// a perfectly valid message can outlive the body it points at.
    Expired,
    Decrypt(String),
    Base64(String),
    Gunzip(String),
    /// The payload decompresses to more than `MAX_DECOMPRESSED_BYTES`. Refused
    /// without ever holding the full expansion.
    TooLarge { limit: usize },
    HashMismatch { expected: String, actual: String },
    Json(String),
    /// The ref said `inline` but carried no `data`, or said `attachment` and
    /// nothing fetched it.
    MissingData,
    /// The body would compress past `PLAN_MAX_COMPRESSED_BYTES`. Refused
    /// before spending an upload on a response the server is guaranteed to
    /// reject. Encode-side only — `decode_payload` never produces this.
    TooLargeToSubmit,
}

impl std::fmt::Display for PayloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PayloadError::Expired => write!(f, "plan payload expired on the ntfy server"),
            PayloadError::Decrypt(e) => write!(f, "failed to decrypt plan payload: {e}"),
            PayloadError::Base64(e) => write!(f, "plan payload is not valid base64: {e}"),
            PayloadError::Gunzip(e) => write!(f, "failed to gunzip plan payload: {e}"),
            PayloadError::TooLarge { limit } => write!(
                f,
                "plan payload decompresses to more than the {limit}-byte limit"
            ),
            PayloadError::HashMismatch { expected, actual } => write!(
                f,
                "plan payload hash mismatch: expected {expected}, got {actual}"
            ),
            PayloadError::Json(e) => write!(f, "plan payload is not valid JSON: {e}"),
            PayloadError::MissingData => write!(f, "plan payload reference carries no data"),
            PayloadError::TooLargeToSubmit => write!(
                f,
                "Your feedback is too large to submit. Please shorten it and try again."
            ),
        }
    }
}

impl std::error::Error for PayloadError {}

/// The wire bytes plus the reference that describes them.
#[derive(Debug)]
pub struct EncodedPayload {
    /// Goes into the outer message's `body` field. `data` is populated only when
    /// `kind == "inline"`; for `"attachment"` the cipher travels as the PUT body.
    pub payload_ref: PlanPayloadRef,
    /// The encrypted-envelope JSON string, or — with no key configured — the
    /// bare base64(gzip(json)) plaintext.
    pub cipher: String,
}

/// sha256 hex of a utf-8 string.
pub fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Encode a plan-review body for the wire.
pub fn encode_payload<T: Serialize>(
    body: &T,
    key_hex: Option<&str>,
) -> Result<EncodedPayload, PayloadError> {
    let json = serde_json::to_string(body).map_err(|e| PayloadError::Json(e.to_string()))?;

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(json.as_bytes())
        .map_err(|e| PayloadError::Gunzip(e.to_string()))?;
    let gzipped = encoder
        .finish()
        .map_err(|e| PayloadError::Gunzip(e.to_string()))?;

    check_compressed_size(gzipped.len())?;

    let plaintext = BASE64.encode(&gzipped);
    let content_hash = sha256_hex(&plaintext);
    let content_length = plaintext.len() as u64;

    let cipher = match key_hex {
        Some(key) => crypto::encrypt(&plaintext, key).map_err(PayloadError::Decrypt)?,
        None => plaintext,
    };

    let inline = cipher.len() <= PLAN_INLINE_THRESHOLD_BYTES;
    Ok(EncodedPayload {
        payload_ref: PlanPayloadRef {
            kind: if inline { "inline" } else { "attachment" }.to_string(),
            data: if inline { Some(cipher.clone()) } else { None },
            content_hash,
            content_length,
        },
        cipher,
    })
}

/// Refuses a gzip output larger than `PLAN_MAX_COMPRESSED_BYTES` — the same
/// `>` comparison and the same quantity the server applies on decode, so a
/// body this accepts is never rejected on the other end for size, and a body
/// this refuses would have been rejected there too.
fn check_compressed_size(compressed_len: usize) -> Result<(), PayloadError> {
    if compressed_len > PLAN_MAX_COMPRESSED_BYTES {
        return Err(PayloadError::TooLargeToSubmit);
    }
    Ok(())
}

/// Inverse of `encode_payload`. `cipher` is `payload_ref.data` for an inline
/// payload, or the downloaded attachment bytes as a utf-8 string.
///
/// Verifies `expected_hash` before decompressing, so a truncated or tampered
/// body surfaces as a refusal rather than a half-rendered plan.
///
/// Decompression stops at `MAX_DECOMPRESSED_BYTES`. The hash covers the
/// *compressed* plaintext, so it says nothing about how far that expands — a
/// payload can hash correctly and still be a bomb.
pub fn decode_payload<T: DeserializeOwned>(
    cipher: &str,
    key_hex: Option<&str>,
    expected_hash: &str,
) -> Result<T, PayloadError> {
    let plaintext = match key_hex {
        Some(key) => {
            let value: serde_json::Value =
                serde_json::from_str(cipher).map_err(|e| PayloadError::Decrypt(e.to_string()))?;
            crypto::decrypt_value(&value, key).map_err(PayloadError::Decrypt)?
        }
        None => cipher.to_string(),
    };

    let actual_hash = sha256_hex(&plaintext);
    if actual_hash != expected_hash {
        return Err(PayloadError::HashMismatch {
            expected: expected_hash.to_string(),
            actual: actual_hash,
        });
    }

    let gzipped = BASE64
        .decode(plaintext.as_bytes())
        .map_err(|e| PayloadError::Base64(e.to_string()))?;

    // Read one byte past the ceiling: if it arrives, the payload is over the
    // limit and we refuse without ever having held the full expansion.
    let mut raw = Vec::new();
    GzDecoder::new(&gzipped[..])
        .take(MAX_DECOMPRESSED_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|e| PayloadError::Gunzip(e.to_string()))?;

    if raw.len() > MAX_DECOMPRESSED_BYTES {
        return Err(PayloadError::TooLarge {
            limit: MAX_DECOMPRESSED_BYTES,
        });
    }

    // Checked after the size test, so a bomb whose cut lands mid-character is
    // still reported as oversized rather than as invalid UTF-8.
    let json = String::from_utf8(raw).map_err(|e| PayloadError::Gunzip(e.to_string()))?;

    serde_json::from_str(&json).map_err(|e| PayloadError::Json(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{InlineComment, PlanReviewBody, PlanReviewResponseBody};

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const OTHER_KEY: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

    fn small_body() -> PlanReviewBody {
        PlanReviewBody {
            content: "# Plan\n\nhello\n".to_string(),
            diff: "@@ -0,0 +1 @@\n+hello\n".to_string(),
        }
    }

    /// Large and varied enough that the cipher lands over the inline threshold.
    fn big_body() -> PlanReviewBody {
        let words = ["plan", "review", "anchor", "revision", "diff", "snapshot", "verdict"];
        let mut seed: u64 = 7;
        let mut out = String::new();
        for _ in 0..4000 {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345) & 0x7fff_ffff;
            out.push_str(words[(seed % words.len() as u64) as usize]);
            out.push(' ');
        }
        PlanReviewBody { content: out.clone(), diff: out }
    }

    #[test]
    fn round_trips_a_body_through_gzip_base64_and_encryption() {
        let encoded = encode_payload(&small_body(), Some(KEY)).unwrap();
        let back: PlanReviewBody =
            decode_payload(&encoded.cipher, Some(KEY), &encoded.payload_ref.content_hash).unwrap();

        assert_eq!(back.content, small_body().content);
        assert_eq!(back.diff, small_body().diff);
    }

    #[test]
    fn round_trips_with_no_encryption_key() {
        let encoded = encode_payload(&small_body(), None).unwrap();
        let back: PlanReviewBody =
            decode_payload(&encoded.cipher, None, &encoded.payload_ref.content_hash).unwrap();

        assert_eq!(back.content, small_body().content);
        // With no key the cipher IS the plaintext, so the hash must match it.
        assert_eq!(encoded.payload_ref.content_hash, sha256_hex(&encoded.cipher));
    }

    #[test]
    fn preserves_crlf_and_lone_cr_verbatim() {
        let body = PlanReviewBody {
            content: "a\r\nb\rc\nd".to_string(),
            diff: String::new(),
        };
        let encoded = encode_payload(&body, Some(KEY)).unwrap();
        let back: PlanReviewBody =
            decode_payload(&encoded.cipher, Some(KEY), &encoded.payload_ref.content_hash).unwrap();

        assert_eq!(back.content, "a\r\nb\rc\nd");
    }

    #[test]
    fn keeps_a_small_body_inline_and_flips_past_the_threshold() {
        let small = encode_payload(&small_body(), Some(KEY)).unwrap();
        assert_eq!(small.payload_ref.kind, "inline");
        assert_eq!(small.payload_ref.data.as_deref(), Some(small.cipher.as_str()));
        assert!(small.cipher.len() <= PLAN_INLINE_THRESHOLD_BYTES);

        let big = encode_payload(&big_body(), Some(KEY)).unwrap();
        assert_eq!(big.payload_ref.kind, "attachment");
        assert!(big.payload_ref.data.is_none());
        assert!(big.cipher.len() > PLAN_INLINE_THRESHOLD_BYTES);
    }

    #[test]
    fn content_hash_is_lowercase_hex_over_the_plaintext() {
        let encoded = encode_payload(&small_body(), None).unwrap();

        assert_eq!(encoded.payload_ref.content_hash.len(), 64);
        assert!(encoded
            .payload_ref
            .content_hash
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_eq!(encoded.payload_ref.content_length, encoded.cipher.len() as u64);
    }

    #[test]
    fn refuses_a_wrong_key_instead_of_returning_an_empty_body() {
        let encoded = encode_payload(&small_body(), Some(KEY)).unwrap();
        let err = decode_payload::<PlanReviewBody>(
            &encoded.cipher,
            Some(OTHER_KEY),
            &encoded.payload_ref.content_hash,
        )
        .unwrap_err();

        assert!(matches!(err, PayloadError::Decrypt(_)), "{err}");
    }

    #[test]
    fn refuses_a_hash_mismatch() {
        let encoded = encode_payload(&small_body(), Some(KEY)).unwrap();
        let err =
            decode_payload::<PlanReviewBody>(&encoded.cipher, Some(KEY), &"0".repeat(64)).unwrap_err();

        assert!(matches!(err, PayloadError::HashMismatch { .. }), "{err}");
    }

    #[test]
    fn refuses_plaintext_that_is_not_gzip() {
        let not_gzip = BASE64.encode(b"definitely not gzip");
        let err =
            decode_payload::<PlanReviewBody>(&not_gzip, None, &sha256_hex(&not_gzip)).unwrap_err();

        assert!(matches!(err, PayloadError::Gunzip(_)), "{err}");
    }

    /// H4. The hash covers the *compressed* plaintext, so a payload can verify
    /// perfectly and still expand without bound — `read_to_string` on a
    /// `GzDecoder` grows until the stream ends. gzip reaches ~1000:1 on
    /// repetitive input, so a few KB on the wire was hundreds of MB in memory.
    #[test]
    fn refuses_a_payload_that_expands_past_the_ceiling() {
        let bomb = "a".repeat(MAX_DECOMPRESSED_BYTES + 1024);
        let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(bomb.as_bytes()).unwrap();
        let gzipped = encoder.finish().unwrap();

        let plaintext = BASE64.encode(&gzipped);
        assert!(
            plaintext.len() < 128 * 1024,
            "the bomb should be small on the wire, was {} bytes",
            plaintext.len()
        );

        // Hashes correctly — the refusal has to come from the size cap, not
        // from integrity checking.
        let err =
            decode_payload::<PlanReviewBody>(&plaintext, None, &sha256_hex(&plaintext)).unwrap_err();

        assert!(matches!(err, PayloadError::TooLarge { .. }), "{err}");
    }

    /// Pins the *reason* for the ceiling rather than the number: it has to stay
    /// clear of the largest body the server can legitimately produce, so
    /// tightening it fails here instead of turning real plans into refusals.
    #[test]
    fn the_decompression_ceiling_clears_the_largest_plan_the_server_can_send() {
        // server/src/plan-file.ts PLAN_MAX_BYTES.
        const PLAN_MAX_BYTES: usize = 1024 * 1024;
        // A body carries a plan plus its diff, and JSON escaping can roughly
        // double a pathological string.
        let worst_case_body = PLAN_MAX_BYTES * 2 * 2;

        assert!(
            MAX_DECOMPRESSED_BYTES >= worst_case_body * 2,
            "ceiling {} leaves no margin over a {}-byte worst-case body",
            MAX_DECOMPRESSED_BYTES,
            worst_case_body
        );
    }

    #[test]
    fn a_plan_at_the_servers_size_limit_still_round_trips() {
        let content = "# Plan\n".to_string() + &"a line of plan text\n".repeat(55_000);
        assert!(content.len() >= 1024 * 1024, "not actually a max-size plan");

        let body = PlanReviewBody {
            content: content.clone(),
            diff: String::new(),
        };
        let encoded = encode_payload(&body, Some(KEY)).unwrap();
        let back: PlanReviewBody =
            decode_payload(&encoded.cipher, Some(KEY), &encoded.payload_ref.content_hash).unwrap();

        assert_eq!(back.content, content);
    }

    // --- Pre-submit compressed-size cap (mirrors server's
    // PLAN_MAX_COMPRESSED_BYTES) ---
    //
    // `check_compressed_size` is exercised directly at the exact byte
    // boundary — precise and independent of gzip's compression ratio, which
    // an end-to-end test built from real body content could not pin exactly.
    // The two tests after it exercise the real pipeline through
    // `encode_payload` to prove the check is actually wired in, using
    // near-incompressible content so a large real body is guaranteed to
    // cross the ceiling rather than being compressed back under it.

    #[test]
    fn accepts_a_body_exactly_at_the_compressed_size_limit() {
        assert!(check_compressed_size(PLAN_MAX_COMPRESSED_BYTES).is_ok());
    }

    #[test]
    fn refuses_a_body_one_byte_over_the_compressed_size_limit() {
        let err = check_compressed_size(PLAN_MAX_COMPRESSED_BYTES + 1).unwrap_err();
        assert!(matches!(err, PayloadError::TooLargeToSubmit), "{err}");
    }

    /// Deterministic pseudo-random bytes, so gzip cannot meaningfully shrink
    /// them the way it does the repetitive text `big_body()` builds — needed
    /// so a large plaintext reliably produces a compressed output near its
    /// own size instead of collapsing under the limit.
    fn incompressible_string(byte_len: usize) -> String {
        let mut state: u64 = 0x243f_6a88_85a3_08d3; // arbitrary fixed seed
        let mut bytes = Vec::with_capacity(byte_len);
        while bytes.len() < byte_len {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            bytes.extend_from_slice(&state.to_le_bytes());
        }
        bytes.truncate(byte_len);
        BASE64.encode(&bytes)
    }

    #[test]
    fn refuses_to_encode_a_body_whose_compressed_size_exceeds_the_submit_limit() {
        let body = PlanReviewBody {
            content: incompressible_string(PLAN_MAX_COMPRESSED_BYTES + 512 * 1024),
            diff: String::new(),
        };

        let err = encode_payload(&body, None).unwrap_err();
        assert!(matches!(err, PayloadError::TooLargeToSubmit), "{err}");

        let message = err.to_string();
        assert!(
            message.to_lowercase().contains("too large"),
            "message should tell the human their feedback is too large: {message}"
        );
        assert!(
            message.to_lowercase().contains("shorten"),
            "message should tell the human to shorten it: {message}"
        );
        assert!(
            !message.to_lowercase().contains("compress"),
            "message should not leak server jargon about compressed bytes: {message}"
        );
    }

    #[test]
    fn encodes_a_real_sized_body_comfortably_under_the_submit_limit() {
        // A full-size legitimate review (biggest plan plus its diff) is well
        // clear of the 2 MiB ceiling; this is the ordinary case the check
        // must never get in the way of.
        let content = "# Plan\n".to_string() + &"a line of plan text\n".repeat(55_000);
        let body = PlanReviewBody {
            content: content.clone(),
            diff: String::new(),
        };

        let encoded = encode_payload(&body, None).unwrap();
        assert!(encoded.cipher.len() < PLAN_MAX_COMPRESSED_BYTES);
    }

    // --- Cross-language fixture: produced by TypeScript, decoded here ---

    #[derive(serde::Deserialize)]
    struct Fixture {
        #[serde(rename = "encryptionKey")]
        encryption_key: String,
        cases: Vec<FixtureCase>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureCase {
        name: String,
        encrypted: bool,
        body: serde_json::Value,
        #[serde(rename = "ref")]
        payload_ref: PlanPayloadRef,
        cipher: String,
    }

    fn load_fixture() -> Fixture {
        // Regenerate with: cd hitl-mcp-server/server && npm run fixture:payload
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/plan-payload.json");
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("cross-language fixture missing at {path}: {e}"));
        serde_json::from_str(&raw).expect("fixture must be valid JSON")
    }

    #[test]
    fn decodes_every_case_in_the_typescript_produced_fixture() {
        let fixture = load_fixture();
        assert_eq!(fixture.cases.len(), 4, "fixture lost cases");

        for case in &fixture.cases {
            let key = if case.encrypted {
                Some(fixture.encryption_key.as_str())
            } else {
                None
            };

            let decoded: serde_json::Value =
                decode_payload(&case.cipher, key, &case.payload_ref.content_hash)
                    .unwrap_or_else(|e| panic!("case '{}' failed to decode: {e}", case.name));

            assert_eq!(decoded, case.body, "case '{}' body mismatch", case.name);
            assert!(case.payload_ref.content_length > 0, "case '{}'", case.name);
            if !case.encrypted {
                // Unencrypted, the cipher IS the plaintext the hash covers.
                assert_eq!(case.payload_ref.content_length as usize, case.cipher.len());
                assert_eq!(case.payload_ref.content_hash, sha256_hex(&case.cipher));
            }
        }
    }

    #[test]
    fn agrees_with_typescript_on_where_the_inline_threshold_falls() {
        let fixture = load_fixture();

        for case in &fixture.cases {
            let expected = if case.cipher.len() <= PLAN_INLINE_THRESHOLD_BYTES {
                "inline"
            } else {
                "attachment"
            };
            assert_eq!(
                case.payload_ref.kind, expected,
                "case '{}' ({} cipher bytes) classified differently by the two languages",
                case.name,
                case.cipher.len()
            );
        }
    }

    #[test]
    fn decodes_a_typescript_produced_response_body_into_the_rust_struct() {
        let fixture = load_fixture();
        let case = fixture
            .cases
            .iter()
            .find(|c| c.name == "inline-plan-review-response-body")
            .expect("fixture must carry a response-body case");

        let body: PlanReviewResponseBody = decode_payload(
            &case.cipher,
            Some(fixture.encryption_key.as_str()),
            &case.payload_ref.content_hash,
        )
        .unwrap();

        assert_eq!(body.overall_feedback, "Mostly good. Two notes inline.");
        assert_eq!(body.inline_comments.len(), 3);
        let second: &InlineComment = &body.inline_comments[1];
        assert_eq!(second.start_line, 2);
        assert_eq!(second.end_line, 4);
        assert_eq!(second.side, "new");
        assert_eq!(body.inline_comments[2].side, "old");
    }

    #[test]
    fn decodes_a_typescript_produced_crlf_plan_body_without_normalizing() {
        let fixture = load_fixture();
        let case = fixture
            .cases
            .iter()
            .find(|c| c.name == "attachment-plan-review-body")
            .expect("fixture must carry an attachment case");

        let body: PlanReviewBody = decode_payload(
            &case.cipher,
            Some(fixture.encryption_key.as_str()),
            &case.payload_ref.content_hash,
        )
        .unwrap();

        assert!(body.content.starts_with("# Big plan\r\n\r\n"), "CRLF was rewritten");
        assert!(body.content.ends_with("\r\n"));
    }
}
