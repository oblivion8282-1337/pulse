# Bughunt 2026-09-20 — offene Entscheidungen & bewusst Aufgeschobenes

Ergebnis der beiden Bughunt-Runden vom 2026-09-20 (Branch `bughunt-2026-09-20`).
Alles unten ist **verifiziert**, aber ausdrücklich NICHT gefixt — entweder, weil
eine Betreiber-Entscheidung fehlt, oder weil Aufwand/Nutzen/Design es hergeben.
Wer einen Punkt angeht: Zeile im jeweiligen Commit-Kontext lesen, dort steht der
Upgrade-Pfad meist schon nebengenannt.

---

## 1. Entscheidung nötig — konkreter Schaden läuft

### 1.1 MinIO-Pin ist upstream weg → Self-Host-Builds brechen
- `infra/self-host/Dockerfile:67` (`MINIO_VERSION=RELEASE.2025-09-07T16-13-09Z`)
  und die SHA256-MinIO-Pins in Zeile 92–93.
- `https://dl.min.io/server/minio/release/linux-amd64/archive/minio.RELEASE.2025-09-07T16-13-09Z`
  antwortet **410 Gone** (auch das Archiv-Listing selbst). Der `curl` im
  Dockerfile (Zeile 323) schlägt damit fehl: **jeder frische Self-Host-Bau ist
  aktuell tot**, bis der Pin gehoben wird.
- Prod (infra/prod) ist NICHT betroffen — dort kommt MinIO als Docker-Hub-Image
  (`minio/minio:RELEASE.2025-09-07...`, Zeile 98), und alte Tags auf Docker Hub
  bleiben pull-bar.
- Entscheidung: Version-Bump im Dockerfile (auf das aktuelle Release, Pins neu
  berechnen — `scripts/refresh-checksums.sh --write` macht das inzwischen und
  prüft MinIO/frp seit dem Bughunt mit). Dabei den Paritäts-Kommentar pflegen
  („pinned to the SAME release the prod stack runs“): Entweder Prod-Compose mit
  heben, oder die Parität bewusst lösen und kommentieren. Alternativ lang-
  fristig den Self-Host-Bau auch auf das Docker-Hub-Image umstellen, dann
  verschwindet die dl.min.io-Abhängigkeit (und das Pin-Problem) ganz.
- Aufgedeckt am 2026-09-20 durch den erweiterten `refresh-checksums.sh`-Lauf
  (Commit `b177afc1`).

## 2. Bewusst aufgeschoben — bekannt, dokumentiert, braucht Design/Vorarbeit

### 2.1 pulse-player: D3D11-Ring wird beim Software-Fallback geleakt (bis Sitzende)
- `streaming/pulse-player/src/depacket/../decode.rs:1775-1821` +
  `zerocopy/bruecke.rs:128-184`. Nach `auf_software`/`rebuild` bleibt die
  D3D11-Shared-Texture-Bridge absichtlich am Leben, weil `GpuBild::handle`
  unter Windows ein nackter `isize` ist — Droppen würde Handles schließen, die
  In-Flight-Frames im Render-Pfad noch referenzieren (der Codekommentar
  verweist selbst auf ausstehend „Befund 4“; Linux hält `Arc<Ringplatz>`).
- Folge: Nach einem GPU-Stall bleiben 160–320 MB Grafik-/Systemspeicher bis
  zum Sitzungsende gebunden, je Fenster multipliziert.
- Upgrade-Pfad: Windows-`GpuBild` dieselbe `Arc<Ringplatz>`-Ownership geben
  wie Linux, dann Bridge beim Fallback sauber droppen.

### 2.2 Username: Fallkollisionen nur durch Vorab-Checks verhindert, nicht airtight
- `services/auth/src/dcc_auth/routes.py` (Register) + `routes_profile.py`
  (change_username) prüfen case-insensitiv — aber ohne eindeutigen Index kann
  ein Rennen zwischen zwei PARALLELEN Registrierungen („bob“ + „Bob“) die
  Variante noch durchlassen; die Resolver matchen lower(username) und würden
  die beiden beliebig vermengen.
- Upgrade-Pfad: Alembic-Migration mit eindeutigem Funktions-Index auf
  `lower(username)`. VOR der Migration Bestandsdaten auf Kollisionen prüfen —
  eine bestehende Kollision lässt den Index sonst nicht anlegen und blockiert
  das Deployment.

### 2.3 voice_override: read-merge-write kann parallele Admin-Patches verschlucken
- `services/voice-signaling/src/dcc_voice_signaling/routes/voice_override.py:97-110`.
  Zwei Admins patchen denselben Nutzer in derselben Millisekunde → letzter
  Schreiber gewinnt, das Feld des ersten geht verloren (z. B. Force-Mute
  wieder weg). Ereignis kann danach vom gespeicherten Stand abweichen.
- Fenster ist winzig, Zwei-Admins-gleichzeitig-realistisch selten. Upgrade:
  atomarer Compare-and-Save (Lua/`WATCH`) oder Patch-Events statt Full-Write.

