# Appearance regression coverage

Light baselines were captured on Windows with Playwright's Chromium 145 at source
`72113bd4429b086db264135cef6c8c6efdd4de25`, before changing application styles.
Do not regenerate them to make a styling change pass. They cover question,
notification, standalone review, expired review, and Inbox question/notification/
handoff content. Default light and dark-then-light use the same images.
The new Appearance control is outside the existing content-pane baselines.
Other OSes need baselines captured from that original revision on their own
rendering stack, not snapshots captured from the modified UI.

`appearance.spec.ts` covers actual renderers, visible text contrast, native
bootstrap, draft/caret retention, review modes and combined highlights, default
and authored diagram palettes, and expanded diagram updates. Inbox's companion
suite covers the settings interaction, save failures, OS-dark with no preference,
shell status variants, and content renderers. The existing dialog, review,
notification, layout, pane, reply, and diagram suites protect unchanged behavior.

The contrast helper checks text against composited backgrounds and opacity.
It deliberately reports unsupported background images rather than counting them
as passes. SVG image labels and native chrome need visual checks in addition to
DOM text checks. Review disabled input text, placeholders, focus outlines,
image placeholders, and diagram controls at native display scaling.

Shared theme assets are authored in `client/src` and copied by
`scripts/sync-shared-ui.mjs`. The native adapter in `client/src-tauri/src/appearance.rs`
is compiled by both Tauri hosts using a path module; this avoids either a new
crate for one adapter or a Tauri dependency in the transport crate. Storage is
independently tested in `hitl-transport`.
