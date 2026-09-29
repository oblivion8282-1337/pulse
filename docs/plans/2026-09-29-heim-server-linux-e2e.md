# Heim-Server Linux-E2E — Übergabe (2026-09-29, abgebrochen auf halbem Weg)

*Zweck: Fortsetzung des Mac-E2E (s. `2026-09-29-heim-server-mac-uebergabe.md`) auf
Linux — die Server-App läuft hier NATIV (Host-Docker statt podman-VM). Stand:
Kette bis zur ICE-Weiche verifiziert, zwei Fixes committed, der Direktpfad-ICE
im Container ist als KERNBUG lokalisiert und hat eine belastbare
Fehlerkette — Details unten, dort weitermachen.*

## Was grün verifiziert ist (Reihenfolge der Kette)

1. **Server-App dev-bundle auf Linux:** `cd desktop && PULSE_URL=https://pulse.
   unicutmedia.com PULSE_HOST_IMAGE=pulse-allinone:heim-test node
   node_modules/electron/cli.js . --remote-debugging-port=9223`. Kein
   Keychain-Blocker wie am Mac; safeStorage via libsecret oder Klartext-Fallback
   (chmod-600-Store). Unit-Tests grün (`pnpm test:unit`).
2. **Takeover dev2:** Logout → Login dev2/test1234 → `#btnSetup` → 403 consumed
   → Takeover-Overlay → Redeem. Dev-Cloud hat Relay-Provisioning an: frische
   Instanz-Creds **mit Relay-Triple** (`merry-meadow-adbe.relay.unicutmedia.com`
   + `77.42.71.166:7000` + Tunnel-Token). Die Mac-Instanz ist damit resettet
   (abgesprochen).
3. **Container pulse-host:** lokal gebautes Image `pulse-allinone:heim-test`
   (`docker build -f infra/self-host/Dockerfile …` vom Repo-Root; Registry-
   Parität Baustelle 2 umgangen via `PULSE_HOST_IMAGE`, greift ungepackt).
   Health `127.0.0.1:55580/api/chat/health` ok, alle 3 `PULSE_RELAY_*`-Vars im
   Container, frpc „Konfiguration gerendert".
4. **Relay-Tunnel:** frps registriert Tunnel-Login, vhost-Loopback-Curl auf
   Hetzner (`curl -H 'Host: merry-meadow-adbe.relay.unicutmedia.com'
   http://127.0.0.1:8081/api/chat/health`) → `{"status":"ok"}`. Volle Kette
   frpc → frps → Container-Caddy steht.
5. **Ticket-Mint:** `POST /api/auth/me/server-ticket` mit Session → 200
   (nach Fix 1, s. unten).

## Fix 1 — Backend (committed): server-ticket löst Relay-Subdomain auf

