# Plan: Direktpfad — Chat ohne Cloud im Datenweg (WebRTC-DataChannel)

**Status:** in Arbeit (Phase 1) · **Datum:** 2026-07-09 · Entscheidung des Users:
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
| 1 | **Cloud-Telefonbuch**: Migration `instance_direct_endpoints`, `POST /selfhost/directory/heartbeat` (Auth: Relay-Token-Hash, wie `relay_auth`), `GET /me/instances/{id}/direct-endpoint` (Session + Membership) | pytest auth-svc |
| 2 | **Adapter-Grundgerüst** im Container: STUN-Discovery, Heartbeat-Sender, s6-Service. **Neue Dependency: `aiortc`** (Python-WebRTC; Rückfrage beim User — Alternative wäre Go/Pion = neue Sprache im Repo) | Heartbeat-Zeile erscheint im Telefonbuch |
| 3 | **Signal-Relay**: Instanz hält WS zur Cloud (`/selfhost/directory/ws`, Auth wie Heartbeat); `POST /me/instances/{id}/direct-offer` (Client) → Cloud reicht durch → Antwort zurück (Long-Poll ≤10 s) | Offer/Answer-Roundtrip im Test |
| 4 | **DataChannel⇄HTTP-Brücke** im Adapter + Framing | curl-Äquivalent über DataChannel gegen lokalen Container |
| 5 | **Client-Weiche**: fetch/WS-Shim über DataChannel, Verbindungs-Cache (letzte bekannte Adresse), TOFU-Pinning | Browser-Test: Chat läuft, Netzwerk-Tab leer Richtung Relay |
| 6 | **E2E-Beweis**: `tcpdump` — beim Chatten **0 Pakete** zu netcup (außer initialem Telefonbuch-Lookup) | Messskript `scratchpad/pfad-messung.sh`-Nachfolger |

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

## Offene Entscheidungen

- **Phase 2, Adapter-Runtime:** Empfehlung `aiortc` (bleibt im Python-Stack, Last eines
  Heim-Servers ist klein). Alternativen: Pion (Go) / webrtc-rs (Rust, Toolchain existiert
  für die HQ-Sidecars). → User-Rückfrage vor Phase 2 (Repo-Regel: keine neuen Dependencies
  ohne Freigabe).
- Heartbeat-Intervall (Entwurf: 120 s; „online" = updated_at < 300 s).
- Ob der Adapter im selben Zug die Medien-Signalisierung (LiveKit-Token-Flow) mitnimmt oder
  die weiter über HTTP läuft (dann eben durch den DataChannel — automatisch mit erledigt).
