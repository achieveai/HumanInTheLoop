# LLM Inbox — Mobile (Android) Design

**Status:** approved 2026-08-21.
**Supersedes:** §13 of `2026-08-16-llm-inbox-design.md`, which was four steps and
a caveat. This is the design those four steps deferred.
**Depends on:** the LLM Inbox itself, complete as of `6d03490`.

## 1. Goal

Answer an agent from your phone.

The Inbox's premise is reaching you when you are away from the desk. Today that
works one way only: ntfy delivers a notification to your phone, and you walk to a
machine to reply. This closes the loop.

## 2. Scope

**Android only.** iOS is excluded by fact, not preference: Tauri requires the
full Xcode application, which is macOS-only. There is no cross-compilation path
and no WSL workaround. From a Windows workstation an iOS target cannot be built
or even initialised. If iOS is ever wanted it needs access to a Mac, and that is
a different project.

The phone is a **reader and responder**, not a listener. You open it to act.

### 2.1 Non-goals

- **Background delivery.** See §5.
- **Play Store distribution.** Personal sideload only.
- **Reaching the archivist from the phone.** §11 of the parent spec makes the
  archivist localhost-only; exposing it is a separate decision with its own auth
  design, and remains deferred.
- **A wire-protocol change.** No new message types, no `PROTOCOL_VERSION` bump.
  A phone is just another subscriber, exactly as §4.5 of the parent spec says.

## 3. Architecture

One codebase, two targets. No new crate. `inbox/` gains an Android target and
the same Rust and JavaScript run on both.

Three desktop assumptions become platform-conditional. They are the entire
structural change:

| Today | On Android |
|---|---|
| `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` in `main.rs` | desktop-only, behind `#[cfg(desktop)]` |
| config read from `~/.hitl/config.json` | app-private directory, written by a settings screen |
| `inbox.db` at `~/.hitl/inbox.db` | app-private directory |

Everything else ships unchanged. Specifically, **the race logic needs nothing**:
`MessageState::response_id` distinguishes "I won" from "somebody else did" by
comparing an id this device minted against the log's winner, and it does not care
whether the other device is a laptop or a phone. That property was built for a
second desktop app and mobile inherits it for free.

### 3.1 What Android takes away

Tauri does not support system tray, native menus, or global shortcuts on mobile.
The Inbox uses none of them — the tray belongs to `hitl-client`. Nothing to
remove.

Android uses the system WebView rather than a bundled one, so rendering depends
on whichever WebView the device has. Minimum target is API 26 (Android 8).

## 4. Responsive layout

Driven by a `data-layout` attribute on the root element, set from a `matchMedia`
observer. **Breakpoints are pane-count decisions, not device decisions** — a
half-width desktop window gets the tablet layout. This is deliberate: it is what
makes the mobile layout observable by resizing a window, and therefore what makes
it testable without a phone.

```
WIDE   ≥ 1100px
┌───────┐┌─────────┐┌────────────┐
│ agents││  list   ││   detail   │
└───────┘└─────────┘└────────────┘

TABLET   600 – 1100px          ☰ opens agents as an overlay
┌──────────┐┌────────────┐
│ ☰ list   ││   detail   │
└──────────┘└────────────┘

PHONE   < 600px                one pane, back-navigated
┌────────────┐      ┌────────────┐
│ ☰  list    │  →   │ ←  detail  │
└────────────┘      └────────────┘
```

Tablet keeps list and detail together because that is the pair you work in; the
agent tree is navigation, and navigation is what collapses first.

### 4.1 Two requirements this creates

**The Android back gesture must map to "back a pane."** Without it, back from the
detail view exits the application. This is correctness, not polish — on a phone,
back is the primary navigation control.

**Detail actions pin to the bottom at narrow widths.** Submit and Skip must not
sit below a long plan body. A reply you cannot reach is a reply you do not send.

### 4.2 Which pane is showing

Pane visibility is app state, not URL state. On phone, selecting a session shows
the list; selecting a message shows the detail. Widening the window back past a
breakpoint restores the multi-pane view with the same selection intact —
selection and layout are independent, and neither resets the other.

## 5. Delivery: the phone does not listen

**Finding that shapes this section:** a Tauri Android app's Rust backend does not
continue running when the app is backgrounded. This is confirmed by a Tauri
maintainer against exactly our pattern — a spawned async task emitting
notifications stopped firing on minimise, not on kill. Android's Doze and App
Standby suspend background network access outright.

Keeping a live ntfy subscription would therefore require an Android **foreground
service** with a permanent notification in the shade. That path was considered
and rejected:

- The available plugin is third-party, not from the Tauri organisation.
- Android 15 caps the `dataSync` service type at six cumulative hours.
- OEM battery managers kill such services regardless of correctness.
- ntfy has an open, unresolved report of battery drain in exactly this mode on
  cellular.

