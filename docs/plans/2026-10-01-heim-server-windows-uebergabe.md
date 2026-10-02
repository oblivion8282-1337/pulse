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

## Windows-E2E (2026-10-01, dieser Rechner) — KETTE GRÜN

Abfolge live gelaufen: Dev-Lauf (`PULSE_BUILD_MODE` via `esbuild --server`,
`PULSE_URL=https://pulse.unicutmedia.com`, `PULSE_HOST_IMAGE=
pulse-allinone:heim-test`) → Login dev2 → Übernahme konsumiert →
`needs-windows-setup`-Phase korrekt → WSL2-Assistent aus der App (UAC) →
`podman machine init` → lokal gebautes Image → Container healthy →
Host-Relays (7900/udp + 1936/tcp) → **Verbindungs-Check 16/16 grün**.

E2E-Grün: Chat über DataChannel (`heim-chat-cloud-e2e.mjs`), Voice
(`heim-voice-cloud-e2e.mjs`, Signal über Relay-TLS, Audiospur beidseitig),
Streaming (`heim-stream-cloud-e2e.mjs`, 50 Frames dekodiert + MediaMTX-Logs),
**RTMPS-Ingest über den Host-tcpRelay** (neu `heim-rtmps-relay-probe.mjs`:
ffmpeg aus ffmpeg-dist, `h264_mf` — LGPL-Build hat kein libx264 — pusht auf
127.0.0.1:1936; MediaMTX loggt die Verbindung von 172.20.160.1, dem Host-Ende
des WSL-NAT). Sidecar-Smoke: health `available:true`, vendor amd,
`remote_input:true`, h264/hevc/av1, 10-bit + HDR.

