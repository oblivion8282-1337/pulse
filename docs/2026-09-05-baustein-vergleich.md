# Baustein-Vergleich: Pulse-Eigenbau vs. fertige Lösungen im Netz

*Stand: 2026-09-05. Vollinventar des Codebestands + Web-Recherche (Chat/Voice-Architekturen, UI-Bausteine, Media/Desktop/Infra) via vier Recherche-Agenten.*

## 1. Inventar in Kurzform

Pulse ist zu ~90 % Eigenbau. Extern im Einsatz: SvelteKit/Svelte 5, shadcn-svelte/bits-ui, marked+DOMPurify, virtua, svelte-sonner, paraglide, livekit-client, MediaMTX, Electron, Capacitor, FastAPI/Postgres.

Große Eigenbau-Silos:

| Baustein | Umfang | Bemerkung |
|---|---|---|
| chat-gateway (services) | ~55k LOC | eigenes WS-Protokoll, Permissions-Engine, Presence, serverseitige Plugin-Sandbox |
| auth (services) | ~19k LOC | inkl. Instanz-Provisioning, Selfhost-Directory/Relay |
| krypto (web + Rust-Crate) | ~7k LOC + ~1k Rust | E2EE, Geräteverwaltung, X3DH-artiger "Pickel", Gruppen-E2EE |
| ablage (web) | ~7,7k LOC | Dropbox/GDrive/Archiv-Adapter, Sync-Queues, Backoff |
| ws-Gateway-Client (web) | ~4,5k LOC | Verbindungspool, Token-Erneuerung, Gap-Fill |
| remote/Fernsteuerung (web) | ~5,2k LOC | eigenes P2P-Protokoll, Zeigerbild-Verifikation |
| stream-Steuerung (web) | ~10,2k LOC | Sidecar-Management, Diagnose, Popup-Detach |
| Rust: HQ-Sidecars + Vulkan-Player | ~65k LOC | plattformeigenes Capture (PipePipe/WGC/ScreenCaptureKit), 10-bit/HDR-Player, WHIP-Client, Fernsteuerung |
| Settings/Admin-UI | ~18k LOC | 84 Settings-Dateien, 36 Admin-Dateien |
| verlauf (IndexedDB, ohne Dexie) | ~2k LOC | eigenes db.ts, Lückenfüllung, lokale Suche |
| permissions (web+shared) | ~1,4k+ LOC | Bitfield, Rollen, Kanal-Overwrites |
| Emoji-Picker + eigene emoji-data | ~630+ LOC | Eigenbau inkl. Datenhaltung |

## 2. Fertige Bausteine, die wir zumindest prüfen sollten

| Unser Eigenbau | Fertiger Baustein | Einschätzung |
|---|---|---|
| WS-Gateway-Client + Gap-Fill | **Centrifugo** (MIT, self-hostbar): Reconnect-Recovery über Offsets, Channel-ACLs, JWT-Auth, Client-Libs | Größter Einzelhebel. Nicht zwingend ersetzen, aber deren Recovery-/Offset-Modell ist exakt unser Gap-Fill-Problem — Blaupause |
| Datei-/Attachment-Speicher (media-svc) | **MinIO + presigned URLs** (+ tusd für Resumable) — Muster von Revolt `autumn`, matrix-media-repo, Rocket.Chat | Dünner Auth-Service bliebe unser; Storage-Vermögen (multipart, resume, CDN-URL) muss nicht selbst getragen werden |
| Emoji-Datenbank + Picker | **PicMo** oder **emoji-picker-element** (Nolan Lawson, Svelte-5, IndexedDB-cache) | Kleiner Gewinn — Emoji-Daten selbst aktuell halten ist Dauerkosten |
| RNNoise-Ferry-Worklet | LiveKit hat inzwischen **SDK-seitige Noise Cancellation**; sonst `jitsi/rnnoise-wasm` | Erst LiveKit-Feature prüfen, dann evtl. eigenen Worklet-Anteil streichen |
| Lightbox / DnD-Sortierung / QuickSwitcher | **PhotoSwipe** / **svelte-dnd-action** / **cmdk-sv** (shadcn-svelte-"Command") | Direkte Ersetzungen im eigenen Setup |
| Settings-Formularhandhabung | **sveltekit-superforms + Formsnap** | Muster für neue Panels, keine Retro-Migration |
| Markdown-Rendering | marked+DOMPurify behalten; **Shiki** für Code-Blöcke ergänzen | Add statt Ersatz |

## 3. Bestätigt richtig gelöst — die Welt macht's genauso

- **LiveKit (Voice-Rooms) + MediaMTX (1:n-Streaming)**: exakt die Aufteilung, die der SFU-Vergleich (LiveKit vs. mediasoup vs. Janus) empfiehlt. MediaMTX bewusst *nicht* für Multi-Party-Rooms — korrekt, es hat kein Room-Konzept.
- **virtua** für die Message-Liste: Svelte-Community-Empfehlung. Migrationskandidat nur bei jump-freiem Prepend-Problem: **TanStack Virtual** (dedizierte Chat-/End-Anchored-APIs + Svelte-5-Adapter).
- **Permissions als Bitfield + Channel-Overwrites**: kopiert das Discord-Schema; das baut jeder Klon selbst. Matrix' Power-Levels sind kein Vorbild (Discord-Bridges leiden darunter).
- **Docker-Compose als Distribution**: passt zur Größe. Coolify/Easypanel nehmen Compose-Dateien als Template an — billiger Sichtbarkeitsgewinn.

## 4. Muster, von denen wir lernen können (ohne Ersatz)

