# Self-Host ohne Freigabe — Implementation Plan

> **Überholt (2026-10-10).** Dieser Plan folgt Fassung 1 des Entwurfs
> (Einrichtungscode, Adresse im Ticket). Fassung 2 ersetzt beides durch das
> Verbinden per Gerätecode. **Nicht ausführen.** Etappe 0 gilt weiter, aber
> mit dem Organisationsnamen `oblivion-pictures` statt `howispulse`. Die Etappen
> 1 bis 5 werden nach Fassung 2 neu geschrieben
> (`docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md`,
> Abschnitt 9).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jeder kann einen Pulse-Server mit `curl -fsSL https://howispulse.com/install | bash` oder einer Compose-Datei installieren — ohne Antrag, ohne Freigabe, ohne Zugangsdaten aus der Cloud.

**Architecture:** Das Serverticket trägt künftig die Adresse des Servers (`aud = [instanz_id, hostname]`); der Server prüft Adresse oder Nummer. Für unbekannte Adressen legt die Cloud beim ersten Ticket selbst einen Telefonbuch-Eintrag an, damit Mitgliedschaften, Server-Liste und Sperre unverändert weiterlaufen. Den Besitzer bestimmt ein Einrichtungscode, den der Server beim ersten Start erzeugt und der beim ersten Beitritt mitgeschickt wird. Das Image wird öffentlich unter einer GitHub-Organisation.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (auth-svc, chat-gateway), pydantic v2, PyJWT 2.12 (RS256, `aud` als Liste), s6-overlay-Shellskripte, Bash-Installer, SvelteKit/Svelte 5 + Paraglide, GitHub Actions + GHCR.

**Spec:** `docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md` (Entscheidungen E1–E11). Übersicht mit Abbildungen: https://claude.ai/artifact/5PJFE2VeBMrxLXPeeqr9Zt

## Global Constraints

- Python `>=3.13`, Ruff `line-length=100`; Kommentare und Docstrings deutsch, Log-Meldungen an fremde Betreiber englisch (`owner_admin_log.py`-Regel).
- **Der Einrichtungscode wird nie geloggt** (CLAUDE.md: „Niemals Stream-Keys/Tokens loggen“; Diagnosepakete können Logs enthalten).
- Keine neuen Abhängigkeiten (Python, npm, Cargo).
- Alembic-Revision-IDs höchstens 32 Zeichen.
- Snowflake-IDs reisen als Strings über die API.
- Svelte-Komponenten ≤ 250 Zeilen, Quelldateien ≤ 350 (hart 500). Runes nur in `.svelte`/`.svelte.ts`.
- i18n: neue Schlüssel in **beiden** `web/messages/de.json` und `web/messages/en.json`; bestehende Schlüssel werden nicht umbenannt oder gelöscht (append-only).
- Commit-Messages und neue Texte mit echten Umlauten; keine Emojis, nirgends.
- Backend-Tests: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q <pfad>`; das volle Gate ist `bash scripts/gate.sh`.
- Jede Etappe auf eigenem Zweig von frisch gepulltem `main`, gelandet über `bash scripts/ship.sh`. **Landen = Prod-Deploy → nur auf ausdrückliche Freigabe des Eigentümers.**
- Nach jeder Code-Änderung: `code-simplifier`-Agent über die geänderten Dateien, Tests erneut grün, `bash .claude/hooks/simplify-stamp.sh`, dann committen.
- Jeder Commit endet mit `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Bestandsserver (drei VPS mit `PULSE_INSTANCE_ID`, Zugangsdaten und `PULSE_INSTANCE_OWNER_ID`; zwei Heim-Server) dürfen in keiner Etappe etwas bemerken.

## Review Focus

1. **Adresse in anderer Schreibweise** (`Chat.Example.org:443/`, abschließender Punkt) muss beim Server dieselbe `aud` ergeben wie seine `PULSE_HOSTNAME` → Tests in Task 1.1 und Task 2.1.
2. **Bestandsserver mit altem Code** bekommen künftig ein Listen-`aud`; sie müssen weiter annehmen, und ihr Besitzer bleibt Admin → Tests in Task 1.4 (Dekodieren mit `audience="<id>"`) und Task 2.1/2.3.
3. **Einrichtungscode in Kleinbuchstaben, mit Leerzeichen oder ohne Bindestriche** muss angenommen werden → Test in Task 2.2.
4. **Neuinstallation auf altem Datenvolumen**, dessen Besitzer schon übernommen hat: der Installer darf keinen Code vortäuschen → Test in Task 4.1.
5. **Adresse eines gelöschten oder gesperrten Eintrags**: gelöscht → neuer Eintrag ohne Freigabe; gesperrt → kein neuer Eintrag, 403 → Tests in Task 1.4.

---

## Etappen und Reihenfolge

| Etappe | Zweig | Was danach live ist |
|---|---|---|
| 0 | `chore/org-umzug` | Repo und Bauwege unter `github.com/howispulse` |
| 1 | `feat/ticket-adresse` | Cloud stellt Tickets mit Adresse aus, auch für unbekannte Server |
| 2 | `feat/selfhost-einrichtungscode` | Server prüft Adresse, kennt den Einrichtungscode, startet nur mit Adresse |
| 3 | `feat/app-einrichtungscode` | Beitrittsdialog fragt nach dem Code |
| 4 | `feat/selfhost-vordertuer` | Installer ohne Token, Compose ohne Login, Paket öffentlich |
| 5 | `chore/freigabe-aufraeumen` | Antrag, Freigabe, `.env`-Download entfernt |

Etappe 1 muss vor Etappe 4 live sein (sonst bekommt ein neuer Server keine Tickets). Etappe 2 muss auf den Servern sein, bevor Etappe 4 neue Server erzeugt (der Installer startet das Image aus Etappe 2). Etappe 3 muss vor Etappe 4 live sein (der Installer verweist auf das Code-Feld). Etappe 0 muss vor Etappe 4 fertig sein (Image-Adresse).

---

## Etappe 0 — Umzug in die Organisation `howispulse`

Hintergrund: GitHub verschiebt beim Repo-Umzug Issues, PRs, Secrets und leitet Web- und Git-Adressen um. **Container-Pakete bleiben beim persönlichen Konto**, ihre Verknüpfung fällt weg, und die Workflows des umgezogenen Repos verlieren den Zugriff darauf. Deshalb müssen alle Bauwege auf `ghcr.io/howispulse/...` schreiben, und die Cloud muss im selben Schritt von dort ziehen.

### Task 0.1: Organisation anlegen und Repo übertragen (Eigentümer, im Browser)

**Files:** keine.

- [ ] **Step 1: Organisation anlegen.** github.com → `+` → *New organization* → Plan *Free* → Name `howispulse`.
- [ ] **Step 2: Einstellungen der Organisation.**
  - *Settings → Authentication security*: „Require two-factor authentication“ einschalten (wer das Organisationskonto übernimmt, erreicht jeden Auto-Updater; Spec §5).
  - *Settings → Actions → General*: „Allow all actions and reusable workflows“ (gebraucht werden u. a. `contributor-assistant`, `dtolnay`, `astral-sh`, `pnpm`, `Swatinem`, `apple-actions`, `android-actions`).
  - *Settings → Packages*: Erstellen öffentlicher **und** privater Pakete erlauben.
  - *Settings → Personal access tokens*: klassische Tokens nicht sperren (der netcup zieht mit einem klassischen `read:packages`-Token).
- [ ] **Step 3: Installierte GitHub-Apps prüfen.** Persönliches Konto → *Settings → Applications*: Apps mit „selected repositories“, die `pulse` enthalten, nach dem Umzug in der Organisation neu installieren.
- [ ] **Step 4: Repo übertragen.** `github.com/oblivion8282-1337/pulse` → *Settings → Danger Zone → Transfer* → Ziel `howispulse`. **Danach nie wieder ein Repo namens `pulse` unter dem persönlichen Konto anlegen** (sonst erlischt die Umleitung).
- [ ] **Step 5: `REGISTRY_PUSH_TOKEN` neu setzen.** Beim Lesen der netcup-`.env` geriet der Wert am 2026-10-09 in das lokale Protokoll eines Suchlaufs. Neues Passwort für den Registry-Benutzer `pulse-ci` erzeugen (Ablauf in `infra/prod/DEPLOY.md`, Abschnitt Registry), auf dem netcup in `~/pulse/infra/prod/.env` eintragen, im Repo unter *Settings → Secrets → Actions* `REGISTRY_PUSH_TOKEN` ersetzen.
- [ ] **Step 6: Git-Remote auf diesem Rechner umstellen.**

```bash
git remote set-url origin https://github.com/howispulse/pulse.git
git fetch origin && git status -sb | head -1
```
Expected: `## main...origin/main` ohne Fehlermeldung. Dasselbe auf Mac, Windows und `~/pulse-test/repo` auf dem Hetzner (dort `ssh michael@77.42.71.166 'cd ~/pulse-test/repo && git remote set-url origin https://github.com/howispulse/pulse.git'`).

### Task 0.2: MediaMTX-Fork in den neuen Namensraum bauen

Das Self-Host-Image kopiert MediaMTX aus `ghcr.io/oblivion8282-1337/pulse-mediamtx` — ein privates Paket des persönlichen Kontos, auf das der Bau nach dem Umzug keinen Zugriff mehr hat. Der Fork muss deshalb **zuerst und allein** im neuen Namensraum entstehen.

**Files:**
- Modify: `.github/workflows/mediamtx-fork.yml:13-14,101-102`

- [ ] **Step 1: Zweig anlegen.**

```bash
git checkout main && git pull --ff-only && git checkout -b chore/org-umzug-mediamtx
```

- [ ] **Step 2: Namen umstellen.** In `.github/workflows/mediamtx-fork.yml` jedes `ghcr.io/oblivion8282-1337/pulse-mediamtx` durch `ghcr.io/howispulse/pulse-mediamtx` ersetzen (Zeilen 13, 14, 101, 102):

```yaml
          tags: |
            ghcr.io/howispulse/pulse-mediamtx:${{ steps.ver.outputs.tag }}
            ghcr.io/howispulse/pulse-mediamtx:latest
```

- [ ] **Step 3: Prüfen, dass nichts übrig ist.**

Run: `grep -n "oblivion8282-1337" .github/workflows/mediamtx-fork.yml`
Expected: keine Ausgabe.

- [ ] **Step 4: Commit und landen.** Die Änderung betrifft nur CI (`NON_USER_FACING`), kein Changelog. Der Push auf `main` löst den Fork-Bau aus (Pfad-Filter enthält die Workflow-Datei). Die Cloud bleibt unberührt, weil `infra/prod/docker-compose.yml` den alten Namensraum pinnt.

```bash
git add .github/workflows/mediamtx-fork.yml
git commit -m "ci: MediaMTX-Fork baut in den Namensraum howispulse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bash scripts/ship.sh
```

- [ ] **Step 5: Auf den grünen Bau warten.**

Run: `gh run list --workflow mediamtx-fork.yml --limit 1`
Expected: `completed  success`. Erst danach Task 0.3.

### Task 0.3: Alle Bauwege und die Cloud-Abholung umstellen

**Files:**
- Modify: `.github/workflows/ci.yml:310-311`
- Modify: `.github/workflows/allinone.yml:4-9,76,327,331`
- Modify: `infra/self-host/Dockerfile:8,210,321`
- Modify: `infra/prod/docker-compose.yml` (alle `pulse-{auth,chat-gateway,voice-signaling,media-svc,mediamtx-auth-hook,relay-frps-plugin,web}:latest`-Zeilen; **nicht** die `pulse-mediamtx`-Zeile)
- Modify: `infra/prod/pulse-update.sh:38-44`
- Modify: `web/src/lib/legal/impressum.md:68`, `web/src/lib/legal/drittanbieter.md:7,159`, `.github/workflows/cla.yml:42`

- [ ] **Step 1: Zweig anlegen.**

```bash
git checkout main && git pull --ff-only && git checkout -b chore/org-umzug
```

- [ ] **Step 2: `ci.yml`.** Zeilen 310–311:

```yaml
          tags: |
            ghcr.io/howispulse/pulse-${{ matrix.name }}:latest
            ghcr.io/howispulse/pulse-${{ matrix.name }}:sha-${{ steps.sha.outputs.short }}
```

- [ ] **Step 3: `allinone.yml`.** Zeile 76 `IMAGE: ghcr.io/howispulse/pulse`. Kopfkommentar 4–9 auf `ghcr.io/howispulse/pulse:…` ziehen. Im Spiegel-Schritt (Zeilen 327–331) die Quelle aus `IMAGE` ableiten und den Spiegelnamen **unverändert `pulse-allinone`** lassen (auth-svc erzwingt ihn in `routes_registry_auth.py:54`, Bestandsserver ziehen ihn):

```yaml
        env:
          GHCR_TAGS: ${{ needs.prepare.outputs.tags }}
          SHORT_SHA: ${{ needs.prepare.outputs.short_sha }}
        run: |
          set -euo pipefail
          SRC="${IMAGE}:sha-${SHORT_SHA}"
          # Registry-Tags aus den GHCR-Tags ableiten. Der Spiegelname bleibt
          # ``pulse-allinone``, obwohl das GHCR-Bild seit dem Umzug ``pulse``
          # heisst: die drei Bestandsserver ziehen ihn, und auth-svc erzwingt
          # ihn (routes_registry_auth.py). Stimmt das Muster nicht, bliebe
          # REG_TAGS gleich GHCR_TAGS und der Spiegel verhungerte still.
          REG_TAGS="$(printf '%s\n' "${GHCR_TAGS}" \
            | sed "s|^${IMAGE}:|registry.howispulse.com/pulse-allinone:|")"
          case "$REG_TAGS" in
            *registry.howispulse.com/pulse-allinone:*) ;;
            *) echo "::error::Spiegel-Tags nicht abgeleitet: $REG_TAGS"; exit 1 ;;
          esac
```

Prüfen, dass `IMAGE` im Job `merge` als Umgebungsvariable verfügbar ist (`env:` auf Workflow-Ebene, Zeile 76 — ja, dort steht es). Der Rest des Schritts bleibt.

- [ ] **Step 4: Self-Host-Dockerfile.** Zeile 210:

```dockerfile
FROM ghcr.io/howispulse/pulse-mediamtx:${PULSE_MEDIAMTX_TAG} AS mediamtx-fork
```
Zeile 8 (Kopfkommentar) auf `ghcr.io/howispulse/pulse:stable`, Zeile 321 `org.opencontainers.image.source="https://github.com/howispulse/pulse"`.

- [ ] **Step 5: Cloud-Compose und Cloud-Updater im Repo.** In `infra/prod/docker-compose.yml` jedes `ghcr.io/oblivion8282-1337/pulse-` **außer** `pulse-mediamtx` durch `ghcr.io/howispulse/pulse-` ersetzen. In `infra/prod/pulse-update.sh` die Liste:

```bash
APP_IMAGES=(
  ghcr.io/howispulse/pulse-auth:latest
  ghcr.io/howispulse/pulse-chat-gateway:latest
  ghcr.io/howispulse/pulse-voice-signaling:latest
  ghcr.io/howispulse/pulse-media-svc:latest
  ghcr.io/howispulse/pulse-mediamtx-auth-hook:latest
  ghcr.io/howispulse/pulse-relay-frps-plugin:latest
  ghcr.io/howispulse/pulse-web:latest
)
```

Run: `grep -n "oblivion8282-1337" infra/prod/docker-compose.yml infra/prod/pulse-update.sh`
Expected: genau eine Zeile, die `pulse-mediamtx:1.19.1-pulse7` (bleibt bis zum nächsten Versionssprung; ein Wechsel erzeugt den MediaMTX-Container neu und reißt Streams ab).

- [ ] **Step 6: Quellcode-Links.** `impressum.md:68`, `drittanbieter.md:7` und `:159`, `cla.yml:42`: `github.com/oblivion8282-1337/pulse` → `github.com/howispulse/pulse`. **Nicht anfassen:** die Adresse `249562202+oblivion8282-1337@users.noreply.github.com` (CLAUDE.md, `scripts/gate.sh:103`, Patch-Kopf) und `allowlist: 'oblivion8282-1337,*[bot]'` in `cla.yml:44` (Benutzername, bleibt).

Run: `grep -rn "github.com/oblivion8282-1337" web/src .github`
Expected: keine Ausgabe.

- [ ] **Step 7: Gate und Commit.** Der Impressum-Text ist für Nutzer sichtbar, ändert aber nur den Link; kein eigener Changelog-Eintrag.

```bash
bash scripts/gate.sh
git add .github/workflows/ci.yml .github/workflows/allinone.yml .github/workflows/cla.yml \
  infra/self-host/Dockerfile infra/prod/docker-compose.yml infra/prod/pulse-update.sh \
  web/src/lib/legal/impressum.md web/src/lib/legal/drittanbieter.md
git commit -m "chore: Bauwege und Cloud-Abholung auf die Organisation howispulse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Erst landen (`bash scripts/ship.sh`), wenn der Eigentümer für Task 0.4 bereitsteht — ab dem Merge baut CI nur noch unter den neuen Namen, und die Cloud bleibt stehen, bis Task 0.4 erledigt ist.

### Task 0.4: Cloud umstellen (gemeinsam mit dem Eigentümer, netcup)

Zwei Fallen (Inventur 2026-10-09): Wird nur die Compose-Datei umgestellt, hält der Updater alles für „schon ausgeliefert“ und schweigt; wird nur das Skript umgestellt, fehlen die Bilder und er schreibt alle zwei Minuten eine Rückfall-Zeile. **Beide Dateien in einem Schritt.** Die Server-Compose ist vom Repo abgedriftet (Redis `--save ""` fehlt dort) — deshalb nur die Bildzeilen ändern, nicht die ganze Datei kopieren.

- [ ] **Step 1: Warten, bis CI die neuen Bilder gebaut hat.**

Run: `gh run list --workflow ci.yml --limit 1`
Expected: `completed  success` für den Merge-Commit aus Task 0.3.

- [ ] **Step 2: Abholbarkeit auf dem netcup prüfen (nur lesen).**

```bash
ssh michael@159.195.150.54 'docker manifest inspect ghcr.io/howispulse/pulse-auth:latest >/dev/null && echo OK'
```
Expected: `OK`. Bei `unauthorized`: der klassische Token des Eigentümers braucht Zugriff auf die Organisation (Task 0.1 Step 2).

- [ ] **Step 3: Beide Dateien in einem Zug umstellen** (Caddy-/Inode-Falle beachten: `sed -i` auf Compose ist hier unkritisch, weil Docker die Datei nicht einhängt).

```bash
ssh michael@159.195.150.54 '
  cd ~/pulse/infra/prod &&
  cp docker-compose.yml docker-compose.yml.vor-umzug &&
  cp pulse-update.sh pulse-update.sh.vor-umzug &&
  sed -i "s#ghcr.io/oblivion8282-1337/pulse-\(auth\|chat-gateway\|voice-signaling\|media-svc\|mediamtx-auth-hook\|relay-frps-plugin\|web\):latest#ghcr.io/howispulse/pulse-\1:latest#" docker-compose.yml pulse-update.sh &&
  grep -n "oblivion8282-1337" docker-compose.yml pulse-update.sh'
```
Expected: nur die `pulse-mediamtx:1.19.1-pulse7`-Zeile.

- [ ] **Step 4: Den nächsten Updater-Lauf beobachten.**

```bash
ssh michael@159.195.150.54 'sleep 150; tail -n 20 ~/pulse/infra/prod/pulse-update.log'
```
Expected: eine Zeile, die das Ausliefern meldet, danach `docker ps` mit frisch gestarteten `pulse_*`-Diensten; https://howispulse.com lädt.

- [ ] **Step 5: Sicherungskopien entfernen**, wenn die Cloud läuft: `ssh michael@159.195.150.54 'rm ~/pulse/infra/prod/*.vor-umzug'`.

---

## Etappe 1 — Cloud: Adresse im Ticket, Eintrag ohne Freigabe

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/ticket-adresse`

### Task 1.1: Gemeinsame Hostnamen-Normalisierung

**Files:**
- Create: `shared/src/dcc_shared/hostname.py`
- Test: `shared/tests/test_hostname.py`

**Interfaces:**
- Produces: `normalisiere_hostname(roh: str) -> str | None` — Kleinbuchstaben, ohne Schema, Port, Pfad und abschließenden Punkt; `None`, wenn kein gültiger FQDN.

- [ ] **Step 1: Failing test schreiben.**

