# Testrunde echtes Gerät — Motorola Edge 60 Pro + Samsung S22 Ultra (2026-09-11)

Branch `feat/mobile` (Spitze `f9db74d2`), App gegen den **lokalen Windows-Dev-Stack**
(`scripts/dev-local.mjs`, `PULSE_WEB_HOST=0.0.0.0`), WebView-URL via **`adb reverse`**
über USB (`tcp:5173/7880/8889/9000` → PC). Grund: die FRITZ!Box isoliert
WLAN-Geräte untereinander (Handy→PC `No route to host`, Handy→Router OK) —
Firewall-Regel „Pulse Dev Vite 5173" (TCP, eingehend) ist angelegt, löst das
Isolations-Problem aber nicht. WLAN-Tests (Bluetooth, reale Netze) folgen, sobald
die Box-Isolation aus ist (FRITZ!Box-UI: Heimnetz/Zugangsprofile bzw.
„verschiedene WLAN-Verbindungen isolieren").

## Start-Prozedur Windows-Dev-Stack (Windows, Git Bash)

Nach Rechner-Pause/Neustart ist ALLES down: Docker Desktop, Container,
Backends, Vite. Diese Reihenfolge hat sich bewährt:

1. **Docker Desktop starten** und auf den Daemon warten:
   `powershell -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"`,
   dann pollt man `docker info` (~10–60 s).
2. **Kompletten Stack hochfahren** (Container, Migrationen, 5 Backends,
   Vite, LiveKit, MediaMTX — ohne Electron):
   ```bash
   cd ~/Documents/pulse
   ABLAGE_ANHANG_MAX_BYTES=52428800 PULSE_WEB_HOST=0.0.0.0 \
     node scripts/dev-local.mjs --no-electron > .dev-local/logs/agent-start.log 2>&1 &
   ```
   ~80 s warten, dann Health-Check: `curl http://127.0.0.1:8001/health`
   (bis 8005), `curl http://127.0.0.1:5173/app` → 200.
   `ABLAGE_ANHANG_MAX_BYTES` hebt die DM-Anhang-Grenze auf 50 MiB
   (Video-Unterstützung, siehe B3); `PULSE_WEB_HOST=0.0.0.0` macht Vite im
   LAN sichtbar (für WLAN-Tests später).
3. **Vite kann SEPARAT sterben** (bash-cancel des Start-Skripts killt den
   Kind-Prozess mit). Neustart nur für Vite:
   ```bash
   cd web && PULSE_WEB_PORT=5173 PULSE_WEB_HOST=0.0.0.0 pnpm dev \
     > ../.dev-local/logs/vite-agent.log 2>&1 &
   ```
   Vorher alte PID auf 5173 killen (`netstat -ano | findstr :5173` →
   `taskkill //PID <pid> //T //F`), sonst hängt der alte Prozess noch.
4. **Samsung S22 Ultra** (Seriel `R5CT83QWY2Z`): USB-Debugging an, dann
   `adb -s <serial> reverse tcp:5173 tcp:5173` (+ 7880/8889/9000).
   Die Tunnels überleben einen App-Neustart, NICHT aber einen adb-Server-
   Neustart — nach Rechner-Pause neu setzen.
5. **Paraglide-Falle** (AGENTS.md): neue i18n-Keys erfordern
   `pnpm paraglide:compile` + Vite-Neustart (mit PID-Kill, s. Schritt 3).
   Laufende Vite-Instanz übernimmt neue Keys NICHT.

## Beteiligte Geräte

- **Motorola Edge 60 Pro** (Seriel `ZY22M4P3TH`): Konto `Dev.mobile`,
  dauerhaftes Gerät (Kamera + Mikrofon), fstest-App mit vollständiger
  Overlay-UI.
- **Samsung S22 Ultra** (Seriel `R5CT83QWY2Z`): Konto `bob`,
  dauerhaftes Gerät. Neuer Weg über `@capacitor/camera` (native
  Android-Kamera-Ansicht statt WebView-Video-Element — kein Grau-Blinken).
- **PC Pulse-Dev-Fenster** (Electron, Profil `Pulse-Dev`): Konto `bob`
  (Zweitgerät), separates Fenster neben der produktiven App.

## Testphasen (chronologisch)

1. **Motorola**: Registrierung, Freundschaftsanfrage, DM-Text, Mikrofon-
   Berechtigung, Video-Kamera-Overlay (Foto/Video-Modus, Front-Rück-
   Wechsel), Sprachaufnahme, Video-Entwurf mit Spulen + Ton-Schalter,
   Video-Entwurf mit Ton-aus → Tonlos-Neukodierung beim Senden.
2. **Samsung**: Registrierung als `bob`, Freundschaftsanfrage an
   `Dev.mobile`, DM-Text, Sprachnachricht, Video-Overlay (Foto/Video),
   Vorschau mit Ton-aus → Tonlos-Neukodierung beim Senden.

## Befunde

- **B1 — Chats-Empty-State verweist auf nicht vorhandenen Stift.**
  `chats_empty` (de/en, `web/messages/de.json:734`): „Tippe unten rechts auf den
  Stift…" — der „Stift" (`chats_compose`) liegt aber im **Drei-Punkte-Menü der
  Kopfzeile** (bewusste Entscheidung, siehe Kommentar in
  `MobileChatsList.svelte`). Fix: Text an das •••-Menü anpassen.
  — **erledigt (2026-09-23)**: Text verweist jetzt auf das Drei-Punkte-Menü
  oben rechts (de/en).
- **B2 — Konto-Wechsel-409 am echten Gerät reproduziert (bekannt aus
  Testrunde 2026-09-09, Übergabe §Testrunde).** Ablauf: Browser-Client richtete
  sich als `dev` ein (`PUT /keys/bundle` 204), dann Abmeldung + Anmeldung als
  `bob` im selben Browser → `PUT /keys/bundle` **409** (`geraet_gehoert_anderem_konto`,
  Log `.dev-local/logs/chat-gateway.log`), der Klient baut die Identität nicht
  neu auf — bob bleibt ohne Bündel, Composer am Partner-Gerät bleibt gesperrt
  („Du kannst nicht in diesen Chat schreiben"), keine sichtbare Anleitung im UI.
  Workaround heute: Website-Daten löschen → onboarding als neues Gerät.
  Fix-Ideen wie Übergabe: bei diesem 409 lokale Identität automatisch neu
  erzeugen oder sichtbaren „Als neues Gerät einrichten"-Weg anbieten.
  — **erledigt (2026-09-23), Wurzel enger als gedacht:** der
  Konto-Wechsel-Wächter (`auth.svelte.ts::_enforceDeviceOwner`) wischte
  Geheimnis, Kennung und Krypto-Zustand — aber NIE das Ed25519-Keypair
  (`pulse.keypair`), obwohl sein Kommentar genau das verspricht. Überlebte
  das Keypair, leitete `geraeteKennung()` die Kennung des VORGÄNGERS frisch
  her (Pubkey hat in `kennungWaehlen` Vorrang) → 409. Fix: `keypairStore.wipe()`
  in den Wisch-Block; der Issue-Flow läuft danach den normalen Erstlauf
  (Keypair erzeugen → Bündel veröffentlichen → kein 409, kein UI-Weg nötig).
  Begleitfund im selben Wisch: der Rueckfall-Schlüssel-Cache
  (`pulse.krypto-rueckfallschluessel`) ist kein Pickle und überlebte bisher
  ebenfalls — der Nachfolge-Account hätte den öffentlichen Halbteil des
  Vorgängers wieder veröffentlicht (Fallback-Nachrichten wären unlesbar
  angekommen); er wird jetzt mitgewischt (`geraeteGeheimnis.ts`).
- **B3 — Lese-Häkchen bleibt einfach, obwohl die Gegenstelle gelesen hat.
  Wurzel gefunden: dieselbe Nachricht trägt auf Sender und Empfänger
  VERSCHIEDENE IDs.** Ablauf: Handy sendet E2EE-DM (lokale ID
  `1789131259499624939`, 19-stellig, Einbauzeit 12:54:19.499 —
  `krypto/senden.ts::lokaleNachrichtId()`); der Server vergibt beim
  `POST /postfach` zusätzlich eine Server-Snowflake (17-stellig,
  91878994424635393 → dekodiert 12:54:19.300). Der EMPFÄNGER (bob, Electron)
  anchor't beim Chat-Öffnen seinen `PUT /dm-channels/{id}/lesestand` an die
  Server-Snowflake (`readState.markRead` → `latestByChannel`, und die
  empfangene Nachricht trägt dort die Umschlag-ID, nicht die innere
  Nutzlast-ID). Der Sender vergleicht nun Häkchen-seitig
  `istGelesenBis(partnerStand=…19.300, messageId=…19.499)` — gleiche
  Nachricht, 199 ms Auseinander, Vergleich sagt „neuer als der Stand" →
  Häkchen bleibt für immer einfach, auch nach Neuladen. Der Code kennt das
  Misch-ID-Problem sonst schon (`web/src/lib/utils/snowflakeZeit.ts`,
  Bughunt-Fund 1) — hier läuft es in die Lese-Bestätigung hinein.
  **Fix-Richtung:** Empfänger-Seite anchor't den Lesestand an die INNERE
  Nachrichten-ID aus der Nutzlast (`baueNachrichtNutzlast(klartext,
  nachrichtId, …)` — die fährt ohnehin verschlüsselt mit, dieselbe Kennung
  nutzt das Reply-to) ODER Sender übernimmt nach dem Senden die
  Server-ID in seinen Verlauf. Ersteres ist konsistenter: Sender- und
  Empfänger-Verlauf würden dasselbe ID-Schema je Nachricht führen.
  — **erledigt (2026-09-23), erste Fix-Richtung umgesetzt:** neue
  `lesestandAnker()` in `stores/lesestandKern.ts` — `krypto_id ?? id` —
  angewandt an den drei Anker-Stellen (Postfach-WS-Handler `chat.ts`,
  Chat-Öffnen `dmKanalWechsel.svelte.ts`, Häkchen-Prüfung
  `MessageItem.svelte`). Die Häkchen-Prüfung über den Anker deckt auch das
  eigene ZWEITgerät ab (dort liegt die Nachricht unter der Zustellungs-ID,
  `krypto_id` springt ein). Test: `test/lesestand-kern.test.ts` (mit den
  exakten IDs aus diesem Befund). **Live-Doppeltest am Gerät steht noch
  aus** — derselbe Vorbehalt wie bei den E2EE-Reaktionen damals.

## Bestätigt arbeitend (echtes Gerät, feat/mobile)

- Registrierung, Login, vier Tabs, Räume/Freunde/Chats-Leere-Zustände
- Freundschaftsanfrage (API-seitig gesendet): Badge am Freunde-Tab,
  ••• → „Ausstehend" → EINGEHEND mit Annehmen/Ablehnen ✓
- `dmSendeSperre`: Partner ohne App-Gerät → Composer gesperrt mit Schloss und
  klarer Meldung ✓ (Kamera/Mic/Anhang-Knöpfe sichtbar, Senden blockiert)
- Anruf-Knopf im DM-Kopf ✓, Archiv-Banner „Sicherung verbinden" im leeren DM ✓
- Geräte-Ersteinrichtung am Handy (dauerhaftes Gerät, `chat.device_key_bundles.dauerhaft = true`) ✓

## Noch offen in dieser Runde

E2EE-DM bidirektional, Reaktionen/Bearbeiten/Löschen, Sprachnachrichten,
Gruppen-UI, Anhänge/Medienübersicht, Anrufe (Audio/Video,
Klingeln, E2EE-Badge), FCM-Push (wartet auf Firebase-Service-Account-JSON),
Zurück-Taste/Share-Target/App-Links, Bluetooth, Offline, stiller 401.
B1–B3 sind im Code gefixt (2026-09-23) — die Doppelverifikation am echten
Gerät (Häkchen-Doppellauf, Konto-Wechsel dev→bob im selben Browser,
Chats-Empty-State-Text) steht noch aus.
