# Heim-Server — Produktentscheide vom 2026-09-27

Ziel: Ein User installiert die Pulse-Server-App auf Windows, Mac oder Linux,
meldet sich mit seinem howispulse.com-Konto an — und betreibt ab da seinen
eigenen Server mit eigenen Communities. Kein Antrag, keine Freischaltung.
Diskutiert am 2026-09-27 mit Michael; diese Entscheide sind verbindlich.

## Die Entscheide im Einzelnen

| Frage | Entscheidung |
|---|---|
| Anmeldung am Heim-Server | **Nur Cloud-Konto** (howispulse.com). Keine lokalen Konten. Der bestehende Ticket-Login bleibt die einzige Identitätsquelle. |
| Selbstbedienung | Server registriert sich **automatisch** in der Cloud, wenn der Besitzer sich einloggt. **Kein Antrag, keine manuelle Freischaltung.** |
| Limit | **1 eigener Server pro Cloud-Konto** (serverseitig erzwungen). |
| Internet-Zugriff | **Direktverbindungen (P2P)** — die Cloud vermittelt nur (Telefonbuch + Signaling), der Traffic läuft zwischen den Rechnern. **Kein Relay** in V1: scheitert die Direktverbindung (strenges Heimnetz), kommt der Freund nicht rein. Bewusst akzeptiert. |
| Alte App-Host-Strecke | **Antrag + Freischaltung + Revoke fliegt komplett raus** (nicht parallel pflegen). |
| Verantwortung | **Der Server-Besitzer ist alleiniger Admin** seiner Communities. Kein Cloud-Zugriff auf seine Daten, kein externer Not-Aus. |
| Server-App-Form | **Kleines eigenes Fenster** (Status, Start/Stop, Backup) — wie die fertige `server.html`-Vorlage. Kein reiner Tray. |
| Updates | **Auto-Update an** für App (Update-Feed) und Container (Image-Pull). |
| HQ-Streaming auf Windows | **Muss in V1 funktionieren** — der bekannte Schannel-DTLS-Blocker wird behoben (RTMPS-Owner-Routing oder OpenSSL-FFmpeg; Entscheidung beim Umsetzen, TCP-Relay für 1936 liegt auf dem Branch bereit). |
| Plattformen | **Alle drei gleichzeitig** (Windows, macOS, Linux). |
| Browser-Zugang | Container-Caddy serviert die Web-UI im Heimnetz (LAN-Adresse); die Client-App führt den Heim-Server als weiteren Eintrag in der Server-Liste. |
| Vorbilder | Home-Assistant-Modell (lokaler Server + optionaler Cloud-Comfort), Nabu-Casa-Relay als spätere Monetarisierungsoption — **nicht** Teil von V1. |

## Explizit NICHT in V1

- Relay-/Rückfallweg für Internet-Verkehr (keine Traffic-Kosten bei uns).
- Föderation zwischen Heim-Servern (ein Konto gilt pro Server, wie bei Discord).
- Lokale Konten ohne Cloud.
- Cloud-Zugriff auf Heim-Server-Daten.

## Umsetzungs-Bausteine (Reihenfolge)

1. **Auto-Registrierung** (auth-svc): self-service Endpoint `POST /me/instances`
   (origin=app_host, 1 pro Konto, erzeugt `RegisteredInstance` + Creds +
   `PULSE_INSTANCE_OWNER_ID` = anmeldendes Konto). Ersetzt die Approval-Strecke.
2. **Server-App-Login**: bootet den Container mit den selbstbedienten Creds
   (gleicher Bootstrap-Weg wie bisher, nur ohne Approval-Schritt).
3. **Direktverbindungen für Mitglieder**: Telefonbuch-Lookup + Direct-Offer von
   owner-only auf Mitglieder öffnen (Weg-1-Einschränkung vom 2026-09-23 lockern).
4. **Alte Strecke abschalten**: Antrags-Route + Admin-Approve/Revoke für
   app_host entfernen bzw. auf 404/410 setzen; Bestands-Instanzen migrieren.
5. **Paketierung**: Merge von `feat/win-server-app-v2` (6 Konfliktdateien),
   Flatpak-Server-Build reaktivieren (Haken stehen kommentiert in flatpak.yml),
   macOS-Paket; HQ-Windows-Fix.

## Ausgangslage / Referenzen

- Bestand: All-in-One-Container (5 Services + Postgres/Redis/Caddy/LiveKit/
  Garage), Server-App-Shell (`server.html`/`server.js`/`hostLifecycle.ts`),
  Ticket-Login (`session_ticket.py`), Direktpfad-Adapter + Telefonbuch.
- `feat/win-server-app-v2` (Merge-Probe 2026-09-27): 6 Konfliktdateien, ~13
  Hunks — siehe Gesprächsnotizen; `docs/plans/2026-07-14-app-host-windows-status.md`.