`routes_server_ticket.py` suchte nur in der Spalte `hostname` (synthetisch
`app-<id>.<relay_base>`), Clients melden aber die Relay-Subdomain (genau die
meldet `GET /me/instances` für app_host und die Server-App als Adresse). Ohne
allozierte Relay-Subdomain fielen beide Werte nicht auf — deshalb fiel der 404
erst jetzt auf („not found" beim Community-Erstellen). Fix: zweistufige
Auflösung, exakter hostname-Treffer gewinnt, sonst `relay_subdomain`. Test:
`test_relay_subdomain_loest_auf_die_instanz_auf` in
`test_server_ticket_route.py` (9/9 grün).

⚠️ Dev-Cloud-Status: der Fix läuft dort bereits — via `scripts/dev-sync.sh`
(lokaler Quellstand, NICHT git). Auf der neuen Maschine nach dem Pull also
einmal `scripts/dev-sync.sh --pull --branch feat/heim-server` (oder lokal
syncen), sonst 404-Wiederholung. Achtung: uvicorn lädt beim dev-sync teils
VERZÖGERT neu („binnen 2 s" galt nicht immer) — vor erneutem Client-Versuch
per `curl -X POST https://pulse.unicutmedia.com/api/auth/me/server-ticket`
prüfen: 401 = Route lebt, 404 = noch alter Stand.

## Fix 2 — Adapter (committed): mDNS-Fernkandidaten discarden + Trace-Logger

`rtc.rs`: `set_ice_multicast_dns_mode(MulticastDnsMode::Disabled)`, `main.rs`:
`env_logger::init()` (RUST_LOG wirkt jetzt; vorher verschwanden webrtc-Logs
im Nirvana). `Cargo.toml`: env_logger-Dep. Begründungskommentar im Code.

## Der offene Kernbug: Direktpfad-ICE im Container (HIER WEITERMACHEN)

**Symptom:** Client-Dial (Community erstellen / Ticket einlösen) →
„Server nicht erreichbar". Browser-ICE gegen den Adapter: checking →
disconnected.

**Befundkette (alles belegt, Reihenfolge der Diagnose):**
1. Telefonbuch/Heartbeat ok (Kandidat 62.46.226.39:7900, online:true), Signal-
   weg ok (direct-offer → 200 mit Answer), container.env ok.
2. TCPDUMP im Container-Netzns: Chromes Checks (112-Byte-STUN mit
   USERNAME/INTEGRITY/FINGERPRINT) kommen mit ~8/s auf eth0 an. NICHTS geht
   raus. Gleichzeitig antwortet coturn im SELBEN Container auf demselben
   Published-Port-Weg problemlos → UDP-Pfad Host→Container ist heil
   (DNAT + docker-proxy, checksums ok).
3. Kontrollexperiment auf dem Host (/tmp/mux-test, gleiche webrtc-rs-Crate
   0.17.1, minimaler Nachbau des Mux): Browser ↔ Mini-Mux → **VERBUNDEN**.
   webrtc-rs↔webrtc-rs Loopback → VERBUNDEN. Crate-Kern und Chrome-Interop
   sind grundsätzlich ok — ABER der erste „Mini-Mux scheitert"-Befund war ein
   Harness-Artefakt (Prozess wurde nach der Answer gekillt).
4. **Adapter-Trace mit RUST_LOG (der entscheidende Befund):**
   - `remote mDNS candidate added, but mDNS is disabled` — Fix 2 greift.
   - `ERROR agent_gather: Failed to gather local candidates using UDP mux:
     Candidate IP could not be found` ← **DAS ist der Kern.**
   - `pingAllCandidates called with no candidate pairs` endlos.
   - `Dropping packet from 192.168.178.72:<port>` für JEDEN Chrome-Check.

**Deutung:** Der Agent hat KEINE lokalen Kandidaten: im Container ist die
einzige Interface-IP 172.17.0.2 — und `is_useful_candidate_ip` (rtc.rs)
filtert 172.16-31 als Docker-Bridge weg → Gathering findet nichts und bricht
mit „Candidate IP could not be found" ab → der Agent registriert sich nie an
der UDPMux → alle Checks werden ungeroutet gedroppt. Die Kandidaten in der
Answer (192.168.178.72 host + 62.46.226.39 srflx) sind reine SDP-Injektionen
(`inject_extra_hosts`/`inject_srflx`) — es steht nichts dahinter. Warum das
auf dem Mac (Sep 28) grün war: ungeklärt — plausibel, dass der Mac-Lauf mit
einem älteren Registry-Image ohne das ip_filter-Setup fuhr oder die
Direktpfad-ICE dort nie durch den Published-Port-Pfad ging (lokal getestet
wurde der Adapter nur mit `--network host`, s. `heim-server-lauf.py`).

**Nächste Schritte (Vorschlag, Reihenfolge):**
1. Gathering im Container zum Erfolg bringen. Optionen: `is_useful_candidate_ip`
   nur auf INJIZIERTE/gatherete SDP-Kandidaten anwenden und den Agenten intern
   die 172.17er-IP behalten lassen (die Answer-Injektion überschreibt eh);
   oder `set_nat_1to1_ips([public/lan-ip], Host)` statt Injektion. Ziel:
   Agent hat ≥1 lokalen Kandidaten, Mux-Registrierung passiert, Checks werden
   beantwortet.
2. Verifizieren mit dem bewährten Protokoll: manual-ICE-Probe per Playwright
   (offer → direct-offer → answer → ICE-State), `docker logs | grep webrtc_ice`
   (RUST_LOG funktioniert jetzt), tcpdump im Netzns (`nsenter -t
   $(docker inspect pulse-host --format '{{.State.Pid}}') -n tcpdump -i eth0…`).
3. Danach Chat-E2E (dev2 Community + dev3 Beitritt, Chromium via
   `scripts/cdp/launch.fish`), dann Voice-E2E.

## Weitere Befunde / Fallstricke dieser Session

- **Wildcard-DNS fehlt weiterhin:** `*.relay.unicutmedia.com → 77.42.71.166`
  ist NICHT im Registrar gesetzt (`dig` leer). Blockiert nur den Voice-E2E
  (wss://<subdomain>.relay…/livekit) — und zwar hart: auch /etc/hosts hilft
  nicht, weil Caddy-on-demand-TLS ohne erreichbare Domain kein Cert zieht.
- **MediaMTX-Portkollision:** der lokale Dev-Stack belegt 1936/tcp + 8189/udp
  (Container braucht beides) → `docker stop streaming-mediamtx` vor Container-
  Start (rückholbar mit `docker start streaming-mediamtx`).
- **pkill ist hier wirkungslos** (ZCode-AppImage-Shadowing, steht auch im
  AGENTS.md) — und `pgrep -f <muster>` matcht die eigene Wrapper-Shell: kill
  nur per PID aus `ss -ulnp`/`docker inspect`.
- **drive.mjs eval truncates ~400 Zeichen** — für lange Rückgaben Playwright
  direkt nutzen (`require('@playwright/test')` aus `web/`).
- **uvicorn-Reload auf der Dev-Cloud verzögert teils** (Minutes, nicht 2 s) —
  siehe Warnung oben bei Fix 1.
- **Weiche transport.ts:** app_host ist direct-only (kein stiller Relay-
  Fallback) — deshalb blockiert der ICE-Bug ALLE app_host-Chats, obwohl der
  Relay-Tunnel grün steht. Der Relay-Hostname-Pfad wird nur für Voice-Signal
  genutzt.
- **`/invite/[code]`-Route fehlt im Web-Build weiterhin** (Baustelle 4) — der
  Beitritt läuft über das Join-Dialog-Pastefeld (`parseJoinInput`), deshalb
  nicht E2E-blockierend. Unangetastet.
- Container auf DIESER Maschine läuft manuell erzeugt (mit `-e RUST_LOG=
  webrtc_ice=trace,webrtc=info`) — für sauberen Zustand: `docker rm -f
  pulse-host` und über die Server-App neu starten. Dev-Profil der Server-App:
  `~/.config/Pulse Server`, CDP 9223; dev2/dev3-Chromiums auf 9225/9226
  (`scripts/cdp/launch.fish <port> <suffix> https://pulse.unicutmedia.com`).
- Hetzner-Relay-Stack (pulsetest_frps/relay_plugin/auth) lebt und ist unangetastet;
  Prod-Rollout bleibt wie im Mac-Dok beschrieben „nur zwei Env-Vars".
