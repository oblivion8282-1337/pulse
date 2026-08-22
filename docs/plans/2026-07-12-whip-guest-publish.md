# WHIP-Publish für Gäste auf App-gehosteten Instanzen (2026-07-12)

> **ÜBERHOLT im entscheidenden Punkt: der Sendeweg ist ein anderer.**
> (Vermerkt 2026-08-04.)
>
> Dieses Blatt baut auf **ffmpegs WHIP-Muxer** auf und leitet daraus ab, dass
> AV1 nicht geht und auf H.264 zurückgefallen werden muss. Beide Sidecars
> haben inzwischen einen **eigenen WebRTC-Sendeweg** (`whip/` in
> `linux-hq-sidecar` und, seit 2026-08-04, in `win-hq-sidecar`) mit eigenem
> AV1-Paketierer. Der Rückfall auf H.264 entfällt damit.
>
> Der Grund war nicht AV1 allein, sondern der **Rückkanal**: ffmpegs Muxer
> reicht die Vollbild-Anforderung eines Zuschauers nicht an die Anwendung
> durch. Das war damals kein Komfortverlust, sondern der Ausschlag: ein
> Intra-Refresh-Strom hatte nach dem Start kein Vollbild mehr, ohne Anforderung
> kam niemand mehr ins Bild. (Die Betriebsart ist am 2026-08-21 entfallen; das
> Argument trägt unverändert weiter, weil der Vollbild-Abstand seit dem
> 2026-08-18 bei 60 s steht.)
>
> Was am Blatt gilt: die Token- und Berechtigungs-Seite (media-svc,
> chat-gateway, auth-hook). **Und der dort beschriebene Weg ist in Produktion
> weiterhin nicht startbar** — `protocol=whip` wird von media-svc und
> chat-gateway noch auf `^rtmp$` festgenagelt und endet mit 422.

## Problem