## Plattform-Einschränkung Fernsteuerung (2026-09-28)

Ein Linux-Server-Rechner kann **nicht selbst** ferngesteuert werden — die
Input-Injektion existiert nur im win-hq-sidecar (Windows). Ein Linux-Rechner
KANN aber einen Windows-Rechner fernsteuern (die Fernsteuerung läuft im
Browser des Steuerenden). Für Windows-Owner ist die Fernsteuerung voll
verfügbar; für Linux-Owner eingeschränkt auf "steuern, nicht gesteuert
werden". Das ist eine Platform-Grenze, kein Bug.


## MediaMTX HLS + Keyframe-Parität (2026-09-28)

Der Self-Host-Container fuhr HLS (`hls: yes`) mit dem Standard-2s-Keyframe-Takt,
während die Cloud HLS abgeschaltet hat (`hls: no`) und mit
`PULSE_KEYFRAME_INTERVAL=0` smooth streamt (Vollbilder nur on-demand).

Behoben: Der Self-Host setzt jetzt `PULSE_KEYFRAME_INTERVAL=0` (smooth
streaming, wie die Cloud) und `hls: no` (kein Client spielt HLS; der Muxer
kann ohne periodische Vollbilder nicht segmentieren). Cloud-Parität.

## Mac-E2E 2026-09-28/29: komplette Kette auf einem Mac belegt

Setup: heim-server-Container lokal (podman machine, Branch-Image), Dev-Cloud
(`pulse.unicutmedia.com`) per `dev-sync --pull feat/heim-server --migrate
--web` auf Branch-Stand, dev2 (Owner, Electron) + dev3 (Mitglied, Electron-
Zweitinstanz UND reiner Browser). Alle Commits der Befunde liegen auf dem
Branch (812ffb35, d533b6ad, 6a7fa87e, 1f2f1a9e, c30dd9b5, 487d29fe,
e630ea0c).

**Grün belegt:**

- Mac-Paket: DMG baut, App bootet; Selbstbedienungs-Provisionierung (Login →
  Instanz angelegt → Bootstrap gemintet/eingelöst) → Container-Boot →
  Health 200 → „Server läuft.", 8 Minuten stabil.
- Owner-Flow im Client: Heim-Server erscheint account-basiert in der Liste,
  Direkttunnel steht, Community + Kanäle werden auf dem heim-eigenen Backend
  angelegt — die Cloud nur Vermittler (Ticket, Telefonbuch, Signaling).
- Mitglied-Beitritt per Einladungslink: dev3 → Cloud-Ticket → Membership →
  Telefonbuch → Tunnel → Redeem mit Invite-Code auf dem heim-eigenen Backend
  → in der Community; Chat-Nachricht live beim Owner.
- Dieselbe Strecke im **reinen Browser** (Chromium, ohne Desktop-App):
  Login, Rail, Tunnel, Senden — Cross-Device-Sichtbarkeit Electron ↔ Browser.
- RTMPS-Transport: TLS-Handshake auf dem publizierten 1936 mit dem
  instanzspezifischen Self-Signed-Zertifikat.

**Offene Baustellen, je mit lokalisierter Ursache:**

1. **Voice (V1.1, Ports + TLS-Entscheidung):** drei gestapelte Ursachen —
   LiveKit-Signal-Port 7880 ist nicht unter den publizierten Ports
   (`MEDIA_PORT_ARGS`), das Backend verkündet
   `wss://<Relay-Hostname>/livekit` (für Self-Service-Instanzen ohne Relay
   unauflösbar), und ein `ws://`-Rückfall wäre Mixed Content auf
   https-Seiten. Streaming-UI sitzt im Voice-Kontext und erbt die Lücke;
   WHEP (8889) ist zusätzlich unveröffentlicht.
2. **Registry-Parität:** Registry-Login mit Dev-Instanz-Creds scheitert an
   `registry.howispulse.com` (exit 125 — die Prod-Registry validiert gegen
   Prod-Auth). Lösung: eigene Registry je Cloud oder Ticket-Transfer.
3. **Keychain-Signierung:** ad-hoc-signierte Mac-Builds bekommen bei jedem
   neuen Binary den Safe-Storage-Schlüsselbund-Passwort-Dialog (keine
   stabile Designated Requirement). Braucht Developer-ID-Signierung oder
   ein anderes Cred-Ablage-Modell; betrifft auch den Mac-Client.
4. **`/invite/[code]`-Route:** im Web-Build nicht vorhanden (404) — der
   Client-Beitritt (Link ins Beitrittsfeld) funktioniert, der reine
   Browser-Weg über die URL noch nicht.

Testgrenzen ehrlich: keine Klang-/Latenzurteile, kein fremdes Netz (beide
Clients teilen sich das LAN/NAT), MediaMTX im Testcontainer war
upstream statt Fork.
