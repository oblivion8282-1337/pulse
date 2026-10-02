# Heim-Server Mac-E2E — Übergabe an den Rechner (2026-09-29)

*Zweck: der Mac-E2E steht kurz vor dem Voice-Abschluss (Variant A, s.
`2026-09-29-voice-signal-varianten.md`) und wartet auf zwei manuelle Schritte:
die Keychain-Freigabe (nur vor Ort möglich) und einen DNS-Eintrag. Dieses
Dokument enthält Zustand, exakte Schritte und alle Fallstricke.*

## Zustand auf dem Mac (Stand: Session-Ende 2026-09-29)

- Branch `feat/heim-server`, alles gepusht (Stand `b1e85b2f` + Docs-Cherry-Picks).
- **Läuft:** heim-server-Container (`pulse-host`, Health 200 via
  `127.0.0.1:55580/api/chat/health`), Server-App (dev-Bundle, CDP-Port 9223),
  dev2/dev3-Clients (CDP 9225/9226 — nach Bedarf neu starten, Kommandos unten).
- **BLOCKER:** der Keychain-Dialog „Pulse Server Safe Storage" wartet auf das
  Mac-Passwort und blockt den Renderer der Server-App per sync-IPC — alle
  CDP-Steuerungen hängen, bis er bedient ist.

## Schritt 0 — Keychain freigeben (nur vor Ort)

Dialog **„Immer erlauben"** + Mac-Login-Passwort. Der ACL-Eintrag gilt für
DIESEN Build (silent boots danach). Falls der Dialog inzwischen weg ist, ohne
freigegeben zu sein: Server-App neu starten (Kommando unten), er kommt wieder.
Hintergrund: ad-hoc-Signatur ⇒ jedes neue Binary braucht die Freigabe erneut;
`--use-mock-keychain` wirkt auf Electron 43 NICHT für safeStorage (empirisch).

Startkommando der Server-App (nach der Freigabe OHNE Mock-Flag testen):

```sh
cd ~/Documents/pulse/desktop
PULSE_URL=https://pulse.unicutmedia.com \
  node node_modules/electron/cli.js . --remote-debugging-port=9223
```

## Schritt 1 — Cloud-Session erneuern + Re-Provisionierung (Takeover)

Die Cloud-Session der Server-App ist abgelaufen (Refresh-Kette tot nach
Stunden idle): provision meldet „Nicht eingeloggt — bitte zuerst einloggen".
Die Dev-Cloud hat inzwischen das Relay-Provisioning AN
(`PULSE_RELAY_SERVER_ADDR=77.42.71.166:7000`, `PULSE_RELAY_BASE_DOMAIN=
relay.unicutmedia.com`) — ein frisches Redeem alloziert daher
`relay_subdomain` + Tunnel-Token (Code: `routes_selfhost_bootstrap.py`,
Gate: `pulse_relay_provision_enabled` + `pulse_relay_server_addr`).

Ablauf (UI oder per CDP auf 9223 — **Evals nie über Navigationen hinweg**,
der JS-Kontext stirbt; Schritte einzeln fahren):

1. `#btnLogout` klicken → Fenster geht aufs howispulse-Login.
2. Login dev2 / test1234 → Login-Watch bringt zurück auf `server.html`.
3. `#btnSetup` klicken → Mint ohne Reset → 403 „consumed" → **Takeover-
   Overlay** → `#btnTakeover` bestätigen (reset) → Redeem → neue Creds
   **jetzt mit Relay-Feldern** → „Bereit." + Startknopf.

## Schritt 2 — Container mit Relay-Env neu starten

Laufenden Container stoppen (`resources-podman-mac/podman stop pulse-host`
aus `desktop/` oder App-Stop), dann Startknopf — der Start schreibt das
frische `container.env` (inkl. `PULSE_RELAY_SUBDOMAIN/SERVER_ADDR/TUNNEL_
TOKEN`) und recreatet.

Verifizieren:

```sh
cd desktop
resources-podman-mac/podman exec pulse-host env | grep PULSE_RELAY   # 3 Vars
resources-podman-mac/podman logs pulse-host | grep frpc              # „Konfiguration gerendert"
resources-podman-mac/podman logs pulse-host | grep -i "frpc\] "      # Login/Proxy-Meldungen
```

