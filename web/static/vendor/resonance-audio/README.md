# Vendored: Resonance Audio (Web SDK)

`resonance-audio.min.js` is the UMD browser build of Google's
[Resonance Audio](https://github.com/resonance-audio/resonance-audio-web-sdk),
vendored here with **one deliberate patch** (see "HRIR patch" below).

- **Version:** 1.0.0 (npm `resonance-audio@1.0.0`)
- **License:** Apache-2.0 (see `LICENSE`)
- **Self-contained:** the bundle includes its only dependency (Omnitone) AND its
  8 HRIR ear-filters (`resources/*.wav`) — no external runtime dependency.

## HRIR patch (why this bundle is not verbatim)

The upstream bundle fetches its 8 HRTF ear-filters at runtime from a hardcoded
URL `https://raw.githubusercontent.com/GoogleChrome/omnitone/master/build/resources/`.
That path was **removed in the Omnitone repo restructure and now 404s** — so the
filters never loaded, leaving only crude L/R panning with no real binaural 3D.

Fix applied here:
- The 8 filters are vendored locally in `resources/` (fetched from
  `omnitone@1.0.6/build/resources/` — newer versions dropped them; the filenames
  match exactly).
- The dead base URL in `resonance-audio.min.js` is patched to the local path
  `/vendor/resonance-audio/resources/`.

Do **not** revert this to "verbatim" — that reintroduces the dead URL.

## Why vendored instead of an npm dependency

The upstream project is stable but no longer actively maintained. Vendoring the
build pins it, removes a runtime dependency on the npm registry, and lets us
lazy-load it as a static asset (`/vendor/resonance-audio/resonance-audio.min.js`)
only when a desktop user actually enables spatial audio — so it never weighs on
the main bundle.

The loader and the type surface we rely on live in
`web/src/lib/voice/spatial/`. To update, run `npm pack resonance-audio@<ver>`
and replace `resonance-audio.min.js` + `LICENSE` from the tarball's `build/`.
After replacing the bundle you MUST re-apply the HRIR patch above (re-point the
omnitone `build/resources/` URL to `/vendor/resonance-audio/resources/`) and
re-fetch the 8 `resources/*.wav` from `omnitone@1.0.6`, or 3D breaks again.
