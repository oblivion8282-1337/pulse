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
