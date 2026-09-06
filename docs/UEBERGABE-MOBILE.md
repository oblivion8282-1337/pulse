# Übergabe: Pulse Mobile — Android zuerst, danach iOS

> Stand: 2026-09-06 · Branch `feat/mobile` (Basis: main `06983a19`) · Autor: Michael + ZCode-Analyse
>
> Dieses Dokument ist bewusst **self-contained**: Es soll einer Person, die das Projekt
> neu übernimmt — und deren KI-Assistent — den kompletten Kontext geben, ohne dass
> Gesprächsverlauf oder alte Branches nötig sind. Alle Pfade sind repo-relativ.

---

## 1. Produktziel

Pulse ist eine Chat- und Community-Plattform (Web + Desktop + Mobile) mit
**Ende-zu-Ende-verschlüsselten Direktnachrichten per Default**. Die Mobile-App folgt
einem **chat-first**-Design: Sie soll sich wie ein Messenger (WhatsApp-Prinzip)
anfühlen, nicht wie ein „Discord-Klon". Konkret:

- **Vier Tabs** (Bottom-Bar auf dem Phone, Icon-Leiste links auf dem Tablet):
  **Chats** (nur private 1:1-Nachrichten) · **Räume** (Communities mit Text- und
  Voice-Kanälen) · **Freunde** · **Du** (Profil/Einstellungen).
- Voice hat bewusst **keinen eigenen Tab** — Einstieg über einen Sprachkanal im
  Räume-Tab, Dauerpräsenz über das Voice-Dock.
- **Anrufe** (Audio und Video, 1:1 wie Gruppenanrufe) gehören zum Kern — aus dem
  Chat heraus gestartet, mit Klingeln/Annehmen/Verpasst wie bei jedem Messenger
  (Epic in §5).
- **Android zuerst**, iOS danach (es gibt noch gar kein iOS-Projekt — siehe §5.4).

## 2. Architektur in einem Absatz

Die Mobile-App ist eine **Capacitor-8-Hülle** (`mobile/`, appId `com.howispulse.app`),
deren WebView standardmäßig die **Produktions-Web-App** lädt
(`mobile/capacitor.config.json` → `server.url: https://howispulse.com/app`;
`mobile/www/index.html` ist nur ein Redirect). Die eigentliche App lebt im
**Web-Frontend** (`web/`): SvelteKit + Svelte-5-Runes + Tailwind v4 + shadcn-svelte,
i18n de/en über Paraglide. Backend: Python-FastAPI-Services unter `services/` —
Herzstück für alles Chat-Thema ist der **chat-gateway**
(`services/chat-gateway/src/dcc_chat_gateway/`), dazu voice-signaling (LiveKit-Tokens),
auth, media-svc. Native Android-Erweiterung in Java unter
`mobile/android/app/src/main/java/com/howispulse/app/`:
`MainActivity` (Permission-Handling beim Start), `MicForegroundService` (hält die
Mic-Aufnahme bei Screen-Lock am Leben), `AudioRoutePlugin` + `SpeakerphoneRouter`
(Lautsprecher-/Bluetooth-SCO-Routing), `OrientationLockPlugin`.

**Die wichtigste Konsequenz dieser Architektur:** Web Push (Service Worker +
Push-API) funktioniert in einer Android-WebView **nicht**. Der komplette
Web-Push-Pfad im Backend läuft im App-Kontext ins Leere — Native Push (FCM) ist der
größte offene Block (§5.1).

## 3. Was auf main schon existiert (Inventar, mit Beleg)

Alles Folgende ist **schon gebaut** — bitte nichts doppelt erfinden:

**Chat-Backend** (`services/chat-gateway/src/dcc_chat_gateway/routes/`)
- DM-Kanäle: find-or-create mit Friend-Gate/Block-Check (`dms.py`), Listen-Vorschau
  (letzte Nachricht) via `dm_vorschau.py`.
- Nachrichten: Pagination (`before/after`), Antworten (`reply_to_id`), Bearbeiten,
  Soft-Delete, Rate-Limit (`messages.py`).
