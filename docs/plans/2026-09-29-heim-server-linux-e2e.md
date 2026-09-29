# Heim-Server Linux-E2E — Übergabe (2026-09-29)

*Zweck: Fortsetzung des Mac-E2E (s. `2026-09-29-heim-server-mac-uebergabe.md`) auf
Linux — die Server-App läuft hier NATIV (Host-Docker statt podman-VM). Stand
(abends): **Direktpfad-ICE gefixt und live verifiziert**, Chat-E2E dev2/dev3
komplett über den DataChannel grün (Fix-Commit `54c4e82b`). Offen: nur noch
Voice — hart blockiert auf den Wildcard-DNS-Eintrag (unten, User-Aktion).*

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

## GEFIXT (2026-09-29, `54c4e82b`): Direktpfad-ICE im Container

**Ursache (per webrtc-ice-0.17.1-Quellcode belegt):** `set_ip_filter` wirkt
NUR aufs Gathering (`agent_gather.rs::gather_candidates_local_udp_mux`) — der
Filter verwarf die Bridge-IP 172.17.0.2, `candidate_ips.is_empty()` →
`ErrCandidateIpNotFound` → Abbruch VOR `udp_mux.get_conn(&ufrag)` → der Agent
hat keine Verbindung in der Mux → „Dropping packet" für jeden Check.

**Fix:** Filteraufteilung. `is_gatherable_ip` (Agent-intern: alle IPv4-
Interfaces, kein Loopback) fürs `set_ip_filter`; `is_useful_candidate_ip`
(bridges/CGNAT/IPv6 raus) nur noch fürs SDP — neu `sdp::strip_unusable_hosts`
wirft die nativen Bridge-Kandidaten aus der Answer, `inject_extra_hosts` +
`inject_srflx` laufen unverändert danach. Clients sehen wie bisher nur
LAN-Host + srflx; der Agent behält die Bridge-IP intern. Der Schlüssel: die
UDPMux routet Checks über den **ufrag im STUN-USERNAME**, nicht über die
Kandidaten-IP (`udp_mux/mod.rs::conn_from_stun_message`) — die Bridge-IP ist
intern also voll funktional.

**Live-Beweis (Reihenfolge der Kette, alles an EINEM Abend):**
1. Server-App (Linux, `PULSE_BUILD_MODE=server`-Bundle) gegen Dev-Cloud →
   Login dev2 → „Server einrichten" → Takeover-Overlay bestätigt → Container
   `pulse-host` healthy in ~30 s. Env korrekt: `PULSE_DIRECT_EXTRA_HOST_IPS=
   192.168.178.20` (echte LAN-IP via `hostLanIpv4s`), Relay-Triple komplett.
2. Adapter-Startlog: öffentliche Adresse `46.128.161.204:7900` (STUN,
   Port-Preservation), Telefonbuch online.
3. ICE-Probe (Browser, Cloud-Origin, Telefonbuch → direct-offer → Answer):
   **ICE CONNECTED nach 250 ms**, DataChannel offen. Answer enthält sauber
   `host 192.168.178.20:7900` + `srflx 46.128.161.204:7900`, KEINE 172.17er.
   Adapter-Log: `verbunden über LAN (Host-Kandidat): lokal 172.17.0.2:7900
   [host] <-> Gegenstelle 192.168.178.20:47519 [prflx]` — genau die
   beabsichtigte Form (Bridge intern, LAN-Pfad trägt).
4. **Chat-E2E** (`infra/self-host/tests/heim-chat-cloud-e2e.mjs`, neu): dev2
   Cloud-Ticket (Relay-Subdomain-Auflösung = Fix 1 in der echten Kette) →
   Session/Community/Kanal/Invite über den DataChannel; dev3 Membership-
   Merkhilfe → Grant-Ticket → Session → Invite-Accept → Nachricht, Owner liest
   sie über seinen eigenen DC. **Grün.**

## Offen: Voice-E2E — hängt an EINEM DNS-Eintrag (User-Aktion)

Die Signal-Strecke für Voice ist `wss://<relay-subdomain>/livekit` (Variante A
aus `2026-09-29-voice-signal-varianten.md`, empfohlen und halb gebaut: unsere
Instanz HAT das Relay-Triple, die Container-Caddy-Route `/livekit/*` steht).
Es fehlt auf dem DNS der Zone `unicutmedia.com`:

    *.relay.unicutmedia.com  →  77.42.71.166   (frps-Box)

`dig` prüfen: `dig +short merry-meadow-adbe.relay.unicutmedia.com` (Stand
29.09. leer; die Zone selbst lebt, nur der Relay-Wildcard fehlt). Danach zieht
der Caddy am Relay-Eingang per on-demand TLS sein Cert (HTTP-01 erreicht ihn
dann über den Namen), und der Zwei-Browser-Voice-Lauf kann wie im Memory
(„VOICE LIVE BEWIESEN", Fake-Mikrofon-Muster) gegen `wss://<subdomain>/livekit`
fahren. SSH auf 77.42.71.166 ist von dieser Maschine aus NICHT
schlüssellos möglich (publickey denied) — Cert-/Caddy-Prüfung dort braucht
entweder Passwort-Zugang oder läuft erst, wenn der DNS steht.

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
- Container auf DIESER Maschine: läuft jetzt SAUBER über die Server-App
  erzeugt (`pulse-host`, healthy, Restart-Policy unless-stopped) — nicht mehr
  manuell. Dev-Profil der Server-App: `~/.config/Pulse Server`, CDP 9223;
  dev2/dev3-Chromiums auf 9225/9226
  (`scripts/cdp/launch.fish <port> <suffix> https://pulse.unicutmedia.com`).
- **Toolchain-Falle auf dieser Maschine:** Das ZCode-AppImage verbiegt
  `argv[0]` — rustup-Proxies (`/usr/bin/cargo`, `rustup` selbst) sterben mit
  „unknown proxy name: 'ZCode-…'". Direkt die Toolchain-Binaries nutzen:
  `export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"`.
  (Gleiches Shadowing-Muster wie `pkill`, steht im AGENTS.md.)
- Docker-Daemon startet hier nicht von allein: `sudo -n systemctl start docker`
  (die `dcc_night_*`-Container kommen per Restart-Policy mit hoch).
- Hetzner-Relay-Stack (pulsetest_frps/relay_plugin/auth) lebt und ist unangetastet;
  Prod-Rollout bleibt wie im Mac-Dok beschrieben „nur zwei Env-Vars".
