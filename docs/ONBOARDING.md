# Onboarding — Entwickler-Setup für eine frische Maschine

Wenn du den Pulse-Stack auf einem neuen Rechner (oder nach einem Neuaufsetzen)
zum Laufen bringen willst: das hier ist die Schritt-für-Schritt-Anleitung.
Sie ist getrennt von `docs/self-host-guide.html` — das richtet sich an Endkunden,
die produktiv hosten wollen; hier geht's um den **Entwickler-Stack**
(Hot-Reload, Tests, lokale Postgres, alles auf 127.0.0.1).

Was im Git liegt und was nicht — Kurzfassung:

| In Git (= via `git clone` da) | NICHT in Git (= neu generieren) |
|---|---|
| Sämtlicher Code | `.env` (Postgres-Passwort, Redis-URL etc.) |
| Migrations, Docs, Infra, Plugins | `secrets/jwt_*.pem` (RS256-Schlüsselpaar) |
| Test-Suites + CDP-Toolkit | Postgres-Daten (Test-Accounts, Gilden) |
| `CLAUDE.md` + `STATUS_NACHT_*.md` | Browser-Profile, Logs, alles unter `/tmp/` |

## Der schnellste Weg: die Maschine sich selbst prüfen lassen

Wenn das Repo schon geklont ist, sagt ein Befehl, was diesem Rechner fehlt:

```bash
bash scripts/gate.sh --maschine
```

Er prüft Werkzeuge, `redis-server`, die CLA-Mailadresse, den FFmpeg-Pfad und
den Admin-Schalter fürs Landen. Die zwei Dinge, die er üblicherweise anmahnt:

| Fehlt | Folge | Behebung (einmal pro Rechner) |
|---|---|---|
| `redis-server` | Backend-Tests seriell: **~7 min statt ~1:15** | `sudo pacman -S redis` · `sudo apt install redis-server` · `brew install redis` |
| `pulse.adminmerge` | `scripts/ship.sh` bleibt auf `BLOCKED` | `git config --local pulse.adminmerge true` |

Die Betriebssysteme sind dabei **nicht gleichwertig**:

| | Tests parallel | gate.sh / ship.sh | Lokaler Dev-Stack |
|---|---|---|---|
| **Linux** | ja | ja | `scripts/dev-up.fish` |
| **macOS** | ja (`brew install redis`) | ja | `dev-up.fish` (fish nötig) |
| **Windows** | **nein** (kein `redis-server`) → seriell | nur über **Git Bash** | **gar nicht** (fish-only) → Remote-Dev-Stack (`infra/dev-remote/README.md`) |

Wer unter Windows Tempo braucht, nimmt WSL.

## Voraussetzungen

System-Tools (Arch-Beispiel — auf anderen Distros analog):

```fish
sudo pacman -S docker docker-compose nodejs pnpm uv chromium openssl
```

Plus eine laufende `docker`-Daemon und dein User in der `docker`-Gruppe.

Versionen, die der Stack erwartet (Stand 2026-05-27):

- **Python 3.13** (uv zieht das automatisch via `uv sync`, kein System-Python nötig)
- **Node 25** + **pnpm 10** (oder neuer; `corepack` schaltet pnpm passend)
- **Docker 24+** mit Compose-Plugin

## 1. Repo + Branch

```fish
git clone https://github.com/oblivion8282-1337/pulse.git
cd pulse
```

Auf `main` bleiben. (Hier stand bis 2026-08-26 ein `git switch
feat/cert-modell-self-host` — dieser Zweig ist seit dem Merge des
Cert-Modells weg, wer der Anleitung wörtlich folgte, scheiterte in
Schritt 1.)

## 2. Secrets

```fish
cp .env.example .env
```

Dann `.env` durchgehen — die meisten Werte sind Defaults, aber **du
musst eigene zufällige Passwörter setzen** für:

- `POSTGRES_PASSWORD` — irgendein 64-stelliger Hex-String (z.B.
  `openssl rand -hex 32`)
- `INTERNAL_SERVICE_SECRET` — analog
- Optional: `LIVEKIT_API_SECRET` falls du Voice testen willst

JWT-Keypair für die RS256-Token (RSA 2048):

```fish
mkdir -p secrets
openssl genpkey -algorithm RSA -out secrets/jwt_private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in secrets/jwt_private.pem -pubout -out secrets/jwt_public.pem
chmod 0600 secrets/jwt_private.pem
```

`secrets/` ist im `.gitignore` — niemals committen.

## 3. Dependencies

```fish
pnpm install                # alle JS-Workspaces (web/, desktop/, plugins/)
uv sync --all-packages      # alle Python-Workspaces (services/*, shared/, streaming/)
```

`uv sync` zieht das Python 3.13 selbst rein, du brauchst es nicht im
System.

## 4. Dev-Stack hochfahren

```fish
./scripts/dev-up.fish
```

Was passiert:

- Postgres (5434), Redis (6380), LiveKit (7880, 7882-7892/udp),
  MediaMTX (1935-1936, 8888, 8889, 8189, 9997) — alles als Docker-
  Container, Volumes bleiben auf deiner Maschine.
