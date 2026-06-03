# Pulse Self-Hosting Guide

Pulse läuft als **ein Docker-Container** mit eingebettetem Postgres, Redis, LiveKit,
MediaMTX, coturn und Caddy. Setup = ein Befehl.

**Anforderungen:** Docker, öffentlicher Hostname (DNS-A-Record), Ports 80 + 443 +
3478 + 7882–7892/udp offen.

---

## Schritt-für-Schritt-Setup

### 1. Cloud-Account anlegen

Registriere dich auf [howispulse.com](https://howispulse.com) und
richte MFA ein (Pflicht für Self-Hoster).

### 2. Self-Host-Antrag stellen

Im Cloud-UI unter **Einstellungen → Self-Host-Instances → Neue Instance beantragen**.
Ausfüllen: Hostname, Zweck, Kontakt. Anträge werden manuell geprüft (Stealth-Beta).

### 3. Auf Approval warten

Nach Prüfung erhältst du eine E-Mail. Ablehnungsgründe sind im Antragsformular
einsehbar (z.B. mehrdeutiger Hostname, fehlende Begründung).

### 4. Credentials abholen

Cloud-UI → **Meine Self-Host-Instances** → Instance anklicken →
`client_id` + `client_secret` **einmalig** anzeigen lassen und sicher speichern
(der Secret kann danach nicht mehr eingesehen werden, nur resettet).

### 5. Domain vorbereiten

Setze einen DNS-A-Record vor dem ersten Container-Start:

```
chat.firma.de.   IN   A   <DEINE_SERVER_IP>
```

Prüfe mit `dig chat.firma.de` oder [whatsmydns.net](https://www.whatsmydns.net).
Caddy versucht das Let's Encrypt-Cert beim Start zu holen — wenn DNS noch nicht
stimmt, hängt es in der Retry-Loop.

Ports freischalten (Firewall/ufw):

```bash
ufw allow 80/tcp    # HTTP (Let's Encrypt ACME Challenge)
ufw allow 443/tcp   # HTTPS
ufw allow 3478/tcp  # coturn TURN TCP
ufw allow 3478/udp  # coturn TURN UDP
ufw allow 7882:7892/udp  # LiveKit WebRTC ICE
```

### 6. Container starten

```bash
docker run -d --name pulse \
  --restart unless-stopped \
  -v pulse-data:/data \
  -p 80:80 -p 443:443 \
  -p 3478:3478 -p 3478:3478/udp \
  -p 7882-7892:7882-7892/udp \
  -e PULSE_HOSTNAME=chat.firma.de \
  -e PULSE_INSTANCE_ID=123456789 \
  -e PULSE_INSTANCE_OWNER_ID=987654321 \
  -e PULSE_CLOUD_CLIENT_ID=sh_live_xxxx \
  -e PULSE_CLOUD_CLIENT_SECRET=xxxx \
  -e PULSE_ADMIN_EMAIL=admin@firma.de \
  ghcr.io/oblivion8282-1337/pulse-allinone:stable
```

`PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID`, `PULSE_CLOUD_CLIENT_ID` und das
`client_secret` stammen alle aus dem Approval auf howispulse.com. Am einfachsten
lädst du unter **„Meine Instanzen"** das fertige `.env`-Snippet herunter (enthält
alles außer dem Secret) und nutzt die `--env-file`-Variante unten.

Alle Env-Vars und Defaults: `infra/self-host/.env.example`.

**Optionale Variablen** (haben sinnvolle Defaults, hier nur ändern wenn nötig):
- `PULSE_CLOUD_ORIGIN` (Default: `https://howispulse.com`) — wohin
  CRL/JWKS-Pinning/Cloud-Policy-Polls gehen. Auf eine eigene Cloud-Foundation
  zeigen oder leer lassen für ein Standalone-Setup (Cloud-Pairing funktioniert
  dann nicht).
- `PULSE_TLS_MODE=auto` (Default) — Caddy holt Let's-Encrypt-Cert automatisch.
  `=provided` → eigenes Cert unter `/data/certs/cert.pem` + `key.pem`.
- `PULSE_TURN_DISABLED=true` — coturn deaktivieren (wenn du eigenen TURN hast
  oder ohne NAT-Traversal auskommst).

**Alternativ mit .env-Datei:**

```bash
docker run -d --name pulse --restart unless-stopped \
  -v pulse-data:/data \
  -p 80:80 -p 443:443 -p 3478:3478 -p 3478:3478/udp \
  -p 7882-7892:7882-7892/udp \
  --env-file /pfad/zu/.env \
  ghcr.io/oblivion8282-1337/pulse-allinone:stable
```

### 7. Healthcheck

**Beim First-Start dauert das 60–120 Sekunden:**
- Postgres initdb: ~10 s
- Alembic-Migrationen: ~5 s
- Caddy Let's Encrypt Cert-Fetch: ~30–60 s (erfordert Port 80+443 + korrekten DNS)
- JWKS Cold-Start (Cloud-Fetch): ~5 s

Nach erfolgreichem Start:

```bash
curl https://chat.firma.de/health
# {"status":"ok"}
```

Logs verfolgen:

```bash
docker logs -f pulse
```

### 8. Erster Login

1. Öffne [howispulse.com](https://howispulse.com) im Browser.
2. Klicke **Server hinzufügen** → trage `chat.firma.de` ein.
3. Du wirst automatisch Server-Owner (erste Registrierung = Bootstrap-Admin).

---

## TLS + Public-Reach

### Standard: Caddy Auto-TLS (Let's Encrypt)

Caddy holt automatisch ein TLS-Cert, solange Port 80+443 erreichbar sind und der
DNS-A-Record korrekt gesetzt ist. Cert wird in `/data/caddy/` gecacht, überlebt
Container-Restarts.

**Problem:** „Caddy hängt beim Start" → DNS-A-Record fehlt oder Ports gesperrt.
Lösung: DNS prüfen, Firewall checken, dann Container neustarten.

### DynDNS (keine statische IP)

Dienste wie [DuckDNS](https://www.duckdns.org) oder
[No-IP](https://www.noip.com) geben dir einen Hostnamen der auf deine aktuelle IP
zeigt. DuckDNS-Client im Container oder Cron-Job auf dem Host aktualisiert den
Record alle 5 Minuten. Caddy-Auto-TLS funktioniert damit wie gewohnt.

### Cloudflare Tunnel (kein Port-Forwarding nötig)

Für Hoster hinter Carrier-Grade-NAT oder restriktiver Firewall:

```bash
cloudflared tunnel create pulse
cloudflared tunnel route dns pulse chat.firma.de
cloudflared tunnel run pulse
```

Im Container dann `PULSE_TLS_MODE=provided` + eigenes Cert aus Cloudflare Origin CA,
oder einfach Cloudflare Tunnel's internes TLS nutzen (Cloudflare terminiert TLS,
Tunnel ist verschlüsselt).

### Tailscale Funnel

Macht deinen Container über Tailscale Funnel öffentlich erreichbar ohne Router-Setup:

```bash
tailscale funnel --bg 443
```

Nutze dann `PULSE_TLS_MODE=provided` mit dem Tailscale-Cert oder lass Caddy ein
eigenständiges Cert holen (Funnel reicht Port 80+443 durch).

### Eigenes Cert (`PULSE_TLS_MODE=provided`)

```bash
docker run ... \
  -v /pfad/zu/certs:/data/certs:ro \
  -e PULSE_TLS_MODE=provided \
  ...
```

Erwartet: `/data/certs/cert.pem` (Vollchain) + `/data/certs/key.pem` (Private Key).

---

## DNS-Leakage-Hinweis

Der DNS-Resolver deiner Nutzer sieht den Hostnamen dieses Servers bei jeder
Verbindung — das gilt für jede Website weltweit und ist technisch unvermeidbar.

Wer das vermeiden will: DNS-over-HTTPS (im Browser aktivierbar) oder Tor-Browser
(Onion-Service für Pulse nicht unterstützt). Für Enterprise-Setups ist ein
internes DNS + Split-Horizon die übliche Lösung.

Weitere Hinweise für Nutzer: `docs/PRIVACY_SELF_HOST_TEMPLATE.md`.

---

## Skalierungs-Limit

Der Single-Container skaliert auf **~1000–1500 aktive User** je nach Hardware
(empfohlen: 4 Cores, 8 GB RAM, SSD).

Bottleneck ist CPU/RAM/Bandbreite, nicht die Datenbank. Für Gemeinschaften
dieser Größe ist der Overhead von Postgres (~50 MB RAM) vernachlässigbar.

Wer darüber hinaus wächst: `pg_dump` exportiert die Daten; eine Multi-Container-
Architektur (eigene Postgres/Redis-Instanzen) ist Power-User-Only und wird nicht
offiziell dokumentiert.

---

## Was passiert bei Updates

Watchtower steckt **nicht** im pulse-allinone-Image (bewusst) — du musst ihn
als separaten Container daneben starten. Empfohlen:

```bash
docker run -d --name pulse-watchtower --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    containrrr/watchtower --scope pulse --interval 300 pulse
```

`--scope pulse` sorgt dafür, dass Watchtower nur Pulse-Container anfasst,
nicht alle anderen Container auf deinem Host. Damit pulse-allinone in den
Scope fällt, beim `docker run` der Pulse-Instanz `--label com.centurylinklabs.watchtower.scope=pulse`
mitgeben.

Watchtower prüft alle 5 Minuten ob ein neues `pulse-allinone:stable`-Image
verfügbar ist. Bei einem Update:

1. Container stoppt (alle Services gleichzeitig down).
2. Neues Image wird gestartet.
3. Alembic-Migrationen laufen automatisch.
4. Container kommt wieder hoch (~20–30 s, Cert schon gecacht).

**Konsequenz:** Laufende Voice-Calls und HQ-Streams werden unterbrochen.
Clients reconnecten automatisch binnen 30 s. Bei Datenbank-Migrations-Fehler
startet der Container nicht — `docker logs pulse` zeigt den Fehler.

Pre-Update-Backup läuft automatisch (konfigurierbar via `PULSE_BACKUP_RETENTION_PRE`,
Default 3 Kopien).

**Updates sind Pflicht.** Wer Watchtower deaktiviert, riskiert beim nächsten
Cloud-Deploy eine inkompatible Protocol-Version — der WS-Hello-Check blockt dann
alle Verbindungen.

---

## Backups

Backups werden automatisch in `/data/backups/` abgelegt (pg_dump):
- **Pre-Update:** vor jedem Container-Restart (Default: 3 letzte Kopien)
- **Wöchentlich:** sonntags 02:00 UTC (Default: 4 letzte Kopien)

```bash
# Manueller Backup
docker exec pulse pg_dump -U pulse pulse > backup-$(date +%Y%m%d).sql

# Backup kopieren
docker cp pulse:/data/backups/ ./local-backups/
```

**Disk-Encryption:** Backups in `/data/backups/` sind plain SQL.
Der Self-Hoster ist für Verschlüsselung auf Host-Level verantwortlich (LUKS, ZFS-
Encryption, verschlüsseltes Backup-Ziel). Pulse empfiehlt: `/data`-Volume auf einem
verschlüsselten Block-Device mounten.

Disk-Warnung bei < 20 % freiem Platz: `GET /health` returnt
`{"status":"degraded","failed":["disk"]}`.

---

## Troubleshooting

### "Caddy startet nicht / Port 80 blockiert"

```bash
docker logs pulse 2>&1 | grep -i "caddy\|tls\|acme"
```

Häufigste Ursache: DNS-A-Record zeigt noch nicht auf die richtige IP, oder Port 80
ist durch eine vorgelagerte Firewall gesperrt. Lösung: DNS prüfen, Firewall öffnen.

### "JWKS nicht verfügbar — WS-Verbindungen schlagen fehl (4046)"

chat-gateway konnte den JWKS-Endpoint der Cloud beim Start nicht erreichen.
Vorübergehend, solange `howispulse.com` nicht erreichbar ist:

```bash
curl https://howispulse.com/.well-known/jwks.json
```

### "Health-Endpoint returnt 503 degraded"

```bash
curl -s https://chat.firma.de/health | python3 -m json.tool
# {"status":"degraded","failed":["db"]}
docker logs pulse 2>&1 | tail -50
```

Fehlende `failed`-Einträge: `db` = Postgres down, `redis` = Redis down, `jwks` = JWKS nicht ready.

### "Voice-Calls funktionieren nicht"

1. Ports 7882–7892/udp offen? `ufw status`
2. coturn läuft? `docker exec pulse s6-svstat /run/s6/services/coturn`
3. `/data/coturn-secret` vorhanden? (wird beim First-Start erstellt)

### "Disk-Warnung im Health-Check"

```bash
docker exec pulse df -h /data
```

Alte Backups löschen:
```bash
docker exec pulse ls -lt /data/backups/
docker exec pulse rm /data/backups/pulse_backup_<datum>.sql
```

### Container "unhealthy" Status

```bash
docker exec pulse /usr/local/bin/pulse-health
# Zeigt welcher Sub-Service nicht antwortet
docker inspect --format='{{json .State.Health}}' pulse | python3 -m json.tool
```

---

## Datenschutz-Vorlage

`docs/PRIVACY_SELF_HOST_TEMPLATE.md` enthält eine Datenschutzerklärung die Self-
Hoster auf ihrer Domain veröffentlichen können (DSGVO-Pflicht).