```python
"""Eine Schreibweise fuer Cloud und Self-Host.

Die Cloud stempelt die angefragte Adresse ins Serverticket, der Self-Host
vergleicht sie mit seiner ``PULSE_HOSTNAME``. Weichen die beiden Fassungen ab,
lehnt ein gesunder Server ein gueltiges Ticket ab.
"""

from __future__ import annotations

import pytest

from dcc_shared.hostname import normalisiere_hostname


@pytest.mark.parametrize(
    ("roh", "erwartet"),
    [
        ("chat.example.org", "chat.example.org"),
        ("Chat.Example.ORG", "chat.example.org"),
        ("https://chat.example.org", "chat.example.org"),
        ("https://chat.example.org:443/", "chat.example.org"),
        ("chat.example.org:8443", "chat.example.org"),
        ("  chat.example.org.  ", "chat.example.org"),
        ("xn--bcher-kva.example", "xn--bcher-kva.example"),
        ("pulse.xn--p1ai", "pulse.xn--p1ai"),
    ],
)
def test_gueltige_adressen(roh, erwartet):
    assert normalisiere_hostname(roh) == erwartet


@pytest.mark.parametrize(
    "roh",
    ["", "   ", "localhost", "127.0.0.1", "[::1]", "-boese.example.org", "a..b.org", "bücher.de", "x" * 250 + ".org"],
)
def test_ungueltige_adressen(roh):
    assert normalisiere_hostname(roh) is None
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `uv run --all-packages pytest -q shared/tests/test_hostname.py`
Expected: FAIL mit `ModuleNotFoundError: No module named 'dcc_shared.hostname'`.

- [ ] **Step 3: Implementieren.**

```python
"""Hostnamen normalisieren — eine Fassung für Cloud und Self-Host.

Seit 2026-10-09 trägt jedes Serverticket die Adresse des Servers im ``aud``
(Spec ``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``,
E1/E2). Die Cloud normalisiert die angefragte Adresse, der Self-Host seine
``PULSE_HOSTNAME`` — beide mit dieser Funktion, damit dieselbe Adresse auf
beiden Seiten dieselbe Zeichenkette ergibt.

Nur ASCII: eine Unicode-Adresse muss als Punycode (``xn--…``) kommen. Der
Browser wandelt sie beim Aufruf ohnehin so um.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

# Mindestens zwei Labels; ein Label beginnt und endet mit Buchstabe oder Ziffer
# (RFC 1123). Oberste Ebene alphabetisch oder Punycode — eine reine Zahl dort
# hiesse IP-Adresse, und die kann kein Zertifikat für einen Namen tragen.
_FQDN_RE = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$"
)


def normalisiere_hostname(roh: str) -> str | None:
    """Die Vergleichsform einer Server-Adresse, oder ``None``, wenn es keine ist."""
    text = roh.strip().lower()
    if not text:
        return None
    try:
        # Das ``//``-Präfix nur, wo keines ist — sonst läse ``urlsplit`` bei
        # einem vollen URL das Schema als Host.
        host = urlsplit(text if "//" in text else f"//{text}").hostname or ""
    except ValueError:
        return None
    host = host.rstrip(".")
    if len(host) > 253 or not _FQDN_RE.match(host):
        return None
    return host
```

- [ ] **Step 4: Test laufen lassen.**

Run: `uv run --all-packages pytest -q shared/tests/test_hostname.py`
Expected: PASS (17 passed).

- [ ] **Step 5: Commit.**

```bash
git add shared/src/dcc_shared/hostname.py shared/tests/test_hostname.py
git commit -m "feat(shared): Hostnamen für Ticket und Server gleich normalisieren

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.2: Datenmodell — Einträge ohne Freigabe

**Files:**
- Create: `services/auth/alembic/versions/20261009_1200_0056_ohne_freigabe.py`
- Modify: `services/auth/src/dcc_auth/models_instances.py:56-58` (+ neue Spalte nach `online_gemeldet`)
- Modify: `services/auth/src/dcc_auth/routes_instance_applications.py:115-130,175-206,315-319`
- Modify: `services/auth/src/dcc_auth/routes_admin_instances.py:71-85,170-183`
- Modify: `web/src/lib/api/instances.ts:53-60,129-140`
- Test: `services/auth/tests/test_instanz_ohne_freigabe.py`

**Interfaces:**
- Produces: Spalte `RegisteredInstance.ohne_freigabe: bool` (Vorgabe `False`); `worker_id_*` jetzt `int | None`; `InstanceOut.ohne_freigabe` in beiden Schemas; `set_up` ist `True` für Einträge ohne Freigabe.

- [ ] **Step 1: Failing test schreiben** (`services/auth/tests/test_instanz_ohne_freigabe.py`).

```python
"""Einträge ohne Freigabe in den Listen der Cloud.

Ein solcher Eintrag entsteht beim ersten Serverticket fuer eine unbekannte
Adresse. Er hat keinen Besitzer in der Cloud, keine Worker-IDs und keine
Zugangsdaten — und muss trotzdem in jeder Liste erscheinen, sonst sieht ein
Mitglied den Server auf seinem zweiten Geraet nie.
"""

from __future__ import annotations

import jwt as pyjwt
import pytest

_REG = {
    "username": "frei_alice",
    "email": "frei_alice@dcc-test.example.com",
    "password": "horse battery staple correct",
    "display_name": "Alice",
}
_LOGIN = {"email_or_username": _REG["email"], "password": _REG["password"]}


async def _reg_and_login(client):
    """Wie in ``test_server_ticket_route.py``: ``(cookie, user_id)``."""
    await client.post("/register", json=_REG)
    r = await client.post("/login", json=_LOGIN)
    assert r.status_code == 200, r.text
    sid = r.cookies.get("pulse_session")
    sub = pyjwt.decode(r.json()["access_token"], options={"verify_signature": False})["sub"]
    return f"pulse_session={sid}", int(sub)


async def _eintrag(session_factory, *, iid: int, hostname: str) -> None:
    from dcc_auth.models_instances import RegisteredInstance

    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"frei-{iid}",
                client_secret="!kein-zugang",
                status="active",
                origin="vps",
                registered_by=None,
                ohne_freigabe=True,
            )
        )
        await s.commit()


@pytest.mark.asyncio
async def test_mitglied_sieht_eintrag_ohne_freigabe_als_eingerichtet(client, session_factory):
    cookie, _ = await _reg_and_login(client)
    await _eintrag(session_factory, iid=910001, hostname="frei.example.com")
    r = await client.post(
        "/me/instances/910001/membership", headers={"Cookie": cookie}
    )
    assert r.status_code == 204, r.text

    r = await client.get("/me/instances", headers={"Cookie": cookie})
    assert r.status_code == 200, r.text
    (eintrag,) = [i for i in r.json() if i["id"] == "910001"]
    assert eintrag["set_up"] is True
    assert eintrag["role"] == "member"
    assert eintrag["ohne_freigabe"] is True
    assert eintrag["worker_id_chat"] is None
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_instanz_ohne_freigabe.py`
Expected: FAIL mit `TypeError: 'ohne_freigabe' is an invalid keyword argument for RegisteredInstance`.

- [ ] **Step 3: Modell ändern** (`models_instances.py`).

```python
    # Worker-IDs: seit 2026-10-09 nullable. Einträge ohne Freigabe bekommen keine
    # — der Container hat sie ohnehin nie gelesen (feste IDs in
    # 07-render-env.sh), und die Vergabe deckelte die Zahl der Server bei ~307.
    worker_id_chat: Mapped[int | None] = mapped_column(SmallInteger, nullable=True, unique=True)
    worker_id_voice: Mapped[int | None] = mapped_column(SmallInteger, nullable=True, unique=True)
    worker_id_media: Mapped[int | None] = mapped_column(SmallInteger, nullable=True, unique=True)
```
Nach `online_gemeldet`:

```python
    # Eintrag ohne Antrag (2026-10-09, ``instanz_eintrag.py``): entstand beim
    # ersten Serverticket für diese Adresse. Kein Besitzer in der Cloud
    # (``registered_by`` NULL), keine Zugangsdaten (``client_secret`` ist
    # ``KEIN_ZUGANG``), keine Worker-IDs.
    ohne_freigabe: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
```

- [ ] **Step 4: Migration schreiben.**

```python
"""ohne_freigabe — Telefonbuch-Einträge ohne Antrag.

Seit dem 2026-10-09 legt die Cloud beim ersten Serverticket für eine unbekannte
Adresse selbst einen Eintrag an (``instanz_eintrag.py``). Solche Einträge haben
keine Worker-IDs — die drei Spalten werden nullable — und tragen eine eigene
Markierung.

Revision ID: 0056_ohne_freigabe
Revises: 0055_instanz_anzeige
Create Date: 2026-10-09 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen (``alembic_version.version_num`` ist varchar(32)).
revision: str = "0056_ohne_freigabe"
down_revision: str | None = "0055_instanz_anzeige"
branch_labels = None
depends_on = None

SCHEMA = "auth"
_WORKER = ("worker_id_chat", "worker_id_voice", "worker_id_media")