### 2.4 WS-Op-Gate: 4040/4043 erlauben Plugin-Enumeration durch Probieren
- `services/chat-gateway/src/dcc_chat_gateway/plugins/ws_op_gate.py`. Der
  Close-Code unterscheidet „nicht in Allowlist“ (4040) von „installiert,
  aber für die Guild aus“ (4043) — wer Op-Namen probt, kann daraus
  „installiert vs. fremd“ lesen. Bewusst so belassen (Debug-Signal, weiche
  Sandbox); die Kommentare im Code sagen das jetzt auch so.
- Falls irgendwann harte Anti-Enumeration gewollt ist: Codes vereinheitlichen
  und die beiden assertierenden Tests mitziehen.

### 2.5 dev-up.fish: Warte-Loops time out still, .env-Werte ungequotet
- `scripts/dev-up.fish`: (a) die Bereitschafts-Loops brechen nach ~9 s still
  um und das Skript meldet trotzdem „Services up“ — der Beweis steht in
  /tmp/dcc-*.log; (b) env-Werte werden unquotet in `bash -c`-Strings
  interpoliert (Zeile ~171/181ff) — Sonderzeichen im Passwort verhunzen den
  Launch still. Dev-only, AGENTS.md dokumentiert das Umschiffen bereits.
- Upgrade: nach jedem Loop den Port final prüfen und bei Fehlschlag mit
  Log-Pfad abbrechen; env sauber als Array an `env` übergeben.

## 2b. Design-Entscheidungen aus Runde 10 (E2E-Krypto/Ablage)

### 2b.1 OTK-Verbrauch je Sendung — Nachfüllen nur bei App-Start
- `krypto/senden.ts` + `gruppe/{senden,kanalSenden}.ts` claimen pro
  Nachricht einen Einmalschlüssel je Zielgerät (Server löscht ihn
  bedingungslos), benutzen ihn aber nur beim Sitzungs-NEUBAU — im
  Normalfall wird er weggeworfen. Nachfüllen passiert nur in
  `veroeffentlicheSchluessel` (Tab-/App-Start, Cert-Rotation): ein
  lange offener Tab senkt den Vorrat aller Mitglieder kontinuierlich
  gegen 0, dann laufen neue Sitzungsaufbauten über den
  Fallback-Schlüssel. Runde 10 hat den Deadlock der NACHFÜLLUNG
  behoben; das DESIGN (Refill nach Claim, z. B. debounce'd
  `nachfuellenWennNoetig` nach Sendungen) ist eine Abwägung zwischen
  Serverlast und Forward-Secrecy-Fenster.

### 2b.2 Zwischenlager-Quota: nicht-atomare Buchung + tote Buchungen ohne Release
- `routes/ablage_zwischenlager.py:137-158`: read-then-INSERT mit await
  dazwischen — zwei parallele Ankündigungen überspringen beide das
  Limit (dasselbe Muster, das kopplung_anlegen per INSERT-FROM-SELECT
  fixte). Plus: die Buchung entsteht bei Ankündigung, scheiternde PUTs
  belegen das Kontingent bis zum 7-Tage-Sweep, und Löschen darf nur
  der Owner — der Hochladende kann seine tote Buchung nicht selbst
  freigeben (Uploader-Spalte fehlt im Modell → Migration nötig).

