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

  > Der Installer zieht standardmässig `registry.howispulse.com/pulse-allinone:edge`
  > — den rollenden Kanal, nicht `:stable`. In der aktuellen Früh-/Security-Phase
  > taggt jeder Push auf `main` beide Kanäle identisch (dieselbe Version steht
  > hinter `:edge` und `:stable`), das ändert sich erst mit echten getaggten
  > Releases. Willst du schon jetzt fest auf `:stable` pinnen (oder ein eigenes
  > Image), setze `PULSE_IMAGE`:
  > ```bash
  > curl -fsSL https://howispulse.com/install | PULSE_BOOTSTRAP_TOKEN=<TOKEN> \
  >   PULSE_IMAGE=registry.howispulse.com/pulse-allinone:stable bash
  > ```

- **Manuell mit Docker Compose** — wenn du den Stack selbst verwalten willst
  (eigener Proxy, eigene Update-Strategie). Das ist der Rest dieser Anleitung.

### Installer: Umgebungsvariablen

Der Installer liest weitere `PULSE_*`-Variablen als Overrides — vor dem Aufruf
per Env setzen (wie bei `PULSE_IMAGE` oben). Alle haben einen automatisch
ermittelten Default; nötig sind sie nur in Sonderfällen. Gilt nur für den
Installer-Weg, nicht für Compose (dort steuert die `.env`; was darin möglich
ist, erklärt die Referenz `https://howispulse.com/self-host/env.example`, im
Repo `infra/self-host/.env.example`). Die vollständige Liste (u. a. `PULSE_CONTAINER`,
`PULSE_VOLUME`, `PULSE_DIR`, `PULSE_HTTP_PORT`, `PULSE_NO_AUTOUPDATE`,
`PULSE_CLOUD_ORIGIN`) steht kanonisch unter
`https://howispulse.com/install/guide` → Abschnitt „Environment overrides" —
dort zuerst eintragen, wenn ein neuer Schalter dazukommt. Hier nur die beiden,
auf die sich Text weiter unten in diesem Dokument stützt:

| Variable | Wirkung | Default |
|---|---|---|
| `PULSE_NETWORK` | Docker-Netz, dem der Container beitritt. **Pflicht**, wenn der erkannte Reverse-Proxy in mehr als einem Docker-Netz hängt — der Installer bricht sonst ab, statt zu raten, welches gemeint ist | automatisch erkannt |
| `PULSE_TLS_MODE` | Erzwingt `auto`, `provided` oder `behind-proxy`, statt die Proxy-Erkennung selbst entscheiden zu lassen | automatisch erkannt |

`PULSE_NETWORK=<name>` steht als Selbsthilfe auch direkt in der Fehlermeldung,
wenn sie zuschlägt — ohne diese Tabelle bliebe der Hinweis ohne Erklärung, was
der Wert eigentlich bewirkt. `PULSE_TLS_MODE=provided` ist der Weg zu einem
selbst mitgebrachten Zertifikat, siehe „Mehr" ganz unten.

---

## Manuelle Installation

Sechs Schritte. Arbeite sie der Reihe nach ab — Schritt 2 entscheidet, welche
Datei du überhaupt brauchst, und Schritt 3 wird gern vergessen.

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

**Sieh dir vorher zwei Werte an**, das erspart später Arbeit:

```bash
grep -E "^PULSE_(HOSTNAME|INSTANCE_ID|INSTANCE_OWNER_ID|INSTANCE_MODE)=" .env
```

- `PULSE_INSTANCE_OWNER_ID` ist die Konto-Kennung dessen, der die Instanz
  beantragt hat. **Nur dieses Konto wird auf dem Server automatisch Admin.**
  Dafür gibt es kein Auffangnetz: Meldest du dich später mit einem anderen
  Konto an, bist du dort ein gewöhnlicher Nutzer, und das lässt sich nur noch
  in der Datenbank ändern. Passt es nicht, stell den Antrag neu — jetzt ist es
  billig, nach dem ersten Start nicht mehr.
