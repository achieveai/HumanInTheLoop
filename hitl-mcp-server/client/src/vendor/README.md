# Vendored browser dependencies

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
