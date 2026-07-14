# macOS-Build in CI — Recherche & Handoff (2026-07-14)

## Warum diese Notiz
Wir wollten einen GitHub-Actions-Workflow (`mac-build.yml`) einrichten, der das
Mac-DMG **automatisch** baut (Stufe 1: unsigniert, gratis), damit die Mac-Version
nicht mehr veraltet. Beim Vorbereiten kam heraus: der Mac-HQ-Streaming-Sidecar
linkt gegen eine **selbstgebaute FFmpeg-Version** (nicht Homebrew). Michael will
das prüfen und vom Mac aus weitermachen. Diese Notiz fasst den Stand zusammen,
damit man auf dem Mac direkt weiterarbeiten kann.

## Ausgangslage
- Verteiltes Mac-DMG auf dem Server: `~/pulse/downloads/Pulse-latest.dmg`,
  Stand **2026-06-16** (~1 Monat alt). Aktuelle Desktop-Version: **0.1.34**.
- Mac hat **kein CI-Build**, **keinen Auto-Update-Feed**, **keinen Auto-Updater**
  (`desktop/electron/updater.ts`: macOS = unsigniertes DMG, manueller Download).
  Gebaut wird manuell via `pnpm --filter @dcc/desktop dist:mac`, hochgeladen per
  `scp` nach `~/pulse/downloads/Pulse-latest.dmg`.