- `PULSE_HOSTNAME` muss exakt der Name sein, unter dem der Server später
  erreichbar ist. Daran hängt die Bindung des Anmelde-Tickets: Die Cloud stellt
  es auf genau diesen Namen aus, und der Server prüft, dass er gemeint ist.

`PULSE_TLS_MODE` steht absichtlich nicht in der Datei — den setzt die
Compose-Variante aus Schritt 2.

### 2. Die richtige Compose-Datei holen

Es gibt zwei, und die Wahl hängt an einer einzigen Frage: **Läuft auf der
Maschine schon etwas auf Port 80 und 443?**

| | Datei | Wann |
|---|---|---|
| **Nein** | `docker-compose.yml` | Die Maschine gehört Pulse allein. Der eingebettete Caddy holt sich selbst ein Let's-Encrypt-Zertifikat. |
| **Ja** | `docker-compose.behind-proxy.yml` | Es läuft schon ein Proxy (nginx, Traefik, Caddy, Nginx Proxy Manager). Pulse fasst 80/443 nicht an und bietet nur HTTP auf `8080` an; TLS macht weiterhin dein Proxy. |

Nimmst du die falsche, kommt der Container nicht hoch — und im schlechtesten
Fall reisst er die anderen Seiten auf der Maschine mit. Im Zweifel nachsehen:

```bash
ss -tlnp | grep -E ':(80|443)\s'
```

Dann Verzeichnis anlegen, Datei holen, `.env` daneben legen:

```bash
mkdir pulse && cd pulse
curl -fsSLO https://howispulse.com/self-host/docker-compose.yml
# oder, hinter eigenem Proxy:
curl -fsSLO https://howispulse.com/self-host/docker-compose.behind-proxy.yml

mv ~/Downloads/pulse-instance-*.env .env
```

Der Dateiname `.env` ist Pflicht — Compose sucht genau den im selben Ordner.

### 3. An der Registry anmelden

Das Image liegt in einer geschlossenen Registry; ohne Anmeldung antwortet sie
mit `401 unauthorized`, und der Start scheitert mit `pull access denied`. Die
Zugangsdaten stehen in deiner `.env`, du musst sie nicht abtippen:

```bash
docker login registry.howispulse.com \
  -u "$(grep -oP '^PULSE_CLOUD_CLIENT_ID=\K.*' .env)" \
  -p "$(grep -oP '^PULSE_CLOUD_CLIENT_SECRET=\K.*' .env)"
```

Erwartete Ausgabe: eine Warnung, dass das Passwort als Argument übergeben wurde,
und darunter `Login Succeeded`. Die Warnung ist hier folgenlos — dasselbe Secret
steht ohnehin im Klartext in der `.env` daneben.

### 4. Starten

```bash
docker compose up -d
# oder, hinter eigenem Proxy:
docker compose -f docker-compose.behind-proxy.yml up -d
```

Der erste Start dauert 60–120 Sekunden: Datenbank anlegen, Migrationen fahren,
auf dem Standardweg zusätzlich das Zertifikat holen. Warte, bis hier `(healthy)`
steht:

```bash
docker ps --filter name=pulse --format '{{.Names}}\t{{.Status}}'
```

Die Logs melden beim ersten Start **immer** ein paar Dinge, die wie Fehler
aussehen und keine sind:

| Zeile | Bedeutung |
|---|---|
| `STUN CHANGE_REQUEST … only one IP address` | coturn mit einer IP-Adresse. Für NAT-Traversal genügt das. |
| `caddyfile: Unnecessary header_up …` | Der Caddy **im** Container, nicht deiner. Kosmetik. |
| `MinIO: Host local has more than 0 drives` | Einzelknoten-Betrieb, so gewollt. |
| `relation "…" does not exist` | Eine Abfrage kam der Migration zuvor. Bei leerer Datenbank gibt es nichts zu finden. |
| `pubsub: drained 0/7 subscribe acks` | Reihenfolge beim Hochfahren. |
| `jwks_cold_start` | Die Cloud-Schlüssel sind noch nicht geholt. Der Poller läuft alle 30 s, das heilt sich selbst — eine Anmeldung in den ersten Sekunden scheitert aber mit `jwks_cold`. Dann einfach noch einmal versuchen. |
| `vapid_auto_generated` | Push-Benachrichtigungen bekommen neue Schlüssel. Merken für später: Ohne feste `VAPID_*`-Werte verfallen Push-Abos bei jedem Neustart still. |