- **Zulip Event-System**: per-User-Event-Queue + `last_event_id`-Cursor + explizite Restart-Semantik nach Server-Reboot — das kopierfähigste Design für unseren Gateway (Python-Stack!). Matrix' Sliding Sync ist das ausgereiftere Gegenstück, für Single-Server ohne Federation Overkill.
- **Revolt-Architektur**: REST und WS-Fanout als getrennte Services mit RabbitMQ/Redis dazwischen (`delta`/`bonfire`) — Vorlage, falls der chat-gateway je gesplittet wird.
- **Offline-Queue**: Discord/Revolt-Standard ist Client-Outbox mit Nonce/Idempotency-Key pro Nachricht, Server dedupliziert. Prüfen, ob unser Composer das schon so macht.
- **Mobile Push**: FCM/APNs über kleines eigenes Gateway ist der übliche Weg; **ntfy/UnifiedPush als Opt-in** wäre Differenzierungsmerkmal für die Selfhost-Zielgruppe (Element macht genau das). iOS-Voice erzwingt PushKit+CallKit — dafür gibt's Capacitor-Plugins (`@capgo/capacitor-incoming-call-kit`).
- **Desktop**: nicht mid-project von Electron auf Tauri 2 wechseln (auch wenn Tauri Sidecars/Updater/Mobile in einem Stack kann). electron-updater mit signiertem `latest.yml` statt eigenem Updater-Code; **GlitchTip** (Sentry-kompatibel, leichtgewichtig, self-hosted) fürs Crash-Reporting.

## 5. Bewusst allein auf der Welt

- **Instanz-Kopplung/Federation**: Es gibt keinen leichten fertigen Baustein. Matrix-Federation ist projektgrößenändernd (State-Res!), ActivityPub/ATProto decken Chat+Voice nicht ab. Wichtig: **frp/WireGuard lösen Erreichbarkeit, nicht Federation.** Wenn die "Kopplung" echte Daten-Federation sein soll, braucht es ein signiertes Server-zu-Server-Protokoll (Matrix-Server-Keys als kleines Vorbild, ATProto zeigt: simpler append-only-Stream reicht als Start); frps ist nur der Transport darunter. Revolt hat Federation bewusst ausgelassen — gleiche YAGNI-Entscheidung.
- **Fernsteuerung, Gruppen-E2EE, HQ-Sidecars + Vulkan-Player**: dafür existiert nichts Fertiges — das ist unser eigentlicher Differenziator. Lektüre für die Krypto-Weiterentwicklung: SimpleX (Double-Ratchet, PQ).

## 6. Priorisierung (TL;DR)

1. **Centrifugo** (oder zumindest sein Recovery-Modell) für den Gateway — größter Hebel.
2. **MinIO + presigned** statt eigenem Attachment-Speicher.
3. Kleine UI-Ersetzungen: Emoji-Picker (PicMo/emoji-picker-element), Lightbox (PhotoSwipe), Command-Palette (cmdk-sv), ggf. LiveKit-Noise-Cancel statt eigenem RNNoise-Worklet.

Der Rest ist schon richtig gelöst oder bewusst Eigenbau, wo es nichts zu holen gibt.

## Quellen (Auswahl)

- Centrifugo: https://centrifugal.dev
- MinIO multipart/presigned: https://vsoch.github.io/2020/s3-minio-multipart-presigned-upload/ · tusd: https://github.com/tus/tusd
- Zulip events-system: https://zulip.readthedocs.io/en/9.2/subsystems/events-system.html · architecture: https://github.com/zulip/zulip/blob/main/docs/overview/architecture-overview.md
- Matrix Sliding Sync: https://matrix.org/blog/2024/11/14/moving-to-native-sliding-sync/
- Revolt-Nachfolger: https://github.com/stoatchat/stoatchat · https://github.com/MilcaoStudio/uprising-backend
- MediaMTX WebRTC (kein Room-Konzept): https://github.com/bluenviron/mediamtx/discussions/5386
- SFU-Vergleiche: https://trembit.com/blog/choosing-the-right-sfu-janus-vs-mediasoup-vs-livekit-for-telemedicine-platforms/ · https://www.forasoft.com/learn/video-streaming/articles-streaming/sfu-comparison-mediasoup-janus-livekit-jitsi
- virtua: https://www.npmjs.com/package/virtua · TanStack Virtual Chat: https://tanstack.com/virtual/latest/docs/chat
- PicMo: https://picmo.pizza/ · emoji-picker-element: https://github.com/nolanlawson/emoji-picker-element
- LiveKit Noise Cancellation: https://docs.livekit.io/transport/media/noise-cancellation/ · jitsi/rnnoise-wasm: https://github.com/jitsi/rnnoise-wasm
- cmdk-sv: https://www.cmdk-sv.com/ · PhotoSwipe: https://photoswipe.com/ · svelte-dnd-action: https://www.npmjs.com/package/svelte-dnd-action · superforms: https://superforms.rocks/ · Formsnap: https://formsnap.dev/
- UnifiedPush/ntfy: https://unifiedpush.org/users/distributors/ntfy/ · Element-UnifiedPush: https://docs.element.io/latest/element-support/element-androidios-client-settings/using-unified-push-and-ntfy-for-push-notifications/
- GlitchTip: https://glitchtip.com · Coolify: https://coolify.io · Easypanel: https://easypanel.io
- NetBird/Headscale als Tailscale-Alternativen: https://netbird.io · frp: https://github.com/fatedier/frp
- SimpleX PQ: https://simplex.chat/blog/20240314-simplex-chat-v5-6-quantum-resistance-signal-double-ratchet-algorithm.html
