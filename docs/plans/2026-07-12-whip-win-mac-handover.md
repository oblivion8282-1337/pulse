# Handover: WHIP-Verifikation Windows + Mac (Stand 2026-07-12)

Übergabe an die Claude-Sessions auf dem **Windows-Rechner** und dem **Mac**, um
den WHIP-Port der HQ-Sidecars dort fertig zu verifizieren. Kontext + Backend:
`docs/plans/2026-07-12-whip-guest-publish.md`.

## Was bereits fertig und AUSGELIEFERT ist (nichts davon wiederholen)

- **Feature komplett live für Linux** (PR #177, gemergt 2026-07-12): Gäste auf
  App-gehosteten Instanzen streamen per WHIP (WebRTC-Ingest, NAT-lochbar wie
  WHEP). media-svc entscheidet das Protokoll server-seitig
  (`MEDIAMTX_PUSH_PROTOCOL=whip` im allinone; Owner bleibt RTMPS), Auth-Hook
  unverändert, allinone-Caddy hat eine `@mtxsession`-Route (WHIP-Session-URLs
  kommen präfixlos zurück). Linux-Rust-Sidecar (`pulse-linux-hq-sidecar`
  Commit `597b53a`) pusht WHIP, Flatpak-Pin gehoben, alle main-Workflows grün.
- **Win/Mac-Code ist geschrieben und committet** (Branch
  `feat/whip-win-mac-sidecar` → PR folgt/gemergt): `url_format_hint`
  http(s)→whip, Codec-Fallback →H.264 bei WHIP (der ffmpeg-8.1-WHIP-Muxer kann
  KEIN AV1/HEVC — auf Linux empirisch bewiesen), `ensure_muxer_available`-Guard
  (fehlender Muxer → klare Meldung), Windows zusätzlich: gemeinsamer
  `open_output`-Helper statt 3× dupliziertem Options-Block.
- **Auf Linux bereits bewiesen** (nicht erneut nötig): WHIP-Handshake/Push/
  Teardown gegen MediaMTX 1.19.1 (localhost + echtes Internet + Caddy-Prefix-
  Proxy), Opus-Audio im WHIP-Strom, NVENC-h264 über WHIP, RTMPS-Regression.
  Windows-Cross-Compile-Check (`cargo check --target x86_64-pc-windows-gnu`)
  ist grün; WHIP-Muxer in den vendored BtbN-DLLs per `strings` nachgewiesen.

## Offen: NUR die Laufzeit-Verifikation auf der jeweiligen Plattform

### Windows-Rechner

1. `git pull` (main muss den Win/Mac-WHIP-Commit enthalten).
2. Falls `streaming/win-hq-sidecar/ffmpeg-dist/n8.1-lgpl-shared/` fehlt:
   `scripts/fetch-ffmpeg.ps1` (zieht die vendored BtbN-Distribution vom VPS).
3. `cargo test` in `streaming/win-hq-sidecar/` (Unit-Suite muss grün sein).
4. **WHIP-Smoke** gegen ein Wegwerf-MediaMTX (Docker, `bluenviron/mediamtx:1.19.1`,
   Minimal-Config: `webrtc: yes`, `webrtcAddress: :8889`,
   `webrtcLocalUDPAddress: :8189`, `moq: no`, `paths: {all_others:}` — Vorbild:
   Linux-Sidecar-Repo `test/mediamtx.yml`):
   `cargo run --release --example encode_smoke -- http://127.0.0.1:8889/whipsmoke/whip ...`
   (argv-Konvention des Beispiels lokal prüfen — auf Linux war es
   `<url> <codec> <w> <h> <fps> <frames>`). Erwartung: WHIP-Handshake-Zeile,
   MediaMTX-Log `stream is available and online`, sauberer Dispose.
   Danach **RTMPS-Regression**: gleicher Lauf gegen `rtmps://…` (Test-Certs).
5. **Codec-Fallback sichtbar machen**: encode_smoke/Stream mit hevc/av1 auf die
   WHIP-URL → es muss die Fallback-Log-Zeile kommen und h264 gepusht werden.
6. Optional (voller Beweis): echter Stream aus der Pulse-Desktop-App gegen eine
   App-Host-Instanz als NICHT-Owner-Account.

### Mac

1. `git pull`, dann in `streaming/mac-hq-sidecar/`:
   **`cargo build --release` — der Mac-Code ist auf der Linux-Maschine NICHT
   kompiliert worden** (kein macOS-SDK). Compile-Fehler wären hier also
   erwartbar-möglich und sind zuerst zu fixen (Diff ist klein:
   `src/encode/mod.rs`).
2. `cargo test` (falls Suite vorhanden) + WHIP-Smoke wie oben:
   `cargo run --release --example encode_smoke -- http://127.0.0.1:8889/whipsmoke/whip …`
   gegen ein lokales Wegwerf-MediaMTX. Homebrew-ffmpeg muss ≥ 8.0 mit dem
   whip-Muxer sein (`ffmpeg -muxers | grep whip`); fehlt er, muss die klare
   Guard-Meldung („Muxer 'whip' fehlt…") erscheinen — das ist dann der
   Guard-Test, und ffmpeg ist zu aktualisieren.
3. RTMPS-Regression (encode_smoke gegen rtmps://) + hevc→h264-Fallback-Check
   (Mac bietet HEVC an — auf der WHIP-URL muss die Fallback-Zeile kommen).

## Falls etwas rot ist

- Fixes bitte auf einem frischen Branch von main (`fix/whip-<plattform>-…`),
  Konventionen wie immer (CLAUDE.md; Changelog nur bei user-facing Verhalten).
- Bei Muxer-/DTLS-Problemen: `ensure_muxer_available` liefert die Diagnose;
  ffmpeg-Build/DLLs prüfen (Windows: vendored Zip neu vom VPS; Mac: brew).

## Wichtige Konstanten (nicht neu erfinden)

- WHIP-URL-Form: `{MEDIAMTX_PUBLIC_BASE}/{pfad}/whip?token=…` — kommt fertig
  von media-svc; die Sidecars nutzen `push_url` verbatim.
- Muxer-Wahl NUR am URL-Schema (`http(s)://` → whip). RTMPS bleibt Default für
  Cloud + Owner; an dessen Optionen (`rw_timeout`, `tls_verify`) nichts ändern.
- WHIP-Codec-Realität (ffmpeg 8.1): nur H.264 + Opus. Fallback ist gewollt und
  geloggt — nicht „wegoptimieren".