**Decision: no background service.** ntfy's own Android app remains the alerting
channel — it already delivers these notifications to the phone today. Our app is
what you open to read and reply.

This is a smaller app, with no permanent notification, no battery risk, and no
dependency whose maintenance we would have to vet.

### 5.1 On launch

Subscribe to ntfy, then catch up from its cache — the identical path the desktop
runs today. Archivist backfill is attempted and allowed to fail; on cellular it
always will, and §11 of the parent spec already requires every client to work
when the archivist is unreachable.

### 5.2 Stated limits

These belong in the spec so they are not discovered as bugs:

- **A closed app receives nothing.** By design.
- **History is ntfy's retention window only** — approximately 12 h of messages
  and 3 h of attachment bodies. Older plan bodies render `expired`, through the
  same renderer path the desktop already uses.
- **No tray, no menu, no global shortcut.**

## 6. Configuration and key entry

A settings screen accepts `topicId` and `encryptionKey` and writes them to
app-private storage.

`encryptionKey` is a 64-hex AES-256 key that decrypts every plan body and
question on the topic. Where it rests is the only genuine security decision in
this design.

**Decision: app-private storage, matching the desktop's posture.** Android
isolates per-app directories and the device's full-disk encryption covers them.
This is the same trust model as `~/.hitl/config.json`, which is protected by file
permissions alone — one story to reason about instead of two.

**The weakness, stated rather than left to be found:** a rooted device or a
device backup can read it. That is equally true of the desktop today.

Android Keystore wrapping and a biometric gate were considered. Both are
meaningfully stronger and both require a Kotlin/JNI path — the same native
surface avoided in §5. If the threat model changes, §6 is where to revisit.

### 6.1 Entering the key

Typed or pasted, once. No QR pairing, no transfer protocol. A pairing mechanism
would be a better experience and is the obvious later improvement, but it is a
design of its own and this spec does not attempt it.

## 7. Testing

**Layout — automated.** Playwright viewport tests at all three widths, asserting
which panes are present and that back navigation moves one pane rather than
exiting. The existing `inbox/tests/` suite already mounts renderers against real
stylesheets, so these are ordinary assertions in the existing harness.

**Android build — manual.** There is no automated device testing and this spec
does not pretend otherwise. Milestone 3's verification is: it installs, it
decrypts, it replies, and the reply settles on the desktop.

**The race, across devices — manual, and worth doing once explicitly.** Open the
same plan on desktop and phone, submit from both, and confirm one wins and the
other reports "Answered elsewhere" without discarding its draft. The fold is
already unit-tested for this; the point of doing it live is to confirm a phone is
genuinely just another subscriber.

## 8. Milestones

| # | Deliverable | Testable without a phone |
|---|---|---|
| 1 | Responsive layout — breakpoints, `☰` overlay, stacked navigation, pinned actions | Yes, fully |
| 2 | Platform-portable config and database paths | Yes — desktop suite must stay green |
| 3 | Android target, settings screen, signed sideload | No |

Milestone 1 delivers value on its own: a desktop window that works at any width.
Milestone 2 is a desktop-safe refactor that removes the `~/.hitl` assumption
without adding a platform. Only Milestone 3 requires the toolchain.

### 8.1 What Milestone 3 costs

- Android Studio, SDK, and NDK r28 or newer — roughly 30–50 GB.
- Rust targets: `aarch64-linux-android`, `armv7-linux-androideabi`,
  `i686-linux-android`, `x86_64-linux-android`.
- `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`. Builds run natively on Windows; WSL is
  not required.
- **A signing keystore that must be kept forever.** Android requires every update
  to carry the same certificate. Lose the keystore and the app cannot be updated
  in place, only reinstalled as a new package, losing local state. Generate once,
  back it up, use 25+ year validity.

Google's developer-verification rollout does not currently apply to direct
sideloading, but that policy is actively changing and should be re-checked before
Milestone 3 ships rather than assumed from this document.

## 9. Inherited constraints

From `2026-08-16-llm-inbox-design.md`, restated because this design must obey
them and a reader of this file alone would not know:

- **No wire-schema change, no `PROTOCOL_VERSION` bump** (§2, §5.3).
- **The archivist is an optimization, not a dependency** (§11). The phone is the
  strongest test of this rule, since it can never reach it.
- **Total order from ntfy, no arbiter** (§9.2). A phone computes the same winner
  as every other device from the same log.
- **Status is folded, never stored as authoritative state** (§4.2).
- **AES-256-GCM envelope** (§3). The phone holds the same key as every other
  device; it is not a new trust boundary, it is an additional holder of an
  existing secret.

## 10. Deliberately not decided here

- **QR or any other pairing mechanism.** §6.1.
- **Exposing the archivist beyond localhost**, which would give the phone real
  history. Its own auth design.
- **iOS.** Requires macOS.
- **Push delivery of any kind**, including a self-hosted Firebase project. §5.
