# Plan: Direktpfad — Chat ohne Cloud im Datenweg (WebRTC-DataChannel)

**Status:** Phasen 1–6 gebaut + verifiziert (lokal), ungemerged · **Datum:** 2026-07-09 · Entscheidung des Users:
Direktpfad VOR dem Relay-TLS-Durchreichen (`2026-07-09-relay-tls-passthrough.md`, zurückgestellt).

## Ziel

Ist die Server-App online, redet ein Client **direkt** mit ihr — Chat, Login, WebSocket,
alles. Die Pulse-Cloud ist nur noch:

1. **Telefonbuch** — „wo ist Instanz X gerade?" (wenige Bytes, kein Inhalt),
2. **Briefträger für den Verbindungsaufbau** — reicht das WebRTC-Angebot/Antwort-Paar durch
   (SDP, ~2 KB, einmal pro Verbindung),
3. Fallback-Relay wie heute, wenn der Direktweg physikalisch nicht geht (CGNAT beidseitig).

Kein DynDNS, keine Portfreigabe, keine Zertifikate: WebRTC verschlüsselt immer (DTLS) und
prüft Identität per **Fingerabdruck** statt CA-Zertifikat — deshalb funktioniert es im
Browser gegen eine nackte, wechselnde Heim-IP. Genau so läuft Voice heute schon; der
Direktpfad wendet dasselbe Prinzip auf alles andere an.

## Warum das trägt (Beweise aus diesem Projekt)

- Fritz!Box = Full-Cone-NAT + Port-Preservation, durch den vollen Stack gemessen
  (Container→Docker→Router, 3 STUN-Server) — Plan `2026-07-09-pulse-server-app.md`.
- Medien (LiveKit, UDP 7882–7892) laufen heute schon direkt; kein UDP ist getunnelt
  (frpc-Konfig: genau ein `http`-Proxy).
- `RTCDataChannel` funktioniert in allen Browsern inkl. Safari (WebTransport nicht — deshalb
  DataChannel, nicht WebTransport).

## Architektur

```
Server-App (Container)                Cloud (netcup)                    Client
──────────────────────                ───────────────                   ──────
direct-adapter                        Telefonbuch:
  ├─ STUN: eigene öffentl.            instance_direct_endpoints
  │  Adresse ermitteln     ─heartbeat→  (candidates, fingerprint,
  ├─ hält WS zur Cloud                   updated_at)
  │  („Klingeldraht")      ←──offer───  Signal-Relay ←────offer(SDP)──── „Server öffnen"
  │                        ───answer→                ────answer(SDP)──→
  └─ DataChannel ⇄ HTTP     ↕ ab hier DIREKT (ICE/DTLS/SCTP), Cloud raus ↕
     Brücke → localhost:8080 ◄════════ Chat/Login/WS über DataChannel ═══► fetch/WS-Shim
```

- **Adapter** (neuer Dienst im allinone-Container): nimmt WebRTC-Verbindungen an,
  bridged DataChannel-Frames auf `localhost:8080` (Container-Caddy) — Backend unverändert.
- **Framing** (Entwurf, Phase 4): Request `{id, method, path, headers, body_b64}` →
  Response `{id, status, headers, body_b64}`; WebSocket = eigener DataChannel pro
  WS-Verbindung (`label: ws:<pfad>`), Frames 1:1 durchgereicht.
- **Client-Weiche** (Phase 5): pro Self-Host-Server erst Direktpfad versuchen (Timeout ~4 s),
  sonst Relay-Hostname wie heute. Fingerabdruck-TOFU: beim ersten Erfolg im ServerEntry
  gespeichert, Abweichung später = harter Fehler.

## Phasen

| # | Inhalt | Ergebnis / Testbarkeit |
|---|---|---|
| 1 | ✅ **Cloud-Telefonbuch**: Migration 0041 `instance_direct_endpoints`, `POST /selfhost/directory/heartbeat` (Auth: Relay-Token-Hash), `GET /me/instances/{id}/direct-endpoint` (Session + Membership) | pytest 10/10 |
| 2 | ✅ **Adapter-Grundgerüst** (Rust/webrtc-rs, User-Entscheidung): STUN-Discovery, persistentes DTLS-Cert, Heartbeat, s6-Service, Dockerfile-Stage | cargo test + Kreisschluss gegen Dev-Cloud |
| 3 | ✅ **Signal-Relay**: `WS /selfhost/directory/ws` + `POST /me/instances/{id}/direct-offer` (409 offline / 504 timeout) | pytest 7/7 (inkl. WS-Roundtrip) |
| 4 | ✅ **DataChannel⇄HTTP/WS-Brücke** im Adapter + Framing | echter Chromium: GET/POST/großer Body/WS durch den Kanal |
| 5 | ✅ **Client-Weiche**: `transportFetch` in `api/client.ts`, `DirectWebSocket` im Gateway, Registry mit TOFU-Pinning | Browser-E2E gegen die **echten** Module; Fingerprint-Abweichung wird abgelehnt |
| 6 | ✅ **Verkehrsmessung**: 20 Requests → 71 Pakete Direktpfad (UDP), **0 Nutzdaten-Pakete zur Cloud** (nur 7 Keepalive-/FIN-Pakete der bestehenden Signal-Verbindung) | tcpdump, Cloud vs. Backend sauber getrennt |

