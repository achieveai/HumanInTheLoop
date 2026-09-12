# Vendored browser dependencies

## Diagram engines

- `mermaid.min.js`: Mermaid 12.0.0, upstream standalone `dist/mermaid.min.js`.
  MIT license in `mermaid.LICENSE.txt`.
  SHA-256: `28fca7ae6ebc7ed7bb63bde63136a74bfef14f296a57e403657eeb8b32836073`.
- `plantuml/`: official `@plantuml/core` 1.2026.8 (MIT, license retained).
  Includes the engine, Viz.js/Graphviz, themes, emoji and OpenIconic assets.
  Optional external sprite libraries and includes are not supported.
- Both packages were obtained using `npm pack` with the exact versions above.
  No CDN is contacted at runtime. Shared assets are copied into the Inbox by
  `scripts/sync-shared-ui.mjs`.

PlantUML's upstream engine is an ES module. Tauri serves CORS headers for the
app's origin, while the renderer iframe deliberately has an opaque sandbox
origin. Convert the engine to a classic script when updating it:

```sh
npx --yes --package esbuild@0.25.12 esbuild PATH_TO_EXTRACTED_PACKAGE/plantuml.js --format=iife --global-name=PlantUML --target=es2020 --outfile=client/src/vendor/plantuml/plantuml.js
```

Do not add `--minify`: esbuild's label renaming produced invalid JavaScript
for this TeaVM output. The non-minified wrapper passes `node --check` and
the browser tests. Engine SHA-256 after wrapping:
`4371e88392b21d7b5d395791d40ec1a63ad1e4fa2bfa6c8fb0b4de64f2dcb631`.

The sandbox uses classic scripts, no app APIs, and `connect-src 'none'`.
Graphviz needs `wasm-unsafe-eval` in the app CSP; JavaScript eval stays disabled.
SVG output is displayed as an image, never inserted into the app DOM.
Run `client/tests/diagrams.spec.ts` after changing either bundle: these tests
apply the shipping CSP and Tauri-style CORS headers instead of the permissive
development server defaults.

## jsdiff

- File: `diff.min.js`
- Upstream package: `diff` (jsdiff) 9.0.0 browser UMD build
- Upstream project: https://github.com/kpdecker/jsdiff
- License: BSD-3-Clause; retained in `diff.LICENSE.txt`
- SHA-256: `b51a9d2885f2c090dc97b981027395f7e7e6558a46c75ae3747db267913a89ab`
- Used API: `Diff.diffArrays` for bounded browser-side block alignment.

The server's `diff` 5.x dependency produces unified patch text; the browser
does not deserialize a version-specific jsdiff object. Compatibility is at the
documented unified-diff text boundary, while the vendored 9.x build is used
only for array alignment in the review UI.
