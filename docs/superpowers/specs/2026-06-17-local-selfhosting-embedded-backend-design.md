# Design-Spec: Lokales Selfhosting — Sub-Projekt ① „Embedded Backend-Bundle"

**Stand:** 2026-06-17 · **Status:** Design (vor Implementierungsplan) · **Scope:** nur ①

## 1. Kontext & Ziel

Pulse hat heute zwei Nutzungsstufen: **Cloud-Community** („Gast in fremder Welt" auf howispulse.com,
null Aufwand) und **VPS-Selfhost** (eigener Server, voller Stack via `pulse-allinone`-Container,
Cert-Modell). Dieses Programm baut die **Mittelstufe**: Ein normaler User hostet eine **eigene
Instanz vom eigenen Rechner aus**, direkt über die Desktop-App — ohne Server, ohne VPS, ohne Docker.
Wie eine selbst gehostete Spiel-Welt.

Das ist **kein einzelnes Feature**, sondern ein Programm aus vier unabhängigen Subsystemen
(Zerlegung in §8). **Diese Spec deckt nur ① ab**: das Backend des bestehenden `allinone`-Stacks
**Docker-frei als native Prozesse** auf dem Rechner des Hosts zum Laufen bringen, vom Electron-Main
orchestriert und lokal verifizierbar. ②–④ bekommen jeweils eigene Specs.

## 2. Feste Constraints (vom User bestätigt)

1. **Docker-frei** — die App bringt alles selbst mit; der User installiert nichts extra.
2. **Aller Medien-Traffic über den Host** — Voice (LiveKit-SFU), Screenshare und HQ-Streaming
   (MediaMTX) laufen auf der Host-Maschine; der Host trägt die Bandbreite.
3. **Cloud-Relay nur für die Steuerungsebene** (leichtes HTTP/WSS-Signaling, später in ②). **Medien
   nie über die Cloud** — direkt zum Host (Hole-Punching/UPnP); striktes NAT/CGNAT erfordert
   einmaliges Port-Forwarding. Die Cloud trägt nie Medien-Bandbreite.
4. **Gegated / monetarisierbar** — Selfhosting ist nicht für jeden offen; die Cloud schaltet es
   pro User frei (vorhandene Instance-Registry + Approval, später + Bezahl-Gate). Das Host-Backend
   ist ein **on-demand nachgeladenes Modul**, nicht Teil der schlanken Basis-App.

## 3. Architektur — das Backend ent-dockert

**Auslöser:** Ein freigeschalteter User klickt „Eigene Instanz hosten" → die App lädt einmalig das
**Host-Modul** und startet es.

**Inhalt des Host-Moduls:**
- **Python-Runtime + Services** (uvicorn-Prozesse): chat-gateway (Kern), voice-signaling (Voice),
  media-svc + mediamtx-auth-hook (HQ-Streaming), auth-svc (Cert/Well-known). *Welche strikt nötig
  sind, wird im Plan am Code verifiziert — auth-svc ist evtl. trimmbar.*
- **Native Binaries:** Redis (Pub/Sub-Bus zwischen den Services), LiveKit (Voice-SFU),
  MediaMTX (Streaming), coturn (NAT). Exakt die `allinone`-Komponenten — nur ohne Docker.

**Orchestrierung:** ein **`LocalBackendManager`** im Electron-Main, direkt analog zum heutigen
GSR-`SidecarManager` (`desktop/electron/sidecar.ts`). Er startet die Prozesse gestaffelt, überwacht
sie, sammelt Logs und fährt sie sauber runter.

**Datenfluss** bleibt identisch zur Cloud, nur auf `localhost`: HTTPS/WSS → Services, WebRTC →
LiveKit, WHEP → MediaMTX (die drei bekannten Transportpfade). In ① bindet alles nur auf `localhost`
— nach außen geht nichts; das macht erst ②.

## 4. Persistenz — die portable „Welt"

Ein Daten-Ordner (z.B. `<userData>/pulse-host/`):
- **`pulse.db`** — eine **SQLite**-Datei mit allen Community-Daten (das `chat`-Schema: Community,
  Kanäle, Nachrichten-Metadaten, Mitgliedschaften, Rollen/Rechte, Einladungen, Bans, Reaktionen,
  Community-Settings, Plugin-State). **Keine Identität** — Accounts/Logins bleiben in der Cloud
  (Cert-Login).
- **`attachments/`** — hochgeladene Bilder/Dateien **direkt im Dateisystem** (lokaler FS-Adapter
  statt MinIO). Ordner + DB-Datei = die ganze Community, trivial zu sichern/mitzunehmen.

**Warum SQLite statt Postgres:** Bei Self-Host-Größe (paar bis paar Dutzend Leute) reicht SQLite
voll; es ist eine portable Einzeldatei (Backup/Umzug trivial), winziger Footprint, kein
Daten-Verzeichnis-Versions-Upgrade-Schmerz, und der Code läuft schon darauf (400+ Tests nutzen
SQLite). Postgres bleibt der „großen" VPS-Stufe vorbehalten.

## 5. Kern-Aufgabe & Haupt-Risiko: echter „SQLite-Mode"