### 2b.3 Festigung belebt gelöschte Dateien wieder
- `ablage/dateispeicher.ts:285-292`: die Idempotenz-Prüfung ist
  Präsenz-basiert („id fehlt im Verzeichnis = noch nicht gefestigt").
  Quittierungsfehler + Owner-Löschen + Retry = Datei ist wieder da.
  Sauberer Fix braucht Lösch-Grabsteine im Verzeichnis oder
  Festigungs-Journal — Design-Entscheidung.

### 2b.4 Pulse-Laufwerk: Reservierungen (zustand=0) zählen nicht aufs Kontingent, kein Sweeper
- `routes/ablage_pulse.py` `_genutzte_bytes` zählt nur zustand=1 —
  parallele Ankündigungen laufen alle gegen denselben Stand; nie
  hochgeladene Ankündigungen akkumulieren sich ohne Sweeper (quota-
  neutral, aber unbegrenzes Tabellenwachstum). Braucht
  Reservierungs-TTL oder -Sweep plus Design-Entscheidung.

## 2c. Tote Regler (Runde 13) — Entfernen aus Render/Examples ist Aufräum-Entscheidung
* `CHAT_GATEWAY_CHALLENGE_SECRET` — die Challenge-Route existiert nicht
  mehr; Render-Script + .env.example bewerben ihn weiter als live.
* `PULSE_JWT_AUDIENCE` — der dokumentierte aud-Check existiert nicht;
  Voreinstellung wird auf jedem Self-Host gerendert.
* `SNOWFLAKE_WORKER_ID_VOICE` — voice-signaling prägt keine Snowflakes;
  jede Operator-Anpassung ist ein No-op.
* Dev-Ports: root `.env.example` (5434/6380) vs. compose-Defaults
  (`POSTGRES_HOST_PORT:-5433`/`6379`) — frisches Kopieren bricht den
  Dev-Stack; Beispiel sollte die Host-Port-Knobs setzen.

## 3. Kosmetisch / UX — klein, aber nicht kostenlos

* `web/src/lib/plugins/conflict-detector.ts` — Konflikt-Detektor ohne UI
  (die dokumentierte Manager-UI aus PLUGIN_ROADMAP Schritt 6 existiert
  nicht mehr; Plugin-Op-Kollisionen laufen lautlos last-wins).
* Mitschnitt/Clip-Stack: `player/client.ts` (startRecording/stopRecording/
  saveClip) + IPC + Rust-Recorder — komplett gebaut, kein Renderer-Aufruf.
* `web/src/lib/api/recovery-package.ts::deleteRecoveryPackage` + Server-
  Endpoint existieren — keine UI, ein Nutzer kann ein Päckchen nie entfernen.
* `web/src/lib/sicherung/googleClient.ts::sicherungClientKonfiguriert` —
  Build-Gate ungekoppelt (Sicherung wird auch ohne konfigurierte
  Google-Client-ID angeboten).
* `web/src/lib/remote/berechtigte.ts::anzahlBerechtigte` — für den nie
  gebauten Gerätedialog.
* `web/src/lib/direct/registry.ts::getDirectConnection` — toter Vorgänger-
  Wrapper (nur noch Docstring-Zitat).
* `shared`-Helfer: `watchkeys.read_parties`, `unregister_channel_handler`
  (Loader-Rollback fährt über _rollback_registrations), `settings-registry`
  `deleteServerSection`/`flushSection` (Policy-Option fehlt),
  `platformAuthenticatorAvailable` (Copy-Tailoring nie verdrahtet).

## 3. Kosmetisch / UX — klein, aber nicht kostenlos

### 3.4 Composer bleibt bis zur E2E-Sendebestätigung offen (UX-Redesign)
- `web/src/lib/components/MessageInput.svelte` + `chat/dmSenden.ts`: beim
  verschlüsselten DM-Sendeweg werden Text/Anhänge sofort beim Absenden
  verworfen; ein späterer Fehler rettet inzwischen nur noch den Text in die
  Zwischenablage (Runde 7). Die saubere Lösung — Composer-Inhalt bis zur
  Bestätigung halten bzw. bei Fehler inkl. Antwort-Kontext wiederherstellen —
  ist ein UX-Redesign (Anhang-Schlüssel sind beim Sendeversuch verbraucht,
  es müsste ein erneuter Upload-Fluss her).

### 3.5 Audit-Log/Mod-Queue-Cursor springt bei Zeitstempel-Gleichheit
- `routes/mod_queue.py` (list_audit_log + inzwischen auch list_mod_queue)
  paginieren mit exklusivem `created_at < before` — teilen sich Einträge
  denselben Zeitstempel (realistisch bei Bulk-Aktionen in einer TX), werden
  die Gleichzeitigen auf Folgeseiten dauerhaft übersprungen. Sauberer Fix
  ist ein Composite-Cursor (created_at + snowflake-id), also ein
  API-Shape-Wechsel mit Klienten-Nachzug — Entscheidung, ob sich das für
  die Admin-Sicht lohnt.


### 3.1 Gast-TTL-Statusdivergenz: 404 vs. 403 für „Ticket abgelaufen“
- voice-signaling `/gast/token` → 404 „ticket expired“
  (`routes/token_gast.py`), media-svc WHEP-Pfad → 403 „ticket expired“
  (`routes.py:563-574`, chat-gateway-Proxy reicht durch, `routes/gast.py:399`).
  Die Gast-Seite kann „Besprechung vorbei“ nicht sauber von „rausgeworfen“
  unterscheiden. Fix wäre eine Vereinheitlichung — aber bestehende Clients
  kennen die aktuellen Codes, also nur zusammen mit einem Klienten-Tick.

### 3.2 MitgliederRollen: Trägerliste im offenen Dialog stale
- `web/src/lib/components/settings/MitgliederRollen.svelte` — Checkbox-Toggles
  schreiben nur `mitgliedRollen`; Gruppierung links und Trägerzahlen der
  Rangleiste folgen erst nach dem Wiederöffnen des Dialogs.

### 3.3 KopplungEinloesen: Warten-Knopf trägt das Label des echten Imports
- `web/src/lib/components/settings/KopplungEinloesen.svelte:173-177` — der
  Status-Poll-Knopf heißt wie der spätere Import-Knopf („Verlauf
  übernehmen“), tut aber nur polling ohne Feedback. Braucht eine eigene
  Paraglide-Message (nach `paraglide:compile` Vite per PID neu starten, s.
  AGENTS.md-Falle).

---

Gefundene, aber vollständig unfallfreie Zonen der Runde (pulse-whip/zeitbasis/
bildmarke, krypto-Kern, media-svc, relay-frps-plugin, desktop IPC/Updater, WS-
Kern/Messages-Stores des Webs) sind in den Commit-Botschaften der Runde
dokumentiert — wer nachforschen will: `git log bughunt-2026-09-20 --oneline`.