- Alembic-Migrations für `auth` und `chat-gateway` werden ausgeführt.
- Die 5 uvicorn-Services starten mit `--reload`: auth (8001),
  chat-gateway (8002), voice-signaling (8003), media-svc (8004),
  mediamtx-auth-hook (8005).
- Vite-Dev-Server für die Web-SPA auf 5173.
- Electron-Dev-Fenster gegen :5173 (kann via Strg+C im Terminal beendet
  werden, ohne den Rest zu stoppen).

`dev-down.fish` fährt alles wieder herunter, lässt aber die Docker-Volumes
intakt (deine Test-Accounts überleben einen Neustart).

## 5. Erster Test-Account

Öffne `http://127.0.0.1:5173/` in einem Browser → **Registrieren**.

**Der erste registrierte User wird automatisch zum Admin** (Bootstrap-
Admin-Mechanismus, siehe `services/auth/src/dcc_auth/routes.py`). Das ist
das Pattern von Mastodon/Gitea/Forgejo. Du kannst dich danach im Admin-
Panel unter `/app/admin` selbst zum Plugin-Allowlist-Manager machen,
weitere Admins via User-Verwaltung promoten, etc.

**Stolperstein 1 — E-Mail-Validierung:**
`email-validator` blockt special-use-TLDs (`.test`, `.localhost`). Test-
Accounts nutzen die Konvention `*@dcc-test.example.com` — z.B.
`alice@dcc-test.example.com`. Das `example.com` ist explizit für
Dokumentations- und Testzwecke reserviert.

**Stolperstein 2 — Server-Erstellung:**
Frisch-Deploys haben `allow_guild_creation=false` als Default (Migration
0010). Erst über `/app/admin` → Berechtigungen → Server-Erstellung
zulassen einschalten, dann können auch Member Gilden anlegen. Der Admin
selbst kann immer eine Gilde erstellen.

**Stolperstein 3 — is_admin im JWT:**
Wenn du jemanden in der DB nachträglich auf `is_admin=true` setzt
(`UPDATE auth.users SET is_admin=true WHERE username='...'`), muss der
User sich aus- und wieder einloggen. `is_admin` ist Teil des JWT-Claim
und wird nicht live aktualisiert. Im Frontend macht sich das durch
403-Antworten der Admin-Endpoints bemerkbar.

## 6. Tests laufen lassen

**Der verbindliche Weg ist ein Skript**, nicht eine Handvoll Befehle:

```fish
bash scripts/gate.sh --maschine   # einmalig: hat diese Maschine alles?
bash scripts/gate.sh              # das Test-Gate — dasselbe, das ship.sh fährt
bash scripts/gate.sh --trocken    # nur sagen, was liefe und warum
```

Dass es dasselbe Skript ist, ist der Punkt: ein grüner Lauf hier zählt
beim späteren `scripts/ship.sh` und wird dort nicht wiederholt. Das Gate
merkt sich den Baum-Hash der geprüften Bereiche in `.git/` und
vergleicht ausserdem gegen `origin/main` — was dieser Zweig nicht
angefasst hat, läuft gar nicht erst.

Der Stempel ist **maschinen-lokal und soll es bleiben**: ein grüner Lauf
auf einem anderen Rechner beweist hier nichts (andere Toolchain, anderes
OS). Der Vergleich mit `origin/main` braucht dagegen keinen Zustand und
wirkt auf einem frischen Klon sofort.

Einzelne Teile von Hand, wenn man sie gezielt braucht:

```fish
# Backend (seriell)
REDIS_URL=redis://localhost:6380/0 uv run --all-packages pytest -q

# Backend parallel — braucht `redis-server` im PATH, s.u.
REDIS_URL=redis://localhost:6380/1 uv run --all-packages pytest -q -n 8

# Frontend
cd web
pnpm check                # svelte-check (TypeScript-Validierung)
pnpm build                # production build
pnpm test:unit            # Nodes eingebauter Läufer, kein Vitest
pnpm exec playwright test # E2E (braucht den dev-Stack)
```

### `redis-server` — warum das Pflicht ist, wenn parallel gefahren wird

Im Parallelbetrieb startet der Wurzel-`conftest.py` **je Worker einen
eigenen `redis-server`** auf einem freien Port. Das ist kein Luxus:
Redis-Pubsub ist **server-global, nicht pro Datenbank** (nachgemessen —
eine auf DB 7 veröffentlichte Nachricht kommt bei einem Abonnenten auf
DB 2 an). Eine eigene Datenbank je Worker trennt also die Schlüssel, aber
nicht den Ereignisbus (`guild:events`, `stream:events`, `voice:events`),
an dem ein grosser Teil der Suite hängt.

Fehlt das Binary, **bricht der parallele Lauf ab** statt scheinbar zu
laufen — ein Lauf, dessen Worker sich gegenseitig die Ereignisse
wegfangen, produziert Fehlschläge, die wie flackernde Tests aussehen und
keine sind. Ohne `redis-server` also seriell fahren:
`PULSE_GATE_JOBS=1 bash scripts/gate.sh`.