def upgrade() -> None:
    for spalte in _WORKER:
        op.alter_column(
            "registered_instances",
            spalte,
            existing_type=sa.SmallInteger(),
            nullable=True,
            schema=SCHEMA,
        )
    op.add_column(
        "registered_instances",
        sa.Column(
            "ohne_freigabe", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    # Die Worker-Spalten bleiben nullable: zurück auf NOT NULL ginge nur, wenn
    # man die Einträge ohne Freigabe samt ihren Mitgliedschaften löschte.
    op.drop_column("registered_instances", "ohne_freigabe", schema=SCHEMA)
```

- [ ] **Step 5: Schemas anpassen.** In **beiden** `InstanceOut` (`routes_instance_applications.py` und `routes_admin_instances.py`):

```python
    worker_id_chat: int | None
    worker_id_voice: int | None
    worker_id_media: int | None
    ohne_freigabe: bool = False
```
`_instance_to_out` (`routes_instance_applications.py`) bekommt `ohne_freigabe=inst.ohne_freigabe`. In `list_my_instances`:

```python
    return [
        _instance_to_out(
            inst,
            user.id,
            membership,
            # Ein Eintrag ohne Freigabe existiert nur, weil schon jemand ein
            # Ticket dafür geholt hat — der Server läuft also. Ohne diese Zeile
            # bliebe er für immer ``set_up=false``, und der Klient nähme ihn auf
            # einem zweiten Gerät nie in die Leiste auf (servers.svelte.ts).
            set_up=inst.id in versorgt or inst.ohne_freigabe,
        )
        for inst, membership in rows
    ]
```
In `routes_admin_instances.list_instances`:

```python
            ohne_freigabe=row.ohne_freigabe,
            # registrar ist NULL bei gelöschtem Konto (Migration 0043) und bei
            # Einträgen ohne Freigabe (die haben nie einen Besitzer in der Cloud).
            registrar_username=(
                row.registrar.username
                if row.registrar
                else ("(ohne Freigabe)" if row.ohne_freigabe else "(Konto gelöscht)")
            ),
```

- [ ] **Step 6: Frontend-Typen** (`web/src/lib/api/instances.ts`). In `Instance` und `AdminInstance`:

```ts
  worker_id_chat: number | null;
  worker_id_voice: number | null;
  worker_id_media: number | null;
  /** Eintrag ohne Freigabe: entstand beim ersten Beitritt, hat keinen Besitzer
   *  in der Cloud (seit 2026-10-09). */
  ohne_freigabe?: boolean;
```

- [ ] **Step 7: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_instanz_ohne_freigabe.py services/auth/tests/test_alembic_koepfe.py services/auth/tests/test_migrations.py services/auth/tests/test_admin_instances.py services/auth/tests/test_instance_applications_me.py`
Expected: PASS. Dann `cd web && pnpm check` → 0 Fehler.

- [ ] **Step 8: Commit.**

```bash
git add services/auth/alembic/versions/20261009_1200_0056_ohne_freigabe.py \
  services/auth/src/dcc_auth/models_instances.py \
  services/auth/src/dcc_auth/routes_instance_applications.py \
  services/auth/src/dcc_auth/routes_admin_instances.py \
  services/auth/tests/test_instanz_ohne_freigabe.py web/src/lib/api/instances.ts
git commit -m "feat(auth): Server-Einträge ohne Freigabe im Datenmodell

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.3: Eintrag finden oder anlegen

**Files:**
- Create: `services/auth/src/dcc_auth/instanz_eintrag.py`
- Test: `services/auth/tests/test_instanz_eintrag.py`

**Interfaces:**
- Consumes: `normalisiere_hostname` (Task 1.1), `RegisteredInstance.ohne_freigabe` (Task 1.2).
- Produces:
  - `KEIN_ZUGANG: str = "!kein-zugang"`
  - `async finde_instanz(db: AsyncSession, host: str) -> RegisteredInstance | None` — erst `hostname`, dann `relay_subdomain`.
  - `adresse_reserviert(host: str, settings: Settings) -> bool` — Cloud-Domain und Relay-Basisdomain samt Unterdomains.
  - `async eintrag_anlegen(db: AsyncSession, host: str) -> RegisteredInstance` — committet; bei gleichzeitigem Anlegen liefert er den Eintrag des Gewinners.

- [ ] **Step 1: Failing test schreiben.**

```python
"""Telefonbuch-Eintrag fuer eine Adresse — finden oder ohne Antrag anlegen."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from dcc_auth.instanz_eintrag import (
    KEIN_ZUGANG,
    adresse_reserviert,
    eintrag_anlegen,
    finde_instanz,
)
from dcc_auth.security import verify_password

_EINSTELLUNGEN = SimpleNamespace(
    pulse_oidc_issuer="https://howispulse.com",
    pulse_relay_base_domain="relay.howispulse.com",
)


@pytest.mark.parametrize(
    ("host", "reserviert"),
    [
        ("howispulse.com", True),
        ("evil.howispulse.com", True),
        ("x.relay.howispulse.com", True),
        ("howispulse.com.example.org", False),
        ("chat.example.org", False),
    ],
)
def test_eigene_domains_sind_reserviert(host, reserviert):
    assert adresse_reserviert(host, _EINSTELLUNGEN) is reserviert


@pytest.mark.asyncio
async def test_anlegen_ergibt_einen_eintrag_ohne_zugang(session_factory):
    async with session_factory() as db:
        inst = await eintrag_anlegen(db, "neu.example.org")
        assert inst.ohne_freigabe is True
        assert inst.registered_by is None
        assert inst.worker_id_chat is None
        assert inst.origin == "vps"
        assert inst.status == "active"
        assert inst.client_secret == KEIN_ZUGANG
        # Mit diesem Wert besteht keine Anmeldung als diese Instanz.
        assert verify_password("", inst.client_secret) is False
        assert verify_password(KEIN_ZUGANG, inst.client_secret) is False


@pytest.mark.asyncio
async def test_doppeltes_anlegen_liefert_den_ersten_eintrag(session_factory):
    """Zwei erste Tickets fuer dieselbe Adresse gleichzeitig: der zweite
    scheitert an der Eindeutigkeit und bekommt den Eintrag des ersten."""
    async with session_factory() as db:
        erster = await eintrag_anlegen(db, "doppelt.example.org")
    async with session_factory() as db:
        zweiter = await eintrag_anlegen(db, "doppelt.example.org")
    assert zweiter.id == erster.id


@pytest.mark.asyncio
async def test_finde_ueber_relay_subdomain(session_factory):
    from dcc_auth.models_instances import RegisteredInstance

    async with session_factory() as db:
        db.add(
            RegisteredInstance(
                id=920001,
                hostname="app-920001.relay.howispulse.com",
                client_id="c-920001",
                client_secret="x",
                worker_id_chat=401,
                worker_id_voice=402,
                worker_id_media=403,
                origin="app_host",
                relay_subdomain="mutig-falke-1a2b.relay.howispulse.com",
            )
        )
        await db.commit()
    async with session_factory() as db:
        inst = await finde_instanz(db, "mutig-falke-1a2b.relay.howispulse.com")
    assert inst is not None and inst.id == 920001
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_instanz_eintrag.py`
Expected: FAIL mit `ModuleNotFoundError: No module named 'dcc_auth.instanz_eintrag'`.

- [ ] **Step 3: Implementieren.**

```python
"""Telefonbuch-Eintrag für eine Adresse — finden oder ohne Antrag anlegen.

Seit 2026-10-09 braucht ein Self-Host keine Freigabe mehr (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E3).
Die Cloud kennt einen Server trotzdem: beim ersten Serverticket für seine
Adresse legt sie hier einen Eintrag an. Er trägt die Mitgliedschaften
(Server-Liste auf allen Geräten), die Sperre und die Admin-Übersicht — dieselben
Wege wie für freigegebene Server, nur ohne Besitzer und ohne Zugangsdaten.
"""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_shared.hostname import normalisiere_hostname

from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.snowflake import next_id

#: Steht statt eines Argon2-Hashes in ``client_secret``. ``verify_password``
#: gibt bei einem ungültigen Hash ``False`` zurück — mit diesem Wert besteht
#: also nie eine Anmeldung als diese Instanz (Registry, Telefonbuch,
#: Servername). Kein zufälliger echter Hash: der wäre von einem benutzten nicht
#: zu unterscheiden und kostete bei jedem Anlegen eine Argon2-Rechnung.
KEIN_ZUGANG = "!kein-zugang"


async def finde_instanz(db: AsyncSession, host: str) -> RegisteredInstance | None:
    """Die Instanz unter dieser Adresse — erst der Hostname, dann die
    Relay-Subdomain, damit ein exakter Hostname-Treffer immer gewinnt."""
    inst = (
        await db.execute(select(RegisteredInstance).where(RegisteredInstance.hostname == host))
    ).scalars().first()
    if inst is None:
        inst = (
            await db.execute(
                select(RegisteredInstance).where(RegisteredInstance.relay_subdomain == host)
            )
        ).scalars().first()
    return inst


def adresse_reserviert(host: str, settings) -> bool:
    """Adressen unter den eigenen Domains bekommen keinen Eintrag.

    Sonst könnte jemand eine Relay-Subdomain belegen, bevor sie vergeben ist,
    und der Klient landete beim Beitritt am falschen Eintrag.
    """
    eigene = (
        normalisiere_hostname(settings.pulse_oidc_issuer),
        normalisiere_hostname(settings.pulse_relay_base_domain),
    )
    return any(d and (host == d or host.endswith("." + d)) for d in eigene)


async def eintrag_anlegen(db: AsyncSession, host: str) -> RegisteredInstance:
    """Legt den Eintrag an und committet.

    Zwei gleichzeitige erste Tickets für dieselbe Adresse: der zweite scheitert
    an der Eindeutigkeit von ``hostname`` und liest den Eintrag des ersten.
    """
    inst = RegisteredInstance(
        id=next_id(),
        hostname=host,
        client_id=f"frei-{secrets.token_urlsafe(16)}",
        client_secret=KEIN_ZUGANG,
        status="active",
        origin="vps",
        registered_by=None,
        ohne_freigabe=True,
    )
    db.add(inst)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        vorhanden = await finde_instanz(db, host)
        if vorhanden is None:
            raise
        return vorhanden
    await db.refresh(inst)
    return inst
```

- [ ] **Step 4: Test laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_instanz_eintrag.py`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit.**

```bash
git add services/auth/src/dcc_auth/instanz_eintrag.py services/auth/tests/test_instanz_eintrag.py
git commit -m "feat(auth): Server-Eintrag für eine Adresse finden oder ohne Antrag anlegen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.4: Ticket mit Adresse, auch für unbekannte Server

**Files:**
- Modify: `services/auth/src/dcc_auth/server_ticket.py:44-77`
- Modify: `services/auth/src/dcc_auth/routes_server_ticket.py:1-138`
- Modify: `services/auth/src/dcc_auth/config.py:151` (neue Einstellung daneben)
- Test: `services/auth/tests/test_server_ticket_route.py`

**Interfaces:**
- Consumes: Task 1.1, Task 1.3.
- Produces: `baue_ticket(*, user_id, instance_id, hostname, name, avatar, amr, acr) -> str` mit `aud = [str(instance_id), hostname]`; Route-Fehlercodes `hostname_ungueltig` (422), `not found` (404, nur für eigene Domains und nicht aktive Einträge), `instance_suspended` (403).

- [ ] **Step 1: Bestehende Tests anpassen und neue schreiben** (`test_server_ticket_route.py`).

In `test_ticket_wird_auf_die_angefragte_instanz_ausgestellt`:

```python
    assert c["aud"] == ["900001", "a.example.com"]
```
In `test_der_hostname_bestimmt_das_publikum_nicht_der_anfragende`:

```python
    assert c["aud"] == ["900011", "boese.example.com"], "das Ticket gilt fuer den genannten Host"
    assert r.json()["instance_id"] == "900011"
    assert "900010" not in c["aud"]
    assert "ehrlich.example.com" not in c["aud"]
```
`test_unbekannte_instanz_gibt_404` ersetzen durch:

```python
@pytest.mark.asyncio
async def test_unbekannte_adresse_bekommt_einen_eintrag(client, session_factory):
    """Seit 2026-10-09 gibt es keine Freigabe mehr: ein Server, den die Cloud
    nicht kennt, bekommt beim ersten Ticket einen Eintrag ohne Besitzer."""
    from sqlalchemy import select

    from dcc_auth.models_instances import RegisteredInstance

    cookie, _ = await _reg_and_login(client)
    r = await client.post(
        "/me/server-ticket", json={"hostname": "https://Neu.Example.com/"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 200, r.text
    iid = r.json()["instance_id"]
    c = pyjwt.decode(r.json()["ticket"], options={"verify_signature": False}, audience=iid)
    assert c["aud"] == [iid, "neu.example.com"]

    async with session_factory() as s:
        inst = (
            await s.execute(
                select(RegisteredInstance).where(RegisteredInstance.hostname == "neu.example.com")
            )
        ).scalar_one()
    assert str(inst.id) == iid
    assert inst.ohne_freigabe is True
    assert inst.registered_by is None


@pytest.mark.asyncio
async def test_zweites_ticket_nutzt_denselben_eintrag(client):
    cookie, _ = await _reg_and_login(client)
    a = await client.post("/me/server-ticket", json={"hostname": "zwei.example.com"}, headers={"Cookie": cookie})
    b = await client.post("/me/server-ticket", json={"hostname": "zwei.example.com"}, headers={"Cookie": cookie})
    assert a.json()["instance_id"] == b.json()["instance_id"]


@pytest.mark.asyncio
@pytest.mark.parametrize("hostname", ["localhost", "127.0.0.1", "kein-punkt", "[::1]"])
async def test_ungueltige_adresse_gibt_422(client, hostname):
    cookie, _ = await _reg_and_login(client)
    r = await client.post("/me/server-ticket", json={"hostname": hostname}, headers={"Cookie": cookie})
    assert r.status_code == 422
    assert r.json()["detail"] == "hostname_ungueltig"


@pytest.mark.asyncio
async def test_eigene_domains_bekommen_keinen_eintrag(client):
    from dcc_auth.config import get_settings

    cookie, _ = await _reg_and_login(client)
    relay = get_settings().pulse_relay_base_domain
    r = await client.post(
        "/me/server-ticket", json={"hostname": f"frech.{relay}"}, headers={"Cookie": cookie}
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_alter_server_nimmt_das_ticket_weiter_an(client, session_factory):
    """Bestandsserver pruefen ``audience=<ihre Nummer>``. PyJWT akzeptiert das,
    solange die Nummer IN der Liste steht — deshalb bleibt sie im Ticket."""
    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(session_factory, iid=900020, hostname="alt.example.com", besitzer=user_id)
    r = await client.post("/me/server-ticket", json={"hostname": "alt.example.com"}, headers={"Cookie": cookie})
    c = pyjwt.decode(r.json()["ticket"], options={"verify_signature": False}, audience="900020")
    assert c["sub"] == str(user_id)


@pytest.mark.asyncio
async def test_geloeschter_server_hinterlaesst_seine_adresse_frei(client, session_factory):
    """Ein geloeschter Eintrag heisst ``deleted-<id>.invalid``. Wer unter der
    alten Adresse neu installiert, bekommt einen frischen Eintrag."""
    cookie, user_id = await _reg_and_login(client)
    await _instanz_anlegen(
        session_factory, iid=900030, hostname="deleted-900030.invalid", besitzer=user_id
    )
    r = await client.post("/me/server-ticket", json={"hostname": "wieder.example.com"}, headers={"Cookie": cookie})
    assert r.status_code == 200
    assert r.json()["instance_id"] != "900030"


@pytest.mark.asyncio
async def test_gesperrter_eintrag_bekommt_keinen_neuen(client, session_factory):
    from dcc_auth.models_instances import SuspendedInstance

    cookie, _ = await _reg_and_login(client)
    erst = await client.post("/me/server-ticket", json={"hostname": "sperr.example.com"}, headers={"Cookie": cookie})
    iid = int(erst.json()["instance_id"])
    async with session_factory() as s:
        s.add(SuspendedInstance(instance_id=iid, reason="Test"))
        await s.commit()
    r = await client.post("/me/server-ticket", json={"hostname": "sperr.example.com"}, headers={"Cookie": cookie})
    assert r.status_code == 403
    assert r.json()["detail"] == "instance_suspended"


@pytest.mark.asyncio
async def test_neue_eintraege_sind_gebremst(client, monkeypatch):
    from dcc_auth.config import get_settings

    monkeypatch.setattr(get_settings(), "rate_limit_server_ticket_neu", "2/hour")
    cookie, _ = await _reg_and_login(client)
    codes = [
        (await client.post("/me/server-ticket", json={"hostname": f"b{i}.example.com"}, headers={"Cookie": cookie})).status_code
        for i in range(3)
    ]
    assert codes == [200, 200, 429]
```
Lange Zeilen beim Übertragen auf ≤ 100 Zeichen umbrechen (Ruff).

- [ ] **Step 2: Tests laufen lassen, die neuen müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_server_ticket_route.py`
Expected: FAIL — `test_unbekannte_adresse_bekommt_einen_eintrag` mit 404, `aud`-Vergleiche mit `'900001' != [...]`.

- [ ] **Step 3: Einstellung ergänzen** (`config.py`, direkt unter `rate_limit_server_ticket`).

```python
    #: Neue Server-Einträge entstehen ohne Antrag beim ersten Ticket für eine
    #: unbekannte Adresse (``instanz_eintrag.py``). Eng gefasst, weil jeder
    #: Aufruf eine Zeile anlegt; ein echter Betreiber braucht einen.
    rate_limit_server_ticket_neu: str = "10/hour"
```

- [ ] **Step 4: `baue_ticket` erweitern** (`server_ticket.py`).

```python
def baue_ticket(
    *,
    user_id: str,
    instance_id: int,
    hostname: str,
    name: str,
    avatar: str | None,
    amr: list[str],
    acr: str,
) -> str:
    """Signiert ein Serverticket für genau einen Server.

    ``aud`` trägt beides: die Adresse (seit 2026-10-09 der Normalfall — ein
    Server ohne Freigabe kennt nur sie) und die Instanz-Nummer (Server mit
    altem Code prüfen nur sie; PyJWT nimmt an, sobald sie IN der Liste steht).
    """
    settings = get_settings()
    jetzt = int(time.time())
    nutzlast: dict[str, Any] = {
        "iss": settings.pulse_oidc_issuer,
        "aud": [str(instance_id), hostname],
        ...  # Rest unverändert
    }
```
Den Modul-Docstring-Absatz „Warum die Frist so kurz ist“ um einen Satz ergänzen: „``aud`` nennt seit 2026-10-09 die Adresse des Servers und seine Instanz-Nummer.“

- [ ] **Step 5: Route umbauen** (`routes_server_ticket.py`). Docstring von `TicketEin` ergänzen: „Seit 2026-10-09 kennt die Cloud nicht jeden Server vorher; für eine unbekannte Adresse legt sie beim ersten Ticket einen Eintrag an (``instanz_eintrag.py``). Die Sicherheitseigenschaft bleibt: das ``aud`` kommt aus der angefragten Adresse, nicht vom Server.“ Den Rumpf ab `roh = …` bis vor `gesperrt = …` ersetzen durch:

```python
    host = normalisiere_hostname(payload.hostname)
    if host is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="hostname_ungueltig")
    inst = await finde_instanz(db, host)
    if inst is None:
        if adresse_reserviert(host, settings):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
        await _check_rate(
            request,
            "server_ticket_neu",
            settings.rate_limit_server_ticket_neu,
            account=str(user.id),
        )
        inst = await eintrag_anlegen(db, host)
    # Nicht aktiv = gesperrt oder gelöscht. Gelöschte Einträge heissen
    # ``deleted-<id>.invalid`` und werden unter ihrer alten Adresse gar nicht
    # mehr gefunden; hier landet praktisch nur ``suspended``.
    if inst.status != "active":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not found")
```
Und im `return` `hostname=host` an `baue_ticket` übergeben. Imports:

```python
from dcc_shared.hostname import normalisiere_hostname

from dcc_auth.instanz_eintrag import adresse_reserviert, eintrag_anlegen, finde_instanz
```
`from urllib.parse import urlsplit` und den nicht mehr gebrauchten `select`-Import entfernen, falls nichts anderes sie nutzt (`SuspendedInstance`-Abfrage braucht `select` weiterhin — dann bleibt er).

Hinweis zur Reihenfolge: eine `status == "suspended"`-Zeile führt erst zu 404. Der Test `test_gesperrter_eintrag_bekommt_keinen_neuen` sperrt über `SuspendedInstance` bei `status="active"` (so wie `test_gesperrte_instanz_bekommt_kein_ticket`); der Admin-Weg setzt beides (`routes_admin_instances.py:194-242`) und trifft damit den 404-Zweig. Das entspricht dem bisherigen Verhalten.

- [ ] **Step 6: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_server_ticket_route.py`
Expected: PASS.

- [ ] **Step 7: Volles Gate, Simplifier, Commit.**

```bash
bash scripts/gate.sh
git add services/auth/src/dcc_auth/server_ticket.py services/auth/src/dcc_auth/routes_server_ticket.py \
  services/auth/src/dcc_auth/config.py services/auth/tests/test_server_ticket_route.py
git commit -m "feat(auth): Serverticket trägt die Adresse, unbekannte Server bekommen einen Eintrag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Landen (nach Freigabe) und Bestand prüfen.** `bash scripts/ship.sh`. Danach in der App auf einem Bestandsserver (VPS) neu anmelden (Server in der Leiste wählen, Seite neu laden): Anmeldung klappt, Admin-Bereich des Servers erreichbar. Bei einem Fehlschlag: `ticket_wrong_audience` im Netzwerk-Tab der App heißt, dass PyJWT auf dem Server die Liste nicht annimmt — dann sofort zurückrollen (`git revert` des Merge-Commits, landen).

---

## Etappe 2 — Server: Adresse prüfen, Einrichtungscode, Start ohne Cloud-Werte

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/selfhost-einrichtungscode`

### Task 2.1: Ticket gegen Adresse oder Nummer prüfen

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/config.py:127-131` (neues Feld danach)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/ticket_pruefung.py:65-95`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py:89-105`
- Modify: `services/chat-gateway/tests/conftest.py:80-81`
- Test: `services/chat-gateway/tests/test_ticket_pruefung.py`, `services/chat-gateway/tests/test_session_ticket_route.py`

**Interfaces:**
- Produces:
  - `Settings.pulse_hostname: str = ""` (aus `PULSE_HOSTNAME`, steht schon in `/etc/pulse/env.sh`, `07-render-env.sh:146`).
  - `erlaubte_empfaenger(*, hostname: str, instanz_id: int) -> list[str]`
  - `async pruefe_ticket(roh: str, *, empfaenger: list[str], cloud_issuer: str, redis) -> TicketDaten`
  - Fehlercode `hostname_unconfigured` (503 in `/session`).

- [ ] **Step 1: Tests schreiben.** In `test_ticket_pruefung.py` jeden Aufruf `instanz_id=42` durch `empfaenger=["42"]` ersetzen und anfügen:

```python
from dcc_chat_gateway.ticket_pruefung import erlaubte_empfaenger


def test_empfaenger_aus_adresse_und_nummer():
    assert erlaubte_empfaenger(hostname="Chat.Example.org", instanz_id=42) == ["chat.example.org", "42"]
    assert erlaubte_empfaenger(hostname="chat.example.org", instanz_id=0) == ["chat.example.org"]
    assert erlaubte_empfaenger(hostname="", instanz_id=42) == ["42"]
    assert erlaubte_empfaenger(hostname="", instanz_id=0) == []


@pytest.mark.asyncio
async def test_ticket_mit_adresse_gilt_beim_server_mit_dieser_adresse():
    roh = _ticket(aud=["99", "chat.example.org"])
    d = await pruefe_ticket(
        roh, empfaenger=erlaubte_empfaenger(hostname="Chat.Example.org.", instanz_id=0),
        cloud_issuer=ISS, redis=FakeRedis(),
    )
    assert d.sub == "7"


@pytest.mark.asyncio
async def test_listen_ticket_gilt_beim_bestandsserver_ueber_die_nummer():
    """Bestandsserver kennen ihre Nummer; die Cloud schreibt sie mit ins Ticket."""
    d = await pruefe_ticket(
        _ticket(aud=["42", "alt.example.org"]), empfaenger=["42"], cloud_issuer=ISS, redis=FakeRedis()
    )
    assert d.sub == "7"


@pytest.mark.asyncio
async def test_ticket_fuer_fremde_adresse_wird_abgelehnt():
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(
            _ticket(aud=["99", "fremd.example.net"]),
            empfaenger=["chat.example.org"], cloud_issuer=ISS, redis=FakeRedis(),
        )
    assert e.value.code == "ticket_wrong_audience"


@pytest.mark.asyncio
async def test_ohne_eigene_adresse_und_nummer_eigener_befund():
    with pytest.raises(TicketFehler) as e:
        await pruefe_ticket(_ticket(), empfaenger=[], cloud_issuer=ISS, redis=FakeRedis())
    assert e.value.code == "hostname_unconfigured"
```
In `test_session_ticket_route.py` anfügen:

```python
@pytest.mark.asyncio
async def test_server_ohne_nummer_erkennt_sein_ticket_an_der_adresse(
    client, ticket_bauer, jwks_in_redis, als_betreiber
):
    als_betreiber.pulse_instance_id = 0
    als_betreiber.pulse_hostname = "chat.example.org"
    r = await client.post(
        "/session", json={"ticket": ticket_bauer(aud=["777", "chat.example.org"])}
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_ohne_adresse_und_nummer_503(client, ticket_bauer, jwks_in_redis, _isolate_chat_settings):
    _isolate_chat_settings.pulse_instance_id = 0
    _isolate_chat_settings.pulse_hostname = ""
    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code == 503
    assert r.json()["detail"] == "hostname_unconfigured"
```

- [ ] **Step 2: Tests laufen lassen, sie müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_ticket_pruefung.py services/chat-gateway/tests/test_session_ticket_route.py`
Expected: FAIL mit `ImportError: cannot import name 'erlaubte_empfaenger'`.

- [ ] **Step 3: Einstellung** (`config.py`, nach `pulse_instance_id`):

```python
    # Die eigene öffentliche Adresse (``PULSE_HOSTNAME``, von 07-render-env.sh
    # durchgereicht). Seit 2026-10-09 trägt jedes Serverticket sie im ``aud``;
    # ein Server ohne Instanz-Nummer erkennt seine Tickets allein daran.
    pulse_hostname: str = ""
```
Den Kommentar über `pulse_instance_id` ergänzen: „Seit 2026-10-09 optional: Server ohne Freigabe haben keine. Bestandsserver behalten sie, weil ihre Tickets sie weiter tragen.“

`tests/conftest.py`, in `_isolate_chat_settings` neben `pulse_instance_id`:

```python
    _TEST_SETTINGS.pulse_hostname = ""
    _TEST_SETTINGS.pulse_instance_owner_id = 0
```

- [ ] **Step 4: `ticket_pruefung.py`.**

```python
from dcc_shared.hostname import normalisiere_hostname


def erlaubte_empfaenger(*, hostname: str, instanz_id: int) -> list[str]:
    """Wofür ein Ticket ausgestellt sein muss, damit dieser Server es annimmt.

    Die Adresse ist seit 2026-10-09 der Normalfall; die Instanz-Nummer bleibt
    für Server, die noch mit Freigabe eingerichtet wurden. Die Cloud schreibt
    beides ins Ticket — deshalb ist die Reihenfolge des Ausrollens egal.
    """
    erlaubt: list[str] = []
    host = normalisiere_hostname(hostname) if hostname else None
    if host:
        erlaubt.append(host)
    if instanz_id:
        erlaubt.append(str(instanz_id))
    return erlaubt
```
`pruefe_ticket` bekommt `empfaenger: list[str]` statt `instanz_id: int`; als erste Zeile im Rumpf:

```python
    if not empfaenger:
        # Ohne eigene Adresse und ohne Nummer passt kein Ticket. Eigener Code,
        # weil der Handgriff ein anderer ist: PULSE_HOSTNAME setzen.
        raise TicketFehler("hostname_unconfigured")
```
und im `jwt.decode` `audience=empfaenger`. Den Modul-Docstring-Punkt `**aud**` ergänzen: „— es taugt nur für diesen Server: seine Adresse oder, bei Bestandsservern, seine Instanz-Nummer.“

- [ ] **Step 5: `routes/session_ticket.py`.** Den Block Zeilen 91–105 ersetzen:

```python
    # Ohne eigene Adresse und ohne Instanz-Nummer kann kein Ticket passen.
    # Ohne diesen Riegel meldete die Anmeldung ``ticket_wrong_audience``, und
    # dessen Text schickt den Betreiber in die falsche Richtung.
    empfaenger = erlaubte_empfaenger(
        hostname=settings.pulse_hostname, instanz_id=settings.pulse_instance_id
    )
    if settings.pulse_instance_mode == "self-host" and not empfaenger:
        raise HTTPException(status_code=503, detail="hostname_unconfigured")

    try:
        daten = await pruefe_ticket(
            payload.ticket,
            empfaenger=empfaenger,
            cloud_issuer=settings.pulse_oidc_issuer,
            redis=redis,
        )
```
Import: `from dcc_chat_gateway.ticket_pruefung import TicketFehler, erlaubte_empfaenger, pruefe_ticket`.

- [ ] **Step 6: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_ticket_pruefung.py services/chat-gateway/tests/test_session_ticket_route.py`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/config.py \
  services/chat-gateway/src/dcc_chat_gateway/ticket_pruefung.py \
  services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py \
  services/chat-gateway/tests/conftest.py services/chat-gateway/tests/test_ticket_pruefung.py \
  services/chat-gateway/tests/test_session_ticket_route.py
git commit -m "feat(chat-gateway): Serverticket gilt für die eigene Adresse oder Nummer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.2: Besitzer und Einrichtungscode

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/models/besitz.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/models/__init__.py` (Re-Export)
- Create: `services/chat-gateway/alembic/versions/20261009_1200_0101_instanz_besitz.py`
- Create: `services/chat-gateway/src/dcc_chat_gateway/besitz.py`
- Test: `services/chat-gateway/tests/test_besitz.py`

**Interfaces:**
- Produces (`dcc_chat_gateway.besitz`):
  - `neuer_code() -> str` — Form `XXXX-XXXX-XXXX`, Crockford-Base32.
  - `async besitzer_kennung(session, settings) -> str | None` — Umgebung gewinnt, sonst Tabelle; in der Cloud immer `None`.
  - `async code_sicherstellen(session, settings) -> str | None` — offener Code, legt ihn bei Bedarf an; `None`, wenn ein Besitzer existiert.
  - `async uebernehmen(session, settings, kennung: str, code: str) -> Literal["uebernommen", "falsch", "vergeben"]`
  - `async neu_aufsetzen(session) -> str` — löscht den Besitzer aus der Tabelle, neuer Code.
- Modell `InstanzBesitz` (Tabelle `chat.instanz_besitz`, genau eine Zeile `id = 1`).

- [ ] **Step 1: Failing test schreiben** (`tests/test_besitz.py`).

```python
"""Besitzer und Einrichtungscode (Spec E5)."""

from __future__ import annotations

import re

import pytest

from dcc_chat_gateway import besitz


def test_code_hat_die_vereinbarte_form():
    code = besitz.neuer_code()
    assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}", code)


@pytest.mark.asyncio
async def test_ohne_besitzer_entsteht_genau_ein_code(session_factory, _isolate_chat_settings):
    async with session_factory() as s:
        erster = await besitz.code_sicherstellen(s, _isolate_chat_settings)
        zweiter = await besitz.code_sicherstellen(s, _isolate_chat_settings)
    assert erster and erster == zweiter


@pytest.mark.asyncio
async def test_umgebung_gewinnt_und_es_gibt_keinen_code(session_factory, _isolate_chat_settings):
    _isolate_chat_settings.pulse_instance_owner_id = 4711
    async with session_factory() as s:
        assert await besitz.besitzer_kennung(s, _isolate_chat_settings) == "4711"
        assert await besitz.code_sicherstellen(s, _isolate_chat_settings) is None
        assert await besitz.uebernehmen(s, _isolate_chat_settings, "1", "egal") == "vergeben"


@pytest.mark.asyncio
@pytest.mark.parametrize("schreibweise", ["genau", "klein", "ohne_striche", "mit_leerraum"])
async def test_richtiger_code_macht_zum_besitzer(session_factory, _isolate_chat_settings, schreibweise):
    async with session_factory() as s:
        code = await besitz.code_sicherstellen(s, _isolate_chat_settings)
        eingabe = {
            "genau": code,
            "klein": code.lower(),
            "ohne_striche": code.replace("-", ""),
            "mit_leerraum": f"  {code.replace('-', ' ')} ",
        }[schreibweise]
        assert await besitz.uebernehmen(s, _isolate_chat_settings, "73315227868860416", eingabe) == "uebernommen"
        assert await besitz.besitzer_kennung(s, _isolate_chat_settings) == "73315227868860416"
        assert await besitz.code_sicherstellen(s, _isolate_chat_settings) is None


@pytest.mark.asyncio
async def test_falscher_code_aendert_nichts(session_factory, _isolate_chat_settings):
    async with session_factory() as s:
        await besitz.code_sicherstellen(s, _isolate_chat_settings)
        assert await besitz.uebernehmen(s, _isolate_chat_settings, "1", "AAAA-AAAA-AAAA") == "falsch"
        assert await besitz.uebernehmen(s, _isolate_chat_settings, "1", "ä") == "falsch"
        assert await besitz.besitzer_kennung(s, _isolate_chat_settings) is None


@pytest.mark.asyncio
async def test_zweite_uebernahme_ist_vergeben(session_factory, _isolate_chat_settings):
    async with session_factory() as s:
        code = await besitz.code_sicherstellen(s, _isolate_chat_settings)
        await besitz.uebernehmen(s, _isolate_chat_settings, "1", code)
        assert await besitz.uebernehmen(s, _isolate_chat_settings, "2", code) == "vergeben"


@pytest.mark.asyncio
async def test_neu_aufsetzen_gibt_den_server_wieder_frei(session_factory, _isolate_chat_settings):
    async with session_factory() as s:
        alt = await besitz.code_sicherstellen(s, _isolate_chat_settings)
        await besitz.uebernehmen(s, _isolate_chat_settings, "1", alt)
        neu = await besitz.neu_aufsetzen(s)
        assert neu != alt
        assert await besitz.besitzer_kennung(s, _isolate_chat_settings) is None
        assert await besitz.code_sicherstellen(s, _isolate_chat_settings) == neu


@pytest.mark.asyncio
async def test_in_der_cloud_gibt_es_keinen_besitzer(session_factory, _isolate_chat_settings):
    _isolate_chat_settings.pulse_instance_mode = "cloud"
    async with session_factory() as s:
        assert await besitz.besitzer_kennung(s, _isolate_chat_settings) is None
        assert await besitz.code_sicherstellen(s, _isolate_chat_settings) is None
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_besitz.py`
Expected: FAIL mit `ImportError: cannot import name 'besitz'`.

- [ ] **Step 3: Modell** (`models/besitz.py`).

```python
"""Besitzer dieses Servers, wenn er nicht aus der Umgebung kommt (2026-10-09).

Genau eine Zeile (``id = 1``). Der Einrichtungscode steht im Klartext darin:
er ist das einzige, was zwischen einem frisch installierten Server und seinem
Besitzer steht, und muss sich deshalb jederzeit wieder anzeigen lassen
(``pulse-setup-code``). Nach der Übernahme wird er gelöscht.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from dcc_chat_gateway.db import Base


class InstanzBesitz(Base):
    __tablename__ = "instanz_besitz"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    #: Cloud-Kennung des Besitzers (dieselbe Zahl wie ``sub`` im Serverticket).
    besitzer: Mapped[str | None] = mapped_column(Text, nullable=True)
    code: Mapped[str | None] = mapped_column(Text, nullable=True)
    uebernommen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
```
In `models/__init__.py` alphabetisch einreihen: `from dcc_chat_gateway.models.besitz import InstanzBesitz` und `"InstanzBesitz"` in `__all__`, falls die Datei eines führt.

- [ ] **Step 4: Migration** (`20261009_1200_0101_instanz_besitz.py`).

```python
"""instanz_besitz — Besitzer und Einrichtungscode ohne Freigabe

Seit 2026-10-09 gibt es keine Freigabe mehr, und damit niemanden, der
``PULSE_INSTANCE_OWNER_ID`` vorher kennt. Ein Server ohne Besitzer erzeugt beim
Start einen Einrichtungscode; wer ihn beim ersten Beitritt mitschickt, wird
Besitzer (``besitz.py``).

Revision ID: 0101_instanz_besitz
Revises: 0100_cached_user_profiles_lower
Create Date: 2026-10-09 12:00:00.000000+00:00

"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Siehe 0088: die Tabellen dieses Dienstes leben im Schema ``chat``.
SCHEMA = "chat"

revision: str = "0101_instanz_besitz"
down_revision: str | Sequence[str] | None = "0100_cached_user_profiles_lower"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "instanz_besitz",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("besitzer", sa.Text(), nullable=True),
        sa.Column("code", sa.Text(), nullable=True),
        sa.Column("uebernommen_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("instanz_besitz", schema=SCHEMA)
```

- [ ] **Step 5: Logik** (`besitz.py`).

```python
"""Wem gehört dieser Server? — Besitzer und Einrichtungscode.

Bis 2026-10-09 stand der Besitzer allein in ``PULSE_INSTANCE_OWNER_ID``, und den
Wert vergab die Cloud bei der Freigabe. Ohne Freigabe weiß niemand vorher, wer
den Server betreibt. Deshalb erzeugt ein Server ohne Besitzer beim Start einen
Einrichtungscode; wer ihn beim ersten Beitritt mitschickt, wird Besitzer
(``routes/session_ticket.py``).

Reihenfolge: die Umgebung gewinnt (Bestandsserver, Server-App), sonst die
Tabelle. Beide Wege enden in ``besitzer_kennung`` — eine zweite Stelle, die
entscheidet, wer Besitzer ist, gibt es nicht.

Der Code steht in keinem Log: Diagnosepakete können Logs enthalten, und wer
den Code hat, übernimmt den Server.
"""

from __future__ import annotations

import hmac
import secrets
from datetime import datetime, timezone
from typing import Literal

from dcc_chat_gateway.models import InstanzBesitz

#: Crockford-Base32 ohne I, L, O, U — nichts, was man beim Abtippen verwechselt.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
#: 12 Zeichen × 5 bit = 60 bit. Mit der Bremse in ``routes/session_ticket.py``
#: (5 Versuche je Konto, 20 je IP in 15 Minuten) ist Durchprobieren aussichtslos.
_LAENGE = 12
_ZEILE = 1

Uebernahme = Literal["uebernommen", "falsch", "vergeben"]


def neuer_code() -> str:
    roh = "".join(secrets.choice(_ALPHABET) for _ in range(_LAENGE))
    return f"{roh[0:4]}-{roh[4:8]}-{roh[8:12]}"


def _vergleichsform(code: str) -> bytes:
    """Großschreibung, ohne Trennzeichen und Leerraum — so, wie Menschen tippen.

    Bytes, weil ``hmac.compare_digest`` bei Zeichenketten außerhalb von ASCII
    einen ``TypeError`` wirft; ein „ä“ im Eingabefeld wäre sonst ein 500.
    """
    return "".join(ch for ch in code.upper() if ch.isalnum()).encode()


async def besitzer_kennung(session, settings) -> str | None:
    if settings.pulse_instance_mode != "self-host":
        return None
    if settings.pulse_instance_owner_id:
        return str(settings.pulse_instance_owner_id)
    zeile = await session.get(InstanzBesitz, _ZEILE)
    return zeile.besitzer if zeile is not None and zeile.besitzer else None


async def code_sicherstellen(session, settings) -> str | None:
    """Der offene Code — angelegt, wenn keiner da ist. ``None`` = es gibt einen
    Besitzer (oder dies ist die Cloud)."""
    if settings.pulse_instance_mode != "self-host":
        return None
    if await besitzer_kennung(session, settings) is not None:
        return None
    zeile = await session.get(InstanzBesitz, _ZEILE)
    if zeile is None:
        zeile = InstanzBesitz(id=_ZEILE, code=neuer_code())
        session.add(zeile)
        await session.commit()
    elif not zeile.code:
        zeile.code = neuer_code()
        await session.commit()
    return zeile.code


async def uebernehmen(session, settings, kennung: str, code: str) -> Uebernahme:
    if await besitzer_kennung(session, settings) is not None:
        return "vergeben"
    if settings.pulse_instance_mode != "self-host":
        return "vergeben"
    zeile = await session.get(InstanzBesitz, _ZEILE)
    if zeile is None or not zeile.code:
        return "falsch"
    if not hmac.compare_digest(_vergleichsform(code), _vergleichsform(zeile.code)):
        return "falsch"
    zeile.besitzer = kennung
    zeile.code = None
    zeile.uebernommen_at = datetime.now(timezone.utc)
    await session.commit()
    return "uebernommen"


async def neu_aufsetzen(session) -> str:
    """Rettungsweg (``pulse-setup-code --reset``): Besitzer aus der Tabelle
    löschen, neuen Code erzeugen. Ein Besitzer aus der Umgebung bleibt davon
    unberührt — der Aufrufer prüft das vorher."""
    zeile = await session.get(InstanzBesitz, _ZEILE)
    if zeile is None:
        zeile = InstanzBesitz(id=_ZEILE)
        session.add(zeile)
    zeile.besitzer = None
    zeile.uebernommen_at = None
    zeile.code = neuer_code()
    await session.commit()
    return zeile.code
```

- [ ] **Step 6: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_besitz.py`
Expected: PASS (11 passed). Danach die Kopf-/Migrationsprüfungen des Dienstes: `uv run --all-packages pytest -q services/chat-gateway/tests -k "alembic or migration"` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/models/besitz.py \
  services/chat-gateway/src/dcc_chat_gateway/models/__init__.py \
  services/chat-gateway/alembic/versions/20261009_1200_0101_instanz_besitz.py \
  services/chat-gateway/src/dcc_chat_gateway/besitz.py services/chat-gateway/tests/test_besitz.py
git commit -m "feat(chat-gateway): Besitzer per Einrichtungscode statt Freigabe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.3: Einrichtungscode beim ersten Beitritt einlösen

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py:50-150`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/owner_admin_log.py:45-93`
- Test: `services/chat-gateway/tests/test_session_ticket_route.py`, `services/chat-gateway/tests/test_owner_admin_log.py`

**Interfaces:**
- Consumes: Task 2.2.
- Produces: `SitzungEin.einrichtungscode: str | None` (max. 32); Antwortcodes `einrichtungscode_falsch` (403), `besitzer_vergeben` (409), `einrichtungscode_gebremst` (429). `log_owner_konfiguration(settings, besitzer: str | None)`, `log_owner_admin_decision(settings, konto_id, is_owner_admin: bool, besitzer: str | None)`.

- [ ] **Step 1: Tests schreiben** (`test_session_ticket_route.py`).

```python
from dcc_chat_gateway import besitz


@pytest_asyncio.fixture(autouse=True)
async def _bremse_leeren(app):
    """Die Bremse zählt in Redis mit 15 Minuten Frist. Ohne Leeren liefe ein
    zweiter Testlauf innerhalb dieser Zeit in 429 statt in den geprüften Fall."""
    async for schluessel in app.state.redis.scan_iter("besitz:rate:*"):
        await app.state.redis.delete(schluessel)
    yield


@pytest.mark.asyncio
async def test_einrichtungscode_macht_zum_besitzer_und_admin(
    client, ticket_bauer, jwks_in_redis, session_factory, _isolate_chat_settings
):
    async with session_factory() as s:
        code = await besitz.code_sicherstellen(s, _isolate_chat_settings)
    r = await client.post(
        "/session", json={"ticket": ticket_bauer(), "einrichtungscode": code.lower()}
    )
    assert r.status_code == 200, r.text
    claims = validate_session_token(
        r.json()["session_token"], key_path=_isolate_chat_settings.session_signing_key_file
    )
    assert claims is not None
    assert claims.admin is True

    # Zweiter Besuch ohne Code: weiterhin Besitzer, weiterhin Admin.
    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_falscher_einrichtungscode(client, ticket_bauer, jwks_in_redis, session_factory, _isolate_chat_settings):
    async with session_factory() as s:
        await besitz.code_sicherstellen(s, _isolate_chat_settings)
    r = await client.post(
        "/session", json={"ticket": ticket_bauer(), "einrichtungscode": "AAAA-AAAA-AAAA"}
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "einrichtungscode_falsch"


@pytest.mark.asyncio
async def test_einrichtungscode_bei_vergebenem_server(client, ticket_bauer, jwks_in_redis, als_betreiber):
    r = await client.post(
        "/session", json={"ticket": ticket_bauer(), "einrichtungscode": "AAAA-AAAA-AAAA"}
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "besitzer_vergeben"


@pytest.mark.asyncio
async def test_einrichtungscode_ist_gebremst(client, ticket_bauer, jwks_in_redis, session_factory, _isolate_chat_settings):
    async with session_factory() as s:
        await besitz.code_sicherstellen(s, _isolate_chat_settings)
    codes = []
    for _ in range(6):
        r = await client.post(
            "/session", json={"ticket": ticket_bauer(), "einrichtungscode": "AAAA-AAAA-AAAA"}
        )
        codes.append(r.status_code)
    assert codes[:5] == [403] * 5
    assert codes[5] == 429
    assert r.json()["detail"] == "einrichtungscode_gebremst"
```
`validate_session_token` ist schon importiert (Kopf der Datei) und liefert ein Objekt mit `.admin` (Muster: `test_der_betreiber_wird_als_admin_erkannt`).

In `test_owner_admin_log.py` die Aufrufe auf die neuen Signaturen umstellen: `_einstellungen` liefert weiter `pulse_instance_owner_id`; Aufrufe werden `log_owner_konfiguration(einst, "4711")` bzw. `log_owner_konfiguration(einst, None)` und `log_owner_admin_decision(einst, "4711", True, "4711")`. Den Test `test_startzeile_warnt_wenn_kein_besitzer_konfiguriert_ist` auf die neue Meldung prüfen:

```python
def test_startzeile_warnt_wenn_kein_besitzer_konfiguriert_ist(caplog):
    with caplog.at_level(logging.INFO, logger=_MODUL):
        log_owner_konfiguration(_einstellungen(owner=0), None)
    assert "no owner yet" in caplog.text
    assert "pulse-setup-code" in caplog.text
```

- [ ] **Step 2: Tests laufen lassen, sie müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_session_ticket_route.py services/chat-gateway/tests/test_owner_admin_log.py`
Expected: FAIL (`einrichtungscode` wird ignoriert → kein Admin; Signaturfehler im Log-Test).

- [ ] **Step 3: `owner_admin_log.py`.**

```python
_KEIN_BESITZER = (
    "This instance has no owner yet — run `pulse-setup-code` inside the container "
    "to show the setup code; the account that enters it when joining becomes the owner"
)


def log_owner_konfiguration(settings, besitzer: str | None) -> None:
    """Beim Start einmal sagen, wem diese Instanz gehört (``besitz.py``)."""
    if settings.pulse_instance_mode != "self-host":
        return
    if besitzer is None:
        log.warning(_KEIN_BESITZER)
        return
    log.info(
        "This instance belongs to Cloud account %s — only that account becomes admin here",
        besitzer,
    )


def log_owner_admin_decision(settings, konto_id, is_owner_admin: bool, besitzer: str | None) -> None:
    """Einmal je Konto festhalten, wie die Besitzer-Prüfung ausging."""
    if settings.pulse_instance_mode != "self-host":
        return
    schluessel = str(konto_id)
    if schluessel in _gemeldet:
        return
    _gemeldet.add(schluessel)

    if besitzer is None:
        log.warning(_KEIN_BESITZER)
    elif is_owner_admin:
        log.info("Account %s recognised as the instance owner — admin", schluessel)
    else:
        log.info(
            "Account %s is NOT the instance owner (owner: %s) — not admin",
            schluessel,
            besitzer,
        )
```
Den Modul-Docstring um einen Absatz ergänzen: „Seit 2026-10-09 kommt der Besitzer aus ``besitz.besitzer_kennung`` (Umgebung oder Einrichtungscode). Die Meldung ohne Besitzer nennt deshalb ``pulse-setup-code`` statt der ``.env``-Zeile.“

- [ ] **Step 4: `routes/session_ticket.py`.** Feld in `SitzungEin`:

```python
    #: Der Einrichtungscode, den der Installer anzeigt (``besitz.py``). Nur auf
    #: einem Server ohne Besitzer sinnvoll; wer ihn mitschickt, wird Besitzer.
    #: Er reist HIER mit und nicht über eine eigene Route nach dem Beitritt:
    #: ohne Besitzer gibt es keine Community und damit keinen Weg durch das
    #: Beitritts-Gate — eine spätere Route wäre nie erreichbar.
    einrichtungscode: str | None = Field(default=None, max_length=32)
```
Hilfsfunktion über der Route:

```python
async def _einrichtungscode_bremse(redis, request: Request, kennung: str) -> None:
    """Je Konto und je IP. Kein gemeinsamer Zähler für alle: sonst könnte ein
    Fremder den Besitzer mit falschen Versuchen eine Viertelstunde aussperren."""
    if not await bremse(redis, f"besitz:rate:konto:{kennung}", 5, 900):
        raise HTTPException(status_code=429, detail="einrichtungscode_gebremst")
    if not await bremse(redis, f"besitz:rate:ip:{client_ip(request)}", 20, 900):
        raise HTTPException(status_code=429, detail="einrichtungscode_gebremst")
```
Im Rumpf `kennung = daten.sub` und den `ist_betreiber`-Block ersetzen:

```python
    kennung = daten.sub
    if payload.einrichtungscode:
        await _einrichtungscode_bremse(redis, request, kennung)
        ergebnis = await besitz.uebernehmen(session, settings, kennung, payload.einrichtungscode)
        if ergebnis == "falsch":
            raise HTTPException(status_code=403, detail="einrichtungscode_falsch")
        if ergebnis == "vergeben":
            raise HTTPException(status_code=409, detail="besitzer_vergeben")
    # Besitzer = Umgebung oder Einrichtungscode (``besitz.besitzer_kennung``);
    # in der Cloud gibt es keinen. Der Vergleich läuft über Zahlen: eine andere,
    # gleichwertige Schreibweise derselben Kennung träfe sonst nicht.
    besitzer = await besitz.besitzer_kennung(session, settings)
    ist_betreiber = besitzer is not None and _kennung_gleich(kennung, besitzer)
    log_owner_admin_decision(settings, kennung, ist_betreiber, besitzer)
```
`_kennung_gleich(vorgelegt: str, erwartet: str | int) -> bool` (Rumpf unverändert). Imports: `from dcc_chat_gateway import besitz`, `from dcc_chat_gateway.client_ip import client_ip`, `from dcc_chat_gateway.gaeste import bremse`. Den langen Kommentar „Drei Bedingungen, alle drei nötig“ entfernen — die Betriebsart prüft jetzt `besitzer_kennung`.

- [ ] **Step 5: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_session_ticket_route.py services/chat-gateway/tests/test_owner_admin_log.py services/chat-gateway/tests/test_ownership_transfer.py`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py \
  services/chat-gateway/src/dcc_chat_gateway/owner_admin_log.py \
  services/chat-gateway/tests/test_session_ticket_route.py services/chat-gateway/tests/test_owner_admin_log.py
git commit -m "feat(chat-gateway): Einrichtungscode beim ersten Beitritt einlösen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.4: Server meldet „noch kein Besitzer“; Betreiber-Prüfung liest den Besitzer

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/server_info.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/faehigkeiten.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/owner_check.py:150-170`
- Test: `services/chat-gateway/tests/test_server_info.py`, `services/chat-gateway/tests/test_owner_check.py`

**Interfaces:**
- Produces: `ServerInfo.besitzer_offen: bool`; Fähigkeit `einrichtungscode` in `SERVER_FAEHIGKEITEN`.

- [ ] **Step 1: Tests schreiben** (`test_server_info.py`).

```python
@pytest.mark.asyncio
async def test_frischer_server_meldet_offenen_besitz(client, _isolate_chat_settings):
    r = await client.get("/.well-known/pulse-server-info")
    assert r.status_code == 200
    assert r.json()["besitzer_offen"] is True
    assert "einrichtungscode" in r.json()["capabilities"]


@pytest.mark.asyncio
async def test_server_mit_besitzer_meldet_keinen_offenen_besitz(client, _isolate_chat_settings):
    _isolate_chat_settings.pulse_instance_owner_id = 4711
    r = await client.get("/.well-known/pulse-server-info")
    assert r.json()["besitzer_offen"] is False


@pytest.mark.asyncio
async def test_cloud_meldet_keinen_offenen_besitz(client, _isolate_chat_settings):
    _isolate_chat_settings.pulse_instance_mode = "cloud"
    r = await client.get("/.well-known/pulse-server-info")
    assert r.json()["besitzer_offen"] is False
```
In `_make_settings` ergänzen: `s.pulse_instance_owner_id = kwargs.get("pulse_instance_owner_id", 0)`.

In `test_owner_check.py` einen Test für den Besitzer aus der Tabelle ergänzen — `test_treffer` als Vorlage kopieren, statt `pulse_instance_owner_id` zu setzen vorher `besitz.uebernehmen` mit dem Code aufrufen und `stimmt_ueberein is True` erwarten.

- [ ] **Step 2: Tests laufen lassen, sie müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_server_info.py services/chat-gateway/tests/test_owner_check.py`
Expected: FAIL mit `KeyError: 'besitzer_offen'`.

- [ ] **Step 3: Implementieren.** `faehigkeiten.py`:

```python
#: ``einrichtungscode``: kennt ``einrichtungscode`` in ``POST /session`` — ein
#: Server ohne Besitzer lässt sich beim ersten Beitritt übernehmen (2026-10-09).
SERVER_FAEHIGKEITEN: tuple[str, ...] = (
    "token_refresh",
    "server-ticket",
    "hist_replay",
    "einrichtungscode",
)
```
`server_info.py`:

```python
class ServerInfo(BaseModel):
    ...
    #: Ein Self-Host ohne Besitzer: der Beitrittsdialog fragt nach dem
    #: Einrichtungscode. Öffentlich, weil die Frage VOR jeder Anmeldung kommt;
    #: preisgegeben wird nur „übernehmbar“, der Code selbst nie.
    besitzer_offen: bool = False


@router.get("/.well-known/pulse-server-info", response_model=ServerInfo)
async def server_info(session: SessionDep) -> ServerInfo:
    ...
    return ServerInfo(
        ...,
        besitzer_offen=(
            settings.pulse_instance_mode == "self-host"
            and await besitzer_kennung(session, settings) is None
        ),
    )
```
Imports `from dcc_chat_gateway.besitz import besitzer_kennung`, `from dcc_chat_gateway.db import SessionDep`. Shape im Modul-Docstring um `"besitzer_offen": false` ergänzen.

`owner_check.py`: die Route bekommt `session: SessionDep`; `konfiguriert`/`stimmt_ueberein` aus `besitzer = await besitzer_kennung(session, settings)`:

```python
    besitzer = await besitzer_kennung(session, settings)
    erwartet = str(claims.get("owner_user_id") or "")
    return OwnerCheckAus(
        modus_self_host=settings.pulse_instance_mode == "self-host",
        owner_konfiguriert=besitzer is not None,
        stimmt_ueberein=besitzer is not None and erwartet == besitzer,
    )
```

- [ ] **Step 4: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_server_info.py services/chat-gateway/tests/test_owner_check.py`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/routes/server_info.py \
  services/chat-gateway/src/dcc_chat_gateway/faehigkeiten.py \
  services/chat-gateway/src/dcc_chat_gateway/routes/owner_check.py \
  services/chat-gateway/tests/test_server_info.py services/chat-gateway/tests/test_owner_check.py
git commit -m "feat(chat-gateway): Server meldet, ob er noch übernommen werden kann

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.5: Start ohne Instanz-Nummer, Code beim Start, `pulse-setup-code`

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/app.py:172-183,336-339`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/besitz.py` (Funktion `beim_start`)
- Create: `services/chat-gateway/src/dcc_chat_gateway/einrichtungscode.py`
- Create: `infra/self-host/s6/usr/local/bin/pulse-setup-code` (Modus 755)
- Test: `services/chat-gateway/tests/test_einrichtungscode_cli.py`

**Interfaces:**
- Produces: `async besitz.beim_start(session_factory, settings) -> None`; `async einrichtungscode.ausfuehren(*, reset: bool, session_factory, settings) -> tuple[int, str]`; CLI-Ausgabe beginnt bei Erfolg mit der Zeile `Setup code: XXXX-XXXX-XXXX` (der Installer liest genau diese Zeile).

- [ ] **Step 1: Failing test schreiben** (`tests/test_einrichtungscode_cli.py`).

```python
"""``pulse-setup-code`` — die Ausgabe, auf die sich der Installer verlaesst."""

from __future__ import annotations

import pytest

from dcc_chat_gateway import besitz
from dcc_chat_gateway.einrichtungscode import ausfuehren


@pytest.mark.asyncio
async def test_zeigt_den_offenen_code(session_factory, _isolate_chat_settings):
    status, text = await ausfuehren(reset=False, session_factory=session_factory, settings=_isolate_chat_settings)
    assert status == 0
    erste = text.splitlines()[0]
    assert erste.startswith("Setup code: ")
    async with session_factory() as s:
        assert erste.removeprefix("Setup code: ") == await besitz.code_sicherstellen(s, _isolate_chat_settings)


@pytest.mark.asyncio
async def test_mit_besitzer_kein_code(session_factory, _isolate_chat_settings):
    async with session_factory() as s:
        code = await besitz.code_sicherstellen(s, _isolate_chat_settings)
        await besitz.uebernehmen(s, _isolate_chat_settings, "73315227868860416", code)
    status, text = await ausfuehren(reset=False, session_factory=session_factory, settings=_isolate_chat_settings)
    assert status == 1
    assert "Setup code:" not in text
    assert "already has an owner" in text


@pytest.mark.asyncio
async def test_reset_gibt_neuen_code(session_factory, _isolate_chat_settings):
    async with session_factory() as s:
        alt = await besitz.code_sicherstellen(s, _isolate_chat_settings)
        await besitz.uebernehmen(s, _isolate_chat_settings, "1", alt)
    status, text = await ausfuehren(reset=True, session_factory=session_factory, settings=_isolate_chat_settings)
    assert status == 0
    assert text.splitlines()[0].startswith("Setup code: ")
    assert alt not in text


@pytest.mark.asyncio
async def test_besitzer_aus_der_umgebung_laesst_sich_nicht_zuruecksetzen(session_factory, _isolate_chat_settings):
    _isolate_chat_settings.pulse_instance_owner_id = 4711
    status, text = await ausfuehren(reset=True, session_factory=session_factory, settings=_isolate_chat_settings)
    assert status == 1
    assert "PULSE_INSTANCE_OWNER_ID" in text
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_einrichtungscode_cli.py`
Expected: FAIL mit `ModuleNotFoundError: No module named 'dcc_chat_gateway.einrichtungscode'`.

- [ ] **Step 3: CLI-Modul** (`einrichtungscode.py`).

```python
"""``pulse-setup-code`` — den Einrichtungscode dieses Servers anzeigen.

Läuft im Container (``docker exec pulse pulse-setup-code``), nie über das Netz:
der Code ist das einzige, was zwischen einem frisch installierten Server und
seinem Besitzer steht. Deshalb steht er auch in keinem Log (``besitz.py``).

``--reset`` setzt den Besitzer zurück und erzeugt einen neuen Code — der
Rettungsweg, wenn der falsche Mensch den Code eingegeben hat.

Die Ausgabe ist englisch (sie landet bei fremden Betreibern), und ihre erste
Zeile ``Setup code: …`` liest der Installer (``web/static/install.sh``) — wer
sie umformuliert, zieht ``zeige_einrichtungscode`` dort mit.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from dcc_chat_gateway import besitz
from dcc_chat_gateway import config as chat_config

_ANLEITUNG = (
    "In the Pulse app, join this server by its address and enter the code when asked.\n"
    "The account that enters it becomes the owner and admin of this server."
)


async def ausfuehren(*, reset: bool, session_factory, settings) -> tuple[int, str]:
    if settings.pulse_instance_mode != "self-host":
        return 2, "This is not a self-hosted server — there is no setup code here."
    if settings.pulse_instance_owner_id:
        return 1, (
            "The owner is set by PULSE_INSTANCE_OWNER_ID "
            f"(Pulse account {settings.pulse_instance_owner_id}). "
            "Remove that line from your configuration to use a setup code instead."
        )
    async with session_factory() as s:
        if reset:
            code = await besitz.neu_aufsetzen(s)
            return 0, f"Setup code: {code}\nOwnership was reset.\n{_ANLEITUNG}"
        besitzer = await besitz.besitzer_kennung(s, settings)
        if besitzer is not None:
            return 1, (
                f"This server already has an owner (Pulse account {besitzer}).\n"
                "Run `pulse-setup-code --reset` to remove the owner and create a new code."
            )
        code = await besitz.code_sicherstellen(s, settings)
    return 0, f"Setup code: {code}\n{_ANLEITUNG}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pulse-setup-code", description="Show the setup code of this Pulse server."
    )
    parser.add_argument(
        "--reset", action="store_true", help="remove the current owner and create a new code"
    )
    args = parser.parse_args(argv)
    from dcc_chat_gateway.db import SessionLocal

    status, text = asyncio.run(
        ausfuehren(reset=args.reset, session_factory=SessionLocal, settings=chat_config.get_settings())
    )
    print(text)
    return status


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Start-Hilfe in `besitz.py`** (unten anfügen).

```python
async def beim_start(session_factory, settings) -> None:
    """Einmal je Start: ohne Besitzer den Code anlegen und sagen, wem der Server
    gehört. Den Code selbst nennt die Meldung nicht (s. Modulkopf)."""
    if settings.pulse_instance_mode != "self-host":
        return
    from dcc_chat_gateway.owner_admin_log import log_owner_konfiguration

    async with session_factory() as s:
        await code_sicherstellen(s, settings)
        besitzer = await besitzer_kennung(s, settings)
    log_owner_konfiguration(settings, besitzer)
```

- [ ] **Step 5: `app.py`.** Den Block Zeilen 171–183 (RuntimeError bei `pulse_instance_id == 0`) **ersatzlos löschen** samt Kommentar. Die Zeile 339 `log_owner_konfiguration(settings)` und ihren Kommentar ersetzen durch:

```python
        # Wem gehört diese Instanz? Ohne Besitzer legt ``beim_start`` den
        # Einrichtungscode an (besitz.py); die Meldung nennt ihn nicht.
        if not getattr(app.state, "skip_redis", False):
            from dcc_chat_gateway.db import SessionLocal

            await besitz.beim_start(SessionLocal, settings)
```
Import oben `from dcc_chat_gateway import besitz`; den nun unbenutzten Import `log_owner_konfiguration` (Zeile 23) entfernen. Den Kommentar über dem Sperr-Poller (Zeile ~281) um einen Satz ergänzen: „Server ohne Freigabe haben keine Instanz-Nummer und damit keinen Sperr-Poller; für sie wirkt die Sperre allein über die Cloud, die keine Tickets mehr ausstellt.“

- [ ] **Step 6: Wrapper im Container** (`infra/self-host/s6/usr/local/bin/pulse-setup-code`).

```sh
#!/bin/sh
# pulse-setup-code — den Einrichtungscode dieses Servers anzeigen, oder mit
# --reset den Besitzer zurücksetzen.   `docker exec pulse pulse-setup-code`
#
# Dieselbe Umgebung wie der chat-gateway (s6-rc.d/chat-gateway/run): die
# Dienste lesen ausschliesslich /etc/pulse/env.sh.
set -eu
. /etc/pulse/env.sh
cd /opt/pulse/services/chat-gateway
exec /usr/sbin/gosu pulse /opt/pulse/venv/bin/python -m dcc_chat_gateway.einrichtungscode "$@"
```
Ausführbar machen (der Dockerfile setzt den Modus nicht selbst, er kommt aus Git):

```bash
chmod 755 infra/self-host/s6/usr/local/bin/pulse-setup-code
git add infra/self-host/s6/usr/local/bin/pulse-setup-code
git update-index --chmod=+x infra/self-host/s6/usr/local/bin/pulse-setup-code
git ls-files -s infra/self-host/s6/usr/local/bin/pulse-setup-code
```
Expected: Zeile beginnt mit `100755`.

- [ ] **Step 7: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_einrichtungscode_cli.py services/chat-gateway/tests`
Expected: PASS (der ganze Dienst, weil `app.py` sich geändert hat).

- [ ] **Step 8: Commit.**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/app.py services/chat-gateway/src/dcc_chat_gateway/besitz.py \
  services/chat-gateway/src/dcc_chat_gateway/einrichtungscode.py \
  services/chat-gateway/tests/test_einrichtungscode_cli.py infra/self-host/s6/usr/local/bin/pulse-setup-code
git commit -m "feat(self-host): Start ohne Instanz-Nummer, Einrichtungscode per pulse-setup-code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.6: Startskripte — nur die Adresse ist Pflicht

**Files:**
- Modify: `infra/self-host/s6/etc/s6-overlay/scripts/10-check-cloud-creds.sh`
- Modify: `infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh:145-161`
- Modify: `infra/self-host/s6/etc/s6-overlay/scripts/09-init-caddy.sh` (nach `cp "$TEMPLATE" "$TARGET"`)
- Test: `infra/self-host/tests/test_startpruefung.py`

Der Dateiname `10-check-cloud-creds.sh` bleibt, obwohl er nicht mehr stimmt: ihn nennen `cont-init-main.sh:43`, `install.sh:1080` und der Status-Text in `/data/setup-status`, den ältere Installer lesen. Der Kopfkommentar erklärt das.

- [ ] **Step 1: Failing test schreiben** (`infra/self-host/tests/test_startpruefung.py`).

```python
"""Startpruefung: seit 2026-10-09 ist nur die Adresse Pflicht.

Die Skripte laufen unter ``set -eu``; eine nicht gesetzte Variable bricht den
ganzen Start ab. Deshalb wird hier jeweils das echte Skript mit einer
Umgebung gefahren, in der die alten Cloud-Werte FEHLEN (nicht nur leer sind).
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys

import pytest

if sys.platform == "win32":
    pytest.skip("Shell-Skripte des Containers — Linux-CI-Sache", allow_module_level=True)

S6 = pathlib.Path(__file__).resolve().parents[1] / "s6"
PRUEFUNG = S6 / "etc/s6-overlay/scripts/10-check-cloud-creds.sh"
CADDY = S6 / "etc/s6-overlay/scripts/09-init-caddy.sh"
TEMPLATE = S6 / "etc/caddy/Caddyfile.template"
_ALT = (
    "PULSE_INSTANCE_ID",
    "PULSE_INSTANCE_OWNER_ID",
    "PULSE_CLOUD_CLIENT_ID",
    "PULSE_CLOUD_CLIENT_SECRET",
    "PULSE_ADMIN_EMAIL",
)


def _umgebung(**gesetzt: str) -> dict[str, str]:
    basis = {k: v for k, v in os.environ.items() if k not in _ALT and k != "PULSE_HOSTNAME"}
    return {**basis, **gesetzt}


def test_nur_die_adresse_genuegt():
    r = subprocess.run(
        ["sh", str(PRUEFUNG)], env=_umgebung(PULSE_HOSTNAME="chat.example.org"),
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr


def test_ohne_adresse_bricht_der_start_ab():
    r = subprocess.run(["sh", str(PRUEFUNG)], env=_umgebung(), capture_output=True, text=True)
    assert r.returncode == 1
    assert "PULSE_HOSTNAME" in r.stderr
    assert "client_secret" not in r.stderr


def test_ungueltige_adresse_bricht_ab():
    r = subprocess.run(
        ["sh", str(PRUEFUNG)], env=_umgebung(PULSE_HOSTNAME="kein punkt"),
        capture_output=True, text=True,
    )
    assert r.returncode == 1


def test_render_env_ueberlebt_fehlende_cloud_werte():
    """Der ``cat <<EOF``-Block aus 07-render-env.sh unter ``set -u``."""
    zeilen = (S6 / "etc/s6-overlay/scripts/07-render-env.sh").read_text().split("\n")
    start = next(i for i, z in enumerate(zeilen) if z.startswith("# Self-host identity."))
    ende = next(i for i, z in enumerate(zeilen) if i > start and z.startswith("export PULSE_TLS_MODE"))
    block = "\n".join(zeilen[start : ende + 1])
    skript = f"set -eu\ncat <<EOF\n{block}\nEOF\n"
    r = subprocess.run(
        ["bash", "-c", skript], env=_umgebung(PULSE_HOSTNAME="chat.example.org", PULSE_CLOUD_ORIGIN="https://howispulse.com"),
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    assert "export PULSE_INSTANCE_ID=''" in r.stdout


def test_caddy_ohne_admin_mail_hat_keine_leere_email_zeile(tmp_path):
    """Leeres ``PULSE_ADMIN_EMAIL`` ergäbe ``email`` ohne Wert — Caddy startet
    damit nicht. 09-init-caddy.sh entfernt die Zeile dann."""
    ziel = tmp_path / "Caddyfile"
    zeilen = CADDY.read_text().split("\n")
    start = next(i for i, z in enumerate(zeilen) if z.startswith("# Ohne Admin-Mail"))
    ende = next(i for i, z in enumerate(zeilen) if i > start and z == "fi")
    block = "\n".join(zeilen[start : ende + 1])
    skript = f'TARGET="{ziel}"\ncp "{TEMPLATE}" "$TARGET"\n{block}\n'
    r = subprocess.run(["bash", "-c", skript], env=_umgebung(), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    text = ziel.read_text()
    assert "email {$PULSE_ADMIN_EMAIL}" not in text
    assert "admin off" in text
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `uv run --all-packages pytest -q infra/self-host/tests/test_startpruefung.py`
Expected: FAIL (`test_nur_die_adresse_genuegt` mit Exit 1, `test_render_env_…` mit `parameter not set`, der Caddy-Test findet `# Ohne Admin-Mail` nicht).

- [ ] **Step 3: `10-check-cloud-creds.sh` neu schreiben.**

```sh
#!/bin/sh
# Startprüfung. Seit 2026-10-09 ist nur noch die Adresse Pflicht — Instanz-
# Nummer, Zugangsdaten und Besitzer-Nummer kamen aus der Freigabe, die es nicht
# mehr gibt (Spec docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md).
# Bestandsserver dürfen sie weiter setzen.
#
# Der Dateiname ist historisch und bleibt: cont-init-main.sh, install.sh und
# ältere Installer erkennen den Schritt an ihm.
set -eu

if [ -z "${PULSE_HOSTNAME:-}" ]; then
    cat >&2 <<'EOF'
[10-check-cloud-creds] FATAL: PULSE_HOSTNAME is not set.

Set it to the public address of this server, for example:

  docker run -d --name pulse -v pulse-data:/data \
    -p 80:80 -p 443:443 -p 7882-7892:7882-7892/udp -p 3478:3478 -p 3478:3478/udp \
    -p 49160-49200:49160-49200/udp -p 1936:1936/tcp -p 8189:8189/udp \
    -e PULSE_HOSTNAME=chat.example.org \
    ghcr.io/howispulse/pulse:stable

The address needs a DNS record pointing at this machine.
Easiest way: curl -fsSL https://howispulse.com/install | bash
EOF
    exit 1
fi

if ! echo "${PULSE_HOSTNAME}" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$'; then
    echo "[10-check-cloud-creds] FATAL: PULSE_HOSTNAME='${PULSE_HOSTNAME}' is not a valid DNS name" >&2
    exit 1
fi

echo "[10-check-cloud-creds] address ok (hostname=${PULSE_HOSTNAME})"
```

- [ ] **Step 4: `07-render-env.sh`.** Im Block „Self-host identity.“ jede der fünf Variablen mit `:-` absichern und die überholten Kommentare ersetzen:

```sh
# Self-host identity.
export PULSE_HOSTNAME='${PULSE_HOSTNAME}'
export PULSE_INSTANCE_MODE=self-host
# Instanz-Nummer, Besitzer-Nummer und Zugangsdaten gibt es nur bei Servern, die
# noch mit Freigabe eingerichtet wurden, und bei der Server-App (seit
# 2026-10-09). Die Dienste lesen NUR diese Datei — deshalb trotzdem hindurch-
# reichen, leer statt ungesetzt (set -u).
export PULSE_INSTANCE_ID='${PULSE_INSTANCE_ID:-}'
export PULSE_INSTANCE_OWNER_ID='${PULSE_INSTANCE_OWNER_ID:-}'
export PULSE_CLOUD_ORIGIN='${PULSE_CLOUD_ORIGIN}'
export PULSE_ADMIN_EMAIL='${PULSE_ADMIN_EMAIL:-}'
# Zugangsdaten bei der Cloud — gelesen vom direct-adapter (Heartbeat) und von
# instance_name.py (Servername). Fehlen sie, schlafen beide.
export PULSE_CLOUD_CLIENT_ID='${PULSE_CLOUD_CLIENT_ID:-}'
export PULSE_CLOUD_CLIENT_SECRET='${PULSE_CLOUD_CLIENT_SECRET:-}'
```
Prüfen, dass die Dienste mit leerer Zeichenkette umgehen: pydantic-settings liest `PULSE_INSTANCE_ID=''` als Zahl — **das scheitert** (`int('')`). Deshalb in `services/chat-gateway/src/dcc_chat_gateway/config.py` für `pulse_instance_id` und `pulse_instance_owner_id` einen Validator ergänzen, der `""` zu `0` macht:

```python
    @field_validator("pulse_instance_id", "pulse_instance_owner_id", mode="before")
    @classmethod
    def _leer_ist_null(cls, wert):
        # 07-render-env.sh reicht fehlende Werte leer durch (set -u). Leer heisst
        # „nicht gesetzt“, nicht „ungültig“.
        return 0 if wert == "" else wert
```
Dasselbe für `pulse_instance_owner_id` in `services/media-svc/src/dcc_media_svc/config.py` ist nicht nötig (dort `str`). Test dazu in `services/chat-gateway/tests/test_config.py` (anlegen, falls nicht vorhanden):

```python
from dcc_chat_gateway.config import Settings


def test_leere_instanzwerte_sind_null(monkeypatch):
    monkeypatch.setenv("PULSE_INSTANCE_ID", "")
    monkeypatch.setenv("PULSE_INSTANCE_OWNER_ID", "")
    s = Settings()
    assert s.pulse_instance_id == 0
    assert s.pulse_instance_owner_id == 0
```
(`field_validator` aus `pydantic` importieren, falls `config.py` ihn noch nicht importiert. Falls `Settings()` ohne weitere Pflichtwerte nicht baubar ist, den Test über `Settings.model_validate({"pulse_instance_id": "", "pulse_instance_owner_id": ""})` führen.)

- [ ] **Step 5: `09-init-caddy.sh`.** Direkt nach `cp "$TEMPLATE" "$TARGET"`:

```bash
# Ohne Admin-Mail: die globale `email`-Zeile entfernen. Caddy startet mit einer
# leeren `email`-Direktive nicht, und Let's Encrypt braucht keine Adresse —
# ohne sie entfallen nur die Ablauf-Warnungen per Mail (seit 2026-10-09).
if [[ -z "${PULSE_ADMIN_EMAIL:-}" ]]; then
    sed -i '/^    email {\$PULSE_ADMIN_EMAIL}$/d' "$TARGET"
fi
```
Die Meldung im `auto`-Zweig auf „Let's Encrypt Auto-TLS aktiv.“ kürzen (sie nannte `PULSE_ADMIN_EMAIL` als Voraussetzung).

- [ ] **Step 6: Tests laufen lassen.**

Run: `uv run --all-packages pytest -q infra/self-host/tests services/chat-gateway/tests/test_config.py`
Expected: PASS (inklusive `test_caddy_tls_modi.py`).

- [ ] **Step 7: Gate, Simplifier, Commit, Landen.**

```bash
bash scripts/gate.sh
git add infra/self-host/s6/etc/s6-overlay/scripts/10-check-cloud-creds.sh \
  infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh \
  infra/self-host/s6/etc/s6-overlay/scripts/09-init-caddy.sh \
  infra/self-host/tests/test_startpruefung.py \
  services/chat-gateway/src/dcc_chat_gateway/config.py services/chat-gateway/tests/test_config.py
git commit -m "feat(self-host): Container startet mit der Adresse allein

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bash scripts/ship.sh   # nach Freigabe
```

- [ ] **Step 8: Bestand prüfen.** Nach dem `allinone`-Bau holen sich die zwei per Installer eingerichteten Mietserver das Bild binnen fünf Minuten. In der App auf einem davon neu anmelden: Anmeldung klappt, der Besitzer ist Admin (Server-Einstellungen erreichbar). Die Heim-Server bekommen den Code erst mit dem nächsten Versionssprung der Server-App; sie sind abwärtskompatibel und brauchen ihn nicht.

---

## Etappe 3 — App: Einrichtungscode beim Beitreten

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/app-einrichtungscode`

### Task 3.1: Fehlercodes und Texte

**Files:**
- Modify: `web/src/lib/api/anmelde-fehler-codes.ts`
- Modify: `web/messages/de.json`, `web/messages/en.json`
- Test: `web/test/anmeldefehler.test.ts`

**Interfaces:**
- Produces: neue `Ablehnungscode`-Werte `hostname_unconfigured`, `hostname_ungueltig`, `einrichtungscode_falsch`, `einrichtungscode_gebremst`, `besitzer_vergeben`.

- [ ] **Step 1: Test erweitern.** `web/test/anmeldefehler.test.ts` prüft schon, dass jeder Code einen Schlüssel hat. Einen Test ergänzen, dass die fünf neuen Codes erkannt werden:

```ts
test('die Codes der Übernahme ohne Freigabe sind bekannt', () => {
  for (const code of [
    'hostname_unconfigured',
    'hostname_ungueltig',
    'einrichtungscode_falsch',
    'einrichtungscode_gebremst',
    'besitzer_vergeben',
  ]) {
    assert.equal(istAblehnungscode(code), true, code);
  }
});
```
(`istAblehnungscode` und `assert` sind in der Datei schon importiert; sonst ergänzen wie die vorhandenen Importe.)

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `cd web && pnpm test:unit`
Expected: FAIL bei `hostname_unconfigured`.

- [ ] **Step 3: Codes ergänzen.** In `ABLEHNUNGSCODES` nach `'instance_id_unconfigured'`:

```ts
  'hostname_unconfigured',
  'hostname_ungueltig',
  'einrichtungscode_falsch',
  'einrichtungscode_gebremst',
  'besitzer_vergeben',
```
In `MELDUNGSSCHLUESSEL`:

```ts
  hostname_unconfigured: 'anmeldung_server_ohne_adresse',
  hostname_ungueltig: 'anmeldung_adresse_ungueltig',
  einrichtungscode_falsch: 'anmeldung_einrichtungscode_falsch',
  einrichtungscode_gebremst: 'anmeldung_einrichtungscode_gebremst',
  besitzer_vergeben: 'anmeldung_besitzer_vergeben',
```

- [ ] **Step 4: Texte.** `web/messages/de.json` (am Ende, vor der schließenden Klammer):

```json
  "anmeldung_server_ohne_adresse": "Dieser Server kennt seine eigene Adresse nicht. Der Betreiber muss PULSE_HOSTNAME setzen und den Server neu starten.",
  "anmeldung_adresse_ungueltig": "Das ist keine gültige Server-Adresse. Gib sie so ein: chat.beispiel.de",
  "anmeldung_einrichtungscode_falsch": "Der Einrichtungscode stimmt nicht. Du findest ihn am Ende der Installation oder mit „docker exec pulse pulse-setup-code“.",
  "anmeldung_einrichtungscode_gebremst": "Zu viele Versuche mit dem Einrichtungscode. Warte eine Viertelstunde und versuche es dann noch einmal.",
  "anmeldung_besitzer_vergeben": "Dieser Server hat schon einen Besitzer. Lass das Feld für den Einrichtungscode leer und tritt mit einer Einladung bei.",
  "join_host_setup_code_label": "Einrichtungscode",
  "join_host_setup_code_hint": "Dieser Server hat noch keinen Besitzer. Wenn du ihn gerade installiert hast, gib den Code ein, den der Installer angezeigt hat. Wer ihn eingibt, wird Besitzer.",
  "join_host_setup_code_placeholder": "XXXX-XXXX-XXXX"
```
`web/messages/en.json`:

```json
  "anmeldung_server_ohne_adresse": "This server does not know its own address. Its operator has to set PULSE_HOSTNAME and restart it.",
  "anmeldung_adresse_ungueltig": "That is not a valid server address. Enter it like this: chat.example.org",
  "anmeldung_einrichtungscode_falsch": "The setup code is wrong. It is shown at the end of the installation, or run “docker exec pulse pulse-setup-code”.",
  "anmeldung_einrichtungscode_gebremst": "Too many attempts with the setup code. Wait a quarter of an hour, then try again.",
  "anmeldung_besitzer_vergeben": "This server already has an owner. Leave the setup code empty and join with an invite.",
  "join_host_setup_code_label": "Setup code",
  "join_host_setup_code_hint": "This server has no owner yet. If you just installed it, enter the code the installer showed. Whoever enters it becomes the owner.",
  "join_host_setup_code_placeholder": "XXXX-XXXX-XXXX"
```

- [ ] **Step 5: Tests laufen lassen.**

Run: `cd web && pnpm test:unit && pnpm check`
Expected: PASS, 0 Fehler.

- [ ] **Step 6: Commit.**

```bash
git add web/src/lib/api/anmelde-fehler-codes.ts web/messages/de.json web/messages/en.json web/test/anmeldefehler.test.ts
git commit -m "feat(web): Texte für Einrichtungscode und Server-Adresse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.2: Code durch den Beitrittsweg reichen

**Files:**
- Modify: `web/src/lib/api/server-info.ts:48-55`
- Modify: `web/src/lib/guilds/joinByHost.ts:43-45,95-122,132-142`
- Modify: `web/src/lib/api/add-server-flow.ts:74-100`
- Modify: `web/src/lib/api/server-ticket.ts:97-120`

**Interfaces:**
- Produces:
  - `ServerInfo.besitzer_offen?: boolean`
  - `HostJoinPrepared = { ok: true; hostname: string; besitzerOffen: boolean } | { ok: false; message: string }`
  - `joinServerByHost(hostname: string, code: string | undefined, confirmed: boolean, einrichtungscode?: string): Promise<void>`
  - `addServerWithCertLogin({..., einrichtungscode?: string})`
  - `loeseTicketEin(server, ticket, zugang: { communityGrantCode?: string; publicJoinHandle?: string; einrichtungscode?: string })`

- [ ] **Step 1: `server-info.ts`.** In `type ServerInfo` ergänzen:

```ts
  /** Self-Host ohne Besitzer (seit 2026-10-09): der Beitrittsdialog fragt nach
   *  dem Einrichtungscode. Ältere Server schicken das Feld nicht. */
  besitzer_offen?: boolean;
```

- [ ] **Step 2: `joinByHost.ts`.**

```ts
type HostJoinPrepared =
  | { ok: true; hostname: string; besitzerOffen: boolean }
  | { ok: false; message: string };
```
Am Ende von `prepareHostJoin`:

```ts
  return { ok: true, hostname: result.hostname, besitzerOffen: result.info.besitzer_offen === true };
```
`joinServerByHost` bekommt den vierten Parameter und reicht ihn weiter:

```ts
export async function joinServerByHost(
  hostname: string,
  code: string | undefined,
  confirmed: boolean,
  einrichtungscode?: string,
): Promise<void> {
  ...
  const { entry, invite, inviteError } = await addServerWithCertLogin({
    hostname,
    inviteCode: code,
    communityGrantCode: code,
    einrichtungscode,
  });
```

- [ ] **Step 3: `add-server-flow.ts`.** Im Argumenttyp `einrichtungscode?: string;` ergänzen und an `loeseTicketEin` übergeben:

```ts
    sitzung = await loeseTicketEin(entry, ticket, {
      communityGrantCode: args.communityGrantCode,
      publicJoinHandle: args.publicJoinHandle,
      einrichtungscode: args.einrichtungscode,
    });
```

- [ ] **Step 4: `server-ticket.ts`.** `zugang`-Typ erweitern und im Body mitschicken:

```ts
  zugang: { communityGrantCode?: string; publicJoinHandle?: string; einrichtungscode?: string } = {},
  ...
        ...(zugang.publicJoinHandle ? { public_join_handle: zugang.publicJoinHandle } : {}),
        // Nur beim ersten Beitritt zu einem Server ohne Besitzer: wer den Code
        // mitschickt, wird Besitzer (chat-gateway besitz.py).
        ...(zugang.einrichtungscode ? { einrichtungscode: zugang.einrichtungscode } : {}),
```

- [ ] **Step 5: Prüfen.**

Run: `cd web && pnpm check`
Expected: 0 Fehler (der neue Parameter ist optional, bestehende Aufrufer bleiben gültig).

- [ ] **Step 6: Commit.**

```bash
git add web/src/lib/api/server-info.ts web/src/lib/guilds/joinByHost.ts \
  web/src/lib/api/add-server-flow.ts web/src/lib/api/server-ticket.ts
git commit -m "feat(web): Einrichtungscode durch den Beitrittsweg reichen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.3: Feld im Beitrittsdialog

**Files:**
- Modify: `web/src/lib/components/JoinGuildStep.svelte`

- [ ] **Step 1: Zustand und Ablauf.** Nach `let needCode = $state(false);`:

```ts
  // Server ohne Besitzer (pulse-server-info: besitzer_offen) → Feld für den
  // Einrichtungscode. Leer lassen ist erlaubt: dann ist man ein normaler Gast,
  // und das Beitritts-Gate entscheidet wie sonst.
  let besitzerOffen = $state(false);
  let setupCode = $state('');
```
In `runHostJoin` nach `pendingHost = prep.hostname;`:

```ts
        besitzerOffen = prep.besitzerOffen;
        if (besitzerOffen && !setupCode.trim()) {
          // Erst das Feld zeigen, dann beitreten — sonst scheiterte der erste
          // Versuch am Beitritts-Gate eines Servers ohne jede Community.
          return;
        }
```
Den Aufruf erweitern:

```ts
      await joinServerByHost(
        pendingHost,
        codeInput.trim() || undefined,
        confirmed,
        setupCode.trim() || undefined,
      );
```
Im `catch` vor dem `else`-Zweig die Cloud-Codes (`ApiError` aus `holeTicket`) auf Texte abbilden:

```ts
      } else if (err instanceof ApiError && istAblehnungscode(err.message)) {
        error = anmeldeFehlerText(err.message);
```
Imports: `import { ApiError } from '$lib/api/client';` und `import { istAblehnungscode } from '$lib/api/anmelde-fehler-codes';` (Pfad von `ApiError` vorher mit `grep -n "export class ApiError" web/src/lib/api/client.ts` bestätigen). In `onInputChange` `besitzerOffen = false; setupCode = '';` ergänzen.

- [ ] **Step 2: Markup.** Nach dem `{#if needCode}…{/if}`-Block:

```svelte
  {#if besitzerOffen}
    <div class="space-y-1.5" data-testid="join-guild-setup-code-block">
      <Label for="join-guild-setup-code" class={fieldLabelClass}>
        {m.join_host_setup_code_label()}
      </Label>
      <p class="text-muted-foreground text-xs">{m.join_host_setup_code_hint()}</p>
      <Input
        id="join-guild-setup-code"
        type="text"
        bind:value={setupCode}
        autocomplete="off"
        spellcheck="false"
        placeholder={m.join_host_setup_code_placeholder()}
        data-testid="join-guild-setup-code"
      />
    </div>
  {/if}
```
Den Kopfkommentar der Komponente um eine Zeile ergänzen: „Meldet der Server `besitzer_offen`, erscheint vor dem Beitritt ein Feld für den Einrichtungscode.“

- [ ] **Step 3: Größe und Typen prüfen.**

Run: `wc -l web/src/lib/components/JoinGuildStep.svelte && cd web && pnpm check && pnpm build`
Expected: ≤ 250 Zeilen, 0 Fehler, Bau grün. Liegt die Datei über 250, den Einrichtungscode-Block als `components/server/SetupCodeField.svelte` (Props `value` gebunden über `$bindable()`) herausziehen.

- [ ] **Step 4: Im echten Browser prüfen** (Lücke laut Memory „Frontend ohne Browser-Test“). Gegen einen Server mit `besitzer_offen` gibt es bis Etappe 4 nur den Weg über den lokalen Stack: `scripts/dev-up.fish`, dann im lokalen chat-gateway `PULSE_INSTANCE_MODE=self-host`, `PULSE_HOSTNAME=localhost` geht nicht (kein FQDN). Deshalb hier nur prüfen, dass der Dialog gegen howispulse.com-Server unverändert funktioniert (Einladungscode-Beitritt), und die eigentliche Probe mit dem frischen Server in Task 4.5 machen.

- [ ] **Step 5: Commit, Changelog-Frage, Landen.**

```bash
git add web/src/lib/components/JoinGuildStep.svelte
git commit -m "feat(web): Beitrittsdialog fragt nach dem Einrichtungscode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Kein eigener Changelog-Eintrag (für Nutzer erst mit Etappe 4 bemerkbar); `scripts/check-changelog.sh` warnt nur. `bash scripts/ship.sh` nach Freigabe.

---

## Etappe 4 — Vordertür: Installer, Compose, öffentliches Paket

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/selfhost-vordertuer`

### Task 4.1: Installer ohne Token

**Files:**
- Modify: `web/static/install.sh` (Kopf 1–23, Konfiguration 25–45, Argumente 47–57, Tokenzwang 65–67, `ist_unser_container` 237–245, `write_update_script` 623–641, `jget` 577–603, Hauptablauf 957–1374)
- Modify: `web/test/install-fremder-container.test.ts:313-337`, `web/test/install-updater.test.ts:178-200,598-612`, `web/test/install-anweisungen.test.ts:378-392`, `web/test/install-eigener-container.test.ts` (neuer Test)
- Delete: `web/test/install-jget.test.ts`
- Create: `web/test/install-einrichtungscode.test.ts`
- Modify: `infra/prod/web-nginx.conf:416` (Kommentar)

**Interfaces:**
- Consumes: CLI-Ausgabe `Setup code: XXXX-XXXX-XXXX` (Task 2.5).
- Produces: Installer-Funktionen `frage_adresse`, `pruefe_adresse`, `zeige_einrichtungscode`, `pruefung_von_aussen`; Umgebungsvariablen `PULSE_HOSTNAME`, `PULSE_ADMIN_EMAIL` (optional), positionales Argument = Adresse.

- [ ] **Step 1: Failing test schreiben** (`web/test/install-einrichtungscode.test.ts`). Muster der Nachbardateien: Funktion herausschneiden, `docker` per PATH fälschen.

```ts
/**
 * Der Installer zeigt am Ende den Einrichtungscode — oder sagt ehrlich, dass
 * der Server schon einen Besitzer hat (Neuinstallation auf altem Volumen).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const quelle = readFileSync(new URL('../static/install.sh', import.meta.url), 'utf8');

function funktion(text: string, name: string): string {
  const zeilen = text.split('\n');
  const start = zeilen.findIndex((z) => z.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `${name}() fehlt`);
  const ende = zeilen.findIndex((z, i) => i > start && z === '}');
  return zeilen.slice(start, ende + 1).join('\n');
}

function lauf(dockerAusgabe: string, dockerStatus: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-code-'));
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh\nprintf '%s\\n' "${dockerAusgabe.replace(/\n/g, '\\n')}"\nexit ${dockerStatus}\n`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const skript = `
CONTAINER=pulse
SRV_HOST=chat.example.org
CLOUD_ORIGIN=https://howispulse.com
log()  { printf '%s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*"; }
${funktion(quelle, 'zeige_einrichtungscode')}
zeige_einrichtungscode
`;
  return execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

test('zeigt den Code und den Weg in die App', () => {
  const aus = lauf('Setup code: K7QM-2XDP-9HRT\nIn the Pulse app, join …', 0);
  assert.match(aus, /K7QM-2XDP-9HRT/);
  assert.match(aus, /chat\.example\.org/);
});

test('Server mit Besitzer: kein vorgetäuschter Code', () => {
  const aus = lauf('This server already has an owner (Pulse account 1).', 1);
  assert.doesNotMatch(aus, /Setup code/);
  assert.match(aus, /already has an owner/);
});
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `cd web && node --test test/install-einrichtungscode.test.ts`
Expected: FAIL mit `zeige_einrichtungscode() fehlt`.

- [ ] **Step 3: Kopf, Konfiguration, Argumente.** Kopfkommentar (Zeilen 1–23) auf die neue Benutzung:

```bash
#!/usr/bin/env bash
# Pulse Self-Host — Installer.
#
#   curl -fsSL https://howispulse.com/install | bash
#   curl -fsSL https://howispulse.com/install | PULSE_HOSTNAME=chat.example.org bash
#
# Fragt nach der Adresse des Servers (oder nimmt PULSE_HOSTNAME bzw. das erste
# Argument), startet den Container und zeigt am Ende den Einrichtungscode. Wer
# ihn beim ersten Beitritt in der Pulse-App eingibt, wird Besitzer.
# Seit 2026-10-09 ohne Antrag und ohne Token
# (docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md).
```
Zeile 27: `IMAGE="${PULSE_IMAGE:-ghcr.io/howispulse/pulse:stable}"`. Argumente (47–57) ersetzen:

```bash
# --- Args ---------------------------------------------------------------- #
DRY_RUN=""
SRV_HOST="${PULSE_HOSTNAME:-}"
ADMIN_EMAIL="${PULSE_ADMIN_EMAIL:-}"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --*) ;;                       # unbekannte Flags ignorieren
    *) [ -z "$SRV_HOST" ] && SRV_HOST="$arg" ;;
  esac
done
```
Den Tokenzwang (65–67) ersetzen durch die beiden Funktionen und den Hinweis für alte Befehle:

```bash
if [ -n "${PULSE_BOOTSTRAP_TOKEN:-}" ]; then
  warn "Setup tokens are no longer needed — ignoring PULSE_BOOTSTRAP_TOKEN."
fi

# Die Adresse kommt aus PULSE_HOSTNAME, dem ersten Argument oder einer Frage am
# Terminal. Bei `curl … | bash` ist stdin die Pipe — deshalb /dev/tty.
frage_adresse() {
  [ -n "$SRV_HOST" ] && return 0
  if { : </dev/tty; } 2>/dev/null; then
    printf '  Address of this server (e.g. chat.example.org): ' >/dev/tty
    read -r SRV_HOST </dev/tty || true
  fi
  [ -n "$SRV_HOST" ] || die "No server address given.
  Usage: curl -fsSL ${CLOUD_ORIGIN}/install | PULSE_HOSTNAME=chat.example.org bash
  The address needs a DNS record pointing at this machine."
}

# Dieselbe Form wie dcc_shared.hostname.normalisiere_hostname — sonst nähme die
# Cloud eine Adresse an, die der Container beim Start ablehnt, oder umgekehrt.
pruefe_adresse() {
  SRV_HOST="$(printf '%s' "$SRV_HOST" | tr 'A-Z' 'a-z' \
    | sed -e 's#^[a-z]*://##' -e 's#[/:].*$##' -e 's#\.$##')"
  printf '%s' "$SRV_HOST" \
    | grep -qE '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$' \
    || die "'${SRV_HOST}' is not a valid server address (expected something like chat.example.org)."
}
```

- [ ] **Step 4: Eigenen Container auch unter dem neuen Bildnamen erkennen.** In `ist_unser_container` (237–245) das Muster ergänzen, sodass `*pulse-allinone*` **und** `*howispulse/pulse*` als unser Container gelten. Test in `install-eigener-container.test.ts` nach dem Muster des Falls in Zeile 173 hinzufügen, mit `image: 'ghcr.io/howispulse/pulse:stable'` und derselben Erwartung.

- [ ] **Step 5: Updater ohne eingebackene Zugangsdaten.** In `write_update_script` den `case "$IMAGE" in registry.howispulse.com/*) … esac`-Block (Zeilen ~630–641) löschen. Der `if [ -n "${REG_PASS:-}" ]`-Zweig im erzeugten Skript bleibt (er ist ohne `REG_PASS` wirkungslos). `jget` (577–603) löschen — einziger Nutzer war die Token-Einlösung — und `web/test/install-jget.test.ts` entfernen.

- [ ] **Step 6: Hauptablauf.** Vor `decide_mode` (Zeile ~963) die Platzhalterzeile `SRV_HOST="<hostname>"; ADMIN_EMAIL=""` ersetzen durch:

```bash
frage_adresse
pruefe_adresse
log "Server address: ${SRV_HOST}"
```
Texte anpassen: `pruefe_container_konflikt "Your setup token is still valid — nothing has been consumed yet."` → `pruefe_container_konflikt "Nothing was changed."`; `log "DRY RUN — nothing changed, no token consumed."` → `log "DRY RUN — nothing changed."`; die übrigen in der Inventur genannten Token-Erwähnungen (Zeilen 130–133, 149–152, 283, 316–322, 407–409, 412–415, 456–459) auf „Nothing was changed.“ bzw. ohne Token-Satz kürzen — `grep -n -i "token" web/static/install.sh` darf danach nur noch die `PULSE_BOOTSTRAP_TOKEN`-Warnung und Relay-/Tunnel-Stellen zeigen.

Die Token-Einlösung (993–1013) ersatzlos löschen; der zweite `build_run_args`-Aufruf entfällt (die Adresse steht jetzt vorher fest). `pulse.env` (1015–1032):

```bash
# 2) Config schreiben (chmod 600).
mkdir -p "$PULSE_DIR"
( umask 077
  {
    printf 'PULSE_HOSTNAME=%s\n' "$SRV_HOST"
    printf 'PULSE_INSTANCE_MODE=self-host\n'
    printf 'PULSE_CLOUD_ORIGIN=%s\n' "$CLOUD_ORIGIN"
    [ -n "$ADMIN_EMAIL" ] && printf 'PULSE_ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL"
    printf 'PULSE_TLS_MODE=%s\n' "$TLS_MODE"
    printf 'PULSE_HTTP_PORT=%s\n' "$HTTP_PORT"
  } > "$ENV_FILE"
)
chmod 600 "$ENV_FILE"
log "Configuration written: ${ENV_FILE} (readable by root only)"
```
Start (1034–1045): den `case "$IMAGE" in registry.howispulse.com/*) … esac`-Login-Block löschen; `docker pull` und `docker run` bleiben.

- [ ] **Step 7: Code anzeigen und Prüfung von außen.** `PY_BERICHT` (1224–1312) und das alte `pruefung_von_aussen` (1321–1343) ersetzen durch:

```bash
# Der Einrichtungscode — oder die ehrliche Auskunft, dass es schon einen
# Besitzer gibt (Neuinstallation auf altem Volumen). Die erste Zeile der
# CLI-Ausgabe lautet „Setup code: …“ (dcc_chat_gateway/einrichtungscode.py).
zeige_einrichtungscode() {
  local aus code
  aus="$(docker exec "$CONTAINER" pulse-setup-code 2>/dev/null || true)"
  code="$(printf '%s\n' "$aus" | sed -n 's/^Setup code: //p' | head -n1)"
  if [ -z "$code" ]; then
    printf '%s\n' "$aus" | sed -n '1,3p' | while IFS= read -r z; do warn "$z"; done
    return 0
  fi
  log "Become the owner of your server:"
  log "  1. Open Pulse (${CLOUD_ORIGIN}/app) and sign in."
  log "  2. Choose \"Join a community\" and enter: ${SRV_HOST}"
  log "  3. Enter this setup code when asked:   ${code}"
  log "Show the code again any time:  docker exec ${CONTAINER} pulse-setup-code"
}

# Antwortet der Server unter seiner Adresse? Das prüft DNS, Port 443 und das
# Zertifikat in einem Abruf. Die Medien-Ports (UDP) prüft es nicht — dafür
# gibt es pulse-doctor im Container. Die frühere Cloud-Prüfung brauchte
# Zugangsdaten, die ein Server ohne Freigabe nicht hat (Spec E11).
pruefung_von_aussen() {
  curl -fsS -m 20 "https://${SRV_HOST}/.well-known/pulse-server-info" >/dev/null 2>&1
}
```
Im Schlussteil (vorher 1336–1343):

```bash
log "Checking that your server answers under https://${SRV_HOST} …"
if pruefung_von_aussen; then
  log "Your server answers under https://${SRV_HOST}."
else
  warn "Your server does not answer under https://${SRV_HOST} yet."
  warn "Check that the DNS record points at this machine and ports 80/443 are open."
  warn "Details:  docker exec $CONTAINER pulse-doctor"
fi
zeige_einrichtungscode
```
In den Proxy-Modi (`static-docker`, `hostproxy`) steht die Proxy-Regel womöglich noch nicht; die Warnung ist dann richtig und genügt.

- [ ] **Step 8: Bestehende Tests nachziehen.**
  - `install-fremder-container.test.ts`: Zeile 324 `TOKEN=testtoken` löschen; Zeile 337 Anker `'log "Instance: ${SRV_HOST} (ID ${INSTANCE_ID})"'` → `'log "Server address: ${SRV_HOST}"'` und davor `SRV_HOST=chat.example.org` setzen sowie `${funktion(quelle, 'frage_adresse')}` und `${funktion(quelle, 'pruefe_adresse')}` einfügen; die Zeile `${funktion(quelle, 'jget')}` löschen.
  - `install-updater.test.ts` (184–197, 598–612) und `install-anweisungen.test.ts` (378–392): `CLIENT_ID=…`/`CLIENT_SECRET=…` und die Kommentare zum Registry-Zweig entfernen. Einen Test ergänzen, dass der erzeugte Updater kein `REG_USER` enthält: erzeugtes Skript lesen, `assert.doesNotMatch(inhalt, /REG_USER=/)`.
  - `install-schluss-reihenfolge.test.ts`: die Prüfung `stdout.includes('DRY RUN — nothing changed')` bleibt gültig; nichts zu tun, außer der Lauf verlangt jetzt `SRV_HOST` — dann `SRV_HOST=chat.example.org` in das Testskript.
  - `install-erststart-absturzschleife.test.ts`: Anker prüfen (`if [ -n "$ABBRUCH_CRASH" ]; then`, `Startup is taking longer than expected`) — unverändert.

- [ ] **Step 9: Alle Installer-Tests.**

Run: `cd web && pnpm test:unit`
Expected: PASS. Zusätzlich `bash -n web/static/install.sh` → keine Ausgabe.

- [ ] **Step 10: nginx-Kommentar.** `infra/prod/web-nginx.conf:416` von `bash -s -- <TOKEN>` auf `curl -fsSL https://howispulse.com/install | bash`.

- [ ] **Step 11: Commit.**

```bash
git add web/static/install.sh web/test/install-*.test.ts infra/prod/web-nginx.conf
git rm web/test/install-jget.test.ts
git commit -m "feat(self-host): Installer ohne Token, zeigt den Einrichtungscode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.2: Compose-Dateien, Beispielkonfiguration, Update-Skript

**Files:**
- Modify: `infra/self-host/docker-compose.yml:1-49`
- Modify: `infra/self-host/docker-compose.behind-proxy.yml:1-53`
- Modify: `infra/self-host/.env.example:1-45`
- Modify: `infra/self-host/pulse-update.sh:49-56`
- Test: `infra/self-host/tests/pulse-update-faelle.sh` (läuft im Gate)

- [ ] **Step 1: `docker-compose.yml`, Kopf (Zeilen 3–18) ersetzen.**

```yaml
# Pulse Self-Host — Docker Compose.
#
#   1. Put this file in an empty directory and create a file named .env next
#      to it with one line — the public address of your server:
#
#        PULSE_HOSTNAME=chat.example.org
#
#      The address needs a DNS record pointing at this machine.
#
#   2. docker compose up -d
#
#   3. Show the setup code and enter it in the Pulse app when you join
#      chat.example.org — whoever enters it becomes the owner:
#
#        docker exec pulse pulse-setup-code
```
Zeile 49 und der Kommentar darüber:

```yaml
    # Public image, no login needed.
    image: ghcr.io/howispulse/pulse:stable
```
`behind-proxy.yml` gleich (Schritt 1–3 identisch; Startbefehl `docker compose -f docker-compose.behind-proxy.yml up -d`; Proxy-Schritt bleibt).

- [ ] **Step 2: `.env.example`, Pflichtteil (1–45) ersetzen.**

```
# Pulse Self-Host — Umgebungsvariablen
# Pflicht ist nur PULSE_HOSTNAME. Alles andere hat sichere Vorgaben.

# [PFLICHT] Die öffentliche Adresse deines Servers — braucht einen DNS-Eintrag
# auf diese Maschine. Caddy holt dafür das Let's-Encrypt-Zertifikat.
PULSE_HOSTNAME=chat.firma.de

# [OPTIONAL] Mail-Adresse für Let's Encrypt (Warnungen vor Zertifikatsablauf).
# Ohne sie läuft alles genauso, nur ohne diese Mails.
#PULSE_ADMIN_EMAIL=admin@firma.de

# Besitzer: wird beim ersten Beitritt mit dem Einrichtungscode bestimmt
# (`docker exec pulse pulse-setup-code`). Server, die noch mit Freigabe
# eingerichtet wurden, tragen stattdessen PULSE_INSTANCE_ID,
# PULSE_INSTANCE_OWNER_ID und PULSE_CLOUD_CLIENT_ID/SECRET — die bleiben gültig.
```

- [ ] **Step 3: `pulse-update.sh` (49–56).** Der Login bleibt für Bestandsinstallationen (ihre Compose-Datei zeigt auf `registry.howispulse.com`); nur der Kommentar ändert sich:

```bash
# Registry-Login nur für Installationen aus der Freigabe-Zeit: ihre Compose-
# Datei zieht von registry.howispulse.com, und die .env trägt die Zugangsdaten.
# Neue Installationen ziehen das öffentliche Bild von GHCR ohne Login.
```

- [ ] **Step 4: Prüfen.**

Run: `bash infra/self-host/tests/pulse-update-faelle.sh && docker compose -f infra/self-host/docker-compose.yml config >/dev/null 2>&1; echo $?`
Expected: Fälle grün; `config` ohne `.env` endet mit Fehler 1 wegen fehlender `.env` — mit `printf 'PULSE_HOSTNAME=chat.example.org\n' > /tmp/claude-1000/pulse-env-probe && docker compose --env-file /tmp/claude-1000/pulse-env-probe -f infra/self-host/docker-compose.yml config >/dev/null; echo $?` → `0` (Pfad im Scratchpad wählen).

- [ ] **Step 5: Commit.**

```bash
git add infra/self-host/docker-compose.yml infra/self-host/docker-compose.behind-proxy.yml \
  infra/self-host/.env.example infra/self-host/pulse-update.sh
git commit -m "feat(self-host): Compose ohne Login und ohne Cloud-Werte

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.3: App — Installationskarte statt Antrag

**Files:**
- Create: `web/src/lib/components/selfhost/SelfHostInstallCard.svelte`
- Modify: `web/src/lib/components/selfhost/SelfHostPanel.svelte`
- Modify: `web/src/lib/components/account/MyInstances.svelte:24-46,76-77,159-193`
- Modify: `web/src/lib/selfhost/hinweis.svelte.ts`, `SelfHostRailButton.svelte:47-53`, `SelfHostRoomsButton.svelte:39-45`
- Modify: `web/src/routes/app/+layout.svelte:24,279-281,289-291,364`, `web/src/lib/stores/auth.svelte.ts:318-326,449-457`, `web/src/lib/ws/handlers/admin.ts:15,25-27`
- Delete: `web/src/lib/components/account/SelfHostApplication.svelte`, `web/src/lib/stores/myInstanceApplications.svelte.ts`, `web/src/lib/components/account/setup/{InstanceSetupPanel,SetupSchnellweg,SetupManuell}.svelte`, `web/src/lib/components/account/InlineResetPanel.svelte`
- Modify: `web/messages/de.json`, `web/messages/en.json`
- Test: `web/test/selfhost-einstieg-gating.test.ts`, `web/tests/e2e/heim-server.spec.ts:63-72`

- [ ] **Step 1: Texte.** `de.json`:

```json
  "self_host_server_title_frei": "Eigener Server",
  "self_host_install_intro": "Auf jedem Linux-Rechner mit Docker und einer eigenen Adresse. Keine Anmeldung nötig — wer den Einrichtungscode beim ersten Beitritt eingibt, wird Besitzer.",
  "self_host_install_command_label": "Installieren mit einem Befehl",
  "self_host_install_copy": "Kopieren",
  "self_host_install_copied": "Kopiert",
  "self_host_install_guide": "Ausführliche Anleitung",
  "my_instances_empty_frei": "Server, die du über einen Antrag eingerichtet hast, erscheinen hier.",
  "my_instances_status_active_frei": "Aktiv"
```
`en.json`:

```json
  "self_host_server_title_frei": "Your own server",
  "self_host_install_intro": "On any Linux machine with Docker and its own address. No sign-up needed — whoever enters the setup code when first joining becomes the owner.",
  "self_host_install_command_label": "Install with one command",
  "self_host_install_copy": "Copy",
  "self_host_install_copied": "Copied",
  "self_host_install_guide": "Detailed guide",
  "my_instances_empty_frei": "Servers you set up through an application appear here.",
  "my_instances_status_active_frei": "Active"
```

- [ ] **Step 2: `SelfHostInstallCard.svelte`.**

```svelte
<!--
  Installationskarte für einen eigenen Server (seit 2026-10-09 ohne Antrag):
  der Ein-Zeilen-Befehl, die Compose-Dateien und die Anleitung. Alles hier ist
  für jeden gleich und enthält kein Geheimnis — deshalb statisch, ohne API.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import ComposeDownloadLinks from '$lib/components/account/ComposeDownloadLinks.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let base = $derived(
    typeof location !== 'undefined' ? location.origin : 'https://howispulse.com'
  );
  let command = $derived(`curl -fsSL ${base}/install | bash`);
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Zwischenablage verweigert (ältere WebView) — der Befehl steht markierbar da.
    }
  }
</script>

<div class="flex flex-col gap-3" data-testid="self-host-install-card">
  <p class="text-text-base text-xs">{m.self_host_install_intro()}</p>
  <div class="flex flex-col gap-1.5">
    <span class="text-text-muted text-xs font-semibold">{m.self_host_install_command_label()}</span>
    <div class="flex items-center gap-2">
      <code
        class="bg-bg-input text-text-bright min-w-0 flex-1 overflow-x-auto rounded-md px-2 py-1.5 font-mono text-xs select-all"
        data-testid="self-host-install-command">{command}</code
      >
      <Button size="xs" variant="outline" onclick={copy} data-testid="self-host-install-copy">
        {copied ? m.self_host_install_copied() : m.self_host_install_copy()}
      </Button>
    </div>
  </div>
  <ComposeDownloadLinks {base} />
  <a class="text-primary text-xs underline" href={`${base}/self-host/guide`} target="_blank" rel="noopener">
    {m.self_host_install_guide()}
  </a>
</div>
```
Den Kopfkommentar von `ComposeDownloadLinks.svelte` anpassen: der Satz „Nur die `.env` daneben ist personalisiert …“ entfällt; stattdessen „Seit 2026-10-09 gibt es keine personalisierte `.env` mehr; die einzige Pflichtzeile schreibt der Betreiber selbst.“

- [ ] **Step 3: `SelfHostPanel.svelte`.** Import `SelfHostApplication` durch `SelfHostInstallCard` ersetzen; im Snippet `serverBody` `<SelfHostApplication />` → `<SelfHostInstallCard />`; Titel `m.self_host_server_title()` → `m.self_host_server_title_frei()`.

- [ ] **Step 4: `MyInstances.svelte` entschlacken.** Entfernen: Import und Aufruf `myInstanceApplications` (24, 76–77), Import `InstanceSetupPanel` (25), `TerminalIcon`/`ChevronDownIcon` (32–33), Zustand `offeneEinrichtung` samt `einrichtungUmschalten` (38–46), den Einrichten-Knopf (159–177) und das ausklappbare Panel (189–193). Den Leertext auf `m.my_instances_empty_frei()` und die Statuspille auf `m.my_instances_status_active_frei()` umstellen. Diagnose, Löschen und Liste bleiben.

- [ ] **Step 5: Roten Punkt und Antragsbeobachtung entfernen.**
  - `hinweis.svelte.ts`: `selfHostHinweisOffen` und den Import von `myInstanceApplications` löschen; `selfHostEinstiegSichtbar` bleibt (Test `selfhost-einstieg-gating.test.ts` liest ihn).
  - `SelfHostRailButton.svelte` (47–53) und `SelfHostRoomsButton.svelte` (39–45): `let hinweis …` und den `{#if hinweis}`-Block löschen.
  - `routes/app/+layout.svelte`: Import (24), `myInstanceApplications.start()` samt Kommentar (279–281), verwaister Kommentar (289–291), `myInstanceApplications.stop()` (364).
  - `stores/auth.svelte.ts`: beide `import('$lib/stores/myInstanceApplications.svelte')…reset()`-Blöcke samt Kommentaren (318–326, 449–457).
  - `ws/handlers/admin.ts`: Import (15) und den `application_decided`-Handler (25–27).

- [ ] **Step 6: Dateien löschen.**

```bash
git rm web/src/lib/components/account/SelfHostApplication.svelte \
  web/src/lib/stores/myInstanceApplications.svelte.ts \
  web/src/lib/components/account/setup/InstanceSetupPanel.svelte \
  web/src/lib/components/account/setup/SetupSchnellweg.svelte \
  web/src/lib/components/account/setup/SetupManuell.svelte \
  web/src/lib/components/account/InlineResetPanel.svelte
grep -rn "myInstanceApplications\|SelfHostApplication\|InstanceSetupPanel\|SetupSchnellweg\|SetupManuell\|InlineResetPanel" web/src
```
Expected: keine Treffer. Die Funktionen `submitApplication`, `listMyApplications`, `mintBootstrapToken`, `downloadEnvFile` in `api/instances.ts` werden damit im Web unbenutzt; sie fallen in Task 5.1.

- [ ] **Step 7: E2E-Test anpassen.** `web/tests/e2e/heim-server.spec.ts` Test 2 „Antragsformular: nur noch VPS…“ (63–72) ersetzen durch:

```ts
test('Eigener Server: Installationsbefehl ohne Token', async ({ page }) => {
  await oeffneServerPanel(page);
  const befehl = page.getByTestId('self-host-install-command');
  await expect(befehl).toBeVisible();
  await expect(befehl).toHaveText(/\/install \| bash$/);
  await expect(page.getByTestId('self-host-application')).toHaveCount(0);
});
```

- [ ] **Step 8: Prüfen.**

Run: `cd web && pnpm check && pnpm build && pnpm test:unit && bash ../scripts/geraete-trennung.sh`
Expected: 0 Fehler, Bau grün, Unit-Tests grün, Gate der Geräte-Trennung grün. Playwright für die geänderte Datei: `pnpm exec playwright test tests/e2e/heim-server.spec.ts tests/e2e/selfhost-einstieg.spec.ts` → grün.

- [ ] **Step 9: Commit.**

```bash
git add -A web/src web/messages web/tests/e2e/heim-server.spec.ts
git commit -m "feat(web): Eigener Server mit Installationsbefehl statt Antrag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.4: Anleitungen für Betreiber

**Files:**
- Modify: `docs/self-host-guide.html` (506–560, 563–903, 1010–1020, 1065)
- Modify: `infra/self-host/README.md` (1–26, 43–104, 144–166)
- Modify: `docs/selfhost-erreichbarkeit.md:9,16-19,24`

- [ ] **Step 1: `docs/self-host-guide.html`.**
  - `#requirements` (510–512): die Zeile „An approved instance … apply … wait for approval“ ersetzen durch „A domain name with a DNS record pointing at your machine.“ Die Porttabelle (520–534) um die Zeile `49160–49200/udp — TURN relay` ergänzen (fehlte schon vorher).
  - `#installer` (549–560): Befehl `curl -fsSL https://howispulse.com/install | bash`; Absatz: „The installer asks for your server's address, starts it and shows a setup code. Open Pulse, choose “Join a community”, enter your address and the setup code — you are now the owner.“
  - `#choose` beide Varianten: Schritte „01 Download the .env“ und „03 Sign in to the registry“ entfernen, neuer Schritt 01 „Create a .env with one line: `PULSE_HOSTNAME=chat.example.org`“, Nummerierung nachziehen; im letzten Schritt „Verify and sign in“ den Verweis auf „My Instances“ durch den Einrichtungscode-Weg ersetzen (`docker exec pulse pulse-setup-code`).
  - `#trouble` „Not admin on your own server“ (1010–1020): neuer Text: „The account that entered the setup code is the owner. To hand the server to someone else, run `docker exec pulse pulse-setup-code --reset` and let them join with the new code. Servers set up before October 2026 keep using `PULSE_INSTANCE_OWNER_ID`.“ Den dort zitierten `grep`-Befehl auf die neue Logzeile `no owner yet` umstellen (Regel aus `owner_admin_log.py`).
  - `#uninstall` (1065): „delete the instance in the app under My Instances“ nur noch für Server aus der Freigabe-Zeit erwähnen.

- [ ] **Step 2: `infra/self-host/README.md`.** Abschnitt „Two registries“ (13–26) ersetzen: öffentliches Bild `ghcr.io/howispulse/pulse`, Spiegel `registry.howispulse.com/pulse-allinone` nur noch für Bestandsinstallationen mit Zugangsdaten. „Run“-Abschnitte (43–104): nur `PULSE_HOSTNAME` Pflicht, kein `docker login`, Einrichtungscode. „Auto-update“ (163): Zugangsdaten nur bei Bestandsinstallationen.

- [ ] **Step 3: `docs/selfhost-erreichbarkeit.md`.** Zeile 9 ergänzen: „Nur für Server mit Eintrag aus der Freigabe-Zeit; neue Server prüft der Installer per Abruf von `/.well-known/pulse-server-info` und `pulse-doctor` (Spec E11).“ Zeilen 16–19: „vergleicht gegen den Besitzer aus `besitz.besitzer_kennung` (Umgebung oder Einrichtungscode)“. Zeile 24: „Der Installer prüft alle Ports, bevor er etwas verändert.“

- [ ] **Step 4: Prüfen, dass nichts Altes stehen bleibt.**

Run: `grep -n -i "bootstrap token\|PULSE_BOOTSTRAP_TOKEN\|wait for approval\|Download the .env\|docker login registry" docs/self-host-guide.html infra/self-host/README.md infra/self-host/docker-compose*.yml`
Expected: keine Treffer außer ausdrücklich als „vor Oktober 2026“ gekennzeichnete Stellen.

- [ ] **Step 5: Commit.**

```bash
git add docs/self-host-guide.html infra/self-host/README.md docs/selfhost-erreichbarkeit.md
git commit -m "docs(self-host): Anleitung ohne Antrag und ohne Zugangsdaten

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.5: Changelog, Paket öffentlich, Probe auf einem frischen Server

- [ ] **Step 1: Changelog-Eintrag.** Dem Eigentümer drei Vorschläge im Stil „Sachlich“ vorlegen und den gewählten oben in `web/static/changelog.json` eintragen (`id` = Datum des Landens, keine Emojis, echte Umlaute). Inhalt: „Eigenen Server ohne Antrag einrichten“; Installation mit einem Befehl; wer den Einrichtungscode beim ersten Beitritt eingibt, wird Besitzer; bestehende Server laufen unverändert weiter.

- [ ] **Step 2: Gate und Landen (nach Freigabe).**

```bash
bash scripts/gate.sh
git add web/static/changelog.json
git commit -m "chore: Changelog — eigener Server ohne Antrag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bash scripts/ship.sh
```

- [ ] **Step 3: Paket öffentlich stellen (Eigentümer, im Browser).** github.com/orgs/howispulse/packages → `pulse` → *Package settings* → *Change visibility* → *Public*. **Endgültig** — GitHub lässt das nicht zurücknehmen. Danach prüfen:

Run: `curl -s -o /dev/null -w "%{http_code}\n" "https://ghcr.io/token?scope=repository:howispulse/pulse:pull"`
Expected: `200`. Die Cloud-Pakete (`pulse-auth` usw.) bleiben privat: dieselbe Abfrage für `howispulse/pulse-auth` → `401`.

- [ ] **Step 4: Probe auf einem frischen Server.** Auf einer Wegwerf-VM (nicht dem Hetzner — die Kiste ist eng und teilt sich Dienste) mit Docker und einem DNS-Eintrag, z. B. `probe.<eigene-domain>`:

```bash
curl -fsSL https://howispulse.com/install | PULSE_HOSTNAME=probe.example.org bash
```
Expected: kein `docker login`, Bild von `ghcr.io/howispulse/pulse`, am Ende „Your server answers …“ und ein Einrichtungscode. Dann in der App (Browser **und** Electron): „Community beitreten“ → `probe.example.org` → Feld „Einrichtungscode“ erscheint → Code eingeben → man landet als Admin auf dem Server, kann eine Community anlegen. Ein zweites Konto tritt über eine Einladung dieser Community bei. In der Cloud-Admin-Liste erscheint `probe.example.org` mit „(ohne Freigabe)“. Zum Schluss `docker exec pulse pulse-setup-code` → „already has an owner“.

- [ ] **Step 5: Probe-VM abbauen.** Den Eintrag in der Cloud-Admin-Liste sperren oder stehen lassen (er schadet nicht; er belegt nur den Hostnamen der Probe).

---

## Etappe 5 — Aufräumen

Zweig: `git checkout main && git pull --ff-only && git checkout -b chore/freigabe-aufraeumen`

### Task 5.1: Freigabe-Oberfläche im Admin-Bereich

**Files:**
- Modify: `web/src/routes/app/admin/+page.svelte:53-61,66-68,79-84,101-113,186-190`
- Modify: `web/src/lib/components/admin/AdminInstances.svelte`
- Modify: `web/src/lib/components/admin/AdminInstancesActive.svelte:49-69,…`
- Modify: `web/src/lib/components/admin/AdminInstancesSuspended.svelte:28-30`
- Modify: `web/src/lib/components/admin/ServerAdminButton.svelte:18-19,37-43`
- Modify: `web/src/lib/components/admin/AdminUserRow.svelte:21,78-85,127-133`, `AdminUsers.svelte:25,40,98-109`, `web/src/lib/api/admin.ts:289`
- Modify: `web/src/lib/ws/handlers/index.ts:27,53`; `web/src/lib/api/instances.ts`
- Delete: `AdminInstancesPending.svelte`, `AdminAppHostRevoke.svelte`, `web/src/lib/stores/pendingInstanceApps.svelte.ts`, `web/src/lib/stores/pendingAppHostApplications.svelte.ts`, `web/src/lib/ws/handlers/admin.ts`
- Modify: `web/messages/de.json`, `web/messages/en.json`
- Test: `web/tests/e2e/admin.spec.ts:139-153`

- [ ] **Step 1: Texte.** `de.json`: `"admin_tab_servers": "Server"`, `"admin_instances_description_frei": "Alle Server, die die Cloud kennt — freigegebene und solche ohne Freigabe. Sperren wirkt sofort für neue Anmeldungen."`, `"admin_instances_ohne_freigabe": "ohne Freigabe"`. `en.json`: `"admin_tab_servers": "Servers"`, `"admin_instances_description_frei": "All servers the cloud knows — approved ones and those without approval. Suspending takes effect for new sign-ins immediately."`, `"admin_instances_ohne_freigabe": "no approval"`.

- [ ] **Step 2: Admin-Seite.** Die Tab-ID `applications` bleibt (E2E und gespeicherte Auswahl hängen daran), das Label wird `m.admin_tab_servers()`, das Badge entfällt (`badge` weglassen); `instancesPending`, `applicationsBadge` und der `listApplications`-`try`-Block in `refreshBadges()` werden gelöscht.

- [ ] **Step 3: `AdminInstances.svelte`.** Tab `pending` und alles zum Zählen (`pendingCount`, `refreshPendingCount`, `onMount`, Heading-Badge, `badgeTab`/`badgeCount`) löschen; Vorgabetab `'active'`; Beschreibung `m.admin_instances_description_frei()`.

- [ ] **Step 4: `AdminInstancesActive.svelte`.** Den `listApplications('approved','app_host')`-Aufruf, `grantByInstance` und `AdminAppHostRevoke` entfernen. Neben dem Hostnamen bei `inst.ohne_freigabe` einen Chip `m.admin_instances_ohne_freigabe()` zeigen (gleiche Klassen wie der vorhandene Origin-Chip).

- [ ] **Step 5: `AdminInstancesSuspended.svelte`.** Den Filter `.filter((i) => i.origin !== 'app_host')` und seinen Kommentar entfernen — gesperrte Heim-Server waren bisher unsichtbar, weil ihr Reiter nicht mehr existiert.

- [ ] **Step 6: Badge-Summe, Benutzerliste, Stores, WS-Handler.**
  - `ServerAdminButton.svelte`: `alertCount` = nur `pendingComplaints.count`; Importe der zwei Stores weg.
  - `AdminUserRow.svelte`/`AdminUsers.svelte`/`api/admin.ts`: Selbsthost-Badge, Umschalter und Filter `self_host` entfernen; `Field` = `'is_admin' | 'disabled'`. Das Feld `self_host_enabled` im Typ `AdminUser` bleibt (der Server liefert es weiter).
  - `ws/handlers/index.ts`: Import und `admin.register()` löschen.

- [ ] **Step 7: `api/instances.ts` aufräumen.** Löschen: `InstanceApplication`, `AdminApplication`, `Approval`, `AppHostApproval`, `BootstrapToken`, `ApplicationStatus`, `ApplicationOrigin`, `NetworkCheck`, `submitApplication`, `listMyApplications`, `mintBootstrapToken`, `downloadEnvFile`, `listApplications`, `approveApplication`, `rejectApplication`, `revokeAppHostApplication`. Vorher je Name `grep -rn "<name>" web/src desktop/electron` → nur die Definition darf übrig sein (die Server-App ruft die Routen über eigene `netJson`-Aufrufe, nicht über diese Datei).

- [ ] **Step 8: Löschen, prüfen.**

```bash
git rm web/src/lib/components/admin/AdminInstancesPending.svelte \
  web/src/lib/components/admin/AdminAppHostRevoke.svelte \
  web/src/lib/stores/pendingInstanceApps.svelte.ts \
  web/src/lib/stores/pendingAppHostApplications.svelte.ts \
  web/src/lib/ws/handlers/admin.ts
cd web && pnpm check && pnpm build && pnpm test:unit && pnpm exec playwright test tests/e2e/admin.spec.ts
```
Expected: alles grün; `admin.spec.ts` klickt den Tab `admin-tab-applications` und findet `admin-instances` weiterhin.

- [ ] **Step 9: Commit.**

```bash
git add -A web/src web/messages
git commit -m "chore(web): Freigabe-Oberfläche im Admin-Bereich entfernt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.2: Antrags- und Freigabe-Routen im auth-svc

**Files:**
- Delete: `services/auth/src/dcc_auth/routes_applications.py`, `services/auth/src/dcc_auth/routes_admin_applications.py`
- Modify: `services/auth/src/dcc_auth/app.py:24,28` (+ `include_router`-Zeilen)
- Modify: `services/auth/src/dcc_auth/routes_instance_applications.py:72-106,353-455` (env-file-Route und `_require_self_host_enabled`)
- Modify: `services/auth/src/dcc_auth/admin_events.py:48-75`
- Delete/Modify Tests: `services/auth/tests/test_unified_applications.py`, `test_admin_app_host.py`, `test_self_host_gate.py`, Antrags-/env-file-Teile von `test_instance_applications_me.py` und `test_admin_instances.py`

- [ ] **Step 1: Verbraucher prüfen.**

```bash
grep -rn "instance-applications\|env-file\|routes_applications\|routes_admin_applications\|publish_application" \
  services web/src desktop/electron infra --include='*.py' --include='*.ts' --include='*.svelte' --include='*.sh' \
  | grep -v "/tests/"
```
Expected: nur die zu löschenden Dateien, `app.py` und `admin_events.py`. Steht dort noch etwas aus `desktop/electron`, **anhalten** und die Server-App-Abhängigkeit klären.

- [ ] **Step 2: Löschen und ausklinken.** Die zwei Routen-Dateien löschen, ihre Importe und `include_router`-Aufrufe in `app.py` entfernen. In `routes_instance_applications.py` die Route `POST /me/instances/{id}/env-file` samt Helfern (`generate_env_file`, `ReissueIn`, falls nur dort benutzt) und `_require_self_host_enabled` löschen; `instance_env_file.py` löschen, wenn danach unbenutzt (`grep -rn instance_env_file services`). In `admin_events.py` `publish_application_pending`/`publish_application_decided` löschen. Die Datei `routes_instance_applications.py` liegt danach unter der harten Grenze von 500 Zeilen (vorher 524).

- [ ] **Step 3: Tests nachziehen.** Löschen: `test_unified_applications.py`, `test_admin_app_host.py`, `test_self_host_gate.py` (nach Prüfung, dass sie nur Antrag/Freigabe/env-file testen). In `test_admin_instances.py` die Tests für Anträge löschen; die verbleibenden Listen-/Sperr-/Rotations-Tests seedeten ihre Instanz über Antrag + Freigabe — dort `_seed_application(...)` + `approve` durch eine direkte Anlage ersetzen:

```python
async def _instanz(session_factory, *, hostname: str, besitzer: int) -> int:
    from dcc_auth.models_instances import RegisteredInstance
    from dcc_auth.snowflake import next_id

    iid = next_id()
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid, hostname=hostname, client_id=f"c-{iid}", client_secret="x",
                worker_id_chat=None, worker_id_voice=None, worker_id_media=None,
                status="active", registered_by=besitzer,
            )
        )
        await s.commit()
    return iid
```
In `test_instance_applications_me.py` die env-file- und Antragstests löschen, Mitgliedschafts- und Listentests behalten.

- [ ] **Step 4: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add -A services/auth
git commit -m "chore(auth): Antrag, Freigabe und .env-Download entfernt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.3: Doku, CLAUDE.md, Gedächtnis

**Files:**
- Modify: `CLAUDE.md` (Abschnitt „Self-Host-Identität & Cert-Modell“, Punkte „Approval = Single-Bootstrap pro Antrag“, „Admin-Status pro Server“, „Instanz-Rolle“; Erreichbarkeits-Abschnitt; Produktiv-Deployment: Bildnamen)
- Modify: `docs/INSTANCE_APPROVAL_POLICY.md` (Kopfvermerk „Überholt seit 2026-10-09“)
- Modify: `IDENTITY_CONCEPT.md` (Nachtrag)

- [ ] **Step 1: CLAUDE.md.** Ersetzen:
  - „**Approval = Single-Bootstrap pro Antrag** …“ → „**Keine Freigabe mehr (seit 2026-10-09).** Jeder installiert mit `curl … /install | bash` oder Compose; Pflicht ist nur `PULSE_HOSTNAME`. Das Serverticket trägt `aud = [instanz_id, hostname]`; der Server nimmt an, wenn seine normalisierte Adresse (`dcc_shared.hostname`) oder seine Instanz-Nummer darin steht. Unbekannte Adressen bekommen beim ersten Ticket einen Eintrag `ohne_freigabe` (`instanz_eintrag.py`). Bestands-VPS behalten Nummer und Zugangsdaten, weil ihr Update-Skript auf dem Host sich damit bei `registry.howispulse.com` anmeldet und bei Fehlschlag still aufhört. Spec: `docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md`.“
  - Unter „Admin auf einem Self-Host entsteht an GENAU EINER Stelle“: „`routes/session_ticket.py` über `besitz.besitzer_kennung` — Umgebung (`PULSE_INSTANCE_OWNER_ID`) gewinnt, sonst der per Einrichtungscode übernommene Besitzer (`chat.instanz_besitz`). Der Code wird nie geloggt; `docker exec pulse pulse-setup-code [--reset]`.“
  - Bildnamen: `ghcr.io/oblivion8282-1337/pulse-*` → `ghcr.io/howispulse/pulse-*` (außer dem MediaMTX-Pin, solange er alt ist), Self-Host-Bild `ghcr.io/howispulse/pulse` (öffentlich), Spiegel `registry.howispulse.com/pulse-allinone` nur für Bestand. Remote `origin` → `github.com/howispulse/pulse.git`.
  - Vorher `grep -n "oblivion8282-1337\|Approval\|Freigabe\|bootstrap" CLAUDE.md` und jede Fundstelle prüfen (Regel „eine Behauptung wird nie an nur einer Stelle korrigiert“). Die noreply-Adresse bleibt.

- [ ] **Step 2: Übrige Dokumente.** `docs/INSTANCE_APPROVAL_POLICY.md` oben: „> **Überholt seit 2026-10-09** — es gibt keine Freigabe mehr. Bleibt als Historie.“ `IDENTITY_CONCEPT.md` am Ende einen Nachtrag „2026-10-09: Self-Hosts ohne Freigabe — `aud` trägt die Adresse; die offene Designfrage ‚audience-binding vs. Privacy‘ ist damit zugunsten der Adresse entschieden (die Cloud sah den Hostnamen ohnehin schon).“

- [ ] **Step 3: Gedächtnis aktualisieren** (maschinenlokal, nicht im Repo): `project_unified_hosting_applications.md` (Umsetzung erledigt), `project_ghcr_pat_rotation.md`, `project_mediamtx_pin.md`, `project_rust_linux_sidecar.md` auf die neuen Bildnamen; Index `MEMORY.md` nachziehen.

- [ ] **Step 4: Gate, Commit, Landen.**

```bash
bash scripts/gate.sh
git add CLAUDE.md docs/INSTANCE_APPROVAL_POLICY.md IDENTITY_CONCEPT.md
git commit -m "docs: Self-Host ohne Freigabe in CLAUDE.md und Konzept nachgezogen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bash scripts/ship.sh   # nach Freigabe
```

---

## Später (nicht Teil dieses Plans)

- MediaMTX-Pins auf `ghcr.io/howispulse/pulse-mediamtx` beim nächsten Fork-Versionssprung (prod: `up -d --no-deps mediamtx` zu ruhiger Zeit; dev-, dev-remote- und `streaming/server`-Compose mitziehen).
- Offene Prüfung von außen für neue Server mit Nachweis des Betreibers (Spec §5).
- `stable` wieder von `edge` trennen, wenn es getaggte Releases gibt (`allinone.yml`, Phasen-Policy).
