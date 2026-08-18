# Gemeinsamer Remote-Dev-Stack (Hetzner)

Der Dev-Stack lief bisher auf jedem Rechner einzeln (`scripts/dev-up.fish`).
Hier läuft die **untere Hälfte** stattdessen einmal zentral auf dem Hetzner
(`77.42.71.166`, https://pulse.unicutmedia.com), und jeder Arbeitsrechner
startet nur noch Vite und Electron.

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
`uv.lock` ist zuletzt am 2026-07-01 gewandert, die vorhandenen Images vom
2026-08-16 sind also aktuell.

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
for s in auth:dcc_auth chat-gateway:dcc_chat_gateway voice-signaling:dcc_voice_signaling \
         media-svc:dcc_media_svc mediamtx-auth-hook:dcc_mediamtx_auth_hook; do
  docker build -f repo/Dockerfile.service repo \
    --build-arg SVC_DIR=${s%%:*} --build-arg SVC_PKG=${s##*:} \
    -t pulsetest-${s%%:*}:local
done
```

## Versions-Parität mit Produktion

Der Sinn dieses Stacks ist, dass ein Test hier etwas über Produktion aussagt.
Dafür müssen die Fremdbausteine dieselben sein. Stand 2026-08-18 sind
Postgres, Redis, MinIO und nginx identisch, und **MediaMTX und LiveKit sind
bewusst auf die Prod-Fassung gepinnt**:

| | Produktion | hier |
|---|---|---|
| MediaMTX-Fork | `1.19.1-pulse4` | `1.19.1-pulse4` |
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

### 2. Compose einspielen

```sh
cd ~/pulse-test
cp docker-compose.yml docker-compose.yml.bak-$(date +%Y%m%d)
# infra/dev-remote/docker-compose.yml vom Arbeitsrechner herüberkopieren
```

### 3. Quellcode hinschieben und starten

```sh
# auf dem Arbeitsrechner
pnpm dev:sync

# auf dem Server
cd ~/pulse-test && docker compose up -d
```

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
