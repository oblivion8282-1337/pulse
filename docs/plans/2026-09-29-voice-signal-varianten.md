# Voice-Erreichbarkeit für Heim-Server — Signal-Varianten (Entscheidungsvorlage)

*Stand: 2026-09-29. Anlass: Mac-E2E (s. `2026-09-27-heim-server.md`, Abschnitt
Mac-E2E) — Voice ist für Self-Service-Instanzen auf allen Plattformen tot,
und zwar an genau EINER Stelle: der Signal-Strecke zu LiveKit.*

## Was bereits steht (nicht neu bauen)

- **Media-Announce hinter NAT ist erprobt** (`templates/livekit.yaml.template`):
  `use_external_ip` (STUN) + `advertise_internal_ip` (LAN-Kandidat bleibt) +
  `skip_external_ip_validation` (Fritz!Box-Hairpin) — am echten App-Host
  verifiziert 2026-07-13. UDP 7882-7892 + 3478 sind in `MEDIA_PORT_ARGS`
  publiziert; unter Win/Mac trägt gvproxy sie auf die LAN-IP.
- **Signal-Route im Container**: Caddy proxyt `/livekit/*` → 7880
  (`handle_path`, F15-Strip-Fix im Caddyfile-Template).
- **Relay-Infrastruktur in Prod**: frps + relay-frps-plugin laufen,
  `routes_selfhost_relay.py` kennt Ausgabe/Prüfung von `relay_subdomain`,
  `BootstrapCreds` trägt die Felder — die Selbstbedienung setzt sie bisher
  nur auf `null` (V1-Entscheid „kein Relay" betraf den CHAT-Datenweg).
- **Der 2026-07-14-Fazit** (`2026-07-14-app-host-windows-status.md`) bleibt
  gültig: universelle Erreichbarkeit ohne Relay gibt es nicht (Browser
  können kein WireGuard, NetBird verworfen, frp-XTCP hilft nur bei TCP) —
  Zielbild Hybrid: billig direkt, Fallback als bezahltes Add-on.

## Die eigentliche Lücke

Das Backend verkündet `LIVEKIT_URL = wss://<Relay-Hostname>/livekit`
(`07-render-env.sh`). Self-Service-Instanzen haben keinen Relay-Hostnamen →
der Client kann die Signal-WS nie öffnen („Failed to fetch", Mac-E2E). Der
Signal-Kanal ist wenigen KB/s — die Kostenfrage des „kein Relay"-Beschlusses
betraf den Medien/Chat-Datenweg, nicht ihn.

## Varianten

### A — Signal über den bestehenden frps-Relay-Hostnamen (Empfehlung V1)

Selbstbedienungs-Instanzen bekommen wieder `relay_subdomain` + Tunnel-Token;
`LIVEKIT_URL` bleibt `wss://<hostname>/livekit` und resolving über die Cloud-
Caddy mit echtem Wildcard-Zertifikat. Media bleibt direkt (UDP, LAN wie
Internet via STUN-Announce).

- **Aufwand:** klein-mittel. Provisionierung mietet wieder einen Tunnel
  (Code vorhanden), Container-Seite existiert im Image (Caddy-Route steht),
  Client unverändert.
- **Abdeckung:** Browser + Electron, LAN + Internet, keine Mixed-Content-
  Falle (echtes wss), Owner braucht kein Port-Forwarding.
- **Kosten/Risiko:** Signal-Bandbreite in der Cloud (KB/s je Teilnehmer);
  „kein Relay"-Beschluss braucht eine bewusste Ausnahme für das Voice-Signal.
  Frp-Tunnel = TCP — LiveKit-Signal ist WS/TCP, passt.

### B — Signal durch den Direkttunnel (Eigenbau, null Infra)

`DirectWebSocket` (vorhanden) trägt die LiveKit-Signal-WS durch den
DataChannel wie die REST-API; Media bleibt direkt.

- **Aufwand:** mittel-hoch im Client — livekit-client erlaubt keinen
  sauberen custom Signal-Transport; Junction über WebSocket-Monkey-Patch
  oder SDK-Fork. Wartungsrisiko bei jedem SDK-Update.
- **Abdeckung:** identisch zu A, aber ohne Cloud-Bandbreite.
- **Risiko:** eigener Code am sensibelsten Punkt (Verbindungsaufbau).

### C — LAN-Stufe: 7880 publizieren + `ws://<LAN-IP>` rendern (kleinste Stufe)

`PULSE_DIRECT_EXTRA_HOST_IPS` liegt vor; `LIVEKIT_URL=ws://<LAN-IP>:7880`
+ Port 7880 in `MEDIA_PORT_ARGS`.

- **Aufwand:** klein (Port-Arg + eine Render-Zeile).
- **Abdeckung:** NUR heim-server-eigene LAN-UI auf http-Origin (ws:// wäre
  Mixed Content auf den https-Seiten der Cloud) und nur im Heimnetz. Kein
  Internet-Voice, Browser-Journey aus der Cloud bleibt ohne Voice.

## Vergleiche in einer Zeile

| | A (frps-Signal) | B (Tunnel-Signal) | C (LAN 7880) |
|---|---|---|---|
| Neuer Code | Provisionierung nutzt vorhandenen Relay-Weg | Client-Transport + Adapter-WS-Proxy | Port + Render-Zeile |
| Browser | ja (echtes wss) | ja, aber Eigenweg | nur http-UI |
| Internet | ja (Signal; Media via STUN) | ja (Signal; Media via STUN) | nein |
| Cloud-Kosten | Signal-Bandbreite (minimal) | keine | keine |
| Beschluss nötig | „kein Relay"-Ausnahme fürs Signal | nein | nein, aber Reichweite |

## Empfehlung

**A für V1** (der Weg der „halbwegs laufenden" Version von Juli, verifiziert),
**B** als späterer Ausbau, wenn die Signal-Bandbreite zur Kostenposition wird
(= das geplante bezahlte Add-on-Modell), **C** optional obendrauf für den
LAN-Fall ohne Cloud-Abhängigkeit. Zu klären vor dem Bau: Review des
Relay-Tunnel-Aufwands in der Provisionierung gegen den V1-Scope, und die
bewusste Ausnahme im „kein Relay"-Beschluss festhalten.