- Emoji-Reaktionen (`reactions.py`), Typing-Indikator (WS, throttled, `ws_typing.py`),
  DM-Volltextsuche `GET /dm-channels-search` (`dms.py`), @Mentions mit
  Mention-Counter und Push-Anbindung.
- Anhänge: Two-Phase-Upload mit Presigned-S3/MinIO-PUT (`attachments.py`), WebP-
  Thumbnails, MIME-Allowlist (inkl. `audio/*`), Quotas.

**Ende-zu-Ende-Verschlüsselung — Default AN** (`web/src/lib/krypto/`)
- Schalter: `krypto/schalter.ts` (`E2E_DMS_ENABLED = true`).
- Signal-artiger Aufbau: Geräte-Bundles + One-Time-Pre-Keys (`routes/schluessel.py`),
  Transport über ein „Postfach", das der Server nur als Chiffrat sieht
  (`routes/postfach.py`, `routes/postfach_anhaenge.py`), Zustell-Quittung
  (`routes/postfach_abholen.py`).
- E2EE-Anhänge inkl. Thumbnails (`krypto/anhangKrypto.ts`, `lib/attachments/uploadVerschluesselt.ts`).
- E2EE-**private Gruppen** (`routes/private_gruppen.py`, `krypto/gruppe/`):
  Backend und Krypto-Suite sind komplett (Anlegen, Liste, Mitglieder +/−,
  Verlassen, WS-Abos über `ws_gruppen_abo.py`), und Gruppen erscheinen mobil in
  der Chats-Liste (`MobileGruppenZeile.svelte`) und öffnen im ChatView
  (`headerKind: 'gruppe'`). **ABER:** Kein Bildschirm im Produkt ruft die
  Verwaltungs-API auf — Anlegen/Verwalten geht nur über die API, nicht über UI
  (Details §5.4).
- Wichtig: DM-Composer sperren, wenn der Partner kein App-Gerät hat
  (`krypto/dmSendeSperre.ts`) — „ohne App-Gerät keine Direktnachrichten".

**Realtime & lokale Daten**
- WebSocket-Gateway mit Ops (`routes/ws.py`, `ws_ops_registry.py`), Client mit
  Reconnect-Backoff und Gap-Fill (`web/src/lib/ws/gapFill.ts`,
  `gateway-connection.ts`).
- Local-First-Verlauf in IndexedDB (`web/src/lib/verlauf/`).
- Geräte-Kopplung mit Verlaufsumzug und verschlüsseltes Backup
  (`web/src/lib/sicherung/`, `krypto/wiederherstellungsPaeckchen.ts`).

**Push (nur Browser!)**
- Kompletter Web-Push-Pfad: `push.py` (pywebpush, VAPID-Selfprovisioning in
  `vapid.py`), Subscriptions (`routes/notifications.py`), Service Worker mit
  `push`/`notificationclick` (`web/src/service-worker.ts`). DM-Push für
  verschlüsselte Nachrichten geht **inhaltlos** raus — dieses Muster für FCM
  wiederverwenden.

**Mobile-Web-UI** (`web/src/lib/components/mobile/`, `web/src/lib/navigation/`)
- Vier Tabs inkl. URL-basiertem Navigations-Stack: `navigation/tabs.ts` — die
  System-Zurück-Geste und Benachrichtigungs-Sprünge funktionieren über die URL
  ohne Zusatzcode.
- `MobileTabBar.svelte`, `MobileChatsList.svelte` (+ Suche, Neues-Gespräch-Dialog),
  `BottomSheet.svelte`, `ChannelSwitcherSheet.svelte`, `TabletNavRail.svelte`,
  `MeSectionList.svelte`.
- DM-**Sprechblasen** (WhatsApp-Stil) über `MessageItem layout='bubble'`
  (`web/src/lib/components/ChatView.svelte`, ca. Zeile 479) — nur in DMs,
  Community-Kanäle bleiben linksbündig.
