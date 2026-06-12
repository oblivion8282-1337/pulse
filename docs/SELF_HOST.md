# Pulse Self-Hosting Guide

Pulse läuft als **ein Docker-Container** mit eingebettetem Postgres, Redis, LiveKit,
MediaMTX, coturn und Caddy. Setup = ein Befehl.

**Anforderungen:** Docker, öffentlicher Hostname (DNS-A-Record), Ports 80 + 443 +
3478 + 7882–7892/udp offen (für HQ-Streaming zusätzlich 1936/tcp + 8189/udp).

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
ufw allow 1936/tcp  # HQ-Streaming RTMPS-Ingest
ufw allow 8189/udp  # HQ-Stream-Wiedergabe (MediaMTX WHEP-ICE)
```

### 6. Container starten

```bash
docker run -d --name pulse \
  --restart unless-stopped \
  -v pulse-data:/data \
  -p 80:80 -p 443:443 \
  -p 3478:3478 -p 3478:3478/udp \
  -p 7882-7892:7882-7892/udp \
  -p 1936:1936 -p 8189:8189/udp \
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
  -p 7882-7892:7882-7892/udp -p 1936:1936 -p 8189:8189/udp \
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

## Manuelle Installation (Docker Compose)

Für alle, die den Stack **selbst verwalten** wollen statt das Installer-Script
zu nutzen — eigener Proxy, eigene Update-Strategie, eigenes Compose-Setup.
Voraussetzungen sind dieselben (Cloud-Approval, Schritte 1–5 oben); danach:

```bash
mkdir pulse && cd pulse
curl -fsSLO https://howispulse.com/self-host/docker-compose.yml
curl -fsSL  https://howispulse.com/self-host/env.example -o .env
# .env ausfüllen — am einfachsten: "Meine Instanzen" → .env-Download als Basis
docker compose up -d
```

Zwei Varianten:

- **`docker-compose.yml`** — Standardfall: Auto-TLS, der Container holt das
  Let's-Encrypt-Cert selbst und belegt 80/443.