- Web/UI ist auf dem Mac trotzdem aktuell (die App lädt die Web-App **remote** von
  howispulse.com). Nur die **native Schale** (Electron/Chromium, Voice-DTX-Fix,
  HQ-Sidecar) ist alt. Für Alltag + die App-Hosting-Parkung (PR #188) sind
  Mac-Nutzer also versorgt; es fehlen native Verbesserungen.

## Der Knackpunkt: selbstgebaute FFmpeg (zu prüfen)
`streaming/mac-hq-sidecar/.cargo/config.toml`:
```
PKG_CONFIG_PATH = "/Users/michael/src/ffmpeg-openssl/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig:/opt/homebrew/opt/opus/lib/pkgconfig"
```
Der Rust-Sidecar (`ffmpeg-next`) linkt gegen eine **private FFmpeg 8.0.1** unter
`~/src/ffmpeg-openssl`, gebaut von `streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh`.

**Warum nicht Homebrew-FFmpeg** (laut `build-ffmpeg.sh` + `.cargo/config.toml`):
1. **TLS**: Homebrew-FFmpeg linkt Apple **SecureTransport**, das bei RTMPS-Bulk-
   Writes nach dem Handshake blockiert → MediaMTX droppt den Publish nach 10 s
   I/O-Timeout (der ursprüngliche „macOS-HQ-Stream startet nie"-Fehler). Der eigene
   Build nutzt `--enable-openssl --disable-securetransport` → RTMPS funktioniert.
2. **Lizenz**: Homebrews Build ist **GPL** (x264/x265). Dieser Build ist **LGPL**
   (VideoToolbox macht den H.264/HEVC-Encode, kein x264/x265) — nur LGPL ist mit
   gebündelten Dylibs redistributierbar.

→ Das ist eine bewusste, begründete Entscheidung, kein Versehen. Genau das war zu
prüfen.

**Zum Nachvollziehen auf dem Mac:**
- `streaming/mac-hq-sidecar/scripts/build-ffmpeg.sh` (Gründe im Kopf + configure-Flags)
- `streaming/mac-hq-sidecar/.cargo/config.toml` (der Pfad)
- `streaming/mac-hq-sidecar/README.md`, Abschnitt „FFmpeg (NOT Homebrew's)"
- Voll-Plan der Mac-Client-Etappe: `docs/plans/2026-06-15-macos-client.md`

## Was einen trivialen CI-Build blockiert
1. **Hardcodierter Pfad**: `.cargo/config.toml` zeigt auf `/Users/michael/src/...`.
   Auf einem GitHub-Runner ist Home `/Users/runner/...` → der Pfad existiert nicht.
   In CI muss `PKG_CONFIG_PATH` überschrieben werden (per Env im Workflow) oder
   `build-ffmpeg.sh` mit `PREFIX=…` runner-relativ gebaut + `config.toml` passend
   gemacht werden.
2. **FFmpeg-Build ist schwer**: `build-ffmpeg.sh` kompiliert FFmpeg 8.0.1 aus dem
   Quelltext (`make -j`) → Erstlauf ~15+ Min. Braucht **Xcode CLT** + Homebrew
   **`openssl@3`** + **`opus`**. In CI cachen (analog zum FFmpeg-Cache im
   `win-build.yml`).
3. Danach: `cargo build --release` → `scripts/bundle-dylibs.sh` (rewrite
   `@loader_path`) → `electron-builder --mac`.

## Zwei Wege für den CI-Build
- **A) FFmpeg in CI bauen + cachen** — self-contained, kein extra Hosting. Erstlauf
  langsam, dann Cache-Treffer. Empfehlung (analog FFmpeg-Cache im win-build).
- **B) FFmpeg-Dist einmal bauen, auf dem VPS hosten, in CI ziehen** — genau wie
  Windows (`streaming/win-hq-sidecar/scripts/fetch-ffmpeg.ps1` zieht eine
  eingefrorene Kopie vom VPS). Sauberer/schneller, aber die Dist muss man einmal
  von Hand bauen + hochladen.

## Schon entschieden (aus der Session 2026-07-14)
- **Stufe 1**: unsigniert, gratis (Repo ist **public** → macOS-Runner kostenlos).
  Signierung/Notarisierung = späterer, kostenpflichtiger Schritt (Apple Developer
  99 $/Jahr). Die Vorbereitungen dafür stehen in `desktop/electron-builder.yml`
  auskommentiert unter „Stufe B" (hardenedRuntime/entitlements/notarize/publish).
- **Podman-Bündelung fürs App-Hosting entfernen** (App-Hosting geparkt, PR #188):
  analog zu Windows den `resources-podman-mac`-`extraResources`-Block in
  `desktop/electron-builder.yml` (mac-Sektion) + `bash scripts/fetch-mac-podman.sh`
  aus dem `dist:mac`-Script in `desktop/package.json` entfernen.
  **NOCH NICHT gemacht** (bewusst pausiert für die Mac-Prüfung).
- **Upload-Ziel**: das versionierte `Pulse-${version}-${arch}.dmg` per `scp` nach
  `michael@159.195.150.54:~/pulse/downloads/Pulse-latest.dmg` (matcht `MAC_DMG_URL`
  in `web/src/lib/downloads/appDownloads.ts`). Gleiche VPS-SSH-Secrets wie
  `win-build.yml`/`flatpak.yml` (`VPS_SSH_PRIVATE_KEY`, `VPS_KNOWN_HOSTS`).

## Nächste Schritte (auf dem Mac)
1. Custom-FFmpeg-Entscheidung prüfen (Abschnitt oben) — passt sie so, oder soll der
   Sidecar-Build anders aufgesetzt werden?
2. `mac-build.yml` schreiben (Weg A oder B), Runner `macos-latest` (Apple Silicon,
   arm64), Trigger auf `desktop/**` + `streaming/mac-hq-sidecar/**` +
   `.github/workflows/mac-build.yml`, `workflow_dispatch`. Struktur analog
   `.github/workflows/win-build.yml` (SSH-Setup + scp + `if: github.ref ==
   'refs/heads/main'`).
3. Podman-Bündelung raus (wie oben, wie bei Windows).
4. Nach dem Merge auf `main` verifizieren — der Mac-Workflow läuft (wie win/flatpak)
   **nur auf main**, ist also erst nach dem Merge sichtbar.

## Referenz-Dateien (Kurzindex)
- `desktop/package.json` — Script `dist:mac`, `bundle:mac-sidecar`, `build:electron`
- `desktop/electron-builder.yml` — mac-Sektion (Z. ~168–205): targets dmg+zip,
  extraResources (hq-sidecar + resources-podman-mac), Stufe-B-Kommentar
- `desktop/electron/updater.ts` — macOS-Update-Verhalten (unsigniert, Download)
- `streaming/mac-hq-sidecar/` — Rust-Sidecar, `scripts/build-ffmpeg.sh`,
  `scripts/bundle-dylibs.sh`, `.cargo/config.toml`, `README.md`
- `web/src/lib/downloads/appDownloads.ts` — `MAC_DMG_URL`
- `docs/plans/2026-06-15-macos-client.md` — Mac-Client-Gesamtplan (Stufe A/B)
