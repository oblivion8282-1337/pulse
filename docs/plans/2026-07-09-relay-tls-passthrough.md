# Plan: Relay-TLS-Durchreichen (Option A) — netcup sieht keine Klartext-Inhalte mehr

**Status:** Entwurf, nicht umgesetzt · **Datum:** 2026-07-09 · Nachfolger von `2026-07-09-pulse-server-app.md`

## Problem

Der Relay-Tunnel der Server-App ist heute vom frp-Typ `http`. Kette:

```
Client --TLS--> Caddy (netcup, on_demand-Zertifikat)   <-- hier wird ENTSCHLÜSSELT
              --HTTP (Klartext)--> frps:8080
              --frp-Tunnel--> frpc im Container --HTTP--> Container-Caddy:8080
```

netcup terminiert TLS und sieht Chat-Nachrichten, Logins, Mitgliederlisten im Klartext.
Das widerspricht dem Constraint „alles direkt aufs Gerät, nichts über netcup (außer PMs)".

**Nicht betroffen:** Medien (Voice/Video/HQ-Stream). Kein UDP-Port ist getunnelt; LiveKit
gibt per `use_external_ip: true` die Heim-IP als ICE-Kandidat aus → direkter Pfad. Bleibt so.

## Ziel

netcup routet nur noch **versiegelte** TLS-Verbindungen anhand des SNI-Namens weiter und
kann sie nicht öffnen. Das Zertifikat liegt im Container des Self-Hosters.

```
Client --TLS--> SNI-Splitter :443 (netcup)
                  ├─ *.relay.howispulse.com → frps vhostHTTPS (roh, unentschlüsselt)
                  │     └─ frp-Tunnel → Container-Caddy:443 (eigenes LE-Zertifikat) ← TLS endet HIER
                  └─ sonst (howispulse.com, registry.*) → Caddy (wie bisher)
```

## Nicht-Ziele

- Metadaten-Schutz. netcup sieht weiterhin: welche Instanz, welche IP, wann, wie viele Bytes.
  Wer das nicht will, braucht Option B (DynDNS, direkte Portfreigabe) — separat, später.
