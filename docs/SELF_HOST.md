# Pulse selbst hosten

Pulse läuft als **ein Docker-Container** — Backend, Postgres, Redis, LiveKit
(Voice), MediaMTX (HQ-Streaming), MinIO, coturn und Caddy sind eingebettet.
Die Web-App und die Nutzer-Identität bleiben bei der Cloud: deine Leute melden
sich auf [howispulse.com](https://howispulse.com) an und verbinden sich von dort
zu deinem Server. Dein Server braucht dafür nur **ausgehendes HTTPS** zur Cloud.

---

## Voraussetzungen

1. **Freigegebene Instanz.** Self-Hosting läuft über die Cloud: Account anlegen,
   MFA aktivieren, unter **Einstellungen → Self-Host** eine Instanz beantragen
   und auf die Freigabe warten. Danach hast du deine Werte (siehe unten).
2. **Ein Server** mit Docker und Docker Compose.
3. **Ein Hostname mit DNS-A-Record** auf die Server-IP (z. B. `chat.firma.de`).
   Vor dem ersten Start setzen, sonst hängt Caddy beim Cert-Holen.
4. **Offene Ports:**

   | Port | Protokoll | Wofür |
   |---|---|---|
   | 80, 443 | TCP | HTTP/HTTPS (Let's-Encrypt-Challenge + App) |
   | 3478 | TCP + UDP | coturn (NAT-Traversal für Voice) |
   | 7882–7892 | UDP | LiveKit WebRTC (Voice) + HQ-Stream-ICE |
   | 1936 | TCP | HQ-Streaming-Ingest (RTMPS) |
   | 8189 | UDP | HQ-Stream-Wiedergabe (WHEP) |

   ```bash
   ufw allow 80,443/tcp
   ufw allow 3478
   ufw allow 7882:7892/udp
   ufw allow 1936/tcp
   ufw allow 8189/udp
   ```

Reines Chat/Login funktioniert auch ohne die Voice-/Stream-Ports — die sind nur
für Voice und HQ-Streaming nötig.

---

## Zwei Wege

- **Installer-Script** — ein Befehl, richtet auch automatische Updates ein.
  Generiere ihn in der App unter **Einstellungen → Self-Host → Server einrichten**:

  ```bash
  curl -fsSL https://howispulse.com/install | PULSE_BOOTSTRAP_TOKEN=<DEIN_TOKEN> bash
  ```

  Das war's. Details: `https://howispulse.com/install/guide`.

- **Manuell mit Docker Compose** — wenn du den Stack selbst verwalten willst
  (eigener Proxy, eigene Update-Strategie). Das ist der Rest dieser Anleitung.

---

## Manuelle Installation

### 1. Fertige `.env` holen

In der App: **Einstellungen → Self-Host → Server einrichten** → Abschnitt
**Manuelle Installation** → **`.env` herunterladen**. Die Datei ist komplett
ausgefüllt — Hostname, Instanz-ID, Owner-ID, Client-ID, ein frisch erzeugtes
`PULSE_CLOUD_CLIENT_SECRET` und deine Admin-Mail. Du musst nichts von Hand
eintragen.

> Jeder Download erzeugt ein **neues** Secret und entwertet das vorherige —
> lade die Datei einmal herunter und bewahre sie sicher auf. Alle weiteren
> internen Geheimnisse (DB-Passwort, JWT-/LiveKit-/MinIO-Keys) erzeugt der
> Container beim ersten Start selbst im `/data`-Volume.

### 2. Dateien holen und starten

```bash
mkdir pulse && cd pulse
curl -fsSLO https://howispulse.com/self-host/docker-compose.yml
# die in Schritt 1 heruntergeladene Datei hierher legen und in ".env" umbenennen:
mv ~/Downloads/pulse-instance-*.env .env
docker compose up -d
```

Der eingebettete Caddy holt jetzt selbst ein Let's-Encrypt-Zertifikat (Port
80 + 443 müssen erreichbar sein, DNS muss stimmen). Der erste Start dauert
60–120 Sekunden (Datenbank-Init, Migrationen, Cert-Holen).

### 3. Hinter einem vorhandenen Reverse-Proxy

Läuft auf dem Host **schon** ein Proxy auf 80/443 (nginx, Traefik, Caddy, Nginx
Proxy Manager)? Dann nimm die Behind-Proxy-Variante — der Container belegt keine
80/443 und macht nur HTTP-Routing auf `127.0.0.1:8080`:

```bash
curl -fsSLO https://howispulse.com/self-host/docker-compose.behind-proxy.yml
docker compose -f docker-compose.behind-proxy.yml up -d
```

In deinem Proxy genügt **eine** Regel auf `http://127.0.0.1:8080` — der Container
übernimmt das gesamte interne Routing. WebSocket-Upgrade muss durchgereicht
werden (bei Nginx Proxy Manager: „WebSocket Support" anhaken). Für Caddy reicht:

```caddy
pulse.firma.de {
    reverse_proxy 127.0.0.1:8080
}
```

**Wichtig:** Voice und HQ-Streaming laufen über UDP **direkt** zum Server, am
HTTP-Proxy vorbei — die UDP-/Media-Ports aus den Voraussetzungen müssen offen
bleiben.

### 4. Prüfen und einloggen

```bash
curl https://chat.firma.de/health         # {"status":"ok"}
curl https://chat.firma.de/health/setup   # wie weit der Erststart kam
docker exec pulse pulse-doctor            # Rundum-Prüfung von innen
```

Dann auf [howispulse.com](https://howispulse.com) → **Server hinzufügen** →
deinen Hostname eintragen. Als Owner wirst du automatisch Admin der Instanz.

Danach einmal **Einstellungen → Self-Host → Meine Instanzen → „Verbindung
prüfen"**: das ist die Prüfung von aussen, und sie sieht die Dinge, die von
innen unsichtbar bleiben — allen voran einen Reverse-Proxy, der WebSockets
nicht durchreicht (dann funktioniert alles ausser dem Chat selbst).

> Rufst du deine Server-Domain direkt im Browser auf, siehst du eine **leere
> Seite** — das ist Absicht. Ein Self-Host hat keine eigene Login-/Anmeldeseite;
> Identität und Client laufen über die Cloud. Login oder Registrierung direkt auf
> der Server-Domain sind nicht möglich.

---

## Betrieb

### Updates

Auf dem manuellen Weg updatest du selbst — bewusst läuft **kein**
Auto-Updater-Container mit (ein Updater mit Docker-Socket wäre root-äquivalent
auf dem Host):

```bash
docker compose pull && docker compose up -d
```

Bei Bedarf in einen Host-Cron oder systemd-Timer packen. **Updates sind Pflicht:**
wer zu lange auf einer alten Version bleibt, riskiert eine inkompatible
Protokoll-Version gegenüber der Cloud — dann blockt der Verbindungs-Check.

### Backups

Der Container macht automatisch periodische `pg_dump`-Snapshots nach
`/data/backups/` (Default täglich, 7 Kopien, im Admin-Panel unter „Backups"
sichtbar). Steuerbar über `PULSE_BACKUP_INTERVAL_SECONDS`,
`PULSE_BACKUP_RETENTION`, `PULSE_BACKUP_DISABLED` in der `.env`.

Verschlüsselung der Backups ist Host-Sache (LUKS, ZFS-Encryption o. Ä.) —
am besten das ganze `/data`-Volume auf ein verschlüsseltes Device legen.

```bash
docker compose exec pulse pg_dump -U pulse pulse > backup-$(date +%Y%m%d).sql
```

---

## Troubleshooting

### Zuerst: die beiden Werkzeuge

**Von aussen** — in der App unter **Einstellungen → Self-Host → Meine
Instanzen → „Verbindung prüfen"**. Die Cloud geht die ganze Kette ab (Name,
Port, Zertifikat, Weiterleitung, Browser-Freigabe, Live-Verbindung, die Ports
für Ton und Bild) und nennt das Glied, das fehlt. Das ist das Einzige, was ein
Server über sich selbst nicht sagen kann.

**Von innen** — auf dem Server:

```bash
docker exec pulse pulse-doctor
```

Trennt drei Richtungen: laufen die Dienste, erreicht der Container die Cloud,
ist der eigene Name ansprechbar. Innen grün und aussen rot heisst DNS,
Firewall oder Proxy — nicht der Server.

> Der Selbstaufruf über den eigenen Namen wird als **unklar** gemeldet und
> nicht als Fehler: etliche Router können den eigenen öffentlichen Namen von
> innen nicht auflösen (fehlendes Hairpin-NAT). Entschieden wird das nur von
> aussen.

Wie weit der Erststart gekommen ist, steht ausserdem unter
`https://<hostname>/health/setup` (öffentlich, nur Phasennamen).

### Die häufigsten Fälle

**Caddy startet nicht / kein Zertifikat.** Fast immer: DNS-A-Record zeigt noch
nicht auf die richtige IP, oder Port 80 ist durch eine vorgelagerte Firewall
gesperrt. DNS und Firewall prüfen, dann `docker compose restart`.

```bash
docker compose logs pulse 2>&1 | grep -i "caddy\|tls\|acme"
```

**Health meldet `degraded`.** `GET /health` zeigt im `failed`-Feld, was klemmt
(`db` = Postgres, `redis` = Redis, `jwks` = Cloud nicht erreichbar, `disk` =
unter 20 % frei). `docker compose logs pulse | tail -50` zeigt die Ursache.

**Alles sieht gut aus, aber der Chat bleibt leer.** Der Reverse-Proxy davor
reicht WebSocket-Verbindungen nicht durch — die häufigste Falle überhaupt, und
die einzige, die man mit `curl` nicht sieht: `/health`, das Hinzufügen des
Servers und das Anmelden funktionieren alle. Bei nginx fehlen die
`Upgrade`-Kopfzeilen, beim Nginx Proxy Manager der Haken „WebSockets Support".
Die Prüfung von aussen meldet das als **Live-Verbindung**.

**Chat geht, Voice nicht.** Die UDP-Ports (3478, 7882–7892) sind nicht offen —
Voice läuft am HTTP-Proxy vorbei direkt zum Container. Die Prüfung von aussen
meldet das als **Sprachverbindung (UDP)**.

**Anmelden schlägt fehl, der Server läuft aber.** Der Server erreicht die
Cloud nicht (`curl https://howispulse.com/.well-known/jwks.json` auf dem
Server testen) — ausgehendes HTTPS muss funktionieren. Ohne die JWKS lehnt der
Gateway jede Verbindung ab, und von aussen sieht das aus, als wäre er kaputt.

**Der Installer bricht mit „ports already in use" ab.** Ein anderer Dienst
hält einen der Ports, die Pulse für Ton und Bild braucht. Der Abbruch kommt
absichtlich, BEVOR der Einrichtungs-Token verbraucht wird — der Befehl bleibt
also gültig, sobald der Port frei ist.

---

## Deinstallation

```bash
docker compose down          # Container stoppen
docker volume rm pulse-data  # ALLE Daten löschen (vorher sichern!)
```

Danach die Instanz in der App unter **Einstellungen → Meine Instanzen** löschen
(gibt den Hostnamen frei). Der Server verschwindet nicht automatisch aus den
Server-Listen deiner Mitglieder — die entfernen ihn selbst per Rechtsklick →
**Server entfernen**.

---

## Mehr

- **Datenschutz-Vorlage** für deine Domain (DSGVO): `docs/PRIVACY_SELF_HOST_TEMPLATE.md`
- **Alle `.env`-Optionen** (Log-Level, coturn abschalten, öffentliche IP setzen):
  Kommentare in `infra/self-host/.env.example`
- **Eigenes Zertifikat** statt Auto-TLS (für Cloudflare Tunnel, Tailscale Funnel,
  internes Netz): `PULSE_TLS_MODE=provided` setzen und Cert + Key unter
  `/data/certs/cert.pem` + `key.pem` ablegen.
- **Image-Aufbau, gebündelte Versionen, Volumes:** `infra/self-host/README.md`