## Schritt 3 — Relay-Registrierung prüfen (auf dem Dev-Server)

```sh
ssh michael@77.42.71.166
docker logs pulsetest_frps --since 10m | grep -iE "login|proxy"   # Tunnel-Login + NewProxy
# Tunnel-Durchstich OHNE DNS (vhost-Loopback 8081 + Host-Header):
curl -s -H 'Host: app-98115546603589632.relay.unicutmedia.com' \
  http://127.0.0.1:8081/api/chat/health
```

Erwartung: `{"status":"ok"}` — dann steht die ganze Kette
frps → Tunnel → Container-Caddy (`:8080` hat das volle Routen-Set inkl.
`/livekit`).

## Schritt 4 — DNS (manuell) + Voice-E2E

1. Wildcard-A-Record: `*.relay.unicutmedia.com → 77.42.71.166` (Registrar).
   Der Caddy-Vhost-Block `*.relay.unicutmedia.com → frps:8080` steht schon
   (Backup der alten Caddyfile: `~/caddy/Caddyfile.bak-20260929-relay`).
2. Voice-Test: dev2 + dev3 im Sprachkanal „Sprachraum" (Heim-Test) beitreten.
   Erwartung: Signal über `wss://<hostname>/livekit` (durch Cloud-Caddy +
   Tunnel), Media direkt per UDP (STUN-Announce, Ports 7882-7892). Prüfen:
   Container-Log `voice_reconcile_ok rooms≥1` + LiveKit-Teilnehmer im Client.
   Nicht prüfbar automatisiert: Klang.

## Dev-Cloud-Relay-Stack (deployt, 2026-09-29)

- `~/pulse-test/relay-compose.yml` + `frps.toml` → Container
  `pulsetest_frps` (7000 frpc, 8081→8080 Loopback-VHOST) +
  `pulsetest_relay_plugin` (Auth gegen `http://auth:8000`, Netz
  `pulse-selfhost-net`).
- Caddy: Block `*.relay.unicutmedia.com → frps:8080`; Backup
  `~/caddy/Caddyfile.bak-20260929-relay`.
- Auth-Env: `~/pulse-test/.env` + `docker compose up -d --force-recreate auth`.
- **Prod-Rollout später:** frps + Plugin laufen dort schon — nur dieselben
  zwei Env-Vars an den auth-Service (`PULSE_RELAY_SERVER_ADDR`,
  `PULSE_RELAY_BASE_DOMAIN=relay.howispulse.com`) und fertig.

## Fallstricke aus der Session (gesammelt)

- **Keychain:** gleiche Binary = stiller Boot; Rebuild (ad-hoc neu signiert)
  = neuer Dialog. Restliste-Punkt: Developer-ID-Signierung.
- **`alert()` blockt den Renderer:** CDP `Page.handleJavaScriptDialog`
  oder App-Neustart. Symptom: Evals hängen ohne Fehler.
- **CDP-Evals nicht über Navigationen hinweg** (Logout/Login): Kontext stirbt,
  Await-Promise hängt ewig — Schritte einzeln fahren.
- **Prozesse killen:** Muster `node_modules/.pnpm/electron@` (trifft Main +
  Helper). „Pulse Server" im ps-Muster greift nicht zuverlässig.
- **Client-Statistikzeile** braucht `PULSE_PLAYER_STATS_LOG=1`.
- **Web-Änderungen live schalten:** `scripts/dev-sync.sh --web` (der Client
  lädt die Web-App von der Dev-Cloud, nicht lokal).
- **Cherry-Pick-Nachtrag aus alten Branches (2026-09-29):** Baustein-Vergleich
  (758afaf8), Self-Host-Auto-Update-Entwurf + Drift-Notiz zu
  `selfhost.unicutmedia.com` (e1e11552, 48584a93). Die Branches
  `feat/win-server-app-v2` (vollständig gemergt),
  `docs/baustein-vergleich-2026-09-05` und
  `docs/selfhost-auto-update-entwurf` sind danach vom Remote gelöscht.