Der Code läuft heute auf SQLite **nur in Tests** — über einen Schema-Strip-Hack in der `conftest`
(die Models nutzen `schema=auth`/`chat`, das SQLite nicht kennt; JSONB→JSON-Variante;
`SELECT FOR UPDATE` ist auf SQLite ein No-op). Für einen **echten** SQLite-Self-Host muss dieser
Schema-Umgang zu einem **erstklassigen Laufzeit-Modus** werden (sauberer „SQLite-Mode" außerhalb der
conftest). Das ist die zentrale Fleißarbeit von ① und sein Haupt-Risiko. Absicherung: den
SQLite-Mode als echten Laufzeitpfad in die bestehenden Test-Suites ziehen (§7).

Locking-Semantik: `FOR UPDATE` schützt heute Cache-Mutation-Races (`state_store.py`). Auf SQLite
serialisiert die DB Schreibzugriffe ohnehin global → die Races sind entschärft; relevant ist eher
Durchsatz als Korrektheit, bei Self-Host-Last unkritisch. Wird im SQLite-Mode explizit verifiziert.

## 6. Lifecycle & Fehlerbehandlung (`LocalBackendManager`)

**Start:** Daten-Ordner anlegen (falls neu) → SQLite-Migrationen laufen → Prozesse **gestaffelt**
hochfahren (Redis → Services → LiveKit/MediaMTX/coturn), jeweils auf `/health` warten (Muster aus
`web/tests/e2e/_globalSetup.ts`) → Status an die UI.

**Stop / App-Quit:** umgekehrte Reihenfolge, SIGTERM→SIGKILL-Staffel (übernommen vom Sidecar).

**Fehler:**
- **Start scheitert** (Port belegt / Binary fehlt / Migration kaputt) → klare Meldung + **Rollback**
  (schon gestartete Prozesse stoppen — nie ein halb-laufender Stack).
- **Prozess stirbt zur Laufzeit** → Restart mit Backoff; nach N Fehlversuchen → Stack stoppen + Fehler.
- **DB-Sicherheit:** keine halb-migrierte DB starten; vor Migration bei App-Update ein **Backup der
  `pulse.db`**.
- **Logs** pro Prozess in den Daten-Ordner — **niemals Secrets/Tokens loggen** (harte CLAUDE.md-Regel).

**Persistenz über App-Close hinaus** (ephemer „läuft solange App offen" vs. Hintergrund-Dienst) ist
bewusst eine **③/UX-Entscheidung** — für ① reicht explizites Start/Stop in der Session.

## 7. Lokale Verifikation

- **SQLite-Mode** als echten Laufzeitpfad in die bestehenden pytest-Suites ziehen (sichert §5 ab).
- **Smoke-Harness:** `LocalBackendManager` headless hochfahren → auf Health warten → Szenario:
  Cert-Login, Community anlegen, Nachricht posten, **Voice-Call zwischen zwei lokalen Clients**,
  ein **HQ-Stream**. = End-to-End-Verifikation von ①.
- **Pro Plattform** (Linux/Flatpak · Windows · Mac) — die nativen Binaries unterscheiden sich.
- **Grenze:** echte Instanz-Config (Instance-ID, Secrets) kommt aus dem Bootstrap-/Cloud-Flow
  (③/④); für ①-Tests reicht eine lokale Fixture-Config.

## 8. Zerlegung des Gesamt-Programms (Kontext, nicht Teil dieser Spec)

- **① Embedded Backend-Bundle** — *diese Spec.*
- **② Erreichbarkeits-Schicht** — Cloud-Rendezvous/Signaling-Relay (nur Steuerung) + direkte Medien
  (STUN/UPnP/host-coturn) + Port-Forward-Assistent.
- **③ Electron-Orchestrierung + UX + Gating** — `LocalBackendManager`-UI, „Instanz hosten"-Flow,
  Lifecycle/Persistenz-Entscheidung, Anbindung an Bootstrap-Token + Monetarisierungs-Grant.
- **④ Cloud-Seite** — Bezahl-Gate vor dem vorhandenen Instance-Registry-Schalter + Betrieb des
  Signaling-Relays.

**Bau-Reihenfolge:** ① zuerst (alles hängt daran), dann ②/③ parallel, ④ begleitend.

## 9. Offene Detail-Entscheidungen (im Implementierungsplan zu klären)

1. **Ports:** feste Ports (8001–8005, 7880 …; einfach, kann auf fremdem Rechner kollidieren) vs.
   **dynamische Ports** (robuster, mehr Verdrahtung). *Tendenz: dynamisch.*
2. **Attachments-Backend:** lokaler FS-Adapter (leicht, portabel; ein neuer Code-Pfad) vs. MinIO-Binary
   (divergenzfrei, schwerer). *Tendenz: lokaler FS.*
3. **Service-Set:** Sind alle 5 Services auf Self-Host nötig (auth-svc evtl. trimmbar)? Am Code prüfen.
4. **Redis:** gebündeltes Binary (divergenzfrei, ~1–2 MB) vs. In-Process-Bus. *Tendenz: Binary.*

## 10. Außerhalb des Scope von ①

- Erreichbarkeit von außen / Relay / Port-Forwarding (②).
- „Instanz hosten"-UI, Modul-Download, Monetarisierungs-Freischaltung, Persistenz-bei-App-zu (③/④).
- TLS/Caddy nach außen (gehört zu ②).

## 11. Erfolgskriterien für ①

Ein freigeschaltetes Host-Modul lässt sich auf Linux/Windows/Mac headless hochfahren, läuft
Docker-frei gegen eine SQLite-Datei + FS-Attachments, und besteht den Smoke-Harness (Cert-Login →
Community → Nachricht → Voice-Call → HQ-Stream) — alles auf `localhost`, ohne Postgres/Docker/MinIO.