**Produktive Bugs gefunden + gefixt:**
- `f3d08ddd` — `vmIpAusIpAusgabe` nahm die WSL-DNS-Pseudoadresse
  (10.255.255.254 auf `lo`, „scope global") als VM-IP → Health-Poll/Relays
  ins Leere. Loopback-Blöcke werden jetzt ganz übersprungen.
- `c24f53d5` — `eebf1230` (Zweisprachigkeit) hatte den
  `host:verbindungstest`-Handler-Kopf samt Security-Guard gelöscht; der Body
  hing tot im `dataInfo`-Handler (Check tot, Datenkarte `push is not
  defined`). Rekonstruiert; `S`/`deutsch` definiert; Health-Glied auf Windows
  jetzt gegen VM-IP:8080 statt den nie gebundenen 55580.

**Umgebungs-Befunde:** Windows-Uhr ging 2 h nach (bremst den Image-Bau über
Debian-Release-Files; `w32tm /resync` + VM-Uhr nachziehen), Image-Bau braucht
ghcr-Login mit `read:packages` (MediaMTX-Fork), Checkout muss LF sein
(`core.autocrlf=false` + Renormalize — s6-Scripts sonst `bad interpreter`),
Autostart-Run-Key wird bei der Übernahme gesetzt (Produktverhalten, App startet
beim Boot und fährt die Machine hoch), Login hielt Reboot via safeStorage.

**Offen auf Windows:** echter Owner-Stream aus dem Client-UI (Sidecar-Klickweg
bei laufender App — Serverseite + Relay + Sidecar health sind einzeln grün),
Fernsteuerungs-Injektion interaktiv (bewegt den echten Zeiger — Klicktest),
Extern-ICE von der Hetzner-Box (SSH-Key fehlt auf diesem Rechner; Linux-
Referenz `54c4e82b`-Beweis steht, Container-Image identisch).

## Übergabe-Paket (Abend 2026-10-01): Voice/WHEP aus dem LAN auf Win-Hosts

**Befund live (Linux-Client `dev` → Win-Host `dev2`):** Voice-Beitritt hing im
„Verbinden" — Signal kam über den Relay-Tunnel durch („connected to Livekit
Server"), aber **kein einziges Medienpaket** fand einen Weg Host→VM. Ursache
war doppelt und bewusst offen gewesene Lücke: das Host-UDP-Relay spiegelte nur
den Chat-Port 7900, und LiveKit/MediaMTX in der VM kündigten nur VM-interne
(172.x) bzw. WAN-hinter-Doppel-NAT-Adressen an — beide für fremde Geräte tot.

**Umgesetzt (dieser Push):**

1. `containerBackendManager.ts` — `RELAY_UDP_PORTS` spiegelt jetzt neben 7900
   auch LiveKit-ICE 7882–7892 und WHEP-ICE 8189 in die VM; im Win-Betrieb
   rendert die Env zusätzlich `PULSE_VM_ANNOUNCE_IP=<erste Host-LAN-IP>`.
2. `05-init-livekit.sh` — bei gesetztem `PULSE_VM_ANNOUNCE_IP`: STUN aus
   (`use_external_ip: false`) und die Host-LAN-IP als `node_ip` ankündigen.
   pion schreibt damit die Kandidaten-IP um, Ports bleiben; der Medienweg
   läuft über die UDP-Relays auf genau dieser Adresse. Linux-App-Hosts setzen
   die Variable nicht → dort bleibt der bewiesene STUN/srflx-Weg unangetastet.
3. `08-init-mediamtx.sh` — gleiche Logik für WHEP:
   `webrtcAdditionalHosts: [<Host-LAN-IP>]` im App-Host-Zweig.
4. Tests: `containerBackend.test.ts` deckt Relay-Portliste + Env-Rendering ab
   (`pnpm test:unit` 250/250 grün); Template-Render beidseitig YAML-valide
   geprüft (mit/ohne VM-Env).

**Auf dem Windows-Rechner (Reihenfolge):**

1. `git pull` im Checkout, dann **Image neu bauen** (die s6-Skripte sind im
   Image gebacken), vom Repo-Root — Tag wie beim E2E-Lauf:
   ```powershell
   podman build -f infra/self-host/Dockerfile `
     --build-arg PULSE_VERSION=$(git rev-parse --short HEAD) `
     -t pulse-allinone:heim-test .
   ```
2. Server-App starten und Welt anlassen — `start()` rendert die Env neu und
   **recreates** den Container, nimmt also neues Image + neue Env mit. Log-
   zeichen: `[udp-relay] Host→VM … aktiv für UDP 7900, 7882, …, 8189` und
   `[05-init-livekit] VM-Betrieb: node_ip=…`.
3. **Firewall:** beim ersten UDP-Bind fragt Windows („Zulassen?" — private
   Netzwerke → Ja). Kommt die Frage nicht, in einer Admin-Powershell:
   ```powershell
   netsh advfirewall firewall add rule name="Pulse Voice-ICE" dir=in action=allow protocol=UDP localport=7882-7892
   netsh advfirewall firewall add rule name="Pulse Chat-ICE"  dir=in action=allow protocol=UDP localport=7900
   netsh advfirewall firewall add rule name="Pulse WHEP-ICE"  dir=in action=allow protocol=UDP localport=8189
   ```
4. **Verifikation Cross-Gerät** (der eigentliche Beweis, den das Windows-E2E
   noch nicht hatte): vom **Linux-Rechner** den Voice-E2E gegen die Win-Instanz
   fahren — `heim-voice-cloud-e2e.mjs` (Vite 5273 mit Cloud-Proxy, wie im
   Skriptkopf; Owner dev2, Gast dev3). Erwartung: GRÜN beidseitig mit
   Audiospur. Danach der Klickweg: `dev` meldet sich im Linux-Client an und
   betritt den Voice-Kanal; Ton muss stehen.

**Bekannte Decken (bewusst so):**

- `PULSE_VM_ANNOUNCE_IP` = **eine** IPv4 (`hostLanIpv4s()[0]`) — LiveKit nimmt
  in `node_ip` nur ein IPv4 (zweite = Config-Fehler). Bei mehreren aktiven
  NICs kann die falsche gewählt sein; der Verbindungs-Check zeigt es.
- **Internet-Gäste** bleiben auf Win-Hosts außen vor: ohne srflx-Nutzung gibt
  es nur LAN-/VM-Kandidaten. Der nächste Schritt dafür ist TURN (coturn läuft
  im Image, wird aber noch an keinen Client gereicht) bzw. Router-Mapping —
  eigenes Stück, erst LAN beweisen.
- macOS unberührt (Publish-Pfad über gvproxy, eigener offener Punkt), Linux
  unberührt (Verhalten bitidentisch, keine neue Env-Variable dort).

## Merge-Tag — Checkliste (2026-10-02, ABGESCHLOSSEN bis auf Rauchprobe)

Netcup-Inspektion 02.10.: Die komplette Relay-Infra steht auf Produktion
(DNS-Wildcard ✓, Caddy on-demand-TLS mit Ask-Verkabelung ✓, frps + Auth-
Plugin ✓, Registry mit `pulse-allinone:stable` + Token-Auth ✓). **Einziger
Blocker: `/selfhost/relay/tls-check` antwortet auf Prod 404** — der Endpunkt
kommt mit diesem Merge, der VPS-Cron rollt ihn 5 Min danach automatisch.

**Erledigt (02.10., PR #486 → `7d5154a4`):**

1. ✅ Gate grün (2×: vor + nach dem Bump; backend/web/desktop/infra gestempelt).
2. ⏳ Windows-Klicktests (Owner-Stream, Fernsteuerung) — bewusst VERSCHOBEN.
3. ✅ Bump 0.1.92 + Changelog (2aeb6835; native.json korrekt unberührt).
4. ✅ PR #486 „merge: Heim-Server 2026-10-02", admin-merge; PR-CI komplett grün
   (backend 16 Min gegen frische DB, frontend, zwillinge, CLA). Ein
   Merge-Konflikt (changelog.json 0.1.92 vs. 0.1.91-Stand) vorab aufgelöst —
   beide Einträge verkettet.
5. ✅ tls-check LEBT: 422 ohne Parameter (Route da), 404 für unbekannte
   Subdomain = korrekte Handler-Antwort. **Achtung Proben-Falle: 404 ist hier
   ein GÜLTIGER Code (unbekannte Domain); die Route beweist nur die 422.**
6. ✅ Alle sechs CI-Straßen grün: ci (Images), flatpak (beide Apps +
   flatpakrefs), win-build-server (0.1.92), win-build, mac-build, allinone
   (Registry: `sha-7d5154a` + :stable/:edge rollt).
7. ✅ Downloads erreichbar: `updates/win-server/latest.yml` → 200 mit
   `version: 0.1.92`; beide `.flatpakref` → 200.

**Zwei Infra-Nachzüge, die der Merge NICHT allein brachte** (gleiche Klasse wie
die Garage-Migration: Images rollt der Cron, Infra nicht):

- **Compose-Drift**: Die Mount-Zeile `updates-win-server` + Garage-Env-Block
  lagen im Repo, aber nicht in `~/pulse/infra/prod/docker-compose.yml` auf dem
  VPS → `pulse_web` hatte den Mount nicht → Feed 404. Fix: compose rsync +
  `docker compose up -d` (Garage-Secrets waren dank damaliger Migration schon
  in der `.env` — die `:?`-Pflichtprüfung wäre sonst reingelaufen).
- **scp-Verzeichnisrechte**: Der CI-Upload legte `~/pulse/updates-win-server/`
  mit `drwxr--r--` an → nginx (Nicht-Root im Container) kam nicht hinein →
  403. Fix: `chmod 755`. Auf einem FRISCHEN Server wiederholt sich das beim
  ersten win-build-server-Lauf — dort an das chmod denken (oder im Workflow
  einen ssh-chmod-Schritt nachziehen).

**Offen:**

8. ⏳ **Rauchprobe gegen Produktion**: Linux-Flatpak Server-App (installiert,
   `flatpak run com.howispulse.PulseServer`), Einrichtung als dev-Konto gegen
   Produktion — KEINE PULSE_URL/PULSE_HOST_IMAGE-Overrides! Beweist: Cloud-
   Provisionierung → Image-Pull aus registry.howispulse.com mit Instanz-Creds
   → frps-Tunnel → Caddy-TLS (tls-check am echten Fall, jetzt endlich 200) →
   Verbindungs-Check 16/16. Danach zweites Gerät: Chat/Voice/Stream via Relay.
   Serverseitig: `docker logs pulse_frps --tail 50` (Login/NewProxy),
   Caddy-Cert-Log, Registry-Pull in den auth-Logs.
9. ⏳ Downloads-Seite (web) um „Pulse Server" erweitern (Windows .exe, beide
   Flatpak-Refs, macOS-DMG).
10. ⏳ Windows-Code-Signing extern anstoßen (Security-Priorität 1; bis dahin
    SmartScreen-Warnung beim ersten Installer).
11. ⏳ TURN-Follow-up (Internet-Gäste an Win-Heimservern).
12. ⏳ Windows-Klicktests (siehe 2) + Mac-Echtgerätetest des Medienwegs.