Installation: Arch `sudo pacman -S redis`, Debian/Ubuntu
`sudo apt install redis-server`, macOS `brew install redis`. Der Dienst
muss **nicht** laufen — nur das Binary muss auffindbar sein, die Tests
starten ihre eigenen Prozesse.

Stand 2026-08-26: 2308 Backend-Tests (seriell 7:23, parallel 1:15) +
136 Playwright-E2Es grün; drei E2Es sind auf `main` rot (mobile-rooms,
mobile-treffflaechen, plugins).

## 7. Optional — CDP-Toolkit für Multi-User-Tests

Wenn du mehrere User parallel im UI testen willst (z.B. Sender + Empfänger
gleichzeitig sehen), siehe `scripts/cdp/README.md`. Kurzfassung:

```fish
./scripts/cdp/launch.fish 9222 alice
./scripts/cdp/launch.fish 9223 bob
nohup node scripts/cdp/observe.mjs 9222 > /dev/null 2>&1 &
nohup node scripts/cdp/observe.mjs 9223 > /dev/null 2>&1 &
```

Drei Chromium-Instanzen mit isolierten Profilen, parallele CDP-Log-
Streams nach `/tmp/pulse-cdp-events-<port>.log`.

## 8. Self-Host-Image lokal testen

```fish
# Image bauen (aus Repo-Root)
docker build -f infra/self-host/Dockerfile \
    --build-arg PULSE_VERSION=(git rev-parse --short HEAD) \
    -t pulse-allinone:local .

# Smoke-Run — Cert vorseeden (sonst hängt Caddy im ACME-Loop)
docker volume create pulse-smoke-data
docker run --rm -v pulse-smoke-data:/data --entrypoint /bin/sh \
    pulse-allinone:local -c "mkdir -p /data/certs && \
    openssl req -x509 -nodes -newkey rsa:2048 \
        -keyout /data/certs/key.pem -out /data/certs/cert.pem \
        -days 365 -subj /CN=pulse.smoke.local \
        -addext 'subjectAltName=DNS:pulse.smoke.local' && \
    chown -R 10001:10001 /data/certs && chmod 0600 /data/certs/key.pem"

# Start
docker run -d --name pulse-smoke \
    -e PULSE_HOSTNAME=pulse.smoke.local \
    -e PULSE_CLOUD_CLIENT_ID=smoke \
    -e PULSE_CLOUD_CLIENT_SECRET=smoke \
    -e PULSE_ADMIN_EMAIL=admin@smoke.local \
    -e PULSE_TLS_MODE=provided \
    -v pulse-smoke-data:/data \
    -p 18080:80 -p 18443:443 \
    pulse-allinone:local

# Healthy-Check
docker inspect --format '{{.State.Health.Status}}' pulse-smoke
docker exec pulse-smoke /usr/local/bin/pulse-health
```

Alle 11 Services sollten hochkommen. Wenn nicht: `docker logs pulse-smoke`
zeigt die `cont-init`-Schritte und welcher fehlgeschlagen ist.

## Wo finde ich was

| Bereich | Pfad |
|---|---|
| Architektur-Übersicht + Tech-Stack-Stolpersteine | `CLAUDE.md` (Root) |
| Master-Plan + Phasen-Roadmap | `PLAN.md` |
| Self-Host-Operator-Doku (für Endkunden, englisch) | `docs/self-host-guide.html` |
| Self-Host-Image-Innenleben (für Entwickler) | `infra/self-host/README.md` |
| Plugin-Manifest-Format | `docs/PLUGIN_MANIFEST.md` |
| Plugin-Roadmap (A → B → C) | `docs/PLUGIN_ROADMAP.md` |
| HQ-Streaming-Architektur | `streaming/README.md` |
| Production-Deployment auf Hetzner | `infra/prod/DEPLOY.md` |
| CDP-Test-Toolkit | `scripts/cdp/README.md` |

## Was Claude NICHT mitnimmt

Wenn du Claude Code als KI-Assistent benutzt: das **Memory** (Stand-
Erinnerung über mehrere Sessions) liegt in `~/.claude/projects/<repo-
slug>/memory/` und ist maschinen-lokal — wandert nicht mit dem Repo
um. Auf einer neuen Maschine kennt Claude:

- ✓ `CLAUDE.md` (gepflegtes Tech-Stack-Inventar + Konventionen)
- ✓ Git-Log inkl. ausführliche Commit-Bodies
- ✓ `STATUS_NACHT_*.md` (historische Snapshots im Repo)
- ✗ Memory-Files mit "wo wir gerade arbeiten"-Detail

Wenn du mit einer langen Session aufhörst und morgen woanders weitermachst,
lohnt es sich, am Ende des Tages einen Status-Markdown in den Repo zu
committen (Pattern wie `STATUS_NACHT_2026-05-26.md`). Claude liest den
beim nächsten Start und kennt damit den Kontext.
