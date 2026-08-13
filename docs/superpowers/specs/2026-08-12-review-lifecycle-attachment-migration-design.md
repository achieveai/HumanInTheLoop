# Review lifecycle and attachment migration design

## Context

Live ReviewPlan testing exposed two lifecycle gaps: a successfully submitted review window stays open, and peer devices keep showing reviews completed elsewhere. The same test also confirmed ntfy attachments now work. Oversized legacy messages still use chunks, so the transport should migrate without breaking installed clients or cached messages.

## Decisions

- A server `plan_review_ack` with `status: received` is the only authoritative completion signal.
- Submitter shows success and closes after about one second.
- Peers show `Completed on <device>` and close after about two seconds.
- A peer stays open if its local draft could not be saved.
- Legacy chunk production migrates to attachments in phases. Chunk decoding remains during compatibility.

## Review completion correlation

A live `plan_review_response` is provisional because simultaneous submissions can lose the first-wins race. Each client temporarily correlates responses and acknowledgements by `reviewId` and `responseId`, tolerating either arrival order. Correlation entries expire after the existing 30-second acknowledgement window plus a small delivery margin; implementation uses one shared constant for the waiter and correlation cleanup.

When a correlated acknowledgement is `received`:

- The submitting command returns `received`, clears the persisted draft, renders the submitted verdict, and closes its window after about one second.
- Other clients emit a local `review-completed` event to the matching review window. It renders the completing device and closes after about two seconds.
- If draft persistence failed on a peer, that window does not close. It warns the human to copy unsaved comments.

`lost`, `unacknowledged`, rejected/losing acknowledgements, publish failures, and decode failures never close windows. Existing cache replay continues to suppress already-settled reviews without replaying stale completion popups.

## Phased oversized-message migration

Small legacy `question`, `answer`, `notification`, and `dismiss_notification` messages keep their frozen wire bytes. They do not gain `protocolVersion`.

Add a protocol-v2 `large_message` carrier. Its compressed, encrypted attachment contains one unchanged serialized legacy message plus integrity metadata. New clients decode the carrier and dispatch the inner message through the existing legacy handlers. This carrier applies only to the four frozen legacy types; it does not change the existing plan-family attachment mechanism.

### Phase A — compatibility

For an oversized legacy message, publish both:

1. The attachment-backed carrier.
2. The existing chunks as fallback.

New clients prefer the carrier and deduplicate the fallback by original `messageId`. Old clients ignore the unknown carrier and consume chunks. New clients retain chunk decoding for old servers and cached traffic.

### Phase B — attachment first

Stop producing chunks by default. Retain a deployment-level configuration flag that dual-publishes chunks for installations that still have old clients. Keep chunk decoding. Missing or expired attachments show a resend-required state rather than silently dropping the message.

### Phase C — later major release

Remove the chunk producer. Remove the decoder only after supported old servers and cached chunk traffic are outside the compatibility window.

## Error handling

- Attachment upload failure is explicit; never publish an oversized inline body.
- Existing compressed and decompressed size limits remain enforced.
- Attachment expiry is distinguishable from malformed, corrupt, or unsupported payloads.
- Only a correlated winning acknowledgement closes windows.
- A submitter's draft-clear failure is distinct from a peer's draft-save failure: it is shown, but does not reverse confirmed server receipt or delay the submitter's one-second close.
- Offline clients rely on cache settlement filtering and do not reopen completed work.

## Verification

Automated coverage includes:

- Response-before-ack and ack-before-response correlation.
- Duplicate, stale, and losing events.
- Submitter and peer close timing.
- Failed-draft peer preservation.
- Settled cache entries not reopening windows.
- New carrier decoding and old chunk decoding.
- Dual-delivery deduplication.
- Old-client fallback publication.
- Visible attachment expiry.
- Mutation checks proving a losing ack cannot close windows and removing fallback breaks compatibility.

Live verification uses two desktop clients on the same topic:

1. Complete a review on one device and observe both close with the selected timing.
2. Repeat with forced peer draft-save failure and confirm it remains open.
3. Exercise oversized question, answer, notification, and dismiss payloads through the Phase A compatibility path.
