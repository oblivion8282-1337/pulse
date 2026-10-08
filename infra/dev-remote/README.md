# Gemeinsamer Remote-Dev-Stack (Hetzner)

Der Dev-Stack lief bisher auf jedem Rechner einzeln (`scripts/dev-up.fish`).
Hier läuft die **untere Hälfte** stattdessen einmal zentral auf dem Hetzner
(`77.42.71.166`, https://pulse.unicutmedia.com), und jeder Arbeitsrechner
startet nur noch Vite und Electron.

Seit 2026-08-25 liegt der Stack physisch auf dem Hetzner-Volume
`/mnt/HC_Volume_106700849/` (30 GB): Compose-Projekt in
`/mnt/HC_Volume_106700849/pulse-test`. Die Daten liegen in Named Volumes —
`pulsetest_pgdata` (Postgres) und `pulsetest_garagedata` (Garage, siehe
§2b); nur das alte `miniodata` ist weg und bleibt als verwaistes Volume mit
Test-Daten auf dem Host zurück (wird nicht migriert). `~/pulse-test` ist ein
Symlink dorthin, alle Skripte und `PULSE_DEV_DIR`-Defaults funktionieren
unverändert.

| Teil | Wo | Warum |
|---|---|---|
| Postgres, Redis, MinIO | Hetzner | Ein Zustand, von allen Rechnern aus. Ein Konto, eine Community, überall dieselbe. |
| LiveKit, MediaMTX | Hetzner | Der eigentliche Gewinn: ein Streaming-Test zwischen zwei Rechnern brauchte vorher beide im selben LAN am selben lokalen MediaMTX. |
| Die 5 FastAPI-Dienste | Hetzner | Quellcode eingehängt, `uvicorn --reload` — eine Änderung ist ~2 s nach dem Sync live. |
| Vite | **lokal** | HMR muss sofort sein. Über die Leitung wäre das ein Rückschritt. |
| Electron, Sidecars, nativer Player | **lokal** | Bildschirmaufnahme und GPU hängen physisch an der Maschine. |

Das Ganze kommt **ohne GitHub aus**: kein Commit, kein PR, kein CI-Lauf, kein
Image-Bau. Und weil der Hetzner an keinem `:latest` hängt, gibt es keinen Weg,
über den ein Sync versehentlich auf howispulse.com landet.

## Täglicher Ablauf

Auf dem Arbeitsrechner — Linux **und** Windows, es braucht nur Node:

```sh
pnpm dev:remote            # Vite (lokal, mit HMR) + Electron gegen den Hetzner
pnpm dev:remote:web        # nur Vite, ohne Electron
```

Backend geändert? Einmal hinschieben, die Dienste laden von selbst neu:

```sh
pnpm dev:sync              # einmalig
pnpm dev:sync:watch        # Dauerlauf: bei jedem Speichern automatisch
pnpm dev:remote:logs       # mitlesen, was die Dienste drüben sagen
```

Weitere Schalter: `scripts/dev-sync.sh --web` (Oberfläche bauen und unter
pulse.unicutmedia.com ausliefern — für Handy, fremden Rechner, verpackte App),
`--migrate` (Alembic), `--restart` (harter Neustart).

Anderer Server: `PULSE_DEV_HOST=user@host PULSE_DEV_DIR=pfad` vor beide
Skripte, oder `pnpm dev:remote --origin https://…`.

## Was noch einen Image-Bau braucht

Fast nichts — aber die Ausnahmen sollte man kennen, sonst sucht man den Fehler
an der falschen Stelle:

| Änderung | Weg |
|---|---|
| Python-Quellcode, Plugins, Migrationen | Sync, ~2 s |
| Oberfläche | lokal HMR; für die ausgelieferte Fassung `--web` |
| `mediamtx.yml`, `livekit.yaml`, nginx | Datei auf dem Server ändern, einen Container neu starten |
| **neue Abhängigkeit (`uv.lock`)** | **Image neu bauen** (siehe unten) |
| **MediaMTX-Fork-Patch** | **Image neu bauen** |

Die Images `pulsetest-*:local` sind seit dem Umbau nur noch
Abhängigkeits-Träger: sie liefern `/app/.venv`, der Quellcode kommt von außen.
`uv.lock` ist zuletzt am **2026-10-08** gewandert: der chat-gateway hängt
seither an `httpx[http2]`, weil die APNs-Anbieter-Schnittstelle ausschliesslich
HTTP/2 spricht (VoIP-Pushes, iOS-Punkt 40). **Das Image von `pulsetest-chat`
wurde dafür am 2026-10-08 neu gebaut** — und der Anlass ist lehrreich: im
`uv.lock` sah es so aus, als käme `h2` ohnehin über `firebase-admin` mit, und
lokal war es auch da. Im Container nicht, und der erste echte Sendeversuch
scheiterte an einem `ImportError`. Ein Lockfile-Eintrag ist keine Zusage über
das, was im Image liegt.

Der Bau-Parameter ist relativ zu `services/`, nicht der Pfad:

```bash
cd ~/pulse-test/repo && docker build -f Dockerfile.service \
  --build-arg SVC_DIR=chat-gateway --build-arg SVC_PKG=dcc_chat_gateway \
  -t pulsetest-chat:local .
```

Wenn doch einmal nötig: `~/pulse-test/repo` ist ein **alter Git-Checkout**, den
`dev-sync.sh` bewusst nicht anfasst (der Sync überträgt nur Quellcode, keine
`pyproject.toml`/`uv.lock`). Vor einem Neubau also **erst dort aktualisieren** —
sonst baut man die Abhängigkeiten eines Zweigs von vorgestern in das Image, und
weil der Quellcode ohnehin eingehängt wird, fällt der Unterschied erst auf, wenn
ein Import fehlschlägt.

```sh
cd ~/pulse-test/repo && git fetch && git checkout main && git pull
```

```sh
cd ~/pulse-test
# Format tag:svc-dir:import-pkg. Die TAGS müssen exakt dem Compose entsprechen
# (pulsetest-auth/chat/voice/media/hook:local, siehe image:-Zeilen im
# docker-compose.yml) — nicht den svc-Verzeichnisnamen. Nur auth decken beide ab.
for s in auth:auth:dcc_auth chat:chat-gateway:dcc_chat_gateway \
         voice:voice-signaling:dcc_voice_signaling media:media-svc:dcc_media_svc \
         hook:mediamtx-auth-hook:dcc_mediamtx_auth_hook; do
  tag=${s%%:*}; rest=${s#*:}; dir=${rest%%:*}; pkg=${rest#*:}
  docker build -f repo/Dockerfile.service repo \
    --build-arg SVC_DIR=$dir --build-arg SVC_PKG=$pkg \
    -t pulsetest-$tag:local
done
```

## Versions-Parität mit Produktion

Der Sinn dieses Stacks ist, dass ein Test hier etwas über Produktion aussagt.
Dafür müssen die Fremdbausteine dieselben sein. Stand 2026-08-18 sind
Postgres, Redis, MinIO und nginx identisch, und **MediaMTX und LiveKit sind
bewusst auf die Prod-Fassung gepinnt**:

| | Produktion | hier |
|---|---|---|
| MediaMTX-Fork | `1.19.1-pulse8` | `1.19.1-pulse8` |
| LiveKit | `v1.13.3` | `v1.13.3` |

Vorher lief hier ein lokal gebautes MediaMTX vom 2026-08-04 und LiveKit
`v1.11`. Dem Fork fehlten damit die 60-fps-Glättung (2026-08-14) und die
PLI-Drossel auf 500 ms (2026-08-15) — **genau die Art Abweichung, die einen
Streaming-Fehler vortäuscht, den es in Produktion nicht gibt.** Wer die Pins in
`infra/prod/docker-compose.yml` anhebt, zieht die hier mit.

Die `mediamtx.yml` weicht an **zwei** Zeilen ab, und das muss so sein: die
öffentliche IP, und `authHTTPAddress` zeigt auf den Compose-Namen statt auf
`127.0.0.1` (Prod fährt MediaMTX mit host-Networking, hier läuft es im
Compose-Netz). Sonst ist sie deckungsgleich — bei Änderungen an der
Prod-Fassung von Hand nachziehen, `dev-sync.sh` fasst sie nicht an.

## Einmalige Einrichtung

### 1. `.env` auf dem Server ergänzen

```sh
ssh michael@77.42.71.166
cd ~/pulse-test && cp .env .env.bak-$(date +%Y%m%d)
```

Diese Werte setzen bzw. korrigieren:

```ini
# MinIO fehlte bisher komplett, während die nginx-Location
# /pulse-attachments/ (set $u minio;) längst darauf zeigte — Anhänge und
# Ablage waren dadurch tot, ohne Fehlermeldung.
S3_INTERNAL_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=https://pulse.unicutmedia.com

# Der lokale Vite leitet /api/* server-seitig weiter, für die Wege ist also
# gar kein CORS im Spiel. Die Einträge sind für den Fall, dass ein Browser
# einmal direkt gegen das Backend fährt.
CORS_ALLOW_ORIGINS=https://pulse.unicutmedia.com,http://localhost:5173,http://127.0.0.1:5173

# Dieselben freizügigen Upload-Werte wie im lokalen Dev-Stack
# (dev-up.fish). Ohne sie sind Ablage und DM-Anhänge in der Entwicklung tot,
# weil die Cloud-Vorgaben in config.py bewusst restriktiv sind.
CLOUD_DM_ATTACHMENTS_ENABLED=true
CLOUD_DROPBOX_ENABLED=true
CLOUD_ATTACHMENT_MIME_PREFIXES=
```

MediaMTX und MinIO spiegeln die Origin von sich aus zurück (nachgemessen:
`access-control-allow-origin: http://localhost:5173`), WHEP und presignte
S3-URLs funktionieren aus dem lokalen Vite deshalb ohne nginx-Eingriff.

### 1b. APNs-Schlüssel für VoIP-Pushes (seit 2026-10-08, iOS-Punkt 40)

Anrufe erreichen ein iPhone nur über einen **VoIP-Push**, und der geht nicht
über Firebase: die Firebase-Schnittstelle kann `apns-push-type: voip` nicht
setzen. Der chat-gateway spricht dafür direkt mit `api.push.apple.com`
(`apns_voip.py`). Dafür braucht er Apples `.p8` **auf dem Server** — in der
Firebase-Konsole liegt es für diesen Weg wirkungslos.

```bash
# Schlüssel neben die JWT-Schlüssel legen (der Container liest /secrets, uid 10001;
# 0644 wie jwt_private.pem, sonst kommt uid 10001 nicht heran)
scp AuthKey_<KEYID>.p8 michael@77.42.71.166:~/pulse-test/secrets/
ssh michael@77.42.71.166 'chmod 644 ~/pulse-test/secrets/AuthKey_<KEYID>.p8'
```

Dann in `~/pulse-test/.env`:

```
APNS_KEY_FILE=/secrets/AuthKey_<KEYID>.p8
APNS_KEY_ID=<KEYID>
APNS_TEAM_ID=6FRUC2UST8
APNS_BUNDLE_ID=com.howispulse.app
APNS_SANDBOX=true
```

**`APNS_SANDBOX` ist keine Kleinigkeit.** Ein Gerätetoken gehört zu GENAU EINER
Umgebung. Ein Entwicklungs-Bau (`aps-environment = development`, so steht es
heute in `App.entitlements`) liefert Sandbox-Tokens, und die Produktions-Adresse
weist sie mit `BadDeviceToken` ab — was aussieht wie ein kaputter Token und
keine falsche Adresse ist. Für einen Store-Bau auf `false`.

Danach `docker compose up -d --force-recreate chat-gateway` (eine
`env_file`-Änderung wirkt erst beim Neuerzeugen, nicht beim `--reload`).

**Fehlt der Schlüssel, ändert sich nichts** — der Anruf läuft wie vorher über
die WebSocket, und wer keine offene Verbindung hat, verpasst ihn. Fail-open an
jeder Stelle; eine Fehlkonfiguration darf keinen Anruf verhindern, der sonst
zustande käme.

**Prüfen, ob der Schlüssel gilt, ohne ein Gerät zu brauchen:** einen Push an
einen absichtlich falschen Gerätetoken schicken. `BadDeviceToken` heisst, die
ANMELDUNG war in Ordnung (nur der Token war falsch); `InvalidProviderToken`
oder `ExpiredProviderToken` heisst, an Schlüssel, Key-ID oder Team-ID stimmt
etwas nicht.

```bash
ssh michael@77.42.71.166 'docker exec pulsetest_chat python -c "
import asyncio, httpx
from dcc_chat_gateway import apns_voip
from dcc_chat_gateway.config import get_settings
z = apns_voip.zugang_aus_einstellungen(get_settings())
async def m():
    async with httpx.AsyncClient(http2=True, timeout=15.0) as k:
        a = await k.post(apns_voip.host_fuer(z.sandbox) + \"/3/device/\" + \"0\"*64,
                         json={}, headers=apns_voip.kopfzeilen(z, apns_voip.jwt_bauen(z)))
    print(a.status_code, a.text[:100])
asyncio.run(m())
"'
```

### 2. Compose einspielen

```sh
cd ~/pulse-test
cp docker-compose.yml docker-compose.yml.bak-$(date +%Y%m%d)
# infra/dev-remote/docker-compose.yml vom Arbeitsrechner herüberkopieren
```

### 2b. Garage einmalig bootstrappen (seit 2026-09-21, Entscheidung 4.1)

Der Objektspeicher ist Garage (das MinIO-Hub-Image ist gelöscht, frische
Hosts kamen sonst an den Tag nicht mehr ran). Der Service heißt weiterhin
`minio` — `.env` (S3_INTERNAL_ENDPOINT) und die nginx-Location auf dem
Server adressieren diesen DNS-Namen, und Garage hört genauso auf :9000.
Bucket + Key legt ein Host-Skript an (das Garage-Image hat keine Shell,
ein Init-Container geht nicht):

```sh
# im Repo-Root auf dem Server, NACH dem ersten `docker compose up -d`
GARAGE_S3_KEY="$S3_ACCESS_KEY" GARAGE_S3_SECRET="$S3_SECRET_KEY" \
  sh scripts/dev-garage-init.sh
```

Idempotent — kein Schaden, es erneut zu laufen zu lassen.

### 3. Quellcode hinschieben und starten

```sh
# auf dem Arbeitsrechner
pnpm dev:sync

# auf dem Server
cd ~/pulse-test && docker compose up -d
```

## Zugang für externe Entwickler (z. B. Mobile) — User `devmob`

Seit 2026-08-25 gibt es einen zweiten, bewusst eingeschränkten Zugang für
Mitarbeiter, die Backend-Änderungen auf dem Remote-Dev-Stack testen müssen,
ohne sonstigen Zugriff auf den Server (dort laufen Prod-Stack und fremde
Projekte):

- **Linux-User `devmob`** — kein sudo, keine Docker-Gruppe, kein Shell-Zugang.
- Sein SSH-Schlüssel erzwingt ein **zweistufiges Gateway**
  (`/usr/local/bin/pulse-dev-gateway.sh` → `pulse-dev-inner.sh`): jede
  Anfrage wird gegen eine Whitelist geprüft, die exakt die Befehle von
  `dev:sync`/`dev:remote` erlaubt — rsync/tar in `src/` und `web-build/`,
  `docker compose up migrate-*`, `restart <5 Dienste>`,
  `logs -f --tail=50 <5 Dienste>`. Alles andere wird abgelehnt und in
  `~/pulse-dev-gateway.log` (User michael) protokolliert.
- Ausgeführt wird **alles als `michael`** (die innere Stufe) — so gehört der
  Code-Baum einem Eigentümer und rsync darf chmod/utime setzen.
- **Der Mitarbeiter bemerkt davon nichts**: bei ihm läuft unverändert
  `pnpm dev:remote` + `pnpm dev:sync`, nur mit anderem SSH-Ziel. Seine
  `~/.ssh/config`:
  ```
  Host pulse-devmob
    HostName 77.42.71.166
    User devmob
    IdentityFile ~/.ssh/pulse-dev-mitarbeiter   # der ausgehändigte Key
    IdentitiesOnly yes
  ```
  und dann `PULSE_DEV_HOST=pulse-devmob pnpm dev:sync` bzw. in der Shell
  vorher `export PULSE_DEV_HOST=pulse-devmob`.
- **Wichtig:** die Befehle dürfen nicht abgewandelt werden (z. B. anderes
  `--tail`) — die Whitelist ist exakt. Wer eigene Remote-Befehle braucht,
  muss die Whitelist in `pulse-dev-inner.sh` erweitern (Root-Zugang nötig).
- **Grenze:** Wer Backend-Code syncen kann, besitzt damit den Dev-Stack
  (sein Code läuft dort) — inkl. der Dev-DB-Zugangsdaten in den
  Container-Umgebungen. Das Gateway schützt den *Rest des Servers*, nicht
  den Dev-Stack vor dem Entwickler.
- **Key sperren:** Zeile in `/home/devmob/.ssh/authorized_keys` löschen
  (Root). Der zugehörige private Schlüssel liegt beim Herausgeber
  (`~/.ssh/pulse-dev-mitarbeiter`).

## Rückfall

Es geht nichts verloren: die Images sind unverändert, der Datenbestand liegt
im selben Volume.

```sh
cd ~/pulse-test
cp docker-compose.yml.bak-<datum> docker-compose.yml
cp .env.bak-<datum> .env
docker compose up -d
```

## Zwei Dinge, die man wissen muss

**Der Projektname `pulsetest` muss bleiben.** Daran hängen der Volume-Präfix
(`pulsetest_pgdata` — der vorhandene Datenbestand) und die Container-Namen, auf
die der Caddy des Hosts zeigt (`reverse_proxy pulsetest_web:80`). Ein anderer
Projektname legt eine leere Datenbank an und pulse.unicutmedia.com zeigt ins
Leere. Genau deshalb wird an Ort und Stelle umgebaut statt ein zweites Projekt
danebenzustellen — zwei Postgres-Container auf demselben Verzeichnis zerlegen
den Datenbestand.

**Es gibt ein gemeinsames Backend.** Wer synchronisiert, setzt den Stand für
alle Rechner. Das ist der Zweck der Übung, heißt aber auch: zwei Leute, die
gleichzeitig an verschiedenen Diensten arbeiten, überschreiben sich.

## Was das nicht ersetzt

`scripts/dev-up.fish` bleibt. Der lokale Stack wird weiter gebraucht für die
E2E-Suite (die fährt ihre eigene `dcc_test`-Datenbank auf eigenen Ports) und
für Arbeiten ohne Internet. Und das verbindliche Test-Gate vor dem Push nach
`main` bleibt ebenfalls lokal — pytest, `pnpm check`, `pnpm build`.