- Schutz gegen ein *böswilliges* netcup. Die Cloud kontrolliert DNS für `relay.howispulse.com`
  und könnte sich jederzeit ein eigenes gültiges Zertifikat für eine Relay-Subdomain ausstellen
  lassen und aktiv dazwischengehen. Option A schützt gegen **passives Mitlesen**, nicht gegen
  einen aktiven Angreifer, der die Cloud kontrolliert. Ein echter Riegel wäre Public-Key-Pinning
  der Instanz im Desktop-Client (siehe „Später").

## Phasen

### Phase 1 — SNI-Splitter auf netcup

Caddy kann Layer-4-SNI-Routing nur mit dem `caddy-l4`-Modul (xcaddy-Rebuild). Stattdessen ein
kleiner nginx-`stream`-Container mit `ssl_preread` davor — Standardwerkzeug, kein Custom-Build:

- Neuer Container `pulse_sni` (`nginx:alpine`), lauscht auf Host-`:443`.
- `ssl_preread_server_name` → `map`: `~^.+\.relay\.howispulse\.com$` → `frps:8443`, Default → `caddy:8443`.
- Caddy gibt Host-`:443` ab und lauscht intern auf `:8443` (`https_port 8443` + `trusted_proxies`,
  damit die Client-IP aus dem PROXY-Protokoll bzw. `X-Forwarded-For` erhalten bleibt).
- Host-`:80` bleibt bei Caddy (Weiterleitungen + ACME-HTTP-01, s. Phase 3).

Dateien: `infra/prod/docker-compose.yml`, neu `infra/prod/sni-splitter.conf`, `~/caddy/Caddyfile`.

**Client-IP:** nginx-stream reicht die IP nicht als Header durch. Entweder PROXY-Protokoll zu frps
(`proxy_protocol on` + frps `transport.proxyProtocolVersion`) oder bewusst akzeptieren, dass der
Container `X-Forwarded-For` verliert. Muss vor dem Bau entschieden werden — betrifft Rate-Limits
und Audit-Logs **im Container**.

### Phase 2 — frps: HTTPS-vHost aktivieren

- `infra/prod/frps.toml`: `vhostHTTPSPort = 8443` ergänzen (HTTP-8080 bleibt für ACME).
- `services/relay-frps-plugin`: `NewProxy` muss `proxy_type in {http, https}` **explizit erlauben**
  und für `https` denselben Subdomain-/Token-Check fahren. Heute wird der Typ nicht geprüft —
  ohne Änderung würde er zwar durchgehen, aber ungeprüft. Tests in `services/relay-frps-plugin/tests/`.
- `frps_config.py::render_frps_server_config()` um `vhost_https_port` erweitern (+ Test).

### Phase 3 — Container: eigenes Zertifikat + HTTPS-Tunnel

Henne-Ei: Für das Zertifikat braucht der Container einen erreichbaren Namen; erreichbar ist er
nur über den Tunnel. Lösung: **ACME HTTP-01 durch den bestehenden HTTP-Tunnel.**

- `~/caddy/Caddyfile` (netcup): Für `*.relay.howispulse.com` den Pfad `/.well-known/acme-challenge/*`
  auf Port 80 **ohne HTTPS-Redirect** direkt an `frps:8080` proxien. Der Rest von :80 bleibt Redirect.
- `09-init-caddy.sh` (Container): Wenn `PULSE_RELAY_SUBDOMAIN` gesetzt ist, Caddy-Site auf
  `:443` mit automatischem ACME (HTTP-01, Challenge kommt über den 8080-Tunnel rein),
  Zertifikate persistent nach `/data/caddy`. Der `:8080`-Klartext-Vhost **bleibt** — er trägt die
  ACME-Challenge und den Fallback.
- `11-render-frpc.sh`: **zwei** Proxys rendern — `type = "http"` → `localPort 8080` (nur ACME/Fallback)
  und `type = "https"` → `localPort 443`.
- Erst wenn ein gültiges Zertifikat vorliegt, den HTTPS-Proxy anmelden (sonst zeigt der SNI-Splitter
  ins Leere). Reihenfolge über eine Bereitschaftsdatei in `/data` oder ein s6-`restart-gate`.

### Phase 4 — Umschalten & Rückfallebene

- Feld `relay_tls_mode` (`terminate` | `passthrough`) auf `registered_instances` (Alembic in `services/auth`).
- Der SNI-Splitter fragt beim Verbindungsaufbau nichts ab — die Entscheidung fällt implizit:
  Meldet der Container einen `https`-Proxy an, gewinnt der Passthrough-Pfad; sonst greift der alte
  `http`-Pfad über Caddys `on_demand`. Beide Wege koexistieren, kein Big-Bang.
- Alt-Instanzen (VPS-Self-Hosts mit eigener Domain) sind nicht betroffen — sie hängen nicht am Relay.

## Verifikation (jede Phase einzeln)

1. `openssl s_client -connect relay-host:443 -servername <slug>.relay.howispulse.com` →
   der **Aussteller/Fingerabdruck muss der des Containers sein**, nicht der von Caddy auf netcup.
   Vergleich gegen `podman exec pulse-host` (Fingerabdruck lokal auslesen).
2. Mitschnitt **auf netcup**: `tcpdump` auf dem `frps`-Interface darf **kein** lesbares
   HTTP mehr zeigen (heute: `GET /api/...` im Klartext sichtbar).
3. Chat + Login + WebSocket funktionieren unverändert vom Handy über Mobilfunk.
4. Medienpfad unverändert direkt (Messung wie in `scratchpad/pfad-messung.sh`).
5. `howispulse.com` und `registry.howispulse.com` weiterhin erreichbar (der Splitter darf sie nicht schlucken).

## Risiken

- **Zertifikats-Mengenbegrenzung.** Let's Encrypt: 50 neue Zertifikate pro registrierter Domain
  und Woche. Gilt **heute schon** (Caddys `on_demand` stellt pro Subdomain eins aus) — Option A
  verschiebt die Ausstellung nur in den Container, erhöht die Zahl nicht. Wird ab ~50 neuen
  Self-Hostern/Woche zur Wand; dann Limit-Erhöhung beantragen oder zweite Domain.
- **Ausfall bei Zertifikatsproblemen.** Bekommt der Container kein Zertifikat (ACME down, Rate-Limit),
  darf er nicht in ein schwarzes Loch routen → Rückfall auf den `http`-Pfad ist Pflicht (Phase 4).
- **Client-IP-Verlust** hinter dem Splitter (s. Phase 1) → Rate-Limits im Container laufen sonst
  gegen die Relay-IP statt gegen den echten Client. Sicherheitsrelevant, nicht kosmetisch.
- **Port-443-Umbau auf netcup betrifft die Produktion.** `howispulse.com` hängt am selben Port.
  Umbau in einem Wartungsfenster, Caddyfile-Backup, Rollback = Compose-Datei zurück + `up -d`.

## Später (nicht Teil von A)

- **Public-Key-Pinning** der Instanz: Beim Bootstrap-Redeem den Fingerabdruck des Container-
  Zertifikats in `registered_instances` hinterlegen; der Electron-Client prüft ihn über
  `session.setCertificateVerifyProc`. Erst das schließt den aktiven MITM durch die Cloud.
  Im Browser nicht durchsetzbar.
- **Option B** (DynDNS + Portfreigabe) als zusätzlicher Modus für Nutzer ohne CGNAT.