- **`docker-compose.behind-proxy.yml`**
  (`https://howispulse.com/self-host/docker-compose.behind-proxy.yml`) — du hast
  schon einen Reverse-Proxy mit eigenem Zertifikat: der Container exponiert nur
  `127.0.0.1:8080`, dein Proxy übernimmt TLS (Proxy-Snippets
  [unten](#hinter-einem-bestehenden-reverse-proxy-pulse_tls_modebehind-proxy)).
  Start: `docker compose -f docker-compose.behind-proxy.yml up -d`

Im Repo liegen beide Dateien unter `infra/self-host/`.

**Updates** liegen auf diesem Pfad in deiner Hand — es läuft bewusst kein
Auto-Updater-Container mit (Docker-Socket = root-äquivalent, siehe
[Updates](#was-passiert-bei-updates)):

```bash
docker compose pull && docker compose up -d
```

manuell, oder als Host-Cron/systemd-Timer. Beachte die Update-Pflicht
([unten](#was-passiert-bei-updates)) — wer zu lange auf einer alten Version
bleibt, riskiert eine inkompatible Protocol-Version gegenüber der Cloud.

---

## TLS + Public-Reach

### Standard: Caddy Auto-TLS (Let's Encrypt)

Caddy holt automatisch ein TLS-Cert, solange Port 80+443 erreichbar sind und der
DNS-A-Record korrekt gesetzt ist. Cert wird in `/data/caddy/` gecacht, überlebt
Container-Restarts.

**Problem:** „Caddy hängt beim Start" → DNS-A-Record fehlt oder Ports gesperrt.
Lösung: DNS prüfen, Firewall checken, dann Container neustarten.

### Hinter einem bestehenden Reverse-Proxy (`PULSE_TLS_MODE=behind-proxy`)

Wenn auf dem Host **schon ein Reverse-Proxy läuft** (z.B. weil andere Dienste
80/443 belegen), terminierst du TLS dort und lässt den Pulse-Container nur
HTTP-Routing machen. Der Container belegt dann **keine 80/443**:

```bash
docker run -d --name pulse --restart unless-stopped \
  -v pulse-data:/data \
  -p 127.0.0.1:8080:8080 \
  -p 3478:3478 -p 3478:3478/udp -p 7882-7892:7882-7892/udp \
  -p 1936:1936 -p 8189:8189/udp \
  --env-file /pfad/zu/.env \
  -e PULSE_TLS_MODE=behind-proxy \
  ghcr.io/oblivion8282-1337/pulse-allinone:stable
```

Dann **eine** Proxy-Regel auf `http://127.0.0.1:8080`. Der Container kümmert sich
intern um das gesamte Pfad-Routing (`/api/*`, `/ws`, `/whep`, `/livekit`, SPA) —
du reichst einfach alles durch.

**Caddy** (WebSockets sind automatisch dabei — wirklich nur diese zwei Zeilen):

```caddy
pulse.firma.de {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx** (WebSocket-Header musst du explizit weiterreichen):

```nginx
server {
    listen 443 ssl;
    server_name pulse.firma.de;
    # ssl_certificate / ssl_certificate_key … (z.B. via certbot)

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket-Upgrade (für /ws + /livekit zwingend):
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

**Nginx Proxy Manager** (GUI): neuer **Proxy Host** →

1. Domain Names: `pulse.firma.de` · Scheme `http` · Forward Hostname/IP
   `127.0.0.1` · Forward Port `8080`
2. **„Websockets Support" aktivieren** — ohne den Schalter bricht die
   Chat-Verbindung (`/api/ws`), weil die Upgrade-Header fehlen.
3. Tab **SSL**: vorhandenes Zertifikat auswählen (oder „Request a new SSL
   Certificate"), „Force SSL" an.

**Wichtig:** Voice (LiveKit/coturn) läuft über **UDP** (3478, 7882–7892), nicht
über den HTTP-Proxy — diese Ports musst du weiterhin direkt am Container öffnen
(siehe `-p` oben). Reines Chat/Login funktioniert auch ohne sie.

Interner Port via `PULSE_HTTP_PORT` änderbar (Default 8080), falls 8080 belegt ist.

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

Der **One-Command-Installer richtet Auto-Updates über einen Host-systemd-Timer
ein** — keinen Watchtower-Container. Er legt `pulse-update.sh` neben die
`pulse.env` und ein `pulse-update.service`/`.timer`-Paar unter
`/etc/systemd/system/` an. Das Skript zieht alle 5 Minuten das Image und
erstellt den Container **nur dann** neu, wenn sich der Digest geändert hat.

```bash
systemctl status pulse-update.timer    # läuft der Updater?
journalctl -u pulse-update --no-pager  # was hat er zuletzt getan?
/opt/pulse/pulse-update.sh             # manuell sofort aktualisieren
```

**Warum kein Watchtower?** Watchtower mountet den Docker-Socket — das ist
root-äquivalent auf dem Host. Der Timer hält den Update-Code stattdessen als
kleines, lesbares Host-Skript; **kein Container besitzt den Socket**. Abschalten
mit `PULSE_NO_AUTOUPDATE=1` vor dem Install (Alias: `PULSE_NO_WATCHTOWER=1`).

**Manueller Pfad (Docker Compose / `docker run`):** kein automatisches Update —
du updatest selbst (`docker compose pull && docker compose up -d`), manuell oder
per eigenem Host-Cron/Timer.

Bei einem Update:

1. Container stoppt (alle Services gleichzeitig down).
2. Neues Image wird gestartet.
3. Alembic-Migrationen laufen automatisch.
4. Container kommt wieder hoch (~20–30 s, Cert schon gecacht).

**Konsequenz:** Laufende Voice-Calls und HQ-Streams werden unterbrochen.
Clients reconnecten automatisch binnen 30 s. Bei Datenbank-Migrations-Fehler
startet der Container nicht — `docker logs pulse` zeigt den Fehler.

**Hinweis Backup:** Ein **periodischer** `pg_dump` läuft im Container (Default
täglich, nach `/data/backups`, im Admin-Panel unter „Backups" sichtbar;
`PULSE_BACKUP_INTERVAL_SECONDS`, `PULSE_BACKUP_RETENTION` Default 7,
`PULSE_BACKUP_DISABLED=true` schaltet ihn ab). Es gibt **kein** dediziertes
Pre-Update-Backup — der jüngste periodische Dump kann also bis zu einem Intervall
alt sein. Vor einem riskanten Update bei Bedarf manuell sichern:
`docker exec pulse gosu pulse pg_dump -Fc … > backup.dump`.

**Updates sind Pflicht.** Wer das Auto-Update deaktiviert (`PULSE_NO_AUTOUPDATE`),
riskiert beim nächsten Cloud-Deploy eine inkompatible Protocol-Version — der
WS-Hello-Check blockt dann alle Verbindungen.

---

## Backups

Backups werden automatisch in `/data/backups/` abgelegt (periodischer pg_dump,
Default täglich, 7 Kopien Retention; `PULSE_BACKUP_INTERVAL_SECONDS` /
`PULSE_BACKUP_RETENTION` / `PULSE_BACKUP_DISABLED` in der `.env`). Im
Admin-Panel unter „Backups" sichtbar.

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

## Deinstallation — Server wieder loswerden

Drei Schritte, in dieser Reihenfolge:

### 1. Instanz in der Cloud löschen

Auf [howispulse.com](https://howispulse.com) unter **Einstellungen → Meine
Instanzen** → **Löschen**. Das entfernt die Instanz endgültig aus deinem Konto,
gibt den Hostnamen für neue Anträge frei und setzt sie auf die Sperrliste —
ein noch laufender Container stellt damit den Betrieb ein. Das kann nicht
rückgängig gemacht werden; für einen Neustart stellst du einfach einen neuen
Antrag.

### 2. Container, Updater und Daten entfernen

**Installer-Setup** (One-Command-Installer):

```bash
sudo systemctl disable --now pulse-update.timer
sudo rm /etc/systemd/system/pulse-update.{service,timer}
sudo systemctl daemon-reload
docker rm -f pulse
sudo rm -rf /opt/pulse
```

(Beim non-root-Install gibt es keine systemd-Units — stattdessen den
Cron-Eintrag und das Updater-Verzeichnis entfernen:
`crontab -l | grep -v 'pulse-update.sh' | crontab -` und `rm -rf ~/.pulse`.)

**Compose-Setup** (manueller Pfad):

```bash
docker compose down
```

**Daten löschen** — erst nach einem letzten Backup, falls du die Inhalte noch
brauchst (siehe [Backups](#backups)):

```bash
docker volume rm pulse-data
```

Damit sind alle Server-Daten (Datenbank, Uploads, Zertifikate, Schlüssel)
unwiderruflich weg.

### 3. Mitglieder informieren

Der Server verschwindet **nicht automatisch** aus den Server-Listen deiner
Mitglieder — jeder entfernt ihn selbst (Rechtsklick auf das Server-Symbol →
**Server entfernen**). Sag deinen Leuten am besten vorher Bescheid.

---

## Datenschutz-Vorlage

`docs/PRIVACY_SELF_HOST_TEMPLATE.md` enthält eine Datenschutzerklärung die Self-
Hoster auf ihrer Domain veröffentlichen können (DSGVO-Pflicht).
