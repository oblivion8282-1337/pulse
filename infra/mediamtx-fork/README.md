# Pulse fork of MediaMTX

A patched MediaMTX image, built as a multi-stage Dockerfile, published to
`ghcr.io/oblivion8282-1337/pulse-mediamtx:<tag>`, consumed by both
`streaming/server/docker-compose.yml` (dev) and `infra/prod/docker-compose.yml`
(prod).

## What it does

**Six patches, in two groups.** The Dockerfile header carries the full
rationale for each; this is the map.

`patches/` — applied to the MediaMTX source right after clone:

| Patch | What it does |
|---|---|
| `0001-rtmp-inject-temporal-delimiter` | prepends an `OBU_TEMPORAL_DELIMITER` to every AV1 temporal unit coming in over RTMP. AMD VAAPI doesn't emit them, NVENC does, and libwebrtc's RTP-AV1 receiver relies on them to find frame boundaries. |
| `0002-forward-viewer-keyframe-requests` | lets a viewer's key-frame request reach the publisher, and makes the hardwired 2 s key-frame ticker switchable (`PULSE_KEYFRAME_INTERVAL`). |
| `0003-flexfec-on-whep` | generates FlexFEC parity on the WHEP sending side (`PULSE_FLEXFEC=1`, media:parity via `PULSE_FLEXFEC_MEDIA`/`_FEC`). |
| `0004-flexfec-adaptiv` | drives that parity off the incoming NACK instead of paying it unconditionally (`PULSE_FLEXFEC_ADAPTIV=1`). |
| `0006-bildmarke-durchreichen` | carries the AV1 Dependency Descriptor (a running frame number) across MediaMTX's re-packetisation, so a viewer can tell a *lost* frame from one the sender never produced (`PULSE_DEPENDENCY_DESCRIPTOR=1`). |

`patches-vendor/` — applied to vendored third-party code, after `go mod vendor`:

| Patch | What it does |
|---|---|
| `0005-flexfec-nachlieferungen-nicht-puffern` | keeps NACK retransmissions out of pion's parity buffer; a single one otherwise left the whole group unprotected. |

**Every one of 0002-0006 is off unless its environment variable is set.** An
un-configured deployment behaves exactly like upstream plus 0001.

> **Dieser Abschnitt beschrieb den Fork bis 2026-08-04 als „minimal" mit genau
> einem Patch**, und den Abschnitt darunter als offene Frage („Experimentelles
> gehört nach `hq-labor/`"). Beides ist überholt: Commit `32992c4e` (2026-08-02)
> hat Vollbild-Weiterleitung und FlexFEC ausdrücklich aus dem Labor in den
> ausgelieferten Weg geschoben. Die Kopien unter
> `streaming/hq-labor/mediamtx-patches/` sind seither der Arbeitsstand des
> Messstands, nicht mehr die Warteschlange davor.

## Was hier NICHT hineingehört

Dieses Verzeichnis ist ein Auslieferungspfad, kein Ablageort. Das Dockerfile
wendet **jeden** Patch in `patches/` an, und der Workflow baut daraus das Image,
das Produktion pinnt.

**Seit 2026-08-04 steht der Patch-Stand im Tag** (`PULSE_REVISION` im
Dockerfile → `1.19.1-pulse4`). Hier stand vorher, ein Patch lande „in Produktion
— ohne Versionswechsel und ohne dass man es am Tag ablesen könnte". Genau das
ist jetzt behoben: wer den Satz ändert, ändert den Tag mit, das alte Image
bleibt in der Registry stehen, und ein Rückweg ist eine Zeile in der
Compose-Datei statt eines Neubaus.

**Der Austausch bleibt trotzdem ein bewusster Schritt.** MediaMTX gehört nicht
zu den Diensten, die der Cron-Updater anfasst (nur die App-Images) — es passiert
erst etwas bei einem `docker compose pull mediamtx && up -d`. Und **das
unterbricht jeden laufenden Stream**: Sender wie Zuschauer verlieren die
Verbindung, und ein automatischer Neustart greift nicht (den gibt es nur bei
einer Auflösungsänderung der Quelle). Vorher in der MediaMTX-API nachsehen, ob
gerade jemand streamt, kostet nichts.

Für alles **Experimentelle** gilt weiterhin: das gehört nach
`streaming/hq-labor/mediamtx-patches/`, wo kein Workflow es anfasst und der
Testserver von Hand versorgt wird.

## How it gets built and shipped

`.github/workflows/mediamtx-fork.yml` rebuilds the image when anything under
`infra/mediamtx-fork/` changes on `main`. It pushes two tags to GHCR:

- `ghcr.io/oblivion8282-1337/pulse-mediamtx:<MEDIAMTX_VERSION>-pulse<PULSE_REVISION>` — version pin, derzeit `1.19.1-pulse6` (MediaMTX-Fassung + unser Patch-Stand, beides als `ARG` im Dockerfile — der Workflow liest sie von dort, hier steht nur eine Abschrift)
- `ghcr.io/oblivion8282-1337/pulse-mediamtx:latest`        — rolling

Both compose files reference the version-pinned tag. The labels include
`com.centurylinklabs.watchtower.enable=false` so Watchtower never silently
swaps it out — every bump is a deliberate compose edit.

## When to remove this fork

Drop the patch + revert the compose files to upstream `bluenviron/mediamtx:<v>`
as soon as **one** of these is true:

1. MediaMTX upstream applies the same workaround (the patch is 3 lines, the
   bug is well-localized — when filed upstream it should land quickly).
2. AMD's Mesa VAAPI AV1 encoder starts emitting Temporal Delimiter OBUs by
   default.
3. Chromium's libwebrtc RTP-AV1 receiver stops relying on them for frame-
   boundary detection.

Verify the cause of the original symptom is gone by running the
"Diagnose-Aufnahme senden" workflow from an AMD-GPU machine, then watching
the WHEP receiver's RTCInboundRtpStreamStats — if `framesDecoded` keeps
pace with `framesReceived`, the fork is no longer needed.

## Bumping MediaMTX

```sh
cd infra/mediamtx-fork
# Edit Dockerfile: MEDIAMTX_VERSION=<new>
# Verify the patch still applies cleanly against the new tag:
git clone --depth=1 -b v<new> https://github.com/bluenviron/mediamtx.git /tmp/mediamtx-check
# EVERY patch, not just 0001 — there are four here plus one vendored.
( cd /tmp/mediamtx-check && for p in ../patches/*.patch; do patch -p1 --dry-run < "$p"; done )
# If one fails to apply, rebase that patch against the new line numbers.
#
# `patches-vendor/0005-*` can only be checked AFTER `go mod vendor` (it goes
# against pion's FlexFEC interceptor, not against the MediaMTX source), so the
# Docker build is the first place it is verified. Expect that step to be the
# one that breaks on a pion bump.
```

Then commit; the workflow rebuilds and pushes the new image, and you update
the `image:` tag in both compose files to match.
