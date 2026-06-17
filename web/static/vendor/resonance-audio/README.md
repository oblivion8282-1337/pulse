# Vendored: Resonance Audio (Web SDK)

`resonance-audio.min.js` is the UMD browser build of Google's
[Resonance Audio](https://github.com/resonance-audio/resonance-audio-web-sdk),
vendored here verbatim (no modifications).

- **Version:** 1.0.0 (npm `resonance-audio@1.0.0`)
- **License:** Apache-2.0 (see `LICENSE`)
- **Self-contained:** the bundle includes its only dependency (Omnitone) — no
  external runtime dependency.

## Why vendored instead of an npm dependency

The upstream project is stable but no longer actively maintained. Vendoring the
build pins it, removes a runtime dependency on the npm registry, and lets us
lazy-load it as a static asset (`/vendor/resonance-audio/resonance-audio.min.js`)
only when a desktop user actually enables spatial audio — so it never weighs on
the main bundle.

The loader and the type surface we rely on live in
`web/src/lib/voice/spatial/`. To update, run `npm pack resonance-audio@<ver>`
and replace `resonance-audio.min.js` + `LICENSE` from the tarball's `build/`.