HQ-Streaming-Publish läuft heute ausschließlich über RTMPS (`rtmps://<host>:1936`) —
eine klassische TCP-Verbindung, die sich **nicht** durch NAT locht. Auf einer
App-gehosteten Heim-Instanz kann daher nur der Host selbst streamen (er pusht an
sein eigenes Gerät); Gäste prallen am Router ab. Zuschauen (WHEP/WebRTC) funktioniert
dagegen von überall, weil ICE das NAT durchlocht (Direktpfad, PR #172 bewiesen).

**Lösung: WHIP** — das Publish-Gegenstück zu WHEP. Gleiche WebRTC-Ebene, gleicher
ICE-Port (8189/udp), gleiche Lochung. MediaMTX kann WHIP-Ingest nativ (`webrtc: yes`
deckt beide Richtungen ab), der Auth-Hook ist protokoll-agnostisch (liest den Token
aus `password`/`token`/`query` — `routes.py:86-104` im auth-hook).

## Machbarkeit (verifiziert 2026-07-12)

- ffmpeg 8.1 (WHIP-Muxer) → MediaMTX 1.19.1 → WHEP-Reader: läuft auf localhost
  UND übers echte Internet durch Fritz!Box-NAT (Hetzner-Testkiste; remote candidate
  war die öffentliche Client-IP → Lochung bestätigt).
- `h264_nvenc` → WHIP: ok. **`av1_nvenc` → WHIP: FEHLT im ffmpeg-8.1-Muxer**
  (`Could not write header: Invalid argument`) → Sidecar braucht AV1→H.264-Fallback
  für WHIP-Ziele.
- Opus ist im Rust-Sidecar bereits der einzige Audio-Codec (libopus, 48 kHz stereo,
  20-ms-Frames) — exakt was WebRTC verlangt. Kein Audio-Umbau.

## Architektur-Entscheidung

**Der Server entscheidet das Protokoll, nicht der Client.** media-svc mintet die
`push_url`; der Sidecar benutzt sie verbatim und wählt den Muxer am URL-Schema
(`rtmp(s)://`→flv, `srt://`→mpegts, neu `http(s)://`→whip). Damit:

- **Null Änderungen** in Frontend, chat-gateway-Weiterleitung, desktop/sidecar.ts,
  Auth-Hook, MediaMTX-Config.
- Cloud (howispulse.com) und erreichbare Self-Hosts bleiben unverändert auf RTMPS
  (Default). Nur das allinone-Image (App-Hosting) setzt das neue Env auf `whip`.
- Der Client-Request behält sein `protocol="rtmp"`-Feld (Pattern `^rtmp$`) —
  es ist ab jetzt ein Wunsch, den der Server überstimmen darf; die Antwort
  (`push_protocol`, `push_url`) ist die Wahrheit.

## Änderungen

### 1. Rust-Sidecar (`~/Dokumente/Linux_Rust_Sidecar`, Branch `feat/whip-output`)

- `encode/mod.rs::url_format_hint`: `http://`/`https://` → `Some("whip")`.
  Die rtmps-spezifischen Optionen (`rw_timeout`, `tls_verify`) NICHT für WHIP setzen
  (der WHIP-Muxer macht sein eigenes I/O; `handshake_timeout`-Default 5 s reicht).
- `ops/start.rs`: Codec-Auflösung — wenn `push_url` ein WHIP-Ziel ist und
  `codec == "av1"`, Fallback auf `h264` + Log-Event (ffmpeg-8.1-WHIP kann kein AV1).
- `mux_writer.rs`: unverändert — der `avio_flush`-Aufruf ist bereits null-guarded
  (WHIP-Muxer hat kein `pb`), `write_trailer` schließt die WHIP-Session.
- Token-Redaction: `redact.rs` maskiert `token=` in Query-Strings bereits.
- CLAUDE.md: „WHIP out-of-scope"-Zeile ersetzen (User-Entscheid 2026-07-12).
- Tests: Unit-Tests für `url_format_hint`-WHIP-Zweig + AV1-Fallback-Logik.

### 2. media-svc (`services/media-svc`)

- `config.py`: neues Setting `mediamtx_push_protocol: str = "rtmp"`
  (Env `MEDIAMTX_PUSH_PROTOCOL`; erlaubt `rtmp` | `whip`).
- `routes.py::_push_url`: WHIP-Zweig — `f"{mediamtx_public_base}/{path}/whip?token={token}"`
  (spiegelt exakt die WHEP-URL-Konstruktion; auf dem allinone geht das durch
  dieselbe Caddy-Route `/whep/*` → :8889).
- Stream-Token-Mint: effektives Protokoll = Server-Setting (überstimmt den
  Client-Wunsch); landet in Redis-Record + Response (`push_protocol`).
- Tests: WHIP-URL-Mint (Setting umgestellt), RTMPS-Default-Regression.

### 3. allinone-Image (`infra/self-host`)

- `07-render-env.sh`: `MEDIAMTX_PUSH_PROTOCOL=whip` neben den bestehenden
  `MEDIAMTX_*`-Zeilen. (Publish-Signalisierung läuft dann über
  `https://<PULSE_HOSTNAME>/whep/<path>/whip?token=…` — Caddy-Route existiert.)

### 4. Doku

- `streaming/README.md`: WHIP als drittes Push-Protokoll dokumentieren.

## Bekannte Risiken / bewusst offen

- **Location-Header hinter Prefix-Proxy**: MediaMTX beantwortet den WHIP-POST mit
  einer Session-URL (Location). Hinter Caddys `/whep/*`-strip-prefix könnte die
  DELETE-Teardown-URL den Prefix verlieren → Session räumt erst per Timeout ab
  (nicht fatal, MediaMTX GC't tote Sessions). Wird im e2e-Test mit Prefix-Proxy
  gegengeprüft; falls kaputt: Caddy `header_up`-Rewrite nachziehen.
- **Win/Mac-Sidecars** (`streaming/{win,mac}-hq-sidecar/`): gleiche kleine
  `url_format_hint`-Änderung nötig, aber auf dieser Maschine nicht baubar/testbar
  → separater Folge-PR auf den jeweiligen Plattformen.
- **Python-GSR-Sidecar** kann kein WHIP (reicht die URL an das GSR-Binary durch).
  Auf App-Host-Instanzen brauchen Streamer also den Rust-Sidecar-Client (Flatpak
  ist seit 2026-07-11 darauf umgestellt).
- **AV1 über WHIP**: kommt ggf. mit späterem ffmpeg; bis dahin H.264-Fallback.

## Teststrategie

1. Sidecar-Unit-Tests (`cargo test`): url_format_hint, AV1-Fallback.
2. media-svc-pytest: WHIP-Mint + RTMPS-Regression.
3. e2e lokal: gebauter Sidecar → `start` mit WHIP-push_url gegen Wegwerf-MediaMTX
   (echter Portal-Start nicht nötig für URL/Muxer-Pfad: ffmpeg-CLI-Äquivalent +
   Header-Write-Test); RTMPS-Regression (bestehender Pfad unangetastet).
4. Prefix-Proxy-Test (Caddy-Simulation) für den Location-Header.
