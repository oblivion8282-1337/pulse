# Testrunde echtes Gerät — Motorola Edge 60 Pro (2026-09-11)

Branch `feat/mobile` (Spitze `f9db74d2`), App gegen den **lokalen Windows-Dev-Stack**
(`scripts/dev-local.mjs`, `PULSE_WEB_HOST=0.0.0.0`), WebView-URL via **`adb reverse`**
über USB (`tcp:5173/7880/8889/9000` → PC). Grund: die FRITZ!Box isoliert
WLAN-Geräte untereinander (Handy→PC `No route to host`, Handy→Router OK) —
Firewall-Regel „Pulse Dev Vite 5173" (TCP, eingehend) ist angelegt, löst das
Isolations-Problem aber nicht. WLAN-Tests (Bluetooth, reale Netze) folgen, sobald
die Box-Isolation aus ist (FRITZ!Box-UI: Heimnetz/Zugangsprofile bzw.
„verschiedene WLAN-Verbindungen isolieren").

Konten (lokale Wegwerf-DB): `Dev.mobile` (Handy), `bob` / `bob-dev-1234`
(Browser, via API registriert). Logs/Spuren: `.dev-local/logs/`.

## Befunde

- **B1 — Chats-Empty-State verweist auf nicht vorhandenen Stift.**
  `chats_empty` (de/en, `web/messages/de.json:734`): „Tippe unten rechts auf den
  Stift…" — der „Stift" (`chats_compose`) liegt aber im **Drei-Punkte-Menü der
  Kopfzeile** (bewusste Entscheidung, siehe Kommentar in
  `MobileChatsList.svelte`). Fix: Text an das •••-Menü anpassen.
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
Gruppen-UI, Anhänge/Medienübersicht, Lese-Häkchen, Anrufe (Audio/Video,
Klingeln, E2EE-Badge), FCM-Push (wartet auf Firebase-Service-Account-JSON),
Zurück-Taste/Share-Target/App-Links, Bluetooth, Offline, stiller 401.