Nach jeder Phase: Commit + kurzer Bericht + User-Bestätigung (Phasen-Workflow).

## Bewusste Grenzen

- **Cloud bleibt Vertrauensanker beim Verbindungsaufbau** (liefert Fingerprint/SDP).
  TOFU-Pinning entschärft das ab dem zweiten Kontakt; Pinning ab Bootstrap = spätere Härtung.
- **Offline = offline.** Kein Store-and-Forward; ist die Server-App aus, gibt es den Server
  nicht. Gewollt.
- **Symmetrisches NAT/CGNAT beidseitig** → Direktpfad scheitert, Relay-Fallback bleibt Pflicht
  (dessen TLS-Härtung = zurückgestellter Plan A).
- Der Relay-`http`-Tunnel bleibt in dieser Ausbaustufe unverändert bestehen (Fallback +
  ACME-Zukunft) — er wird nur vom Normalfall zur Ausnahme.

## Erledigte Entscheidungen

- **Adapter-Runtime: webrtc-rs (Rust)** — User-Entscheidung 2026-07-09.
- Heartbeat 120 s, „online" = letzter Heartbeat < 300 s.
- Medien-Signalisierung braucht nichts Eigenes: sie läuft über HTTP und damit automatisch
  durch den DataChannel.

## Fallstricke, die im Bau auftauchten (für die Nachwelt)

1. **webrtc-rs gathert im Mux-Betrieb KEINE srflx-Kandidaten** (`agent_gather.rs`:
   `UDPNetwork::Muxed(_) => continue`), und `set_nat_1to1_ips(.., Srflx)` sitzt in genau
   diesem übersprungenen Arm — er ist wirkungslos. Lösung: `sdp::inject_srflx()` hängt den
   Kandidaten der STUN-Adresse selbst an die Answer. Ohne das sieht ein Client im Internet
   nur unerreichbare LAN-Adressen.
2. **rustls-CryptoProvider** muss explizit gewählt werden (reqwest bringt `aws-lc-rs`,
   webrtc bringt `ring`) — sonst panict der erste DTLS-Handschlag, nicht der Start.
3. **ICE-IP-Filter ist Pflicht**: Docker-Bridges, CGNAT/Tailscale und IPv6 machten den
   Verbindungsaufbau flatterhaft (dieselbe Klasse Bug wie der frühere WHEP-IPv6-Leak).

## Noch offen

- Deploy: Cloud-Migration 0041 + neues allinone-Image (Adapter) + Server-App-Rebuild.
- **Changelog-Eintrag** vor dem Push auf `main` (Pflicht-Gate, Stil vom User wählen lassen).
- Relay bleibt Fallback; seine TLS-Härtung ist `2026-07-09-relay-tls-passthrough.md`.
- Test über echtes Internet (Client außerhalb des Heimnetzes) steht noch aus — bisher
  wurde der srflx-Kandidat nur erzeugt und angeboten, aber im LAN-Test nicht *benutzt*.


## Relay-Fallback entfernt für app_host (Stand 2026-07-13)

User-Entscheidung: Kein Relay-Fallback mehr für App-Hosting — Text/Login liefe
sonst doch über die Cloud. Der Direktpfad ist für `origin='app_host'`-Instanzen
der EINZIGE Weg; VPS-Self-Hosts und die Cloud bleiben unberührt.

- **Client-Weiche** (`web/src/lib/direct/policy.ts`, pur): `isDirectOnly()`
  greift nur bei explizitem `origin='app_host'` am `ServerEntry` (kommt aus
  `GET /me/instances` via `hydrateFromBackend`; Alt-Einträge ohne origin
  verhalten sich wie VPS). Scheitert der Direktpfad, gibt es drei erklärte
  Fehlzustände statt eines stillen Fallbacks (`transportFetch` wirft
  `DirectUnavailableError`, der Gateway-WS geht auf 'closed' + Backoff):
  (a) Telefonbuch offline → „Server ist offline" (bestehende Offline-Anzeige),
  (b) online aber ICE scheitert → „Keine Direktverbindung möglich …",
  (c) Fingerprint-Wechsel → sichtbarer Vertrauens-Dialog
  (`DirectTrustDialog.svelte`: „Neuer Identität vertrauen" = forgetPin +
  Reconnect) statt console.warn. Zustand pro Instanz im
  `directStatus`-Store, sichtbar im Server-Tooltip der Rail.
- **Cloud-Flag** `PULSE_RELAY_PROVISION_ENABLED` (auth-svc, Default `true`):
  bei `false` vergibt der Bootstrap-Redeem keine `relay_subdomain` und keinen
  Tunnel-Token mehr (Response bleibt shape-stabil mit null; Bestands-
  Subdomains bleiben in der DB — kein Daten-Rückbau).
- **Container-Marker**: `PULSE_HOST_ORIGIN=app_host|vps` ersetzt die
  „Relay-Token gesetzt = App-Hosting"-Heuristik in `07-render-env.sh` /
  `08-init-mediamtx.sh` (explizite Env hat Vorrang, Heuristik bleibt Fallback
  für Bestands-Container). Die Desktop-Server-App setzt die Env in
  `container.env` (paralleler Desktop-Strang).
- **Status**: Client-Logik pur + backend-getestet; der Ende-zu-Ende-Beweis
  (App-Host ohne Relay von extern) ist ausdrücklich manuelle Verifikation.