- Android-Zurück-Taste: `web/src/lib/platform/zurueckTaste.ts`, registriert in
  `web/src/routes/app/+layout.svelte` („navigiert in der App hoch statt zu schließen").
- Geräteklassen `desktop|tablet|handy`: `web/src/lib/stores/geraetKlasse.ts`,
  `viewport.svelte.ts` (`isMobile`/`istHandy`).
- PWA-Manifest (`web/static/manifest.json`) — installierbar im Browser, ersetzt die
  Hülle aber nicht.

**Voice**
- LiveKit (`web/src/lib/voice/livekit.svelte.ts`), Token-Dienst
  `services/voice-signaling`, Bluetooth-SCO-Routing-Fix, Mic-Foreground-Service
  (native). Kamera im Voice-Call funktioniert (WebView getUserMedia).
  Achtung: Der Token-Flow ist an **Guild-Sprachkanäle** gebunden
  (`POST /token { channel_id }` → `_require_voice_channel_member` +
  `_room_for_channel(channel_id)`) — für Anrufe aus DMs/Gruppen braucht es ein
  eigenes Call-Room-Konzept (siehe Anrufe-Epic in §5).

**Android-Hülle heute**
- `versionCode 3` / `versionName "1.2"`, minSdk/targetSdk aus
  `mobile/android/variables.gradle`. Permissions im Manifest: `INTERNET`,
  `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `FOREGROUND_SERVICE(_MICROPHONE)`,
  `POST_NOTIFICATIONS`, `CAMERA` (neu in diesem Branch, siehe §4).

## 4. Dieser Branch `feat/mobile`

- **`06994b21`** (portiert aus dem verworfenen `feature/mobile-app`): Kamera-Freigabe
  schon beim App-Start zusammen mit Mikrofon (`MainActivity`), `CAMERA`-Permission im
  Manifest, **Foto-Knopf im Composer** (`MessageInput.svelte`,
  `capture="environment"` öffnet die Android-Kamera-App, Foto läuft durch die
  normale Attachment-Pipeline — nur bei `viewport.istHandy`), und
  `raumPfadNachAuflegen` (`navigation/letzterRaumBereich.svelte.ts`): nach dem
  Auflegen zeigt der Räume-Tab auf die Raum-Übersicht statt auf den verlassenen
  Sprachkanal (verhindert Auto-Rejoin).
- **`68ea7aa9`**: Design-Referenz-Mockups nach `docs/mockups/pulse-mobile-chatfirst/`
  (README = kompletter Design-Handoff: Screens, Interaktionen, Tokens, offene Punkte).
- **`d5dec5ec`**: i18n-Key `message_input_take_photo` (de/en).

⚠️ **Offene Entscheidung, die in diesem Commit steckt:** Er entfernt den
Lautsprecher/Hörmuschel-Umschalter aus der `VoiceControlBar` und mappt nativ
`earpiece → speaker` („Voice läuft immer wie Anruf auf Lautsprecher", Entscheidung
vom 25.08. im alten Branch). Auf main lebt der Umschalter noch. Falls er bleiben
soll: die drei Dateien `VoiceControlBar.svelte`, `SpeakerphoneRouter.java`,
`AudioRoutePlugin.java` aus diesem Commit zurücknehmen. **Mit Michael klären.**

Verifikationsstand: Unit-Suite 1150 Tests grün; `pnpm check` im `web/` zeigt nur die
9 Vorbefunde des ungebaute-Krypto-wasm (`krypto/pulse-krypto/pkg/` muss gebaut
werden — in einem frischen Checkout normal).

## 5. Roadmap

### P0 — ohne das ist die App kein Messenger

1. **FCM-Push End-to-End (größter Block).** In der Capacitor-WebView gibt es kein
   Web Push. Nötig:
   - `@capacitor/push-notifications` (FCM) in die Hülle; Firebase-Projekt anlegen,
     `google-services.json` in `mobile/android/app/`.
   - Backend: Fan-out in `push.py` um FCM v1 erweitern — es existieren bereits
     `fan_out_dm_push` und `fan_out_dm_push_encrypted` (inhaltlos) als Blaupausen;
     Device-Tokens persistieren (analog `web_push_subscriptions`-Migration).
   - Notification-Tap → Deep-Link in den Chat: die Web-Routen sind bereits
     URL-basiert (§3), in der WebView also einfach navigieren.
   - `POST_NOTIFICATIONS`-Permission ist im Manifest, muss aber als Runtime-
     Permission beim ersten Start abgefragt werden (`MainActivity` macht das
     bereits — dort anschließen).
2. **Serverseitiger Read-State + Lese-Häkchen.** Heute ist Unread reines
   localStorage (`web/src/lib/stores/readState.svelte.ts` — der Kopfkommentar
   dokumentiert die Lücke selbst): Zähler stimmen nicht geräteübergreifend und
   überleben kein Cache-Clear. Nötig: `last_read_at` pro DM-Teilnehmer serverseitig.
   - E2EE-Weg: die existierende Postfach-Quittung (`routes/postfach_abholen.py`)
     um „gelesen" erweitern (sie ist schon das Zustell-ACK).
   - Klartext-/Kanal-Pfad: REST-Endpunkt + WS-Event.
   - UI: Häkchen (zustellt/gelesen) in Bubble + Ungelesen-Pille in `MobileChatsList`.
3. **Sprachnachrichten.** Fehlen komplett (kein `MediaRecorder` in `web/src`).
   Alles Darunterliegende existiert: `audio/*` in der Attachment-Allowlist,
   E2EE-Anhang-Krypto, Thumbs. Zu bauen: Aufnahme-UI (Halten zum Sprechen,
   Abbruch, Wellenform), Wiedergabe mit Geschwindigkeit, Autoplay-Kette optional.
   Auch an den E2EE-Weg anbinden (Postfach-Anhang), sonst gilt die Funktion nur
   im Klartext-Pfad.
4. **Gruppenchats komplettieren — Anlegen und Verwalten.** Für ein
   WhatsApp-Gefühl sind Gruppen Kernfunktionalität, und der seltsame Stand ist:
   **alles Unterbau ist fertig, nur die UI fehlt.** Produktentscheid 2026-09-06:
   gilt **produktweit** — Desktop und Mobile teilen den Web-Layer, die fehlende
   UI wird also einmal gebaut und erscheint in beiden. Backend-Lifecycle komplett
   (`routes/private_gruppen.py`), E2EE-Krypto-Suite komplett
   (`web/src/lib/krypto/gruppe/`), API-Client ebenfalls
   (`web/src/lib/api/gruppen.ts`: `erstellen`, `mitgliedHinzufuegen`,
   `mitgliedEntfernen`, `verlassen`) — aber **kein einziger Bildschirm ruft diese
   Methoden auf** (geprüft am 2026-09-06, null Aufrufer). Gruppen sind heute nur
   über die direkte API anlegbar, also faktisch ein Testfeature. Zu bauen:
   - „Gruppe erstellen" im Chats-Tab (Einstieg im `NeuesGespraechDialog` oder
     eigener Sheet-Einstieg): Name wählen, Freunde hinzufügen (`POST /gruppen`,
     `POST .../mitglieder`).
   - Gruppen-Sheet im Chat (•••): Mitgliederliste aus `MemberList`,
     Hinzufügen/Entfernen, Gruppe verlassen — alles vorhandene Endpunkte.
   - Hinweis: Es gibt **keinen Einladungs-/Beitritts-Flow** — Mitglieder werden
     direkt per `user_id` hinzugefügt (Ersteller fügt seine Freunde hinzu). Das
     reicht für den Messenger-Kern; einen Einladungs-Link-Flow würde ich bewusst
     erst später planen.
   - Politur danach: Gruppen-Zeilen zeigen bewusst keinen Vorschautext
     (Docblock in `MobileGruppenZeile.svelte` — der Server liefert für Gruppen
     keine Vorschau, anders als bei DMs via `dm_vorschau.py`). Wenn Gruppen
     Erstklassig werden sollen: serverseitige Gruppen-Vorschau nach dem
     DM-Vorbild (Achtung E2EE: Vorschaufeld wäre Klartext auf dem Server —
     Entweder-Entscheidung dokumentieren).

### Epic: Anrufe — Audio/Video, 1:1 und Gruppe

Produktentscheid 2026-09-06: Aus der Direktnachricht heraus anrufen (1:1,
Audio wie Video) und Gruppenanrufe gehören in den Kern des Produkts. Der
LiveKit-Unterbau existiert (Mehrfach-Teilnehmer, Reconnect, Audio-Routing,
Mic-Foreground-Service, Kamera-Track); was fehlt, ist die **Anruf-Ebene
darüber**. Stufen:

- **A — Call-Room-Konzept im Backend.** Der Token-Flow
  (`services/voice-signaling/routes/token.py`) verlangt einen Guild-Voice-Kanal
  (`_require_voice_channel_member`, `_room_for_channel(channel_id)`). DMs und
  private Gruppen haben keinen solchen Kanal. Nötig: Anruf-Entität
  (id, Typ `dm|gruppe`, Teilnehmer, Zustand) im chat-gateway/voice-signaling und
  eine Token-Ausstellung mit Anruf-Mitgliedschaftsprüfung (DM-Teilnahme bzw.
  Gruppen-Mitgliedschaft statt Kanal-Mitgliedschaft).
- **B — Klingeln/Signalisierung.** WS-Events (`call_invite`, `call_accept`,
  `call_decline`, `call_cancel`, `call_timeout`) über das bestehende Gateway —
  ephemeral, kein Gap-Fill. Gerät offline: **inhaltloser Push** (Muster
  existiert: `fan_out_dm_push_encrypted` in `push.py`; FCM laut P0.1). Anruf-
  ergebnis als Systemzeile im Chat („Verpasst", „Dauer") — WhatsApp-Prinzip.
- **C — UI, 1:1 zuerst.** Ausgehend: Klingel-Screen + Auflegen. Eingehend:
  Annehmen (nur Audio / mit Video), Ablehnen. Laufend: die bestehende
  Voice-UI-Komponenten wiederverwenden (`VoiceControlBar`, Kacheln,
  `MobileVoiceStack`, Lautsprecher-Routing, Mic-Foreground-Service). Kamera
  an/aus und Front/Rück-Wechsel sind im LiveKit-Stack bereits gebaut.
- **D — Gruppenanruf.** Derselbe Mechanismus mit n Teilnehmern; LiveKit-Räume
  skalieren bereits (Raum-Kanäle machen nichts anderes). Einstieg „Anruf
  starten" in der Gruppe; Modell wie WhatsApp: klingeln, wer will, stößt hinzu.
- **E — Sperre/Hintergrund.** Android: eingehender Anruf als Full-Screen-Intent
  bzw. `ConnectionService` (in-call UI über den Sperrbildschirm),
  `MicForegroundService` um einen Call-Typ (Kamera!) erweitern. iOS:
  PushKit + CallKit — Apple verlangt den CallKit-Report, **bevor** der VoIP-Push
  verarbeitet wird, sonst wird die App bestraft. Stufe E erst, wenn A–D im
  Vordergrund sauber laufen.

**Ehrlichkeits-Hinweis (Produkt + Play-Listing):** Anrufe sind **nicht**
Ende-zu-Ende verschlüsselt — LiveKit transportverschlüsselt (DTLS-SRTP), aber
der SFU sieht das Medien-Plaintext. DM-*Texte* sind dagegen E2EE. Diesen
Unterschied in der Security-Dokumentation sauber benennen. Echte E2EE-Anrufe
wären ein eigenes Projekt und sind bewusst zurückgestellt (siehe unten).

### P1 — Chat-Alltag rund machen

5. **Reaktionen/Bearbeiten/Löschen im E2EE-Pfad.** Klartext-DMs können das,
   verschlüsselte Nachrichten nicht (keine Server-Zeile; Fehlermeldung in
   `web/src/lib/krypto/…/cloudNachrichtAktionen.ts`). Ansatz: Reaktion als
   Postfach-Umschlag, Löschen als Tombstone im lokalen Verlauf + Umschlag an
   Geräte.
6. **Long-Press-ActionSheet in der Bubble-Darstellung verifizieren**
   (`MessageActionSheet.svelte` existiert) und **Swipe-to-reply** ergänzen.
7. **Medienübersicht pro Chat** — Bilder-/Datei-Grid aus dem lokalen Verlauf
   (IndexedDB, `web/src/lib/verlauf/`) + Attachment-Metadaten.
8. **Android App Links + Share-Target.** `howispulse.com/app/...`-Links sollen die
   App öffnen (Benachrichtigungs-Klicks, geteilte Links); Fotos/Text aus anderen
   Apps in einen Chat teilen (Intent-Filter in `AndroidManifest.xml`, Empfang im
   Web-Layer).
9. **E2EE-Ersteinrichtung auf neuem Gerät als App-Onboarding.** Das Koppeln mit
   Verlaufsumzug existiert, aber der Flow muss auf Android sauber durchlaufen —
   ohne ihn sendet der Nutzer keine DMs (`dmSendeSperre`).

### P2 — Hülle & Release

10. **Bundle-vs-Remote-Entscheidung.** Die Hülle lädt hartcodiert Produktion. Für
   den Play-Store und das Self-Host/Managed-Server-Modell (Docs:
   `docs/managed-server-vermietung.md`, `docs/user-gehostete-kanaele-analyse.md`)
   braucht es entweder ein gebündeltes Frontend (SvelteKit-Build nach `mobile/www/`
   statt Redirect, Updates über Play) oder eine Server-Auswahl in der App.
   `android:usesCleartextTraffic` bleibt aus; lokale Dev-URLs über Capacitor-
   `server.cleartext` nur im Dev-Build.
11. **Release-Handwerk:** Signing-Keystore-Management (liegt korrekt nicht im
    Repo — Aufbewahrung regeln!), targetSdk passend zu Capacitor 8 (API 35),
    App-Icon/Splash (Ressourcen liegen in `mobile/android/app/src/main/res/`),
    Play-Data-Safety-Angaben (E2EE = Erklärpflicht + Verkaufsargument).
12. **Rate-Limiter im chat-gateway** — existiert nicht (dokumentiert in
    `routes/dms.py`). Ein Messenger mit Hintergrund-Sync ist genau der Traffic,
    für den man einen will.
13. **Offline-UX.** Ohne Netz zeigt die WebView einen toten Bildschirm; lokaler
    Verlauf existiert, aber der Start braucht einen Offline-Fallback/Retry.

### iOS (nach Android — heute existiert kein iOS-Projekt)

- `mobile/` enthält nur `android/`; `@capacitor/ios` ist nicht installiert.
- Alle vier Java-Plugins (AudioRoute, MicForegroundService, SpeakerphoneRouter,
  OrientationLock) brauchen Swift-Pendants; der Permission-Flow in `MainActivity`
  ebenfalls.
- VoIP-Push über PushKit/CallKit ist ein eigener Block und als Stufe E Teil des
  Anrufe-Epics (§5) — der iOS-Anschluss der Anrufe hängt daran.
- **Deshalb:** Push-Fan-out, Read-State und Sprachnachrichten bewusst
  plattformneutral im chat-gateway bauen, damit der iOS-Anschluss mechanisch statt
  konzeptionell wird.

### Aus dem verworfenen `dm-attachment-e2ee` gerettete Ideen

Der alte Branch (Juli 2026) wurde verworfen — seine drei Kern-Features (E2EE-DM-
Anhänge, E2EE-DM-Text, Schlüsselbund-Backup) leben auf main. Zwei *Ideen* daraus
gibt es aber noch nicht und sie gehören auf die Roadmap:

- **Anhang-Verfall:** DM-Anhänge melden nach Ablauf sauber „abgelaufen" statt
  „Schlüssel fehlt". Kleine Server-Aufgabe; ohne sie liegen Chat-Anhänge ewig auf
  dem Server.
- **Medien-Nachziehen / lokales Medien-Archiv:** „Meine Medien bleiben auf meinem
  Gerät" — Backfill-Endpunkt (paginierter Abruf der eigenen Anhang-Metadaten) plus
  Geräte-Ablage. Für Mobil der größte Hebel bei Speicher und Datenvolumen. Als
  frische Planung auf heutigem main angehen — vorher `web/src/lib/ablage/` und
  `docs/superpowers/plans/2026-08-31-ablage-e3-persoenliches-archiv.md` lesen,
  das ist der neuere Architektur-Ansatz für persönliche Archive.

### Bewusst zurückgestellt

- **E2EE-Anrufe** — Anrufe laufen über den LiveKit-SFU (transportverschlüsselt,
  aber nicht End-zu-Ende, siehe Anrufe-Epic). Echte E2EE-Anrufe (LiveKit-External-
  E2EE-Keys oder Mesh ohne SFU) sind ein eigenes Projekt und erst anzugehen,
  wenn die Anruf-Stufen A–E stehen.
- **Einladungs-Link-Flow für Gruppen** — Mitglieder werden zunächst direkt per
  `user_id` hinzugefügt (P0.4). Beitreten-per-Link wäre eine spätere Erweiterung
  mit eigener Sicherheitsbetrachtung.

## 6. Arbeiten im Repo — was die neue Person wissen muss

- **`AGENTS.md` im Repo-Root ist Pflichtlektüre** (Arbeitsregeln, Dev-Stack,
  Paraglide/Vite-Falle, „kein pkill"). Dazu `docs/ONBOARDING.md` §4 für den
  Dev-Stack (`./scripts/dev-up.fish`, Ports 5173 + 8001–8005,
  `PULSE_DEV_SKIP_MEDIAMTX=1` wenn MediaMTX nicht pullbar ist).
- **Android-Dev-Loop ist noch nicht dokumentiert — erster Auftrag: etablieren und
  in diesem Dokument nachtragen.** Der Standard-Capacitor-Weg:
  `cd mobile && npx cap sync android`, dann `cd mobile/android && ./gradlew
  installDebug` (oder Android Studio). Zum Testen gegen den lokalen Stack
  `server.url` in `mobile/capacitor.config.json` auf die LAN-/Emulator-Adresse
  (Emulator: `http://10.0.2.2:5173`) umstellen und `server.cleartext: true` setzen
  — **nicht committen**.
- Konventionen: Code-Pfade und Bezeichner überwiegend **deutsch**, Svelte 5 Runes,
  Tailwind-Tokens aus `web/src/app.css`, Icons aus `@lucide/svelte`,
  Übersetzungen in `web/messages/{de,en}.json` (nach neuen Keys: Vite neu starten,
  siehe AGENTS.md). Ponytail-Regel: kleinster arbeitsfähiger Diff, zu jeder
  nicht-trivialen Logik eine lauffähige Prüfung (`pnpm test:unit` in `web/`,
  Node-Test-Runner).
- **Branch-Hygiene:** Entwicklung in `feat/mobile`, PRs gegen `main`. Die alten
  Mobile-/Krypto-Branches sind gelöscht; ihre Spitzen sind lokal als Tags
  verwahrt, falls jemand archäologische Fragen hat: `archiv/mobile-app`,
  `archiv/mobile-chatfirst-redesign`, `archiv/e2ee-main`,
  `archiv/e2e-dm-krypto-weg-a`, `archiv/dm-attachment-e2ee`.

## 7. Kürzester Einstieg (checkliste für Tag 1)

1. Repo klonen, `AGENTS.md` + `docs/ONBOARDING.md` lesen, Dev-Stack starten.
2. `feat/mobile` auschecken, `cd web && pnpm install && pnpm test:unit` → grün?
3. APK bauen und aufs Gerät bekommen (§6) — erst gegen Produktion, dann lokal.
4. Dieses Dokument mit Michael durchgehen: P0-Reihenfolge bestätigen, die offene
   Hörmuschel-Entscheidung (§4) und Bundle-vs-Remote (§5.10) klären.
5. Erster Arbeitspaket-Schnitt: **FCM-Push** — Firebase-Projekt ist das einzige
   echte external Dependency auf dem Weg.