Alles andere liest du am besten so:

```bash
docker logs pulse 2>&1 | grep -iE "error|fatal|traceback" | tail -20
```

### 5. Die Proxy-Regel anlegen

Nur auf dem Behind-Proxy-Weg. In deinem Proxy genügt **eine** Regel — den Rest
routet der Container selbst. **WebSocket-Upgrade muss durchgereicht werden**
(bei Nginx Proxy Manager: „WebSocket Support" anhaken); ohne das funktioniert
die Anmeldung, aber der Chat selbst nicht.

**Läuft dein Proxy direkt auf dem Host?** Dann zeigt die Regel auf die
Loopback-Adresse:

```caddy
chat.firma.de {
    reverse_proxy 127.0.0.1:8080
}
```

**Läuft dein Proxy selbst in einem Container?** Dann kommt er an `127.0.0.1`
des Hosts **nicht** heran — das ist sein eigenes Loopback. Beide müssen sich
ein Docker-Netz teilen, dann sprechen sie über den Container-Namen:

```bash
docker network create pulse-net
docker network connect pulse-net <name-deines-proxy-containers>
```

In der Compose-Datei zwei Blöcke ergänzen. Beim Dienst `pulse`, eingerückt wie
`ports:` und `volumes:`:

```yaml
    networks:
      - pulse-net
```

und ganz am Dateiende, neben dem vorhandenen `volumes:`-Block:

```yaml
networks:
  pulse-net:
    external: true
```

`external: true` heisst: Compose legt das Netz nicht selbst an, sondern benutzt
das, an dem dein Proxy schon hängt. Die beiden Blöcke heissen zufällig gleich,
meinen aber Verschiedenes — der eingerückte sagt „dieser Dienst hängt in dem
Netz", der linksbündige „so ist das Netz definiert". Die Regel zeigt danach auf
den Container-Namen:

```caddy
chat.firma.de {
    reverse_proxy pulse:8080
}
```

Nach dem Ändern der YAML-Datei prüfen, ohne zu starten:

```bash
docker compose -f docker-compose.behind-proxy.yml config >/dev/null && echo "YAML ok"
```

**Wichtig, unabhängig vom Proxy:** Voice und HQ-Streaming laufen über UDP
**direkt** zum Server, am HTTP-Proxy vorbei — die UDP-/Media-Ports aus den
Voraussetzungen müssen offen bleiben. Fehlen sie, ist das Muster eindeutig:
Chat geht, Voice nicht.

### 6. Prüfen und einloggen

Erst von aussen, in dieser Reihenfolge:

```bash
curl https://chat.firma.de/health         # {"status":"ok"}
curl https://chat.firma.de/.well-known/pulse-server-info
```

Die zweite Zeile ist die aussagekräftigste. Darin muss stehen:

- deine **`instance_id`** — dieselbe Zahl wie in der `.env`,
- in **`capabilities`** der Eintrag **`server-ticket`**. Daran erkennt die App,
  dass der Server den heutigen Anmeldeweg spricht. Fehlt er, nimmt der Server
  niemanden mehr auf, und ein Update allein genügt nicht — dann läuft dort ein
  Stand von vor dem 2026-08-28 und muss neu aufgesetzt werden.

Für den Blick von innen:

```bash
docker exec pulse pulse-doctor            # Rundum-Prüfung
curl https://chat.firma.de/health/setup   # wie weit der Erststart kam
```

Dann auf [howispulse.com](https://howispulse.com) → **Server hinzufügen** →
deinen Hostname eintragen. Melde dich mit dem Konto an, das die Instanz
beantragt hat (siehe Schritt 1) — nur das wird automatisch Admin.

Danach einmal **Einstellungen → Self-Host → Meine Instanzen → „Verbindung
prüfen"**: das ist die Prüfung von aussen, und sie sieht die Dinge, die von
innen unsichtbar bleiben — allen voran einen Reverse-Proxy, der WebSockets
nicht durchreicht.

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

Der Installer-Weg macht dasselbe automatisch, prüft aber zusätzlich, ob der
neue Container seit dem Start wirklich durchgehend läuft — ohne einen
einzigen Neustart, nicht nur "läuft gerade" —, und macht sonst selbst einen
Rollback —
Mechanik samt der beiden Fein-Regler `PULSE_UPDATE_STABIL_VERSUCHE`/
`PULSE_UPDATE_STABIL_INTERVALL` (nur für den generierten Updater selbst
relevant, nicht für den `curl`-Aufruf) stehen unter
`https://howispulse.com/install/guide` → Abschnitt 7.

### Backups

Der Container macht automatisch periodische `pg_dump`-Snapshots nach
`/data/backups/` (Default täglich, 7 Kopien, im Admin-Panel unter „Backups"
sichtbar). Steuerbar über `PULSE_BACKUP_INTERVAL_SECONDS`,
`PULSE_BACKUP_RETENTION`, `PULSE_BACKUP_DISABLED` in der `.env`.

Verschlüsselung der Backups ist Host-Sache (LUKS, ZFS-Encryption o. Ä.) —
am besten das ganze `/data`-Volume auf ein verschlüsseltes Device legen.

```bash
docker compose exec pulse pg_dump -h 127.0.0.1 -U pulse dcc > backup-$(date +%Y%m%d).sql
```

Die Datenbank heisst intern `dcc`, nicht `pulse` — nur die Rolle heisst `pulse`.
`-h 127.0.0.1` ist Pflicht: Postgres im Container lauscht zusätzlich zum
Unix-Socket auch auf `127.0.0.1`, aber der Socket-Pfad ist nicht der
Standardpfad (`-k /var/run/pulse`), den `pg_dump` ohne `-h` suchen würde. Der
automatische Backup-Dienst im Container macht denselben Dump im
komprimierten `--format=custom` (per `pg_restore` wiederherstellbar); der
Befehl hier nutzt bewusst das einfache SQL-Textformat.

---

## Troubleshooting

> Die Befehle unten nennen den Container beim Vorgabenamen `pulse`. Über den
> Compose-Weg ist der fest (`container_name: pulse` in der Compose-Datei);
> beim Installer-Skript gilt statt dessen dein `PULSE_CONTAINER`, falls du
> ihn beim Einrichten gesetzt hast.

### Der Installer sagt es dir schon

Am Ende jeder Installation läuft die Prüfung von aussen automatisch, und das
Ergebnis steht **im Terminal**, nicht nur in der App:

```
    [ ok ] Name lookup
    [ ok ] Reachability (port 443)
    [FAIL] Encryption

    [ -- ] not checked, the chain stopped before them:
           Server condition, Identity, Browser access, Live connection

  ------------------------------------------------------------------
  THIS IS WHERE IT BREAKS: Encryption

    The connection on port 443 is accepted, but no encrypted connection
    is established. So something answers there — just not Pulse.

    WHAT TO DO
    Usually a foreign firewall or a different server sits at this
    address. First check whether the A record really points at this
    machine. ...
```

Zwei Dinge daran sind Absicht. **Nur das erste Kreuz** bekommt die lange
Erklärung — die Glieder danach wiederholen in aller Regel dieselbe Ursache.
Und die ausgelassenen Glieder werden **benannt**: eine abgebrochene Kette darf
sich nicht wie eine vollständige lesen.

Läuft die Prüfung gerade nicht (kein Netz, Cloud nicht erreichbar), kommst du
jederzeit über `docker exec pulse pulse-doctor` an dieselben Sätze.

### Die beiden Werkzeuge für später

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

`pulse-doctor` vergleicht ausserdem, **worauf dein Name zeigt** und **als was
sich diese Maschine nach draussen meldet**. Sind die beiden verschieden, ist
das der häufigste Grund für „das Zertifikat kommt nicht":

```
Zeigt der Name auf diese Maschine?
  unklar  chat.firma.de zeigt auf 203.0.113.226 — diese Maschine ist 203.0.113.228
```

Auch das ist bewusst **unklar** und kein Fehler, denn es gibt zwei Deutungen
mit verschiedenen Handgriffen: der A-Eintrag zeigt auf den falschen Rechner —
oder das Netz hat getrennte Ein- und Ausgänge (Firmen-Firewall). Im zweiten
Fall muss die Firewall Port 80 und 443 hierher weiterleiten, **und** Pulse
gehört mit `PULSE_TLS_MODE=behind-proxy` gestartet; sonst versucht es
vergeblich, sich selbst ein Zertifikat zu holen.

Wie weit der Erststart gekommen ist, steht ausserdem unter
`https://<hostname>/health/setup` (öffentlich, nur Phasennamen).

### Die häufigsten Fälle

**Caddy startet nicht / kein Zertifikat.** Fast immer: DNS-A-Record zeigt noch
nicht auf die richtige IP, oder Port 80 ist durch eine vorgelagerte Firewall
gesperrt. DNS und Firewall prüfen, dann `docker compose restart`.

```bash
docker compose logs pulse 2>&1 | grep -i "caddy\|tls\|acme"
```

**Health meldet `degraded`.** `GET /health` liefert dann 503 mit einem
`failed`-Feld — das enthält ausschliesslich `db` (Postgres) und/oder `redis`.
Fehlt nur die JWKS (Cloud noch nicht erreicht, direkt nach dem Start normal),
bleibt der Status bei 200: `{"status":"warming_up","warming":["jwks"]}` — kein
Fehlerfall. Die Speicherplatzbelegung steht in `/health` gar nicht; sie liefert
nur der interne, secret-geschützte `/internal/health-probe`-Endpunkt
(`disk_usage`/`disk_warning`, braucht den `X-Pulse-Internal-Secret`-Header).
`docker compose logs pulse | tail -50` zeigt die Ursache.

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

Diese Ports lassen sich **nicht** einfach auf einen anderen umlegen (kein
`-p 9882:7882/udp`): WebRTC trägt seine Portnummer selbst in den
ICE-Kandidaten, die es dem anderen Ende ankündigt — eine Docker-Umleitung
ändert die tatsächlich lauschende Portnummer nicht mit, und die Verbindung
scheitert, weil der Server weiterhin 7882 ansagt, während aussen 9882 offen
ist. Wer den Port wirklich belegt braucht (z. B. ein zweiter Dienst auf
derselben Portnummer), weicht stattdessen auf eine **zweite IP** für Pulse
aus: `-p <IP>:7882-7892:7882-7892/udp` (entsprechend für 3478 und 8189) bindet
Pulse an eine eigene Adresse, ohne den bestehenden Dienst auf der ersten IP
anzufassen.

**Ich bin auf meinem eigenen Server kein Admin.** Dann bist du mit einem
anderen Cloud-Konto angemeldet als dem, mit dem du den Server beantragt hast.
Der Server sagt dir beides — beim Start, wem er laut Konfiguration gehört, und
bei jeder Anmeldung, wer sich gerade angemeldet hat:

```bash
docker logs pulse 2>&1 | grep -i "Cloud-Konto\|Cert-User"
```

```
Diese Instanz gehoert Cloud-Konto 4711 — nur dieses Konto wird hier Admin
Cert-User 9999 ist NICHT der Instanz-Owner (konfiguriert: 4711) — kein Admin
```

Zwei verschiedene Zahlen heisst: falsches Konto. Melde dich mit dem Konto an,
mit dem du den Antrag gestellt hast.

Wer den Server auf ein anderes Konto umschreiben muss, ändert
`PULSE_INSTANCE_OWNER_ID` in der `.env` und startet neu — in der Oberfläche
gibt es dafür bislang nichts.

> Kommt keine dieser Zeilen, läuft der Container auf einer zu leisen Stufe.
> `PULSE_LOG_LEVEL=info` in der `.env` setzen (das ist die Vorgabe) und neu
> starten. Ohne `info` ist diese Auskunft abgeschaltet.

---

## Deinstallation

Der Befehl unterscheidet sich danach, mit welchem der beiden Wege oben du
installiert hast — die Volume-Namen sind nicht dieselben.

**Installer-Weg** (rohes `docker run`, kein Compose-Projekt): Container heisst
schlicht `pulse`, Volume schlicht `pulse-data` — ohne Projekt-Präfix. Wurde
beim Installieren `PULSE_CONTAINER`/`PULSE_VOLUME` gesetzt, gelten die
abweichenden Namen von dort.

**Zuerst den Auto-Update-Takt abbauen — VOR `docker rm`.** Sonst holt der
nächste Fünf-Minuten-Takt den gerade gelöschten Container mitsamt leerem
Volume zurück: der generierte Updater bricht nicht ab, nur weil `$CONTAINER`
fehlt (ohne Container ist `cur_id` leer, `new_id` bleibt gesetzt — der
Digest-Vergleich schlägt fehl, kein früher Ausstieg) und startet ihn
stattdessen aus dem noch lokal liegenden Image neu. Welcher Weg gilt, stand
bei der Installation in der Ausgabe ("Auto-updates enabled …"); im Zweifel
beide versuchen, der jeweils andere schlägt folgenlos fehl:

```bash
# root-Install (systemd):
sudo systemctl disable --now pulse-update.timer
sudo rm /etc/systemd/system/pulse-update.{service,timer}
sudo systemctl daemon-reload

# non-root-Install (User-Crontab):
crontab -l | grep -v pulse-update.sh | crontab -
```

Erst danach:

```bash
docker rm -f pulse           # Container stoppen und entfernen
docker volume rm pulse-data  # ALLE Daten löschen (vorher sichern!)
```

**Compose-Weg**: Docker Compose stellt dem Volume-Namen den Projektnamen
voran — beim `mkdir pulse && cd pulse` aus Schritt 2 oben also `pulse` als
Projektname, das Volume heisst damit `pulse_pulse-data`, nicht `pulse-data`.
`docker compose down -v` kennt den richtigen Namen automatisch:

```bash
docker compose down -v   # Container stoppen UND das Volume (pulse_pulse-data) löschen
```

Nur `docker compose down` (ohne `-v`) lässt das Volume stehen — praktisch für
einen Reinstall ohne Datenverlust, aber dann bleibt danach zusätzlicher
Aufräumbedarf mit `docker volume rm pulse_pulse-data`, falls die Daten am Ende
doch weg sollen.

Danach die Instanz in der App unter **Einstellungen → Meine Instanzen** löschen
(gibt den Hostnamen frei). Der Server verschwindet nicht automatisch aus den
Server-Listen deiner Mitglieder — die entfernen ihn selbst per Rechtsklick →
**Server entfernen**.

---

## Mehr

- **Datenschutz-Vorlage** für deine Domain (DSGVO): `docs/PRIVACY_SELF_HOST_TEMPLATE.md`
- **Alle `.env`-Optionen** (Log-Level, coturn abschalten, öffentliche IP setzen):
  die kommentierte Referenz unter `https://howispulse.com/self-host/env.example`
  (im Repo `infra/self-host/.env.example`). Sie ist zum Nachschlagen da — die
  `.env`, mit der du startest, lädst du fertig aus der App.
- **Eigenes Zertifikat** statt Auto-TLS (für Cloudflare Tunnel, Tailscale Funnel,
  internes Netz): `PULSE_TLS_MODE=provided` setzen und Cert + Key unter
  `/data/certs/cert.pem` + `key.pem` ablegen.
- **Image-Aufbau, gebündelte Versionen, Volumes:** `infra/self-host/README.md`
