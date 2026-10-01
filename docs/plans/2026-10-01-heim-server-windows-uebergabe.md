# Heim-Server — Windows-Übergabe (2026-10-01)

*Zweck: Weiter geht es mit **Windows** — dem letzten großen ungetesteten Feld.
Linux ist abgeschlossen (siehe `2026-09-29-heim-server-linux-e2e.md`, Abschnitte
„Zweiter Testtag" und „Benutzer-Welten"). Dieser Text fasst den Stand zusammen
und gibt die Windows-Testreihenfolge vor.*

## Branch-Stand

`feat/heim-server`, alles gepusht. Die wichtigsten Commits der letzten Tage:
`54c4e82b` Direktpfad-ICE-Fix · `326e1bde`/`dee5f997` Benutzer-Welten + Fixes ·
`54f381d3` Verbindungs-Check mit Medien-Gliedern · `eebf1230` Zweisprachigkeit ·
`4079b233` Check-Begründungen + Deutsch.

## Wo Linux steht (Referenz, nicht nochmal zu testen)

- **Alles grün:** Server-App (Einrichtung/Übernahme/Start/Stopp/Autostart),
  Benutzer-Welten (Anmeldung startet die Welt des Kontos, Abmelden stoppt sie,
  Daten bleiben je Konto im eigenen Volume), Direktpfad-ICE aus Heimnetz **und
  Internet** (extern von der Hetzner-Box bewiesen), Chat über DataChannel,
  Voice (LAN + extern), Streaming (WHIP/WHEP über die Relay-Kette),
  Verbindungs-Check (16 Glieder App + 10 Web, inkl. Sprache-Signalweg und
  WHIP/WHEP-Rundtrip), Backup→Restore, Zweisprachigkeit de/en, Security-Scan
  der neuen Flächen (M1: On-Demand-TLS-Ask prüft jetzt echte Subdomains).
- **Server-Name:** App-Hoster benennt seinen Server im Client unter
  `/app/admin` → „Server-Name" (ganz oben) — erreicht alle Mitglieder über den
  ready-Frame. Live gesetzt: devs Welt heißt „Michaels Server".
- **Dev-Cloud-Zustand:** `*.relay.unicutmedia.com → 77.42.71.166` im DNS
  (User), Caddy-Ask auf `/selfhost/relay/tls-check` umgestellt (Ghost-Certs
  ausgeschlossen), auth-Service mit neuem Diagnose-Zweig deployt.
  Instanzen auf der Dev-Cloud: **dev2** (98115546603589632, Linux-Legacy-Welt,
  gestoppt) und **dev** (99084438121484288, „Michaels Server", läuft auf dem
  Linux-Rechner). Für Windows-Tests: viertes Konto anlegen oder Übernahme —
  **1 Server/Konto**.

## Windows — was getestet werden muss (Reihenfolge)

1. **Server-App auf echter Windows-Hardware** (der große Block):
   - Installation/Erststart; Dev-Lauf NUR mit `PULSE_BUILD_MODE=server` +
     `PULSE_URL=https://pulse.unicutmedia.com` + `PULSE_HOST_IMAGE=…` — ein
     barer `electron .` lädt die Produktions-UI (howispulse.com), lassen!
   - Container-Runtime: Podman/WSL2-Sonderwege der App (Phase
     `needs-windows-setup` → WSL2-Assistent; Windows nutzt `--network host`
     IN der VM + `udpRelay`/`tcpRelay` vom Host — genau diese Schichten sind
     nie live gelaufen).
   - Einrichtung als eigenes Konto (z. B. neues dev4) → Provisionierung
     erstellt die Instanz; **oder** Übernahme (Reset!) — vorab entscheiden.
   - Verbindungs-Check direkt nutzen: er zeigt die Windows-Netz-Sonderwege
     als Glieder (Container, Gesundheit, Medien) mit Handgriffen.
2. **Direktpfad + Chat** vom zweiten Gerät (wie auf Linux).
3. **Voice** — Fake-Mikrofon-Muster aus dem Memory oder echtes Mikrofon.
4. **HQ-Streaming vom Windows-Host** — der einzige nie gelaufene Medienweg:
   Owner streamt per **RTMPS** (Port 1936/TCP, Owner-Routing), Zuschauer WHEP.
   `win-hq-sidecar` braucht das gebaute `.exe` + FFmpeg-DLLs; im Dev-Lauf per
   `PULSE_HQ_SIDECAR`-Äquivalent (`resolveBinaryPath`, siehe `sidecar.ts`).
5. **Fernsteuerung** — nur der Windows-Host kann ferngesteuert werden
   (Linux-Grenze); Remote-Input-Flag + WHEP-Knopf sind serverseitig geprüft.

## Windows-Fallstricke aus dem Code (noch nicht am Gerät verifiziert)

- Rootless-Podman/WSL2 leitet eingehendes UDP NICHT über published Ports →
  deshalb `--network host` in der VM + UDP-Relay vom Host. Der Verbindungs-
  Check muss zeigen, ob Ton/Bild so durchkommen.
- `MEDIA_PORT_ARGS`/`MEDIA_MAP_UDP` (PortMapper, NAT-PMP/PCP) müssen mit den
  published Ports übereinstimmen — im Lochungs-Modus der Server-App wird das
  Mapping bewusst NICHT gesetzt (ICE locht selbst, wie an der Fritz!Box
  bewiesen). Falls Windows-Basis rot bleibt: hier ansetzen.
- Registry-Pull ist Baustelle 2: Tests laufen mit `PULSE_HOST_IMAGE` auf einem
  lokal vorhandenen Linux-Image (Podman kann das ziehen/bauen).

## Offen (unabhängig von Windows)

- Merge nach `main` → erst ab dort: Windows/Mac-CI-Builds, Registry
  (Baustelle 2: `registry.howispulse.com`-Pull mit Instanz-Creds), Downloads.
- Auto-Update-Verfahren (Design steht, §6 Signierschlüssel offen).
- Security-Strang: Windows-Code-Signing (extern, Priorität 1 des Scans).
- Stufe 3 des Verbindungs-Checks (Freund-Ansicht: echter Browser-ICE-Check im
  Beitritts-Dialog; Muster: `heim-ext-ice-probe.cjs`).
- Export-Dateidialog einmal von Hand klicken (Payload ist bewiesen).
- Zweitinstanz-Client-Weltwechsel ungetestet (Server-App getestet).
