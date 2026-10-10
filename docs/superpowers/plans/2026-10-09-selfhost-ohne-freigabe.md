# Self-Host ohne Freigabe — Implementation Plan (Fassung 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Ersetzt den Plan zu Fassung 1 vom 2026-10-09 (Einrichtungscode, Adresse im Ticket). Der alte Text steht in der Git-Geschichte dieser Datei (`git log -p -- docs/superpowers/plans/2026-10-09-selfhost-ohne-freigabe.md`).

**Goal:** Jeder kann einen Pulse-Server mit `curl -fsSL https://howispulse.com/install | bash` oder einer Compose-Datei installieren, ohne Antrag und ohne Freigabe; am Ende der Installation verbindet der Betreiber ihn mit einem Klick im Browser mit seinem Pulse-Konto.

**Architecture:** Der Server fragt bei der Cloud einen Gerätecode an (Muster RFC 8628) und belegt per Nachweis unter `/.well-known/pulse-verbinden`, dass er unter seiner Adresse läuft. Der Betreiber bestätigt auf `howispulse.com/verbinden`; die Cloud legt den Eintrag an und gibt dieselben Zugangsdaten aus wie heute ein Bootstrap-Token. Ab da läuft der Server exakt wie ein freigegebener Server (Tickets an die Instanz-Nummer, Admin über `PULSE_INSTANCE_OWNER_ID`, Sperre, Prüfung von außen). In der App ersetzt ein Eintrag im Plus-Menü den Server-Knopf, „Meine Server“ erscheint nur mit eigenem Server.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + Redis (auth-svc, chat-gateway), httpx, pydantic v2, s6-overlay-Shellskripte, Bash-Installer, SvelteKit/Svelte 5 + Paraglide, Playwright, Nodes Test-Läufer, GitHub Actions + GHCR.

**Spec:** `docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md` (Fassung 2, Entscheidungen E1–E11, Ablauf Abschnitt 4, Oberfläche Abschnitt 5). Skizzen des Eigentümers: https://claude.ai/artifact/RUbfNR22z4nj3KmHwRCwjA

## Global Constraints

- Python `>=3.13`, Ruff `line-length=100`; Kommentare und Docstrings deutsch, Meldungen an fremde Betreiber (Installer, `pulse-connect`, Container-Log) englisch.
- Niemals Client-Secret, Abholkennung oder Anzeigecode loggen. Einzige Ausnahme: `pulse-connect` zeigt Link und Code im Terminal des Betreibers, dafür ist es da.
- Keine neuen Abhängigkeiten (Python, npm, Cargo). Für HTTP-Tests `httpx.MockTransport`, kein respx.
- Alembic-Revision-IDs höchstens 32 Zeichen. Snowflake-IDs reisen als Strings über die API.
- Quelldateien ≤ 350 Zeilen (hart 500), Svelte-Komponenten ≤ 250. Runen nur in `.svelte`/`.svelte.ts`; Node-geprüfte Dateien ohne erweiterungslose Laufzeit-Importe und ohne `$state` auf Modulebene.
- Geräte-Trennung: keine Breakpoint-Klassen in `web/src`, `viewport.*` nur in Routen, `components/mobile/` und dem Store. **`bash scripts/geraete-trennung.sh` aus dem Wurzelverzeichnis aufrufen**: aus `web/` heraus findet seine `git ls-files`-Abfrage keine Datei, und es ist still grün.
- `grep` ist auf der Entwicklungsmaschine `ugrep`; Muster mit `$` (etwa `$lib/…`) treffen dort nicht verlässlich. Für feste Texte `grep -rnF`.
- Paraglide-Schlüssel werden am Ende von `de.json`/`en.json` angefügt (vor der schließenden `}`; die bisher letzte Zeile bekommt ein Komma).
- i18n: neue Schlüssel in `web/messages/de.json` UND `web/messages/en.json`; bestehende Schlüssel werden nicht umbenannt oder gelöscht (append-only).
- Commit-Messages und neue Texte mit echten Umlauten; keine Emojis, nirgends.
- Backend-Tests: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q <pfad>`; Web: `cd web && pnpm check && pnpm build && pnpm test:unit`; volles Gate `bash scripts/gate.sh`.
- Jede Etappe auf eigenem Zweig von frisch gepulltem `main`, gelandet über `bash scripts/ship.sh`. **Landen = Prod-Deploy → nur auf ausdrückliche Freigabe des Eigentümers.**
- Nach jeder Code-Änderung: `code-simplifier`-Agent über die geänderten Dateien, Tests erneut grün, `bash .claude/hooks/simplify-stamp.sh`, dann committen. Jeder Commit endet mit `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Bestandsserver (drei VPS mit Zugangsdaten in der Umgebung, zwei Heim-Server) dürfen in keiner Etappe etwas bemerken.
- GitHub-Organisation: `oblivion-pictures`. Die Domain `howispulse.com` bleibt überall.

## Review Focus

1. **Fremder Proxy liefert die SPA statt des Nachweises.** Ein vorgeschalteter Proxy, der `/.well-known/pulse-verbinden` nicht durchreicht, antwortet mit HTML und Status 200. Erwartet: kein Erfolg, sondern Befund `kein_nachweis`/`falscher_wert`, und `pulse-connect` erklärt, was zu tun ist (Exit 3), ohne einen Code zu verbrauchen. Test in Task 1.4 (HTML-Antwort) und Task 2.4 (409 → Exit 3).
2. **Adresse in anderer Schreibweise** (`Chat.Example.org`, abschließender Punkt, mit `:443`) beim Anfragen. Erwartet: derselbe normalisierte Eintrag, kein Zweiteintrag. Test in Task 1.1 und im Durchlauf-Test von Task 1.7.
3. **Bestätigung zu spät oder Konsole abgebrochen.** Wer nach 15 Minuten klickt oder `pulse-connect` mit Strg+C beendet, ruft es erneut auf. Erwartet: Die Seite zeigt „Dieser Code gilt nicht mehr“ mit dem Handgriff; jeder Ausgang von `pulse-connect` (auch Strg+C) löscht die Nachweis-Datei, ein neuer Aufruf erzeugt eine neue Kennung und bekommt einen neuen Code (die Cloud sperrt nur dieselbe Kennung für eine andere Adresse). Tests in Task 2.4 (Strg+C), Task 1.7 (`vorgang_laeuft` nur bei gleicher Kennung) und Task 3.2 (404 → „gilt nicht mehr“).
4. **Neuinstallation auf altem, schon verbundenem Volumen.** Erwartet: Der Installer verbindet nicht erneut (Server-Info meldet `verbunden: true`) und sagt das. Test in Task 4.1.
5. **Bestandsserver nach dem Image-Update.** Umgebung mit Zugangsdaten gewinnt vor `verbindung.env`; ein Fremder kann einen antwortenden Bestandsserver nicht von einem anderen Rechner aus übernehmen (kein Nachweis). Tests in Task 2.3 (Vorrang der Umgebung) und Task 1.6 (keine Übernahme ohne Nachweis).

## Etappen und Reihenfolge

| Etappe | Zweig | Was danach live ist |
|---|---|---|
| 0 | `chore/org-umzug-mediamtx`, `chore/org-umzug` | Repo und Bauwege unter `github.com/oblivion-pictures` |
| 1 | `feat/verbinden-cloud` | Cloud kann Server per Gerätecode verbinden (noch niemand ruft es) |
| 2 | `feat/verbinden-server` | Image startet unverbunden und bringt `pulse-connect` mit |
| 3 | `feat/verbinden-seite` | Bestätigungsseite `howispulse.com/verbinden` |
| 4 | `feat/selfhost-vordertuer` | Installer ohne Token, Compose ohne Zugangsdaten, Paket öffentlich |
| 5 | `feat/eigener-server-einstieg` | Plus-Eintrag, Dialog, „Meine Server“, Server-Knopf weg, Admin-Oberfläche |
| 6 | `chore/freigabe-aufraeumen` | Antrag, Freigabe, `.env`-Download entfernt |

Ausrollen in genau dieser Reihenfolge. Der Installer (4) druckt den Link auf die Seite aus 3, braucht die Routen aus 1, das Image aus 2 und die öffentliche Bildadresse aus 0. Der Dialog aus 5 zeigt den Befehl aus 4. Etappe 6 erst, wenn 5 live ist und kein Klient mehr die alten Routen ruft.

---

## Etappe 0 — Umzug in die Organisation `oblivion-pictures`

Hintergrund: GitHub verschiebt beim Repo-Umzug Issues, PRs, Secrets und leitet Web- und Git-Adressen um. **Container-Pakete bleiben beim persönlichen Konto**, ihre Verknüpfung fällt weg, und die Workflows des umgezogenen Repos verlieren den Zugriff darauf. Deshalb müssen alle Bauwege auf `ghcr.io/oblivion-pictures/...` schreiben, und die Cloud muss im selben Schritt von dort ziehen.

### Task 0.1: Organisation anlegen und Repo übertragen (Eigentümer, im Browser)

**Files:** keine.

- [x] **Step 1: Organisation anlegen.** Erledigt am 2026-10-10: `oblivion-pictures`, Plan *Free*, Kontaktadresse die des Eigentümers, Besitzer `oblivion8282-1337`.
- [ ] **Step 2: Einstellungen der Organisation.**
  - *Settings → Authentication security*: „Require two-factor authentication“ einschalten (wer das Organisationskonto übernimmt, erreicht jeden Auto-Updater; Spec §5).
  - *Settings → Actions → General*: „Allow all actions and reusable workflows“ (gebraucht werden u. a. `contributor-assistant`, `dtolnay`, `astral-sh`, `pnpm`, `Swatinem`, `apple-actions`, `android-actions`).
  - *Settings → Packages*: Erstellen öffentlicher **und** privater Pakete erlauben.
  - *Settings → Personal access tokens*: klassische Tokens nicht sperren (der netcup zieht mit einem klassischen `read:packages`-Token).
- [ ] **Step 3: Installierte GitHub-Apps prüfen.** Persönliches Konto → *Settings → Applications*: Apps mit „selected repositories“, die `pulse` enthalten, nach dem Umzug in der Organisation neu installieren.
- [ ] **Step 4: Repo übertragen.** `github.com/oblivion8282-1337/pulse` → *Settings → Danger Zone → Transfer* → Ziel `oblivion-pictures`. **Danach nie wieder ein Repo namens `pulse` unter dem persönlichen Konto anlegen** (sonst erlischt die Umleitung).
- [ ] **Step 5: `REGISTRY_PUSH_TOKEN` neu setzen.** Beim Lesen der netcup-`.env` geriet der Wert am 2026-10-09 in das lokale Protokoll eines Suchlaufs. Neues Passwort für den Registry-Benutzer `pulse-ci` erzeugen (Ablauf in `infra/prod/DEPLOY.md`, Abschnitt Registry), auf dem netcup in `~/pulse/infra/prod/.env` eintragen, im Repo unter *Settings → Secrets → Actions* `REGISTRY_PUSH_TOKEN` ersetzen.
- [ ] **Step 6: Git-Remote auf diesem Rechner umstellen.**

```bash
git remote set-url origin https://github.com/oblivion-pictures/pulse.git
git fetch origin && git status -sb | head -1
```
Expected: `## main...origin/main` ohne Fehlermeldung. Dasselbe auf Mac, Windows und `~/pulse-test/repo` auf dem Hetzner (dort `ssh michael@77.42.71.166 'cd ~/pulse-test/repo && git remote set-url origin https://github.com/oblivion-pictures/pulse.git'`).

### Task 0.2: MediaMTX-Fork in den neuen Namensraum bauen

Das Self-Host-Image kopiert MediaMTX aus `ghcr.io/oblivion8282-1337/pulse-mediamtx` — ein privates Paket des persönlichen Kontos, auf das der Bau nach dem Umzug keinen Zugriff mehr hat. Der Fork muss deshalb **zuerst und allein** im neuen Namensraum entstehen.

**Files:**
- Modify: `.github/workflows/mediamtx-fork.yml:13-14,101-102`

- [ ] **Step 1: Zweig anlegen.**

```bash
git checkout main && git pull --ff-only && git checkout -b chore/org-umzug-mediamtx
```

- [ ] **Step 2: Namen umstellen.** In `.github/workflows/mediamtx-fork.yml` jedes `ghcr.io/oblivion8282-1337/pulse-mediamtx` durch `ghcr.io/oblivion-pictures/pulse-mediamtx` ersetzen (Zeilen 13, 14, 101, 102):

```yaml
          tags: |
            ghcr.io/oblivion-pictures/pulse-mediamtx:${{ steps.ver.outputs.tag }}
            ghcr.io/oblivion-pictures/pulse-mediamtx:latest
```

- [ ] **Step 3: Prüfen, dass nichts übrig ist.**

Run: `grep -n "oblivion8282-1337" .github/workflows/mediamtx-fork.yml`
Expected: keine Ausgabe.

- [ ] **Step 4: Commit und landen.** Die Änderung betrifft nur CI (`NON_USER_FACING`), kein Changelog. Der Push auf `main` löst den Fork-Bau aus (Pfad-Filter enthält die Workflow-Datei). Die Cloud bleibt unberührt, weil `infra/prod/docker-compose.yml` den alten Namensraum pinnt.

```bash
git add .github/workflows/mediamtx-fork.yml
git commit -m "ci: MediaMTX-Fork baut in den Namensraum oblivion-pictures

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
- Modify: `web/src/lib/legal/impressum.md:68`, `web/src/lib/legal/drittanbieter.md:7,159`, `.github/workflows/cla.yml:51`
- Modify: `infra/self-host/README.md:14`, `infra/prod/DEPLOY.md:14,396`, `docs/ONBOARDING.md:63` (Behauptungen über Bild- und Repo-Adressen)

- [ ] **Step 1: Zweig anlegen.**

```bash
git checkout main && git pull --ff-only && git checkout -b chore/org-umzug
```

- [ ] **Step 2: `ci.yml`.** Zeilen 310–311:

```yaml
          tags: |
            ghcr.io/oblivion-pictures/pulse-${{ matrix.name }}:latest
            ghcr.io/oblivion-pictures/pulse-${{ matrix.name }}:sha-${{ steps.sha.outputs.short }}
```

- [ ] **Step 3: `allinone.yml`.** Zeile 76 `IMAGE: ghcr.io/oblivion-pictures/pulse`. Kopfkommentar 4–9 auf `ghcr.io/oblivion-pictures/pulse:…` ziehen. Im Spiegel-Schritt (Zeilen 327–331) die Quelle aus `IMAGE` ableiten und den Spiegelnamen **unverändert `pulse-allinone`** lassen (auth-svc erzwingt ihn in `routes_registry_auth.py:54`, Bestandsserver ziehen ihn):

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
FROM ghcr.io/oblivion-pictures/pulse-mediamtx:${PULSE_MEDIAMTX_TAG} AS mediamtx-fork
```
Zeile 8 (Kopfkommentar) auf `ghcr.io/oblivion-pictures/pulse:stable`, Zeile 321 `org.opencontainers.image.source="https://github.com/oblivion-pictures/pulse"`.

- [ ] **Step 5: Cloud-Compose und Cloud-Updater im Repo.** In `infra/prod/docker-compose.yml` jedes `ghcr.io/oblivion8282-1337/pulse-` **außer** dem Fork `pulse-mediamtx:1.19.1-pulse7` durch `ghcr.io/oblivion-pictures/pulse-` ersetzen (`pulse-mediamtx-auth-hook` zieht mit um). In `infra/prod/pulse-update.sh` den Kommentar in Zeile 27 (`ghcr.io/oblivion-pictures/pulse-*:latest`) und die Liste:

```bash
APP_IMAGES=(
  ghcr.io/oblivion-pictures/pulse-auth:latest
  ghcr.io/oblivion-pictures/pulse-chat-gateway:latest
  ghcr.io/oblivion-pictures/pulse-voice-signaling:latest
  ghcr.io/oblivion-pictures/pulse-media-svc:latest
  ghcr.io/oblivion-pictures/pulse-mediamtx-auth-hook:latest
  ghcr.io/oblivion-pictures/pulse-relay-frps-plugin:latest
  ghcr.io/oblivion-pictures/pulse-web:latest
)
```

Run: `grep -n "oblivion8282-1337" infra/prod/docker-compose.yml infra/prod/pulse-update.sh`
Expected: genau eine Zeile, die `pulse-mediamtx:1.19.1-pulse7` (bleibt bis zum nächsten Versionssprung; ein Wechsel erzeugt den MediaMTX-Container neu und reißt Streams ab).

- [ ] **Step 6: Quellcode-Links.** `impressum.md:68`, `drittanbieter.md:7` und `:159`, `cla.yml:51`: `github.com/oblivion8282-1337/pulse` → `github.com/oblivion-pictures/pulse`. **Nicht anfassen:** die Adresse `249562202+oblivion8282-1337@users.noreply.github.com` (CLAUDE.md, `scripts/gate.sh:103`, Patch-Kopf) und `allowlist: 'oblivion8282-1337,*[bot]'` in `cla.yml:53` (Benutzername, bleibt).

Run: `grep -rn "github.com/oblivion8282-1337" web/src .github`
Expected: keine Ausgabe.

- [ ] **Step 7: Behauptungen in der Doku.** `infra/self-host/README.md:14` (`ghcr.io/oblivion8282-1337/pulse-allinone` → `ghcr.io/oblivion-pictures/pulse`), `infra/prod/DEPLOY.md:14` (`ghcr.io/oblivion8282-1337/pulse-*` → `ghcr.io/oblivion-pictures/pulse-*`) und `:396` (`…/pulse-allinone:edge` → `ghcr.io/oblivion-pictures/pulse:edge`), `docs/ONBOARDING.md:63` (Klon-Adresse → `https://github.com/oblivion-pictures/pulse.git`). Datierte Dokumente unter `docs/plans/`, `docs/superpowers/plans/` und `docs/2026-*` sind Historie und bleiben. Die `pulse-mediamtx`-Fundstellen (`infra/self-host/README.md:113`, `infra/mediamtx-fork/*`, `infra/dev-remote/docker-compose.yml:290`, `streaming/server/docker-compose.yml:45`) bleiben bis zum nächsten MediaMTX-Versionssprung auf dem alten Namensraum, wie die Pins.

Run: `git grep -n "oblivion8282-1337" -- ':!*.patch' ':!scripts/gate.sh' ':!CLAUDE.md' ':!docs/plans' ':!docs/superpowers/plans' ':!docs/2026-*' | grep -Ev "pulse-mediamtx([: ]|$)" | grep -v "allowlist:"`
Expected: keine Ausgabe.

- [ ] **Step 8: Gate und Commit.** Der Impressum-Text ist für Nutzer sichtbar, ändert aber nur den Link; kein eigener Changelog-Eintrag.

```bash
bash scripts/gate.sh
git add .github/workflows/ci.yml .github/workflows/allinone.yml .github/workflows/cla.yml \
  infra/self-host/Dockerfile infra/prod/docker-compose.yml infra/prod/pulse-update.sh \
  web/src/lib/legal/impressum.md web/src/lib/legal/drittanbieter.md \
  infra/self-host/README.md infra/prod/DEPLOY.md docs/ONBOARDING.md
git commit -m "chore: Bauwege und Cloud-Abholung auf die Organisation oblivion-pictures

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
ssh michael@159.195.150.54 'docker manifest inspect ghcr.io/oblivion-pictures/pulse-auth:latest >/dev/null && echo OK'
```
Expected: `OK`. Bei `unauthorized`: der klassische Token des Eigentümers braucht Zugriff auf die Organisation (Task 0.1 Step 2).

- [ ] **Step 3: Beide Dateien in einem Zug umstellen** (Caddy-/Inode-Falle beachten: `sed -i` auf Compose ist hier unkritisch, weil Docker die Datei nicht einhängt).

```bash
ssh michael@159.195.150.54 '
  cd ~/pulse/infra/prod &&
  cp docker-compose.yml docker-compose.yml.vor-umzug &&
  cp pulse-update.sh pulse-update.sh.vor-umzug &&
  sed -i "s#ghcr.io/oblivion8282-1337/pulse-\(auth\|chat-gateway\|voice-signaling\|media-svc\|mediamtx-auth-hook\|relay-frps-plugin\|web\):latest#ghcr.io/oblivion-pictures/pulse-\1:latest#" docker-compose.yml pulse-update.sh &&
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

---

## Etappe 1 — Cloud: Verbinden per Gerätecode

Danach ist live: Die Cloud nimmt Verbindungsanfragen von Servern an, lässt sie von einem angemeldeten Konto bestätigen und gibt die Zugangsdaten genau einmal zur Abholung frei. Für Nutzer ist noch nichts sichtbar, weil weder `pulse-connect` (Etappe 2) noch die Bestätigungsseite (Etappe 3) existieren.

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/verbinden-cloud`

### Vorbemerkungen zu Etappe 1

**Kennung beim Anfragen (Vertrag, Nachtrag 2).** `POST /selfhost/verbinden/start` nimmt `{"hostname": str, "kennung": str}`, nicht den Nachweis. Die Cloud bildet den Nachweis selbst (`nachweis_aus_kennung`) und speichert weiterhin nur den Hash.

Grund: Der Nachweis (SHA-256 der Kennung) steht während des Verbindens öffentlich unter `https://<adresse>/.well-known/pulse-verbinden`. Mit der Vertragsfassung könnte jeder, der diese Adresse während eines laufenden `pulse-connect` abfragt, mit demselben Nachweis selbst einen Code anfordern und ihn mit seinem eigenen Konto bestätigen. Holt der Server danach mit seiner Kennung ab, bekommt er Zugangsdaten mit dem Angreifer als Besitzer, und der Angreifer ist Admin auf einem fremden Server. Wird mit `SET NX` „wer zuerst kommt“ erzwungen, bleibt ein Wettlauf, den ein Angreifer mit dauerndem Abfragen gewinnen kann. Er löscht dann beim Bestätigen den alten Eintrag des Opfers über die Übernahme-Regel (E2). Mit der Kennung im Start kann nur der Server selbst einen Code anfordern. Die Kennung reist ohnehin schon bei jedem Abholen über dieselbe TLS-Verbindung. Für `pulse-connect` (Teil B) ändert sich nur das Feld im Start-Aufruf; Nachweis-Datei und Abholen bleiben wie im Vertrag.

**Code nie im Pfad (Vertrag, Nachtrag 2).** Die angemeldeten Routen heißen `POST /me/selfhost/verbinden/vorgang` (Body `{"code"}`) und `POST /me/selfhost/verbinden/entscheidung` (Body `{"code", "aktion"}`). Pfade landen in Zugriffsprotokollen (`infra/prod/web-nginx.conf:35-43` loggt `$uri`), und wer dort einen offenen Code liest, könnte ihn mit seinem Konto bestätigen.

Zwei Abweichungen vom Vertrag betreffen nur auth-svc-interne Signaturen und nichts außerhalb von Teil A:
- `vorgang_entscheiden(...) -> bool` statt `-> None`. Die Route committet ihre Datenbank-Arbeit nur, wenn genau dieser Aufruf den Vorgang aus `wartet` heraus entschieden hat (Doppelklick, zwei Tabs).
- `instanz_verbinden(...) -> Verbunden` (benanntes Tupel aus `instanz` und `abgeloest`) statt `-> RegisteredInstance`. Bei einer Übernahme muss die Route nach dem Commit den Cache der Sperrliste für den alten Eintrag leeren.

**Nachträge eingearbeitet:** Task 1.8 (Hinweis-Mails an das bestätigende Konto und bei einer Übernahme an den bisherigen Besitzer, Entwurf E5 „Schutz gegen untergeschobene Links“) und Task 1.9 (Ereignis `instanz_verbunden` an die Geräte des Besitzers, Entwurf E3).

**Für alle Tasks:**
- Testbefehl Backend (alle drei Variablen sind Pflicht, CLAUDE.md „Tests“):
  `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q <pfad>`
- Ab Task 1.3 brauchen die neuen Tests einen **echten Redis** (`redis_echt`-Fixture). Ohne `-n` ist das der Dev-Redis auf `:6380` (`docker compose up -d redis`, `scripts/gate.sh` fährt ihn selbst hoch), mit `-n` startet der Wurzel-`conftest.py` je Worker einen eigenen. Eine Attrappe kann `SET NX`, `GETDEL`, `KEEPTTL` und WATCH/MULTI nur nachspielen, und genau daran hängt das „genau einmal“. Prod läuft `redis:7-alpine` (`infra/prod/docker-compose.yml:64`), `GETDEL` braucht mindestens 6.2.
- Importreihenfolge wie in den Nachbardateien (stdlib, Drittpakete, Leerzeile, `dcc_shared`, Leerzeile, `dcc_auth`). `ruff` hängt in keinem Gate, und seine isort-Regel meldet auch Bestandsdateien (`test_bootstrap_token.py`, `test_selfhost_probe_betreiber.py`). Deshalb hier nicht nach ruff umsortieren.
- Nach jeder Code-Änderung: `code-simplifier`-Agent über die geänderten Dateien, Testlauf wiederholen (grün), `bash .claude/hooks/simplify-stamp.sh`, erst dann committen.
- Niemals Kennung, Code oder Secret loggen. Die Log-Zeilen dieser Etappe nennen nur Adresse, Instanz- und Nutzer-Kennungen.
- Bestand darf nichts bemerken: Die Migration ist rein additiv (Spalten nullable oder mit `server_default`). `GET /me/instances` bekommt nur ein zusätzliches Feld, die Bootstrap-Antwort bleibt Byte für Byte gleich.

---

### Task 1.1: Hostnamen-Normalisierung in `dcc_shared`

Fast unverändert aus dem alten Plan (Task 1.1) übernommen. Neu ist nur die Begründung im Modulkopf: Es geht nicht mehr um die Adresse im Ticket, sondern um den Eintrag beim Verbinden.

**Files:**
- Create: `shared/src/dcc_shared/hostname.py`
- Test: `shared/tests/test_hostname.py` (neu)

**Interfaces:**
- Consumes: nichts.
- Produces: `normalisiere_hostname(roh: str) -> str | None`. Liefert Kleinbuchstaben ohne Schema, Port, Pfad und abschließenden Punkt, oder `None`, wenn es kein gültiger FQDN ist (IP-Adressen, `localhost`, Unicode ohne Punycode, mehr als 253 Zeichen).

- [ ] **Step 1: Fehlschlagenden Test schreiben** (`shared/tests/test_hostname.py`).

```python
"""Eine Schreibweise fuer jede Server-Adresse.

Die Cloud traegt beim Verbinden eines Servers dessen Adresse in
``auth.registered_instances.hostname`` ein und findet ihn spaeter darueber
wieder (Serverticket, Uebernahme). Kaeme dieselbe Adresse einmal mit Schema,
Port oder Grossbuchstaben an, entstuenden zwei Eintraege fuer einen Server.
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
    [
        "",
        "   ",
        "localhost",
        "127.0.0.1",
        "[::1]",
        "-boese.example.org",
        "a..b.org",
        "bücher.de",
        "x" * 250 + ".org",
    ],
)
def test_ungueltige_adressen(roh):
    assert normalisiere_hostname(roh) is None
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q shared/tests/test_hostname.py`
Expected: Sammelfehler `ModuleNotFoundError: No module named 'dcc_shared.hostname'`.

- [ ] **Step 3: Umsetzen** (`shared/src/dcc_shared/hostname.py`).

```python
"""Hostnamen normalisieren — eine Fassung für Cloud und Self-Host.

Seit dem Verbinden per Gerätecode (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E1)
trägt die Cloud die Adresse eines Servers selbst ein: so, wie der Server sie
beim Anfragen des Codes nennt. Dieselbe Adresse muss danach in jeder
Schreibweise (mit Schema, Port, Grossbuchstaben, abschliessendem Punkt)
denselben Eintrag treffen — sonst entstünden zwei Einträge für einen Server,
und die Übernahme einer Adresse (E2) fände den alten nicht.

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

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q shared/tests/test_hostname.py`
Expected: `17 passed`.

- [ ] **Step 5: Vereinfachen.** `code-simplifier` über `shared/src/dcc_shared/hostname.py` und `shared/tests/test_hostname.py`, Step 4 wiederholen, dann `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 6: Commit.**

```bash
git add shared/src/dcc_shared/hostname.py shared/tests/test_hostname.py
git commit -m "feat(shared): Hostnamen für Cloud und Self-Host gleich normalisieren

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.2: Datenmodell und Migration `0056_verbinden`

**Files:**
- Create: `services/auth/alembic/versions/20261010_1200_0056_verbinden.py`
- Modify: `services/auth/src/dcc_auth/models_instances.py:56-58` (Worker-IDs), neue Spalten nach `:86-90` (`online_gemeldet`)
- Modify: `services/auth/src/dcc_auth/models.py` (neue Spalte nach `:101-106`, `self_host_enabled`)
- Modify: `services/auth/src/dcc_auth/routes_instance_applications.py:118-120`, `:154`, `:205`, `:217-221`, `:241-244`
- Modify: `services/auth/src/dcc_auth/routes_admin_instances.py:78-80`, `:87`, `:183`
- Modify: `services/auth/src/dcc_auth/instance_provisioning.py:29`, `:83-86`, `:102-118`, `:130-137`
- Test: `services/auth/tests/test_verbinden_datenmodell.py` (neu)

**Wer liest Worker-IDs heute? (`git grep -n worker_id_`, geprüft am 2026-10-10)**

| Stelle | Liest/schreibt | Folge von `None` | Maßnahme |
|---|---|---|---|
| `models_instances.py:56-58,106-108` | Spalten + eindeutige Indizes | mehrere `NULL` sind in eindeutigen Indizes erlaubt (Postgres und SQLite) | Spalten nullable |
| `routes_instance_applications.py:118-120,188-190` (`InstanceOut`, `GET /me/instances`, `POST /me/instances`) | gibt sie aus | **500** bei `int` | `int \| None` |
| `routes_admin_instances.py:78-80,175-177` (`GET /admin/instances`) | gibt sie aus | **500** bei `int` | `int \| None` |
| `routes_admin_instances.py:106-141` `_allocate_worker_ids` | `max()` über die Spalten | `max` überspringt `NULL` | bleibt |
| `instance_provisioning.py:103-113` (Heim-Server) | vergibt sie | — | Vergabe entfällt (E7) |
| `routes_admin_applications.py:87-89,208-218,296-298` (VPS-Freigabe) | vergibt sie | nie `None` | bleibt bis Etappe 6 |
| `instance_env_file.py` | schreibt sie nicht | — | nichts |
| `web/src/lib/api/instances.ts:57-59,121-123,133-135`, `web/src/lib/components/admin/AdminInstancesActive.svelte:150` | Typ `number`, Anzeige `Workers: a/b/c` | Svelte zeigt `null` leer an: „Workers: //“ (nur Admin, nur neue Einträge) | Teil C, Etappe 5 (siehe Offene Punkte) |
| Tests (`test_*`, die Instanzen mit Worker-IDs anlegen) | schreiben feste Werte | — | bleiben |

**Interfaces:**
- Consumes: nichts Neues.
- Produces:
  - `RegisteredInstance.worker_id_{chat,voice,media}: int | None`
  - `RegisteredInstance.ohne_freigabe: bool` (Vorgabe `False`)
  - `RegisteredInstance.verbunden_at: datetime | None`
  - `User.server_verbinden_gesperrt: bool` (Vorgabe `False`)
  - `InstanceOut.ohne_freigabe: bool` in beiden Schemas, Worker-IDs `int | None`
  - `_versorgte_instanzen` zählt `verbunden_at IS NOT NULL` mit

- [ ] **Step 1: Fehlschlagenden Test schreiben** (`services/auth/tests/test_verbinden_datenmodell.py`).

```python
"""Datenmodell für das Verbinden per Gerätecode (Migration 0056).

Ein verbundener Server entsteht ohne Antrag und ohne Worker-IDs. Er muss
trotzdem in jeder Liste erscheinen, in der heute ein freigegebener steht —
sonst sähe der Besitzer seinen Server auf dem zweiten Gerät nie.
"""

from __future__ import annotations

import inspect
from datetime import UTC, datetime
from pathlib import Path

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership


async def _konto(client, name: str) -> dict:
    reg = {
        "username": name,
        "email": f"{name}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": name,
    }
    r = await client.post("/register", json=reg)
    assert r.status_code == 201, r.text
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    assert r.status_code == 200, r.text
    cookie = f"pulse_session={r.cookies.get('pulse_session')}"
    me = await client.get("/me", headers={"Cookie": cookie})
    return {"cookie": cookie, "id": int(me.json()["id"]), "token": r.json()["access_token"]}


async def _verbundener_eintrag(
    session_factory, *, iid: int, hostname: str, besitzer: int, verbunden: bool
) -> None:
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"verb-{iid}",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$egal",
                status="active",
                origin="vps",
                registered_by=besitzer,
                ohne_freigabe=True,
                verbunden_at=datetime.now(UTC) if verbunden else None,
            )
        )
        s.add(UserInstanceMembership(user_id=besitzer, instance_id=iid, role="owner"))
        await s.commit()


def _migration_0056():
    import importlib.util

    pfad = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob("*_0056_*.py")
    )
    spec = importlib.util.spec_from_file_location(pfad.stem, pfad)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_migration_0056_haengt_an_0055_und_kann_zurueck():
    mod = _migration_0056()
    assert mod.revision == "0056_verbinden"
    assert len(mod.revision) <= 32
    assert mod.down_revision == "0055_instanz_anzeige"
    hin = inspect.getsource(mod.upgrade)
    zurueck = inspect.getsource(mod.downgrade)
    for spalte in ("ohne_freigabe", "verbunden_at", "server_verbinden_gesperrt"):
        assert spalte in hin
        assert spalte in zurueck
    assert "nullable=True" in hin


async def test_neues_konto_darf_verbinden(client, session_factory):
    konto = await _konto(client, "dm_neu")
    async with session_factory() as s:
        user = await s.get(User, konto["id"])
    assert user.server_verbinden_gesperrt is False


async def test_neuer_heim_server_bekommt_keine_worker_ids(client, session_factory):
    """E7: der Vorrat an Worker-IDs war die einzige harte Obergrenze für die
    Zahl der Server, und der Container hat die Nummern nie gelesen."""
    konto = await _konto(client, "dm_heim")
    r = await client.post("/me/instances", headers={"Cookie": konto["cookie"]})
    assert r.status_code == 201, r.text
    assert r.json()["instance"]["worker_id_chat"] is None
    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, int(r.json()["instance"]["id"]))
    assert (inst.worker_id_chat, inst.worker_id_voice, inst.worker_id_media) == (None, None, None)


async def test_verbundener_server_zaehlt_erst_nach_dem_abholen_als_eingerichtet(
    client, session_factory
):
    konto = await _konto(client, "dm_vps")
    await _verbundener_eintrag(
        session_factory, iid=930001, hostname="fertig.example.com",
        besitzer=konto["id"], verbunden=True,
    )
    await _verbundener_eintrag(
        session_factory, iid=930002, hostname="halb.example.com",
        besitzer=konto["id"], verbunden=False,
    )
    r = await client.get("/me/instances", headers={"Cookie": konto["cookie"]})
    assert r.status_code == 200, r.text
    nach_id = {i["id"]: i for i in r.json()}
    assert nach_id["930001"]["set_up"] is True
    assert nach_id["930001"]["ohne_freigabe"] is True
    assert nach_id["930001"]["worker_id_chat"] is None
    assert nach_id["930001"]["role"] == "owner"
    assert nach_id["930002"]["set_up"] is False


async def test_admin_liste_zeigt_den_vermerk(client, session_factory):
    admin = await _konto(client, "dm_admin")  # erstes Konto = Bootstrap-Admin
    await _verbundener_eintrag(
        session_factory, iid=930003, hostname="admin-sicht.example.com",
        besitzer=admin["id"], verbunden=True,
    )
    r = await client.get(
        "/admin/instances", headers={"Authorization": f"Bearer {admin['token']}"}
    )
    assert r.status_code == 200, r.text
    (eintrag,) = [i for i in r.json() if i["id"] == "930003"]
    assert eintrag["ohne_freigabe"] is True
    assert eintrag["worker_id_chat"] is None
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_datenmodell.py`
Expected: `5 failed`, darunter `StopIteration` (Migration fehlt), `AttributeError: 'User' object has no attribute 'server_verbinden_gesperrt'`, `TypeError: 'ohne_freigabe' is an invalid keyword argument for RegisteredInstance` und `assert 100 is None` (Heim-Server bekommt noch Worker-IDs).

- [ ] **Step 3: Migration schreiben** (`services/auth/alembic/versions/20261010_1200_0056_verbinden.py`).

```python
"""verbinden — Server per Gerätecode mit einem Konto verbinden.

Seit Fassung 2 von ``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``
entsteht ein Server-Eintrag ohne Antrag: Der Betreiber bestätigt im Browser
einen Gerätecode, den sein Server angefragt hat (E1).

* ``worker_id_{chat,voice,media}`` werden nullable (E7): neue Einträge bekommen
  keine mehr. Kein Self-Host hat sie je gelesen (``07-render-env.sh`` setzt feste
  IDs), und der Vorrat war nach rund 307 Einträgen erschöpft.
* ``ohne_freigabe``: der Eintrag entstand über das Verbinden, nicht über einen
  freigegebenen Antrag. Nur ein Vermerk für die Admin-Übersicht.
* ``verbunden_at``: wann der Server seine Zugangsdaten abgeholt hat. Erst dann
  zählt er als eingerichtet (``_versorgte_instanzen``) — dieselbe Frage, die
  bei freigegebenen Servern das eingelöste Installer-Token beantwortet.
* ``users.server_verbinden_gesperrt``: Riegel für ein Konto, das nach einer
  Sperre immer neue Server verbindet (E8). Vorgabe aus.

Revision ID: 0056_verbinden
Revises: 0055_instanz_anzeige
Create Date: 2026-10-10 12:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# Revision-ID max. 32 Zeichen (``alembic_version.version_num`` ist varchar(32)).
revision: str = "0056_verbinden"
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
    op.add_column(
        "registered_instances",
        sa.Column("verbunden_at", sa.DateTime(timezone=True), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        "users",
        sa.Column(
            "server_verbinden_gesperrt",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        schema=SCHEMA,
    )


def downgrade() -> None:
    # Die Worker-Spalten bleiben nullable: zurück auf NOT NULL ginge nur, wenn
    # man die seither entstandenen Einträge samt Mitgliedschaften löschte.
    op.drop_column("users", "server_verbinden_gesperrt", schema=SCHEMA)
    op.drop_column("registered_instances", "verbunden_at", schema=SCHEMA)
    op.drop_column("registered_instances", "ohne_freigabe", schema=SCHEMA)
```

- [ ] **Step 4: Modelle anpassen.**

In `services/auth/src/dcc_auth/models_instances.py` die Zeilen 56–58 ersetzen:

```python
    # Seit Migration 0056 nullable: neue Einträge (verbundene Server, neue
    # Heim-Server) bekommen keine Worker-IDs mehr. Der Container hat sie nie
    # gelesen (feste IDs in 07-render-env.sh), und die Vergabe deckelte die
    # Zahl der Server bei ~307 (Spec 2026-10-09, E7).
    worker_id_chat: Mapped[int | None] = mapped_column(SmallInteger, nullable=True, unique=True)
    worker_id_voice: Mapped[int | None] = mapped_column(SmallInteger, nullable=True, unique=True)
    worker_id_media: Mapped[int | None] = mapped_column(SmallInteger, nullable=True, unique=True)
```

Direkt nach dem Block `online_gemeldet` (Zeilen 86–90) einfügen (`DateTime` ist dort schon importiert):

```python
    # Eintrag aus dem Verbinden per Gerätecode (Migration 0056,
    # ``verbinden_eintrag.py``) statt aus einem freigegebenen Antrag. Nur ein
    # Vermerk für die Admin-Übersicht — Tickets, Sperre und Mitgliedschaften
    # behandeln beide Arten gleich.
    ohne_freigabe: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
    # Wann der Server seine Zugangsdaten abgeholt hat
    # (``POST /selfhost/verbinden/abholen``). Erst ab da zählt er als
    # eingerichtet — vorher stünde er mit totem Status-Punkt in der Leiste.
    verbunden_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
```

In `services/auth/src/dcc_auth/models.py` direkt nach dem Block `self_host_enabled` (Zeilen 101–106) einfügen:

```python
    # Riegel gegen ein Konto, das nach einer Sperre immer neue Server verbindet
    # (Migration 0056, Spec 2026-10-09 E8). Bewusst eine eigene Spalte statt
    # ``self_host_enabled`` umzudeuten: das ist eine Freischaltung mit Vorgabe
    # aus und gehört weiter dem Server-App-Weg.
    server_verbinden_gesperrt: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
```

- [ ] **Step 5: Schemas und „eingerichtet“-Rechnung anpassen.**

`services/auth/src/dcc_auth/routes_instance_applications.py`, `InstanceOut` (Zeilen 118–120) ersetzen:

```python
    # ``None`` für Einträge ab Migration 0056 (verbundene und neue Heim-Server).
    worker_id_chat: int | None
    worker_id_voice: int | None
    worker_id_media: int | None
```

Nach `online: bool | None = None` (Zeile 154) einfügen:

```python
    # Eintrag aus dem Verbinden per Gerätecode statt aus einem Antrag.
    ohne_freigabe: bool = False
```

In `_instance_to_out` nach `online=inst.online_gemeldet if inst.origin == "app_host" else None,` (Zeile 205) einfügen:

```python
        ohne_freigabe=inst.ohne_freigabe,
```

In `_versorgte_instanzen` den Docstring-Absatz (Zeilen 217–221) ersetzen:

```python
    Dieselbe Frage wie ``bootstrap_redeemed`` — nur für viele Instanzen auf
    einmal, weil die Liste sie sonst einzeln stellen müsste (N+1). Es zählen
    DREI Wege: das eingelöste Installer-Token, der ``.env``-Download und seit
    Migration 0056 das Abholen beim Verbinden per Gerätecode
    (``verbunden_at``). Ein bloss ausgestelltes Token oder ein bestätigter,
    aber nie abgeholter Code zählt nicht; dort läuft noch kein Server.
```

und die Bedingung der zweiten Abfrage (Zeilen 242–243) ersetzen:

```python
                RegisteredInstance.id.in_(instanz_ids),
                RegisteredInstance.env_file_downloaded_at.is_not(None)
                | RegisteredInstance.verbunden_at.is_not(None),
```

`services/auth/src/dcc_auth/routes_admin_instances.py`, `InstanceOut` (Zeilen 78–80) ersetzen:

```python
    # ``None`` für Einträge ab Migration 0056 (verbundene und neue Heim-Server).
    worker_id_chat: int | None
    worker_id_voice: int | None
    worker_id_media: int | None
```

Nach `origin: str = "vps"` (Zeile 87) einfügen:

```python
    # Eintrag aus dem Verbinden per Gerätecode (Migration 0056). Die Oberfläche
    # zeigt den Vermerk „ohne Freigabe“ und bietet „Secret rotieren“ nur
    # freigegebenen Einträgen an.
    ohne_freigabe: bool = False
```

In `list_instances` nach `origin=row.origin,` (Zeile 183) einfügen:

```python
            ohne_freigabe=row.ohne_freigabe,
```

- [ ] **Step 6: Heim-Server ohne Worker-IDs** (`services/auth/src/dcc_auth/instance_provisioning.py`).

Zeile 29 löschen: `from dcc_auth.routes_admin_instances import _allocate_worker_ids`

Docstring-Absatz (Zeilen 83–86) ersetzen:

```python
    Läuft INNERHALB der Transaktion des Callers. client_id-Kollisionen werden
    per SAVEPOINT-Retry gefangen, ohne die äußere Transaktion (z.B.
    ``self_host_enabled``) zurückzurollen — der Caller committet am Ende alles
    gemeinsam. Worker-IDs vergibt die Funktion seit Migration 0056 nicht mehr
    (Spec 2026-10-09, E7): der Container liest sie nie, und ihr Vorrat war die
    einzige harte Obergrenze für die Zahl der Server.
```

In der Schleife die Zeile `wid_chat, wid_voice, wid_media = await _allocate_worker_ids(session)` (103) löschen und im `RegisteredInstance(...)` die drei Zeilen `worker_id_chat=wid_chat,` bis `worker_id_media=wid_media,` (111–113) löschen. Den `except`-Zweig und die Abschlussmeldung (Zeilen 130–137) ersetzen:

```python
        except IntegrityError:
            # SAVEPOINT zurückgerollt (client_id-Kollision) → neuer Versuch mit
            # frischen Werten. Die äußere Transaktion bleibt intakt.
            continue
    raise HTTPException(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="instance allocation conflict, try again",
    )
```

(Den Text `worker-id allocation conflict` prüft kein Test und keine Oberfläche. Geprüft mit `git grep -n "allocation conflict"`: nur hier und in `routes_admin_applications.py`, das unverändert bleibt.)

- [ ] **Step 7: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_datenmodell.py services/auth/tests/test_instance_selfservice.py services/auth/tests/test_admin_instances.py services/auth/tests/test_instance_applications_me.py services/auth/tests/test_migrations.py services/auth/tests/test_alembic_koepfe.py services/auth/tests/test_unified_applications.py services/auth/tests/test_instance_status.py`
Expected: `120 passed`.

- [ ] **Step 8: Migration gegen echtes Postgres prüfen.** Die SQLite-Tests fahren keine Migration (`create_all`). Prüfung auf einem Wegwerf-Container, nicht auf der Dev-DB:

```bash
docker run --rm -d --name pulse-mig-probe -e POSTGRES_PASSWORD=probe -e POSTGRES_USER=dcc -e POSTGRES_DB=dcc -p 127.0.0.1:5499:5432 postgres:16-alpine
until docker exec pulse-mig-probe pg_isready -U dcc -d dcc >/dev/null 2>&1; do sleep 0.5; done
docker exec pulse-mig-probe psql -U dcc -d dcc -qc "create schema auth; create schema chat;"
cd services/auth
POSTGRES_HOST=localhost POSTGRES_PORT=5499 POSTGRES_PASSWORD=probe uv run alembic upgrade head
POSTGRES_HOST=localhost POSTGRES_PORT=5499 POSTGRES_PASSWORD=probe uv run alembic downgrade -1
POSTGRES_HOST=localhost POSTGRES_PORT=5499 POSTGRES_PASSWORD=probe uv run alembic upgrade head
docker exec pulse-mig-probe psql -U dcc -d dcc -tAc "select version_num from auth.alembic_version"
cd ../..
docker rm -f pulse-mig-probe
```
Expected: drei Läufe ohne Fehler, zuletzt `Running upgrade 0055_instanz_anzeige -> 0056_verbinden`, Ausgabe `0056_verbinden`. (Am 2026-10-10 so nachgefahren. Ohne `create schema auth` scheitert schon der erste Lauf, weil die Prod-Initialisierung das Schema anlegt und nicht Alembic.)

- [ ] **Step 9: Vereinfachen.** `code-simplifier` über alle in Step 3–6 geänderten Dateien und den neuen Test, Step 7 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 10: Commit.**

```bash
git add services/auth/alembic/versions/20261010_1200_0056_verbinden.py \
  services/auth/src/dcc_auth/models_instances.py services/auth/src/dcc_auth/models.py \
  services/auth/src/dcc_auth/routes_instance_applications.py \
  services/auth/src/dcc_auth/routes_admin_instances.py \
  services/auth/src/dcc_auth/instance_provisioning.py \
  services/auth/tests/test_verbinden_datenmodell.py
git commit -m "feat(auth): Datenmodell für das Verbinden per Gerätecode (Migration 0056)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.3: Gerätecode und Redis-Vorgang (`dcc_auth/verbinden.py`)

**Woher bekommt auth-svc Redis?** `app.state.redis` wird im Lifespan gesetzt (`app.py:104-112`, `Redis.from_url(settings.redis_url, decode_responses=True)`) und ist `None`, wenn Redis fehlt. Die Routen holen ihn über `routes_suspended_instances._get_redis(request)` (Zeile 50: `getattr` plus `ping`, sonst `None`). In Tests läuft kein Lifespan (`httpx.ASGITransport`), deshalb setzen Tests `app.state.redis` selbst (Muster: `test_suspended_instances_endpoint.py:47-52`, `test_instance_status.py:57-62`). Bisher geschieht das dort nur mit Attrappen. Der neue Fixture `redis_echt` liefert einen echten Klienten auf `REDIS_URL`.

**Files:**
- Create: `services/auth/src/dcc_auth/verbinden.py`
- Modify: `services/auth/tests/conftest.py` (Fixture `redis_echt` am Dateiende, nach Zeile 156)
- Test: `services/auth/tests/test_verbinden.py` (neu)

**Interfaces:**
- Consumes: ein `redis.asyncio.Redis` mit `decode_responses=True` (wie `app.state.redis`).
- Produces (Vertrag, mit der oben genannten Abweichung bei `vorgang_entscheiden`):
  - `GUELTIG_S: int = 900`, `ABSTAND_S: int = 5`
  - `class VorgangLaeuft(Exception)`
  - `class Vorgang(BaseModel)`: `hostname: str`, `code: str` (ohne Bindestrich), `status: Literal["wartet", "bestaetigt", "abgelehnt"]`, `instance_id: str | None`, `user_id: str | None`, `gueltig_bis: str` (ISO 8601)
  - `neuer_code() -> str`, `code_anzeigen(code: str) -> str`, `code_normalisieren(roh: str) -> str | None`, `nachweis_aus_kennung(kennung: str) -> str`
  - `async vorgang_anlegen(redis, hostname: str, nachweis: str) -> Vorgang` (wirft `VorgangLaeuft`)
  - `async vorgang_per_code(redis, code: str) -> tuple[str, Vorgang] | None`
  - `async vorgang_per_nachweis(redis, nachweis: str) -> Vorgang | None`
  - `async vorgang_entscheiden(redis, nachweis: str, status, *, instance_id: str | None, user_id: str | None) -> bool`
  - `async vorgang_entnehmen(redis, nachweis: str) -> Vorgang | None`
  - Redis-Schlüssel wie im Vertrag: `auth:verbinden:vorgang:<nachweis>` (JSON), `auth:verbinden:code:<code>` → `<nachweis>`, beide 900 s.

- [ ] **Step 1: Fixture ergänzen.** Am Ende von `services/auth/tests/conftest.py` anfügen (`os`, `pytest_asyncio` und `AsyncIterator` sind dort schon importiert):

```python


@pytest_asyncio.fixture
async def redis_echt() -> AsyncIterator:
    """Ein echter Redis-Klient für den Verbinden-Vorgang (``verbinden.py``).

    Die übrigen auth-Tests kommen mit Attrappen aus, weil sie nur ``get``/
    ``set``/``publish`` brauchen. Der Vorgang hängt dagegen an Redis-Semantik,
    die eine Attrappe nur behaupten könnte: Ablaufzeiten, ``SET NX``,
    ``GETDEL`` und WATCH/MULTI. ``REDIS_URL`` setzt das Gate (seriell
    ``:6380/1``, parallel ein eigener Server je Worker, Wurzel-``conftest.py``).
    Geräumt werden nur die eigenen Schlüssel — DB 1 teilen sich im seriellen
    Lauf alle Dienste.
    """
    from redis.asyncio import Redis

    klient = Redis.from_url(
        os.environ.get("REDIS_URL", "redis://127.0.0.1:6380/1"), decode_responses=True
    )

    async def _raeumen() -> None:
        async for schluessel in klient.scan_iter(match="auth:verbinden:*"):
            await klient.delete(schluessel)

    await _raeumen()
    yield klient
    await _raeumen()
    await klient.aclose()
```

- [ ] **Step 2: Fehlschlagenden Test schreiben** (`services/auth/tests/test_verbinden.py`).

```python
"""Gerätecode und Redis-Vorgang des Verbindens (``dcc_auth/verbinden.py``).

Der Vorgang lebt 15 Minuten in Redis und ist der einzige Ort, an dem Cloud,
Browser und Server sich treffen: Der Server kennt seine Abholkennung, der
Browser den Code, die Cloud nur den Hash der Kennung.
"""

from __future__ import annotations

import asyncio
import hashlib

import pytest

from dcc_auth import verbinden as v

_NACHWEIS = hashlib.sha256(b"kennung-fuer-den-test").hexdigest()


def test_code_hat_acht_zeichen_aus_dem_crockford_alphabet():
    codes = {v.neuer_code() for _ in range(200)}
    assert len(codes) > 190
    for code in codes:
        assert len(code) == 8
        assert set(code) <= set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")


def test_code_wird_mit_bindestrich_angezeigt():
    assert v.code_anzeigen("K7QM2XDP") == "K7QM-2XDP"


@pytest.mark.parametrize(
    ("roh", "erwartet"),
    [
        ("K7QM-2XDP", "K7QM2XDP"),
        ("k7qm2xdp", "K7QM2XDP"),
        ("  k7qm - 2xdp ", "K7QM2XDP"),
        ("O0IL-1234", "00111234"),
        ("abcd-efgh", "ABCDEFGH"),
    ],
)
def test_eingabe_wird_normalisiert(roh, erwartet):
    assert v.code_normalisieren(roh) == erwartet


@pytest.mark.parametrize("roh", ["", "K7QM-2XD", "K7QM-2XDPP", "K7QM-2XDU", "K7QM_2XDP"])
def test_unbrauchbare_eingabe_ist_none(roh):
    assert v.code_normalisieren(roh) is None


def test_nachweis_ist_der_sha256_der_kennung():
    assert v.nachweis_aus_kennung("kennung-fuer-den-test") == _NACHWEIS


async def test_anlegen_und_finden(redis_echt):
    vorgang = await v.vorgang_anlegen(redis_echt, "neu.example.org", _NACHWEIS)
    assert vorgang.status == "wartet"
    assert vorgang.hostname == "neu.example.org"
    assert vorgang.instance_id is None and vorgang.user_id is None

    treffer = await v.vorgang_per_code(redis_echt, vorgang.code)
    assert treffer is not None
    assert treffer[0] == _NACHWEIS
    assert treffer[1] == vorgang
    assert await v.vorgang_per_nachweis(redis_echt, _NACHWEIS) == vorgang


async def test_beide_schluessel_laufen_nach_15_minuten_ab(redis_echt):
    vorgang = await v.vorgang_anlegen(redis_echt, "frist.example.org", _NACHWEIS)
    for schluessel in (
        f"auth:verbinden:vorgang:{_NACHWEIS}",
        f"auth:verbinden:code:{vorgang.code}",
    ):
        assert 0 < await redis_echt.ttl(schluessel) <= v.GUELTIG_S


async def test_zweites_anlegen_derselben_kennung_liefert_denselben_code(redis_echt):
    """Ein wiederholter Start (Netzfehler beim ersten) verbraucht keinen
    zweiten Code."""
    erster = await v.vorgang_anlegen(redis_echt, "wieder.example.org", _NACHWEIS)
    zweiter = await v.vorgang_anlegen(redis_echt, "wieder.example.org", _NACHWEIS)
    assert zweiter.code == erster.code


async def test_dieselbe_kennung_fuer_eine_andere_adresse_wird_abgelehnt(redis_echt):
    await v.vorgang_anlegen(redis_echt, "eins.example.org", _NACHWEIS)
    with pytest.raises(v.VorgangLaeuft):
        await v.vorgang_anlegen(redis_echt, "zwei.example.org", _NACHWEIS)


async def test_entschiedener_vorgang_wird_nicht_neu_ausgegeben(redis_echt):
    await v.vorgang_anlegen(redis_echt, "fertig.example.org", _NACHWEIS)
    await v.vorgang_entscheiden(redis_echt, _NACHWEIS, "abgelehnt", instance_id=None, user_id="1")
    with pytest.raises(v.VorgangLaeuft):
        await v.vorgang_anlegen(redis_echt, "fertig.example.org", _NACHWEIS)


async def test_entscheiden_geht_genau_einmal(redis_echt):
    await v.vorgang_anlegen(redis_echt, "einmal.example.org", _NACHWEIS)
    assert await v.vorgang_entscheiden(
        redis_echt, _NACHWEIS, "bestaetigt", instance_id="42", user_id="7"
    )
    assert not await v.vorgang_entscheiden(
        redis_echt, _NACHWEIS, "abgelehnt", instance_id=None, user_id="8"
    )
    vorgang = await v.vorgang_per_nachweis(redis_echt, _NACHWEIS)
    assert (vorgang.status, vorgang.instance_id, vorgang.user_id) == ("bestaetigt", "42", "7")
    # Die Frist läuft weiter; eine Entscheidung verlängert sie nicht.
    assert 0 < await redis_echt.ttl(f"auth:verbinden:vorgang:{_NACHWEIS}") <= v.GUELTIG_S


async def test_entscheiden_ohne_vorgang_ist_false(redis_echt):
    assert not await v.vorgang_entscheiden(
        redis_echt, _NACHWEIS, "bestaetigt", instance_id="1", user_id="1"
    )


async def test_gleichzeitiges_entscheiden_hat_genau_einen_gewinner(redis_echt):
    await v.vorgang_anlegen(redis_echt, "rennen.example.org", _NACHWEIS)
    ergebnisse = await asyncio.gather(
        *(
            v.vorgang_entscheiden(
                redis_echt, _NACHWEIS, "bestaetigt", instance_id=str(i), user_id=str(i)
            )
            for i in range(5)
        )
    )
    assert sorted(ergebnisse) == [False, False, False, False, True]


async def test_entnehmen_raeumt_beide_schluessel_und_geht_nur_einmal(redis_echt):
    vorgang = await v.vorgang_anlegen(redis_echt, "weg.example.org", _NACHWEIS)
    entnommen, nochmal = await asyncio.gather(
        v.vorgang_entnehmen(redis_echt, _NACHWEIS),
        v.vorgang_entnehmen(redis_echt, _NACHWEIS),
    )
    assert [entnommen, nochmal].count(None) == 1
    assert await v.vorgang_per_code(redis_echt, vorgang.code) is None
    assert await redis_echt.exists(f"auth:verbinden:code:{vorgang.code}") == 0


async def test_fremder_code_trifft_keinen_vorgang(redis_echt):
    await v.vorgang_anlegen(redis_echt, "fremd.example.org", _NACHWEIS)
    assert await v.vorgang_per_code(redis_echt, "ZZZZZZZZ") is None
```

- [ ] **Step 3: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden.py`
Expected: Sammelfehler `ImportError: cannot import name 'verbinden' from 'dcc_auth'`.

- [ ] **Step 4: Umsetzen** (`services/auth/src/dcc_auth/verbinden.py`).

```python
"""Gerätecode und Vorgang beim Verbinden eines Servers mit einem Konto.

Ablauf nach dem Muster „Device Authorization Grant“ (RFC 8628; Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E1):
Der Server fragt einen Code an, der Betreiber bestätigt ihn im Browser, der
Server holt danach mit seiner geheimen Abholkennung die Zugangsdaten ab.

Der Vorgang lebt nur in Redis, 15 Minuten lang, unter zwei Schlüsseln:

* ``auth:verbinden:vorgang:<nachweis>`` — der Zustand (JSON, ``Vorgang``).
  Der Nachweis ist der SHA-256 der Abholkennung. Die Kennung selbst speichert
  die Cloud nie; wer nur den Speicher sieht, kann nichts abholen.
* ``auth:verbinden:code:<code>`` — Verweis vom Anzeigecode auf den Nachweis,
  damit die Bestätigungsseite den Vorgang findet.

Kein Datenbank-Eintrag: ein nie bestätigter Code hinterlässt nichts, und die
Frist erledigt Redis selbst.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel
from redis.exceptions import WatchError

#: Gültigkeit eines Codes in Sekunden (E1: 15 Minuten).
GUELTIG_S = 900
#: Abstand, in dem der Server abholen soll. Die Bremse in ``config.py``
#: (``rate_limit_verbinden_abholen``) lässt das Doppelte zu.
ABSTAND_S = 5

# Crockford-Base32: ohne I, L, O, U — nichts, was sich beim Abtippen mit einer
# Ziffer oder einem anderen Buchstaben verwechseln lässt.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_VERWECHSLUNG = str.maketrans({"O": "0", "I": "1", "L": "1"})
_CODE_LAENGE = 8
_PRAEFIX = "auth:verbinden:"

Status = Literal["wartet", "bestaetigt", "abgelehnt"]


class VorgangLaeuft(Exception):
    """Für diese Abholkennung läuft schon ein Vorgang für eine andere Adresse."""


class Vorgang(BaseModel):
    hostname: str
    code: str
    status: Status = "wartet"
    instance_id: str | None = None
    user_id: str | None = None
    gueltig_bis: str


def _vorgang_schluessel(nachweis: str) -> str:
    return f"{_PRAEFIX}vorgang:{nachweis}"


def _code_schluessel(code: str) -> str:
    return f"{_PRAEFIX}code:{code}"


def neuer_code() -> str:
    """Acht Zeichen, 40 Bit — genug für 15 Minuten bei gebremstem Raten."""
    return "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LAENGE))


def code_anzeigen(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def code_normalisieren(roh: str) -> str | None:
    """Die Eingabe des Betreibers in die Speicherform, oder ``None``.

    Groß/klein, Leerraum und Bindestriche sind egal; ``O``/``I``/``L`` werden
    als die Ziffern gelesen, mit denen man sie verwechselt.
    """
    code = "".join(roh.split()).replace("-", "").upper().translate(_VERWECHSLUNG)
    if len(code) != _CODE_LAENGE or any(z not in _ALPHABET for z in code):
        return None
    return code


def nachweis_aus_kennung(kennung: str) -> str:
    return hashlib.sha256(kennung.encode()).hexdigest()


async def vorgang_per_nachweis(redis, nachweis: str) -> Vorgang | None:
    roh = await redis.get(_vorgang_schluessel(nachweis))
    return Vorgang.model_validate_json(roh) if roh is not None else None


async def vorgang_anlegen(redis, hostname: str, nachweis: str) -> Vorgang:
    """Legt den Vorgang an; ein wiederholter Start liefert den laufenden.

    Wiederholt heisst: dieselbe Kennung für dieselbe Adresse, noch nicht
    entschieden — der Server hat nach einem Netzfehler noch einmal gefragt.
    Sonst wird nichts überschrieben (``VorgangLaeuft``): ein zweiter Aufruf
    könnte einen schon gezeigten Code still entwerten oder ein Ergebnis
    zurücksetzen, das noch auf das Abholen wartet.
    """
    laufend = await vorgang_per_nachweis(redis, nachweis)
    if laufend is not None:
        if laufend.hostname != hostname or laufend.status != "wartet":
            raise VorgangLaeuft
        return laufend

    # Zwei gleichzeitige Vorgänge mit demselben Code dürfen nicht entstehen:
    # die Bestätigungsseite fände sonst den falschen Server.
    for _ in range(5):
        code = neuer_code()
        if await redis.set(_code_schluessel(code), nachweis, ex=GUELTIG_S, nx=True):
            break
    else:
        raise RuntimeError("kein freier Gerätecode gefunden")

    ende = datetime.now(UTC).replace(microsecond=0) + timedelta(seconds=GUELTIG_S)
    vorgang = Vorgang(hostname=hostname, code=code, gueltig_bis=ende.isoformat())
    if not await redis.set(
        _vorgang_schluessel(nachweis), vorgang.model_dump_json(), ex=GUELTIG_S, nx=True
    ):
        # Ein gleichzeitiger Start mit derselben Kennung war schneller.
        await redis.delete(_code_schluessel(code))
        raise VorgangLaeuft
    return vorgang


async def vorgang_per_code(redis, code: str) -> tuple[str, Vorgang] | None:
    """``code`` in Speicherform (``code_normalisieren``)."""
    nachweis = await redis.get(_code_schluessel(code))
    if nachweis is None:
        return None
    vorgang = await vorgang_per_nachweis(redis, nachweis)
    if vorgang is None or vorgang.code != code:
        return None
    return nachweis, vorgang


async def vorgang_entscheiden(
    redis,
    nachweis: str,
    status: Status,
    *,
    instance_id: str | None,
    user_id: str | None,
) -> bool:
    """Setzt das Ergebnis, aber nur aus ``wartet`` heraus — ``True`` bei Erfolg.

    Ein Code wird genau einmal entschieden: Zwei Tabs, ein Doppelklick oder
    zwei Menschen, die denselben Code gesehen haben, ergeben genau einen
    Gewinner. Der Aufrufer committet seine Datenbank-Arbeit erst, wenn hier
    ``True`` kam. Die Frist läuft weiter (``KEEPTTL``).
    """
    schluessel = _vorgang_schluessel(nachweis)
    async with redis.pipeline(transaction=True) as pipe:
        try:
            await pipe.watch(schluessel)
            roh = await pipe.get(schluessel)
            if roh is None:
                return False
            vorgang = Vorgang.model_validate_json(roh)
            if vorgang.status != "wartet":
                return False
            neu = vorgang.model_copy(
                update={"status": status, "instance_id": instance_id, "user_id": user_id}
            )
            pipe.multi()
            pipe.set(schluessel, neu.model_dump_json(), xx=True, keepttl=True)
            await pipe.execute()
        except WatchError:
            return False
    return True


async def vorgang_entnehmen(redis, nachweis: str) -> Vorgang | None:
    """Holt den Vorgang und löscht beide Schlüssel; gelingt genau einem Aufrufer.

    ``GETDEL`` ist atomar — zwei gleichzeitige Abholungen bekommen nie beide
    Zugangsdaten.
    """
    roh = await redis.getdel(_vorgang_schluessel(nachweis))
    if roh is None:
        return None
    vorgang = Vorgang.model_validate_json(roh)
    await redis.delete(_code_schluessel(vorgang.code))
    return vorgang
```

- [ ] **Step 5: Test laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden.py`
Expected: `23 passed`. Danach einmal parallel, um den Fixture auch mit eigenem Redis je Worker zu sehen: dieselbe Zeile mit `-n 4` → `23 passed`.

- [ ] **Step 6: Vereinfachen.** `code-simplifier` über `verbinden.py`, `conftest.py` und `test_verbinden.py`, Step 5 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 7: Commit.**

```bash
git add services/auth/src/dcc_auth/verbinden.py services/auth/tests/conftest.py \
  services/auth/tests/test_verbinden.py
git commit -m "feat(auth): Gerätecode und Redis-Vorgang für das Verbinden

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.4: Nachweis von außen prüfen (`dcc_auth/verbinden_nachweis.py`)

**Wie die Nachbarn httpx benutzen:** Die Erreichbarkeitsprüfung löst den Namen einmal auf und verwirft private Netze (`selfhost_probe.py:108` `pruefe_dns`). Danach verbindet sie über `Ziel` an die geprüfte IP, mit dem echten Namen im `Host`-Kopf und als SNI (`selfhost_probe_dienst.py:28-61`, Grund: DNS-Rebinding). Den Klienten baut sie mit `httpx.AsyncClient(follow_redirects=False, verify=True)` (`routes_selfhost_diagnose.py:163`). Die Tests ersetzen den Klienten durch `httpx.AsyncClient(transport=httpx.MockTransport(handler))` (`test_selfhost_probe_betreiber.py:30-36`) und Hilfsfunktionen per `monkeypatch` (`test_selfhost_diagnose.py:339`). Kein `respx`. Die Nachweis-Route ist anonym, deshalb gilt dieselbe Absicherung, und die Antwort wird nur bis 4 KiB gelesen.

**Files:**
- Create: `services/auth/src/dcc_auth/verbinden_nachweis.py`
- Test: `services/auth/tests/test_verbinden_nachweis.py` (neu)

**Interfaces:**
- Consumes: `pruefe_dns(host: str) -> Schritt` (`selfhost_probe.py:108`), `Schritt` (`selfhost_probe.py:88`), `Ziel(host: str, adresse: str)` mit `.url(pfad)`, `.kopf()`, `.sni` (`selfhost_probe_dienst.py:28`).
- Produces:
  - `PFAD = "/.well-known/pulse-verbinden"`, `FRIST_S = 8.0`
  - `async nachweis_pruefen(hostname: str, erwartet: str) -> str | None`. `None` heißt in Ordnung, sonst einer der Befunde `"nicht_erreichbar" | "zertifikat" | "kein_nachweis" | "falscher_wert"`.
  - `async nachweis_lesen(klient: httpx.AsyncClient, ziel: Ziel, erwartet: str) -> str | None` ist der testbare Kern.
  - Erwartete Antwort des Servers (Etappe 2): `200 {"nachweis": "<64 Hex>"}`.

- [ ] **Step 1: Fehlschlagenden Test schreiben** (`services/auth/tests/test_verbinden_nachweis.py`).

```python
"""Nachweis, dass unter einer Adresse wirklich der anfragende Server läuft.

Die Cloud ruft ``https://<adresse>/.well-known/pulse-verbinden`` ab und
erwartet dort den SHA-256 der Abholkennung (Spec 2026-10-09, E2). Jeder
Befund führt beim Betreiber zu einem anderen Handgriff — deshalb trennen die
Tests sie einzeln.
"""

from __future__ import annotations

import asyncio
import hashlib
import ssl

import httpx
import pytest

from dcc_auth import verbinden_nachweis as vn
from dcc_auth.selfhost_probe import Schritt
from dcc_auth.selfhost_probe_dienst import Ziel

_ERWARTET = hashlib.sha256(b"kennung").hexdigest()


def _ziel() -> Ziel:
    return Ziel("pulse.example.com", "203.0.113.7")


def _klient(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _antwort(antwort: httpx.Response):
    def handler(_request: httpx.Request) -> httpx.Response:
        return antwort

    return handler


async def _lesen(handler) -> str | None:
    async with _klient(handler) as klient:
        return await vn.nachweis_lesen(klient, _ziel(), _ERWARTET)


async def test_passender_nachweis_ist_in_ordnung():
    gesehen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(request)
        return httpx.Response(200, json={"nachweis": _ERWARTET})

    assert await _lesen(handler) is None
    # Die Anfrage geht an die geprüfte IP, der Name reist im Host-Kopf: sonst
    # löste httpx den Namen ein zweites Mal auf (selfhost_probe_dienst.Ziel).
    (anfrage,) = gesehen
    assert str(anfrage.url) == "https://203.0.113.7/.well-known/pulse-verbinden"
    assert anfrage.headers["host"] == "pulse.example.com"


async def test_grossbuchstaben_und_leerraum_stoeren_nicht():
    handler = _antwort(httpx.Response(200, json={"nachweis": f" {_ERWARTET.upper()}\n"}))
    assert await _lesen(handler) is None


async def test_anderer_wert():
    andere = hashlib.sha256(b"andere").hexdigest()
    assert await _lesen(_antwort(httpx.Response(200, json={"nachweis": andere}))) == (
        "falscher_wert"
    )


@pytest.mark.parametrize(
    "antwort",
    [
        httpx.Response(404, json={"detail": "Not Found"}),
        httpx.Response(301, headers={"Location": "https://anderswo.example.com/"}),
        # Der SPA-Rückfall eines fremden Proxys: 200, aber HTML.
        httpx.Response(200, text="<!doctype html><title>Pulse</title>"),
        httpx.Response(200, json=["kein", "objekt"]),
        httpx.Response(200, json={"nachweis": 42}),
        httpx.Response(200, json={"nachweis": "zu-kurz"}),
        httpx.Response(200, content=b'{"nachweis": "' + b"a" * 5000 + b'"}'),
    ],
)
async def test_kein_nachweis(antwort):
    assert await _lesen(_antwort(antwort)) == "kein_nachweis"


async def test_zertifikat_wird_erkannt():
    def handler(request: httpx.Request) -> httpx.Response:
        try:
            raise ssl.SSLCertVerificationError(1, "certificate verify failed")
        except ssl.SSLCertVerificationError as exc:
            raise httpx.ConnectError(
                "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed",
                request=request,
            ) from exc

    assert await _lesen(handler) == "zertifikat"


async def test_verbindungsfehler_heisst_nicht_erreichbar():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    assert await _lesen(handler) == "nicht_erreichbar"


async def test_frist(monkeypatch):
    monkeypatch.setattr(vn, "FRIST_S", 0.05)

    async def handler(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return httpx.Response(200, json={"nachweis": _ERWARTET})

    assert await _lesen(handler) == "nicht_erreichbar"


async def test_adresse_im_privaten_netz_wird_nie_abgefragt(monkeypatch):
    async def dns(_host):
        return Schritt("dns", False, "zeigt_ins_private_netz", "10.0.0.5")

    def darf_nicht():
        raise AssertionError("kein HTTP-Aufruf ohne geprüfte Adresse")

    monkeypatch.setattr(vn, "pruefe_dns", dns)
    monkeypatch.setattr(vn, "_klient", darf_nicht)
    assert await vn.nachweis_pruefen("pulse.example.com", _ERWARTET) == "nicht_erreichbar"


async def test_ganzer_weg_ueber_die_aufgeloeste_adresse(monkeypatch):
    async def dns(_host):
        return Schritt("dns", True, "aufgeloest", adressen=["203.0.113.7"])

    gesehen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        gesehen.append(str(request.url))
        return httpx.Response(200, json={"nachweis": _ERWARTET})

    monkeypatch.setattr(vn, "pruefe_dns", dns)
    monkeypatch.setattr(vn, "_klient", lambda: _klient(handler))
    assert await vn.nachweis_pruefen("pulse.example.com", _ERWARTET) is None
    assert gesehen == ["https://203.0.113.7/.well-known/pulse-verbinden"]
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_nachweis.py`
Expected: Sammelfehler `ImportError: cannot import name 'verbinden_nachweis' from 'dcc_auth'`.

- [ ] **Step 3: Umsetzen** (`services/auth/src/dcc_auth/verbinden_nachweis.py`).

```python
"""Nachweis beim Verbinden: läuft unter dieser Adresse der anfragende Server?

Der Server legt den SHA-256 seiner Abholkennung unter
``/.well-known/pulse-verbinden`` ab; nur er kennt die Kennung (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E2).
Die Cloud prüft das beim Anfragen des Codes und noch einmal vor dem Eintragen.
Das verhindert, dass jemand eine fremde Adresse für sich einträgt, und macht
einen Besitzerwechsel eindeutig: Es gewinnt, wer die Adresse nachweislich
gerade betreibt.

Die Route dahinter ist anonym — die Cloud ruft hier auf Zuruf eines
Unbekannten einen fremden Rechner auf. Deshalb dieselbe Absicherung wie bei
der Erreichbarkeitsprüfung: erst auflösen und private Netze verwerfen
(``pruefe_dns``), dann an die geprüfte IP verbinden (``Ziel``), Zertifikat
voll geprüft, keine Weiterleitungen, und die Antwort nur bis zu einer festen
Grösse lesen.
"""

from __future__ import annotations

import asyncio
import json
import re
import ssl

import httpx

from dcc_auth.selfhost_probe import pruefe_dns
from dcc_auth.selfhost_probe_dienst import Ziel

PFAD = "/.well-known/pulse-verbinden"
#: Ganze Prüfung höchstens so lange — ein Betreiber wartet im Terminal darauf.
FRIST_S = 8.0
# Die echte Antwort hat unter 100 Bytes. Mehr liest die Cloud von einem
# Unbekannten nicht.
_HOECHSTENS_BYTES = 4096
_HEX64 = re.compile(r"[0-9a-f]{64}")


def _klient() -> httpx.AsyncClient:
    return httpx.AsyncClient(follow_redirects=False, verify=True)


def _zertifikatsfehler(exc: BaseException) -> bool:
    """httpx verpackt den TLS-Fehler zweimal (httpcore, dann httpx); die
    Ursache steht unten in der Kette."""
    kette: BaseException | None = exc
    for _ in range(10):
        if kette is None:
            return False
        if isinstance(kette, ssl.SSLCertVerificationError) or (
            "CERTIFICATE_VERIFY_FAILED" in str(kette)
        ):
            return True
        kette = kette.__cause__ or kette.__context__
    return False


async def nachweis_lesen(klient: httpx.AsyncClient, ziel: Ziel, erwartet: str) -> str | None:
    """``None`` = in Ordnung, sonst der Befund."""
    roh = bytearray()
    try:
        async with asyncio.timeout(FRIST_S):
            async with klient.stream(
                "GET", ziel.url(PFAD), headers=ziel.kopf(), extensions=ziel.sni
            ) as antwort:
                if antwort.status_code != 200:
                    return "kein_nachweis"
                async for stueck in antwort.aiter_bytes():
                    roh += stueck
                    if len(roh) > _HOECHSTENS_BYTES:
                        return "kein_nachweis"
    except Exception as exc:  # noqa: BLE001 — jeder Fehler hier ist ein Befund
        return "zertifikat" if _zertifikatsfehler(exc) else "nicht_erreichbar"

    try:
        gemeldet = json.loads(roh)["nachweis"]
    except (ValueError, KeyError, TypeError):
        return "kein_nachweis"
    if not isinstance(gemeldet, str) or not _HEX64.fullmatch(gemeldet.strip().lower()):
        return "kein_nachweis"
    # Kein Vergleich in konstanter Zeit nötig: der Wert ist öffentlich, er
    # steht ja unter der Adresse für jeden lesbar.
    if gemeldet.strip().lower() != erwartet:
        return "falscher_wert"
    return None


async def nachweis_pruefen(hostname: str, erwartet: str) -> str | None:
    """``None`` = in Ordnung, sonst ``nicht_erreichbar`` | ``zertifikat`` |
    ``kein_nachweis`` | ``falscher_wert``.

    Eine Adresse, die ins private Netz zeigt, heisst nach aussen schlicht
    ``nicht_erreichbar`` — der anonyme Aufrufer soll aus dem Befund nichts
    über das Netz der Cloud lernen.
    """
    dns = await pruefe_dns(hostname)
    if not dns.ok:
        return "nicht_erreichbar"
    async with _klient() as klient:
        return await nachweis_lesen(klient, Ziel(hostname, dns.adressen[0]), erwartet)
```

- [ ] **Step 4: Test laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_nachweis.py`
Expected: `15 passed`.

Optional, mit Netz: `_zertifikatsfehler` gegen echte TLS-Fehler. Am 2026-10-10 nachgefahren: `self-signed.badssl.com` und `wrong.host.badssl.com` ergeben `True`, `https://127.0.0.1:1/` (Verbindung verweigert) ergibt `False`.

```bash
uv run --all-packages python -c "
import asyncio, httpx
from dcc_auth.verbinden_nachweis import _zertifikatsfehler
async def m():
    for u in ('https://self-signed.badssl.com/', 'https://127.0.0.1:1/'):
        try:
            async with httpx.AsyncClient(timeout=10) as k: await k.get(u)
        except Exception as e: print(u, _zertifikatsfehler(e))
asyncio.run(m())"
```

- [ ] **Step 5: Vereinfachen.** `code-simplifier` über beide Dateien, Step 4 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 6: Commit.**

```bash
git add services/auth/src/dcc_auth/verbinden_nachweis.py services/auth/tests/test_verbinden_nachweis.py
git commit -m "feat(auth): Nachweis prüfen, dass unter der Adresse der anfragende Server läuft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.5: Zugangsdaten-Ausgabe aus dem Bootstrap herausziehen (`dcc_auth/zugangsdaten.py`)

Reines Refactoring des Bootstrap-Wegs. Die Antwort von `POST /selfhost/bootstrap` bleibt in Feldern und Werten identisch (CLAUDE.md: „Refactoring darf Verhalten nicht ändern“).

**Files:**
- Create: `services/auth/src/dcc_auth/zugangsdaten.py`
- Modify: `services/auth/src/dcc_auth/routes_selfhost_bootstrap.py:20-41` (Importe), `:49-59` (`BootstrapCredsOut`), `:110-113` (Secret-Rotation), `:141-171` (Besitzer, Mitgliedschaft, Antwort)
- Test: `services/auth/tests/test_zugangsdaten.py` (neu)
- Müssen grün bleiben: `services/auth/tests/test_bootstrap_token.py` (13 Tests, u. a. `test_redeem_happy_and_rotates_secret`, `test_redeem_is_single_use`, `test_redeem_expired`), `services/auth/tests/test_relay_provisioning.py` (20 Tests, Relay-Felder im Bootstrap-Weg, u. a. `test_redeem_assigns_relay_when_enabled`, `test_redeem_vps_gets_no_relay`) und `services/auth/tests/test_instance_selfservice.py` (5 Tests, `test_voller_durchlauf_selbstbedienung_bis_container_env` löst ein Token ein).

**Interfaces:**
- Consumes: `hash_password` (`security.py`), `User`, `RegisteredInstance`, `UserInstanceMembership`, `Settings` (`config.py`).
- Produces:
  - `class ZugangsdatenOut(BaseModel)`: `instance_id`, `owner_user_id`, `hostname`, `client_id`, `client_secret`, `cloud_origin` (alle `str`), `admin_email: str | None = None`
  - `async zugangsdaten_ausgeben(db: AsyncSession, instance: RegisteredInstance, settings: Settings) -> ZugangsdatenOut`. Rotiert das Secret und stellt die Besitzer-Mitgliedschaft sicher. **Committet nicht.**
  - `BootstrapCredsOut(ZugangsdatenOut)` mit den drei Relay-Feldern wie bisher.

- [ ] **Step 1: Fehlschlagenden Test schreiben** (`services/auth/tests/test_zugangsdaten.py`).

```python
"""Zugangsdaten ausgeben — ein Weg für Installer-Token und Verbinden.

``zugangsdaten_ausgeben`` rotiert das Secret und stellt die
Besitzer-Mitgliedschaft sicher. Bootstrap-Einlösung und Abholen beim
Verbinden benutzen beide diese Funktion; was hier nicht stimmt, stimmt in
beiden Wegen nicht.
"""

from __future__ import annotations

from sqlalchemy import select

from dcc_auth.config import get_settings
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.security import verify_password
from dcc_auth.zugangsdaten import zugangsdaten_ausgeben

_ALT = "$argon2id$v=19$m=65536,t=3,p=4$alterhash"


async def _besitzer(client) -> int:
    reg = {
        "username": "zd_alice",
        "email": "zd_alice@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": "Alice",
    }
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    me = await client.get(
        "/me", headers={"Cookie": f"pulse_session={r.cookies.get('pulse_session')}"}
    )
    return int(me.json()["id"])


async def _instanz(session_factory, besitzer: int) -> None:
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=940001,
                hostname="zugang.example.com",
                client_id="zd-client",
                client_secret=_ALT,
                status="active",
                origin="vps",
                registered_by=besitzer,
            )
        )
        await s.commit()


async def _mitgliedschaften(session_factory) -> list[UserInstanceMembership]:
    async with session_factory() as s:
        return list(
            (
                await s.execute(
                    select(UserInstanceMembership).where(
                        UserInstanceMembership.instance_id == 940001
                    )
                )
            ).scalars()
        )


async def test_felder_secret_und_mitgliedschaft(client, session_factory):
    besitzer = await _besitzer(client)
    await _instanz(session_factory, besitzer)

    async with session_factory() as db:
        inst = await db.get(RegisteredInstance, 940001)
        zugang = await zugangsdaten_ausgeben(db, inst, get_settings())
        await db.commit()

    assert zugang.instance_id == "940001"
    assert zugang.owner_user_id == str(besitzer)
    assert zugang.hostname == "zugang.example.com"
    assert zugang.client_id == "zd-client"
    assert zugang.cloud_origin == get_settings().pulse_oidc_issuer
    assert zugang.admin_email == "zd_alice@dcc-test.example.com"
    async with session_factory() as s:
        gespeichert = (await s.get(RegisteredInstance, 940001)).client_secret
    assert gespeichert != _ALT
    assert verify_password(zugang.client_secret, gespeichert)
    (mitglied,) = await _mitgliedschaften(session_factory)
    assert (mitglied.user_id, mitglied.role) == (besitzer, "owner")


async def test_vorhandene_mitgliedschaft_bleibt_einzeln(client, session_factory):
    besitzer = await _besitzer(client)
    await _instanz(session_factory, besitzer)
    async with session_factory() as s:
        s.add(UserInstanceMembership(user_id=besitzer, instance_id=940001, role="owner"))
        await s.commit()

    for _ in range(2):
        async with session_factory() as db:
            inst = await db.get(RegisteredInstance, 940001)
            await zugangsdaten_ausgeben(db, inst, get_settings())
            await db.commit()

    assert len(await _mitgliedschaften(session_factory)) == 1
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_zugangsdaten.py`
Expected: Sammelfehler `ModuleNotFoundError: No module named 'dcc_auth.zugangsdaten'`.

- [ ] **Step 3: Modul anlegen** (`services/auth/src/dcc_auth/zugangsdaten.py`).

```python
"""Zugangsdaten eines Servers ausgeben — ein Weg für zwei Eingänge.

Zwei Routen händigen einem Server seine Zugangsdaten aus: die Einlösung des
Installer-Tokens (``routes_selfhost_bootstrap.py``, Server-App und
freigegebene Server) und das Abholen nach dem Verbinden per Gerätecode
(``routes_verbinden.py``). Beide müssen dasselbe tun — Secret rotieren,
Besitzer als Mitglied eintragen, dieselben Felder liefern —, sonst bekäme ein
verbundener Server andere Werte als ein freigegebener, und
``07-render-env.sh`` müsste zwei Formen kennen.

Committet nicht: der Aufrufer hat jeweils eigenen Zustand, der in derselben
Transaktion landen muss (eingelöstes Token, ``verbunden_at``).
"""

from __future__ import annotations

import asyncio
import secrets

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.config import Settings
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.security import hash_password


class ZugangsdatenOut(BaseModel):
    instance_id: str
    owner_user_id: str
    hostname: str
    client_id: str
    client_secret: str
    cloud_origin: str
    admin_email: str | None = None


async def zugangsdaten_ausgeben(
    db: AsyncSession, instance: RegisteredInstance, settings: Settings
) -> ZugangsdatenOut:
    """Rotiert das Secret (Klartext nur in der Rückgabe) und stellt die
    Besitzer-Mitgliedschaft sicher. Secret wird NIE geloggt."""
    new_secret = secrets.token_urlsafe(32)
    instance.client_secret = await asyncio.to_thread(hash_password, new_secret)

    owner = await db.get(User, instance.registered_by)
    admin_email = owner.email if owner is not None else None

    # Owner-Membership in der Cloud tracken (= Account-basierte Server-Liste,
    # ersetzt den Zero-Knowledge-Vault). Genehmigung und Verbinden legen sie
    # bereits an; bei wiederholter Ausgabe (oder einem vor diesem Fix
    # genehmigten Antrag) existiert sie ggf. schon → nur einfügen, wenn noch
    # keine da ist (ein blindes INSERT würde am Composite-PK mit
    # IntegrityError crashen).
    existing_membership = await db.get(
        UserInstanceMembership, (instance.registered_by, instance.id)
    )
    if existing_membership is None:
        db.add(
            UserInstanceMembership(
                user_id=instance.registered_by,
                instance_id=instance.id,
                role="owner",
            )
        )

    return ZugangsdatenOut(
        instance_id=str(instance.id),
        owner_user_id=str(instance.registered_by),
        hostname=instance.hostname,
        client_id=instance.client_id,
        client_secret=new_secret,
        cloud_origin=settings.pulse_oidc_issuer,
        admin_email=admin_email,
    )
```

- [ ] **Step 4: Bootstrap umstellen** (`services/auth/src/dcc_auth/routes_selfhost_bootstrap.py`).

Den Importblock (Zeilen 20–41) ersetzen:

```python
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select

from dcc_auth.bootstrap import TOKEN_PREFIX, hash_bootstrap_token
from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models_instances import InstanceBootstrapToken, RegisteredInstance
from dcc_auth.relay import allocate_relay_subdomain, generate_relay_token, hash_relay_token
from dcc_auth.routes import _check_rate
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.zugangsdaten import ZugangsdatenOut, zugangsdaten_ausgeben
```

`BootstrapCredsOut` (Zeilen 49–59) ersetzen:

```python
class BootstrapCredsOut(ZugangsdatenOut):
    """Die gemeinsamen Felder (``zugangsdaten.py``) plus die Relay-Felder, die
    nur der Weg über das Installer-Token kennt."""

    relay_subdomain: str | None = None
    relay_server_addr: str | None = None
    relay_tunnel_token: str | None = None
```

Die Secret-Rotation (Zeilen 110–113) ersetzen:

```python
    # Token verbrennen + Secret rotieren (Klartext nur in der Antwort).
    row.consumed_at = now
    zugang = await zugangsdaten_ausgeben(db, instance, settings)
```

Von `owner = await db.get(User, instance.registered_by)` (Zeile 141) bis einschließlich `relay_subdomain=relay_subdomain,` in der Antwort (Zeile 171) ersetzen. Der Relay-Block davor (Zeilen 115–139) bleibt unverändert:

```python
    await db.commit()

    return BootstrapCredsOut(
        **zugang.model_dump(),
        relay_subdomain=relay_subdomain,
```

Die restlichen Zeilen der Antwort (Kommentar `# Ohne Provisioning auch keine Server-Adresse …`, `relay_server_addr=(…)`, `relay_tunnel_token=relay_token_plain,`, `)`) bleiben unverändert. Danach darf die Datei weder `asyncio`, `secrets`, `BaseModel`, `User`, `UserInstanceMembership` noch `hash_password` importieren. Prüfen mit `grep -nE "^import (asyncio|secrets)|BaseModel|hash_password|UserInstanceMembership|import User" services/auth/src/dcc_auth/routes_selfhost_bootstrap.py`: erwartet keine Ausgabe.

- [ ] **Step 5: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_zugangsdaten.py services/auth/tests/test_bootstrap_token.py services/auth/tests/test_relay_provisioning.py services/auth/tests/test_instance_selfservice.py`
Expected: `40 passed`.

- [ ] **Step 6: Vereinfachen.** `code-simplifier` über `zugangsdaten.py`, `routes_selfhost_bootstrap.py` und `test_zugangsdaten.py`, Step 5 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 7: Commit.**

```bash
git add services/auth/src/dcc_auth/zugangsdaten.py \
  services/auth/src/dcc_auth/routes_selfhost_bootstrap.py services/auth/tests/test_zugangsdaten.py
git commit -m "refactor(auth): Zugangsdaten-Ausgabe aus dem Bootstrap herausziehen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.6: Server-Eintrag beim Verbinden (`dcc_auth/verbinden_eintrag.py`)

**Files:**
- Create: `services/auth/src/dcc_auth/verbinden_eintrag.py`
- Test: `services/auth/tests/test_verbinden_eintrag.py` (neu)

**Interfaces:**
- Consumes: `soft_delete_instance(db, inst)` (`routes_instance_delete.py:75-127`, ohne Commit, legt den `SuspendedInstance`-Eintrag an, benennt den Hostnamen in `deleted-<id>.invalid` um, löscht Mitgliedschaften, Telefonbuch und offene Bootstrap-Tokens), `hash_password` (`security.py`), `next_id` (`snowflake.py`), `normalisiere_hostname` (Task 1.1), `RegisteredInstance.ohne_freigabe` (Task 1.2).
- Produces:
  - `HOECHSTENS_SERVER = 10`
  - `class ZuVieleServer(Exception)`, `class InstanzGesperrt(Exception)`
  - `class Verbunden(NamedTuple)`: `instanz: RegisteredInstance`, `abgeloest: int | None`
  - `adresse_gesperrt(hostname: str, settings) -> bool`. Wahr für die Cloud-Domain (Host aus `settings.pulse_oidc_issuer`) und die Relay-Basisdomain (`settings.pulse_relay_base_domain`), jeweils samt Unterdomains.
  - `async instanz_verbinden(db: AsyncSession, user: User, hostname: str) -> Verbunden`. Ohne Commit.
- Regeln:
  - Gesperrter Eintrag unter der Adresse → `InstanzGesperrt`. Sonst entkäme ein gesperrter Server seiner Sperre durch Neuverbinden.
  - Eigener Eintrag → wiederverwenden (Mitgliedschaft sicherstellen). Er zählt nicht gegen die Grenze.
  - Sonst Grenze: mindestens 10 eigene Einträge mit `status = 'active'` und `origin = 'vps'` → `ZuVieleServer`.
  - Fremder Eintrag → Soft-Delete, `flush`, dann neu anlegen.
  - Neu: `origin="vps"`, `ohne_freigabe=True`, `registered_by=user.id`, keine Worker-IDs, zufällige `client_id`, Argon2-Hash eines verworfenen Zufallswerts, Besitzer-Mitgliedschaft `role="owner"`.

- [ ] **Step 1: Fehlschlagenden Test schreiben** (`services/auth/tests/test_verbinden_eintrag.py`).

```python
"""Server-Eintrag beim Verbinden: neu, wiederverwenden oder übernehmen.

Die Route hat den Nachweis schon geprüft, wenn ``instanz_verbinden`` läuft:
Unter der Adresse antwortet der Server, der den Code angefragt hat. Daraus
folgt die ganze Regel (Spec 2026-10-09, E2) — wer die Adresse nachweislich
betreibt, bekommt den Eintrag.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_instances import (
    RegisteredInstance,
    SuspendedInstance,
    UserInstanceMembership,
)
from dcc_auth.security import verify_password
from dcc_auth.verbinden_eintrag import (
    HOECHSTENS_SERVER,
    InstanzGesperrt,
    ZuVieleServer,
    adresse_gesperrt,
    instanz_verbinden,
)

_EINSTELLUNGEN = SimpleNamespace(
    pulse_oidc_issuer="https://howispulse.com",
    pulse_relay_base_domain="relay.howispulse.com",
)


async def _konto(client, name: str) -> int:
    reg = {
        "username": name,
        "email": f"{name}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": name,
    }
    await client.post("/register", json=reg)
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    me = await client.get(
        "/me", headers={"Cookie": f"pulse_session={r.cookies.get('pulse_session')}"}
    )
    return int(me.json()["id"])


async def _instanz(
    session_factory,
    *,
    iid: int,
    hostname: str,
    besitzer: int,
    status: str = "active",
    origin: str = "vps",
) -> None:
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"ve-{iid}",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$alt",
                status=status,
                origin=origin,
                registered_by=besitzer,
            )
        )
        s.add(UserInstanceMembership(user_id=besitzer, instance_id=iid, role="owner"))
        await s.commit()


async def _verbinden(session_factory, user_id: int, hostname: str):
    async with session_factory() as db:
        user = await db.get(User, user_id)
        ergebnis = await instanz_verbinden(db, user, hostname)
        await db.commit()
    return ergebnis


@pytest.mark.parametrize(
    ("host", "gesperrt"),
    [
        ("howispulse.com", True),
        ("evil.howispulse.com", True),
        ("x.relay.howispulse.com", True),
        ("howispulse.com.example.org", False),
        ("nothowispulse.com", False),
        ("chat.example.org", False),
    ],
)
def test_eigene_domains_sind_gesperrt(host, gesperrt):
    assert adresse_gesperrt(host, _EINSTELLUNGEN) is gesperrt


async def test_neue_adresse_ergibt_einen_eintrag_ohne_freigabe(client, session_factory):
    uid = await _konto(client, "ve_neu")
    ergebnis = await _verbinden(session_factory, uid, "neu.example.org")
    assert ergebnis.abgeloest is None

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, ergebnis.instanz.id)
        mitglied = await s.get(UserInstanceMembership, (uid, inst.id))
    assert inst.hostname == "neu.example.org"
    assert (inst.origin, inst.status, inst.registered_by) == ("vps", "active", uid)
    assert inst.ohne_freigabe is True
    assert inst.verbunden_at is None
    assert (inst.worker_id_chat, inst.worker_id_voice, inst.worker_id_media) == (None, None, None)
    # Ein echter Argon2-Hash eines verworfenen Zufallswerts: bis zum Abholen
    # meldet sich niemand als dieser Server an.
    assert inst.client_secret.startswith("$argon2")
    assert not verify_password("", inst.client_secret)
    assert mitglied is not None and mitglied.role == "owner"


async def test_eigene_adresse_wird_wiederverwendet(client, session_factory):
    """Neuinstallation desselben Besitzers: derselbe Eintrag, dieselbe Nummer —
    Mitglieder und Communitys auf dem Server bleiben gültig."""
    uid = await _konto(client, "ve_eigen")
    await _instanz(session_factory, iid=950001, hostname="eigen.example.org", besitzer=uid)
    ergebnis = await _verbinden(session_factory, uid, "eigen.example.org")
    assert ergebnis.instanz.id == 950001
    assert ergebnis.abgeloest is None
    assert ergebnis.instanz.ohne_freigabe is False


async def test_fremde_adresse_wird_uebernommen(client, session_factory):
    alt = await _konto(client, "ve_alt")
    neu = await _konto(client, "ve_neu2")
    await _instanz(session_factory, iid=950002, hostname="wechsel.example.org", besitzer=alt)

    ergebnis = await _verbinden(session_factory, neu, "wechsel.example.org")
    assert ergebnis.abgeloest == 950002
    assert ergebnis.instanz.id != 950002

    async with session_factory() as s:
        vorher = await s.get(RegisteredInstance, 950002)
        sperre = await s.get(SuspendedInstance, 950002)
        alte_mitglieder = (
            await s.execute(
                select(UserInstanceMembership).where(
                    UserInstanceMembership.instance_id == 950002
                )
            )
        ).all()
        jetzt = await s.get(RegisteredInstance, ergebnis.instanz.id)
    # Soft-Delete wie routes_instance_delete: der alte Server steht über die
    # Sperrliste still, seine Adresse ist frei.
    assert vorher.status == "deleted"
    assert vorher.hostname == "deleted-950002.invalid"
    assert sperre is not None
    assert alte_mitglieder == []
    assert (jetzt.hostname, jetzt.registered_by) == ("wechsel.example.org", neu)


async def test_gesperrter_server_ist_nicht_zu_uebernehmen(client, session_factory):
    """Sonst entkäme ein gesperrter Server seiner Sperre durch Neuverbinden."""
    uid = await _konto(client, "ve_sperr")
    await _instanz(
        session_factory, iid=950003, hostname="sperr.example.org", besitzer=uid,
        status="suspended",
    )
    with pytest.raises(InstanzGesperrt):
        await _verbinden(session_factory, uid, "sperr.example.org")
    async with session_factory() as s:
        assert (await s.get(RegisteredInstance, 950003)).status == "suspended"


async def test_grenze_gilt_fuer_neue_adressen(client, session_factory):
    uid = await _konto(client, "ve_grenze")
    for i in range(HOECHSTENS_SERVER):
        await _instanz(
            session_factory, iid=951000 + i, hostname=f"s{i}.example.org", besitzer=uid
        )
    with pytest.raises(ZuVieleServer):
        await _verbinden(session_factory, uid, "elf.example.org")
    # Eine eigene Adresse neu zu verbinden kostet keinen Platz.
    ergebnis = await _verbinden(session_factory, uid, "s3.example.org")
    assert ergebnis.instanz.id == 951003


async def test_grenze_zaehlt_nur_aktive_gemietete_server(client, session_factory):
    uid = await _konto(client, "ve_zaehlen")
    for i in range(HOECHSTENS_SERVER - 1):
        await _instanz(
            session_factory, iid=952000 + i, hostname=f"z{i}.example.org", besitzer=uid
        )
    await _instanz(
        session_factory, iid=952100, hostname="app-952100.relay.howispulse.com",
        besitzer=uid, origin="app_host",
    )
    await _instanz(
        session_factory, iid=952101, hostname="gesperrt.example.org", besitzer=uid,
        status="suspended",
    )
    ergebnis = await _verbinden(session_factory, uid, "zehnter.example.org")
    assert ergebnis.instanz.hostname == "zehnter.example.org"
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_eintrag.py`
Expected: Sammelfehler `ModuleNotFoundError: No module named 'dcc_auth.verbinden_eintrag'`.

- [ ] **Step 3: Umsetzen** (`services/auth/src/dcc_auth/verbinden_eintrag.py`).

```python
"""Server-Eintrag beim Verbinden per Gerätecode anlegen, wiederverwenden oder übernehmen.

Läuft, nachdem der Betreiber im Browser „Verbinden“ geklickt und die Cloud
den Nachweis unter der Adresse erneut geprüft hat (``routes_verbinden.py``).
Damit steht fest: unter dieser Adresse läuft gerade der Server, der den Code
angefragt hat. Daraus folgt die Regel (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E2):

* eigener Eintrag unter der Adresse → wiederverwenden (Neuinstallation
  desselben Besitzers; Mitglieder und Nummer bleiben),
* fremder Eintrag → Soft-Delete wie ``routes_instance_delete.py`` und neu
  anlegen. Der alte Server steht über die Sperrliste still, falls er
  irgendwo noch läuft,
* kein Eintrag → neu anlegen.

Committet nicht: der Aufrufer committet erst, wenn der Vorgang in Redis
tatsächlich entschieden ist (``verbinden.vorgang_entscheiden``).
"""

from __future__ import annotations

import asyncio
import secrets
from typing import NamedTuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_shared.hostname import normalisiere_hostname

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.routes_instance_delete import soft_delete_instance
from dcc_auth.security import hash_password
from dcc_auth.snowflake import next_id

#: Höchstens so viele verbundene gemietete Server je Konto (E8). Heim-Server
#: zählen nicht mit; für die gilt weiter einer je Konto.
HOECHSTENS_SERVER = 10


class ZuVieleServer(Exception):
    """Das Konto hat schon ``HOECHSTENS_SERVER`` aktive gemietete Server."""


class InstanzGesperrt(Exception):
    """Unter der Adresse steht ein gesperrter Eintrag.

    Ihn zu übernehmen hiesse, der Sperre durch Neuverbinden zu entkommen.
    """


class Verbunden(NamedTuple):
    instanz: RegisteredInstance
    #: Kennung des per Übernahme gelöschten Eintrags — der Aufrufer muss nach
    #: dem Commit den Cache der Sperrliste leeren (``suspended_list_add``).
    abgeloest: int | None


def adresse_gesperrt(hostname: str, settings) -> bool:
    """Adressen unter den eigenen Domains bekommen keinen Eintrag.

    Sonst könnte jemand eine Relay-Subdomain belegen, bevor sie vergeben ist,
    oder einen Namen unter der Cloud-Domain für sich eintragen.
    """
    eigene = (
        normalisiere_hostname(settings.pulse_oidc_issuer),
        normalisiere_hostname(settings.pulse_relay_base_domain),
    )
    return any(d and (hostname == d or hostname.endswith("." + d)) for d in eigene)


async def _aktive_gemietete_server(db: AsyncSession, user_id: int) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(RegisteredInstance)
            .where(
                RegisteredInstance.registered_by == user_id,
                RegisteredInstance.status == "active",
                RegisteredInstance.origin == "vps",
            )
        )
    ).scalar_one()


async def instanz_verbinden(db: AsyncSession, user: User, hostname: str) -> Verbunden:
    """Eintrag für ``hostname`` mit ``user`` als Besitzer — ohne Commit."""
    vorhanden = (
        await db.execute(
            select(RegisteredInstance)
            .where(RegisteredInstance.hostname == hostname)
            .with_for_update()
        )
    ).scalars().first()

    if vorhanden is not None and vorhanden.status == "suspended":
        raise InstanzGesperrt
    if vorhanden is not None and vorhanden.registered_by == user.id:
        if await db.get(UserInstanceMembership, (user.id, vorhanden.id)) is None:
            db.add(UserInstanceMembership(user_id=user.id, instance_id=vorhanden.id, role="owner"))
        return Verbunden(vorhanden, None)

    if await _aktive_gemietete_server(db, user.id) >= HOECHSTENS_SERVER:
        raise ZuVieleServer

    abgeloest: int | None = None
    if vorhanden is not None:
        await soft_delete_instance(db, vorhanden)
        abgeloest = vorhanden.id
        # Die Adresse muss frei sein, bevor der neue Eintrag sie belegt
        # (``hostname`` ist eindeutig).
        await db.flush()

    neu = RegisteredInstance(
        id=next_id(),
        hostname=hostname,
        client_id=secrets.token_urlsafe(16),
        # Platzhalter bis zum Abholen: ein echter Hash eines verworfenen
        # Zufallswerts. ``zugangsdaten_ausgeben`` rotiert ihn beim Abholen.
        client_secret=await asyncio.to_thread(hash_password, secrets.token_urlsafe(32)),
        status="active",
        origin="vps",
        registered_by=user.id,
        ohne_freigabe=True,
    )
    db.add(neu)
    db.add(UserInstanceMembership(user_id=user.id, instance_id=neu.id, role="owner"))
    await db.flush()
    return Verbunden(neu, abgeloest)
```

- [ ] **Step 4: Test laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_eintrag.py services/auth/tests/test_instance_delete.py`
Expected: alles grün (`test_verbinden_eintrag.py`: 12 Tests).

- [ ] **Step 5: Vereinfachen.** `code-simplifier` über beide neuen Dateien, Step 4 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 6: Commit.**

```bash
git add services/auth/src/dcc_auth/verbinden_eintrag.py services/auth/tests/test_verbinden_eintrag.py
git commit -m "feat(auth): Server-Eintrag beim Verbinden anlegen, wiederverwenden oder übernehmen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.7: Routen, Bremsen und Einbindung (`dcc_auth/routes_verbinden.py`)

**Bremsen:** `_check_rate(request, key, rule)` (`routes.py:1187`) zählt je IP im Prozess. Mit `account=` kommt nur das allgemeine `rate_limit_per_account` (10/min) dazu. Eine Bremse nur je Konto mit eigener Regel baut die Route deshalb aus den Bausteinen `_parse_rule` (`routes.py:1126`) und `_consume_token` (`routes.py:1133`). Neue `rate_limit_*`-Felder müssen auch in die Prüfliste des `field_validator` (`config.py:319-348`), sonst wird ein Tippfehler in der `.env` erst beim ersten Aufruf sichtbar.

**Files:**
- Create: `services/auth/src/dcc_auth/routes_verbinden.py`
- Modify: `services/auth/src/dcc_auth/config.py` (nach Zeile 153 drei Felder, nach Zeile 337 drei Einträge in der Validator-Liste)
- Modify: `services/auth/src/dcc_auth/app.py` (Import vor Zeile 51, `include_router` nach Zeile 295)
- Test: `services/auth/tests/test_verbinden_routen.py` (neu)

**Interfaces:**
- Consumes: alles aus Task 1.1 und 1.3 bis 1.6; `_require_cloud` (`routes_admin_instances.py:44`), `_require_user` (`routes_instance_applications.py:55`, Sitzungs-Cookie, 401 auch bei gesperrtem Konto), `_get_redis` und `suspended_list_add` (`routes_suspended_instances.py:50`, `:83`).
- Produces (Vertrag Abschnitt „Cloud-Schnittstelle“ mit Nachtrag 2):
  1. `POST /selfhost/verbinden/start`, Body `{"hostname": str, "kennung": str (32–128)}` → 201 `{"code", "link", "gueltig_s": 900, "abstand_s": 5}`; 400 `adresse_ungueltig`/`adresse_gesperrt`; 409 `{"code": "nachweis_fehlt", "befund": …}`; 409 `vorgang_laeuft`; 429; 503 `verbinden_nicht_verfuegbar`.
  2. `POST /selfhost/verbinden/abholen`, Body `{"kennung": str}` → 202 `{"status": "wartet"}` | 200 `VerbindenZugangOut` | 403 `abgelehnt` | 410 `abgelaufen`.
  3. `POST /me/selfhost/verbinden/vorgang`, Body `{"code": str}` → 200 `{"hostname", "gueltig_bis"}` | 404 `unbekannt` | 401.
  4. `POST /me/selfhost/verbinden/entscheidung`, Body `{"code": str, "aktion": "verbinden" | "ablehnen"}` → 200 `{"status": "verbunden", "hostname", "instance_id"}` bzw. `{"status": "abgelehnt"}`; 403 `verbinden_gesperrt`; 403 `instance_suspended`; 409 `zu_viele_server`; 409 `nachweis_fehlt`; 404 `unbekannt`.
  - Der Anzeigecode steht in keinem Pfad (Vertrag, Nachtrag 2): Pfade landen in Zugriffsprotokollen (`infra/prod/web-nginx.conf:35-43` loggt `$uri`). Ein Test hält das für alle Routen des Routers fest.
  - `class VerbindenZugangOut(ZugangsdatenOut)` mit `owner_name: str` (Anzeigename, sonst Benutzername)
  - Einstellungen `rate_limit_verbinden_start = "10/hour"`, `rate_limit_verbinden_abholen = "30/minute"`, `rate_limit_verbinden_bestaetigen = "20/hour"`

- [ ] **Step 1: Fehlschlagenden Test schreiben** (`services/auth/tests/test_verbinden_routen.py`).

```python
"""Verbinden per Gerätecode — die vier Routen im Zusammenspiel.

Server fragt an (``start``), Betreiber sieht und bestätigt im Browser
(``vorgang``/``entscheidung``, der Code im Körper), Server holt ab
(``abholen``). Die Prüfung von aussen (``nachweis_pruefen``) ist hier
ersetzt; sie hat eigene Tests in ``test_verbinden_nachweis.py``.
"""

from __future__ import annotations

import hashlib
import re
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from dcc_auth import routes_verbinden
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.security import verify_password

_KENNUNG = "abholkennung-fuer-den-test-mit-genug-zeichen-0123"
_NACHWEIS = hashlib.sha256(_KENNUNG.encode()).hexdigest()
_HOST = "mein.example.org"


@pytest.fixture
async def mit_redis(app, redis_echt):
    app.state.redis = redis_echt
    yield redis_echt
    app.state.redis = None


@pytest.fixture
def nachweis(monkeypatch):
    """Ersetzt die Prüfung von aussen. ``befund`` = ``None`` heisst bestanden."""
    stand = SimpleNamespace(befund=None, aufrufe=[])

    async def gefaelscht(hostname: str, erwartet: str) -> str | None:
        stand.aufrufe.append((hostname, erwartet))
        return stand.befund

    monkeypatch.setattr(routes_verbinden, "nachweis_pruefen", gefaelscht)
    return stand


async def _konto(client, name: str) -> dict:
    reg = {
        "username": name,
        "email": f"{name}@dcc-test.example.com",
        "password": "correct horse battery staple",
        "display_name": name.capitalize(),
    }
    r = await client.post("/register", json=reg)
    assert r.status_code == 201, r.text
    r = await client.post(
        "/login", json={"email_or_username": reg["email"], "password": reg["password"]}
    )
    cookie = f"pulse_session={r.cookies.get('pulse_session')}"
    me = await client.get("/me", headers={"Cookie": cookie})
    return {"cookie": cookie, "id": int(me.json()["id"])}


async def _start(client, hostname: str = _HOST, kennung: str = _KENNUNG):
    return await client.post(
        "/selfhost/verbinden/start", json={"hostname": hostname, "kennung": kennung}
    )


async def _abholen(client, kennung: str = _KENNUNG):
    return await client.post("/selfhost/verbinden/abholen", json={"kennung": kennung})


async def _ansehen(client, konto: dict, code: str):
    return await client.post(
        "/me/selfhost/verbinden/vorgang", json={"code": code}, headers={"Cookie": konto["cookie"]}
    )


async def _entscheiden(client, konto: dict, code: str, aktion: str):
    return await client.post(
        "/me/selfhost/verbinden/entscheidung",
        json={"code": code, "aktion": aktion},
        headers={"Cookie": konto["cookie"]},
    )


def test_code_steht_in_keinem_pfad():
    """Pfade landen in Zugriffsprotokollen (``web-nginx.conf`` loggt ``$uri``);
    wer dort einen offenen Code liest, könnte ihn mit seinem Konto bestätigen."""
    pfade = [route.path for route in routes_verbinden.router.routes]
    assert len(pfade) == 4
    assert all("{" not in pfad for pfad in pfade)


async def test_durchlauf(client, session_factory, mit_redis, nachweis):
    michael = await _konto(client, "michael")

    r = await _start(client, hostname="https://Mein.Example.org:443/")
    assert r.status_code == 201, r.text
    start = r.json()
    assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}", start["code"])
    assert start["link"].endswith(f"/verbinden#{start['code']}")
    assert (start["gueltig_s"], start["abstand_s"]) == (900, 5)
    # Die Cloud prüft den Hash der Kennung, nie die Kennung selbst.
    assert nachweis.aufrufe == [(_HOST, _NACHWEIS)]

    r = await _ansehen(client, michael, start["code"])
    assert r.status_code == 200, r.text
    assert r.json()["hostname"] == _HOST
    assert r.json()["gueltig_bis"]

    r = await _entscheiden(client, michael, start["code"], "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "verbunden"
    assert r.json()["hostname"] == _HOST
    iid = r.json()["instance_id"]
    # Vor dem Bestätigen erneut von aussen geprüft.
    assert len(nachweis.aufrufe) == 2

    r = await _abholen(client)
    assert r.status_code == 200, r.text
    zugang = r.json()
    assert zugang["instance_id"] == iid
    assert zugang["owner_user_id"] == str(michael["id"])
    assert zugang["owner_name"] == "Michael"
    assert zugang["hostname"] == _HOST
    assert zugang["admin_email"] == "michael@dcc-test.example.com"
    assert zugang["cloud_origin"].startswith("https://")
    assert "relay_subdomain" not in zugang

    async with session_factory() as s:
        inst = await s.get(RegisteredInstance, int(iid))
        mitglied = await s.get(UserInstanceMembership, (michael["id"], int(iid)))
    assert inst.client_id == zugang["client_id"]
    assert verify_password(zugang["client_secret"], inst.client_secret)
    assert inst.verbunden_at is not None
    assert inst.ohne_freigabe is True
    assert mitglied.role == "owner"

    # Genau einmal: danach gibt es nichts mehr abzuholen.
    assert (await _abholen(client)).status_code == 410

    # Der Server steht im Konto, eingerichtet — also in der Leiste aller Geräte.
    r = await client.get("/me/instances", headers={"Cookie": michael["cookie"]})
    (eintrag,) = [i for i in r.json() if i["id"] == iid]
    assert eintrag["set_up"] is True and eintrag["role"] == "owner"


async def test_abholen_vor_der_entscheidung_wartet(client, mit_redis, nachweis):
    assert (await _start(client)).status_code == 201
    r = await _abholen(client)
    assert r.status_code == 202
    assert r.json() == {"status": "wartet"}


async def test_fremde_kennung_holt_nichts(client, mit_redis, nachweis):
    """Wer den Code gesehen hat, kennt die Kennung nicht."""
    assert (await _start(client)).status_code == 201
    assert (await _abholen(client, kennung="x" * 43)).status_code == 410


async def test_ablehnen(client, session_factory, mit_redis, nachweis):
    konto = await _konto(client, "ablehner")
    code = (await _start(client)).json()["code"]

    r = await _entscheiden(client, konto, code, "ablehnen")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "abgelehnt"}

    r = await _abholen(client)
    assert r.status_code == 403
    assert r.json()["detail"] == "abgelehnt"
    assert (await _abholen(client)).status_code == 410
    async with session_factory() as s:
        treffer = (
            await s.execute(select(RegisteredInstance).where(RegisteredInstance.hostname == _HOST))
        ).first()
    assert treffer is None


async def test_entschiedener_code_ist_unbekannt(client, mit_redis, nachweis):
    konto = await _konto(client, "doppelt")
    code = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, konto, code, "verbinden")).status_code == 200
    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 404
    assert r.json()["detail"] == "unbekannt"


async def test_abgelaufen(client, mit_redis, nachweis):
    konto = await _konto(client, "spaet")
    code = (await _start(client)).json()["code"]
    # Was Redis nach 15 Minuten von selbst tut.
    async for schluessel in mit_redis.scan_iter(match="auth:verbinden:*"):
        await mit_redis.delete(schluessel)

    r = await _ansehen(client, konto, code)
    assert r.status_code == 404
    assert r.json()["detail"] == "unbekannt"
    assert (await _entscheiden(client, konto, code, "verbinden")).status_code == 404
    r = await _abholen(client)
    assert r.status_code == 410
    assert r.json()["detail"] == "abgelaufen"


async def test_code_in_jeder_schreibweise(client, mit_redis, nachweis):
    konto = await _konto(client, "tipper")
    code = (await _start(client)).json()["code"]
    getippt = code.replace("-", "").lower()
    r = await _ansehen(client, konto, getippt)
    assert r.status_code == 200, r.text


async def test_ohne_anmeldung(client, mit_redis, nachweis):
    code = (await _start(client)).json()["code"]
    r = await client.post("/me/selfhost/verbinden/vorgang", json={"code": code})
    assert r.status_code == 401
    r = await client.post(
        "/me/selfhost/verbinden/entscheidung", json={"code": code, "aktion": "verbinden"}
    )
    assert r.status_code == 401


async def test_gesperrtes_konto_darf_nicht_verbinden(
    client, session_factory, mit_redis, nachweis
):
    konto = await _konto(client, "gesperrt")
    async with session_factory() as s:
        (await s.get(User, konto["id"])).server_verbinden_gesperrt = True
        await s.commit()
    code = (await _start(client)).json()["code"]

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 403
    assert r.json()["detail"] == "verbinden_gesperrt"
    # Ablehnen bleibt möglich, damit der Server nicht 15 Minuten wartet.
    assert (await _entscheiden(client, konto, code, "ablehnen")).status_code == 200


async def test_elfter_server(client, session_factory, mit_redis, nachweis):
    konto = await _konto(client, "sammler")
    async with session_factory() as s:
        for i in range(10):
            s.add(
                RegisteredInstance(
                    id=960000 + i,
                    hostname=f"vorhanden{i}.example.org",
                    client_id=f"vr-{i}",
                    client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                    status="active",
                    origin="vps",
                    registered_by=konto["id"],
                )
            )
        await s.commit()
    code = (await _start(client)).json()["code"]
    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 409
    assert r.json()["detail"] == "zu_viele_server"


async def test_nachweis_fehlt_beim_start(client, mit_redis, nachweis):
    nachweis.befund = "kein_nachweis"
    r = await _start(client)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "nachweis_fehlt", "befund": "kein_nachweis"}
    # Kein Code verbraucht, kein Vorgang angelegt.
    assert [k async for k in mit_redis.scan_iter(match="auth:verbinden:*")] == []


async def test_nachweis_fehlt_beim_bestaetigen(client, session_factory, mit_redis, nachweis):
    """Zwischen Anfrage und Klick kann der Server verschwunden sein — dann
    entsteht kein Eintrag, und der Code bleibt offen."""
    konto = await _konto(client, "vorsicht")
    code = (await _start(client)).json()["code"]
    nachweis.befund = "falscher_wert"

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 409
    assert r.json()["detail"]["befund"] == "falscher_wert"
    async with session_factory() as s:
        treffer = (
            await s.execute(select(RegisteredInstance).where(RegisteredInstance.hostname == _HOST))
        ).first()
    assert treffer is None
    assert (await _abholen(client)).status_code == 202


@pytest.mark.parametrize(
    ("hostname", "detail"),
    [
        ("localhost", "adresse_ungueltig"),
        ("203.0.113.7", "adresse_ungueltig"),
        ("frech.howispulse.com", "adresse_gesperrt"),
        ("app-1.relay.howispulse.com", "adresse_gesperrt"),
    ],
)
async def test_unbrauchbare_adressen(client, mit_redis, nachweis, hostname, detail):
    r = await _start(client, hostname=hostname)
    assert r.status_code == 400
    assert r.json()["detail"] == detail
    assert nachweis.aufrufe == []


async def test_uebernahme_einer_fremden_adresse(client, session_factory, mit_redis, nachweis):
    alt = await _konto(client, "altbesitzer")
    neu = await _konto(client, "neubesitzer")
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=961000,
                hostname=_HOST,
                client_id="alt-client",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                status="active",
                origin="vps",
                registered_by=alt["id"],
            )
        )
        await s.commit()

    code = (await _start(client)).json()["code"]
    r = await _entscheiden(client, neu, code, "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["instance_id"] != "961000"
    async with session_factory() as s:
        assert (await s.get(RegisteredInstance, 961000)).status == "deleted"


async def test_zweiter_start_derselben_kennung_liefert_denselben_code(
    client, mit_redis, nachweis
):
    erster = (await _start(client)).json()["code"]
    zweiter = await _start(client)
    assert zweiter.status_code == 201
    assert zweiter.json()["code"] == erster
    anderer_host = await _start(client, hostname="anders.example.org")
    assert anderer_host.status_code == 409
    assert anderer_host.json()["detail"] == "vorgang_laeuft"


async def test_ohne_redis_kein_verbinden(client, nachweis):
    r = await _start(client)
    assert r.status_code == 503
    assert r.json()["detail"] == "verbinden_nicht_verfuegbar"


async def test_nur_in_der_cloud(client, mit_redis, nachweis, monkeypatch):
    import dcc_auth.routes_admin_instances as rai

    monkeypatch.setattr(
        rai, "get_settings", lambda: SimpleNamespace(pulse_instance_mode="self-host")
    )
    assert (await _start(client)).status_code == 403


async def test_bremse_beim_start(client, mit_redis, nachweis):
    codes = [(await _start(client, kennung=f"{i:02d}" + "k" * 41)).status_code for i in range(11)]
    assert codes[:10] == [201] * 10
    assert codes[10] == 429


async def test_bremse_je_konto(client, mit_redis, nachweis):
    konto = await _konto(client, "neugierig")
    code = (await _start(client)).json()["code"]
    codes = [(await _ansehen(client, konto, code)).status_code for _ in range(21)]
    assert codes[:20] == [200] * 20
    assert codes[20] == 429
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_routen.py`
Expected: Sammelfehler `ImportError: cannot import name 'routes_verbinden' from 'dcc_auth'`.

- [ ] **Step 3: Einstellungen ergänzen** (`services/auth/src/dcc_auth/config.py`).

Nach `rate_limit_bootstrap_redeem: str = "10/minute"` (Zeile 153) einfügen:

```python
    # Verbinden per Gerätecode (routes_verbinden.py, Spec 2026-10-09 E8).
    # ``start`` ist anonym und lässt die Cloud einen fremden Rechner abfragen
    # — ein Betreiber braucht einen Aufruf je Installation. ``abholen`` fragt
    # ``pulse-connect`` alle 5 s ab (12/min); 30 lassen Luft für einen
    # zweiten Server hinter derselben Adresse. ``bestaetigen`` gilt je Konto
    # für Ansehen und Entscheiden zusammen (zwei Aufrufe je Server).
    rate_limit_verbinden_start: str = "10/hour"
    rate_limit_verbinden_abholen: str = "30/minute"
    rate_limit_verbinden_bestaetigen: str = "20/hour"
```

In der Liste des `field_validator` nach `"rate_limit_bootstrap_redeem",` (Zeile 337) einfügen:

```python
        "rate_limit_verbinden_start",
        "rate_limit_verbinden_abholen",
        "rate_limit_verbinden_bestaetigen",
```

- [ ] **Step 4: Routen schreiben** (`services/auth/src/dcc_auth/routes_verbinden.py`).

```python
"""Verbinden per Gerätecode — die vier Routen.

Ein Self-Host verbindet sich am Ende seiner Installation mit dem Konto seines
Betreibers (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E1):

1. ``POST /selfhost/verbinden/start`` — anonym, vom Server (``pulse-connect``).
2. ``POST /me/selfhost/verbinden/vorgang`` — angemeldet, die Bestätigungsseite.
3. ``POST /me/selfhost/verbinden/entscheidung`` — angemeldet, „Verbinden“/„Abbrechen“.
4. ``POST /selfhost/verbinden/abholen`` — anonym, vom Server, bis 200/403/410.

Die beiden anonymen Routen vertrauen dem Aufrufer nichts an, was er nicht
schon hat: Der Start verlangt die Abholkennung (die Cloud prüft ihren Hash
unter der Adresse), das Abholen liefert nur dem, der dieselbe Kennung kennt.
Kennung, Code und Secret werden nie geloggt — und der Code steht in keinem
Pfad, auch bei den angemeldeten Routen nicht: Pfade landen in
Zugriffsprotokollen (``web-nginx.conf`` loggt ``$uri``), und wer dort einen
offenen Code liest, könnte ihn mit seinem Konto bestätigen.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from time import monotonic
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError

from dcc_shared.hostname import normalisiere_hostname

from dcc_auth.config import get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance
from dcc_auth.routes import _check_rate, _consume_token, _parse_rule
from dcc_auth.routes_admin_instances import _require_cloud
from dcc_auth.routes_instance_applications import _require_user
from dcc_auth.routes_suspended_instances import _get_redis, suspended_list_add
from dcc_auth.verbinden import (
    ABSTAND_S,
    GUELTIG_S,
    Vorgang,
    VorgangLaeuft,
    code_anzeigen,
    code_normalisieren,
    nachweis_aus_kennung,
    vorgang_anlegen,
    vorgang_entnehmen,
    vorgang_entscheiden,
    vorgang_per_code,
    vorgang_per_nachweis,
)
from dcc_auth.verbinden_eintrag import (
    InstanzGesperrt,
    ZuVieleServer,
    adresse_gesperrt,
    instanz_verbinden,
)
from dcc_auth.verbinden_nachweis import nachweis_pruefen
from dcc_auth.zugangsdaten import ZugangsdatenOut, zugangsdaten_ausgeben

log = logging.getLogger(__name__)

router = APIRouter(tags=["self-host"], dependencies=[Depends(_require_cloud)])


class StartEin(BaseModel):
    hostname: str = Field(..., min_length=1, max_length=253)
    #: Die geheime Abholkennung des Servers. Die Cloud bildet daraus den
    #: Nachweis und vergisst sie wieder — gespeichert wird nur der Hash.
    kennung: str = Field(..., min_length=32, max_length=128)


class StartAus(BaseModel):
    code: str
    link: str
    gueltig_s: int
    abstand_s: int


class AbholenEin(BaseModel):
    kennung: str = Field(..., min_length=32, max_length=128)


class VerbindenZugangOut(ZugangsdatenOut):
    #: Der Name, den ``pulse-connect`` im Terminal nennt („Connected to …“) —
    #: so sieht der Betreiber, wessen Klick den Server bekommen hat.
    owner_name: str


class VorgangAus(BaseModel):
    hostname: str
    gueltig_bis: str


class VorgangEin(BaseModel):
    #: Wie getippt oder aus dem Link übernommen; ``code_normalisieren`` macht
    #: daraus die Speicherform.
    code: str = Field(..., min_length=1, max_length=32)


class EntscheidungEin(VorgangEin):
    aktion: Literal["verbinden", "ablehnen"]


class EntscheidungAus(BaseModel):
    status: Literal["verbunden", "abgelehnt"]
    hostname: str | None = None
    instance_id: str | None = None


async def _redis(request: Request):
    """Ohne Redis kein Vorgang — anders als Sperrlisten-Cache und
    Admin-Ereignisse gibt es hier nichts, worauf man zurückfallen könnte."""
    redis = await _get_redis(request)
    if redis is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="verbinden_nicht_verfuegbar"
        )
    return redis


def _bremse_je_konto(request: Request, user_id: int) -> None:
    """Je Konto statt je IP: ``_check_rate`` kennt pro Konto nur das
    allgemeine Login-Budget (``rate_limit_per_account``), und das ist für
    eine Seite, die man einmal pro Server öffnet, zu weit."""
    regel = get_settings().rate_limit_verbinden_bestaetigen
    anzahl, sekunden = _parse_rule(regel)
    _consume_token(
        request.app, "verbinden_bestaetigen", str(user_id), anzahl, sekunden, monotonic(), regel
    )


async def _offener_vorgang(redis, roh: str) -> tuple[str, Vorgang]:
    """Unbekannt, abgelaufen und schon entschieden sehen gleich aus."""
    code = code_normalisieren(roh)
    treffer = await vorgang_per_code(redis, code) if code else None
    if treffer is None or treffer[1].status != "wartet":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
    return treffer


def _nachweis_fehlt(befund: str) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT, detail={"code": "nachweis_fehlt", "befund": befund}
    )


@router.post(
    "/selfhost/verbinden/start", response_model=StartAus, status_code=status.HTTP_201_CREATED
)
async def verbinden_start(payload: StartEin, request: Request) -> StartAus:
    settings = get_settings()
    await _check_rate(request, "verbinden_start", settings.rate_limit_verbinden_start)

    hostname = normalisiere_hostname(payload.hostname)
    if hostname is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="adresse_ungueltig")
    if adresse_gesperrt(hostname, settings):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="adresse_gesperrt")
    redis = await _redis(request)

    nachweis = nachweis_aus_kennung(payload.kennung)
    # Schon hier und nicht erst beim Bestätigen: ein Server, den die Cloud
    # nicht erreicht, soll keinen Code verbrauchen, den der Betreiber dann
    # vergeblich bestätigt.
    befund = await nachweis_pruefen(hostname, nachweis)
    if befund is not None:
        raise _nachweis_fehlt(befund)
    try:
        vorgang = await vorgang_anlegen(redis, hostname, nachweis)
    except VorgangLaeuft:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="vorgang_laeuft") from None

    anzeige = code_anzeigen(vorgang.code)
    basis = (settings.app_base_url or settings.pulse_oidc_issuer).rstrip("/")
    return StartAus(
        code=anzeige,
        # Der Code steht hinter ``#``: der Browser schickt ihn nie an einen
        # Server, er landet in keinem Zugriffsprotokoll (E5).
        link=f"{basis}/verbinden#{anzeige}",
        gueltig_s=GUELTIG_S,
        abstand_s=ABSTAND_S,
    )


@router.post("/me/selfhost/verbinden/vorgang", response_model=VorgangAus)
async def verbinden_ansehen(payload: VorgangEin, request: Request, db: SessionDep) -> VorgangAus:
    user = await _require_user(request, db)
    _bremse_je_konto(request, user.id)
    _, vorgang = await _offener_vorgang(await _redis(request), payload.code)
    return VorgangAus(hostname=vorgang.hostname, gueltig_bis=vorgang.gueltig_bis)


@router.post(
    "/me/selfhost/verbinden/entscheidung",
    response_model=EntscheidungAus,
    # „abgelehnt“ antwortet nur mit dem Status, wie im Vertrag.
    response_model_exclude_none=True,
)
async def verbinden_entscheiden(
    payload: EntscheidungEin, request: Request, db: SessionDep
) -> EntscheidungAus:
    user = await _require_user(request, db)
    _bremse_je_konto(request, user.id)
    redis = await _redis(request)
    nachweis, vorgang = await _offener_vorgang(redis, payload.code)

    if payload.aktion == "ablehnen":
        if not await vorgang_entscheiden(
            redis, nachweis, "abgelehnt", instance_id=None, user_id=str(user.id)
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
        return EntscheidungAus(status="abgelehnt")

    if user.server_verbinden_gesperrt:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="verbinden_gesperrt")
    # Zweite Prüfung: zwischen Anfrage und Klick können Minuten liegen. Erst
    # sie macht die Übernahme einer eingetragenen Adresse vertretbar (E2).
    befund = await nachweis_pruefen(vorgang.hostname, nachweis)
    if befund is not None:
        raise _nachweis_fehlt(befund)

    try:
        verbunden = await instanz_verbinden(db, user, vorgang.hostname)
    except ZuVieleServer:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="zu_viele_server") from None
    except InstanzGesperrt:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="instance_suspended") from None
    except IntegrityError:
        # Ein gleichzeitiger Klick auf denselben Code hat die Adresse schon
        # eingetragen und gewinnt.
        await db.rollback()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt") from None

    instanz_id = str(verbunden.instanz.id)
    if not await vorgang_entscheiden(
        redis, nachweis, "bestaetigt", instance_id=instanz_id, user_id=str(user.id)
    ):
        await db.rollback()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="unbekannt")
    await db.commit()

    if verbunden.abgeloest is not None:
        await suspended_list_add(redis, verbunden.abgeloest)
        # warning, weil ``info`` in der Cloud unsichtbar ist (logging_setup.py):
        # wer später fragt, warum sein Server stillsteht, findet es hier.
        log.warning(
            "verbinden_uebernahme hostname=%s alt=%s neu=%s",
            vorgang.hostname,
            verbunden.abgeloest,
            instanz_id,
        )
    return EntscheidungAus(status="verbunden", hostname=vorgang.hostname, instance_id=instanz_id)


@router.post(
    "/selfhost/verbinden/abholen",
    response_model=VerbindenZugangOut,
    responses={202: {"description": "noch nicht entschieden"}},
)
async def verbinden_abholen(payload: AbholenEin, request: Request, db: SessionDep):
    settings = get_settings()
    await _check_rate(request, "verbinden_abholen", settings.rate_limit_verbinden_abholen)
    redis = await _redis(request)
    nachweis = nachweis_aus_kennung(payload.kennung)

    vorgang = await vorgang_per_nachweis(redis, nachweis)
    if vorgang is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")
    if vorgang.status == "wartet":
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content={"status": "wartet"})

    # Ab hier genau einmal: wer den Vorgang entnimmt, bekommt das Ergebnis.
    vorgang = await vorgang_entnehmen(redis, nachweis)
    if vorgang is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")
    if vorgang.status == "abgelehnt":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="abgelehnt")

    instanz = await db.get(RegisteredInstance, int(vorgang.instance_id), with_for_update=True)
    # Zwischen Klick und Abholen gesperrt, gelöscht oder übernommen, oder der
    # Besitzer hat sein Konto gelöscht: nichts mehr auszuhändigen.
    if instanz is None or instanz.status != "active" or instanz.registered_by is None:
        raise HTTPException(status.HTTP_410_GONE, detail="abgelaufen")

    zugang = await zugangsdaten_ausgeben(db, instanz, settings)
    instanz.verbunden_at = datetime.now(UTC)
    besitzer = await db.get(User, instanz.registered_by)
    await db.commit()
    return VerbindenZugangOut(
        **zugang.model_dump(),
        owner_name=besitzer.display_name or besitzer.username,
    )
```

- [ ] **Step 5: In die App einbinden** (`services/auth/src/dcc_auth/app.py`).

Vor `from dcc_auth.routes_version_policy import router as version_policy_router` (Zeile 51) einfügen:

```python
from dcc_auth.routes_verbinden import router as verbinden_router
```

Nach `app.include_router(selfhost_bootstrap_router)` (Zeile 295) einfügen:

```python
    app.include_router(verbinden_router)
```

- [ ] **Step 6: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_routen.py`
Expected: `23 passed`.

- [ ] **Step 7: Vereinfachen.** `code-simplifier` über `routes_verbinden.py`, `config.py`, `app.py` und den Test, Step 6 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 8: Commit.**

```bash
git add services/auth/src/dcc_auth/routes_verbinden.py services/auth/src/dcc_auth/config.py \
  services/auth/src/dcc_auth/app.py services/auth/tests/test_verbinden_routen.py
git commit -m "feat(auth): Routen für das Verbinden per Gerätecode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.8: Hinweis-Mails beim Verbinden (Nachtrag 2026-10-10, Entwurf E5)

Gegenmittel 2 gegen untergeschobene Links: Wer einen Link bestätigt hat, den ihm jemand geschickt hat, erfährt es aus seinem Postfach. Bei einer Übernahme (Entwurf E2) bekommt zusätzlich der bisherige Besitzer eine Nachricht, denn sein Eintrag ist danach gelöscht und sein Server steht über die Sperrliste still. Muster ist der Hinweis an die alte Adresse in `routes_account_security.py:186-191`: Versand nach dem Commit, jeder Fehler nur als `warning`. Die Mailtexte liegen wie alle anderen in `email.py` (`compose_email_change_notice`, Zeile 218).

**Files:**
- Modify: `services/auth/src/dcc_auth/email.py` (zwei Funktionen vor `issue_verification_email`, Zeile 232; `UTC` und `datetime` sind in Zeile 24 schon importiert)
- Modify: `services/auth/src/dcc_auth/routes_verbinden.py` (Import, Helfer `_hinweis_mail`, Schluss von `verbinden_entscheiden`)
- Test: `services/auth/tests/test_verbinden_routen.py` (drei Tests anhängen)

**Interfaces:**
- Consumes: `send_email(to: str, subject: str, body_plain: str, session: AsyncSession | None = None) -> None` (`email.py:113`; ohne SMTP-Konfiguration nur `email_skipped` im Log, bei SMTP-Fehlern wirft sie). `Verbunden.abgeloest` (Task 1.6). `soft_delete_instance` lässt `registered_by` des alten Eintrags stehen (`routes_instance_delete.py:75-127`), der bisherige Besitzer ist also noch bekannt, sofern er sein Konto nicht gelöscht hat.
- Produces:
  - `compose_verbinden_hinweis(hostname: str, zeitpunkt: datetime) -> tuple[str, str]`, Betreff `Pulse: Ein Server wurde mit deinem Konto verbunden`, an das bestätigende Konto, bei jedem Verbinden
  - `compose_verbinden_uebernahme(hostname: str, zeitpunkt: datetime) -> tuple[str, str]`, Betreff `Pulse: Dein Server wurde mit einem anderen Konto verbunden`, an den bisherigen Besitzer, nur bei einer Übernahme (nicht, wenn derselbe Besitzer neu verbindet)
  - Log-Ereignis `verbinden_hinweis_mail_fehlgeschlagen user_id=…` (warning, ohne Code und Kennung)

- [ ] **Step 1: Fehlschlagende Tests anhängen** (Ende von `services/auth/tests/test_verbinden_routen.py`).

```python


async def test_hinweis_mail_nach_dem_verbinden(client, mit_redis, nachweis, monkeypatch):
    """Gegenmittel gegen untergeschobene Links (Entwurf E5): wer einen fremden
    Link bestätigt hat, erfährt es spätestens aus seinem Postfach."""
    gesendet: list[tuple[str, str, str]] = []

    async def mitschreiben(to, subject, body_plain, session=None):
        gesendet.append((to, subject, body_plain))

    monkeypatch.setattr(routes_verbinden, "send_email", mitschreiben)
    konto = await _konto(client, "postfach")

    abgelehnt = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, konto, abgelehnt, "ablehnen")).status_code == 200
    assert gesendet == []

    await _abholen(client)  # räumt den abgelehnten Vorgang
    code = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, konto, code, "verbinden")).status_code == 200

    ((an, betreff, text),) = gesendet
    assert an == "postfach@dcc-test.example.com"
    assert betreff == "Pulse: Ein Server wurde mit deinem Konto verbunden"
    assert _HOST in text
    assert "UTC" in text
    assert "Warst du das nicht? Lösche den Server in Pulse unter Meine Server." in text
    assert code not in text and code.replace("-", "") not in text


async def test_versandfehler_bricht_das_verbinden_nicht_ab(
    client, mit_redis, nachweis, monkeypatch
):
    import smtplib

    async def kaputt(*_a, **_k):
        raise smtplib.SMTPException("relay down")

    monkeypatch.setattr(routes_verbinden, "send_email", kaputt)
    konto = await _konto(client, "ohnepost")
    code = (await _start(client)).json()["code"]

    r = await _entscheiden(client, konto, code, "verbinden")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "verbunden"
    assert (await _abholen(client)).status_code == 200


async def test_uebernahme_schreibt_dem_vorbesitzer(
    client, session_factory, mit_redis, nachweis, monkeypatch
):
    """Bei einer Übernahme ist der alte Eintrag weg und der alte Server steht
    still — sein Besitzer soll das nicht erst am toten Server merken."""
    gesendet: list[tuple[str, str, str]] = []

    async def mitschreiben(to, subject, body_plain, session=None):
        gesendet.append((to, subject, body_plain))

    monkeypatch.setattr(routes_verbinden, "send_email", mitschreiben)
    alt = await _konto(client, "vorbesitzer")
    neu = await _konto(client, "nachfolger")
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=962000,
                hostname=_HOST,
                client_id="vb-client",
                client_secret="$argon2id$v=19$m=65536,t=3,p=4$x",
                status="active",
                origin="vps",
                registered_by=alt["id"],
            )
        )
        await s.commit()

    code = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, neu, code, "verbinden")).status_code == 200
    an_vorbesitzer = [m for m in gesendet if m[0] == "vorbesitzer@dcc-test.example.com"]
    ((_, betreff, text),) = an_vorbesitzer
    assert betreff == "Pulse: Dein Server wurde mit einem anderen Konto verbunden"
    assert _HOST in text and "UTC" in text
    assert "Wer den Server unter dieser Adresse betreibt, hat ihn neu verbunden." in text
    assert "prüfe, wer Zugriff auf den Rechner und die Domain hat." in text
    assert [m[0] for m in gesendet].count("nachfolger@dcc-test.example.com") == 1

    # Derselbe Besitzer verbindet denselben Server neu (zweiter Lauf von
    # pulse-connect): kein Besitzerwechsel, also keine zweite Mail an den
    # Vorbesitzer.
    code = (await _start(client, kennung="zweite-abholkennung-fuer-denselben-server")).json()[
        "code"
    ]
    assert (await _entscheiden(client, neu, code, "verbinden")).status_code == 200
    assert [m[0] for m in gesendet].count("vorbesitzer@dcc-test.example.com") == 1
    assert [m[0] for m in gesendet].count("nachfolger@dcc-test.example.com") == 2
```

- [ ] **Step 2: Tests laufen lassen, die neuen müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_routen.py`
Expected: `3 failed, 23 passed` mit `AttributeError: <module 'dcc_auth.routes_verbinden' …> has no attribute 'send_email'`.

- [ ] **Step 3: Mailtexte** (`services/auth/src/dcc_auth/email.py`, direkt vor `async def issue_verification_email`).

```python
def compose_verbinden_hinweis(hostname: str, zeitpunkt: datetime) -> tuple[str, str]:
    """Hinweis nach dem Verbinden eines Servers mit dem Konto (Entwurf
    2026-10-09, E5): Wer einen ihm untergeschobenen Link bestätigt hat,
    erfährt es spätestens hier. Kein Code, keine Kennung im Text."""
    subject = "Pulse: Ein Server wurde mit deinem Konto verbunden"
    body = (
        f"Hallo,\n\n"
        f"dein Pulse-Konto wurde soeben mit einem Server verbunden:\n\n"
        f"  Adresse:   {hostname}\n"
        f"  Zeitpunkt: {zeitpunkt.astimezone(UTC):%Y-%m-%d %H:%M} UTC\n\n"
        f"Der Server erscheint jetzt unter Meine Server und in der Leiste\n"
        f"deiner Geräte.\n\n"
        f"Warst du das nicht? Lösche den Server in Pulse unter Meine Server.\n"
    )
    return subject, body


def compose_verbinden_uebernahme(hostname: str, zeitpunkt: datetime) -> tuple[str, str]:
    """Hinweis an den bisherigen Besitzer, wenn ein anderes Konto seine
    Adresse übernommen hat (Entwurf 2026-10-09, E2). Die Cloud weiss nur,
    dass unter der Adresse jetzt ein Server läuft, der den Nachweis liefert —
    nicht, wer davorsitzt. Der Text behauptet deshalb nichts darüber."""
    subject = "Pulse: Dein Server wurde mit einem anderen Konto verbunden"
    body = (
        f"Hallo,\n\n"
        f"dein Server wurde soeben mit einem anderen Pulse-Konto verbunden:\n\n"
        f"  Adresse:   {hostname}\n"
        f"  Zeitpunkt: {zeitpunkt.astimezone(UTC):%Y-%m-%d %H:%M} UTC\n\n"
        f"Dein bisheriger Eintrag ist damit gelöscht und erscheint nicht mehr\n"
        f"unter Meine Server.\n\n"
        f"Wer den Server unter dieser Adresse betreibt, hat ihn neu verbunden.\n"
        f"Warst du das nicht, prüfe, wer Zugriff auf den Rechner und die Domain hat.\n"
    )
    return subject, body


```

- [ ] **Step 4: Versand in der Route** (`services/auth/src/dcc_auth/routes_verbinden.py`).

Nach `from dcc_auth.db import SessionDep` einfügen:

```python
from dcc_auth.email import compose_verbinden_hinweis, compose_verbinden_uebernahme, send_email
```

Direkt vor `def _nachweis_fehlt(befund: str) -> HTTPException:` einfügen:

```python
async def _hinweis_mail(db, empfaenger: User, mail: tuple[str, str]) -> None:
    """Gegenmittel gegen untergeschobene Links (Entwurf E5) — an den, der
    bestätigt hat, und bei einer Übernahme an den bisherigen Besitzer.

    Ein Fehlschlag beim Versand bricht nichts ab — der Server ist zu diesem
    Zeitpunkt schon eingetragen, und ein 500 hiesse für den Betreiber „hat
    nicht geklappt“, obwohl es geklappt hat.
    """
    betreff, text = mail
    try:
        await send_email(empfaenger.email, betreff, text, session=db)
    except Exception as exc:  # noqa: BLE001
        log.warning("verbinden_hinweis_mail_fehlgeschlagen user_id=%s: %s", empfaenger.id, exc)


```

Den Schluss von `verbinden_entscheiden`, ab `    if verbunden.abgeloest is not None:` bis einschließlich der letzten Zeile `    return EntscheidungAus(status="verbunden", hostname=vorgang.hostname, instance_id=instanz_id)`, ersetzen durch:

```python
    jetzt = datetime.now(UTC)
    if verbunden.abgeloest is not None:
        await suspended_list_add(redis, verbunden.abgeloest)
        # warning, weil ``info`` in der Cloud unsichtbar ist (logging_setup.py):
        # wer später fragt, warum sein Server stillsteht, findet es hier.
        log.warning(
            "verbinden_uebernahme hostname=%s alt=%s neu=%s",
            vorgang.hostname,
            verbunden.abgeloest,
            instanz_id,
        )
        # Der Soft-Delete lässt ``registered_by`` stehen: der bisherige
        # Besitzer ist bekannt, solange er sein Konto nicht gelöscht hat.
        alt = await db.get(RegisteredInstance, verbunden.abgeloest)
        vorbesitzer = await db.get(User, alt.registered_by) if alt.registered_by else None
        if vorbesitzer is not None:
            await _hinweis_mail(
                db, vorbesitzer, compose_verbinden_uebernahme(vorgang.hostname, jetzt)
            )
    await _hinweis_mail(db, user, compose_verbinden_hinweis(vorgang.hostname, jetzt))
    return EntscheidungAus(status="verbunden", hostname=vorgang.hostname, instance_id=instanz_id)
```

(`db` hat `expire_on_commit=False`, `db.py:31`. `user.email` und der eben gelöschte Eintrag sind nach dem Commit also ohne Nachladen lesbar.)

- [ ] **Step 5: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_verbinden_routen.py services/auth/tests/test_email_change.py`
Expected: alles grün (`test_verbinden_routen.py`: 26 Tests). Ohne SMTP-Konfiguration ruft der Durchlauf-Test die echte `send_email` auf, und die meldet nur `email_skipped`.

- [ ] **Step 6: Vereinfachen.** `code-simplifier` über `email.py`, `routes_verbinden.py` und den Test, Step 5 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 7: Commit.**

```bash
git add services/auth/src/dcc_auth/email.py services/auth/src/dcc_auth/routes_verbinden.py \
  services/auth/tests/test_verbinden_routen.py
git commit -m "feat(auth): Hinweis-Mails beim Verbinden und bei der Übernahme eines Servers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.9: Ereignis an die Geräte des Besitzers nach dem Abholen

Entwurf E3: Der Server erscheint „in der Leiste aller seiner Geräte“. Ohne Ereignis sähen offene Geräte ihn erst beim nächsten Laden von `/me/instances`. Nach erfolgreichem Abholen (Zugangsdaten ausgegeben, `verbunden_at` gesetzt, ab jetzt `set_up = true`) publiziert auth-svc deshalb auf `user:events` ein Ereignis an den Besitzer.

**Was der Weg schon prüft:** Der chat-gateway validiert jedes `user:events`-Ereignis gegen `EVENT_REGISTRY` (`pubsub_channel_handlers.py:261-303` → `maybe_drop` in `pubsub_event_validation.py:94`, Vorgabe `strict`). Ein unbekanntes `op` lässt er mit Warnung durch, prüft dann aber seine Form nicht. Erst der Eintrag im Register macht die Form verbindlich. `shared/tests/test_events.py` fährt jede Registrierung durch `test_event_round_trips` und braucht dafür in `_PAYLOADS` (Zeilen 40–402) eine Beispiel-Nutzlast je `op`. Ohne sie gibt es einen `KeyError`. Muster: `application_decided` (`dcc_shared/events/applications.py`, Register Zeile 198, Publisher `admin_events.publish_application_decided`).

**Abweichung vom Vorschlag `instanzen.py`:** Das Modell kommt in die vorhandene Datei `shared/src/dcc_shared/events/instances.py`. Dort steht schon `InstanceStatusEvent`, das andere Instanz-Ereignis auf `user:events` an dieselben Geräte. Zwei Dateien `instances.py` und `instanzen.py` nebeneinander wären eine Falle beim Suchen.

**Files:**
- Modify: `shared/src/dcc_shared/events/instances.py` (ganze Datei, 27 Zeilen)
- Modify: `shared/src/dcc_shared/events/__init__.py` (Kanal-Übersicht nach Zeile 35, Import Zeile 73, Register nach Zeile 199, `__all__` nach Zeile 287)
- Modify: `services/auth/src/dcc_auth/admin_events.py` (Import nach Zeile 25, neue Funktion am Ende)
- Modify: `services/auth/src/dcc_auth/routes_verbinden.py` (Import, Aufruf in `verbinden_abholen`)
- Test: `shared/tests/test_events.py` (`_PAYLOADS` nach Zeile 166, ein Test am Ende), `services/auth/tests/test_verbinden_routen.py` (zwei Tests anhängen)

**Interfaces:**
- Consumes: `_publish(request, channel, payload)` und `USER_EVENTS_CHANNEL` (`admin_events.py:38`, `:32`). Liest `request.app.state.redis` und fängt jeden Fehler beim `publish` ab.
- Produces:
  - `class InstanzVerbundenData(_EventBase)`: `instance_id: str`
  - `class InstanzVerbundenEvent(_EventBase)`: `op: Literal["instanz_verbunden"]`, `data: InstanzVerbundenData`
  - Wire-Form auf `user:events`: `{"op": "instanz_verbunden", "data": {"instance_id": "<str>"}, "_target_user_id": "<besitzer>"}`. Der chat-gateway streift `_target_user_id` vor der Zustellung ab.
  - `async publish_instanz_verbunden(request: Request, *, user_id: int, instance_id: int) -> None`, best-effort

- [ ] **Step 1: Fehlschlagende Tests schreiben.**

In `shared/tests/test_events.py` im Wörterbuch `_PAYLOADS` direkt nach dem Eintrag `"instance_status": {…},` (Zeilen 163–166) einfügen:

```python
    "instanz_verbunden": {
        "op": "instanz_verbunden",
        "data": {"instance_id": "21000000000000078"},
    },
```

Am Ende derselben Datei anfügen:

```python


def test_instanz_verbunden_traegt_nur_die_nummer() -> None:
    """auth-svc meldet dem Besitzer einen frisch verbundenen Server
    (``admin_events.publish_instanz_verbunden``). Der Payload nennt nur die
    Nummer — die Geräte laden ``/me/instances`` danach selbst."""
    modell = EVENT_REGISTRY["instanz_verbunden"]
    evt = modell.model_validate(_PAYLOADS["instanz_verbunden"])
    assert evt.data.instance_id == "21000000000000078"
    with pytest.raises(Exception):  # pydantic.ValidationError (extra="forbid")
        modell.model_validate(
            {"op": "instanz_verbunden", "data": {"instance_id": "1", "hostname": "x"}}
        )
```

Am Ende von `services/auth/tests/test_verbinden_routen.py` anfügen:

```python


async def test_abholen_meldet_den_server_an_die_geraete_des_besitzers(
    client, mit_redis, nachweis, monkeypatch
):
    """Entwurf E3: der Server erscheint in der Leiste ALLER Geräte des
    Besitzers — offene Geräte erfahren es über ``user:events``, nicht erst
    beim nächsten Laden von ``/me/instances``."""
    import json

    from dcc_shared.events import EVENT_REGISTRY

    gesendet: list[tuple[str, dict]] = []

    async def mitschreiben(kanal, nutzlast):
        gesendet.append((kanal, json.loads(nutzlast)))
        return 0

    monkeypatch.setattr(mit_redis, "publish", mitschreiben)
    konto = await _konto(client, "geraete")
    code = (await _start(client)).json()["code"]
    iid = (await _entscheiden(client, konto, code, "verbinden")).json()["instance_id"]
    # Bestätigt heisst noch nicht eingerichtet: erst das Abholen zählt.
    assert gesendet == []

    assert (await _abholen(client)).status_code == 200
    ((kanal, nutzlast),) = gesendet
    assert kanal == "user:events"
    assert nutzlast.pop("_target_user_id") == str(konto["id"])
    assert nutzlast == {"op": "instanz_verbunden", "data": {"instance_id": iid}}
    # Genau diese Prüfung macht der chat-gateway vor der Zustellung
    # (pubsub_event_validation.py, strikter Modus).
    EVENT_REGISTRY["instanz_verbunden"].model_validate(nutzlast)


async def test_redis_fehler_beim_melden_kostet_das_abholen_nicht(
    client, mit_redis, nachweis, monkeypatch
):
    async def kaputt(*_a, **_k):
        raise ConnectionError("redis weg")

    monkeypatch.setattr(mit_redis, "publish", kaputt)
    konto = await _konto(client, "unbeirrt")
    code = (await _start(client)).json()["code"]
    assert (await _entscheiden(client, konto, code, "verbinden")).status_code == 200
    assert (await _abholen(client)).status_code == 200
```

- [ ] **Step 2: Tests laufen lassen, die neuen müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q shared/tests/test_events.py services/auth/tests/test_verbinden_routen.py`
Expected: `2 failed`, nämlich `test_instanz_verbunden_traegt_nur_die_nummer` (`KeyError: 'instanz_verbunden'`) und `test_abholen_meldet_den_server_an_die_geraete_des_besitzers` (`ValueError: not enough values to unpack (expected 1, got 0)`). Der Test zum Redis-Fehler ist schon grün; er hält fest, dass das so bleibt.

- [ ] **Step 3: Modell** (`shared/src/dcc_shared/events/instances.py`, ganze Datei ersetzen).

```python
"""Ereignisse rund um die Server einer Person — an genau ein Konto.

Publiziert von auth-svc auf ``user:events`` (Routing über
``_target_user_id``):

* ``instance_status`` (``instance_status.py``, je Mitglied): Heim-Server läuft
  / läuft nicht / heißt jetzt so. Die Server-Leiste blendet einen gestoppten
  Heim-Server aus und zeigt den Anzeigenamen statt der Relay-Adresse.
* ``instanz_verbunden`` (``routes_verbinden.py``, an den Besitzer): ein
  Server wurde per Gerätecode mit dem Konto verbunden und hat seine
  Zugangsdaten abgeholt (Spec 2026-10-09, E3). Die Geräte laden
  ``/me/instances`` neu und nehmen ihn in die Leiste.

Ohne diese Ereignisse sähe die Leiste beides erst beim nächsten Laden von
``/me/instances``.
"""

from __future__ import annotations

from typing import Literal

from dcc_shared.events._base import _EventBase


class InstanceStatusData(_EventBase):
    instance_id: str
    online: bool
    anzeigename: str | None = None


class InstanceStatusEvent(_EventBase):
    """``op="instance_status"`` — Online-Zustand oder Name hat sich geändert."""

    op: Literal["instance_status"] = "instance_status"
    data: InstanceStatusData


class InstanzVerbundenData(_EventBase):
    # Nur die Nummer: die Geräte holen alles Weitere über ``/me/instances``,
    # das dieselben Rechte prüft wie jede andere Abfrage der Liste.
    instance_id: str


class InstanzVerbundenEvent(_EventBase):
    """``op="instanz_verbunden"`` — ein Server ist mit deinem Konto verbunden."""

    op: Literal["instanz_verbunden"] = "instanz_verbunden"
    data: InstanzVerbundenData
```

- [ ] **Step 4: Registrieren** (`shared/src/dcc_shared/events/__init__.py`).

In der Kanal-Übersicht unter `* ``user:events``` nach dem Punkt `guild_ban_lifted` (endet Zeile 35 mit `rejoin invite)`) einfügen:

```python
    - ``instanz_verbunden`` (auth-svc: a server was connected to your account
      and fetched its credentials — devices reload ``/me/instances``)
```

Zeile 73 ersetzen:

```python
from dcc_shared.events.instances import InstanceStatusEvent, InstanzVerbundenEvent
```

Im `EVENT_REGISTRY` nach `"instance_status": InstanceStatusEvent,` (Zeile 199) einfügen:

```python
    "instanz_verbunden": InstanzVerbundenEvent,
```

In `__all__` nach `"InstanceStatusEvent",` (Zeile 287) einfügen:

```python
    "InstanzVerbundenEvent",
```

- [ ] **Step 5: Publisher** (`services/auth/src/dcc_auth/admin_events.py`).

Nach `from fastapi import Request` (Zeile 25) einfügen:

```python

from dcc_shared.events.instances import InstanzVerbundenData, InstanzVerbundenEvent
```

Am Dateiende anfügen:

```python


async def publish_instanz_verbunden(request: Request, *, user_id: int, instance_id: int) -> None:
    """Meldet dem Besitzer, dass ein Server mit seinem Konto verbunden ist und
    seine Zugangsdaten abgeholt hat — seine offenen Geräte nehmen ihn sofort
    in die Leiste (Spec 2026-10-09, E3).

    Gebaut aus dem Modell statt als Wörterbuch: der chat-gateway verwirft im
    strikten Modus jede Form, die das Register nicht annimmt. Best-effort wie
    alles hier — ein verlorenes Ereignis kostet nur die Sofortigkeit, das
    Abholen ist da schon geschehen.
    """
    ereignis = InstanzVerbundenEvent(data=InstanzVerbundenData(instance_id=str(instance_id)))
    await _publish(
        request,
        USER_EVENTS_CHANNEL,
        {**ereignis.model_dump(mode="json"), "_target_user_id": str(user_id)},
    )
```

- [ ] **Step 6: Aufruf beim Abholen** (`services/auth/src/dcc_auth/routes_verbinden.py`).

Vor `from dcc_auth.config import get_settings` einfügen:

```python
from dcc_auth.admin_events import publish_instanz_verbunden
```

In `verbinden_abholen` die beiden Zeilen

```python
    await db.commit()
    return VerbindenZugangOut(
```

ersetzen durch:

```python
    await db.commit()
    await publish_instanz_verbunden(request, user_id=instanz.registered_by, instance_id=instanz.id)
    return VerbindenZugangOut(
```

- [ ] **Step 7: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q shared/tests/test_events.py services/auth/tests/test_verbinden_routen.py services/chat-gateway/tests/test_event_validation.py`
Expected: alles grün (`test_verbinden_routen.py`: 28 Tests).

- [ ] **Step 8: Vereinfachen.** `code-simplifier` über alle in Step 1–6 geänderten Dateien, Step 7 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 9: Commit.**

```bash
git add shared/src/dcc_shared/events/instances.py shared/src/dcc_shared/events/__init__.py \
  shared/tests/test_events.py services/auth/src/dcc_auth/admin_events.py \
  services/auth/src/dcc_auth/routes_verbinden.py services/auth/tests/test_verbinden_routen.py
git commit -m "feat(auth): verbundener Server erscheint sofort auf allen Geräten des Besitzers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.10: Admin-Schalter „Darf Server verbinden“

Die Spalte gibt es seit Task 1.2. Hier kommt sie in die Admin-Nutzerliste und den Admin-Patch, mit Protokolleintrag wie `self_host_enabled`. Der Owner-Schutz (`routes_admin.py:145-158`) gilt auch hier: Kein Zweit-Admin darf den Betreiber vom Verbinden aussperren. Die Oberfläche (Schalter in der Nutzerliste) ist Teil C, Etappe 5.

**Files:**
- Modify: `services/auth/src/dcc_auth/schemas.py:143` (`UserAdminOut`), `:156` (`UserAdminPatch`)
- Modify: `services/auth/src/dcc_auth/routes_admin.py:145-154` (Owner-Schutz), nach `:221` (neuer Block)
- Test: `services/auth/tests/test_admin.py` (zwei Tests am Dateiende, nach Zeile 392)

**Interfaces:**
- Consumes: `User.server_verbinden_gesperrt` (Task 1.2), `_audit` (`routes_admin.py:54`).
- Produces: `UserAdminOut.server_verbinden_gesperrt: bool`, `UserAdminPatch.server_verbinden_gesperrt: bool | None`. Der Protokolleintrag `user.patch` bekommt den Payload `{"server_verbinden_gesperrt": {"from": …, "to": …}}`.

- [ ] **Step 1: Fehlschlagende Tests anhängen** (Ende von `services/auth/tests/test_admin.py`; `pytest`, `select`, `User`, `_register_user`, `_promote` und `_login` sind dort vorhanden).

```python


# ─── Riegel „Darf Server verbinden“ (Spec 2026-10-09, E8) ───────────────────


@pytest.mark.asyncio
async def test_admin_sperrt_das_verbinden_von_servern(client, admin_token, session_factory):
    await _register_user(client, username="bob", email="bob@example.com")
    async with session_factory() as s:
        bob_id = (await s.execute(select(User.id).where(User.username == "bob"))).scalar_one()
    headers = {"Authorization": f"Bearer {admin_token}"}

    rows = (await client.get("/admin/users", headers=headers)).json()
    assert next(u for u in rows if u["username"] == "bob")["server_verbinden_gesperrt"] is False

    r = await client.patch(
        f"/admin/users/{bob_id}", json={"server_verbinden_gesperrt": True}, headers=headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["server_verbinden_gesperrt"] is True
    async with session_factory() as s:
        assert (await s.get(User, bob_id)).server_verbinden_gesperrt is True

    eintraege = (await client.get("/admin/audit-log", headers=headers)).json()
    (eintrag,) = [
        e for e in eintraege if e["action"] == "user.patch" and int(e["target_id"]) == bob_id
    ]
    assert eintrag["payload"] == {"server_verbinden_gesperrt": {"from": False, "to": True}}


@pytest.mark.asyncio
async def test_owner_darf_nicht_vom_verbinden_ausgesperrt_werden(
    client, admin_token, session_factory
):
    await _register_user(client, username="bob", email="bob@example.com")
    await _promote(session_factory, "bob")
    bob_token = await _login(client, username_or_email="bob")
    async with session_factory() as s:
        alice_id = (
            await s.execute(select(User.id).where(User.username == "alice"))
        ).scalar_one()

    r = await client.patch(
        f"/admin/users/{alice_id}",
        json={"server_verbinden_gesperrt": True},
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    assert r.status_code == 400
    assert "owner" in r.json()["detail"]
```

- [ ] **Step 2: Tests laufen lassen, die neuen müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_admin.py`
Expected: `2 failed, 17 passed`, mit `KeyError: 'server_verbinden_gesperrt'` und `assert 200 == 400`.

- [ ] **Step 3: Schemas** (`services/auth/src/dcc_auth/schemas.py`).

In `UserAdminOut` nach `self_host_enabled: bool = False` (Zeile 143) einfügen:

```python
    # Riegel „Darf Server verbinden“ (Migration 0056, Spec 2026-10-09 E8).
    server_verbinden_gesperrt: bool = False
```

In `UserAdminPatch` nach `self_host_enabled: bool | None = None` (Zeile 156) einfügen:

```python
    server_verbinden_gesperrt: bool | None = None
```

- [ ] **Step 4: Patch-Route** (`services/auth/src/dcc_auth/routes_admin.py`).

Den Owner-Schutz (Kommentar und Bedingung bis `):`, Zeilen 145–154) ersetzen:

```python
    # Owner-Schutz: der Betreiber kann von niemandem (auch keinem Zweit-Admin)
    # entmachtet (is_admin→false), gesperrt (disabled→true) oder in seinen
    # Self-Host-Rechten beschnitten (self_host_enabled→false,
    # server_verbinden_gesperrt→true) werden. Sonst könnte ein Admin den Owner
    # ausschalten und sich selbst die Owner-Rechte (Self-Host-/App-Host-
    # Genehmigung) verschaffen.
    if user.is_owner and (
        payload.is_admin is False
        or payload.disabled is True
        or payload.self_host_enabled is False
        or payload.server_verbinden_gesperrt is True
    ):
```

Nach dem `self_host_enabled`-Block (endet Zeile 221 mit `user.self_host_enabled = payload.self_host_enabled`) und vor `if changes:` einfügen:

```python

    neu_gesperrt = payload.server_verbinden_gesperrt
    if neu_gesperrt is not None and neu_gesperrt != user.server_verbinden_gesperrt:
        # Wirkt nur auf künftiges Verbinden (routes_verbinden.py). Schon
        # verbundene Server laufen weiter; die stoppt die Instanz-Sperre.
        changes["server_verbinden_gesperrt"] = {
            "from": user.server_verbinden_gesperrt,
            "to": neu_gesperrt,
        }
        user.server_verbinden_gesperrt = neu_gesperrt
```

- [ ] **Step 5: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_admin.py`
Expected: `19 passed`.

- [ ] **Step 6: Vereinfachen.** `code-simplifier` über `schemas.py`, `routes_admin.py` und `test_admin.py`, Step 5 wiederholen, `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 7: Commit.**

```bash
git add services/auth/src/dcc_auth/schemas.py services/auth/src/dcc_auth/routes_admin.py \
  services/auth/tests/test_admin.py
git commit -m "feat(auth): Admin-Schalter „Darf Server verbinden“

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1.11: Landen

**Files:** keine neuen.

- [ ] **Step 1: Ganze Backend-Suite, dann das Gate.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q -n 8 shared/tests services/auth/tests`
Expected: alles grün (am 2026-10-11 in einer Kopie nachgefahren: `925 passed, 2 skipped`; dazu `services/chat-gateway/tests` mit `1741 passed`, weil der chat-gateway das geänderte Ereignis-Register liest — das Gate fährt ihn ohnehin mit).

Run: `bash scripts/gate.sh`
Expected: grün. Der Python-Teil läuft, weil sich `services/` und `shared/` gegenüber `origin/main` geändert haben. Web und Rust werden übersprungen (Teilbaum gleich `origin/main`). Den Lauf nicht neben `cargo build` oder `pnpm build` legen (CLAUDE.md „Tests“).

- [ ] **Step 2: Changelog bewusst auslassen.**

Run: `bash scripts/check-changelog.sh origin/main HEAD`
Expected: die Warnung `Dieser Push ändert Code, aber web/static/changelog.json wurde nicht aktualisiert.` Sie ist hier richtig, denn `services/auth/src/**` und `shared/src/**` stehen nicht in `NON_USER_FACING` (`scripts/check-changelog.sh:27`), und das Skript endet immer mit `exit 0`. Kein Eintrag: Ohne `pulse-connect` (Etappe 2) und ohne Bestätigungsseite (Etappe 3) kann kein Nutzer etwas davon bemerken. Neue Heim-Server zeigen nur in der Admin-Liste leere Worker-IDs.

- [ ] **Step 3: Freigabe des Eigentümers einholen, dann landen.** Landen heißt Prod-Deploy: Der Cron auf dem netcup zieht `:latest` binnen 5 Minuten und fährt `migrate-auth` mit, also Migration 0056 auf der Cloud-Datenbank. Erst nach ausdrücklichem „ja“:

```bash
bash scripts/ship.sh
```

- [ ] **Step 4: Cloud prüfen (nur lesend, nach ≤ 5 Minuten).**

```bash
ssh michael@159.195.150.54 'docker exec pulse_postgres psql -U dcc -d dcc -tAc "select version_num from auth.alembic_version"'
```
Expected: `0056_verbinden`.

```bash
ssh michael@159.195.150.54 "docker exec pulse_postgres psql -U dcc -d dcc -tAc \"select hostname, origin, ohne_freigabe, worker_id_chat is not null from auth.registered_instances where status = 'active' order by registered_at\""
```
Expected: die fünf Bestandsserver (drei `vps`, zwei `app_host`), alle mit `ohne_freigabe = f` und Worker-IDs (`t`).

```bash
curl -s -w ' %{http_code}\n' -X POST https://howispulse.com/api/auth/selfhost/verbinden/start \
  -H 'Content-Type: application/json' \
  -d '{"hostname":"localhost","kennung":"probeprobeprobeprobeprobeprobeprobe"}'
```
Expected: `{"detail":"adresse_ungueltig"} 400`. Damit sind Route, nginx-Weg und Cloud-Riegel bestätigt, ohne einen Vorgang anzulegen oder einen fremden Rechner abzufragen. Verbraucht einen der 10 Starts pro Stunde dieser IP.

```bash
ssh michael@159.195.150.54 'docker logs --since 10m pulse_auth 2>&1 | grep -iE "error|traceback" | tail -20'
```
Expected: keine neuen Fehler.

- [ ] **Step 5: Bestand in der App prüfen (Eigentümer).** App neu laden: Alle Server stehen weiter in der Leiste. Anmelden auf einem Bestands-VPS klappt, sein Besitzer ist dort Admin. `Admin → Anträge → Aktive Instanzen` lädt. Heim-Server: Server-App starten, er erscheint wie bisher.

- [ ] **Step 6: Aufräumen.** `git checkout main && git pull --ff-only && git tidy`.

---

---

## Etappe 2 — Server: Start ohne Verbindung und pulse-connect

Danach ist live: Das Self-Host-Image startet mit nichts als `PULSE_HOSTNAME`, liefert `/.well-known/pulse-verbinden` und `verbunden` in der Server-Info aus, nimmt unverbunden niemanden auf (`POST /session` → 503 `nicht_verbunden`) und bringt `pulse-connect` mit, das ihn per Gerätecode mit einem Pulse-Konto verbindet; Bestandsserver laufen unverändert, weil ihre Werte aus der Umgebung gewinnen.

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/verbinden-server`

**Voraussetzungen.** Etappe 1 ist auf `main` (der Prüfstein in Task 2.4 importiert `dcc_auth.verbinden.nachweis_aus_kennung`; die Rauchprobe in Task 2.5 braucht die Cloud-Routen live). Etappe 0 ist durch (Bildname für die Rauchprobe). Für Einzelläufe der chat-gateway-Tests muss der Dev-Redis auf Port 6380 laufen (`docker compose up -d redis`); das Gate startet eigene.

**Was im Image wie ankommt (geprüft).** `infra/self-host/Dockerfile:394` kopiert `infra/self-host/s6/` als Ganzes nach `/` — eine neue Datei unter `s6/usr/local/bin/` landet ohne Dockerfile-Änderung in `/usr/local/bin/`. Den Modus setzt das Dockerfile dort nicht (Zeile 412–414 machen nur `scripts/*.sh` und `s6-rc.d` ausführbar); er kommt aus Git, wie bei `pulse-doctor` (`git ls-files -s` → `100755`). Python im Image: `/opt/pulse/venv/bin/python3` (uv-venv, `UV_PROJECT_ENVIRONMENT=/opt/pulse/venv`, Zeile 109; Muster `infra/self-host/servername.py`). Die Dienste lesen ausschließlich `/etc/pulse/env.sh` (`s6-rc.d/*/run`: `. /etc/pulse/env.sh`); ein `docker exec` sieht nur die Container-Umgebung, deshalb sourct die Hülle `env.sh` selbst.

**Wem gehört `/data/pulse`, und wer liest was (geklärt).**

| Pfad | Besitzer, Modus | Schreibt | Liest |
|---|---|---|---|
| `/data` | `pulse:pulse` (uid/gid 10001), 0700 | `01-init-data-dirs.sh` (`chown -R` bei jedem Start) | alle |
| `/data/pulse` | `pulse:pulse`, 0700 (neu in Task 2.3) | `01-init-data-dirs.sh` | — |
| `/data/pulse/verbinden-nachweis` | root, 0644 (bis zum nächsten Start) | `pulse-connect` (root, `docker exec`) | chat-gateway als `pulse`: Verzeichnis gehört ihm, Datei ist für alle lesbar |
| `/data/pulse/verbindung.env` | root, 0600; ab dem nächsten Start `pulse:pulse` 0600 (`chown -R`) | `pulse-connect` | nur `07-render-env.sh`, das als root läuft (cont-init, kein `USER` im Dockerfile) |

`pulse-connect` läuft bewusst als root und nicht über `gosu pulse` wie der Dienst: der Neustart über `/run/s6/basedir/bin/halt` braucht root (dasselbe Kommando steht in `restart-gate.sh:36`).

**Stellen, die heute eine Instanz-Nummer oder Cloud-Zugangsdaten voraussetzen, und ihr Verhalten unverbunden** (`git grep -n 'pulse_instance_id\|pulse_instance_owner_id\|pulse_cloud_client\|PULSE_INSTANCE_ID\|PULSE_CLOUD_CLIENT' -- services shared infra/self-host`):

| Stelle | Heute | Unverbunden nach Etappe 2 | Task |
|---|---|---|---|
| `10-check-cloud-creds.sh` | bricht ohne 6 Werte ab | nur `PULSE_HOSTNAME` Pflicht | 2.3 |
| `07-render-env.sh:153–161` | `${PULSE_INSTANCE_ID}` unter `set -u` → Abbruch | `:-0` / `:-`; liest `verbindung.env` für leere Werte | 2.3 |
| `09-init-caddy.sh` + `Caddyfile.template:3` | `email {$PULSE_ADMIN_EMAIL}` leer → Caddy startet nicht | `email`-Zeile entfällt ohne Mail | 2.3 |
| chat-gateway `config.py:131,231` (`int`) | `''` wäre ein pydantic-Fehler | `07` rendert `'0'` | 2.3 |
| `app.py:172–184` | `RuntimeError` | entfällt; Warnzeile mit `pulse-connect` | 2.2 |
| `app.py:286–298` Sperr-Poller, Name-Abgleich | an `pulse_instance_id` gebunden | laufen nicht (unverändert) | — |
| `app.py:339` `log_owner_konfiguration` | „nobody will be able to manage it“ | ersetzt durch `melde_verbindungsstand` | 2.2 |
| `routes/session_ticket.py:96–97` | 503 `instance_id_unconfigured` | 503 `nicht_verbunden` | 2.2 |
| `routes/server_info.py` | `instance_id: null` | zusätzlich `verbunden: false` | 2.1 |
| `routes/owner_check.py:156–160` | Claim-`instance_id` gegen 0 → 401 | unverändert 401 (es gibt keinen Cloud-Eintrag, der fragen würde) | — |
| `instance_name.py:46–48` | an Nummer und Zugangsdaten gebunden | schläft (unverändert) | — |
| `routes/ws_ops_handlers.py:570`, `routes/admin_diagnose_paket.py:233` | lesen die Nummer | nur mit Sitzung erreichbar → unerreichbar | — |
| `jwks_poller`, `cloud_policy_poller` | brauchen nur `PULSE_CLOUD_ORIGIN` | laufen | — |
| `s6-rc.d/direct-adapter/run:10` | schläft ohne Zugangsdaten | schläft (unverändert) | — |
| media-svc `config.py:82` (`str`) | Besitzer-Vergleich | `"0"` trifft keine echte Kennung | — |
| auth-svc, voice-signaling, mediamtx-auth-hook | lesen keine Instanz-Nummer (`config.py` ohne Feld) | unverändert | — |

---

### Task 2.1: Nachweis-Route, Feld `verbunden`, Caddy-Zeile

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/verbindung.py`
- Create: `services/chat-gateway/src/dcc_chat_gateway/routes/verbinden_nachweis.py`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/config.py:241` (Einstellung danach einfügen)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/__init__.py:83` (Import) und `:132` (Router)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/server_info.py` (ganze Datei, 66 Zeilen)
- Modify: `infra/self-host/s6/etc/caddy/Caddyfile.template:142` (Block danach einfügen)
- Create: `services/chat-gateway/tests/test_verbinden_nachweis_route.py`
- Modify: `services/chat-gateway/tests/test_server_info.py:1–8` (Docstring) und ans Ende (nach Zeile 125)
- Create: `infra/self-host/tests/test_caddy_wellknown.py`

**Interfaces:**
- Consumes: `dcc_chat_gateway.config.get_settings()` (`config.py:456`, Modulzugriff wie `routes/owner_check.py:56`); `Settings.pulse_instance_mode`, `Settings.pulse_instance_id`.
- Produces:
  - `Settings.pulse_verbinden_dir: str = "/data/pulse"` (Umgebung `PULSE_VERBINDEN_DIR`)
  - `dcc_chat_gateway.verbindung.NACHWEIS_DATEI = "verbinden-nachweis"`, `VERBINDUNG_DATEI = "verbindung.env"`
  - `dcc_chat_gateway.verbindung.ist_verbunden(settings) -> bool` (`mode != "self-host" or bool(pulse_instance_id)`)
  - `dcc_chat_gateway.verbindung.nachweis_lesen(verzeichnis: Path) -> str | None` (nur `[0-9a-f]{64}`)
  - `GET /.well-known/pulse-verbinden` → 200 `{"nachweis": "<64 hex>"}`, sonst 404; in der Cloud immer 404
  - `ServerInfo.verbunden: bool` in `GET /.well-known/pulse-server-info`

- [ ] **Step 1: Fehlschlagende Tests schreiben.**

`services/chat-gateway/tests/test_verbinden_nachweis_route.py`:

```python
"""``GET /.well-known/pulse-verbinden`` — der Nachweis beim Verbinden (Spec 2026-10-09, E2)."""

from __future__ import annotations

import pytest

from dcc_chat_gateway.verbindung import NACHWEIS_DATEI

PFAD = "/.well-known/pulse-verbinden"
WERT = "ab" * 32


@pytest.fixture
def verzeichnis(tmp_path, monkeypatch, _isolate_chat_settings):
    monkeypatch.setattr(_isolate_chat_settings, "pulse_verbinden_dir", str(tmp_path))
    return tmp_path


@pytest.mark.asyncio
async def test_liefert_den_abgelegten_nachweis(client, verzeichnis):
    (verzeichnis / NACHWEIS_DATEI).write_text(WERT + "\n", encoding="ascii")
    r = await client.get(PFAD)
    assert r.status_code == 200, r.text
    assert r.json() == {"nachweis": WERT}


@pytest.mark.asyncio
async def test_ohne_datei_404(client, verzeichnis):
    r = await client.get(PFAD)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_fremder_inhalt_wird_nicht_ausgeliefert(client, verzeichnis):
    """Die Route ist anonym: was nicht genau wie ein Nachweis aussieht, bleibt drin."""
    (verzeichnis / NACHWEIS_DATEI).write_text("PULSE_CLOUD_CLIENT_SECRET=geheim\n")
    r = await client.get(PFAD)
    assert r.status_code == 404
    assert "geheim" not in r.text


@pytest.mark.asyncio
async def test_in_der_cloud_gibt_es_keinen_nachweis(
    client, verzeichnis, monkeypatch, _isolate_chat_settings
):
    (verzeichnis / NACHWEIS_DATEI).write_text(WERT + "\n", encoding="ascii")
    monkeypatch.setattr(_isolate_chat_settings, "pulse_instance_mode", "cloud")
    r = await client.get(PFAD)
    assert r.status_code == 404
```

In `services/chat-gateway/tests/test_server_info.py` die Abdeckungsliste im Modul-Docstring (Zeilen 3–8) um eine Zeile ergänzen — nach `4. Response carries server_version and pulse_oidc_issuer.` einfügen:

```
5. verbunden: false only for a self-host without instance id (Spec 2026-10-09, E4).
```

und ans Dateiende anhängen:

```python


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("modus", "instanz", "erwartet"),
    [("self-host", 0, False), ("self-host", 123456789, True), ("cloud", 0, True)],
)
async def test_server_info_meldet_ob_verbunden(client, modus, instanz, erwartet):
    """Ein unverbundener Self-Host sagt es von sich aus (Spec 2026-10-09, E4) —
    wer die Server-Info liest, erkennt daran, dass ``pulse-connect`` noch fehlt."""
    mock_settings = _make_settings(pulse_instance_mode=modus, pulse_instance_id=instanz)
    with patch("dcc_chat_gateway.routes.server_info.get_settings", return_value=mock_settings):
        r = await client.get("/.well-known/pulse-server-info")
    assert r.status_code == 200
    assert r.json()["verbunden"] is erwartet
```

`infra/self-host/tests/test_caddy_wellknown.py` (bisher prüft kein Test, ob die Vorlage die well-known-Pfade führt — `test_caddy_attachments_cors.py` und `test_caddy_tls_modi.py` decken andere Blöcke ab):

```python
"""Jeder well-known-Pfad des chat-gateway braucht eine eigene Zeile in der Caddy-Vorlage.

Fehlt sie, greift der SPA-Rückfall am Ende der Vorlage und antwortet mit einer
leeren HTML-Seite und Status 200 — für ``/.well-known/pulse-verbinden`` hieße
das: die Cloud findet beim Verbinden keinen Nachweis, und ``pulse-connect``
schickt den Betreiber auf die Suche nach einem Fehler, der in der Vorlage
steckt. Dieselbe Falle hat die Cloud-Poller schon einmal erwischt (CLAUDE.md,
well-known-Endpoints). Geprüft wird die Vorlage selbst; die sed-Ersetzungen
aus 09-init-caddy.sh fassen diese Blöcke nicht an.
"""

from __future__ import annotations

import pathlib

import pytest

TEMPLATE = (
    pathlib.Path(__file__).resolve().parents[1] / "s6" / "etc" / "caddy" / "Caddyfile.template"
)


def _handle_block(pfad: str) -> str | None:
    """Der ``handle <pfad> { … }``-Block (Klammern gezählt), oder ``None``."""
    zeilen = TEMPLATE.read_text(encoding="utf-8").split("\n")
    start = next((i for i, z in enumerate(zeilen) if z.strip() == f"handle {pfad} {{"), None)
    if start is None:
        return None
    tiefe = 0
    for i in range(start, len(zeilen)):
        tiefe += zeilen[i].count("{") - zeilen[i].count("}")
        if tiefe == 0:
            return "\n".join(zeilen[start : i + 1])
    raise AssertionError(f"handle-Block für {pfad} nicht geschlossen")


@pytest.mark.parametrize(
    "pfad",
    [
        "/.well-known/pulse-server-info",
        "/.well-known/pulse-owner-check",
        "/.well-known/pulse-verbinden",
    ],
)
def test_well_known_pfad_geht_an_den_chat_gateway(pfad):
    block = _handle_block(pfad)
    assert block is not None, f"keine Zeile 'handle {pfad} {{' in der Caddy-Vorlage"
    assert "reverse_proxy 127.0.0.1:8002" in block
```

- [ ] **Step 2: Tests laufen lassen, sie müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_verbinden_nachweis_route.py`
Expected: FAIL — Sammelfehler `ModuleNotFoundError: No module named 'dcc_chat_gateway.verbindung'`, `Interrupted: 1 error during collection` (deshalb die übrigen Dateien getrennt).

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_server_info.py infra/self-host/tests/test_caddy_wellknown.py`
Expected: FAIL — `test_server_info_meldet_ob_verbunden[...]` dreimal mit `KeyError: 'verbunden'`, `test_well_known_pfad_geht_an_den_chat_gateway[/.well-known/pulse-verbinden]` mit `AssertionError: keine Zeile 'handle /.well-known/pulse-verbinden {'`. Die beiden anderen Caddy-Fälle und die bestehenden Server-Info-Tests sind grün.

- [ ] **Step 3: Einstellung in `config.py`.** Nach Zeile 241 (`    pulse_cloud_client_secret: str = ""`) einfügen:

```python

    # Verbinden mit einem Pulse-Konto (pulse-connect, Spec 2026-10-09 E4/E6):
    # hier liegen während des Verbindens der Nachweis (``verbinden-nachweis``)
    # und danach die abgeholten Zugangsdaten (``verbindung.env``).
    # 07-render-env.sh setzt den Pfad im Container aus PULSE_DATA_PATH.
    pulse_verbinden_dir: str = "/data/pulse"
```

(`config.py` liegt mit 458 Zeilen schon über der weichen Grenze; +6 Zeilen, hart 500 bleibt gewahrt. Ein Aufteilen der Einstellungen ist nicht Teil dieser Etappe.)

- [ ] **Step 4: `services/chat-gateway/src/dcc_chat_gateway/verbindung.py` anlegen** (Fassung dieses Tasks; Task 2.2 ergänzt die Meldung beim Start):

```python
"""Verbindung dieses Servers mit einem Pulse-Konto (Spec 2026-10-09, E2/E4/E6).

Gemeinsame Namen für die Stellen, die sonst je eine eigene Fassung hätten: die
Nachweis-Route (``routes/verbinden_nachweis.py``), die Server-Info
(``routes/server_info.py``), ``POST /session``, den Start (``app.py``) und das
Werkzeug ``pulse-connect`` (``verbinden_cli.py``). Die Dateien liegen in
``settings.pulse_verbinden_dir`` (Container: ``/data/pulse``, gesetzt von
07-render-env.sh).
"""

from __future__ import annotations

import re
from pathlib import Path

#: Eine Zeile, 64 Hex-Zeichen: der SHA-256 der Abholkennung. Liegt nur, solange
#: ``pulse-connect`` auf die Bestätigung wartet.
NACHWEIS_DATEI = "verbinden-nachweis"
#: Die abgeholten Zugangsdaten (0600). Gelesen von 07-render-env.sh, nicht von
#: den Diensten selbst — die sehen nur ``/etc/pulse/env.sh``.
VERBINDUNG_DATEI = "verbindung.env"

_NACHWEIS_FORM = re.compile(r"[0-9a-f]{64}")


def ist_verbunden(settings) -> bool:
    """Ein Self-Host ohne Instanz-Nummer ist noch mit keinem Konto verbunden.

    Die Cloud gilt immer als verbunden — sie ist die Gegenstelle.
    """
    return settings.pulse_instance_mode != "self-host" or bool(settings.pulse_instance_id)


def nachweis_lesen(verzeichnis: Path) -> str | None:
    """Der abgelegte Nachweis, oder ``None``, wenn keiner in gültiger Form da ist.

    Eine Datei mit anderem Inhalt liefert ``None`` statt ihres Inhalts: die
    Route ist anonym und soll nichts ausliefern, was nicht genau die erwartete
    Form hat.
    """
    try:
        wert = (verzeichnis / NACHWEIS_DATEI).read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return wert if _NACHWEIS_FORM.fullmatch(wert) else None
```

- [ ] **Step 5: `services/chat-gateway/src/dcc_chat_gateway/routes/verbinden_nachweis.py` anlegen:**

```python
"""``GET /.well-known/pulse-verbinden`` — der Nachweis beim Verbinden (Spec 2026-10-09, E2).

Während ``pulse-connect`` auf die Bestätigung im Browser wartet, liegt in
``<pulse_verbinden_dir>/verbinden-nachweis`` der SHA-256 seiner geheimen
Abholkennung. Die Cloud bekommt beim Anfragen des Gerätecodes die Kennung
selbst, bildet den Hash und vergleicht ihn mit dem Wert hier — beim Anfragen
und noch einmal vor dem Eintragen. Wer eine fremde Adresse für sich eintragen
will, kann dort keinen passenden Wert hinlegen.

Anonym, weil die Cloud sich gegenüber einem Server, den sie noch gar nicht
kennt, nicht ausweisen kann. Preisgegeben wird nichts, was einem Dritten
nützt: der Hash öffnet nichts — anfragen und abholen kann nur, wer die Kennung
selbst hat (deshalb schickt ``pulse-connect`` beim Anfragen die Kennung und
nicht den Hash, Vertrag Nachtrag 2).
Ohne Datei — der Normalfall, auch auf jedem Bestandsserver — antwortet die
Route 404. Keine Bremse: eine Antwort kostet das Lesen einer Datei von 65
Byte, ohne Datenbank und ohne Redis.

Nur auf einem Self-Host: die Cloud verbindet sich nicht mit sich selbst.
Braucht eine Zeile im ``Caddyfile.template`` (Muster ``owner_check.py``).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

# Modul-Zugriff statt ``from … import get_settings`` — Begründung in
# ``owner_check.py`` (Tests tauschen den Anbieter aus).
from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway.verbindung import nachweis_lesen

router = APIRouter()


class NachweisAus(BaseModel):
    nachweis: str


@router.get("/.well-known/pulse-verbinden", response_model=NachweisAus)
async def verbinden_nachweis() -> NachweisAus:
    settings = chat_config.get_settings()
    wert = None
    if settings.pulse_instance_mode == "self-host":
        wert = nachweis_lesen(Path(settings.pulse_verbinden_dir))
    if wert is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return NachweisAus(nachweis=wert)
```

- [ ] **Step 6: Router einhängen** (`routes/__init__.py`). Zeile 83–84 ersetzen:

```python
    users,
    voice_pull,
```

durch

```python
    users,
    verbinden_nachweis,
    voice_pull,
```

und Zeile 132 ersetzen:

```python
router.include_router(owner_check.router)
```

durch

```python
router.include_router(owner_check.router)
router.include_router(verbinden_nachweis.router)
```

- [ ] **Step 7: `services/chat-gateway/src/dcc_chat_gateway/routes/server_info.py` vollständig ersetzen:**

```python
"""GET /.well-known/pulse-server-info — public, no auth (Phase 3.3).

Returns the server version, OIDC issuer, instance identity, and capability
list so that clients can negotiate compatibility before opening a WS
connection.

Shape::

    {
        "server_version": "0.8.0",
        "build_version": "48c405a",
        "pulse_oidc_issuer": "https://howispulse.com",
        "instance_id": "<snowflake-string>|null",
        "capabilities": ["token_refresh", "server-ticket"],
        "verbunden": true
    }

``instance_id`` is null when ``PULSE_INSTANCE_MODE=cloud`` (the Cloud
instance has no separate ID; everything is identified by the issuer).
Self-hosted instances carry the Snowflake-ID they received from the Cloud
on registration (``PULSE_INSTANCE_ID`` env var, stored in settings).

``build_version`` ist der Baustempel des Laufs (2026-09-11): der kurze
Commit-SHA, den die CI beim Bauen ins Image schreibt — derselbe Stempel auf
Cloud und Self-Host bedeutet byte-identischen Stand. Ohne CI-Bau: ``dev``.
``server_version`` bleibt die handgesetzte KOMPATIBILITAETS-Nummer und
sagt nichts ueber den Stand (s. ``dcc_chat_gateway.build_version``).

``verbunden`` (Spec 2026-10-09, E4): ``false`` heißt, dieser Self-Host ist noch
mit keinem Pulse-Konto verbunden und nimmt niemanden auf; abhelfen kann nur
``pulse-connect`` auf dem Server. Die Cloud meldet immer ``true``. Dieselbe
Rechnung wie ``POST /session`` (``verbindung.ist_verbunden``).
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from dcc_chat_gateway import __version__, build_version
from dcc_chat_gateway.config import get_settings
from dcc_chat_gateway.faehigkeiten import SERVER_FAEHIGKEITEN
from dcc_chat_gateway.verbindung import ist_verbunden

router = APIRouter()


class ServerInfo(BaseModel):
    server_version: str
    build_version: str = "dev"
    pulse_oidc_issuer: str
    instance_id: str | None
    capabilities: list[str]
    verbunden: bool = True


@router.get("/.well-known/pulse-server-info", response_model=ServerInfo)
async def server_info() -> ServerInfo:
    """Return public server metadata for client compatibility checks."""
    settings = get_settings()

    if settings.pulse_instance_mode == "cloud":
        instance_id = None
    else:
        raw_id = settings.pulse_instance_id
        instance_id = str(raw_id) if raw_id else None

    return ServerInfo(
        server_version=__version__,
        build_version=build_version(),
        pulse_oidc_issuer=settings.pulse_oidc_issuer,
        instance_id=instance_id,
        capabilities=list(SERVER_FAEHIGKEITEN),
        verbunden=ist_verbunden(settings),
    )
```

(Der Import `from dcc_chat_gateway.config import get_settings` bleibt bewusst gebunden: die bestehenden Tests patchen `dcc_chat_gateway.routes.server_info.get_settings`.)

- [ ] **Step 8: Caddy-Zeile.** In `infra/self-host/s6/etc/caddy/Caddyfile.template` nach Zeile 142 (schließende Klammer des `handle /.well-known/pulse-owner-check`-Blocks) einfügen:

```
        # pulse-verbinden trägt beim Verbinden mit einem Pulse-Konto den
        # Nachweis, dass dieser Server unter seiner Adresse läuft (pulse-connect,
        # Spec 2026-10-09 E2). Die Cloud ruft ihn von aussen ab; ohne diese Zeile
        # bekäme sie statt des Nachweises die leere SPA-Seite. Ebenfalls
        # chat-gateway.
        handle /.well-known/pulse-verbinden {
            reverse_proxy 127.0.0.1:8002 {
                header_up Host {host}
                header_up X-Forwarded-For {remote_host}
            }
        }
```

(Exakter Pfad statt `/.well-known/*`, damit `/.well-known/acme-challenge` für Let's Encrypt frei bleibt — Kommentar Zeile 114–118 der Vorlage.)

- [ ] **Step 9: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_verbinden_nachweis_route.py services/chat-gateway/tests/test_server_info.py infra/self-host/tests/test_caddy_wellknown.py infra/self-host/tests/test_caddy_tls_modi.py infra/self-host/tests/test_caddy_attachments_cors.py`
Expected: PASS (alle; die beiden bestehenden Caddy-Dateien als Gegenprobe, dass der neue Block die sed-Ersetzungen nicht stört).

- [ ] **Step 10: Vereinfachen.** `code-simplifier`-Agent über `verbindung.py`, `routes/verbinden_nachweis.py`, `routes/server_info.py`, `routes/__init__.py`, `config.py`, `Caddyfile.template` und die drei Testdateien; danach Step 9 erneut (grün), dann `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 11: Commit.**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/verbindung.py \
  services/chat-gateway/src/dcc_chat_gateway/routes/verbinden_nachweis.py \
  services/chat-gateway/src/dcc_chat_gateway/routes/__init__.py \
  services/chat-gateway/src/dcc_chat_gateway/routes/server_info.py \
  services/chat-gateway/src/dcc_chat_gateway/config.py \
  infra/self-host/s6/etc/caddy/Caddyfile.template \
  services/chat-gateway/tests/test_verbinden_nachweis_route.py \
  services/chat-gateway/tests/test_server_info.py \
  infra/self-host/tests/test_caddy_wellknown.py
git commit -m "feat(self-host): Nachweis unter /.well-known/pulse-verbinden und Feld verbunden in der Server-Info

Der chat-gateway liefert den Nachweis aus, den pulse-connect beim Verbinden
ablegt (Spec 2026-10-09, E2); die Caddy-Vorlage führt den Pfad. Die
Server-Info sagt, ob ein Self-Host schon mit einem Konto verbunden ist.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.2: chat-gateway startet ohne Verbindung, `POST /session` antwortet 503 `nicht_verbunden`

**Files:**
- Modify: `services/chat-gateway/src/dcc_chat_gateway/verbindung.py` (aus Task 2.1)
- Modify: `services/chat-gateway/src/dcc_chat_gateway/app.py:23`, `:36–37`, `:172–184`, `:285`, `:337–339`
- Modify: `services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py:26` (Import danach) und `:91–97`
- Create: `services/chat-gateway/tests/test_start_ohne_verbindung.py`
- Modify: `services/chat-gateway/tests/test_session_ticket_route.py` (Test ans Ende anhängen)

**Interfaces:**
- Consumes: `dcc_chat_gateway.owner_admin_log.log_owner_konfiguration(settings) -> None` (`owner_admin_log.py:45`); `verbindung.ist_verbunden` (Task 2.1).
- Produces:
  - `dcc_chat_gateway.verbindung.NICHT_VERBUNDEN_HINWEIS: str` = `"This server is not connected to a Pulse account yet. Run: docker exec -it pulse pulse-connect"`
  - `dcc_chat_gateway.verbindung.melde_verbindungsstand(settings) -> None` (Warnzeile unverbunden, sonst `log_owner_konfiguration`)
  - Lifespan ohne `RuntimeError` bei `pulse_instance_mode == "self-host"` und `pulse_instance_id == 0`
  - `POST /session` → 503 `{"detail": "nicht_verbunden"}`, wenn `not ist_verbunden(settings)` (ersetzt `instance_id_unconfigured`)

- [ ] **Step 1: Fehlschlagende Tests schreiben.**

`services/chat-gateway/tests/test_start_ohne_verbindung.py`:

```python
"""Ein Self-Host startet auch unverbunden (Spec 2026-10-09, E4).

Bis 2026-10 brach der Lifespan ohne ``PULSE_INSTANCE_ID`` mit ``RuntimeError``
ab — ein frisch installierter Server hätte dann nicht einmal den Nachweis
ausliefern können, den die Cloud zum Verbinden braucht.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient

import dcc_chat_gateway.app as chat_app
from dcc_chat_gateway.verbindung import NICHT_VERBUNDEN_HINWEIS, melde_verbindungsstand

_MODUL = "dcc_chat_gateway.verbindung"


@pytest.mark.asyncio
async def test_lifespan_startet_ohne_instanz_nummer(
    ws_app, _isolate_chat_settings, monkeypatch, caplog
):
    # app.py bindet ``get_settings`` beim Import an einen eigenen Namen — der
    # Austausch im conftest erreicht den Lifespan deshalb nicht; hier gezielt.
    _isolate_chat_settings.pulse_instance_id = 0
    monkeypatch.setattr(chat_app, "get_settings", lambda: _isolate_chat_settings)

    def _lauf() -> None:
        with TestClient(ws_app):
            pass  # starten und gleich wieder herunterfahren

    with caplog.at_level(logging.WARNING):
        await asyncio.wait_for(asyncio.to_thread(_lauf), timeout=20)
    assert any(r.getMessage() == NICHT_VERBUNDEN_HINWEIS for r in caplog.records)


def _einstellungen(*, modus: str = "self-host", instanz: int = 0, besitzer: int = 0):
    return SimpleNamespace(
        pulse_instance_mode=modus, pulse_instance_id=instanz, pulse_instance_owner_id=besitzer
    )


def test_unverbunden_nennt_pulse_connect(caplog):
    with caplog.at_level(logging.INFO, logger=_MODUL):
        melde_verbindungsstand(_einstellungen())
    eigene = [r for r in caplog.records if r.name == _MODUL]
    assert [r.getMessage() for r in eigene] == [NICHT_VERBUNDEN_HINWEIS]
    # WARNING: die Cloud-Vorgabe für PULSE_LOG_LEVEL ist warning, info wäre dort
    # unsichtbar (logging_setup.py).
    assert eigene[0].levelno == logging.WARNING


def test_verbunden_nennt_den_besitzer(caplog):
    with caplog.at_level(logging.INFO, logger="dcc_chat_gateway.owner_admin_log"):
        melde_verbindungsstand(_einstellungen(instanz=5, besitzer=4711))
    assert "4711" in caplog.text
    assert NICHT_VERBUNDEN_HINWEIS not in caplog.text


def test_in_der_cloud_kein_hinweis(caplog):
    with caplog.at_level(logging.INFO):
        melde_verbindungsstand(_einstellungen(modus="cloud"))
    assert NICHT_VERBUNDEN_HINWEIS not in caplog.text
```

In `services/chat-gateway/tests/test_session_ticket_route.py` ans Dateiende anhängen:

```python


@pytest.mark.asyncio
async def test_unverbundener_server_nimmt_niemanden_auf(
    client, ticket_bauer, _isolate_chat_settings
):
    """Spec 2026-10-09, E4: ohne Verbindung keine Sitzung — mit dem Grund, den
    die App dem Betreiber übersetzen kann, nicht mit ``ticket_wrong_audience``."""
    _isolate_chat_settings.pulse_instance_id = 0
    r = await client.post("/session", json={"ticket": ticket_bauer()})
    assert r.status_code == 503
    assert r.json() == {"detail": "nicht_verbunden"}
```

(`_isolate_chat_settings` setzt `pulse_instance_id` vor jedem Test wieder auf 100, `conftest.py:81`.)

- [ ] **Step 2: Tests laufen lassen, sie müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_start_ohne_verbindung.py`
Expected: FAIL — Sammelfehler `ImportError: cannot import name 'NICHT_VERBUNDEN_HINWEIS' from 'dcc_chat_gateway.verbindung'`, `Interrupted: 1 error during collection`.

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_session_ticket_route.py`
Expected: FAIL — nur `test_unverbundener_server_nimmt_niemanden_auf`, mit `AssertionError` (503, aber `{'detail': 'instance_id_unconfigured'}` statt `{'detail': 'nicht_verbunden'}`); alle übrigen grün.

- [ ] **Step 3: `verbindung.py` ergänzen.** Drei Ersetzungen.

(a) Ersetze

```python
import re
from pathlib import Path
```

durch

```python
import logging
import re
from pathlib import Path

from dcc_chat_gateway.owner_admin_log import log_owner_konfiguration

log = logging.getLogger(__name__)
```

(b) Ersetze

```python
_NACHWEIS_FORM = re.compile(r"[0-9a-f]{64}")
```

durch

```python
#: Englisch, weil die Zeile im Log fremder Betreiber steht (Regel aus
#: ``owner_admin_log.py``). Der Befehl ist derselbe, den Installer und
#: Compose-Datei nennen.
NICHT_VERBUNDEN_HINWEIS = (
    "This server is not connected to a Pulse account yet. "
    "Run: docker exec -it pulse pulse-connect"
)

_NACHWEIS_FORM = re.compile(r"[0-9a-f]{64}")
```

(c) Ans Dateiende anhängen:

```python


def melde_verbindungsstand(settings) -> None:
    """Einmal je Start sagen, wem der Server gehört — oder dass noch niemandem.

    Ein unverbundener Server bekäme von ``log_owner_konfiguration`` die Warnung,
    ``PULSE_INSTANCE_OWNER_ID`` fehle. Das stimmt, nennt aber die falsche
    Abhilfe: eine Zeile in der ``.env`` statt ``pulse-connect``.
    """
    if ist_verbunden(settings):
        log_owner_konfiguration(settings)
    else:
        log.warning(NICHT_VERBUNDEN_HINWEIS)
```

- [ ] **Step 4: `app.py`.** Fünf Ersetzungen (Zeilenangaben gegen den Stand vor diesem Task; die Datei liegt mit 535 Zeilen schon über der harten Grenze, dieser Task verkürzt sie um 5 Zeilen).

(a) Zeile 23 löschen:

```python
from dcc_chat_gateway.owner_admin_log import log_owner_konfiguration
```

(b) Zeilen 36–37

```python
from dcc_chat_gateway.suspend_poller import suspend_poller_loop
from dcc_chat_gateway.voice_pull_cleanup import voice_pull_reaper_loop
```

ersetzen durch

```python
from dcc_chat_gateway.suspend_poller import suspend_poller_loop
from dcc_chat_gateway.verbindung import melde_verbindungsstand
from dcc_chat_gateway.voice_pull_cleanup import voice_pull_reaper_loop
```

(c) Zeilen 172–184 (Kommentar „Fail fast: a self-host must have PULSE_INSTANCE_ID …“ bis einschließlich der schließenden Klammer von `raise RuntimeError(…)`) ersetzen durch:

```python
    # Ohne PULSE_INSTANCE_ID startet ein Self-Host seit 2026-10 trotzdem (Spec
    # 2026-10-09, E4): er liefert Nachweis und Server-Info aus und nimmt
    # niemanden auf, bis ``pulse-connect`` ihn verbindet (``POST /session`` →
    # 503 ``nicht_verbunden``). Der frühere Abbruch hier schützte die
    # pairwise-Rechnung, die mit dem Ticket-Weg entfallen ist.
```

(d) Zeile 285

```python
        # (beobachtet 2026-07-27, s. suspend_poller.py).
```

ersetzen durch

```python
        # (beobachtet 2026-07-27, s. suspend_poller.py). Ein unverbundener
        # Server (Instanz-Nummer 0) hat noch keinen Eintrag, den man sperren
        # könnte, und deshalb auch keinen Poller.
```

(e) Zeilen 337–339

```python
        # Wem gehoert diese Instanz? Einmal je Start, damit die Antwort auch
        # dann im Protokoll steht, wenn sich noch niemand angemeldet hat.
        log_owner_konfiguration(settings)
```

ersetzen durch

```python
        # Wem gehört diese Instanz — oder noch niemandem? Einmal je Start, damit
        # die Antwort auch dann im Protokoll steht, wenn sich noch niemand
        # angemeldet hat (verbindung.py).
        melde_verbindungsstand(settings)
```

- [ ] **Step 5: `routes/session_ticket.py`.** Nach Zeile 26 (`from dcc_chat_gateway.ticket_pruefung import TicketFehler, pruefe_ticket`) einfügen:

```python
from dcc_chat_gateway.verbindung import ist_verbunden
```

und Zeilen 91–97 ersetzen:

```python
    # Ohne Instanz-Kennung kann kein Ticket passen (``aud`` wäre "0"). Ohne
    # diesen Riegel meldete die Anmeldung ``ticket_wrong_audience``, und dessen
    # Text schickt den Betreiber in seine Serverliste — statt zur fehlenden
    # Zeile in seiner ``.env``. Genau die Sorte Fehlleitung, gegen die dieser
    # Umbau gebaut ist.
    if settings.pulse_instance_mode == "self-host" and not settings.pulse_instance_id:
        raise HTTPException(status_code=503, detail="instance_id_unconfigured")
```

durch

```python
    # Ein Server, der noch mit keinem Pulse-Konto verbunden ist, nimmt niemanden
    # auf (Spec 2026-10-09, E4). Ohne Instanz-Kennung könnte ohnehin kein Ticket
    # passen (``aud`` wäre "0"); ohne diesen Riegel meldete die Anmeldung
    # ``ticket_wrong_audience``, und dessen Text schickt in die Serverliste statt
    # zur Abhilfe: ``pulse-connect`` auf dem Server.
    if not ist_verbunden(settings):
        raise HTTPException(status_code=503, detail="nicht_verbunden")
```

- [ ] **Step 6: Tests laufen lassen** — erst gezielt, dann der ganze Dienst (der Lifespan betrifft jeden WS-Test).

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_start_ohne_verbindung.py services/chat-gateway/tests/test_session_ticket_route.py services/chat-gateway/tests/test_owner_admin_log.py services/chat-gateway/tests/test_lifespan_shutdown.py`
Expected: PASS.

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q -n 8 services/chat-gateway/tests`
Expected: PASS (ohne `redis-server` im PATH ohne `-n 8` fahren, dann ~7 min; nicht neben schwere Bauten legen).

- [ ] **Step 7: Vereinfachen.** `code-simplifier` über `verbindung.py`, `app.py`, `routes/session_ticket.py` und die zwei Testdateien; Step 6 (gezielt) erneut grün; `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 8: Commit.**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/verbindung.py \
  services/chat-gateway/src/dcc_chat_gateway/app.py \
  services/chat-gateway/src/dcc_chat_gateway/routes/session_ticket.py \
  services/chat-gateway/tests/test_start_ohne_verbindung.py \
  services/chat-gateway/tests/test_session_ticket_route.py
git commit -m "feat(chat-gateway): Self-Host startet ohne Verbindung und nimmt dann niemanden auf

Ohne PULSE_INSTANCE_ID bricht der Start nicht mehr ab; das Log nennt einmal
pulse-connect, und POST /session antwortet 503 nicht_verbunden statt
instance_id_unconfigured (Spec 2026-10-09, E4).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.3: Startskripte — nur die Adresse ist Pflicht, Zugangsdaten aus dem Datenvolumen

**Files:**
- Modify (vollständig ersetzen): `infra/self-host/s6/etc/s6-overlay/scripts/10-check-cloud-creds.sh` (59 Zeilen)
- Modify: `infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh:15` (Block danach) und `:145–161`
- Modify: `infra/self-host/s6/etc/s6-overlay/scripts/09-init-caddy.sh:19`, `:26`, `:66`
- Modify: `infra/self-host/s6/etc/s6-overlay/scripts/01-init-data-dirs.sh:22`, `:27`
- Create: `infra/self-host/tests/test_startpruefung.py`
- Modify (Behauptungen nachziehen): `infra/self-host/README.md:97–100`, `services/auth/tests/test_instance_selfservice.py:130–132`, `CLAUDE.md:194` (ein Halbsatz)

Der Dateiname `10-check-cloud-creds.sh` bleibt: `cont-init-main.sh:43` ruft ihn so, `/data/setup-status` meldet ihn so, und `web/static/install.sh:1080` übersetzt genau diesen Namen in seine Checkliste.

**Interfaces:**
- Consumes: `${DATA}/pulse/verbindung.env` (geschrieben von `pulse-connect`, Task 2.4) — Format: je Zeile `NAME=wert`, keine Kommentare, keine Anführungszeichen; Namen nur `PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID`, `PULSE_CLOUD_CLIENT_ID`, `PULSE_CLOUD_CLIENT_SECRET`, optional `PULSE_ADMIN_EMAIL`; Werte nur aus `[A-Za-z0-9._@+-]`.
- Produces:
  - `/etc/pulse/env.sh` rendert unverbunden `PULSE_INSTANCE_ID='0'`, `PULSE_INSTANCE_OWNER_ID='0'`, `PULSE_CLOUD_CLIENT_ID=''`, `PULSE_CLOUD_CLIENT_SECRET=''`, `PULSE_ADMIN_EMAIL=''` und neu `PULSE_VERBINDEN_DIR='${DATA}/pulse'`; Werte aus der Umgebung gewinnen vor der Datei.
  - `/data/pulse` (`pulse:pulse`, 0700) bei jedem Start.
  - `09-init-caddy.sh`: ohne Admin-Mail keine `email`-Zeile im Caddyfile; neue Variable `ENV_SH="/etc/pulse/env.sh"`.
  - `10-check-cloud-creds.sh`: Exit 1 nur ohne oder mit ungültiger `PULSE_HOSTNAME`.

- [ ] **Step 1: Fehlschlagende Tests schreiben** (`infra/self-host/tests/test_startpruefung.py`).

```python
"""Startskripte des Containers: nur die Adresse ist Pflicht (Spec 2026-10-09, E4).

Die Skripte laufen unter ``set -eu``; eine nicht gesetzte Variable bricht den
ganzen Start ab. Deshalb wird jeweils das echte Skript — oder der echte Block,
unverändert herausgeschnitten wie in ``test_caddy_tls_modi.py`` — mit einer
Umgebung gefahren, in der die alten Cloud-Werte FEHLEN, nicht nur leer sind.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys

import pytest

if sys.platform == "win32":
    pytest.skip("Shell-Skripte des Containers — Linux-CI-Sache", allow_module_level=True)

S6 = pathlib.Path(__file__).resolve().parents[1] / "s6"
SKRIPTE = S6 / "etc/s6-overlay/scripts"
PRUEFUNG = SKRIPTE / "10-check-cloud-creds.sh"
RENDER = SKRIPTE / "07-render-env.sh"
CADDY = SKRIPTE / "09-init-caddy.sh"
TEMPLATE = S6 / "etc/caddy/Caddyfile.template"
_ALT = (
    "PULSE_HOSTNAME",
    "PULSE_INSTANCE_ID",
    "PULSE_INSTANCE_OWNER_ID",
    "PULSE_CLOUD_CLIENT_ID",
    "PULSE_CLOUD_CLIENT_SECRET",
    "PULSE_ADMIN_EMAIL",
)
_AUSGABE = (
    'printf "%s|%s|%s|%s|%s\\n" "${PULSE_INSTANCE_ID:-}" "${PULSE_INSTANCE_OWNER_ID:-}" '
    '"${PULSE_CLOUD_CLIENT_ID:-}" "${PULSE_CLOUD_CLIENT_SECRET:-}" "${PULSE_ADMIN_EMAIL:-}"'
)
ZUGANG = (
    "PULSE_INSTANCE_ID=73315227868860500\n"
    "PULSE_INSTANCE_OWNER_ID=73315227868860416\n"
    "PULSE_CLOUD_CLIENT_ID=Zx9_client-id\n"
    "PULSE_CLOUD_CLIENT_SECRET=geheim_secret-123\n"
)


def _umgebung(**gesetzt: str) -> dict[str, str]:
    # Auch PULSE_INSTANCE_ID=0 aus dem Gate (scripts/gate.sh) muss hier weg.
    basis = {k: v for k, v in os.environ.items() if k not in _ALT}
    return {**basis, **gesetzt}


def _block(datei: pathlib.Path, anfang: str, ende: str) -> str:
    """Von der Zeile, die mit ``anfang`` beginnt, bis zur ersten danach, die mit
    ``ende`` beginnt — unverändert aus dem echten Skript."""
    zeilen = datei.read_text(encoding="utf-8").split("\n")
    start = next((i for i, z in enumerate(zeilen) if z.startswith(anfang)), None)
    assert start is not None, f"{anfang!r} fehlt in {datei.name} — Skript umgebaut?"
    schluss = next((i for i, z in enumerate(zeilen) if i > start and z.startswith(ende)), None)
    assert schluss is not None, f"kein {ende!r} nach {anfang!r} in {datei.name}"
    return "\n".join(zeilen[start : schluss + 1])


def _sh(skript: str, **umgebung: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["sh", "-c", skript], env=_umgebung(**umgebung), capture_output=True, text=True
    )


# ── 10-check-cloud-creds.sh ───────────────────────────────────────────────


def test_nur_die_adresse_genuegt():
    r = _sh(f'sh "{PRUEFUNG}"', PULSE_HOSTNAME="chat.example.org")
    assert r.returncode == 0, r.stderr


def test_ohne_adresse_bricht_der_start_ab():
    r = _sh(f'sh "{PRUEFUNG}"')
    assert r.returncode == 1
    assert "PULSE_HOSTNAME" in r.stderr


def test_ungueltige_adresse_bricht_ab():
    r = _sh(f'sh "{PRUEFUNG}"', PULSE_HOSTNAME="kein punkt")
    assert r.returncode == 1


# ── 07-render-env.sh: Zugangsdaten aus dem Datenvolumen ───────────────────


def _verbindung_lesen(tmp_path, inhalt: str | None, **umgebung: str):
    daten = tmp_path / "data"
    (daten / "pulse").mkdir(parents=True)
    if inhalt is not None:
        (daten / "pulse" / "verbindung.env").write_text(inhalt, encoding="utf-8")
    block = _block(RENDER, "# Verbindung mit einem Pulse-Konto", "fi")
    return _sh(f'set -eu\nDATA="{daten}"\n{block}\n{_AUSGABE}\n', **umgebung)


def test_werte_aus_dem_volumen_fuellen_die_luecken(tmp_path):
    r = _verbindung_lesen(tmp_path, ZUGANG + "PULSE_ADMIN_EMAIL=ops@example.org\n")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == (
        "73315227868860500|73315227868860416|Zx9_client-id|geheim_secret-123|ops@example.org"
    )


def test_umgebung_gewinnt(tmp_path):
    """Bestandsserver und Server-App setzen die Werte per Umgebung — sie
    dürfen von einer Datei im Volumen nichts bemerken."""
    r = _verbindung_lesen(
        tmp_path,
        ZUGANG,
        PULSE_INSTANCE_ID="4711",
        PULSE_INSTANCE_OWNER_ID="42",
        PULSE_CLOUD_CLIENT_ID="alt",
        PULSE_CLOUD_CLIENT_SECRET="alt-geheim",
    )
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "4711|42|alt|alt-geheim|"


def test_ohne_datei_bleibt_alles_leer(tmp_path):
    r = _verbindung_lesen(tmp_path, None)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "||||"


def test_nichts_aus_der_datei_wird_ausgefuehrt(tmp_path):
    marke = tmp_path / "ausgefuehrt"
    inhalt = f"PULSE_INSTANCE_ID=$(touch {marke})\nPATH=/nirgends\nPULSE_CLOUD_CLIENT_ID=abc\n"
    r = _verbindung_lesen(tmp_path, inhalt)
    assert r.returncode == 0, r.stderr
    assert not marke.exists()
    assert r.stdout.strip() == "||abc||"
    assert "ignored" in r.stderr


# ── 07-render-env.sh: env.sh unter set -u ─────────────────────────────────


def _env_sh(**umgebung: str) -> subprocess.CompletedProcess:
    block = _block(RENDER, "# Self-host identity.", "export PULSE_VERBINDEN_DIR")
    return _sh(
        f"set -eu\nDATA=/data\ncat <<EOF\n{block}\nEOF\n",
        PULSE_HOSTNAME="chat.example.org",
        PULSE_CLOUD_ORIGIN="https://howispulse.com",
        **umgebung,
    )


def test_env_sh_ohne_verbindung():
    r = _env_sh()
    assert r.returncode == 0, r.stderr
    for zeile in (
        "export PULSE_INSTANCE_ID='0'",
        "export PULSE_INSTANCE_OWNER_ID='0'",
        "export PULSE_CLOUD_CLIENT_ID=''",
        "export PULSE_CLOUD_CLIENT_SECRET=''",
        "export PULSE_ADMIN_EMAIL=''",
        "export PULSE_VERBINDEN_DIR='/data/pulse'",
    ):
        assert zeile in r.stdout.splitlines()


def test_env_sh_bestand_unveraendert():
    r = _env_sh(
        PULSE_INSTANCE_ID="4711",
        PULSE_INSTANCE_OWNER_ID="42",
        PULSE_CLOUD_CLIENT_ID="cid",
        PULSE_CLOUD_CLIENT_SECRET="geheim",
        PULSE_ADMIN_EMAIL="admin@firma.de",
    )
    assert r.returncode == 0, r.stderr
    for zeile in (
        "export PULSE_INSTANCE_ID='4711'",
        "export PULSE_INSTANCE_OWNER_ID='42'",
        "export PULSE_CLOUD_CLIENT_ID='cid'",
        "export PULSE_CLOUD_CLIENT_SECRET='geheim'",
        "export PULSE_ADMIN_EMAIL='admin@firma.de'",
    ):
        assert zeile in r.stdout.splitlines()


# ── 09-init-caddy.sh: Admin-Mail optional ─────────────────────────────────


def _caddy(tmp_path, env_sh: str | None) -> tuple[subprocess.CompletedProcess, str]:
    ziel = tmp_path / "Caddyfile"
    shutil.copy(TEMPLATE, ziel)
    datei = tmp_path / "env.sh"
    if env_sh is not None:
        datei.write_text(env_sh, encoding="utf-8")
    block = _block(CADDY, "# Ohne Admin-Mail", "fi")
    skript = f'set -euo pipefail\nTARGET="{ziel}"\nENV_SH="{datei}"\n{block}\n'
    r = subprocess.run(["bash", "-c", skript], env=_umgebung(), capture_output=True, text=True)
    return r, ziel.read_text(encoding="utf-8")


def test_caddy_ohne_admin_mail_hat_keine_leere_email_zeile(tmp_path):
    r, text = _caddy(tmp_path, "export PULSE_ADMIN_EMAIL=''\n")
    assert r.returncode == 0, r.stderr
    assert "email {$PULSE_ADMIN_EMAIL}" not in text
    assert "admin off" in text


def test_caddy_nimmt_die_mail_aus_env_sh(tmp_path):
    """Die Mail kann aus verbindung.env stammen — dann steht sie nur in env.sh."""
    r, text = _caddy(tmp_path, "export PULSE_ADMIN_EMAIL='ops@example.org'\n")
    assert r.returncode == 0, r.stderr
    assert "    email {$PULSE_ADMIN_EMAIL}" in text.splitlines()


def test_caddy_ohne_env_sh_stirbt_nicht(tmp_path):
    r, text = _caddy(tmp_path, None)
    assert r.returncode == 0, r.stderr
    assert "email {$PULSE_ADMIN_EMAIL}" not in text
```

- [ ] **Step 2: Tests laufen lassen, sie müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q infra/self-host/tests/test_startpruefung.py`
Expected: FAIL — 10 von 12: `test_nur_die_adresse_genuegt` (Exit 1, fehlende Cloud-Werte), die vier `07`-Volumen-Tests (`'# Verbindung mit einem Pulse-Konto' fehlt in 07-render-env.sh`), beide `env_sh`-Tests (`kein 'export PULSE_VERBINDEN_DIR' nach '# Self-host identity.'`), die drei Caddy-Tests (`'# Ohne Admin-Mail' fehlt in 09-init-caddy.sh`). Grün schon vorher: `test_ohne_adresse_…`, `test_ungueltige_adresse_…` (Regressionswächter). In der Wegwerf-Kopie nachgefahren: genau dieses Bild.

- [ ] **Step 3: `10-check-cloud-creds.sh` vollständig ersetzen** (Modus 755 bleibt, Datei wird nur überschrieben):

```sh
#!/bin/sh
# Startprüfung. Pflicht ist seit 2026-10 nur noch die Adresse (Spec
# docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md, E4).
# Instanz-Nummer, Besitzer und Zugangsdaten kommen aus der Umgebung
# (Bestandsserver mit Freigabe, Server-App) oder von pulse-connect aus
# /data/pulse/verbindung.env (07-render-env.sh). Fehlen sie, startet der
# Server trotzdem und nimmt niemanden auf, bis er verbunden ist.
#
# Der Dateiname ist historisch und bleibt: cont-init-main.sh ruft den Schritt
# unter diesem Namen, /data/setup-status (GET /health/setup) meldet ihn so, und
# der Installer übersetzt genau diesen Namen in seine Checkliste.
set -eu

if [ -z "${PULSE_HOSTNAME:-}" ]; then
    cat >&2 <<'EOF'
[10-check-cloud-creds] FATAL: PULSE_HOSTNAME is not set.

Set it to the public address of this server, for example
  -e PULSE_HOSTNAME=chat.example.org     (docker run)
  PULSE_HOSTNAME=chat.example.org        (.env next to docker-compose.yml)

The address needs a DNS record pointing at this machine.
Easiest way to install: curl -fsSL https://howispulse.com/install | bash
EOF
    exit 1
fi

# Sieht die Adresse wie ein echter DNS-Name aus? Lieber hier laut scheitern als
# später still beim Zertifikat.
if ! echo "${PULSE_HOSTNAME}" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$'; then
    echo "[10-check-cloud-creds] FATAL: PULSE_HOSTNAME='${PULSE_HOSTNAME}' is not a valid DNS name" >&2
    exit 1
fi

echo "[10-check-cloud-creds] address ok (hostname=${PULSE_HOSTNAME})"
```

(Keinen Bildnamen in der Meldung: er wechselt in Etappe 0/4 und wäre die nächste Behauptung, die stehen bleibt.)

- [ ] **Step 4: `07-render-env.sh`, Zugangsdaten aus dem Volumen.** Nach Zeile 15 (`: "${PULSE_CLOUD_ORIGIN:=https://howispulse.com}"`) einfügen:

```sh

# Verbindung mit einem Pulse-Konto (pulse-connect, Spec 2026-10-09 E4): die
# abgeholten Zugangsdaten liegen im Datenvolumen. Übernommen wird nur, was die
# Umgebung LEER lässt — Werte aus `docker run -e` oder der .env gewinnen, damit
# Bestandsserver und Server-App unverändert laufen.
#
# Bewusst kein `.`/source: die Werte stammen aus einer Antwort der Cloud, und
# eine Zeile wie `X=$(...)` würde beim Sourcen ausgeführt. Erlaubt sind nur die
# fünf Namen und die Zeichen, die verbinden_cli.py (_WERT) schreibt — beide
# Stellen synchron halten.
VERBINDUNG="${DATA}/pulse/verbindung.env"
if [ -r "$VERBINDUNG" ]; then
    while IFS='=' read -r schluessel wert || [ -n "$schluessel" ]; do
        case "$schluessel" in
            PULSE_INSTANCE_ID|PULSE_INSTANCE_OWNER_ID|PULSE_CLOUD_CLIENT_ID|PULSE_CLOUD_CLIENT_SECRET|PULSE_ADMIN_EMAIL) ;;
            *) continue ;;
        esac
        case "$wert" in
            ''|*[!A-Za-z0-9._@+-]*)
                echo "[07-render-env] ${schluessel} in ${VERBINDUNG} ignored (unexpected characters)" >&2
                continue ;;
        esac
        eval "aktuell=\${${schluessel}:-}"
        if [ -z "$aktuell" ]; then
            export "${schluessel}=${wert}"
        fi
    done < "$VERBINDUNG"
fi
```

(`eval` ist hier ungefährlich: `schluessel` ist durch das erste `case` auf fünf feste Namen beschränkt.)

- [ ] **Step 5: `07-render-env.sh`, `env.sh` unter `set -u`.** Zeilen 145–161 (von `# Self-host identity.` bis einschließlich `export PULSE_CLOUD_CLIENT_SECRET='${PULSE_CLOUD_CLIENT_SECRET}'`) ersetzen durch:

```sh
# Self-host identity.
export PULSE_HOSTNAME='${PULSE_HOSTNAME}'
export PULSE_INSTANCE_MODE=self-host
# Instanz-Nummer, Besitzer und Zugangsdaten kommen aus der Umgebung
# (Bestandsserver, Server-App) oder aus ${DATA}/pulse/verbindung.env
# (pulse-connect, Block oben). Ein frisch installierter Server hat noch keine:
# er startet trotzdem und nimmt niemanden auf (chat-gateway, POST /session
# antwortet 503 nicht_verbunden). Die beiden Zahlen werden als 0 statt leer
# gerendert, weil pydantic eine leere Zeichenkette nicht als int liest und der
# chat-gateway sonst schon beim Laden seiner Einstellungen stürbe. Die Dienste
# lesen NUR diese Datei; ein Wert, der nur in der Container-Umgebung steht,
# erreicht sie nicht.
export PULSE_INSTANCE_ID='${PULSE_INSTANCE_ID:-0}'
export PULSE_INSTANCE_OWNER_ID='${PULSE_INSTANCE_OWNER_ID:-0}'
export PULSE_CLOUD_ORIGIN='${PULSE_CLOUD_ORIGIN}'
export PULSE_ADMIN_EMAIL='${PULSE_ADMIN_EMAIL:-}'
# Zugangsdaten bei der Cloud: gelesen vom direct-adapter (Heartbeat; schläft
# ohne sie, s6-rc.d/direct-adapter/run) und von instance_name.py (Server-Name
# an die Cloud). NIE loggen.
export PULSE_CLOUD_CLIENT_ID='${PULSE_CLOUD_CLIENT_ID:-}'
export PULSE_CLOUD_CLIENT_SECRET='${PULSE_CLOUD_CLIENT_SECRET:-}'
# Wo pulse-connect Nachweis und Zugangsdaten ablegt (chat-gateway-Einstellung
# pulse_verbinden_dir, Spec 2026-10-09 E4/E6).
export PULSE_VERBINDEN_DIR='${DATA}/pulse'
```

Achtung, der Block liegt im ungequoteten Heredoc `cat > /etc/pulse/env.sh <<EOF`: in seinen Kommentaren darf weder ein Backtick noch `$(` stehen (beides würde beim Rendern ausgeführt). `${DATA}` in einem Kommentar wird nur eingesetzt — harmlos. Die Zeile „reserved for the Phase 4–6 handshake … no service consumes them yet“ entfällt; sie war falsch (direct-adapter und `instance_name.py` lesen die Werte).

- [ ] **Step 6: `09-init-caddy.sh`.** Nach Zeile 19 (`TARGET="/etc/caddy/Caddyfile"`) einfügen:

```bash
ENV_SH="/etc/pulse/env.sh"
```

Nach Zeile 26 (`cp "$TEMPLATE" "$TARGET"`) einfügen:

```bash

# Ohne Admin-Mail: die globale `email`-Zeile entfernen. Caddy startet mit einer
# `email`-Direktive ohne Wert nicht, und Let's Encrypt braucht keine Adresse
# (ohne sie entfallen nur die Ablauf-Warnungen per Mail). Gefragt wird
# /etc/pulse/env.sh, nicht die eigene Umgebung: die Mail kann aus
# /data/pulse/verbindung.env stammen (07-render-env.sh läuft vorher), und Caddy
# liest dieselbe Datei (s6-rc.d/caddy/run). Spec 2026-10-09, E4.
ADMIN_EMAIL="$( [ -r "$ENV_SH" ] && . "$ENV_SH"; printf '%s' "${PULSE_ADMIN_EMAIL:-}" )"
if [[ -z "$ADMIN_EMAIL" ]]; then
    sed -i '/^    email {\$PULSE_ADMIN_EMAIL}$/d' "$TARGET"
    if grep -qF 'email {$PULSE_ADMIN_EMAIL}' "$TARGET"; then
        echo "[07-init-caddy] FEHLER: email-Zeile konnte nicht entfernt werden." >&2
        exit 1
    fi
    echo "[07-init-caddy] Keine PULSE_ADMIN_EMAIL — Zertifikat ohne Kontaktadresse."
fi
```

Zeile 66

```bash
    echo "[07-init-caddy] Let's Encrypt Auto-TLS aktiv (ACME via PULSE_ADMIN_EMAIL)."
```

ersetzen durch

```bash
    echo "[07-init-caddy] Let's Encrypt Auto-TLS aktiv."
```

(Das Präfix `[07-init-caddy]` ist das, das die Datei überall schon schreibt; die Vorlage selbst bleibt bei `email {$PULSE_ADMIN_EMAIL}`, weil die Windows-Server-App sie unverändert nutzt und die Mail immer setzt, `desktop/electron/localBackend/nativeBackend/envContract.ts:96`.) Reihenfolge geprüft: `cont-init-main.sh` fährt `07-render-env` (Zeile 61) vor `09-init-caddy` (Zeile 68).

- [ ] **Step 7: `01-init-data-dirs.sh`.** Zeile 22

```sh
    "${DATA}/uploads/guild-icons"
```

ersetzen durch

```sh
    "${DATA}/uploads/guild-icons" \
    "${DATA}/pulse"
```

und nach Zeile 27 (`chmod 0750 "${DATA}/uploads"`) einfügen:

```sh
# pulse-connect legt hier Nachweis und Zugangsdaten ab (verbinden_cli.py). Es
# läuft als root; lesen muss den Nachweis der chat-gateway als pulse — deshalb
# gehört das Verzeichnis pulse, und das chown -R oben zieht die Dateien beim
# nächsten Start nach.
chmod 0700 "${DATA}/pulse"
```

- [ ] **Step 8: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q infra/self-host/tests`
Expected: PASS (alle Dateien unter `infra/self-host/tests`, einschließlich `test_caddy_tls_modi.py` als Gegenprobe für die sed-Zweige). Zusätzlich die Syntax: `sh -n infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh && sh -n infra/self-host/s6/etc/s6-overlay/scripts/10-check-cloud-creds.sh && sh -n infra/self-host/s6/etc/s6-overlay/scripts/01-init-data-dirs.sh && bash -n infra/self-host/s6/etc/s6-overlay/scripts/09-init-caddy.sh` → keine Ausgabe, Exit 0.

- [ ] **Step 9: Behauptungen nachziehen** (CLAUDE.md: eine Behauptung nie an nur einer Stelle korrigieren). Erst greppen:

```bash
git grep -n "six \`-e\` vars are mandatory\|10-check-cloud-creds.sh verlangt\|schon beim Start abfängt"
```

Erwartet: genau die drei Stellen unten.

(a) `infra/self-host/README.md:97–100`

```
The six `-e` vars are mandatory; cont-init aborts with a clear error otherwise.
`PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID`, `PULSE_CLOUD_CLIENT_ID` and the
secret come from the Cloud approval — the ready-made `.env` under "Meine
Instanzen" on howispulse.com carries all but the secret.
```

ersetzen durch

```
Only `PULSE_HOSTNAME` is mandatory; cont-init aborts with a clear error without
it. A server started without `PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID`,
`PULSE_CLOUD_CLIENT_ID` and `PULSE_CLOUD_CLIENT_SECRET` runs but admits nobody
until it is connected: `docker exec -it pulse pulse-connect` (the values then
live in `/data/pulse/verbindung.env`; values passed with `-e` win). Servers set
up with a Cloud approval keep passing them with `-e` as before.
```

(Das `docker run`-Beispiel darüber und `.env.example` schreibt Etappe 4 neu.)

(b) `services/auth/tests/test_instance_selfservice.py:130–132`

```
# Bootstrap-Token → Einlösung → die Werte, ohne die der All-in-One-Container
# hart failt (10-check-cloud-creds.sh verlangt HOSTNAME, INSTANCE_ID,
# CLIENT_ID/SECRET, ADMIN_EMAIL, OWNER_ID). Genau diese Kette fährt die
```

(Zeilen 130–132) ersetzen durch

```
# Bootstrap-Token → Einlösung → die Werte, ohne die der All-in-One-Container
# niemanden aufnimmt (bis 2026-10 verlangte 10-check-cloud-creds.sh sie alle
# schon beim Start; seither startet er ohne sie unverbunden). Genau diese Kette fährt die
```

(c) `CLAUDE.md:194` — den Halbsatz

```
also ausgerechnet der Fall, den `10-check-cloud-creds.sh` schon beim Start abfängt.
```

ersetzen durch

```
also ausgerechnet der Fall, den `10-check-cloud-creds.sh` damals schon beim Start abfing (seit 2026-10 verlangt es nur noch `PULSE_HOSTNAME`; ein unverbundener Server meldet statt dieser Warnung den `pulse-connect`-Hinweis, `verbindung.py`).
```

- [ ] **Step 10: Vereinfachen.** `code-simplifier` über die vier Skripte und `test_startpruefung.py`; Step 8 erneut grün; `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 11: Commit.**

```bash
git add infra/self-host/s6/etc/s6-overlay/scripts/10-check-cloud-creds.sh \
  infra/self-host/s6/etc/s6-overlay/scripts/07-render-env.sh \
  infra/self-host/s6/etc/s6-overlay/scripts/09-init-caddy.sh \
  infra/self-host/s6/etc/s6-overlay/scripts/01-init-data-dirs.sh \
  infra/self-host/tests/test_startpruefung.py \
  infra/self-host/README.md services/auth/tests/test_instance_selfservice.py CLAUDE.md
git commit -m "feat(self-host): Container startet mit der Adresse allein

Pflicht ist nur noch PULSE_HOSTNAME. 07-render-env.sh übernimmt Zugangsdaten
aus /data/pulse/verbindung.env, wenn die Umgebung sie leer lässt (Umgebung
gewinnt), und rendert fehlende Werte ohne Abbruch; ohne Admin-Mail entfällt
die email-Zeile im Caddyfile (Spec 2026-10-09, E4).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.4: `pulse-connect`

**Files:**
- Create: `services/chat-gateway/src/dcc_chat_gateway/verbinden_texte.py` (77 Zeilen)
- Create: `services/chat-gateway/src/dcc_chat_gateway/verbinden_cli.py` (341 Zeilen; mit den Texten wären es über 380 — deshalb die eigene Textdatei, Muster `dcc_auth/diagnose_texte.py`)
- Create: `infra/self-host/s6/usr/local/bin/pulse-connect` (Modus 755, aus Git)
- Create: `services/chat-gateway/tests/test_verbinden_cli.py`
- Create: `infra/self-host/tests/test_pulse_connect_huelle.py`

**Interfaces:**
- Consumes:
  - Cloud (Etappe 1, Vertrag mit Nachtrag 2): `POST {PULSE_CLOUD_ORIGIN}/api/auth/selfhost/verbinden/start` mit `{"hostname", "kennung"}` (die Kennung selbst; die Cloud bildet `sha256` und vergleicht mit `/.well-known/pulse-verbinden`) → 201 `{"code", "link", "gueltig_s", "abstand_s"}` | 400 `adresse_ungueltig`/`adresse_gesperrt` | 409 `{"detail": {"code": "nachweis_fehlt", "befund": …}}` | 429; `POST …/selfhost/verbinden/abholen` mit `{"kennung"}` → 202 | 200 `VerbindenZugangOut` | 403 | 410 | 429.
  - `dcc_auth.verbinden.nachweis_aus_kennung(kennung: str) -> str` (nur im Prüfstein-Test).
  - `verbindung.NACHWEIS_DATEI`, `verbindung.VERBINDUNG_DATEI`; `Settings.pulse_verbinden_dir`, `.pulse_cloud_origin`, `.pulse_instance_id`, `.pulse_instance_mode`; Umgebung `PULSE_HOSTNAME`.
- Produces:
  - `verbinden_cli.main(argv: list[str] | None = None) -> int` — Optionen `--no-restart`, `--yes`; Exit 0 verbunden, 1 Fehler, 2 abgelehnt/abgelaufen, 3 Nachweis von außen nicht erreichbar.
  - `verbinden_cli.verbinden(umgebung: Umgebung, client: httpx.Client, *, neustart: Callable[[], None] | None, rueckfrage: Callable[[str], bool], schlafen: Callable[[float], None] = time.sleep, uhr: Callable[[], float] = time.monotonic, ausgabe: Callable[[str], None] = _drucke) -> int`
  - `verbinden_cli.Umgebung(hostname: str, cloud_origin: str, verzeichnis: Path, instanz_id: int, modus: str)` (frozen dataclass)
  - `verbinden_cli.nachweis_aus_kennung(kennung: str) -> str` = `hashlib.sha256(kennung.encode("utf-8")).hexdigest()`; Kennung = `secrets.token_urlsafe(32)`.
  - `verbinden_cli.lies_verbindung(verzeichnis: Path) -> dict[str, str]`, `container_neustarten() -> None`, `frage_im_terminal(frage: str) -> bool`, `HALT = "/run/s6/basedir/bin/halt"`, `HOECHSTENS_S = 900`, `ANFRAGE_FRIST_S = 15.0`.
  - Dateien: `verbinden-nachweis` (0644, eine Zeile 64 Hex = `sha256(kennung)`, VOR `start` geschrieben, nach jedem Lauf gelöscht — auch bei Fehler und Strg+C); `verbindung.env` (0600, atomar, Format wie in Task 2.3).
  - Hülle `/usr/local/bin/pulse-connect`: sourct `/etc/pulse/env.sh`, ruft `python3 -m dcc_chat_gateway.verbinden_cli "$@"` als root.

- [ ] **Step 1: Fehlschlagende Tests schreiben.**

`services/chat-gateway/tests/test_verbinden_cli.py`:

```python
"""``pulse-connect`` (``verbinden_cli.py``) gegen eine nachgebaute Cloud.

Die Cloud ist ein ``httpx.MockTransport`` mit genau den Antworten aus dem
Vertrag (auth-svc ``routes_verbinden.py``). Uhr und Schlaf sind ersetzt, damit
15 Minuten Warten keine 15 Minuten dauern; der Neustart ist eine Liste, in die
der Test schaut — ein echtes ``halt`` beendete den Container, nicht den Test.
"""

from __future__ import annotations

import json
import stat
from pathlib import Path

import httpx
import pytest

from dcc_chat_gateway import verbinden_cli
from dcc_chat_gateway.verbinden_cli import Umgebung, nachweis_aus_kennung, verbinden
from dcc_chat_gateway.verbindung import NACHWEIS_DATEI, VERBINDUNG_DATEI

CLOUD = "https://cloud.example"
HOST = "chat.example.org"
START = "/api/auth/selfhost/verbinden/start"
ABHOLEN = "/api/auth/selfhost/verbinden/abholen"
VORGANG = {
    "code": "K7QM-2XDP",
    "link": f"{CLOUD}/verbinden#K7QM-2XDP",
    "gueltig_s": 900,
    "abstand_s": 5,
}
ZUGANG = {
    "instance_id": "73315227868860500",
    "owner_user_id": "73315227868860416",
    "owner_name": "michael",
    "hostname": HOST,
    "client_id": "Zx9_client-id",
    "client_secret": "geheim_secret-123",
    "cloud_origin": CLOUD,
    "admin_email": None,
}
WARTET = (202, {"status": "wartet"})


class Cloud:
    """Die beiden anonymen Routen der Cloud, mit vorgegebenen Antworten."""

    def __init__(self, verzeichnis: Path, *, start=(201, VORGANG), abholen=()):
        self.verzeichnis = verzeichnis
        self.start = start
        self.abholen = list(abholen)
        self.pfade: list[str] = []
        self.kennung_beim_start: str | None = None
        self.nachweis_beim_start: str | None = None
        self.kennungen_beim_abholen: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.pfade.append(request.url.path)
        koerper = json.loads(request.content)
        if request.url.path == START:
            # Vertrag, Nachtrag 2: die Kennung selbst, nie der (öffentlich
            # lesbare) Nachweis — die Cloud bildet den Hash selbst.
            assert set(koerper) == {"hostname", "kennung"}
            assert koerper["hostname"] == HOST
            self.kennung_beim_start = koerper["kennung"]
            # Der Nachweis muss VOR der Anfrage bereitliegen: die Cloud ruft
            # ihn sofort von aussen ab und vergleicht ihn mit sha256(kennung).
            self.nachweis_beim_start = (self.verzeichnis / NACHWEIS_DATEI).read_text().strip()
            assert self.nachweis_beim_start == nachweis_aus_kennung(koerper["kennung"])
            status, daten = self.start
            return httpx.Response(status, json=daten)
        if request.url.path == ABHOLEN:
            assert set(koerper) == {"kennung"}
            self.kennungen_beim_abholen.append(koerper["kennung"])
            status, daten = self.abholen.pop(0) if self.abholen else WARTET
            return httpx.Response(status, json=daten)
        return httpx.Response(404, json={"detail": "Not Found"})


class Uhr:
    def __init__(self) -> None:
        self.jetzt = 0.0
        self.schlaefe: list[float] = []

    def __call__(self) -> float:
        return self.jetzt

    def schlafen(self, sekunden: float) -> None:
        self.schlaefe.append(sekunden)
        self.jetzt += sekunden


def _nein(_frage: str) -> bool:
    return False


def _lauf(tmp_path, cloud, *, instanz_id=0, rueckfrage=_nein, neustart=None):
    zeilen: list[str] = []
    uhr = Uhr()
    umgebung = Umgebung(
        hostname=HOST,
        cloud_origin=CLOUD,
        verzeichnis=tmp_path,
        instanz_id=instanz_id,
        modus="self-host",
    )
    with httpx.Client(transport=httpx.MockTransport(cloud)) as client:
        code = verbinden(
            umgebung,
            client,
            neustart=neustart,
            rueckfrage=rueckfrage,
            schlafen=uhr.schlafen,
            uhr=uhr,
            ausgabe=zeilen.append,
        )
    return code, "\n".join(zeilen), uhr


def test_verbindet_schreibt_die_zugangsdaten_und_startet_neu(tmp_path):
    cloud = Cloud(tmp_path, abholen=[WARTET, WARTET, (200, ZUGANG)])
    neustarts: list[str] = []
    code, text, uhr = _lauf(tmp_path, cloud, neustart=lambda: neustarts.append("halt"))

    assert code == 0
    assert cloud.pfade == [START, ABHOLEN, ABHOLEN, ABHOLEN]
    assert uhr.schlaefe == [5, 5, 5]
    kennung = cloud.kennung_beim_start
    # Abgeholt wird mit derselben Kennung, die beim Anfragen mitging; abgelegt
    # war nur ihr Hash, nicht die Kennung selbst.
    assert cloud.kennungen_beim_abholen == [kennung] * 3
    assert cloud.nachweis_beim_start != kennung
    datei = tmp_path / VERBINDUNG_DATEI
    assert datei.read_text().splitlines() == [
        "PULSE_INSTANCE_ID=73315227868860500",
        "PULSE_INSTANCE_OWNER_ID=73315227868860416",
        "PULSE_CLOUD_CLIENT_ID=Zx9_client-id",
        "PULSE_CLOUD_CLIENT_SECRET=geheim_secret-123",
    ]
    assert stat.S_IMODE(datei.stat().st_mode) == 0o600
    assert not (tmp_path / NACHWEIS_DATEI).exists()
    assert neustarts == ["halt"]
    assert VORGANG["link"] in text
    assert "K7QM-2XDP" in text
    assert "Connected to michael. Your server now appears in Pulse." in text
    # Kennung und Secret erscheinen in keiner Ausgabe.
    assert kennung not in text
    assert ZUGANG["client_secret"] not in text


def test_ohne_neustart_bleibt_der_container_stehen(tmp_path):
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, text, _ = _lauf(tmp_path, cloud, neustart=None)
    assert code == 0
    assert "Restarting" not in text
    assert (tmp_path / VERBINDUNG_DATEI).exists()


def test_admin_mail_nur_wenn_die_cloud_eine_liefert(tmp_path):
    cloud = Cloud(tmp_path, abholen=[(200, {**ZUGANG, "admin_email": "ops@example.org"})])
    assert _lauf(tmp_path, cloud)[0] == 0
    zeilen = (tmp_path / VERBINDUNG_DATEI).read_text().splitlines()
    assert zeilen[-1] == "PULSE_ADMIN_EMAIL=ops@example.org"


def test_nachweis_von_aussen_nicht_erreichbar(tmp_path):
    detail = {"code": "nachweis_fehlt", "befund": "nicht_erreichbar"}
    cloud = Cloud(tmp_path, start=(409, {"detail": detail}))
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 3
    assert cloud.pfade == [START]
    assert "port 443" in text
    assert "No code was used up" in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()
    assert not (tmp_path / VERBINDUNG_DATEI).exists()


@pytest.mark.parametrize(
    "antwort", [(403, {"detail": "abgelehnt"}), (410, {"detail": "abgelaufen"})]
)
def test_abgelehnt_oder_abgelaufen(tmp_path, antwort):
    cloud = Cloud(tmp_path, abholen=[WARTET, antwort])
    code, _text, _ = _lauf(tmp_path, cloud)
    assert code == 2
    assert not (tmp_path / VERBINDUNG_DATEI).exists()
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_frist_laeuft_ab(tmp_path):
    cloud = Cloud(tmp_path, start=(201, {**VORGANG, "gueltig_s": 15}))
    code, text, uhr = _lauf(tmp_path, cloud)
    assert code == 2
    assert uhr.jetzt >= 15
    assert "expired" in text


def test_schon_verbunden_fragt_nach(tmp_path):
    (tmp_path / VERBINDUNG_DATEI).write_text("PULSE_INSTANCE_ID=4711\n")
    fragen: list[str] = []

    def merke(frage: str) -> bool:
        fragen.append(frage)
        return False

    cloud = Cloud(tmp_path)
    code, _text, _ = _lauf(tmp_path, cloud, instanz_id=4711, rueckfrage=merke)
    assert code == 1
    assert cloud.pfade == []
    assert "already connected" in fragen[0]


def test_mit_ja_verbindet_er_neu(tmp_path):
    (tmp_path / VERBINDUNG_DATEI).write_text("PULSE_INSTANCE_ID=4711\n")
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    code, _text, _ = _lauf(tmp_path, cloud, instanz_id=4711, rueckfrage=lambda _f: True)
    assert code == 0
    assert "PULSE_INSTANCE_ID=73315227868860500" in (tmp_path / VERBINDUNG_DATEI).read_text()


def test_verbindung_aus_der_umgebung_bleibt_unangetastet(tmp_path):
    """Bestandsserver: die Nummer steht in der .env, nicht in der Datei. Eine
    neue Datei verlöre gegen die Umgebung — also gar nicht erst anfangen."""
    cloud = Cloud(tmp_path)
    code, text, _ = _lauf(tmp_path, cloud, instanz_id=77, rueckfrage=lambda _f: True)
    assert code == 1
    assert cloud.pfade == []
    assert "PULSE_INSTANCE_ID" in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_unerwartete_zugangsdaten_werden_nicht_geschrieben(tmp_path):
    boese = {**ZUGANG, "client_secret": "x'$(reboot)"}
    cloud = Cloud(tmp_path, abholen=[(200, boese)])
    code, text, _ = _lauf(tmp_path, cloud)
    assert code == 1
    assert not (tmp_path / VERBINDUNG_DATEI).exists()
    assert "reboot" not in text


def test_cloud_nicht_erreichbar(tmp_path):
    def weg(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("weg", request=request)

    code, text, _ = _lauf(tmp_path, weg)
    assert code == 1
    assert CLOUD in text
    assert not (tmp_path / NACHWEIS_DATEI).exists()


def test_nachweis_wie_ihn_die_cloud_rechnet():
    """Server und Cloud rechnen den Nachweis je für sich; laufen die beiden
    Rechnungen auseinander, scheitert jedes Verbinden mit ``falscher_wert``."""
    from dcc_auth.verbinden import nachweis_aus_kennung as cloud_rechnung

    kennung = "Abc-_123xyz"
    assert nachweis_aus_kennung(kennung) == cloud_rechnung(kennung)


def test_main_reicht_die_schalter_durch(monkeypatch):
    gesehen = []

    def falsch(umgebung, client, *, neustart, rueckfrage, **_rest):
        gesehen.append((umgebung, neustart, rueckfrage))
        return 0

    monkeypatch.setattr(verbinden_cli, "verbinden", falsch)
    monkeypatch.setenv("PULSE_HOSTNAME", HOST)
    assert verbinden_cli.main(["--no-restart", "--yes"]) == 0
    assert verbinden_cli.main([]) == 0
    (umgebung, neustart_a, frage_a), (_u, neustart_b, frage_b) = gesehen
    assert umgebung.hostname == HOST
    assert neustart_a is None
    assert frage_a("?") is True
    assert neustart_b is verbinden_cli.container_neustarten
    assert frage_b is verbinden_cli.frage_im_terminal


def test_alter_nachweis_wird_ersetzt(tmp_path):
    """Ein abgebrochener Lauf kann eine Nachweis-Datei hinterlassen haben; der
    neue Lauf legt seine eigene darüber (die Cloud prüft beim Start dagegen)."""
    (tmp_path / NACHWEIS_DATEI).write_text("0" * 64 + "\n")
    cloud = Cloud(tmp_path, abholen=[(200, ZUGANG)])
    assert _lauf(tmp_path, cloud)[0] == 0
    assert cloud.nachweis_beim_start != "0" * 64


def test_strg_c_raeumt_den_nachweis_weg(tmp_path):
    def abbruch_beim_abholen(request: httpx.Request) -> httpx.Response:
        if request.url.path == ABHOLEN:
            raise KeyboardInterrupt
        return httpx.Response(201, json=VORGANG)

    with pytest.raises(KeyboardInterrupt):
        _lauf(tmp_path, abbruch_beim_abholen)
    assert not (tmp_path / NACHWEIS_DATEI).exists()
    assert not (tmp_path / VERBINDUNG_DATEI).exists()
```

`infra/self-host/tests/test_pulse_connect_huelle.py`:

```python
"""Die Hülle ``pulse-connect`` im Container.

Das Dockerfile kopiert ``infra/self-host/s6/`` als Ganzes nach ``/`` und setzt
für ``/usr/local/bin`` keinen Modus — das Ausführungsrecht kommt allein aus
Git (wie bei ``pulse-doctor``). Fehlt es, antwortet ``docker exec pulse
pulse-connect`` mit „permission denied“, und genau dieser Befehl steht im
Container-Log jedes unverbundenen Servers.
"""

from __future__ import annotations

import importlib
import os
import pathlib
import sys

import pytest

if sys.platform == "win32":
    pytest.skip("Ausführungsbit gibt es nur unter Linux/macOS", allow_module_level=True)

HUELLE = pathlib.Path(__file__).resolve().parents[1] / "s6" / "usr/local/bin/pulse-connect"


def test_huelle_ist_ausfuehrbar_und_ruft_das_modul():
    assert os.access(HUELLE, os.X_OK), "chmod 755 + git update-index --chmod=+x vergessen?"
    text = HUELLE.read_text(encoding="utf-8")
    assert ". /etc/pulse/env.sh" in text
    assert "-m dcc_chat_gateway.verbinden_cli" in text
    # Der Neustart am Ende braucht root (halt) — kein gosu.
    assert "gosu" not in text.split("set -eu", 1)[1]


def test_das_aufgerufene_modul_hat_einen_einstieg():
    modul = importlib.import_module("dcc_chat_gateway.verbinden_cli")
    assert callable(modul.main)
```

- [ ] **Step 2: Tests laufen lassen, sie müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_verbinden_cli.py`
Expected: FAIL — Sammelfehler `ModuleNotFoundError: No module named 'dcc_chat_gateway.verbinden_cli'`, `Interrupted: 1 error during collection`.

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q infra/self-host/tests/test_pulse_connect_huelle.py`
Expected: FAIL — `test_huelle_ist_ausfuehrbar_und_ruft_das_modul` mit `AssertionError: chmod 755 + git update-index --chmod=+x vergessen?` (Datei fehlt, `os.access` → False); `test_das_aufgerufene_modul_hat_einen_einstieg` mit `ModuleNotFoundError: No module named 'dcc_chat_gateway.verbinden_cli'`.

- [ ] **Step 3: `services/chat-gateway/src/dcc_chat_gateway/verbinden_texte.py` anlegen:**

```python
"""Die Texte von ``pulse-connect`` (``verbinden_cli.py``).

Englisch, weil sie im Terminal fremder Betreiber stehen (Regel aus
``owner_admin_log.py``); eigene Datei, damit die Ablauflogik unter der
Größengrenze bleibt — Muster ``dcc_auth/diagnose_texte.py``. Kein Text hier
enthält die Abholkennung oder ein Secret, und keiner darf es je tun.

``BEFUNDE`` deckt die Befunde der Cloud-Prüfung ab (``verbinden_nachweis.py``
im auth-svc: ``nicht_erreichbar``, ``zertifikat``, ``kein_nachweis``,
``falscher_wert``). Kommt dort einer dazu, gehört er hierher.
"""

from __future__ import annotations

BEFUNDE = {
    "nicht_erreichbar": (
        "The Pulse cloud could not reach https://{host}/. Check that the DNS record "
        "of {host} points at this server and that port 443 is open."
    ),
    "zertifikat": (
        "https://{host}/ has no valid certificate yet. It usually arrives within a "
        "few minutes after the DNS record points at this server."
    ),
    "kein_nachweis": (
        "https://{host}/ answered, but without the connection proof. If a proxy sits "
        "in front of Pulse, it must forward /.well-known/pulse-verbinden."
    ),
    "falscher_wert": (
        "https://{host}/ answered with a different connection proof. Is another "
        "Pulse server running under this address?"
    ),
}
BEFUND_UNBEKANNT = "The Pulse cloud could not verify https://{host}/."
NACHWEIS_HILFE = (
    "No code was used up. Details: docker exec pulse pulse-doctor\n"
    "Then try again: docker exec -it pulse pulse-connect"
)

NUR_SELF_HOST = "pulse-connect only works on a self-hosted Pulse server."
OHNE_ADRESSE = "PULSE_HOSTNAME is not set. Set it to the address of this server."
AUS_DER_UMGEBUNG = (
    "This server is connected through its configuration (PULSE_INSTANCE_ID in .env\n"
    "or docker run -e), and pulse-connect cannot change that. To connect it to\n"
    "another account, remove PULSE_INSTANCE_ID, PULSE_INSTANCE_OWNER_ID,\n"
    "PULSE_CLOUD_CLIENT_ID and PULSE_CLOUD_CLIENT_SECRET there, recreate the\n"
    "container and run pulse-connect again."
)
SCHON_VERBUNDEN = (
    "This server is already connected to a Pulse account. "
    "Connect it to a different account? [y/N] "
)
NICHTS_GEAENDERT = "Nothing changed."

BEGINN = "Connecting {host} to a Pulse account."
ANLEITUNG = (
    "Open this link in a browser where you are signed in to Pulse:\n\n"
    "  {link}\n\n"
    "Check that it shows the code {code}, then confirm.\n"
    "Only confirm if you are installing this server yourself right now.\n"
    "Waiting for the confirmation (up to {minuten} minutes) ..."
)

CLOUD_WEG = (
    "Could not reach the Pulse cloud at {origin}. "
    "Check the outgoing internet connection of this server."
)
ADRESSE_GESPERRT = "{host} belongs to Pulse itself. Use your own domain."
ADRESSE_UNGUELTIG = "The Pulse cloud does not accept {host} as an address."
ZU_VIELE = "Too many connection attempts from this server. Try again in an hour."
UNERWARTET = "Unexpected answer from the Pulse cloud (HTTP {status}). Nothing changed."
ABGELEHNT = "The connection was declined in the browser. Nothing changed."
ABGELAUFEN = "The code expired before it was confirmed. Run pulse-connect again."

VERBUNDEN = "Connected to {besitzer}. Your server now appears in Pulse."
NEUSTART = "Restarting the server to apply the connection. It is back in about a minute."
NEUSTART_VON_HAND = "Could not restart by itself. On the host, run: docker restart pulse"
ABGEBROCHEN = "\nCancelled. Nothing changed."
```

- [ ] **Step 4: `services/chat-gateway/src/dcc_chat_gateway/verbinden_cli.py` anlegen:**

```python
"""``pulse-connect`` — diesen Server mit einem Pulse-Konto verbinden.

Aufruf im Container: ``docker exec -it pulse pulse-connect [--no-restart] [--yes]``
(Hülle: ``infra/self-host/s6/usr/local/bin/pulse-connect``). Ablauf nach dem
Muster „Device Authorization Grant“ (RFC 8628), Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md`` E1/E2/E6:

1. Eine geheime Abholkennung erzeugen und ihren SHA-256 als Nachweis nach
   ``<pulse_verbinden_dir>/verbinden-nachweis`` legen; der chat-gateway liefert
   ihn unter ``/.well-known/pulse-verbinden`` aus.
2. Bei der Cloud einen Gerätecode anfragen und dabei die Kennung selbst
   mitschicken; die Cloud bildet den Hash und vergleicht ihn sofort von außen
   mit dem Nachweis — ein nicht erreichbarer Server verbraucht keinen Code
   (Exit 3). Der Nachweis ist öffentlich lesbar und genügt allein für nichts:
   stünde er statt der Kennung im Anfragekörper, könnte jeder Mitleser einen
   Vorgang für diesen Server anlegen (Vertrag, Nachtrag 2).
3. Link und Code zeigen und alle ``abstand_s`` Sekunden abholen, bis der
   Betreiber im Browser bestätigt oder ablehnt, höchstens 15 Minuten.
4. Die Zugangsdaten atomar nach ``verbindung.env`` schreiben (0600), den
   Nachweis löschen und den Container neu starten: erst der Neustart rendert
   ``/etc/pulse/env.sh`` neu (07-render-env.sh liest die Datei dort).

**Abholkennung und Secret erscheinen in keiner Ausgabe.** Die Kennung geht
nur an die Cloud (``start``, ``abholen``). Link und Code erscheinen — sie zu
zeigen ist der Zweck. Die Texte stehen in ``verbinden_texte.py``.

**Rechte.** ``docker exec`` läuft als root, und dabei bleibt es: der Neustart
über ``/run/s6/basedir/bin/halt`` braucht root (wie in restart-gate.sh). Für den
Dienst bleibt trotzdem alles lesbar: ``/data/pulse`` gehört ``pulse`` (uid
10001, 01-init-data-dirs.sh), der Nachweis ist 0644, und ``verbindung.env``
(0600) liest allein 07-render-env.sh, das selbst als root läuft. Beim nächsten
Start macht ``chown -R pulse:pulse /data`` (01-init-data-dirs.sh) ohnehin alles
zu ``pulse``.

Exit-Codes: 0 verbunden · 1 Fehler · 2 abgelehnt oder abgelaufen · 3 der
Nachweis ist von außen nicht erreichbar.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import secrets
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from dcc_chat_gateway import config as chat_config
from dcc_chat_gateway import verbinden_texte as texte
from dcc_chat_gateway.verbindung import NACHWEIS_DATEI, VERBINDUNG_DATEI

#: Beendet den Container sauber; die Neustartregel ``unless-stopped``
#: (Installer, Compose-Dateien) holt ihn zurück.
HALT = "/run/s6/basedir/bin/halt"
#: Spec E8: ein Gerätecode gilt 15 Minuten. Länger wartet das Werkzeug auch
#: dann nicht, wenn die Cloud mehr nennt.
HOECHSTENS_S = 900
ANFRAGE_FRIST_S = 15.0
#: Erlaubte Zeichen in ``verbindung.env``. 07-render-env.sh weist alles andere
#: ab (``*[!A-Za-z0-9._@+-]*``) — beide Stellen synchron halten.
_WERT = re.compile(r"[A-Za-z0-9._@+-]+")
_ZAHL = re.compile(r"[0-9]+")


class _Abbruch(Exception):
    """Beendet den Ablauf mit Exit-Code und einer Meldung für den Betreiber."""

    def __init__(self, exit_code: int, meldung: str) -> None:
        super().__init__(meldung)
        self.exit_code = exit_code
        self.meldung = meldung


@dataclass(frozen=True)
class Umgebung:
    """Was ``pulse-connect`` über diesen Server wissen muss (aus env.sh)."""

    hostname: str
    cloud_origin: str
    verzeichnis: Path
    #: ``pulse_instance_id`` aus /etc/pulse/env.sh; 0 = unverbunden.
    instanz_id: int
    modus: str


@dataclass(frozen=True)
class _Vorgang:
    code: str
    link: str
    gueltig_s: int
    abstand_s: int


def nachweis_aus_kennung(kennung: str) -> str:
    """SHA-256 der Abholkennung, hex, klein — dieselbe Rechnung wie
    ``dcc_auth.verbinden.nachweis_aus_kennung`` (Prüfstein im Test)."""
    return hashlib.sha256(kennung.encode("utf-8")).hexdigest()


def lies_verbindung(verzeichnis: Path) -> dict[str, str]:
    """Die Schlüssel aus ``verbindung.env``; leer, wenn es keine gibt."""
    try:
        zeilen = (verzeichnis / VERBINDUNG_DATEI).read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    return dict(zeile.split("=", 1) for zeile in zeilen if "=" in zeile)


def _schreibe_atomar(ziel: Path, inhalt: str, modus: int) -> None:
    """Erst eine Nachbardatei, dann umbenennen: ein Abbruch mittendrin hinterlässt
    nie eine halbe ``verbindung.env``, die 07-render-env.sh dann läse."""
    zwischen = ziel.with_name(f".{ziel.name}.{os.getpid()}.tmp")
    fd = os.open(zwischen, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, modus)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as datei:
            datei.write(inhalt)
            datei.flush()
            os.fsync(datei.fileno())
        os.chmod(zwischen, modus)  # die umask darf den Modus nicht verändern
        os.replace(zwischen, ziel)
    except BaseException:
        zwischen.unlink(missing_ok=True)
        raise


def _anzeigbar(text: str) -> str:
    """Steuerzeichen aus Cloud-Text entfernen, bevor er im Terminal landet."""
    return "".join(zeichen for zeichen in text if zeichen.isprintable())


def _vorpruefung(umgebung: Umgebung, rueckfrage: Callable[[str], bool]) -> None:
    if umgebung.modus != "self-host":
        raise _Abbruch(1, texte.NUR_SELF_HOST)
    if not umgebung.hostname:
        raise _Abbruch(1, texte.OHNE_ADRESSE)
    datei_id = lies_verbindung(umgebung.verzeichnis).get("PULSE_INSTANCE_ID", "")
    # Eine Instanz-Nummer, die nicht aus der Datei stammt, steht in der Umgebung —
    # und die gewinnt (07-render-env.sh). Eine neue Datei bliebe wirkungslos.
    if umgebung.instanz_id and str(umgebung.instanz_id) != datei_id:
        raise _Abbruch(1, texte.AUS_DER_UMGEBUNG)
    if datei_id and not rueckfrage(texte.SCHON_VERBUNDEN):
        raise _Abbruch(1, texte.NICHTS_GEAENDERT)


def _detail(antwort: httpx.Response) -> object:
    try:
        return antwort.json().get("detail")
    except (ValueError, AttributeError):
        return None


def _starten(umgebung: Umgebung, client: httpx.Client, kennung: str) -> _Vorgang:
    url = f"{umgebung.cloud_origin}/api/auth/selfhost/verbinden/start"
    host = umgebung.hostname
    try:
        antwort = client.post(url, json={"hostname": host, "kennung": kennung})
    except httpx.HTTPError:
        raise _Abbruch(1, texte.CLOUD_WEG.format(origin=umgebung.cloud_origin)) from None
    detail = _detail(antwort)
    if antwort.status_code == 409:
        befund = detail.get("befund") if isinstance(detail, dict) else None
        text = texte.BEFUNDE.get(befund, texte.BEFUND_UNBEKANNT).format(host=host)
        raise _Abbruch(3, f"{text}\n{texte.NACHWEIS_HILFE}")
    if antwort.status_code == 400:
        gesperrt = detail == "adresse_gesperrt"
        vorlage = texte.ADRESSE_GESPERRT if gesperrt else texte.ADRESSE_UNGUELTIG
        raise _Abbruch(1, vorlage.format(host=host))
    if antwort.status_code == 429:
        raise _Abbruch(1, texte.ZU_VIELE)
    if antwort.status_code != 201:
        raise _Abbruch(1, texte.UNERWARTET.format(status=antwort.status_code))
    try:
        daten = antwort.json()
        return _Vorgang(
            code=_anzeigbar(str(daten["code"])),
            link=_anzeigbar(str(daten["link"])),
            gueltig_s=min(int(daten["gueltig_s"]), HOECHSTENS_S),
            abstand_s=max(1, int(daten["abstand_s"])),
        )
    except (ValueError, KeyError, TypeError):
        raise _Abbruch(1, texte.UNERWARTET.format(status=201)) from None


def _abholen(
    umgebung: Umgebung,
    client: httpx.Client,
    kennung: str,
    vorgang: _Vorgang,
    schlafen: Callable[[float], None],
    uhr: Callable[[], float],
) -> dict:
    url = f"{umgebung.cloud_origin}/api/auth/selfhost/verbinden/abholen"
    ende = uhr() + vorgang.gueltig_s
    while uhr() < ende:
        schlafen(vorgang.abstand_s)
        try:
            antwort = client.post(url, json={"kennung": kennung})
        except httpx.HTTPError:
            continue  # Netzaussetzer: weiter warten, die Frist läuft mit
        if antwort.status_code == 200:
            try:
                return antwort.json()
            except ValueError:
                raise _Abbruch(1, texte.UNERWARTET.format(status=200)) from None
        if antwort.status_code == 403:
            raise _Abbruch(2, texte.ABGELEHNT)
        if antwort.status_code == 410:
            break
        if antwort.status_code == 429:
            schlafen(vorgang.abstand_s)
        # 202 heißt „wartet“; alles andere (etwa 502 während eines Deploys der
        # Cloud) behandeln wir genauso — die Frist begrenzt das Warten.
    raise _Abbruch(2, texte.ABGELAUFEN)


def _verbindung_env(zugang: dict) -> str:
    """Inhalt von ``verbindung.env`` — oder Abbruch, ohne die Werte zu nennen."""
    pflicht = (
        ("PULSE_INSTANCE_ID", zugang.get("instance_id"), _ZAHL),
        ("PULSE_INSTANCE_OWNER_ID", zugang.get("owner_user_id"), _ZAHL),
        ("PULSE_CLOUD_CLIENT_ID", zugang.get("client_id"), _WERT),
        ("PULSE_CLOUD_CLIENT_SECRET", zugang.get("client_secret"), _WERT),
    )
    zeilen = []
    for name, wert, form in pflicht:
        if not isinstance(wert, str) or not form.fullmatch(wert):
            raise _Abbruch(1, texte.UNERWARTET.format(status=200))
        zeilen.append(f"{name}={wert}")
    mail = zugang.get("admin_email")
    if isinstance(mail, str) and "@" in mail and _WERT.fullmatch(mail):
        zeilen.append(f"PULSE_ADMIN_EMAIL={mail}")
    return "\n".join(zeilen) + "\n"


def _drucke(text: str) -> None:
    print(text, flush=True)


def verbinden(
    umgebung: Umgebung,
    client: httpx.Client,
    *,
    neustart: Callable[[], None] | None,
    rueckfrage: Callable[[str], bool],
    schlafen: Callable[[float], None] = time.sleep,
    uhr: Callable[[], float] = time.monotonic,
    ausgabe: Callable[[str], None] = _drucke,
) -> int:
    """Der ganze Ablauf; gibt den Exit-Code zurück. ``neustart=None`` = ``--no-restart``."""
    try:
        _vorpruefung(umgebung, rueckfrage)
        ausgabe(texte.BEGINN.format(host=umgebung.hostname))
        kennung = secrets.token_urlsafe(32)
        nachweis_datei = umgebung.verzeichnis / NACHWEIS_DATEI
        umgebung.verzeichnis.mkdir(parents=True, exist_ok=True)
        # VOR der Anfrage: die Cloud ruft den Nachweis sofort von außen ab.
        _schreibe_atomar(nachweis_datei, nachweis_aus_kennung(kennung) + "\n", 0o644)
        try:
            vorgang = _starten(umgebung, client, kennung)
            minuten = vorgang.gueltig_s // 60
            ausgabe(texte.ANLEITUNG.format(link=vorgang.link, code=vorgang.code, minuten=minuten))
            zugang = _abholen(umgebung, client, kennung, vorgang, schlafen, uhr)
            inhalt = _verbindung_env(zugang)
            _schreibe_atomar(umgebung.verzeichnis / VERBINDUNG_DATEI, inhalt, 0o600)
        finally:
            nachweis_datei.unlink(missing_ok=True)
    except _Abbruch as abbruch:
        ausgabe(abbruch.meldung)
        return abbruch.exit_code
    besitzer = _anzeigbar(str(zugang.get("owner_name") or "your account"))
    ausgabe(texte.VERBUNDEN.format(besitzer=besitzer))
    if neustart is not None:
        ausgabe(texte.NEUSTART)
        neustart()
    return 0


def container_neustarten() -> None:
    """Container über s6 beenden; Docker startet ihn neu (``unless-stopped``)."""
    try:
        erfolgreich = subprocess.run([HALT], check=False).returncode == 0
    except OSError:
        erfolgreich = False
    if not erfolgreich:
        print(texte.NEUSTART_VON_HAND, flush=True)


def frage_im_terminal(frage: str) -> bool:
    try:
        return input(frage).strip().lower() in ("y", "yes")
    except EOFError:  # kein Terminal (docker exec ohne -it): lieber nichts ändern
        return False


def _immer_ja(_frage: str) -> bool:
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pulse-connect", description="Connect this Pulse server to your Pulse account."
    )
    parser.add_argument(
        "--no-restart",
        action="store_true",
        help="do not restart the server afterwards (the installer restarts it itself)",
    )
    parser.add_argument(
        "--yes", action="store_true", help="connect again without asking if already connected"
    )
    optionen = parser.parse_args(argv)
    settings = chat_config.get_settings()
    umgebung = Umgebung(
        hostname=os.environ.get("PULSE_HOSTNAME", "").strip(),
        cloud_origin=settings.pulse_cloud_origin.rstrip("/"),
        verzeichnis=Path(settings.pulse_verbinden_dir),
        instanz_id=settings.pulse_instance_id,
        modus=settings.pulse_instance_mode,
    )
    with httpx.Client(timeout=ANFRAGE_FRIST_S, follow_redirects=False) as client:
        try:
            return verbinden(
                umgebung,
                client,
                neustart=None if optionen.no_restart else container_neustarten,
                rueckfrage=_immer_ja if optionen.yes else frage_im_terminal,
            )
        except KeyboardInterrupt:
            print(texte.ABGEBROCHEN, file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())
```

Warum der Neustart erst nach der Erfolgsmeldung kommt: `halt` beendet den ganzen Container und damit auch diesen Prozess und die `docker exec`-Sitzung — was danach gedruckt würde, sähe niemand. Ohne Neustartregel (`--restart unless-stopped` setzen Installer und beide Compose-Dateien, `docker-compose.yml:51`) bliebe der Container stehen; das ist der Fall, für den `NEUSTART_VON_HAND` nur greift, wenn `halt` gar nicht erst läuft.

- [ ] **Step 5: Hülle `infra/self-host/s6/usr/local/bin/pulse-connect` anlegen:**

```sh
#!/bin/sh
# pulse-connect — diesen Server mit einem Pulse-Konto verbinden.
#   docker exec -it pulse pulse-connect [--no-restart] [--yes]
#
# Dieselbe Umgebung wie der chat-gateway (s6-rc.d/chat-gateway/run): die Dienste
# lesen ausschliesslich /etc/pulse/env.sh, und nur dort stehen die Werte aus
# /data/pulse/verbindung.env (07-render-env.sh). Die Logik steht in
# services/chat-gateway/src/dcc_chat_gateway/verbinden_cli.py.
#
# Bewusst OHNE gosu: der Neustart am Ende (/run/s6/basedir/bin/halt) braucht
# root. Warum die Dateien trotzdem für den Dienst lesbar bleiben, steht im Kopf
# von verbinden_cli.py.
set -eu
if [ ! -r /etc/pulse/env.sh ]; then
    echo "pulse-connect: the server is still starting. Wait a moment and try again." >&2
    exit 1
fi
. /etc/pulse/env.sh
exec /opt/pulse/venv/bin/python3 -m dcc_chat_gateway.verbinden_cli "$@"
```

Ausführbar machen (der Dockerfile setzt den Modus nicht, er kommt aus Git):

```bash
chmod 755 infra/self-host/s6/usr/local/bin/pulse-connect
git add infra/self-host/s6/usr/local/bin/pulse-connect
git update-index --chmod=+x infra/self-host/s6/usr/local/bin/pulse-connect
git ls-files -s infra/self-host/s6/usr/local/bin/pulse-connect
```

Expected: Zeile beginnt mit `100755`.

- [ ] **Step 6: Tests laufen lassen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/chat-gateway/tests/test_verbinden_cli.py infra/self-host/tests/test_pulse_connect_huelle.py`
Expected: PASS (16 + 2 Testfälle). In der Wegwerf-Kopie ohne Etappe 1 nachgefahren: 15 von 15 grün bei abgewähltem Prüfstein; der Prüfstein `test_nachweis_wie_ihn_die_cloud_rechnet` braucht Etappe 1 auf `main` — scheitert er mit `ModuleNotFoundError: dcc_auth.verbinden`, ist der Zweig nicht von einem `main` mit Etappe 1 abgezweigt.

- [ ] **Step 7: Vereinfachen.** `code-simplifier` über `verbinden_cli.py`, `verbinden_texte.py`, die Hülle und die zwei Testdateien (Grenze: `verbinden_cli.py` ≤ 350 Zeilen halten); Step 6 erneut grün; `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 8: Commit.**

```bash
git add services/chat-gateway/src/dcc_chat_gateway/verbinden_cli.py \
  services/chat-gateway/src/dcc_chat_gateway/verbinden_texte.py \
  infra/self-host/s6/usr/local/bin/pulse-connect \
  services/chat-gateway/tests/test_verbinden_cli.py \
  infra/self-host/tests/test_pulse_connect_huelle.py
git commit -m "feat(self-host): pulse-connect verbindet den Server per Gerätecode mit einem Pulse-Konto

Legt den Nachweis ab, fragt bei der Cloud einen Code an, zeigt Link und Code,
holt die Zugangsdaten nach der Bestätigung im Browser ab, schreibt sie nach
/data/pulse/verbindung.env und startet den Container neu (Spec 2026-10-09,
E1/E6). Abholkennung und Secret erscheinen in keiner Ausgabe.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2.5: Landen und Bestand prüfen

**Files:** keine neuen. Prüft den ganzen Zweig.

**Interfaces:**
- Consumes: Etappe 1 live in der Cloud (für die Rauchprobe); Self-Host-Bild aus Etappe 0.
- Produces: `main` mit Etappe 2; `allinone.yml` baut das Bild (Pfadfilter `services/**`, `infra/self-host/**`, `.github/workflows/allinone.yml:43–49`).

- [ ] **Step 1: Volles Gate.**

Run: `bash scripts/gate.sh`
Expected: grün; Backend-Bereich läuft (inkl. `infra/self-host/tests`, sie stehen in den pytest-`testpaths`), Infra-Bereich (`pulse-update-faelle.sh`) läuft, Web und Rust übersprungen (Teilbäume gleich `origin/main`).

- [ ] **Step 2: Reste greppen.**

```bash
git grep -n "instance_id_unconfigured\|PULSE_INSTANCE_ID must be set\|10-check will eine nicht-leere"
```

Expected, und so bleibt es in dieser Etappe:
- `web/src/lib/api/anmelde-fehler-codes.ts:28,57` — Teil C nimmt `nicht_verbunden` dazu (Etappe 3); `instance_id_unconfigured` bleibt dort (append-only, schadet nicht).
- `desktop/electron/localBackend/containerEnv.ts:127` — Kommentar stimmt nicht mehr; bewusst nicht hier angefasst (siehe Offene Punkte).
- `SCAN_REPORT_2026-05-29_rescan.findings.json` — Archiv, nicht anfassen.
- `docs/superpowers/plans/2026-08-28-e2e-dm-etappen.md:408` — überholter Plan (CLAUDE.md nennt ihn so), Geschichte.
- `docs/superpowers/plans/2026-10-09-selfhost-ohne-freigabe.md` — dieser Plan selbst bzw. seine Vorfassung.

Keine Treffer mehr in `services/` und `infra/`.

- [ ] **Step 3: Kein Changelog-Eintrag.** Kein Nutzer bemerkt die Etappe: neue, unverbundene Server entstehen erst mit dem Installer aus Etappe 4, Bestandsserver laufen unverändert. `scripts/check-changelog.sh` warnt beim Push trotzdem (Pfade unter `services/` zählen dort als Code) — die Warnung ist hinzunehmen, sie blockiert nichts (`exit 0`).

- [ ] **Step 4: Kein Versionssprung der Server-App.** `win-build-server.yml` liefert `services/**` und `Caddyfile.template` aus und baut bei diesem Push; Windows-Heim-Server erreicht das erst mit dem nächsten Bump. Absichtlich kein Bump: dort ist die Instanz-Nummer immer gesetzt (`desktop/electron/localBackend/nativeBackend/envContract.ts`), es gibt dort weder `pulse-connect` noch `/data/pulse` — die neue Route antwortet 404, der Start verhält sich wie bisher. Ein Bump spielte jedem Windows-Nutzer ein wirkungsloses Update zu (Präzedenz: `feat/fernsteuerung-1b-zweiter-schnitt`).

- [ ] **Step 5: Landen — nur nach ausdrücklicher Freigabe des Eigentümers.**

```bash
bash scripts/ship.sh
```

Danach `git tidy`.

- [ ] **Step 6: Rauchprobe am fertigen Bild** (lokale Maschine mit Docker, nicht der Hetzner — dort ist kein Platz). Sobald `allinone.yml` für den Merge-Commit grün ist:

```bash
PULSE_IMAGE="<Self-Host-Bild aus Etappe 0, z. B. ghcr.io/oblivion-pictures/pulse>:sha-<kurzer SHA des Merge-Commits>"
docker login ghcr.io   # nur solange das Paket privat ist (bis Etappe 4)
docker run -d --name pulse-probe -v pulse-probe-data:/data \
  -e PULSE_HOSTNAME=probe.example.org -e PULSE_TLS_MODE=behind-proxy \
  -p 127.0.0.1:18080:8080 "$PULSE_IMAGE"
until [ "$(docker inspect -f '{{.State.Health.Status}}' pulse-probe)" = healthy ]; do sleep 5; done
docker logs pulse-probe 2>&1 | grep -F "This server is not connected to a Pulse account yet. Run: docker exec -it pulse pulse-connect"
curl -s http://127.0.0.1:18080/.well-known/pulse-server-info
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/.well-known/pulse-verbinden
docker exec pulse-probe pulse-connect --no-restart; echo "exit=$?"
docker exec pulse-probe ls -l /data/pulse
docker rm -f pulse-probe && docker volume rm pulse-probe-data
```

Expected: Container wird `healthy` (Start nur mit Adresse, Caddy ohne `email`-Zeile); die `grep`-Zeile findet den Hinweis genau einmal; Server-Info enthält `"instance_id":null` und `"verbunden":false`; Nachweis-Route `404`; `pulse-connect` meldet „Connecting probe.example.org …“, dann den Befund `nicht_erreichbar` mit „No code was used up“ und `exit=3` (die Cloud erreicht `probe.example.org` nicht — genau der Weg ohne verbrauchten Code); `/data/pulse` gehört `pulse`, Modus `drwx------`, und ist danach leer.

- [ ] **Step 7: Bestand prüfen.** Binnen fünf Minuten nach dem Bau ziehen die Auto-Updater der Bestands-VPS das Bild. Auf einem davon (Adresse kennt der Eigentümer):

```bash
curl -s https://<bestands-host>/.well-known/pulse-server-info
curl -s -o /dev/null -w '%{http_code}\n' https://<bestands-host>/.well-known/pulse-verbinden
```

Expected: `"verbunden":true` und dieselbe `instance_id` wie vorher; Nachweis-Route `404`. In der App auf diesem Server neu anmelden: Anmeldung klappt, der Besitzer ist Admin (Server-Einstellungen erreichbar). Heim-Server (Server-App) bekommen das Bild mit ihrem nächsten Update; dort gewinnt `container.env` vor jeder Datei.

---

---

## Etappe 3 — Web: Bestätigungsseite `/verbinden`

Danach ist `https://howispulse.com/verbinden#XXXX-XXXX` live: Die Seite fragt
„Installierst du gerade selbst einen Pulse-Server?“, zeigt Adresse und Code und
verbindet mit „Ja, das ist mein Server“ (Abbrechen ist vorausgewählt); ohne
Anmeldung führt sie über Anmelden oder Registrieren zurück; die App nennt bei
einem unverbundenen Server den Handgriff `pulse-connect`.

Voraussetzung: Etappe 1 (`routes_verbinden.py`) und Etappe 2 (`nicht_verbunden`)
sind gelandet. Ohne Installer (Etappe 4) erreicht niemand die Seite — deshalb
kein Changelog-Eintrag in dieser Etappe.

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/verbinden-seite`

### Task 3.1: Code-Rechnung und gemerkter Code

**Files:**
- Create: `web/src/lib/verbinden/code.ts`
- Create: `web/src/lib/verbinden/gemerkt.ts`
- Create: `web/test/verbinden-code.test.ts`
- Create: `web/test/verbinden-gemerkt.test.ts`

**Interfaces:**
- Produces:
  - `codeNormalisieren(roh: string): string | null` → Anzeigeform `XXXX-XXXX` oder `null`
  - `codeAusHash(hash: string): string | null`
  - `SPEICHER_SCHLUESSEL = 'pulse.verbinden.gemerkt'`, `HALTBARKEIT_MS = 900_000`
  - `type Speicher = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>`
  - `verbindungMerken(s: Speicher | null, code: string, jetzt: number): void`
  - `gemerkteVerbindung(s: Speicher | null, jetzt: number): string | null`
  - `gemerkteVerbindungVerwerfen(s: Speicher | null): void`
- Consumes: nichts (beide Dateien importfrei bis auf den Nachbarn mit Endung `.ts`, Muster `web/src/lib/einladung/gemerkt.ts`).

- [ ] **Step 1: Test für die Code-Rechnung schreiben.** `web/test/verbinden-code.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeAusHash, codeNormalisieren } from '../src/lib/verbinden/code.ts';

test('gibt die Anzeigeform zurück, egal wie getippt', () => {
  for (const roh of [
    'K7QM-2XDP',
    'k7qm-2xdp',
    'K7QM2XDP',
    ' k7qm 2xdp ',
    'K7QM - 2XDP',
    'k-7-q-m-2-x-d-p'
  ]) {
    assert.equal(codeNormalisieren(roh), 'K7QM-2XDP', roh);
  }
});

test('verwechselbare Buchstaben werden zu Ziffern (wie die Cloud)', () => {
  assert.equal(codeNormalisieren('OOOO-IIII'), '0000-1111');
  assert.equal(codeNormalisieren('oooo-llll'), '0000-1111');
});

test('alles andere ist kein Code', () => {
  for (const roh of [
    '',
    'K7QM-2XD',
    'K7QM-2XDPQ',
    'K7QM-2XDU', // U gehört nicht zu Crockford-Base32
    'K7QM-2XD!',
    'K7QM_2XDP',
    'x'.repeat(40)
  ]) {
    assert.equal(codeNormalisieren(roh), null, roh);
  }
});

test('liest den Code hinter dem #', () => {
  assert.equal(codeAusHash('#K7QM-2XDP'), 'K7QM-2XDP');
  assert.equal(codeAusHash('#k7qm%202xdp'), 'K7QM-2XDP');
  assert.equal(codeAusHash('K7QM-2XDP'), 'K7QM-2XDP');
});

test('leerer oder kaputter Hash ergibt null', () => {
  for (const h of ['', '#', '#%E0%A4%A', '#nichts']) {
    assert.equal(codeAusHash(h), null, h);
  }
});
```

- [ ] **Step 2: Test für den gemerkten Code schreiben.** `web/test/verbinden-gemerkt.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gemerkteVerbindung,
  gemerkteVerbindungVerwerfen,
  verbindungMerken,
  HALTBARKEIT_MS,
  SPEICHER_SCHLUESSEL,
  type Speicher
} from '../src/lib/verbinden/gemerkt.ts';

function speicher(): Speicher & { daten: Map<string, string> } {
  const daten = new Map<string, string>();
  return {
    daten,
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k)
  };
}

const T0 = 1_760_000_000_000;

test('merken und wieder lesen, in Anzeigeform', () => {
  const s = speicher();
  verbindungMerken(s, 'k7qm2xdp', T0);
  assert.equal(gemerkteVerbindung(s, T0 + 1000), 'K7QM-2XDP');
});

test('ein ungültiger Code wird gar nicht erst gemerkt', () => {
  const s = speicher();
  verbindungMerken(s, 'quatsch', T0);
  assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false);
});

test('gilt 15 Minuten wie der Code an der Cloud, danach weg', () => {
  const s = speicher();
  verbindungMerken(s, 'K7QM-2XDP', T0);
  assert.equal(gemerkteVerbindung(s, T0 + HALTBARKEIT_MS - 1), 'K7QM-2XDP');
  assert.equal(gemerkteVerbindung(s, T0 + HALTBARKEIT_MS), null);
  assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false);
});

test('Zeitstempel in der Zukunft gilt nicht (Uhr verstellt)', () => {
  const s = speicher();
  verbindungMerken(s, 'K7QM-2XDP', T0 + 60_000);
  assert.equal(gemerkteVerbindung(s, T0), null);
});

test('kaputte oder manipulierte Einträge werden verworfen', () => {
  for (const roh of [
    'kein json',
    'null',
    '"text"',
    JSON.stringify({ code: 'K7QM-2XDU', gemerktAm: T0 }),
    JSON.stringify({ code: 7, gemerktAm: T0 }),
    JSON.stringify({ code: 'K7QM-2XDP', gemerktAm: 'gestern' })
  ]) {
    const s = speicher();
    s.daten.set(SPEICHER_SCHLUESSEL, roh);
    assert.equal(gemerkteVerbindung(s, T0), null, roh);
    assert.equal(s.daten.has(SPEICHER_SCHLUESSEL), false, roh);
  }
});

test('ein Speicher, der wirft, bricht nichts', () => {
  const wirft: Speicher = {
    getItem: () => {
      throw new Error('gesperrt');
    },
    setItem: () => {
      throw new Error('voll');
    },
    removeItem: () => {
      throw new Error('gesperrt');
    }
  };
  verbindungMerken(wirft, 'K7QM-2XDP', T0);
  assert.equal(gemerkteVerbindung(wirft, T0), null);
  gemerkteVerbindungVerwerfen(wirft);
  assert.equal(gemerkteVerbindung(null, T0), null);
});

test('verwerfen löscht', () => {
  const s = speicher();
  verbindungMerken(s, 'K7QM-2XDP', T0);
  gemerkteVerbindungVerwerfen(s);
  assert.equal(gemerkteVerbindung(s, T0), null);
});

test('eigener Schlüssel, getrennt von der gemerkten Einladung', () => {
  assert.equal(SPEICHER_SCHLUESSEL, 'pulse.verbinden.gemerkt');
});
```

- [ ] **Step 3: Tests laufen lassen, sie müssen scheitern.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit`
Expected: FAIL — `Cannot find module '../src/lib/verbinden/code.ts'`.

- [ ] **Step 4: `web/src/lib/verbinden/code.ts` anlegen.**

```ts
/**
 * Anzeigecode der Server-Verbindung (`XXXX-XXXX`, Crockford-Base32) — reine
 * Rechnung, importfrei (Node-Unit-Test, s. `pnpm test:unit`-Falle in
 * CLAUDE.md).
 *
 * Dieselbe Normalisierung wie `dcc_auth/verbinden.py::code_normalisieren`
 * (Etappe 1): Groß/klein egal, Leerraum und Bindestriche egal, `O`→`0`,
 * `I`/`L`→`1`. Die Cloud normalisiert selbst noch einmal; hier geht es darum,
 * einen Tippfehler sofort zu melden, statt die Bremse am Server
 * (20 Bestätigungen je Stunde und Konto) zu verbrauchen.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LAENGE = 8;
/** Mehr tippt niemand für acht Zeichen; längere Eingaben sind kein Code. */
const MAX_ROH = 32;

export function codeNormalisieren(roh: string): string | null {
  if (roh.length > MAX_ROH) return null;
  const s = roh
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== LAENGE) return null;
  for (const zeichen of s) {
    if (!ALPHABET.includes(zeichen)) return null;
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Code aus `location.hash` (mit oder ohne führendes `#`). Kaputt kodierte
 *  Adressen (`%E0%A4%A`) sind kein Code, kein Absturz. */
export function codeAusHash(hash: string): string | null {
  const roh = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!roh) return null;
  let dekodiert: string;
  try {
    dekodiert = decodeURIComponent(roh);
  } catch {
    return null;
  }
  return codeNormalisieren(dekodiert);
}
```

- [ ] **Step 5: `web/src/lib/verbinden/gemerkt.ts` anlegen.**

```ts
// Gemerkter Verbindungs-Code — der Rückweg der Bestätigungsseite `/verbinden`
// über Anmelden und Registrieren. Muster: `lib/einladung/gemerkt.ts`.
// Importfrei bis auf den Nachbarn (Node-Unit-Tests).
//
// Warum nicht über die Adresse (`/login?redirect=/verbinden#CODE`): der Code
// steht absichtlich hinter `#`, damit er in keinem Server-Protokoll landet
// (Spec E5). Als Teil von `?redirect=` stünde er in der Adresse der
// Anmeldeseite — und die fordert der Browser beim Server an. Die Anmeldung
// bekommt deshalb nur `?redirect=/verbinden`, der Code wartet hier.
//
// 15 Minuten wie der Code selbst: ein älterer Eintrag ist an der Cloud ohnehin
// verfallen.
import { codeNormalisieren } from './code.ts';

export const SPEICHER_SCHLUESSEL = 'pulse.verbinden.gemerkt';
export const HALTBARKEIT_MS = 15 * 60 * 1000;

export type Speicher = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function verbindungMerken(s: Speicher | null, code: string, jetzt: number): void {
  if (!s) return;
  const c = codeNormalisieren(code);
  if (!c) return;
  try {
    s.setItem(SPEICHER_SCHLUESSEL, JSON.stringify({ code: c, gemerktAm: jetzt }));
  } catch {
    /* voll oder gesperrt — dann eben ohne Rückweg */
  }
}

export function gemerkteVerbindungVerwerfen(s: Speicher | null): void {
  if (!s) return;
  try {
    s.removeItem(SPEICHER_SCHLUESSEL);
  } catch {
    /* gesperrt — es gibt nichts zu tun */
  }
}

/** Der gemerkte Code in Anzeigeform. Alles Ungültige (kaputt, abgelaufen, aus
 *  der Zukunft) wird dabei gelöscht. */
export function gemerkteVerbindung(s: Speicher | null, jetzt: number): string | null {
  if (!s) return null;
  let roh: string | null;
  try {
    roh = s.getItem(SPEICHER_SCHLUESSEL);
  } catch {
    return null;
  }
  if (roh === null) return null;
  const code = lesen(roh, jetzt);
  if (!code) gemerkteVerbindungVerwerfen(s);
  return code;
}

function lesen(roh: string, jetzt: number): string | null {
  let d: unknown;
  try {
    d = JSON.parse(roh);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null) return null;
  const { code, gemerktAm } = d as Record<string, unknown>;
  if (typeof code !== 'string' || typeof gemerktAm !== 'number') return null;
  const alter = jetzt - gemerktAm;
  if (!(alter >= 0 && alter < HALTBARKEIT_MS)) return null;
  return codeNormalisieren(code);
}
```

- [ ] **Step 6: Tests laufen lassen.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit`
Expected: PASS, die Testzahl steigt gegenüber vorher um 14.

- [ ] **Step 7: Vereinfachen, prüfen, committen.** `code-simplifier`-Agent über die vier Dateien, dann:

```bash
cd /home/michael/Dokumente/pulse/web && pnpm check && pnpm test:unit
cd /home/michael/Dokumente/pulse && bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/verbinden/code.ts web/src/lib/verbinden/gemerkt.ts \
  web/test/verbinden-code.test.ts web/test/verbinden-gemerkt.test.ts
git commit -m "feat(web): Verbindungs-Code normalisieren und über die Anmeldung merken

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.2: API, Seite `/verbinden` und Rückweg

**Files:**
- Create: `web/src/lib/verbinden/fehler.ts`
- Create: `web/test/verbinden-fehler.test.ts`
- Create: `web/src/lib/api/verbinden.ts`
- Create: `web/src/lib/verbinden/VerbindenKarte.svelte`
- Create: `web/src/routes/verbinden/+page.svelte`
- Create: `web/tests/e2e/verbinden.spec.ts`
- Modify: `web/src/routes/app/+page.svelte:1-24` (Importe), `:61-66` (Einschub nach dem `?add=`-Block)
- Modify: `web/src/lib/stores/auth.svelte.ts:5` (Import), `:412-415` (Abmelden)
- Modify: `web/messages/de.json`, `web/messages/en.json` (Ende)

**Interfaces:**
- Consumes (Vertrag, Etappe 1, Stand „Nachtrag 2“ — der Code steht nie in einem URL-Pfad): `POST /me/selfhost/verbinden/vorgang` Body `{"code": str}` → 200 `{hostname, gueltig_bis}` | 404 `{"detail":"unbekannt"}`; `POST /me/selfhost/verbinden/entscheidung` Body `{"code": str, "aktion": "verbinden"|"ablehnen"}` → 200 `{"status":"verbunden",hostname,instance_id}` | 200 `{"status":"abgelehnt"}` | 403 `{"detail":"verbinden_gesperrt"}` | 409 `{"detail":"zu_viele_server"}` | 409 `{"detail":{"code":"nachweis_fehlt","befund":…}}`; Bremse → 429.
- Consumes: `cookieFetch` (`web/src/lib/api/cookie-client.ts:64`), `ApiError` (`web/src/lib/api/client.ts:30`), `browserSpeicher` (`web/src/lib/einladung/gemerkt.ts:27`), `auth.hydrate()` (`web/src/lib/stores/auth.svelte.ts:59`), `serversStore.hydrateFromBackend()` (`web/src/lib/api/servers.svelte.ts:372`), `AuthBuehne` (`web/src/lib/components/AuthBuehne.svelte`).
- Produces:
  - `holeVerbindung(code: string): Promise<Verbindung>`, `entscheideVerbindung(code: string, aktion: 'verbinden' | 'ablehnen'): Promise<VerbindenErgebnis>` (`web/src/lib/api/verbinden.ts`)
  - `BEFUNDE`, `type VerbindenFehler`, `verbindenFehler(status: number | null, body: unknown): VerbindenFehler`, `meldungsSchluessel(f: VerbindenFehler): string | null` (`web/src/lib/verbinden/fehler.ts`)
  - `VerbindenKarte.svelte` mit exportiertem `type VerbindenZustand`
  - Route `/verbinden`; `data-testid`s siehe „Neue Namen“.

- [ ] **Step 1: Test für die Fehlerdeutung schreiben.** `web/test/verbinden-fehler.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BEFUNDE,
  meldungsSchluessel,
  verbindenFehler,
  type VerbindenFehler
} from '../src/lib/verbinden/fehler.ts';

test('404 heißt: Code unbekannt, abgelaufen oder schon entschieden', () => {
  assert.deepEqual(verbindenFehler(404, { detail: 'unbekannt' }), { art: 'unbekannt' });
});

test('401 heißt: die Anmeldung ist weg', () => {
  assert.deepEqual(verbindenFehler(401, { detail: 'missing session cookie' }), {
    art: 'abgemeldet'
  });
});

test('die drei Ablehnungen beim Bestätigen', () => {
  assert.deepEqual(verbindenFehler(403, { detail: 'verbinden_gesperrt' }), {
    art: 'verbinden_gesperrt'
  });
  assert.deepEqual(verbindenFehler(409, { detail: 'zu_viele_server' }), {
    art: 'zu_viele_server'
  });
  assert.deepEqual(
    verbindenFehler(409, { detail: { code: 'nachweis_fehlt', befund: 'zertifikat' } }),
    { art: 'nachweis_fehlt', befund: 'zertifikat' }
  );
});

test('ein unbekannter Befund bleibt ein Nachweis-Fehler ohne Einzelheit', () => {
  assert.deepEqual(
    verbindenFehler(409, { detail: { code: 'nachweis_fehlt', befund: 'neu' } }),
    { art: 'nachweis_fehlt', befund: null }
  );
});

test('Bremse und alles Unerwartete', () => {
  assert.deepEqual(verbindenFehler(429, null), { art: 'gebremst' });
  const unerwartet: [number | null, unknown][] = [
    [500, null],
    [null, null],
    [403, { detail: 'anderes' }],
    [409, 'text']
  ];
  for (const [status, body] of unerwartet) {
    assert.deepEqual(verbindenFehler(status, body), { art: 'sonst' }, String(status));
  }
});

test('unbekannt und abgemeldet sind eigene Zustände, kein Hinweistext', () => {
  assert.equal(meldungsSchluessel({ art: 'unbekannt' }), null);
  assert.equal(meldungsSchluessel({ art: 'abgemeldet' }), null);
});

test('jeder Hinweis hat einen Text in beiden Sprachen', () => {
  // Ein Schlüssel ohne Text fiele still auf „Etwas ist schiefgegangen“ zurück
  // — und der Betreiber erführe nicht, dass sein Proxy den Nachweis schluckt.
  const faelle: VerbindenFehler[] = [
    { art: 'nachweis_fehlt', befund: null },
    ...BEFUNDE.map((befund) => ({ art: 'nachweis_fehlt' as const, befund })),
    { art: 'zu_viele_server' },
    { art: 'verbinden_gesperrt' },
    { art: 'gebremst' },
    { art: 'sonst' }
  ];
  for (const sprache of ['de', 'en']) {
    const katalog = JSON.parse(
      readFileSync(new URL(`../messages/${sprache}.json`, import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    for (const f of faelle) {
      const schluessel = meldungsSchluessel(f);
      assert.ok(schluessel, JSON.stringify(f));
      assert.equal(typeof katalog[schluessel], 'string', `${sprache}: ${schluessel}`);
    }
  }
});
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit`
Expected: FAIL — `Cannot find module '../src/lib/verbinden/fehler.ts'`.

- [ ] **Step 3: `web/src/lib/verbinden/fehler.ts` anlegen.**

```ts
/**
 * Was eine Antwort der Cloud auf der Bestätigungsseite `/verbinden` bedeutet —
 * reine Rechnung, importfrei (Node-Unit-Test).
 *
 * Quelle der Codes: `dcc_auth/routes_verbinden.py` (Etappe 1). Die Texte stehen
 * im Paraglide-Katalog unter `verbinden_fehler_*`; diese Datei nennt nur den
 * Schlüssel, damit der Test die Deckung in beiden Sprachen prüfen kann (Muster:
 * `api/anmelde-fehler-codes.ts`).
 */

/** Befunde der Nachweis-Prüfung (`verbinden_nachweis.py::nachweis_pruefen`). */
export const BEFUNDE = ['nicht_erreichbar', 'zertifikat', 'kein_nachweis', 'falscher_wert'] as const;
type Befund = (typeof BEFUNDE)[number];

export type VerbindenFehler =
  | { art: 'unbekannt' }
  | { art: 'abgemeldet' }
  | { art: 'nachweis_fehlt'; befund: Befund | null }
  | { art: 'zu_viele_server' }
  | { art: 'verbinden_gesperrt' }
  | { art: 'gebremst' }
  | { art: 'sonst' };

function detail(body: unknown): unknown {
  return body !== null && typeof body === 'object' && 'detail' in body
    ? (body as { detail: unknown }).detail
    : undefined;
}

function istBefund(wert: unknown): wert is Befund {
  return (BEFUNDE as readonly unknown[]).includes(wert);
}

/** `status` = HTTP-Status der Antwort, `null` = gar keine Antwort (Netz weg). */
export function verbindenFehler(status: number | null, body: unknown): VerbindenFehler {
  const d = detail(body);
  if (status === 404) return { art: 'unbekannt' };
  if (status === 401) return { art: 'abgemeldet' };
  if (status === 429) return { art: 'gebremst' };
  if (status === 403 && d === 'verbinden_gesperrt') return { art: 'verbinden_gesperrt' };
  if (status === 409 && d === 'zu_viele_server') return { art: 'zu_viele_server' };
  if (status === 409 && d !== null && typeof d === 'object') {
    const { code, befund } = d as { code?: unknown; befund?: unknown };
    if (code === 'nachweis_fehlt') {
      return { art: 'nachweis_fehlt', befund: istBefund(befund) ? befund : null };
    }
  }
  return { art: 'sonst' };
}

/** Paraglide-Schlüssel des Hinweistextes. `null` = die Seite wechselt in einen
 *  eigenen Zustand („gilt nicht mehr“, „anmelden“) statt einen Text zu zeigen. */
export function meldungsSchluessel(f: VerbindenFehler): string | null {
  switch (f.art) {
    case 'unbekannt':
    case 'abgemeldet':
      return null;
    case 'nachweis_fehlt':
      return f.befund ? `verbinden_fehler_nachweis_${f.befund}` : 'verbinden_fehler_nachweis';
    case 'zu_viele_server':
      return 'verbinden_fehler_zu_viele_server';
    case 'verbinden_gesperrt':
      return 'verbinden_fehler_gesperrt';
    case 'gebremst':
      return 'verbinden_fehler_gebremst';
    default:
      return 'verbinden_fehler_sonst';
  }
}
```

- [ ] **Step 4: Texte anfügen.** Ans Ende von `web/messages/de.json`:

```json
  "verbinden_seitentitel": "Server verbinden · Pulse",
  "verbinden_titel": "Server verbinden",
  "verbinden_frage_titel": "Installierst du gerade selbst einen Pulse-Server?",
  "verbinden_code_konsole": "Dieser Code steht jetzt in der Konsole deines Servers.",
  "verbinden_warnung": "Hat dir jemand diesen Link geschickt? Dann klicke auf Abbrechen.",
  "verbinden_ja": "Ja, das ist mein Server",
  "verbinden_ja_laeuft": "Verbinde …",
  "verbinden_abbrechen": "Abbrechen",
  "verbinden_angemeldet_als": "Angemeldet als {konto}",
  "verbinden_code_label": "Code",
  "verbinden_eingabe_text": "Gib den Code ein, den dein Server in der Konsole zeigt.",
  "verbinden_eingabe_platzhalter": "XXXX-XXXX",
  "verbinden_eingabe_weiter": "Weiter",
  "verbinden_eingabe_ungueltig": "Das ist kein gültiger Code. Er hat acht Zeichen, zum Beispiel K7QM-2XDP.",
  "verbinden_abgemeldet_text": "Melde dich bei Pulse an, um diesen Server mit deinem Konto zu verbinden.",
  "verbinden_anmelden": "Anmelden",
  "verbinden_registrieren": "Konto erstellen",
  "verbinden_fertig_titel": "Server verbunden",
  "verbinden_fertig_text": "Fertig. Die Konsole deines Servers macht jetzt von selbst weiter.",
  "verbinden_abgelehnt_titel": "Abgebrochen",
  "verbinden_abgelehnt_text": "Der Server wird nicht mit deinem Konto verbunden. Die Konsole des Servers meldet das von selbst.",
  "verbinden_unbekannt_titel": "Dieser Code gilt nicht mehr",
  "verbinden_unbekannt_text": "Ein Code gilt 15 Minuten und nur einmal. Einen neuen bekommst du auf deinem Server mit: docker exec -it pulse pulse-connect",
  "verbinden_zu_pulse": "Zu Pulse",
  "verbinden_erneut": "Erneut versuchen",
  "verbinden_fehler_titel": "Das hat nicht geklappt",
  "verbinden_fehler_nachweis": "Pulse konnte nicht prüfen, dass dein Server unter dieser Adresse läuft. Versuche es gleich noch einmal.",
  "verbinden_fehler_nachweis_nicht_erreichbar": "Pulse erreicht deinen Server unter dieser Adresse gerade nicht. Prüfe, ob er läuft und Port 443 von außen erreichbar ist, dann versuche es noch einmal.",
  "verbinden_fehler_nachweis_zertifikat": "Dein Server hat noch kein gültiges Zertifikat. Warte ein, zwei Minuten, bis er es geholt hat, und versuche es dann noch einmal.",
  "verbinden_fehler_nachweis_kein_nachweis": "Unter dieser Adresse antwortet nicht dein Pulse-Server, oder ein Proxy davor reicht /.well-known/pulse-verbinden nicht durch.",
  "verbinden_fehler_nachweis_falscher_wert": "Unter dieser Adresse läuft ein anderer Pulse-Server als der, der diesen Code angefragt hat. Starte pulse-connect auf dem Server, der unter dieser Adresse läuft.",
  "verbinden_fehler_zu_viele_server": "Mit deinem Konto sind schon 10 gemietete Server verbunden. Lösche zuerst einen, den du nicht mehr brauchst.",
  "verbinden_fehler_gesperrt": "Dein Konto darf keine Server verbinden. Wende dich an den Betreiber von Pulse.",
  "verbinden_fehler_gebremst": "Zu viele Versuche in kurzer Zeit. Warte eine Weile und versuche es dann noch einmal.",
  "verbinden_fehler_sonst": "Etwas ist schiefgegangen. Versuche es gleich noch einmal."
```

Ans Ende von `web/messages/en.json`:

```json
  "verbinden_seitentitel": "Connect server · Pulse",
  "verbinden_titel": "Connect a server",
  "verbinden_frage_titel": "Are you installing a Pulse server yourself right now?",
  "verbinden_code_konsole": "This code is showing in your server's console right now.",
  "verbinden_warnung": "Did someone send you this link? Then click Cancel.",
  "verbinden_ja": "Yes, this is my server",
  "verbinden_ja_laeuft": "Connecting …",
  "verbinden_abbrechen": "Cancel",
  "verbinden_angemeldet_als": "Signed in as {konto}",
  "verbinden_code_label": "Code",
  "verbinden_eingabe_text": "Enter the code your server shows in its console.",
  "verbinden_eingabe_platzhalter": "XXXX-XXXX",
  "verbinden_eingabe_weiter": "Continue",
  "verbinden_eingabe_ungueltig": "That is not a valid code. It has eight characters, for example K7QM-2XDP.",
  "verbinden_abgemeldet_text": "Sign in to Pulse to connect this server to your account.",
  "verbinden_anmelden": "Sign in",
  "verbinden_registrieren": "Create account",
  "verbinden_fertig_titel": "Server connected",
  "verbinden_fertig_text": "Done. Your server's console continues on its own now.",
  "verbinden_abgelehnt_titel": "Cancelled",
  "verbinden_abgelehnt_text": "The server will not be connected to your account. The server's console reports this on its own.",
  "verbinden_unbekannt_titel": "This code is no longer valid",
  "verbinden_unbekannt_text": "A code is valid for 15 minutes and only once. Get a new one on your server with: docker exec -it pulse pulse-connect",
  "verbinden_zu_pulse": "Go to Pulse",
  "verbinden_erneut": "Try again",
  "verbinden_fehler_titel": "That did not work",
  "verbinden_fehler_nachweis": "Pulse could not verify that your server is running at this address. Try again in a moment.",
  "verbinden_fehler_nachweis_nicht_erreichbar": "Pulse cannot reach your server at this address right now. Check that it is running and that port 443 is reachable from outside, then try again.",
  "verbinden_fehler_nachweis_zertifikat": "Your server does not have a valid certificate yet. Wait a minute or two until it has fetched one, then try again.",
  "verbinden_fehler_nachweis_kein_nachweis": "Something other than your Pulse server answers at this address, or a proxy in front of it does not pass /.well-known/pulse-verbinden through.",
  "verbinden_fehler_nachweis_falscher_wert": "A different Pulse server than the one that requested this code is running at this address. Run pulse-connect on the server that runs at this address.",
  "verbinden_fehler_zu_viele_server": "Your account already has 10 rented servers connected. Delete one you no longer need first.",
  "verbinden_fehler_gesperrt": "Your account is not allowed to connect servers. Contact the operator of Pulse.",
  "verbinden_fehler_gebremst": "Too many attempts in a short time. Wait a while, then try again.",
  "verbinden_fehler_sonst": "Something went wrong. Try again in a moment."
```

- [ ] **Step 5: API anlegen.** `web/src/lib/api/verbinden.ts`:

```ts
/**
 * Bestätigungsseite `/verbinden` gegen auth-svc (Spec 2026-10-09, E1/E5;
 * Routen aus `routes_verbinden.py`). Cookie-Auth wie `instancesApi`.
 *
 * Der Code reist im Anfragekörper, nie im Pfad: Pfade landen in den
 * Zugriffsprotokollen von nginx/Caddy — genau das, was das `#` in der
 * Adresse der Seite vermeidet (Vertrag, Nachtrag 2). Er geht in Anzeigeform
 * (`XXXX-XXXX`) hinaus; die Cloud normalisiert selbst. Nie loggen — wer ihn
 * bestätigt, wird Besitzer eines Servers.
 */
import { cookieFetch } from './cookie-client';

/** Spiegelt die Antwort von `POST /me/selfhost/verbinden/vorgang`. */
export interface Verbindung {
  hostname: string;
  gueltig_bis: string;
}

/** Spiegelt die Antwort von `POST /me/selfhost/verbinden/entscheidung`. */
export interface VerbindenErgebnis {
  status: string;
  hostname?: string;
  instance_id?: string;
}

export function holeVerbindung(code: string): Promise<Verbindung> {
  return cookieFetch<Verbindung>('/me/selfhost/verbinden/vorgang', {
    method: 'POST',
    body: { code }
  });
}

export function entscheideVerbindung(
  code: string,
  aktion: 'verbinden' | 'ablehnen'
): Promise<VerbindenErgebnis> {
  return cookieFetch<VerbindenErgebnis>('/me/selfhost/verbinden/entscheidung', {
    method: 'POST',
    body: { code, aktion }
  });
}
```

- [ ] **Step 6: Unit-Tests laufen lassen.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit && pnpm check`
Expected: PASS (der Deckungstest findet die Schlüssel aus Step 4), 0 Fehler.

- [ ] **Step 7: Zwischen-Commit (Rechnung, API, Texte).** `code-simplifier` über `fehler.ts`, `api/verbinden.ts`, dann:

```bash
cd /home/michael/Dokumente/pulse && bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/verbinden/fehler.ts web/test/verbinden-fehler.test.ts \
  web/src/lib/api/verbinden.ts web/messages/de.json web/messages/en.json
git commit -m "feat(web): Fehlerdeutung, API und Texte der Bestätigungsseite

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Playwright-Test schreiben.** `web/tests/e2e/verbinden.spec.ts`:

```ts
/**
 * Bestätigungsseite /verbinden (Spec 2026-10-09-selfhost-ohne-freigabe-design.md,
 * E5). Die Cloud-Antworten sind vorgetäuscht: der echte Weg verlangt einen
 * Server, der unter seiner Adresse den Nachweis ausliefert (E2) — den gibt es
 * im Testaufbau nicht. Geprüft wird die Seite: Rückweg über Registrieren und
 * Anmelden, Eingabe von Hand, vorausgewähltes Abbrechen, jeder Zustand und
 * jeder Fehlergrund.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const ts = Date.now();
const NAME = `verb_${ts}`;
const PW = 'verbinden-secret-pass';
const HOST = 'chat.dcc-test.example.com';
const CODE = 'K7QM-2XDP';

type Antwort = { status: number; body: unknown };

const VORGANG = '**/api/auth/me/selfhost/verbinden/vorgang';
const ENTSCHEIDUNG = '**/api/auth/me/selfhost/verbinden/entscheidung';

/** Täuscht die beiden Routen der Cloud vor; liefert die gesendeten Aktionen.
 *  Prüft nebenbei, dass der Code im Körper reist und nie im Pfad steht
 *  (Vertrag, Nachtrag 2 — Pfade landen in Zugriffsprotokollen). */
async function cloudVortaeuschen(
  ctx: BrowserContext,
  antworten: { holen?: Antwort; entscheiden?: Antwort } = {}
): Promise<string[]> {
  const aktionen: string[] = [];
  await ctx.unroute(VORGANG);
  await ctx.unroute(ENTSCHEIDUNG);
  await ctx.route(VORGANG, async (route) => {
    const { code } = route.request().postDataJSON() as { code: string };
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const a = antworten.holen ?? {
      status: 200,
      body: { hostname: HOST, gueltig_bis: new Date(Date.now() + 600_000).toISOString() }
    };
    return route.fulfill({ status: a.status, json: a.body });
  });
  await ctx.route(ENTSCHEIDUNG, async (route) => {
    const { code, aktion } = route.request().postDataJSON() as { code: string; aktion: string };
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    aktionen.push(aktion);
    const a =
      antworten.entscheiden ??
      (aktion === 'verbinden'
        ? {
            status: 200,
            body: { status: 'verbunden', hostname: HOST, instance_id: '7300000000000000099' }
          }
        : { status: 200, body: { status: 'abgelehnt' } });
    return route.fulfill({ status: a.status, json: a.body });
  });
  return aktionen;
}

const karte = (page: Page, zustand: string) =>
  page.locator(`[data-testid=verbinden-karte][data-zustand=${zustand}]`);

test.describe.serial('Bestätigungsseite /verbinden', () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // Ein Service Worker kann Anfragen bedienen, die Playwright-Routen dann nicht sehen.
    ctx = await browser.newContext({ serviceWorkers: 'block' });
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  test('abgemeldet: Konto erstellen führt zur Frage zurück', async () => {
    const aktionen = await cloudVortaeuschen(ctx);
    await page.goto(`/verbinden#${CODE}`);
    await expect(karte(page, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('verbinden-code')).toHaveText(CODE);

    await page.getByTestId('verbinden-registrieren').click();
    await page.waitForURL(/\/register/);
    await page.getByTestId('reg-username').fill(NAME);
    await page.getByTestId('reg-email').fill(`${NAME}@dcc-test.example.com`);
    await page.getByTestId('reg-password').fill(PW);
    await page.getByTestId('reg-submit').click();
    // Registrieren endet auf /app; die Startseite löst den gemerkten Code ein.
    await page.waitForURL((u) => u.pathname === '/verbinden' && u.hash === `#${CODE}`, {
      timeout: 20_000
    });

    await expect(karte(page, 'bereit')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('verbinden-host')).toHaveText(HOST);
    await expect(page.getByTestId('verbinden-code')).toHaveText(CODE);
    await expect(page.getByTestId('verbinden-warnung')).toBeVisible();
    // Schutz gegen untergeschobene Links (E5): Abbrechen ist vorausgewählt.
    await expect(page.getByTestId('verbinden-abbrechen')).toBeFocused();

    await page.getByTestId('verbinden-bestaetigen').click();
    await expect(karte(page, 'verbunden')).toBeVisible();
    expect(aktionen).toEqual(['verbinden']);
  });

  test('von Hand eingetippt; Enter auf dem vorausgewählten Knopf lehnt ab', async () => {
    const aktionen = await cloudVortaeuschen(ctx);
    await page.goto('/verbinden');
    await expect(karte(page, 'eingabe')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('verbinden-code-eingabe').fill('abc');
    await page.getByTestId('verbinden-code-weiter').click();
    await expect(page.getByTestId('verbinden-hinweis')).toHaveAttribute('data-fehler', 'eingabe');
    await expect(karte(page, 'eingabe')).toBeVisible();

    await page.getByTestId('verbinden-code-eingabe').fill('k7qm 2xdp');
    await page.getByTestId('verbinden-code-weiter').click();
    await expect(page).toHaveURL(new RegExp(`/verbinden#${CODE}$`));
    await expect(karte(page, 'bereit')).toBeVisible();
    await expect(page.getByTestId('verbinden-abbrechen')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(karte(page, 'abgelehnt')).toBeVisible();
    expect(aktionen).toEqual(['ablehnen']);
  });

  test('unbekannter oder verbrauchter Code', async () => {
    await cloudVortaeuschen(ctx, { holen: { status: 404, body: { detail: 'unbekannt' } } });
    await page.goto('/verbinden#ZZZZ-ZZZZ');
    await expect(karte(page, 'unbekannt')).toBeVisible({ timeout: 15_000 });
  });

  test('Fehler beim Bestätigen: der Grund steht da, die Frage bleibt', async () => {
    const faelle: { code: string; antwort: Antwort; art: string }[] = [
      {
        code: 'A1B2-C3D4',
        antwort: {
          status: 409,
          body: { detail: { code: 'nachweis_fehlt', befund: 'zertifikat' } }
        },
        art: 'nachweis_fehlt'
      },
      {
        code: 'A1B2-C3D5',
        antwort: { status: 409, body: { detail: 'zu_viele_server' } },
        art: 'zu_viele_server'
      },
      {
        code: 'A1B2-C3D6',
        antwort: { status: 403, body: { detail: 'verbinden_gesperrt' } },
        art: 'verbinden_gesperrt'
      }
    ];
    for (const fall of faelle) {
      await cloudVortaeuschen(ctx, { entscheiden: fall.antwort });
      await page.goto(`/verbinden#${fall.code}`);
      // Erst der neue Code, dann der Zustand — sonst träfe der Klick noch die
      // Karte des vorigen Falls.
      await expect(page.getByTestId('verbinden-code')).toHaveText(fall.code, { timeout: 15_000 });
      await expect(karte(page, 'bereit')).toBeVisible();
      await page.getByTestId('verbinden-bestaetigen').click();
      await expect(page.getByTestId('verbinden-hinweis')).toHaveAttribute('data-fehler', fall.art);
      await expect(karte(page, 'bereit')).toBeVisible();
    }
  });

  test('abgemeldet: Anmelden führt zurück, der Code reist nicht über die Adresse', async ({
    browser
  }) => {
    const zweiter = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await cloudVortaeuschen(zweiter);
      const p = await zweiter.newPage();
      await p.goto(`/verbinden#${CODE}`);
      await expect(karte(p, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
      await p.getByTestId('verbinden-anmelden').click();
      await p.waitForURL(/\/login\?redirect=%2Fverbinden$/);
      // Die Anmeldeseite fordert der Browser beim Server an (Spec E5).
      expect(p.url()).not.toContain('K7QM');
      await p.getByTestId('login-identifier').fill(NAME);
      await p.getByTestId('login-password').fill(PW);
      await p.getByTestId('login-submit').click();
      await p.waitForURL((u) => u.pathname === '/verbinden', { timeout: 20_000 });
      await expect(karte(p, 'bereit')).toBeVisible({ timeout: 15_000 });
      await expect(p.getByTestId('verbinden-code')).toHaveText(CODE);
    } finally {
      await zweiter.close();
    }
  });
});
```

- [ ] **Step 9: Test laufen lassen, er muss scheitern.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm exec playwright test tests/e2e/verbinden.spec.ts`
Expected: FAIL — die Route `/verbinden` gibt es noch nicht (`verbinden-karte` nicht gefunden).

- [ ] **Step 10: `web/src/lib/verbinden/VerbindenKarte.svelte` anlegen.**

```svelte
<!--
  Inhalt der Bestätigungsseite `/verbinden` (Spec 2026-10-09, E5) — rein
  darstellend: Zustand, Daten und Aktionen kommen als Props aus der Route, die
  Ladelogik steht dort. Muster: `lib/einladung/EinladungKarte.svelte`.

  „bereit“ ist eine FRAGE, keine Bitte, und „Abbrechen“ ist vorausgewählt
  (E5, Schutz gegen untergeschobene Links): Wer einem anderen den Link seines
  eigenen Vorgangs schickt, soll an einem reflexhaften Klick oder Enter
  scheitern. Adresse und Code stehen groß da — der Code ist der einzige
  Beleg, dass dieser Link zu dem Server gehört, den man gerade installiert.
-->
<script lang="ts" module>
  export type VerbindenZustand =
    | 'laden'
    | 'eingabe'
    | 'abgemeldet'
    | 'bereit'
    | 'verbunden'
    | 'abgelehnt'
    | 'unbekannt'
    | 'fehler';
</script>

<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import ServerIcon from '@lucide/svelte/icons/server';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import CircleXIcon from '@lucide/svelte/icons/circle-x';
  import LinkOffIcon from '@lucide/svelte/icons/unlink';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
  import { m } from '$lib/paraglide/messages.js';

  let {
    zustand,
    code = null,
    hostname = null,
    konto = '',
    hinweis = null,
    fehlerArt = null,
    busy = false,
    onCode,
    onAnmelden,
    onRegistrieren,
    onVerbinden,
    onAbbrechen,
    onErneut,
    onZuPulse
  }: {
    zustand: VerbindenZustand;
    code?: string | null;
    hostname?: string | null;
    /** Benutzername des angemeldeten Kontos — wer bestätigt, wird Besitzer. */
    konto?: string;
    hinweis?: string | null;
    /** Maschinenlesbarer Grund zum Hinweis (`data-fehler`, für Tests). */
    fehlerArt?: string | null;
    busy?: boolean;
    onCode?: (roh: string) => void;
    onAnmelden?: () => void;
    onRegistrieren?: () => void;
    onVerbinden?: () => void;
    onAbbrechen?: () => void;
    onErneut?: () => void;
    onZuPulse?: () => void;
  } = $props();

  let eingabe = $state('');

  // Ausdrücklich per focus() statt `autofocus`: Svelte meldet das Attribut als
  // a11y-Warnung (Muster `DropboxCreateFolderDialog.svelte`). Läuft, sobald die
  // Frage erscheint und der Knopf steht.
  let abbrechenKnopf = $state<HTMLElement | null>(null);
  $effect(() => {
    if (zustand === 'bereit') abbrechenKnopf?.focus();
  });

  const abschluss = $derived(
    zustand === 'verbunden'
      ? {
          titel: m.verbinden_fertig_titel(),
          text: m.verbinden_fertig_text(),
          Symbol: CircleCheckIcon,
          ton: 'bg-success/15 text-success'
        }
      : zustand === 'abgelehnt'
        ? {
            titel: m.verbinden_abgelehnt_titel(),
            text: m.verbinden_abgelehnt_text(),
            Symbol: CircleXIcon,
            ton: 'bg-bg-hover text-text-muted'
          }
        : zustand === 'unbekannt'
          ? {
              titel: m.verbinden_unbekannt_titel(),
              text: m.verbinden_unbekannt_text(),
              Symbol: LinkOffIcon,
              ton: 'bg-bg-hover text-text-muted'
            }
          : null
  );

  const titel = $derived(
    zustand === 'bereit'
      ? m.verbinden_frage_titel()
      : zustand === 'fehler'
        ? m.verbinden_fehler_titel()
        : m.verbinden_titel()
  );
</script>

<div
  class="bg-card border-border/60 flex w-full max-w-md flex-col items-center gap-6 rounded-xl border p-8 text-center shadow-2xl"
  data-testid="verbinden-karte"
  data-zustand={zustand}
>
  {#if zustand === 'laden'}
    <div class="bg-bg-hover size-16 animate-pulse rounded-full"></div>
    <div class="flex w-full flex-col items-center gap-2">
      <div class="bg-bg-hover h-6 w-48 animate-pulse rounded"></div>
      <div class="bg-bg-hover h-4 w-32 animate-pulse rounded"></div>
    </div>
    <div class="bg-bg-hover h-9 w-full animate-pulse rounded-md"></div>
  {:else if abschluss}
    {@const Symbol = abschluss.Symbol}
    <div class="flex size-16 items-center justify-center rounded-full {abschluss.ton}">
      <Symbol class="size-7" />
    </div>
    <div class="flex flex-col gap-2">
      <h1 class="text-card-foreground text-xl font-semibold">{abschluss.titel}</h1>
      <p class="text-muted-foreground text-sm">{abschluss.text}</p>
    </div>
    <Button variant="outline" class="w-full" onclick={onZuPulse} data-testid="verbinden-zu-pulse">
      {m.verbinden_zu_pulse()}
    </Button>
  {:else}
    <div class="bg-primary/15 text-primary flex size-16 items-center justify-center rounded-full">
      <ServerIcon class="size-7" />
    </div>
    <h1 class="text-card-foreground text-xl font-semibold">{titel}</h1>

    {#if zustand === 'eingabe'}
      <p class="text-muted-foreground text-sm">{m.verbinden_eingabe_text()}</p>
      <form
        class="flex w-full flex-col gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          onCode?.(eingabe);
        }}
      >
        <Input
          bind:value={eingabe}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck={false}
          placeholder={m.verbinden_eingabe_platzhalter()}
          aria-label={m.verbinden_code_label()}
          class="text-center font-mono text-lg tracking-widest"
          data-testid="verbinden-code-eingabe"
        />
        <Button type="submit" class="w-full" data-testid="verbinden-code-weiter">
          {m.verbinden_eingabe_weiter()}
        </Button>
      </form>
    {:else}
      {#if hostname}
        <p class="text-text-bright break-all text-lg font-semibold" data-testid="verbinden-host">
          {hostname}
        </p>
      {/if}
      {#if code}
        <p
          class="bg-bg-input border-border rounded-lg border px-4 py-2 font-mono text-2xl font-bold tracking-widest"
          data-testid="verbinden-code"
        >
          {code}
        </p>
      {/if}

      {#if zustand === 'bereit'}
        <div class="flex flex-col gap-2">
          <p class="text-muted-foreground text-sm">{m.verbinden_code_konsole()}</p>
          <p
            class="text-warning flex items-start justify-center gap-1.5 text-sm font-medium"
            data-testid="verbinden-warnung"
          >
            <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
            {m.verbinden_warnung()}
          </p>
        </div>
        <!-- Abbrechen oben und gefüllt: der sichere Weg ist der naheliegende. -->
        <div class="flex w-full flex-col gap-2">
          <Button
            bind:ref={abbrechenKnopf}
            class="w-full"
            onclick={onAbbrechen}
            disabled={busy}
            data-testid="verbinden-abbrechen"
          >
            {m.verbinden_abbrechen()}
          </Button>
          <Button
            variant="outline"
            class="w-full"
            onclick={onVerbinden}
            disabled={busy}
            data-testid="verbinden-bestaetigen"
          >
            {busy ? m.verbinden_ja_laeuft() : m.verbinden_ja()}
          </Button>
        </div>
        {#if konto}
          <p class="text-muted-foreground text-xs">{m.verbinden_angemeldet_als({ konto })}</p>
        {/if}
      {:else if zustand === 'abgemeldet'}
        <p class="text-muted-foreground text-sm">{m.verbinden_abgemeldet_text()}</p>
        <div class="flex w-full flex-col gap-2">
          <Button class="w-full" onclick={onAnmelden} data-testid="verbinden-anmelden">
            {m.verbinden_anmelden()}
          </Button>
          <Button
            variant="outline"
            class="w-full"
            onclick={onRegistrieren}
            data-testid="verbinden-registrieren"
          >
            {m.verbinden_registrieren()}
          </Button>
        </div>
      {:else}
        <div class="flex w-full flex-col gap-2">
          <Button class="w-full" onclick={onErneut} data-testid="verbinden-erneut">
            {m.verbinden_erneut()}
          </Button>
          <Button variant="outline" class="w-full" onclick={onZuPulse} data-testid="verbinden-zu-pulse">
            {m.verbinden_zu_pulse()}
          </Button>
        </div>
      {/if}
    {/if}
  {/if}

  {#if hinweis}
    <p class="text-destructive text-sm" role="alert" data-testid="verbinden-hinweis" data-fehler={fehlerArt}>
      {hinweis}
    </p>
  {/if}
</div>
```

- [ ] **Step 11: Route `web/src/routes/verbinden/+page.svelte` anlegen.**

```svelte
<!--
  /verbinden#XXXX-XXXX — Bestätigung, dass ein gerade installierter Server
  diesem Konto gehören soll (Spec docs/superpowers/specs/
  2026-10-09-selfhost-ohne-freigabe-design.md, E1/E5). `pulse-connect` im
  Container zeigt Link und Code; „Ja, das ist mein Server“ trägt den Server
  auf dieses Konto ein, „Abbrechen“ lehnt den Vorgang ab (die Konsole meldet
  beides von selbst).

  Steht AUSSERHALB von /app (wie /invite/<code>): wer abgemeldet ist, soll die
  Frage sehen, statt von der Anmelde-Wache weggeschickt zu werden.

  Der Code steht hinter `#` und reist nie in einer Adresse, die der Browser
  beim Server anfordert (E5). Deshalb führt „Anmelden“ nach
  `/login?redirect=/verbinden` OHNE Code; der wartet im Speicher
  (lib/verbinden/gemerkt.ts). Registrieren endet auf /app — dort löst die
  Startseite den gemerkten Code ein (routes/app/+page.svelte).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { serversStore } from '$lib/api/servers.svelte';
  import { ApiError } from '$lib/api/client';
  import { entscheideVerbindung, holeVerbindung } from '$lib/api/verbinden';
  import AuthBuehne from '$lib/components/AuthBuehne.svelte';
  import VerbindenKarte, { type VerbindenZustand } from '$lib/verbinden/VerbindenKarte.svelte';
  import { codeAusHash, codeNormalisieren } from '$lib/verbinden/code';
  import {
    gemerkteVerbindung,
    gemerkteVerbindungVerwerfen,
    verbindungMerken
  } from '$lib/verbinden/gemerkt';
  import { meldungsSchluessel, verbindenFehler } from '$lib/verbinden/fehler';
  import { browserSpeicher } from '$lib/einladung/gemerkt';
  import { m } from '$lib/paraglide/messages.js';

  const ausAdresse = $derived(codeAusHash(page.url.hash));
  const konto = $derived(auth.user?.username ?? '');

  let zustand = $state<VerbindenZustand>('laden');
  let code = $state<string | null>(null);
  let hostname = $state<string | null>(null);
  let hinweis = $state<string | null>(null);
  let fehlerArt = $state<string | null>(null);
  let busy = $state(false);
  // Gegen überholte Antworten, wenn der Code wechselt (Eingabe, neuer Link).
  let lauf = 0;

  function hinweisSetzen(art: string | null, text: string | null): void {
    fehlerArt = art;
    hinweis = text;
  }

  function fehlerZeigen(err: unknown): void {
    const f =
      err instanceof ApiError ? verbindenFehler(err.status, err.body) : verbindenFehler(null, null);
    if (f.art === 'unbekannt' || f.art === 'abgemeldet') {
      zustand = f.art;
      return;
    }
    const schluessel = meldungsSchluessel(f);
    const katalog = m as unknown as Record<string, (() => string) | undefined>;
    hinweisSetzen(f.art, (schluessel && katalog[schluessel]?.()) || m.verbinden_fehler_sonst());
    // Beim Bestätigen bleibt die Frage stehen: nach einem behobenen Proxy oder
    // einem gelöschten Server genügt ein zweiter Klick. Beim Laden gibt es
    // noch nichts zu bestätigen.
    if (zustand !== 'bereit') zustand = 'fehler';
  }

  async function laden(ausDerAdresse: string | null): Promise<void> {
    const meiner = ++lauf;
    zustand = 'laden';
    hostname = null;
    hinweisSetzen(null, null);
    // Auth wird nur im /app-Layout hydriert; diese Route liegt außerhalb.
    await auth.hydrate().catch(() => {});
    if (meiner !== lauf) return;
    let c = ausDerAdresse;
    if (!c && auth.user) {
      // Rückweg über die Anmeldung: der Code wartet im Speicher. Einmal
      // gelesen, gehört er dieser Seite — ein Abbruch soll ihn nicht später
      // auf /app wieder hervorholen.
      const speicher = browserSpeicher();
      c = gemerkteVerbindung(speicher, Date.now());
      gemerkteVerbindungVerwerfen(speicher);
    }
    code = c;
    if (!c) {
      zustand = 'eingabe';
      return;
    }
    if (!auth.user) {
      zustand = 'abgemeldet';
      return;
    }
    try {
      const v = await holeVerbindung(c);
      if (meiner !== lauf) return;
      hostname = v.hostname;
      zustand = 'bereit';
    } catch (err) {
      if (meiner !== lauf) return;
      fehlerZeigen(err);
    }
  }

  $effect(() => {
    const c = ausAdresse;
    untrack(() => void laden(c));
  });

  function codeEingegeben(roh: string): void {
    const c = codeNormalisieren(roh);
    if (!c) {
      hinweisSetzen('eingabe', m.verbinden_eingabe_ungueltig());
      return;
    }
    // Über die Adresse statt direkt laden: ein Neuladen behält den Code, und
    // ein Wechsel hinter `#` bleibt im Browser.
    void goto(`/verbinden#${c}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  function merkenUndWeiter(ziel: string): void {
    if (code) verbindungMerken(browserSpeicher(), code, Date.now());
    void goto(ziel);
  }

  async function entscheiden(aktion: 'verbinden' | 'ablehnen'): Promise<void> {
    if (!code || busy) return;
    busy = true;
    hinweisSetzen(null, null);
    try {
      const r = await entscheideVerbindung(code, aktion);
      zustand = r.status === 'verbunden' ? 'verbunden' : 'abgelehnt';
      if (zustand === 'verbunden') leisteSpaeterAbgleichen();
    } catch (err) {
      fehlerZeigen(err);
    } finally {
      busy = false;
    }
  }

  /** Der neue Server zählt für die Leiste erst als eingerichtet, wenn
   *  `pulse-connect` die Zugangsdaten abgeholt hat (Spec E3) — das geschieht im
   *  Abfrage-Abstand der Konsole (5 s) NACH diesem Klick; ein Abgleich jetzt
   *  sähe ihn noch nicht. Einmalig und ohne Abbau beim Verlassen: der Store ist
   *  app-weit, und wer sofort „Zu Pulse“ klickt, soll den Server trotzdem
   *  bekommen. */
  function leisteSpaeterAbgleichen(): void {
    setTimeout(() => void serversStore.hydrateFromBackend(), 8000);
  }
</script>

<svelte:head>
  <title>{m.verbinden_seitentitel()}</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
  <AuthBuehne />
  <VerbindenKarte
    {zustand}
    {code}
    {hostname}
    {konto}
    {hinweis}
    {fehlerArt}
    {busy}
    onCode={codeEingegeben}
    onAnmelden={() => merkenUndWeiter('/login?redirect=%2Fverbinden')}
    onRegistrieren={() => merkenUndWeiter('/register')}
    onVerbinden={() => entscheiden('verbinden')}
    onAbbrechen={() => entscheiden('ablehnen')}
    onErneut={() => laden(code)}
    onZuPulse={() => goto('/app')}
  />
</div>
```

- [ ] **Step 12: Rückweg auf der Startseite `/app`.** `web/src/routes/app/+page.svelte` — nach Zeile 24 (`import { viewport } …`) zwei Importe:

```ts
  import { browserSpeicher } from '$lib/einladung/gemerkt';
  import { gemerkteVerbindung, gemerkteVerbindungVerwerfen } from '$lib/verbinden/gemerkt';
```

Im `onMount` (Zeile 57) den `?add=`-Block (Zeilen 61–66) stehen lassen und **direkt danach** einfügen:

```ts
    // Rückweg der Server-Bestätigung (lib/verbinden/gemerkt.ts): Registrieren
    // und E-Mail-Bestätigung enden beide hier auf /app; die Anmeldung springt
    // über `?redirect=/verbinden` direkt hin. Hier statt im Layout, weil diese
    // Seite ohnehin die Startweiterleitung (/app/friends) vornimmt — zwei
    // Weiterleitungen aus zwei Komponenten liefen um die Wette. Sie läuft erst,
    // wenn das Layout fertig hydriert ist (Anmeldung und E-Mail-Riegel geprüft).
    const verbindenCode = gemerkteVerbindung(browserSpeicher(), Date.now());
    if (verbindenCode) {
      gemerkteVerbindungVerwerfen(browserSpeicher());
      void goto(`/verbinden#${verbindenCode}`, { replaceState: true });
      return;
    }
```

- [ ] **Step 13: Abmelden räumt den gemerkten Code.** `web/src/lib/stores/auth.svelte.ts` Zeile 5 nach dem Einladungs-Import:

```ts
import { browserSpeicher, gemerkteEinladungVerwerfen } from '$lib/einladung/gemerkt';
import { gemerkteVerbindungVerwerfen } from '$lib/verbinden/gemerkt';
```

Zeilen 412–415 alt:

```ts
    // Gemerkte Einladung (lib/einladung/gemerkt.ts) — auf einem gemeinsam
    // genutzten Rechner soll der nächste Nutzer nicht die Einladung des
    // vorigen vorgesetzt bekommen.
    gemerkteEinladungVerwerfen(browserSpeicher());
```

neu:

```ts
    // Gemerkte Einladung und gemerkter Verbindungs-Code (lib/einladung/
    // gemerkt.ts, lib/verbinden/gemerkt.ts) — auf einem gemeinsam genutzten
    // Rechner soll der nächste Nutzer weder die Einladung noch den Server des
    // vorigen vorgesetzt bekommen.
    gemerkteEinladungVerwerfen(browserSpeicher());
    gemerkteVerbindungVerwerfen(browserSpeicher());
```

- [ ] **Step 14: Prüfen.**

```bash
cd /home/michael/Dokumente/pulse/web && wc -l src/lib/verbinden/VerbindenKarte.svelte src/routes/verbinden/+page.svelte \
  && pnpm check && pnpm build && pnpm test:unit && cd .. && bash scripts/geraete-trennung.sh
cd /home/michael/Dokumente/pulse/web && pnpm exec playwright test tests/e2e/verbinden.spec.ts
```
Expected: beide Svelte-Dateien ≤ 250 Zeilen (Karte etwa 230, Seite etwa 190), 0 Fehler, Bau grün, Unit grün, Geräte-Trennung „✓ keine“ in allen Abschnitten, 5 Playwright-Tests grün. Liegt die Karte über 250, den `{#if zustand === 'bereit'}`-Block als `web/src/lib/verbinden/VerbindenFrage.svelte` (Props `busy`, `konto`, `onVerbinden`, `onAbbrechen`, Fokus-Effekt mitnehmen) herausziehen.

Falls der Test „von Hand eingetippt“ an `toHaveURL(…#K7QM-2XDP)` vorbeiläuft, aber die Karte in `eingabe` stehen bleibt, aktualisiert SvelteKit `page.url.hash` bei `goto` mit gleichem Pfad nicht: dann in `codeEingegeben` nach dem `goto` zusätzlich `void laden(c)` aufrufen (der `lauf`-Zähler verwirft den doppelten Lauf). Nachgelesen in `node_modules/@sveltejs/kit/src/runtime/client/client.js`: Hash-Wechsel über die Adresse laufen über `popstate` → `update_url`, `goto` über `navigate` — beide setzen `page.url`; der Hinweis ist nur die Rückfallebene.

- [ ] **Step 15: Im echten Browser ansehen** (Gedächtnis „Frontend ohne Browser-Test = Lücke“). Lokalen Stack starten (`scripts/dev-up.fish`), `http://127.0.0.1:5173/verbinden` öffnen: Eingabefeld erscheint; einen erfundenen Code tippen → „Dieser Code gilt nicht mehr“ (echte Cloud-Route aus Etappe 1 antwortet 404). Abgemeldet in einem privaten Fenster `…/verbinden#K7QM-2XDP` → Anmelden/Konto erstellen. Die Zustände mit echtem Server prüft Etappe 4.

- [ ] **Step 16: Vereinfachen, committen.** `code-simplifier` über die neuen und geänderten Dateien dieses Tasks, Step 14 erneut grün, dann:

```bash
cd /home/michael/Dokumente/pulse && bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/verbinden/VerbindenKarte.svelte web/src/routes/verbinden/+page.svelte \
  web/src/routes/app/+page.svelte web/src/lib/stores/auth.svelte.ts \
  web/tests/e2e/verbinden.spec.ts
git commit -m "feat(web): Bestätigungsseite /verbinden mit Rückweg über die Anmeldung

Die Seite fragt, ob man gerade selbst einen Server installiert; Abbrechen
ist vorausgewählt. Der Code reist nie in einer Adresse zum Server.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.3: Fehlertext für `nicht_verbunden`

**Files:**
- Modify: `web/src/lib/api/anmelde-fehler-codes.ts:28` und `:57`
- Modify: `web/test/anmeldefehler.test.ts:1-7` (Import), `:20-40` (Codeliste), Ende (neuer Test)
- Modify: `web/messages/de.json`, `web/messages/en.json` (Ende)

**Interfaces:**
- Consumes: `POST /session` → 503 `{"detail": "nicht_verbunden"}` (Etappe 2, `routes/session_ticket.py`); `TicketFehler` liest `detail` nur, wenn `istAblehnungscode` zustimmt (`web/src/lib/api/server-ticket.ts:133-140`).
- Produces: `Ablehnungscode` um `'nicht_verbunden'` erweitert; Schlüssel `anmeldung_server_nicht_verbunden`. Angezeigt über `anmeldeFehlerText` (`add-server-flow.ts:192`, Beitrittsfeld) und `meldungFuer` (`anmelde-fehler.ts:65`, laufender Betrieb) — ohne weitere Änderung.

- [ ] **Step 1: Test erweitern.** In `web/test/anmeldefehler.test.ts` den Import ergänzen:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ABLEHNUNGSCODES,
  MELDUNGSSCHLUESSEL,
  istAblehnungscode,
} from '../src/lib/api/anmelde-fehler-codes.ts';
```

Im Test „die Codeliste deckt ab, was der Server tatsaechlich antwortet“ (Zeilen 20–40) den Quellen-Kommentar und die Liste erweitern — alt:

```ts
  // Quelle: ticket_pruefung.py (ticket_*, jwks_cold), gates.py (join_*,
  // "instance banned"), suspend_poller.py (instance_suspended/-deleted).
```

neu:

```ts
  // Quelle: ticket_pruefung.py (ticket_*, jwks_cold), gates.py (join_*,
  // "instance banned"), suspend_poller.py (instance_suspended/-deleted),
  // session_ticket.py (nicht_verbunden: Self-Host ohne Verbindung, seit 2026-10).
```

und in der Liste nach `'instance_deleted',` die Zeile `'nicht_verbunden',` einfügen. Am Dateiende anfügen:

```ts
test('jeder Meldungsschluessel steht in beiden Katalogen', () => {
  // Ein Schlüssel ohne Text liefe in `anmeldeFehlerText` still auf die
  // Sammelmeldung — genau das, wogegen diese Datei gebaut ist.
  for (const sprache of ['de', 'en']) {
    const katalog = JSON.parse(
      readFileSync(new URL(`../messages/${sprache}.json`, import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    for (const c of ABLEHNUNGSCODES) {
      assert.equal(typeof katalog[MELDUNGSSCHLUESSEL[c]], 'string', `${sprache}: ${c}`);
    }
  }
});
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit`
Expected: FAIL — `nicht_verbunden fehlt in der Liste`.

- [ ] **Step 3: Code eintragen.** `web/src/lib/api/anmelde-fehler-codes.ts` — nach Zeile 28 (`'instance_id_unconfigured',`):

```ts
  // Self-Host läuft, ist aber noch mit keinem Konto verbunden (`pulse-connect`
  // nicht gelaufen). Löst `instance_id_unconfigured` für neue Server ab; der
  // alte Code bleibt für Server mit älterem Stand.
  'nicht_verbunden',
```

Nach Zeile 57 (`instance_id_unconfigured: 'anmeldung_server_ohne_kennung',`):

```ts
  nicht_verbunden: 'anmeldung_server_nicht_verbunden',
```

- [ ] **Step 4: Texte.** `web/messages/de.json` (Ende):

```json
  "anmeldung_server_nicht_verbunden": "Dieser Server ist noch mit keinem Pulse-Konto verbunden und nimmt deshalb niemanden auf. Der Betreiber muss auf dem Server „docker exec -it pulse pulse-connect“ ausführen."
```

`web/messages/en.json` (Ende):

```json
  "anmeldung_server_nicht_verbunden": "This server is not connected to a Pulse account yet, so it does not let anyone in. Its operator needs to run “docker exec -it pulse pulse-connect” on the server."
```

- [ ] **Step 5: Prüfen.**

```bash
cd /home/michael/Dokumente/pulse/web && pnpm check && pnpm test:unit
```
Expected: 0 Fehler, alle Unit-Tests grün (der neue Katalog-Test deckt auch die 15 bestehenden Codes; sie sind heute vollständig, nachgeprüft am 2026-10-10).

- [ ] **Step 6: Vereinfachen, committen.**

```bash
cd /home/michael/Dokumente/pulse && bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/api/anmelde-fehler-codes.ts web/test/anmeldefehler.test.ts \
  web/messages/de.json web/messages/en.json
git commit -m "feat(web): eigener Text für einen Server ohne Verbindung (nicht_verbunden)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.4: Landen

- [ ] **Step 1: Volles Gate.**

Run: `cd /home/michael/Dokumente/pulse && bash scripts/gate.sh`
Expected: grün (Web: check, build, Unit, Geräte-Trennung). Playwright läuft in keinem Gate — die neue Datei ist in Task 3.2 Step 14 gelaufen.

- [ ] **Step 2: Kein Changelog.** Ohne Installer (Etappe 4) erreicht niemand die Seite. `scripts/check-changelog.sh` warnt nur.

- [ ] **Step 3: Landen nach ausdrücklicher Freigabe des Eigentümers** (Landen = Prod-Deploy):

```bash
cd /home/michael/Dokumente/pulse && bash scripts/ship.sh
```

- [ ] **Step 4: Nach dem Deploy prüfen.**

Run: `curl -s -o /dev/null -w "%{http_code}\n" https://howispulse.com/verbinden`
Expected: `200` (SPA-Rückfall in `infra/prod/web-nginx.conf`, `location /`). Im Browser `https://howispulse.com/verbinden` → Eingabefeld.

---

---

## Etappe 4 — Vordertür: Installer, Compose, öffentliches Paket

Danach installiert jeder mit `curl -fsSL https://howispulse.com/install | bash` oder einer Compose-Datei ohne Antrag und ohne Zugangsdaten, und der Installer verbindet den Server am Ende per `pulse-connect` mit dem Pulse-Konto des Betreibers.

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/selfhost-vordertuer`

**Voraussetzung für das Landen (nicht für das Bauen):** Etappen 0–3 sind live — das Bild `ghcr.io/oblivion-pictures/pulse:stable` entsteht (Etappe 0), die Cloud kennt `/selfhost/verbinden/*` (Etappe 1), das Bild bringt `pulse-connect`, die Nachweis-Route und `verbunden` in der Server-Info mit (Etappe 2), `https://howispulse.com/verbinden` steht (Etappe 3). Task 4.4 prüft das, bevor das Paket öffentlich wird.

**Kein Changelog-Eintrag.** `web/static/install.sh`, `infra/`, `docs/` stehen in `NON_USER_FACING` (`scripts/check-changelog.sh`, Zeile 27). Die neuen Testdateien unter `web/test/` stehen dort nicht (das Muster kennt nur `/tests/`) — `check-changelog.sh` druckt deshalb beim Push eine Warnung; sie hält nichts auf (`exit 0`). Für Nutzer sichtbar wird der neue Weg erst mit dem Einstieg in der App (Etappe 5, Teil C); dort gehört der Eintrag hin.

**Zur Größe:** `web/static/install.sh` ist eine einzige Datei, weil `curl … | bash` nichts nachladen kann. Sie hatte vorher 1374 Zeilen und hat danach 1591; die Größen-Policy (`PLAN.md` §12.1) greift bei diesem Skript wie bisher nicht.

**Zu den Ersetzungsblöcken in Etappe 4 und 6:** Sie sind aus einem Zeilenvergleich gegen den heutigen Stand (`docs/selfhost-ohne-freigabe` = `main` vom 2026-10-10) erzeugt; jede Datei mit solchen Blöcken wurde daraus nachgebaut und Zeile für Zeile mit dem Ziel verglichen, und auf dem Nachbau liefen die Installer-Tests (100 grün), die Fälle des Compose-Updaters und die auth- und shared-Suiten grün. Von Hand beschrieben (und nicht im Nachbau gelaufen) sind nur das Entfernen von `_allocate_worker_ids` (Task 6.1 Step 4, hängt an Etappe 1) und `CLAUDE.md`/Doku in Task 6.4; das Entfernen in `shared/` (Task 6.2) lief im Nachbau mit. Je Datei von unten nach oben anwenden, dann gelten die Zeilennummern. Wo sich Zeilen wiederholen (`},`, Leerzeilen, Dekoratoren), beginnt ein Block manchmal eine Zeile früher oder später, als man ihn von Hand schneiden würde — das Ergebnis ist dasselbe. Hat eine frühere Etappe dieselbe Datei verändert, sind die zitierten Zeilen der Anker, nicht die Nummern.

### Task 4.1: Installer ohne Token, mit Verbinden am Ende

**Files:**
- Modify: `web/static/install.sh` (17 Blöcke, Zeilen 5–1342 des heutigen Stands; Einzelheiten in Step 3)
- Create: `web/test/install-ohne-token.test.ts`, `web/test/install-bestand.test.ts`, `web/test/install-verbinden.test.ts`
- Modify: `web/test/install-anweisungen.test.ts:321-324,361-370,390-395`, `web/test/install-fremder-container.test.ts:51-57,257-371,426-449`, `web/test/install-overrides.test.ts:187-191`, `web/test/install-proxy-erkennung.test.ts:346-348`, `web/test/install-schluss-reihenfolge.test.ts:13-35,151,168,221,232-241`
- Delete: `web/test/install-jget.test.ts` (einziger Nutzer von `jget` war die Token-Einlösung)
- Modify: `infra/prod/web-nginx.conf:416` (Kommentar mit dem alten Befehl)

**Interfaces:**
- Consumes:
  - `docker exec -it <container> pulse-connect --no-restart` (Etappe 2, `verbinden_cli.py`): Exit 0 verbunden, 1 Fehler, 2 abgelehnt/abgelaufen, 3 von außen nicht erreichbar; liest das Terminal; gibt nie Secret oder Kennung aus.
  - `GET /.well-known/pulse-server-info` mit Feld `verbunden: bool` (Etappe 2) — im Container unter `http://127.0.0.1:8002/…` (chat-gateway direkt), von außen unter `https://<adresse>/…`.
  - `/data/pulse/verbindung.env` im Datenvolumen (Etappe 2): Zeilen `KEY=wert` für `PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID`, `PULSE_CLOUD_CLIENT_ID`, `PULSE_CLOUD_CLIENT_SECRET`, optional `PULSE_ADMIN_EMAIL`.
  - `POST ${CLOUD_ORIGIN}/api/auth/selfhost/diagnose/{instance_id}` mit `X-Pulse-Client-Id`, `X-Pulse-Client-Secret`, `X-Pulse-Container-Name` (unverändert, `routes_selfhost_diagnose.py`).
  - Bild `ghcr.io/oblivion-pictures/pulse:stable` (Etappe 0; öffentlich ab Task 4.4).
- Produces:
  - Aufruf ohne Token: `curl -fsSL https://howispulse.com/install | bash`; Adresse aus `PULSE_HOSTNAME`, erstem Argument oder Frage am Terminal; `PULSE_ADMIN_EMAIL` optional. Etappe 5 (Teil C) zeigt genau diesen Befehl im Dialog.
  - `pulse.env` nur mit `PULSE_HOSTNAME`, `PULSE_INSTANCE_MODE`, `PULSE_CLOUD_ORIGIN`, optional `PULSE_ADMIN_EMAIL`, `PULSE_TLS_MODE`, `PULSE_HTTP_PORT` — plus die Verbindungszeilen eines Bestandsservers derselben Adresse.
  - Meldung bei jedem Scheitern des Verbindens: `Connect later: docker exec -it <container> pulse-connect`, Exit 0.
  - Shell-Funktionen `frage_adresse`, `pruefe_adresse`, `zugang_lesen`, `bestand_uebernehmen`, `pruefe_registry_zugang`, `schreibe_konfiguration`, `warte_auf_start`, `server_info_innen`, `server_info_aussen`, `ist_verbunden`, `verbinden_spaeter`, `server_verbinden`, `zugang_aus_volumen`; Umgebungsvariablen `PULSE_TTY`, `PULSE_INSTALL_WARTE_VERSUCHE`, `PULSE_INSTALL_WARTE_INTERVALL` (nur für Tests gedacht).

Drei Entscheidungen, die über den Vertrag hinausgehen, und ihr Grund:

1. **Bestandsserver behalten ihre Verbindungszeilen in `pulse.env`.** Die zwei per Installer eingerichteten Bestands-VPS tragen `PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID` und die Zugangsdaten in ihrer `pulse.env` (`/opt/pulse/pulse.env` bei Installation als root, sonst `~/.pulse/pulse.env`), nicht im Volumen. Schriebe ein erneuter Lauf des neuen Installers die Datei ohne sie, stünde der Server unverbunden da; `pulse-connect` gäbe ihm dann eine neue Instanz-Nummer (Soft-Delete des alten Eintrags), und seine Mitglieder verlören ihn aus ihrer Server-Liste. Deshalb übernimmt `bestand_uebernehmen` diese Zeilen, wenn die alte Datei zu derselben Adresse gehört. Neuinstallationen bekommen keine Zugangsdaten in die Datei.
2. **„Schon verbunden?“ wird im Container gefragt, nicht über die eigene Adresse.** Ein Abruf über `https://<adresse>` scheitert in Netzen ohne Hairpin-NAT (Begründung in `pulse-doctor` §4); der Installer hielte den Server dann für unverbunden und riefe `pulse-connect`, das auf einem verbundenen Server nachfragt. Der Abruf von außen bleibt — als Auskunft für den Betreiber, nicht als Entscheidung.
3. **Die Prüfung aus der Cloud bleibt.** Sie ist das einzige Werkzeug, das WebSocket-Weiterleitung, UDP-Medienports, CORS und Betreiber-Erkennung von außen sieht; `pulse-doctor` sieht nur nach innen und verweist selbst auf diese Prüfung. Nach dem Verbinden liegen die Zugangsdaten im Volumen; der Installer liest sie per `docker exec … cat /data/pulse/verbindung.env` (Root auf dem Host hat er ohnehin) und reicht sie curl über stdin (`-K -`), nie über die Befehlszeile. Ein unverbundener Server überspringt die Prüfung (er hat keine Zugangsdaten).

- [ ] **Step 1: Drei neue Testdateien anlegen.**

`web/test/install-ohne-token.test.ts` — das echte Skript läuft im `--dry-run` von vorn bis zum Plan:

```ts
/**
 * `web/static/install.sh` ohne Token (seit Oktober 2026).
 *
 * Bis dahin brach der Installer ohne `PULSE_BOOTSTRAP_TOKEN` sofort ab. Jetzt
 * braucht er nur die Adresse des Servers — aus `PULSE_HOSTNAME`, dem ersten
 * Argument oder einer Frage am Terminal — und verbindet den Server am Ende
 * per `pulse-connect` (s. `install-verbinden.test.ts`).
 *
 * **Wie das geht:** Hier läuft das ECHTE Skript von vorn bis zum Plan, mit
 * `--dry-run` (verändert nichts) und gefälschtem `docker`/`ss` auf dem PATH:
 * `docker info` gelingt, kein Container existiert, kein Port ist belegt.
 * `PULSE_TTY` zeigt auf eine Datei mit vorbereiteter Eingabe oder auf einen
 * Pfad, den es nicht gibt (= kein Terminal) — so wartet kein Lauf auf ein
 * echtes Terminal.
 */

import { test as testAlle } from 'node:test';

// Die Tests führen web/static/install.sh unter bash aus (gefälschte Kommandos
// über einen PATH-Ordner). Unter Windows geht das nicht kaputt-frei; der
// Installer gehört auf Linux-Hosts, die Prüfungen laufen in der Linux-CI.
const test = process.platform === 'win32' ? testAlle.skip : testAlle;
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

interface Lauf {
  exit: number;
  ausgabe: string;
}

interface Optionen {
  env?: Record<string, string>;
  args?: string[];
  /** Inhalt des „Terminals"; `null` = es gibt keins. */
  eingabe?: string | null;
  /** Inhalt einer pulse.env aus einer früheren Installation. */
  alteKonfiguration?: string;
}

function lauf(optionen: Optionen = {}): Lauf {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-adresse-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
case "$1" in
  info|ps) exit 0 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'ss'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  chmodSync(join(bin, 'ss'), 0o755);

  const pulseDir = join(dir, 'pulse');
  if (optionen.alteKonfiguration !== undefined) {
    mkdirSync(pulseDir);
    writeFileSync(join(pulseDir, 'pulse.env'), optionen.alteKonfiguration, { mode: 0o600 });
  }
  let tty = join(dir, 'kein-terminal');
  if (optionen.eingabe != null) {
    tty = join(dir, 'terminal');
    writeFileSync(tty, optionen.eingabe);
  }

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    PULSE_DIR: pulseDir,
    PULSE_TTY: tty,
    ...(optionen.env ?? {})
  };
  try {
    const ausgabe = execFileSync('bash', [SKRIPT, '--dry-run', ...(optionen.args ?? [])], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { exit: 0, ausgabe };
  } catch (fehler) {
    const f = fehler as { status?: number; stdout?: string; stderr?: string };
    return { exit: f.status ?? 1, ausgabe: `${f.stdout ?? ''}${f.stderr ?? ''}` };
  }
}

test('ohne Token und mit PULSE_HOSTNAME läuft der Installer bis zum Plan', () => {
  const e = lauf({ env: { PULSE_HOSTNAME: 'chat.example.org' } });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /Server address: chat\.example\.org/);
  assert.match(e.ausgabe, /DRY RUN — nothing changed\./);
  assert.match(e.ausgabe, /ghcr\.io\/oblivion-pictures\/pulse:stable/);
  assert.doesNotMatch(e.ausgabe, /token/i);
});

test('die Adresse geht auch als erstes Argument', () => {
  const e = lauf({ args: ['chat.example.org'] });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /Server address: chat\.example\.org/);
});

test('ohne Adresse fragt der Installer am Terminal', () => {
  const e = lauf({ eingabe: 'Chat.Example.org\n' });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /Address of this server/);
  assert.match(e.ausgabe, /Server address: chat\.example\.org/);
});

test('ohne Adresse und ohne Terminal: klare Meldung statt Warten', () => {
  const e = lauf({ eingabe: null });
  assert.equal(e.exit, 1);
  assert.match(e.ausgabe, /No server address given/);
  assert.match(e.ausgabe, /PULSE_HOSTNAME=chat\.example\.org/);
});

test('die Adresse wird in die Form gebracht, die die Cloud einträgt', () => {
  for (const roh of ['https://Chat.Example.org:443/pfad', 'chat.example.org.', ' CHAT.example.org ']) {
    const e = lauf({ env: { PULSE_HOSTNAME: roh } });
    assert.equal(e.exit, 0, `${roh}: ${e.ausgabe}`);
    assert.match(e.ausgabe, /Server address: chat\.example\.org\n/, roh);
  }
});

test('ungültige Adressen werden abgewiesen, bevor etwas geschieht', () => {
  for (const roh of ['localhost', '203.0.113.7', 'chat_example.org', '-chat.example.org']) {
    const e = lauf({ env: { PULSE_HOSTNAME: roh } });
    assert.equal(e.exit, 1, roh);
    assert.match(e.ausgabe, /is not a valid server address/, roh);
    assert.doesNotMatch(e.ausgabe, /DRY RUN/, roh);
  }
});

test('ein alter Token-Befehl läuft weiter, der Token wird ignoriert und nicht ausgegeben', () => {
  const ueberEnv = lauf({
    env: { PULSE_HOSTNAME: 'chat.example.org', PULSE_BOOTSTRAP_TOKEN: 'plse_boot_geheimeswort' }
  });
  assert.equal(ueberEnv.exit, 0, ueberEnv.ausgabe);
  assert.match(ueberEnv.ausgabe, /Setup tokens are no longer needed/);
  assert.doesNotMatch(ueberEnv.ausgabe, /geheimeswort/);

  // Der alte Befehl `bash -s -- <TOKEN>`: das Argument ist KEINE Adresse.
  const alsArgument = lauf({
    env: { PULSE_HOSTNAME: 'chat.example.org' },
    args: ['plse_boot_geheimeswort']
  });
  assert.equal(alsArgument.exit, 0, alsArgument.ausgabe);
  assert.match(alsArgument.ausgabe, /Server address: chat\.example\.org/);
  assert.doesNotMatch(alsArgument.ausgabe, /geheimeswort/);
});

test('liegt eine frühere pulse.env da, ist ihre Adresse die Vorgabe', () => {
  const alt = 'PULSE_HOSTNAME=alt.example.org\nPULSE_INSTANCE_MODE=self-host\n';
  const mitTerminal = lauf({ eingabe: '\n', alteKonfiguration: alt });
  assert.equal(mitTerminal.exit, 0, mitTerminal.ausgabe);
  assert.match(mitTerminal.ausgabe, /Address of this server \[alt\.example\.org\]/);
  assert.match(mitTerminal.ausgabe, /Server address: alt\.example\.org/);

  const ohneTerminal = lauf({ eingabe: null, alteKonfiguration: alt });
  assert.equal(ohneTerminal.exit, 0, ohneTerminal.ausgabe);
  assert.match(ohneTerminal.ausgabe, /Server address: alt\.example\.org/);
});
```

`web/test/install-bestand.test.ts` — was in `pulse.env` und im Updater steht:

```ts
/**
 * `web/static/install.sh` — was in `pulse.env` und im Updater steht.
 *
 * Seit Oktober 2026 schreibt der Installer keine Zugangsdaten mehr: die holt
 * `pulse-connect` am Ende selbst ab und legt sie ins Datenvolumen. Eine
 * Ausnahme muss halten: die drei Server aus der Freigabe-Zeit tragen ihre
 * Zugangsdaten in `pulse.env`. Läuft der neue Installer auf so einem Server,
 * wandern sie mit — sonst stünde der Server unverbunden da, und ein neues
 * Verbinden gäbe ihm eine neue Instanz-Nummer (seine Mitglieder verlören ihn
 * aus ihrer Server-Liste). Ebenso bleibt beim Spiegel
 * `registry.howispulse.com` die Anmeldung im Updater; das öffentliche Bild
 * braucht keine.
 *
 * **Wie das geht:** wie in den Nachbardateien — die Funktionen werden
 * heredoc-bewusst aus `install.sh` geschnitten und gegen ein
 * Temp-Verzeichnis ausgeführt.
 */

import { test as testAlle } from 'node:test';

// Unter Windows nicht ausführbar (bash, chmod-Semantik); der Installer gehört
// auf Linux-Hosts, die Prüfungen laufen in der Linux-CI.
const test = process.platform === 'win32' ? testAlle.skip : testAlle;
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

/** Shell-Funktion bis zur `}` in Spalte 0 — heredoc-bewusst (wie install-updater.test.ts). */
function funktion(quelle: string, name: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `Funktion ${name}() nicht gefunden — Skript umgebaut?`);
  let heredocEnde: string | null = null;
  for (let i = start + 1; i < zeilen.length; i++) {
    const zeile = zeilen[i];
    if (heredocEnde !== null) {
      if (zeile === heredocEnde) heredocEnde = null;
      continue;
    }
    const treffer = zeile.match(/<<-?\s*['"]?(\w+)['"]?\s*$/);
    if (treffer) {
      heredocEnde = treffer[1];
      continue;
    }
    if (zeile === '}') return zeilen.slice(start, i + 1).join('\n');
  }
  assert.fail(`kein Ende fuer ${name}() gefunden — Skript umgebaut?`);
}

const BESTAND = [
  'PULSE_HOSTNAME=chat.example.org',
  'PULSE_INSTANCE_ID=123456789',
  'PULSE_INSTANCE_OWNER_ID=987654321',
  'PULSE_INSTANCE_MODE=self-host',
  'PULSE_CLOUD_ORIGIN=https://howispulse.com',
  'PULSE_CLOUD_CLIENT_ID=cid-bestand',
  'PULSE_CLOUD_CLIENT_SECRET=geheimnis-bestand',
  'PULSE_ADMIN_EMAIL=alt@example.org',
  'PULSE_TLS_MODE=auto',
  'PULSE_HTTP_PORT=8080',
  ''
].join('\n');

interface Konfig {
  datei: string;
  modus: number;
  ausgabe: string;
}

function konfiguriere(opt: { alteDatei?: string; adminEmail?: string } = {}): Konfig {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-konfig-'));
  const pulseDir = join(dir, 'pulse');
  if (opt.alteDatei !== undefined) {
    mkdirSync(pulseDir);
    writeFileSync(join(pulseDir, 'pulse.env'), opt.alteDatei, { mode: 0o600 });
  }
  const skript = `
set -euo pipefail
PULSE_DIR="${pulseDir}"
ENV_FILE="${join(pulseDir, 'pulse.env')}"
SRV_HOST=chat.example.org
CLOUD_ORIGIN=https://howispulse.com
ADMIN_EMAIL="${opt.adminEmail ?? ''}"
TLS_MODE=auto
HTTP_PORT=8080
INSTANCE_ID=""; CLIENT_ID=""; CLIENT_SECRET=""; BESTAND_ZEILEN=""
log()  { printf 'LOG %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*"; }
${funktion(quelle, 'zugang_lesen')}
${funktion(quelle, 'bestand_uebernehmen')}
${funktion(quelle, 'schreibe_konfiguration')}
bestand_uebernehmen
schreibe_konfiguration
printf 'VAR INSTANCE_ID=%s\\n' "$INSTANCE_ID"
printf 'VAR CLIENT_ID=%s\\n' "$CLIENT_ID"
printf 'VAR SECRET_GESETZT=%s\\n' "\${CLIENT_SECRET:+ja}"
`;
  const ausgabe = execFileSync('bash', ['-c', skript], { encoding: 'utf8' });
  const pfad = join(pulseDir, 'pulse.env');
  return { datei: readFileSync(pfad, 'utf8'), modus: statSync(pfad).mode & 0o777, ausgabe };
}

test('eine Neuinstallation schreibt keine Zugangsdaten in pulse.env', () => {
  const k = konfiguriere();
  assert.match(k.datei, /^PULSE_HOSTNAME=chat\.example\.org$/m);
  assert.match(k.datei, /^PULSE_INSTANCE_MODE=self-host$/m);
  assert.match(k.datei, /^PULSE_CLOUD_ORIGIN=https:\/\/howispulse\.com$/m);
  assert.match(k.datei, /^PULSE_TLS_MODE=auto$/m);
  assert.match(k.datei, /^PULSE_HTTP_PORT=8080$/m);
  assert.doesNotMatch(k.datei, /PULSE_INSTANCE_ID|PULSE_INSTANCE_OWNER_ID|PULSE_CLOUD_CLIENT/);
  assert.doesNotMatch(k.datei, /PULSE_ADMIN_EMAIL/, 'ohne Angabe keine leere Mail-Zeile');
  assert.equal(k.modus, 0o600);
});

test('PULSE_ADMIN_EMAIL steht nur drin, wenn sie angegeben wurde', () => {
  const k = konfiguriere({ adminEmail: 'admin@example.org' });
  assert.match(k.datei, /^PULSE_ADMIN_EMAIL=admin@example\.org$/m);
});

test('ein Bestandsserver behält seine Verbindung, ohne dass das Geheimnis ausgegeben wird', () => {
  const k = konfiguriere({ alteDatei: BESTAND });
  for (const zeile of [
    'PULSE_INSTANCE_ID=123456789',
    'PULSE_INSTANCE_OWNER_ID=987654321',
    'PULSE_CLOUD_CLIENT_ID=cid-bestand',
    'PULSE_CLOUD_CLIENT_SECRET=geheimnis-bestand',
    'PULSE_ADMIN_EMAIL=alt@example.org'
  ]) {
    assert.ok(k.datei.split('\n').includes(zeile), `fehlt in pulse.env: ${zeile}`);
  }
  assert.match(k.ausgabe, /Keeping the existing connection of chat\.example\.org \(instance 123456789\)/);
  assert.match(k.ausgabe, /^VAR CLIENT_ID=cid-bestand$/m);
  assert.match(k.ausgabe, /^VAR SECRET_GESETZT=ja$/m);
  assert.doesNotMatch(k.ausgabe, /geheimnis-bestand/);
});

test('gehört die alte pulse.env zu einer anderen Adresse, wandert nichts mit', () => {
  const k = konfiguriere({ alteDatei: BESTAND.replace('chat.example.org', 'alt.example.org') });
  assert.match(k.ausgabe, /WARN The previous configuration .* belongs to alt\.example\.org/);
  assert.doesNotMatch(k.datei, /PULSE_INSTANCE_ID|PULSE_CLOUD_CLIENT/);
  assert.match(k.ausgabe, /^VAR INSTANCE_ID=$/m);
});

function registryPruefung(image: string, mitZugang: boolean): { exit: number; ausgabe: string } {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const skript = `
set -euo pipefail
IMAGE="${image}"
CLIENT_ID="${mitZugang ? 'cid' : ''}"
CLIENT_SECRET="${mitZugang ? 'geheim' : ''}"
err() { printf '%s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
${funktion(quelle, 'pruefe_registry_zugang')}
pruefe_registry_zugang
echo __WEITER__
`;
  try {
    return { exit: 0, ausgabe: execFileSync('bash', ['-c', skript], { encoding: 'utf8' }) };
  } catch (fehler) {
    const f = fehler as { status?: number; stderr?: string };
    return { exit: f.status ?? 1, ausgabe: f.stderr ?? '' };
  }
}

test('der Spiegel registry.howispulse.com ohne Bestands-Zugang bricht ab, bevor etwas geschieht', () => {
  const e = registryPruefung('registry.howispulse.com/pulse-allinone:edge', false);
  assert.equal(e.exit, 1);
  assert.match(e.ausgabe, /unset PULSE_IMAGE/);
  assert.match(e.ausgabe, /Nothing has been changed yet/);
});

test('der Spiegel mit Bestands-Zugang und das öffentliche Bild laufen weiter', () => {
  assert.equal(registryPruefung('registry.howispulse.com/pulse-allinone:edge', true).exit, 0);
  assert.equal(registryPruefung('ghcr.io/oblivion-pictures/pulse:stable', false).exit, 0);
});

function updater(image: string, clientId: string, secret: string): { text: string; modus: number } {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-updater-anmeldung-'));
  const updateSh = join(dir, 'pulse-update.sh');
  const skript = `
set -euo pipefail
PULSE_DIR="${dir}"
UPDATE_SH="${updateSh}"
IMAGE="${image}"
CONTAINER=pulse
CLIENT_ID="${clientId}"
CLIENT_SECRET="${secret}"
RUN_ARGS=( -d --name pulse "${image}" )
${funktion(quelle, 'write_update_script')}
write_update_script
`;
  execFileSync('bash', ['-c', skript], { encoding: 'utf8' });
  return { text: readFileSync(updateSh, 'utf8'), modus: statSync(updateSh).mode & 0o777 };
}

test('der Updater für das öffentliche Bild meldet sich nirgends an', () => {
  const u = updater('ghcr.io/oblivion-pictures/pulse:stable', '', '');
  assert.doesNotMatch(u.text, /^REGISTRY=/m);
  assert.doesNotMatch(u.text, /^REG_USER=/m);
  assert.doesNotMatch(u.text, /^REG_PASS=/m);
});

test('ein Bestandsserver am Spiegel behält die Anmeldung im Updater', () => {
  const u = updater('registry.howispulse.com/pulse-allinone:edge', 'cid-bestand', 'geheimnis-bestand');
  assert.match(u.text, /^REGISTRY=registry\.howispulse\.com$/m);
  assert.match(u.text, /^REG_USER=cid-bestand$/m);
  assert.match(u.text, /^REG_PASS=geheimnis-bestand$/m);
  assert.equal(u.modus, 0o700);
});
```

`web/test/install-verbinden.test.ts` — der Verbinden-Schritt, der Schluss des Hauptablaufs und die Prüfung aus der Cloud:

```ts
/**
 * `web/static/install.sh` — der letzte Schritt: den Server mit einem
 * Pulse-Konto verbinden (`server_verbinden`, Spec E1/E6).
 *
 * Der Installer ruft `docker exec -it <container> pulse-connect --no-restart`
 * mit dem Terminal als Eingabe auf (bei `curl … | bash` ist stdin die Pipe),
 * startet danach selbst neu und wartet, bis der Server mit den abgeholten
 * Zugangsdaten wieder steht. Was hier festgehalten wird:
 *
 *   - pulse-connect bekommt das Terminal, nicht die Pipe;
 *   - jedes Scheitern (Strg+C, abgelehnt, abgelaufen, von aussen nicht
 *     erreichbar, kein Terminal) endet mit dem Hinweis
 *     `Connect later: docker exec -it pulse pulse-connect` und OHNE
 *     Fehler-Exit — der Server läuft ja;
 *   - ein schon verbundener Server (Neuinstallation auf altem Volumen,
 *     Bestandsserver) wird nicht neu verbunden: pulse-connect fragte dort
 *     nach, ob er einem anderen Konto gehören soll;
 *   - das Client-Secret für die Prüfung aus der Cloud geht nie über die
 *     Befehlszeile (`ps`), sondern über stdin an curl.
 *
 * **Wie das geht:** die Funktionen werden heredoc-bewusst aus `install.sh`
 * geschnitten und gegen ein gefälschtes `docker`/`curl` ausgeführt, die jeden
 * Aufruf samt Herkunft ihrer Standardeingabe protokollieren
 * (`/proc/self/fd/0` — Linux, wie der ganze Installer).
 */

import { test as testAlle } from 'node:test';

// Unter Windows nicht ausführbar (bash, /proc); der Installer gehört auf
// Linux-Hosts, die Prüfungen laufen in der Linux-CI.
const test = process.platform === 'win32' ? testAlle.skip : testAlle;
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

/** Shell-Funktion bis zur `}` in Spalte 0 — heredoc-bewusst (wie install-updater.test.ts). */
function funktion(quelle: string, name: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `Funktion ${name}() nicht gefunden — Skript umgebaut?`);
  let heredocEnde: string | null = null;
  for (let i = start + 1; i < zeilen.length; i++) {
    const zeile = zeilen[i];
    if (heredocEnde !== null) {
      if (zeile === heredocEnde) heredocEnde = null;
      continue;
    }
    const treffer = zeile.match(/<<-?\s*['"]?(\w+)['"]?\s*$/);
    if (treffer) {
      heredocEnde = treffer[1];
      continue;
    }
    if (zeile === '}') return zeilen.slice(start, i + 1).join('\n');
  }
  assert.fail(`kein Ende fuer ${name}() gefunden — Skript umgebaut?`);
}

/** Wörtlicher Ausschnitt zwischen zwei Zeilen (beide inklusive, getrimmt verglichen). */
function bereich(quelle: string, vonZeile: string, bisZeile: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.trim() === vonZeile);
  assert.notEqual(start, -1, `Startanker "${vonZeile}" nicht gefunden — Skript umgebaut?`);
  const ende = zeilen.findIndex((z, i) => i > start && z.trim() === bisZeile);
  assert.notEqual(ende, -1, `Endanker "${bisZeile}" nicht gefunden — Skript umgebaut?`);
  return zeilen.slice(start, ende + 1).join('\n');
}

interface Optionen {
  /** Antwort von pulse-server-info im Container; `null` = er antwortet nicht. */
  serverInfo: string | null;
  /** Exit-Code von pulse-connect. */
  connectExit?: number;
  /** Gibt es ein Terminal? */
  terminal?: boolean;
}

interface Ergebnis {
  exit: number;
  ausgabe: string;
  /** Jeder docker-Aufruf als Zeile „<argumente> | stdin=<herkunft>". */
  dockerAufrufe: string[];
  terminalPfad: string;
}

function umgebung(optionen: Optionen) {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-verbinden-'));
  const protokoll = join(dir, 'docker.log');
  writeFileSync(protokoll, '');
  const terminalPfad = join(dir, 'terminal');
  if (optionen.terminal !== false) writeFileSync(terminalPfad, '');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
printf '%s | stdin=%s\\n' "$*" "$(readlink /proc/self/fd/0)" >> "${protokoll}"
case "$*" in
  *pulse-server-info*) ${
    optionen.serverInfo === null ? 'exit 7' : `printf '%s' '${optionen.serverInfo}'`
  } ;;
  *pulse-connect*) exit ${optionen.connectExit ?? 0} ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);
  return { dir, protokoll, terminalPfad };
}

const VORSPANN = `
set -euo pipefail
CONTAINER=pulse
VERBUNDEN=""
PULSE_INSTALL_WARTE_VERSUCHE=1
PULSE_INSTALL_WARTE_INTERVALL=0
log()  { printf 'LOG %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*"; }
warte_auf_start() { echo __GEWARTET__; }
`;

function verbinde(optionen: Optionen): Ergebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const u = umgebung(optionen);
  const skript = `${VORSPANN}
TTY_GERAET="${u.terminalPfad}"
${funktion(quelle, 'server_info_innen')}
${funktion(quelle, 'ist_verbunden')}
${funktion(quelle, 'verbinden_spaeter')}
${funktion(quelle, 'server_verbinden')}
server_verbinden
echo "VERBUNDEN=$VERBUNDEN"
echo __UEBERLEBT__
`;
  let exit = 0;
  let ausgabe = '';
  try {
    ausgabe = execFileSync('bash', ['-c', skript], {
      env: { ...process.env, PATH: `${u.dir}:${process.env.PATH}` },
      encoding: 'utf8'
    });
  } catch (fehler) {
    const f = fehler as { status?: number; stdout?: string };
    exit = f.status ?? 1;
    ausgabe = f.stdout ?? '';
  }
  const dockerAufrufe = readFileSync(u.protokoll, 'utf8').split('\n').filter(Boolean);
  return { exit, ausgabe, dockerAufrufe, terminalPfad: u.terminalPfad };
}

const UNVERBUNDEN = '{"server_version":"0.8.0","instance_id":null,"verbunden":false}';
const VERBUNDEN = '{"server_version":"0.8.0","instance_id":"123456789","verbunden":true}';
const HINWEIS = /Connect later: docker exec -it pulse pulse-connect/;

test('pulse-connect läuft mit --no-restart und dem Terminal als Eingabe, danach Neustart', () => {
  const e = verbinde({ serverInfo: UNVERBUNDEN, connectExit: 0 });
  assert.equal(e.exit, 0, e.ausgabe);
  const connect = e.dockerAufrufe.find((z) => z.includes('pulse-connect'));
  assert.ok(connect, `pulse-connect nicht aufgerufen: ${e.dockerAufrufe.join('\n')}`);
  assert.match(connect, /^exec -it pulse pulse-connect --no-restart \| /);
  assert.ok(connect.endsWith(`stdin=${e.terminalPfad}`), `stdin war nicht das Terminal: ${connect}`);
  assert.ok(e.dockerAufrufe.some((z) => z.startsWith('restart pulse ')), 'kein docker restart');
  assert.match(e.ausgabe, /__GEWARTET__/);
  assert.match(e.ausgabe, /^VERBUNDEN=1$/m);
  assert.doesNotMatch(e.ausgabe, HINWEIS);
});

test('Abbruch von pulse-connect (Strg+C) → Hinweis, kein Neustart, kein Fehler-Exit', () => {
  const e = verbinde({ serverInfo: UNVERBUNDEN, connectExit: 130 });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.match(e.ausgabe, /__UEBERLEBT__/);
  assert.match(e.ausgabe, HINWEIS);
  assert.ok(!e.dockerAufrufe.some((z) => z.startsWith('restart ')), 'trotz Abbruch neu gestartet');
  assert.match(e.ausgabe, /^VERBUNDEN=$/m);
});

test('abgelehnt/abgelaufen (2), Fehler (1) und von aussen nicht erreichbar (3) enden ebenso', () => {
  for (const code of [1, 2, 3]) {
    const e = verbinde({ serverInfo: UNVERBUNDEN, connectExit: code });
    assert.equal(e.exit, 0, `Exit ${code}: ${e.ausgabe}`);
    assert.match(e.ausgabe, HINWEIS, `Exit ${code}`);
    assert.ok(!e.dockerAufrufe.some((z) => z.startsWith('restart ')), `Exit ${code}: neu gestartet`);
  }
});

test('Neuinstallation auf altem, schon verbundenem Volumen: kein neues Verbinden', () => {
  const e = verbinde({ serverInfo: VERBUNDEN });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')), 'pulse-connect aufgerufen');
  assert.ok(!e.dockerAufrufe.some((z) => z.startsWith('restart ')), 'neu gestartet');
  assert.match(e.ausgabe, /already connected to a Pulse account/);
  assert.match(e.ausgabe, /^VERBUNDEN=1$/m);
});

test('ein älterer Server ohne Feld „verbunden", aber mit Instanz-Nummer gilt als verbunden', () => {
  const e = verbinde({ serverInfo: '{"server_version":"0.7.0","instance_id":"123456789"}' });
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')));
  assert.match(e.ausgabe, /^VERBUNDEN=1$/m);
});

test('ohne Terminal kein pulse-connect, sondern der Hinweis', () => {
  const e = verbinde({ serverInfo: UNVERBUNDEN, terminal: false });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')));
  assert.match(e.ausgabe, HINWEIS);
});

test('antwortet der Server im Container nicht, wird nicht verbunden', () => {
  const e = verbinde({ serverInfo: null });
  assert.equal(e.exit, 0, e.ausgabe);
  assert.ok(!e.dockerAufrufe.some((z) => z.includes('pulse-connect')));
  assert.match(e.ausgabe, HINWEIS);
});

test('der Hauptablauf endet nach gescheitertem Verbinden mit Exit 0 und „Done."', () => {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const u = umgebung({ serverInfo: UNVERBUNDEN, connectExit: 2 });
  const skript = `${VORSPANN}
TTY_GERAET="${u.terminalPfad}"
SRV_HOST=chat.example.org
pruefung_von_aussen() { return 1; }
${funktion(quelle, 'server_info_innen')}
${funktion(quelle, 'ist_verbunden')}
${funktion(quelle, 'verbinden_spaeter')}
${funktion(quelle, 'server_verbinden')}
${bereich(quelle, 'server_verbinden', 'log "Done."')}
`;
  const ausgabe = execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${u.dir}:${process.env.PATH}` },
    encoding: 'utf8'
  });
  assert.match(ausgabe, HINWEIS);
  assert.match(ausgabe, /LOG Done\./);
  assert.doesNotMatch(ausgabe, /Checking your server from the outside/, 'Cloud-Prüfung ohne Verbindung');
});

test('die Prüfung aus der Cloud liest die Zugangsdaten aus dem Volumen und gibt das Secret nie auf der Befehlszeile weiter', () => {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-pruefung-'));
  const argvLog = join(dir, 'curl-argv.log');
  const stdinLog = join(dir, 'curl-stdin.log');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$*" in
  *verbindung.env*) printf 'PULSE_INSTANCE_ID=123456789\\nPULSE_INSTANCE_OWNER_ID=42\\nPULSE_CLOUD_CLIENT_ID=cid-neu\\nPULSE_CLOUD_CLIENT_SECRET=geheimnis-neu\\n' ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/bash
printf '%s\\n' "$*" > "${argvLog}"
cat > "${stdinLog}"
printf '{"gesamt":"ok","schritte":[]}'
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'curl'), 0o755);
  const skript = `
set -euo pipefail
CONTAINER=pulse
CLOUD_ORIGIN=https://cloud.invalid
INSTANCE_ID=""; CLIENT_ID=""; CLIENT_SECRET=""
PY_BERICHT='import sys; print("BERICHT " + sys.stdin.read())'
${funktion(quelle, 'zugang_lesen')}
${funktion(quelle, 'zugang_aus_volumen')}
${funktion(quelle, 'pruefung_von_aussen')}
pruefung_von_aussen
`;
  const ausgabe = execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8'
  });
  assert.match(ausgabe, /BERICHT \{"gesamt":"ok"/);
  assert.ok(existsSync(argvLog), 'curl wurde nicht aufgerufen');
  const argv = readFileSync(argvLog, 'utf8');
  assert.match(argv, /\/api\/auth\/selfhost\/diagnose\/123456789/);
  assert.doesNotMatch(argv, /geheimnis-neu/, 'Secret stand auf der Befehlszeile');
  const stdin = readFileSync(stdinLog, 'utf8');
  assert.match(stdin, /X-Pulse-Client-Secret: geheimnis-neu/);
  assert.match(stdin, /X-Pulse-Client-Id: cid-neu/);
  assert.doesNotMatch(ausgabe, /geheimnis-neu/);
});
```

- [ ] **Step 2: Die neuen Tests laufen lassen — sie müssen scheitern.**

Run: `cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/install-ohne-token.test.ts test/install-bestand.test.ts test/install-verbinden.test.ts`

Expected: `ℹ tests 25`, `ℹ pass 2`, `ℹ fail 23`. `install-ohne-token`: alle acht scheitern, weil das heutige Skript ohne Token mit `No bootstrap token provided` und Exit 1 abbricht. `install-bestand`: sechs scheitern mit `Funktion zugang_lesen() nicht gefunden — Skript umgebaut?` bzw. `pruefe_registry_zugang()`; die beiden Updater-Tests sind schon heute grün — sie halten das Verhalten fest, das bleiben muss (Anmeldung nur am Spiegel). `install-verbinden`: alle neun scheitern mit `Funktion server_info_innen() nicht gefunden` bzw. `zugang_lesen()`.

- [ ] **Step 3: `web/static/install.sh` umbauen.** Die Blöcke sind in Dateireihenfolge nummeriert; die Zeilenangaben beziehen sich auf den heutigen Stand der Datei. **Von unten nach oben anwenden (Block 17 zuerst)**, dann bleiben die Zeilennummern der übrigen Blöcke gültig. Was die Blöcke tun:

- 1–3: Kopf ohne Token, Bild `ghcr.io/oblivion-pictures/pulse:stable`, `TTY_GERAET`, Argumente (Adresse statt Token, ein alter `plse_boot_…`-Token als Argument wird erkannt und ignoriert), Warnung statt Abbruch bei altem Token-Befehl.
- 4–6: Kommentare und Meldung in `check_ports` ohne Token („Nothing has been changed yet.“).
- 6 enthält außerdem die neuen Funktionen `frage_adresse`, `pruefe_adresse`, `zugang_lesen`, `bestand_uebernehmen`, `pruefe_registry_zugang`, `schreibe_konfiguration` direkt hinter `pruefe_pulse_dir_schreibbar`.
- 7–8: `ist_unser_container` erkennt auch `ghcr.io/oblivion-pictures/pulse:*`; die späte Konfliktmeldung sagt, dass die Konfiguration schon steht.
- 9–12: Meldungen in `_set_proxy` und `decide_mode` ohne Token.
- 13: `jget` entfällt.
- 14: Kommentar in `write_update_script`; der Code dort bleibt — Anmeldung am Spiegel nur, wenn `IMAGE` auf `registry.howispulse.com/*` zeigt (Bestand).
- 15–17: Der Hauptablauf. Die Warteschleife wird zur Funktion `warte_auf_start` (läuft zweimal: nach dem Start und nach dem Neustart mit den abgeholten Zugangsdaten); neue Funktionen `server_info_innen`, `server_info_aussen`, `ist_verbunden`, `verbinden_spaeter`, `server_verbinden`, `zugang_aus_volumen`; `pruefung_von_aussen` liest die Zugangsdaten aus dem Volumen und gibt das Secret über stdin an curl. Der Bericht-Code `PY_BERICHT` (heutige Zeilen 1209–1312) bleibt unverändert stehen. Die Schritte des Ablaufs heißen danach: 1) Adresse/Modus, 2) Konfiguration, 3) Start, 4) Auto-Update, 5) Startfortschritt, 6) Route, 7) Antwort unter der eigenen Adresse, 8) Verbinden, 9) Prüfung aus der Cloud. Die Nummer 4 und der Kommentar `# 7) Antwortet der Server unter seiner eigenen Adresse?` sind Anker in `install-anweisungen.test.ts`.

**Block 1 — alte Zeilen 5–9 ersetzen.** Alt:

```bash
#   curl -fsSL https://howispulse.com/install | PULSE_BOOTSTRAP_TOKEN=<TOKEN> bash
#
# Token bevorzugt per Env-Variable (argv wäre für jeden lokalen User in `ps`
# sichtbar, solange das Script läuft); `bash -s -- <TOKEN>` bleibt als
# Fallback unterstützt.
```

Neu:

```bash
#   curl -fsSL https://howispulse.com/install | bash
#   curl -fsSL https://howispulse.com/install | PULSE_HOSTNAME=chat.example.org bash
#
# Fragt nach der Adresse des Servers (oder nimmt PULSE_HOSTNAME bzw. das erste
# Argument), startet den Container und verbindet ihn am Ende mit dem
# Pulse-Konto des Betreibers: `pulse-connect` im Container zeigt Link und Code,
# der Betreiber bestätigt im Browser. Seit Oktober 2026 ohne Antrag und ohne
# Token (docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md).
```

**Block 2 — alte Zeilen 21–27 ersetzen.** Alt:

```bash
# Sicherheit: Bootstrap-Token wird beim Einlösen verbraucht, das Pairing-Secret
# serverseitig rotiert. --dry-run zeigt nur den Plan (kein Token-Verbrauch).
set -euo pipefail

# --- Konfiguration (per Env überschreibbar) --------------------------------
CLOUD_ORIGIN="${PULSE_CLOUD_ORIGIN:-https://howispulse.com}"
IMAGE="${PULSE_IMAGE:-registry.howispulse.com/pulse-allinone:edge}"
```

Neu:

```bash
# --dry-run zeigt nur den Plan und verändert nichts.
set -euo pipefail

# --- Konfiguration (per Env überschreibbar) --------------------------------
CLOUD_ORIGIN="${PULSE_CLOUD_ORIGIN:-https://howispulse.com}"
IMAGE="${PULSE_IMAGE:-ghcr.io/oblivion-pictures/pulse:stable}"
```

**Block 3 — alte Zeilen 46–67 ersetzen.** Alt:

```bash

# --- Args ---------------------------------------------------------------- #
DRY_RUN=""
TOKEN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --*) ;;                       # unbekannte Flags ignorieren
    *) [ -z "$TOKEN" ] && TOKEN="$arg" ;;
  esac
done
TOKEN="${TOKEN:-${PULSE_BOOTSTRAP_TOKEN:-}}"

# --- Ausgabe-Helfer --------------------------------------------------------
log()  { printf '\033[1;36m[pulse]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pulse]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[pulse] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

[ -n "$TOKEN" ] || die "No bootstrap token provided.
  Usage: curl -fsSL ${CLOUD_ORIGIN}/install | PULSE_BOOTSTRAP_TOKEN=<TOKEN> bash
  Get a token in the Pulse app: Settings → Self-Host → Set up server."
```

Neu:

```bash
# Woher Eingaben kommen. Bei `curl … | bash` ist stdin die Pipe, deshalb das
# Terminal direkt. PULSE_TTY biegt das um — die Tests setzen es, damit ein
# Lauf aus einem Terminal heraus nie auf eine Eingabe wartet.
TTY_GERAET="${PULSE_TTY:-/dev/tty}"

# --- Args ---------------------------------------------------------------- #
DRY_RUN=""
SRV_HOST="${PULSE_HOSTNAME:-}"
ADMIN_EMAIL="${PULSE_ADMIN_EMAIL:-}"
ALTER_TOKEN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --*) ;;                       # unbekannte Flags ignorieren
    plse_boot_*) ALTER_TOKEN=1 ;; # alter Befehl `bash -s -- <TOKEN>`, s. unten
    *) if [ -z "$SRV_HOST" ]; then SRV_HOST="$arg"; fi ;;
  esac
done
# Zugangsdaten kennt der Installer nur von Bestandsservern (bestand_uebernehmen)
# oder, nach dem Verbinden, aus dem Datenvolumen (zugang_aus_volumen).
INSTANCE_ID=""; CLIENT_ID=""; CLIENT_SECRET=""; BESTAND_ZEILEN=""
VERBUNDEN=""

# --- Ausgabe-Helfer --------------------------------------------------------
log()  { printf '\033[1;36m[pulse]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pulse]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[pulse] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# Bis Oktober 2026 verlangte der Installer einen Einmal-Token aus der Cloud.
# Alte Befehle laufen weiter; der Token wird nicht mehr verwendet.
if [ -n "$ALTER_TOKEN" ] || [ -n "${PULSE_BOOTSTRAP_TOKEN:-}" ]; then
  warn "Setup tokens are no longer needed — ignoring the token."
fi
```

**Block 4 — alte Zeilen 98–102 ersetzen.** Alt:

```bash
# Warum VOR dem Token-Einlösen: der Token ist einmalig und wird in Schritt 2
# verbrannt, `docker run` läuft erst in Schritt 4. Ein belegter Port 3478 (ein
# anderer coturn, gar nicht selten) liess das Script unter `set -e` sterben —
# mit verbranntem Token und einer rohen Docker-Fehlermeldung. Zwei Sekunden
# vorher war das erkennbar.
```

Neu:

```bash
# Warum VOR jeder Änderung: `docker run` läuft erst in Schritt 3, nachdem die
# Konfiguration geschrieben und das Bild geladen ist. Ein belegter Port 3478
# (ein anderer coturn, gar nicht selten) liess das Script unter `set -e`
# sterben — mit einer rohen Docker-Fehlermeldung und einem halb eingerichteten
# Server. Zwei Sekunden vorher war das erkennbar.
```

**Block 5 — alte Zeile 114 ersetzen.** Alt:

```bash
  # echter Fremdkonflikt hätte den Einmal-Token doch noch verbrannt.
```

Neu:

```bash
  # echter Fremdkonflikt wäre erst an `docker run` gescheitert.
```

**Block 6 — alte Zeilen 132–152 ersetzen.** Alt:

```bash
  is listening) and run this command again — your setup token is still valid,
  nothing has been consumed yet."
}

# --- $PULSE_DIR muss beschreibbar sein — vor der Token-Einloesung -------- #
#
# `mkdir -p "$PULSE_DIR"` war bisher der ERSTE Dateisystemzugriff des ganzen
# Laufs und lief NACH der Token-Einloesung (s. "3) Config schreiben" weiter
# unten). Wer PULSE_DIR=/opt/pulse ohne Schreibrechte setzt, verbrannte den
# Token trotzdem — eine rohe mkdir-Fehlermeldung unter set -e sagt nicht,
# dass der Token weg ist, und ein neuer Versuch braucht einen kompletten
# neuen Antrag (Single-Bootstrap pro Antrag, s. CLAUDE.md). Legt das
# Verzeichnis hier bereits an (idempotent, kein Test-und-wieder-Löschen)
# statt es nur zu prüfen — die spätere `mkdir -p` bei der Config wird damit
# zu einem reinen No-op und bleibt dort trotzdem stehen, falls sich der
# Ablauf dazwischen je trennt.
pruefe_pulse_dir_schreibbar() {
  mkdir -p "$PULSE_DIR" 2>/dev/null && [ -w "$PULSE_DIR" ] || die "Cannot create or write to '${PULSE_DIR}'.
  Check the permissions on that path, or set PULSE_DIR=<a writable path> and
  run this command again — your setup token is still valid, nothing has
  been consumed yet."
```

Neu:

```bash
  is listening) and run this command again. Nothing has been changed yet."
}

# --- $PULSE_DIR muss beschreibbar sein — vor der ersten Änderung -------- #
#
# `mkdir -p "$PULSE_DIR"` ist der erste Dateisystemzugriff des ganzen Laufs.
# Wer PULSE_DIR=/opt/pulse ohne Schreibrechte setzt, bekam sonst erst beim
# Schreiben der Konfiguration eine rohe mkdir-Fehlermeldung unter set -e. Legt
# das Verzeichnis hier bereits an (idempotent, kein Test-und-wieder-Löschen)
# statt es nur zu prüfen — die spätere `mkdir -p` in schreibe_konfiguration
# wird damit zu einem reinen No-op und bleibt dort trotzdem stehen, falls sich
# der Ablauf dazwischen je trennt.
pruefe_pulse_dir_schreibbar() {
  mkdir -p "$PULSE_DIR" 2>/dev/null && [ -w "$PULSE_DIR" ] || die "Cannot create or write to '${PULSE_DIR}'.
  Check the permissions on that path, or set PULSE_DIR=<a writable path> and
  run this command again. Nothing has been changed yet."
}

# --- Adresse des Servers ------------------------------------------------- #
#
# Sie kommt aus PULSE_HOSTNAME, dem ersten Argument oder einer Frage am
# Terminal (Frage auf stdout wie bei der Routen-Frage weiter unten, Antwort
# aus TTY_GERAET). Liegt von einer früheren Installation schon eine
# pulse.env da, ist deren Adresse die Vorgabe — ein erneuter Lauf soll nicht
# aus Versehen eine andere Adresse eintragen.
frage_adresse() {
  [ -n "$SRV_HOST" ] && return 0
  local vorschlag=""
  if [ -r "$ENV_FILE" ]; then
    vorschlag="$(grep -m1 '^PULSE_HOSTNAME=' "$ENV_FILE" | cut -d= -f2- || true)"
  fi
  if { : <"$TTY_GERAET"; } 2>/dev/null; then
    if [ -n "$vorschlag" ]; then
      printf '  Address of this server [%s]: ' "$vorschlag"
    else
      printf '  Address of this server (e.g. chat.example.org): '
    fi
    read -r SRV_HOST <"$TTY_GERAET" || true
  fi
  SRV_HOST="${SRV_HOST:-$vorschlag}"
  [ -n "$SRV_HOST" ] || die "No server address given.
  Usage: curl -fsSL ${CLOUD_ORIGIN}/install | PULSE_HOSTNAME=chat.example.org bash
  The address needs a DNS record pointing at this machine."
}

# Dieselbe Form, die die Cloud beim Verbinden einträgt
# (dcc_shared.hostname.normalisiere_hostname): Kleinbuchstaben, ohne Schema,
# Pfad, Port und abschliessenden Punkt. Wiche sie ab, stünde in pulse.env eine
# andere Adresse als im Cloud-Eintrag.
pruefe_adresse() {
  SRV_HOST="$(printf '%s' "$SRV_HOST" | tr -d '[:space:]' | tr 'A-Z' 'a-z' \
    | sed -e 's|^[a-z][a-z0-9+.-]*://||' -e 's|[/:?#].*$||' -e 's|\.$||')"
  printf '%s' "$SRV_HOST" \
    | grep -qE '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$' \
    || die "'${SRV_HOST}' is not a valid server address (expected something like chat.example.org).
  The address needs a DNS record pointing at this machine."
}

# --- Zugangsdaten aus KEY=wert-Zeilen lesen (stdin) ---------------------- #
# Setzt INSTANCE_ID, CLIENT_ID und CLIENT_SECRET. Gibt nichts aus.
zugang_lesen() {
  local k v
  while IFS='=' read -r k v || [ -n "$k" ]; do
    v="${v%\"}"; v="${v#\"}"
    case "$k" in
      PULSE_INSTANCE_ID)         INSTANCE_ID="$v" ;;
      PULSE_CLOUD_CLIENT_ID)     CLIENT_ID="$v" ;;
      PULSE_CLOUD_CLIENT_SECRET) CLIENT_SECRET="$v" ;;
    esac
  done
}

# --- Bestand: Verbindung einer Installation aus der Freigabe-Zeit ------- #
#
# Server, die vor Oktober 2026 mit Freigabe eingerichtet wurden, tragen ihre
# Zugangsdaten in $ENV_FILE und nicht im Datenvolumen. Schriebe ein erneuter
# Lauf die Datei ohne sie, stünde der Server unverbunden da; ein neues
# Verbinden gäbe ihm eine neue Instanz-Nummer, und seine Mitglieder verlören
# ihn aus ihrer Server-Liste. Gehört die alte Datei zu derselben Adresse,
# wandern ihre Verbindungswerte deshalb unverändert mit (im Container gewinnt
# die Umgebung ohnehin vor /data/pulse/verbindung.env). Liest nur.
bestand_uebernehmen() {
  [ -r "$ENV_FILE" ] || return 0
  local alter_host
  alter_host="$(grep -m1 '^PULSE_HOSTNAME=' "$ENV_FILE" | cut -d= -f2- || true)"
  [ -n "$alter_host" ] || return 0
  if [ "$alter_host" != "$SRV_HOST" ]; then
    warn "The previous configuration in ${ENV_FILE} belongs to ${alter_host} — its connection is not carried over."
    return 0
  fi
  BESTAND_ZEILEN="$(grep -E '^PULSE_(INSTANCE_ID|INSTANCE_OWNER_ID|CLOUD_CLIENT_ID|CLOUD_CLIENT_SECRET)=.' "$ENV_FILE" || true)"
  [ -n "$BESTAND_ZEILEN" ] || return 0
  zugang_lesen <<<"$BESTAND_ZEILEN"
  if [ -z "$ADMIN_EMAIL" ]; then
    ADMIN_EMAIL="$(grep -m1 '^PULSE_ADMIN_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)"
  fi
  log "Keeping the existing connection of ${SRV_HOST} (instance ${INSTANCE_ID})."
}

# --- Spiegel registry.howispulse.com nur mit Bestands-Zugang ------------- #
#
# Der Spiegel lässt nur Server aus der Freigabe-Zeit herein (Anmeldung mit
# ihren Zugangsdaten, routes_registry_auth.py). Ohne sie scheiterte ein Lauf
# erst beim Pull, nach dem Schreiben der Konfiguration — deshalb hier, vor
# jeder Änderung.
pruefe_registry_zugang() {
  case "$IMAGE" in
    registry.howispulse.com/*)
      if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
        die "The image ${IMAGE} needs the credentials of a server set up before October 2026.
  Use the public image instead: unset PULSE_IMAGE and run this command again.
  Nothing has been changed yet."
      fi ;;
  esac
  return 0
}

# --- Konfiguration schreiben (chmod 600) -------------------------------- #
#
# Nur Adresse und Betriebswerte. Die Zugangsdaten holt pulse-connect am Ende
# selbst ab und legt sie ins Datenvolumen (/data/pulse/verbindung.env); hier
# stehen sie allein bei einem Bestandsserver (s. bestand_uebernehmen).
schreibe_konfiguration() {
  mkdir -p "$PULSE_DIR"
  ( umask 077
    {
      printf 'PULSE_HOSTNAME=%s\n' "$SRV_HOST"
      printf 'PULSE_INSTANCE_MODE=self-host\n'
      printf 'PULSE_CLOUD_ORIGIN=%s\n' "$CLOUD_ORIGIN"
      if [ -n "$ADMIN_EMAIL" ]; then printf 'PULSE_ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL"; fi
      printf 'PULSE_TLS_MODE=%s\n' "$TLS_MODE"
      printf 'PULSE_HTTP_PORT=%s\n' "$HTTP_PORT"
      if [ -n "$BESTAND_ZEILEN" ]; then printf '%s\n' "$BESTAND_ZEILEN"; fi
    } > "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
```

**Block 7 — alte Zeilen 224–260 ersetzen.** Alt:

```bash
# Kollisionsquelle. ZWEI Wege gelten als "unser Container":
#   1. Ein Substring-Vergleich auf `pulse-allinone` — `PULSE_IMAGE` ist
#      überschreibbar und ein Betreiber mit eigenem Spiegel/Fork (eigene
#      Registry, eigener Tag) soll den Installer trotzdem benutzen können,
#      solange der Repository-Name erhalten bleibt.
#   2. Ein exakter Vergleich mit dem AKTUELL konfigurierten `$IMAGE` (Fund 3,
#      Schlussprüfung) — Weg 1 allein sperrt einen Betreiber aus, der
#      `PULSE_IMAGE` auf einen anders benannten Spiegel/Fork gesetzt hat
#      (kein `pulse-allinone` im Namen): sein eigener Container gälte dann
#      unter demselben Containernamen für immer als fremd, und ein erneuter
#      Lauf des Installers könnte nie wieder auf ihn zugreifen.
# Ein Docker-LABEL wäre robuster (unabhängig von beidem), existiert im
# Image aber nicht — das einzuführen läge ausserhalb dieser Behebung.
ist_unser_container() {
  local img
  img="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)"
  case "$img" in
    *pulse-allinone*) return 0 ;;
    "$IMAGE") return 0 ;;
    *) return 1 ;;
  esac
}

# --- Fremdkonflikt am Containernamen erkennen (liest nur, löscht nichts) - #
#
# Wird an ZWEI Stellen aufgerufen: FRÜH, direkt nach `check_ports` und damit
# vor der Token-Einlösung — und SPÄT, direkt vor dem tatsächlichen
# `docker rm -f` in `sichere_container_ersetzung`. Die frühe Prüfung allein
# würde nicht reichen: zwischen ihr und dem eigentlichen Ersetzen liegen die
# Token-Einlösung und der Image-Pull, spürbare Zeit, in der sich der
# Containername theoretisch neu belegen liesse — ein Fremdkonflikt, der
# GENAU in dieser Lücke entsteht, fände die frühe Prüfung nicht mehr. Die
# späte Prüfung allein würde den Token unnötig verbrennen (s. dort). Beide
# zusammen schliessen das Fenster; keine der beiden ersetzt die andere.
#
# $1 = zusätzlicher Satz für die Meldung (früh: Hinweis auf den noch
# unverbrauchten Token; spät: Hinweis, dass er es nicht mehr ist).
```

Neu:

```bash
# Kollisionsquelle. DREI Wege gelten als "unser Container":
#   1. Ein Substring-Vergleich auf `pulse-allinone` — so heisst das Bild am
#      Spiegel registry.howispulse.com (Bestandsserver) und bis Oktober 2026
#      auf GHCR. `PULSE_IMAGE` ist überschreibbar, und ein Betreiber mit
#      eigenem Spiegel/Fork (eigene Registry, eigener Tag) soll den Installer
#      trotzdem benutzen können, solange der Repository-Name erhalten bleibt.
#   2. Das öffentliche Bild `ghcr.io/oblivion-pictures/pulse` mit beliebigem
#      Tag oder Digest — der Name `pulse` allein wäre zu allgemein, deshalb
#      nur unter genau diesem Pfad.
#   3. Ein exakter Vergleich mit dem AKTUELL konfigurierten `$IMAGE` (Fund 3,
#      Schlussprüfung) — Weg 1 allein sperrt einen Betreiber aus, der
#      `PULSE_IMAGE` auf einen anders benannten Spiegel/Fork gesetzt hat
#      (kein `pulse-allinone` im Namen): sein eigener Container gälte dann
#      unter demselben Containernamen für immer als fremd, und ein erneuter
#      Lauf des Installers könnte nie wieder auf ihn zugreifen.
# Ein Docker-LABEL wäre robuster (unabhängig von allen dreien), existiert im
# Image aber nicht — das einzuführen läge ausserhalb dieser Behebung.
ist_unser_container() {
  local img
  img="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)"
  case "$img" in
    *pulse-allinone*) return 0 ;;
    ghcr.io/oblivion-pictures/pulse:*|ghcr.io/oblivion-pictures/pulse@*) return 0 ;;
    "$IMAGE") return 0 ;;
    *) return 1 ;;
  esac
}

# --- Fremdkonflikt am Containernamen erkennen (liest nur, löscht nichts) - #
#
# Wird an ZWEI Stellen aufgerufen: FRÜH, direkt nach `check_ports` und damit
# vor jeder Änderung — und SPÄT, direkt vor dem tatsächlichen `docker rm -f`
# in `sichere_container_ersetzung`. Die frühe Prüfung allein würde nicht
# reichen: zwischen ihr und dem eigentlichen Ersetzen liegen das Schreiben der
# Konfiguration und der Image-Pull, spürbare Zeit, in der sich der
# Containername theoretisch neu belegen liesse — ein Fremdkonflikt, der
# GENAU in dieser Lücke entsteht, fände die frühe Prüfung nicht mehr. Die
# späte Prüfung allein liesse eine geschriebene Konfiguration zurück, obwohl
# der Lauf von Anfang an keine Chance hatte. Beide zusammen schliessen das
# Fenster; keine der beiden ersetzt die andere.
#
# $1 = zusätzlicher Satz für die Meldung (früh: es wurde noch nichts
# verändert; spät: die Konfiguration steht schon, ein neuer Lauf ist sicher).
```

**Block 8 — alte Zeile 283 ersetzen.** Alt:

```bash
  pruefe_container_konflikt "Your setup token has already been redeemed for this run — it cannot be reused. You'll need a fresh one to try again."
```

Neu:

```bash
  pruefe_container_konflikt "The configuration has already been written — running this command again is safe."
```

**Block 9 — alte Zeile 320 ersetzen.** Alt:

```bash
  consumed yet; this check runs before the setup token is redeemed.
```

Neu:

```bash
  changed yet.
```

**Block 10 — alte Zeilen 409–415 ersetzen.** Alt:

```bash
  Nothing has been consumed yet; this check runs before the setup token is redeemed."; fi ;;
    static-caddy|static-nginx)
      if [ -n "$PROXY_NET" ]; then MODE=static-docker
      else die "Proxy '${PROXY_CONTAINER}' is only on the default Docker bridge network — Pulse has no reachable address to hand it.
  A loopback address (127.0.0.1) would be the PROXY CONTAINER's own loopback, not the host's; it could never reach Pulse from there.
  Set PULSE_NETWORK=<name> to a network Pulse and '${PROXY_CONTAINER}' can both join, and run this command again.
  Nothing has been consumed yet; this check runs before the setup token is redeemed."; fi ;;
```

Neu:

```bash
  Nothing has been changed yet."; fi ;;
    static-caddy|static-nginx)
      if [ -n "$PROXY_NET" ]; then MODE=static-docker
      else die "Proxy '${PROXY_CONTAINER}' is only on the default Docker bridge network — Pulse has no reachable address to hand it.
  A loopback address (127.0.0.1) would be the PROXY CONTAINER's own loopback, not the host's; it could never reach Pulse from there.
  Set PULSE_NETWORK=<name> to a network Pulse and '${PROXY_CONTAINER}' can both join, and run this command again.
  Nothing has been changed yet."; fi ;;
```

**Block 11 — alte Zeilen 436–437 ersetzen.** Alt:

```bash
  #   1. PULSE_TLS_MODE validieren — VOR jeder Wirkung und vor allem vor der
  #      Token-Einloesung weiter unten im Skript. Der Container kennt nur
```

Neu:

```bash
  #   1. PULSE_TLS_MODE validieren — VOR jeder Wirkung und vor allem vor dem
  #      Schreiben der Konfiguration weiter unten. Der Container kennt nur
```

**Block 12 — alte Zeilen 458–459 ersetzen.** Alt:

```bash
  Nothing has been consumed yet; this check runs before the setup token is
  redeemed." ;;
```

Neu:

```bash
  Nothing has been changed yet." ;;
```

**Block 13 — alte Zeilen 575–604 löschen.** Alt:

```bash
# --- JSON-Feld auslesen (python3 bevorzugt, sonst grep/sed) -------------- #
# Newlines werden hart entfernt: die Werte landen zeilenweise in der .env.
jget() {
  if command -v python3 >/dev/null 2>&1; then
    # `.get('$2','')` liefert das Vorgabe-'' nur, wenn der Schlüssel FEHLT —
    # steht er mit JSON-`null` im Feld (z. B. admin_email ohne hinterlegte
    # Mail), kommt echtes `None` zurück und `print(None)` schreibt den
    # literalen Text "None" in die .env. `or ''` fängt beides ab.
    #
    # `|| true` am Ende, aus demselben Grund wie beim Rückfallzweig unten
    # (dort steht nur noch der Verweis hierher): eine Antwort mit
    # Statuscode 200, die kein gültiges JSON ist (Captive Portal,
    # transparenter Proxy, WAF-Zwischenseite — `curl -fsSL` folgt
    # Weiterleitungen, `-f` greift nur bei Nicht-2xx), lässt `json.load` mit
    # `JSONDecodeError` abbrechen. Ohne `|| true` tötet das unter `set -euo
    # pipefail` (Skriptkopf) die Zuweisung `VAR="$(jget …)"` wortlos, mit
    # einem Python-Traceback als letzter Ausgabe, unmittelbar nach dem
    # Einlösen des Bootstrap-Tokens.
    printf '%s' "$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$2','') or '')" | tr -d '\r\n' || true
  else
    # Kein Treffer lässt `grep -o` mit Exit 1 enden; unter `set -euo
    # pipefail` (Skriptkopf) tötet das sonst die Zuweisung `VAR="$(jget …)"`
    # wortlos, unmittelbar nach dem Einlösen des Bootstrap-Tokens. Ein
    # fehlendes/leeres Feld ist hier ein Normalzustand, kein Fehler — wie
    # beim python3-Zweig oben.
    printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
      | sed 's/.*:[[:space:]]*"//; s/"$//' | tr -d '\r\n' || true
  fi
}
```

**Block 14 — alte Zeilen 633–635 ersetzen.** Alt:

```bash
    # Registry-Credentials einbacken (chmod 700, gleicher Schutz wie pulse.env).
    # Nur wenn IMAGE von der eigenen Registry kommt — der GHCR-Fallback via
    # PULSE_IMAGE braucht kein Login.
```

Neu:

```bash
    # Registry-Zugang einbacken (chmod 700, gleicher Schutz wie pulse.env) —
    # nur für den Spiegel registry.howispulse.com, den allein Bestandsserver
    # aus der Freigabe-Zeit nutzen (s. pruefe_registry_zugang). Das
    # öffentliche Bild auf GHCR braucht keine Anmeldung.
```

**Block 15 — alte Zeilen 953–1068 ersetzen.** Alt (116 Zeilen, Leerzeilen mitgezählt) — ab Zeile 953:

```bash
# ======================================================================== #
# Ablauf
# ======================================================================== #
```

bis Zeile 1068:

```bash
fi

# 6) Startfortschritt verfolgen — mitlaufende Checkliste statt Stille.
```

Neu:

```bash
# --- Startfortschritt verfolgen — mitlaufende Checkliste statt Stille --- #
```

**Block 16 — alte Zeilen 1096–1207 ersetzen.** Alt (112 Zeilen, Leerzeilen mitgezählt) — ab Zeile 1096:

```bash
log "Starting up — this takes about a minute:"
GESEHEN=0
FERTIG=""
```

bis Zeile 1207:

```bash
  read -r -t 600 _ </dev/tty 2>/dev/null || true
  echo
fi
```

Neu:

```bash
# Wartet, bis der Container seine Startskripte durchlaufen hat, und druckt
# die Checkliste mit. Läuft zweimal: nach dem ersten Start und nach dem
# Neustart, der die abgeholten Zugangsdaten einliest (server_verbinden).
# Bricht der Start ab, endet der Installer hier mit Exit 1 — ein Server, der
# nicht startet, braucht zuerst `docker logs`, nicht den nächsten Schritt.
warte_auf_start() {
  GESEHEN=0
  FERTIG=""
  ABBRUCH=""
  ABBRUCH_CRASH=""
  for _ in $(seq 1 60); do
    STATUS_ROH="$(docker exec "$CONTAINER" cat /data/setup-status 2>/dev/null || true)"
    if [ -n "$STATUS_ROH" ]; then
      ZEILEN="$(printf '%s\n' "$STATUS_ROH" | wc -l)"
      if [ "$ZEILEN" -gt "$GESEHEN" ]; then
        printf '%s\n' "$STATUS_ROH" | tail -n +$((GESEHEN + 1)) | while IFS="$(printf '\t')" read -r _t name zustand; do
          [ -z "$name" ] && continue
          if [ "$zustand" = "ok" ]; then
            printf '    \033[1;32m+\033[0m %s\n' "$(schritt_text "$name")"
          else
            printf '    \033[1;31mx\033[0m %s — FAILED\n' "$(schritt_text "$name")"
          fi
        done
        GESEHEN="$ZEILEN"
      fi
      printf '%s\n' "$STATUS_ROH" | grep -q "$(printf '\t')fertig$(printf '\t')ok" && { FERTIG=1; break; }
      # Merker statt `exit` in der Regel: ein `exit` dort springt nach END,
      # und dessen `exit` ueberschreibt den Status wieder — die Erkennung waere
      # damit immer falsch.
      printf '%s\n' "$STATUS_ROH" \
        | awk -F"$(printf '\t')" '$3 != "" && $3 != "ok" { gefunden=1 } END { exit !gefunden }' \
        && { ABBRUCH=1; break; }
    fi
    # Ein Container, der nicht mehr läuft, wird auch nicht mehr fertig — UND
    # einer, der immer wieder abstürzt und neu startet, macht ebenso wenig
    # Fortschritt, meldet dabei aber '.State.Running' durchgehend 'true' (Fund
    # 1, Schlussprüfung: Docker hält den Wert während der GESAMTEN
    # Neustart-Rückstufung auf 'true', s. container_laeuft_stabil() weiter
    # oben). Ohne diese Unterscheidung wartete die Schleife eine Absturzschleife
    # bis zum Zeitlimit aus, statt sie sofort zu erkennen — und das ist der
    # wahrscheinlichste Fehlschlag einer Erstinstallation überhaupt.
    #
    # '.RestartCount' + '.State.Status' in einem Aufruf, wie in Fund 1: steigt
    # der Zähler, ist es keine Erstinstallation, sondern eine Schleife — dafür
    # unten eine EIGENE Meldung, nicht "the step marked FAILED above", denn
    # oben steht in diesem Fall gar kein FAILED — der Container starb, bevor er
    # überhaupt einen weiteren Schritt in setup-status schreiben konnte.
    WERTE="$(docker inspect -f '{{.RestartCount}} {{.State.Status}}' "$CONTAINER" 2>/dev/null)" || WERTE=""
    RESTARTS="${WERTE%% *}"
    STATUS="${WERTE#* }"
    if [ "${RESTARTS:-0}" != "0" ]; then
      ABBRUCH=1; ABBRUCH_CRASH=1; break
    elif [ -z "$WERTE" ] || [ "$STATUS" != "running" ]; then
      ABBRUCH=1; break
    fi
    # Zustandserkennung Ende — hier weiter mit 'sleep 5' im echten Ablauf.
    sleep 5
  done

  echo
  if [ -n "$ABBRUCH_CRASH" ]; then
    err "Startup aborted — the container is stuck in a restart loop. It keeps crashing before it can make further progress."
    err "  docker logs ${CONTAINER} 2>&1 | tail -50"
    exit 1
  elif [ -n "$ABBRUCH" ]; then
    err "Startup aborted. The step marked FAILED above is where it stopped."
    err "  docker logs ${CONTAINER} 2>&1 | tail -50"
    exit 1
  fi
  [ -n "$FERTIG" ] || warn "Startup is taking longer than expected — check: docker logs -f ${CONTAINER}"
}

# --- /.well-known/pulse-server-info lesen -------------------------------- #
#
# Von innen über den chat-gateway (127.0.0.1:8002 im Container): kein DNS,
# kein Zertifikat, kein Hairpin-NAT — die verlässliche Antwort auf „ist der
# Server schon verbunden?“. Von aussen über https://<adresse>: der Beweis,
# dass DNS, Port 443, Zertifikat und Routing stehen. Beide wiederholen, weil
# „startup complete“ nur das Ende der Startskripte meldet; die Dienste und
# Caddys Zertifikat kommen erst danach. PULSE_INSTALL_WARTE_* nur für Tests.
server_info_innen() {
  local i
  for i in $(seq 1 "${PULSE_INSTALL_WARTE_VERSUCHE:-20}"); do
    docker exec "$CONTAINER" curl -fsS -m 5 \
      http://127.0.0.1:8002/.well-known/pulse-server-info 2>/dev/null && return 0
    sleep "${PULSE_INSTALL_WARTE_INTERVALL:-3}"
  done
  return 1
}

server_info_aussen() {
  local i
  for i in $(seq 1 "${PULSE_INSTALL_WARTE_VERSUCHE:-20}"); do
    curl -fsS -m 5 "https://${SRV_HOST}/.well-known/pulse-server-info" 2>/dev/null && return 0
    sleep "${PULSE_INSTALL_WARTE_INTERVALL:-3}"
  done
  return 1
}

# Ist der Server mit einem Pulse-Konto verbunden? $1 = Antwort von
# pulse-server-info. Ältere Server kennen das Feld `verbunden` nicht; dort
# heisst eine gesetzte Instanz-Nummer dasselbe (instance_id ist null, solange
# keine gesetzt ist).
ist_verbunden() {
  case "$1" in
    *'"verbunden":true'*|*'"verbunden": true'*) return 0 ;;
    *'"verbunden"'*) return 1 ;;
  esac
  printf '%s' "$1" | grep -qE '"instance_id"[[:space:]]*:[[:space:]]*"[0-9]+"'
}

verbinden_spaeter() {
  warn "Your server is running, but it is not connected to a Pulse account yet."
  warn "Connect later: docker exec -it ${CONTAINER} pulse-connect"
}

# --- Mit einem Pulse-Konto verbinden (pulse-connect im Container) ------- #
#
# Der letzte Schritt einer Installation (Spec E1/E6): pulse-connect fragt bei
# der Cloud einen Gerätecode an, zeigt Link und Code und wartet, bis der
# Betreiber im Browser bestätigt. Es braucht ein Terminal; `--no-restart`,
# weil der Neustart hier geschieht — so sieht der Installer, wann der Server
# mit den abgeholten Zugangsdaten wieder steht.
#
# Ein schon verbundener Server (Neuinstallation auf altem Volumen, Bestand)
# wird nicht angefasst: pulse-connect fragte dort nach, ob er einem anderen
# Konto gehören soll, und das entscheidet niemand nebenbei.
#
# Nie ein Fehler-Exit: Der Server läuft auch unverbunden, er nimmt nur noch
# niemanden auf. Abbruch (Strg+C), abgelaufener oder abgelehnter Code, von
# aussen nicht erreichbar — alles endet mit dem Hinweis, wie man es nachholt.
server_verbinden() {
  local info
  info="$(server_info_innen || true)"
  if [ -z "$info" ]; then
    warn "Your server does not answer inside the container yet — skipping the connection step."
    warn "  docker logs ${CONTAINER} 2>&1 | tail -50"
    verbinden_spaeter
    return 0
  fi
  if ist_verbunden "$info"; then
    VERBUNDEN=1
    log "This server is already connected to a Pulse account."
    log "To connect it to a different account:  docker exec -it ${CONTAINER} pulse-connect"
    return 0
  fi
  if ! { : <"$TTY_GERAET"; } 2>/dev/null; then
    warn "No terminal available — connecting needs one."
    verbinden_spaeter
    return 0
  fi
  log "Connecting your server to your Pulse account…"
  if ! docker exec -it "$CONTAINER" pulse-connect --no-restart <"$TTY_GERAET"; then
    verbinden_spaeter
    return 0
  fi
  # setup-status vorher leeren: sonst sähe warte_auf_start bis zum ersten
  # Startskript noch das „fertig“ des vorigen Laufs.
  docker exec "$CONTAINER" rm -f /data/setup-status >/dev/null 2>&1 || true
  log "Restarting Pulse with the new connection…"
  if ! docker restart "$CONTAINER" >/dev/null; then
    warn "The restart failed. Restart it yourself:  docker restart ${CONTAINER}"
    return 0
  fi
  warte_auf_start
  VERBUNDEN=1
}

# --- Zugangsdaten für die Prüfung aus der Cloud ------------------------- #
#
# Die Prüfung weist sich mit den Zugangsdaten der Instanz aus
# (routes_selfhost_diagnose.py, Weg 2). Ein Bestandsserver hat sie schon in
# $ENV_FILE (bestand_uebernehmen), ein frisch verbundener nur im Datenvolumen
# — pulse-connect hat sie dort abgelegt. Gelesen wird über `docker exec`, und
# nichts davon wird ausgegeben.
zugang_aus_volumen() {
  if [ -z "$CLIENT_SECRET" ]; then
    zugang_lesen <<<"$(docker exec "$CONTAINER" cat /data/pulse/verbindung.env 2>/dev/null || true)"
  fi
  [ -n "$INSTANCE_ID" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]
}
```

**Block 17 — alte Zeilen 1314–1342 ersetzen.** Alt:

```bash
# 8) Die Prüfung von aussen — das Einzige, was der Server über sich selbst
# NICHT sagen kann. Die Cloud geht die ganze Kette ab (DNS, Zertifikat,
# Routing, CORS, WebSocket-Upgrade, UDP) und benennt das Glied, das fehlt.
#
# Die eigene Aussenadresse kommt AUS DEM CONTAINER, nicht aus einem zweiten
# Aufruf an einen fremden Dienst: dort steht genau die Zahl, mit der Pulse
# selbst arbeitet (04-init-coturn), und es entsteht keine neue Abhaengigkeit.
pruefung_von_aussen() {
  local antwort eigene
  antwort="$(curl -fsS -m 60 -X POST \
    "${CLOUD_ORIGIN}/api/auth/selfhost/diagnose/${INSTANCE_ID}" \
    -H "X-Pulse-Client-Id: ${CLIENT_ID}" \
    -H "X-Pulse-Client-Secret: ${CLIENT_SECRET}" \
    -H "X-Pulse-Container-Name: ${CONTAINER}" 2>/dev/null)" || return 1
  [ -n "$antwort" ] || return 1
  command -v python3 >/dev/null 2>&1 || { printf '%s\n' "$antwort"; return 0; }
  eigene="$(docker exec "$CONTAINER" sed -n 's/^external-ip=//p' \
    /etc/coturn/turnserver.conf 2>/dev/null | tr -d '\r' | head -n1 || true)"
  printf '%s' "$antwort" \
    | PULSE_EIGENE_IP="$eigene" PULSE_CONTAINER_NAME="$CONTAINER" python3 -c "$PY_BERICHT"
}

log "Checking your server from the outside — this is what your users will see:"
if pruefung_von_aussen; then
  :
else
  warn "Could not run the external check right now."
  warn "Run it on this machine any time:  docker exec $CONTAINER pulse-doctor"
  warn "Or in the Pulse app: My Instances → Check connection."
```

Neu:

```bash
# Die Prüfung von aussen — das Einzige, was der Server über sich selbst NICHT
# sagen kann. Die Cloud geht die ganze Kette ab (DNS, Zertifikat, Routing,
# CORS, WebSocket-Upgrade, UDP, Betreiber-Erkennung) und benennt das Glied,
# das fehlt.
#
# Die Zugangsdaten gehen über stdin an curl (`-K -`), nicht über die
# Befehlszeile — die ist für jeden lokalen Nutzer in `ps` sichtbar, solange
# der Aufruf läuft.
#
# Die eigene Aussenadresse kommt AUS DEM CONTAINER, nicht aus einem zweiten
# Aufruf an einen fremden Dienst: dort steht genau die Zahl, mit der Pulse
# selbst arbeitet (04-init-coturn), und es entsteht keine neue Abhaengigkeit.
pruefung_von_aussen() {
  local antwort eigene
  zugang_aus_volumen || return 1
  antwort="$(printf 'header = "X-Pulse-Client-Id: %s"\nheader = "X-Pulse-Client-Secret: %s"\n' \
      "$CLIENT_ID" "$CLIENT_SECRET" \
    | curl -fsS -m 60 -K - -X POST \
      "${CLOUD_ORIGIN}/api/auth/selfhost/diagnose/${INSTANCE_ID}" \
      -H "X-Pulse-Container-Name: ${CONTAINER}" 2>/dev/null)" || return 1
  [ -n "$antwort" ] || return 1
  command -v python3 >/dev/null 2>&1 || { printf '%s\n' "$antwort"; return 0; }
  eigene="$(docker exec "$CONTAINER" sed -n 's/^external-ip=//p' \
    /etc/coturn/turnserver.conf 2>/dev/null | tr -d '\r' | head -n1 || true)"
  printf '%s' "$antwort" \
    | PULSE_EIGENE_IP="$eigene" PULSE_CONTAINER_NAME="$CONTAINER" python3 -c "$PY_BERICHT"
}

# ======================================================================== #
# Ablauf
# ======================================================================== #

# 1) Adresse festlegen, Bestand lesen, Umgebung erkennen, Modus wählen. Nichts
# davon verändert etwas auf der Maschine.
frage_adresse
pruefe_adresse
log "Server address: ${SRV_HOST}"
bestand_uebernehmen
decide_mode
build_run_args
print_plan

# 1b) Ports prüfen, bevor irgendetwas verändert wird. VOR dem Dry-Run-Ausstieg
# (Fund 4, Schlussprüfung): diese Prüfung liest nur, und der Vorschau-Modus ist
# gerade der, in dem ein Betreiber einen Konflikt sehen will — vorher meldete
# ein Dry-Run auf einer Maschine mit belegtem Port trotzdem einen grünen Plan.
check_ports

# 1c) Aus demselben Grund wie 1b, ebenfalls VOR dem Dry-Run-Ausstieg: lieber
# jetzt scheitern als mit halb eingerichtetem Server. Ersetzt NICHT die
# gleiche Prüfung in `sichere_container_ersetzung` weiter unten (s. dort).
pruefe_container_konflikt "Nothing has been changed yet."
pruefe_registry_zugang

if [ -n "$DRY_RUN" ]; then
  echo
  log "DRY RUN — nothing changed."
  log "Planned container start:"
  printf '    docker run'; printf ' %q' "${RUN_ARGS[@]}"; echo
  exit 0
fi

# 1d) $PULSE_DIR muss beschreibbar sein — NACH dem Dry-Run-Ausstieg (anders
# als 1b/1c): ein Dry-Run verspricht "nothing changed", und diese Prüfung legt
# das Verzeichnis tatsächlich an (s. Begründung bei der Funktion), das wäre in
# einem Dry-Run ein echter, wenn auch harmloser Seiteneffekt.
pruefe_pulse_dir_schreibbar

# 2) Konfiguration schreiben (chmod 600).
schreibe_konfiguration
log "Configuration written: ${ENV_FILE} (readable by root only)"

# 3) Container starten. Anmelden nur am Spiegel registry.howispulse.com
# (Bestand, s. pruefe_registry_zugang) — das öffentliche Bild braucht keins.
case "$IMAGE" in
  registry.howispulse.com/*)
    log "Logging in to Pulse registry (instance credentials)…"
    printf '%s' "$CLIENT_SECRET" | docker login registry.howispulse.com -u "$CLIENT_ID" --password-stdin \
      || die "Registry login failed — instance credentials rejected (suspended or wrong instance?)." ;;
esac
log "Pulling image ${IMAGE}…"
docker pull "$IMAGE"
sichere_container_ersetzung
log "Starting Pulse (${MODE})…"
docker run "${RUN_ARGS[@]}" >/dev/null

# 4) Auto-Update — Host-systemd-Timer statt eines socket-haltenden Containers.
# Kein Container braucht den Docker-Socket; der Update-Code ist das oben
# generierte, lesbare Skript. PULSE_NO_AUTOUPDATE=1 schaltet es ab
# (PULSE_NO_WATCHTOWER bleibt als Alias erhalten).
# Migration: einen früher angelegten Watchtower-Container ablösen.
docker rm -f pulse-watchtower >/dev/null 2>&1 || true
if [ -z "${PULSE_NO_AUTOUPDATE:-${PULSE_NO_WATCHTOWER:-}}" ]; then
  write_update_script
  log "Update helper written: ${UPDATE_SH}"
  if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    install_update_timer
    log "Auto-updates enabled (systemd timer 'pulse-update.timer', checks every 5 min)."
  elif command -v crontab >/dev/null 2>&1; then
    install_update_cron
    log "Auto-updates enabled (user crontab, checks every 5 min). 'crontab -l' to view."
  else
    warn "No root+systemd and no crontab — auto-update could not be scheduled."
    warn "Update manually anytime:   ${UPDATE_SH}"
  fi
fi

# 5) Startfortschritt verfolgen (s. warte_auf_start).
log "Starting up — this takes about a minute:"
warte_auf_start

# 6) Falls eine Route nötig ist, sie + den Reload-Befehl konkret ausgeben.
#
# BEVOR geprüft wird, nicht danach: im Modus `static-docker` hat der Container
# keinen veröffentlichten Port, er ist also über https://<hostname> erst
# erreichbar, NACHDEM diese Route steht. Früher stand die Prüfung davor und
# lief zwangsläufig fünf Minuten ins Leere, bevor der Betreiber überhaupt
# erfuhr, was er noch zu tun hat.
if [ "$MODE" = "static-docker" ] || [ "$MODE" = "hostproxy" ]; then
  if [ "$MODE" = "static-docker" ]; then TARGET="${CONTAINER}:${HTTP_PORT}"; else TARGET="127.0.0.1:${HTTP_PORT}"; fi
  # Reload-Befehl nach erkanntem Proxy (bei dockerisiertem statischem Proxy
  # kennen wir den Container-Namen → konkreter Befehl).
  case "$PROXY_KIND" in
    static-caddy) RELOAD_CMD="docker exec ${PROXY_CONTAINER} caddy reload --config /etc/caddy/Caddyfile" ;;
    static-nginx) RELOAD_CMD="docker exec ${PROXY_CONTAINER} nginx -s reload" ;;
    *)            RELOAD_CMD="# reload your reverse proxy, e.g.:  sudo systemctl reload caddy   (or: nginx -s reload)" ;;
  esac
  cat <<EOF

  ----------------------------------------------------------------
  Last step — ONE route in your existing reverse proxy.
  (If a route for ${SRV_HOST} already exists, just point it at http://${TARGET}.)

  Caddy — add to your Caddyfile:
      ${SRV_HOST} {
          reverse_proxy ${TARGET}
      }
  nginx — inside the server block (WebSockets must pass through):
      location / {
          proxy_pass http://${TARGET};
          proxy_http_version 1.1;
          proxy_set_header Upgrade \$http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host \$host;
      }

  Then reload the proxy:
      ${RELOAD_CMD}
  ----------------------------------------------------------------

EOF
  # Ohne die Route kann keine Prüfung von aussen gelingen — also erst fragen.
  printf '  Press Enter once the route is in place (or Ctrl-C to check later)… '
  # Mit Frist: ein unbeaufsichtigter Lauf mit Terminal haenge sonst fuer immer.
  read -r -t 600 _ <"$TTY_GERAET" 2>/dev/null || true
  echo
fi

# 7) Antwortet der Server unter seiner eigenen Adresse?
#
# Ein Abruf von /.well-known/pulse-server-info prüft DNS, Port 443, Zertifikat
# und Routing in einem Schritt. Ein Fehlschlag hier ist kein Beweis: etliche
# Netze erreichen ihren eigenen öffentlichen Namen von innen nicht (kein
# Hairpin-NAT). Deshalb nur eine Warnung — ob die Cloud den Server erreicht,
# stellt pulse-connect im nächsten Schritt selbst fest.
log "Checking that your server answers under https://${SRV_HOST} …"
if server_info_aussen >/dev/null; then
  log "Your server answers under https://${SRV_HOST}."
else
  warn "Your server does not answer under https://${SRV_HOST} from this machine yet."
  warn "Check that the DNS record points at this machine and that ports 80 and 443 are open."
  warn "Some networks cannot reach their own public address from inside — the next step checks from outside."
  warn "Details:  docker exec ${CONTAINER} pulse-doctor"
fi

# 8) Mit dem Pulse-Konto verbinden (s. server_verbinden).
server_verbinden

# 9) Die Prüfung aus der Cloud — nur ein verbundener Server hat die
# Zugangsdaten, mit denen sie sich ausweist.
if [ -n "$VERBUNDEN" ]; then
  log "Checking your server from the outside — this is what your users will see:"
  if ! pruefung_von_aussen; then
    warn "Could not run the external check right now."
    warn "Run it on this machine any time:  docker exec $CONTAINER pulse-doctor"
    warn "Or in the Pulse app: My Instances → Check connection."
  fi
```

Danach: `grep -n -i "token" web/static/install.sh` zeigt nur noch die Zeilen um `ALTER_TOKEN`/`PULSE_BOOTSTRAP_TOKEN` und die eine Kopfzeile „ohne Antrag und ohne Token“.

- [ ] **Step 4: Bestehende Installer-Tests nachziehen und `install-jget.test.ts` löschen.** Die Zeilenangaben beziehen sich auf den heutigen Stand; je Datei von unten nach oben anwenden.

`web/test/install-anweisungen.test.ts` — der Ausschnitt reicht jetzt von Schritt 4 bis Schritt 6, die Warteschleife ist eine Funktion, und die Routen-Frage liest aus `TTY_GERAET`:

**Teil 1 — alte Zeilen 321–324 ersetzen.** Alt:

```ts
 * Führt die echten Schritte 5–7 aus `install.sh` End-zu-Ende aus (Schritt 5:
 * Auto-Update-Einrichtung; Schritt 6: Startfortschritt, hier vom gefälschten
 * `docker` sofort als „fertig" gemeldet — kein 60×5s-Warten im Test; Schritt
 * 7: die Proxy-Route). `id` wird gefälscht, damit IMMER der Crontab-Zweig
```

Neu:

```ts
 * Führt die echten Schritte 4–6 aus `install.sh` End-zu-Ende aus (Schritt 4:
 * Auto-Update-Einrichtung; Schritt 5: Startfortschritt über `warte_auf_start`,
 * hier vom gefälschten `docker` sofort als „fertig" gemeldet — kein
 * 60×5s-Warten im Test; Schritt 6: die Proxy-Route). `id` wird gefälscht, damit IMMER der Crontab-Zweig
```

**Teil 2 — alte Zeilen 361–370 ersetzen.** Alt:

```ts
  // Endanker ist NICHT das schliessende `EOF` des Route-Heredocs (Schritt 7
  // hat danach noch ein `fi`, das den `if [ "$MODE" = … ]`-Block von weiter
  // oben schliesst — ohne dieses `fi` bricht die generierte Shell mit
  // "Unerwartetes Dateiende" ab). `fi` selbst waere als Anker mehrdeutig (acht
  // Treffer allein in diesem Bereich), deshalb der nächste eindeutige
  // Kommentar direkt danach — als reiner Kommentar harmlos mitgeschnitten.
  const bereichText = bereich(
    quelle,
    '# 5) Auto-Update — Host-systemd-Timer statt eines socket-haltenden Containers.',
    '# Bericht der Aussen-Pruefung — eine Checkliste, kein Protokollauszug.'
```

Neu:

```ts
  // Endanker ist NICHT das schliessende `EOF` des Route-Heredocs (Schritt 6
  // hat danach noch ein `fi`, das den `if [ "$MODE" = … ]`-Block von weiter
  // oben schliesst — ohne dieses `fi` bricht die generierte Shell mit
  // "Unerwartetes Dateiende" ab). `fi` selbst waere als Anker mehrdeutig (acht
  // Treffer allein in diesem Bereich), deshalb der nächste eindeutige
  // Kommentar direkt danach — als reiner Kommentar harmlos mitgeschnitten.
  const bereichText = bereich(
    quelle,
    '# 4) Auto-Update — Host-systemd-Timer statt eines socket-haltenden Containers.',
    '# 7) Antwortet der Server unter seiner eigenen Adresse?'
```

**Teil 3 — alte Zeilen 390–395 ersetzen.** Alt:

```ts
log() { :; }
warn() { printf '__WARN__%s\\n' "$*"; }
err() { printf '__ERR__%s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
${funktion(quelle, 'write_update_script')}
${funktion(quelle, 'install_update_cron')}
```

Neu:

```ts
# Die Routen-Frage liest aus TTY_GERAET; /dev/null beantwortet sie sofort.
# Aus einem Terminal heraus läse \`read\` sonst wirklich von dort.
TTY_GERAET=/dev/null
log() { :; }
warn() { printf '__WARN__%s\\n' "$*"; }
err() { printf '__ERR__%s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
${funktion(quelle, 'write_update_script')}
${funktion(quelle, 'install_update_cron')}
${funktion(quelle, 'schritt_text')}
${funktion(quelle, 'warte_auf_start')}
```

`web/test/install-fremder-container.test.ts` — der Reihenfolge-Test misst jetzt, ob `pulse.env` geschrieben wurde, statt ob `curl` lief; die späte Meldung sagt, dass ein neuer Lauf sicher ist; zwei neue Fälle für das öffentliche Bild:

**Teil 1 — alte Zeilen 51–57 ersetzen.** Alt:

```ts
 * ZUSAMMENHÄNGENDEN AUSSCHNITT aus — von `check_ports` bis nach der
 * Token-Einlösung, inklusive der echten `curl`-Zeile —, gegen ein
 * gefälschtes `curl`, das eine Markerdatei hinterlässt, sobald es
 * aufgerufen wird. Ein Test, der nur behauptet „die Prüfung sitzt vor der
 * Einlösung" (weil er sie in dieser Reihenfolge selbst zusammenbaut), würde
 * eine künftige Umsortierung im echten Skript nicht bemerken — nur echter,
 * an Ort und Stelle ausgeführter Quelltext tut das.
```

Neu:

```ts
 * ZUSAMMENHÄNGENDEN AUSSCHNITT aus — von `check_ports` bis nach dem Schreiben
 * der Konfiguration. Ein Test, der nur behauptet „die Prüfung sitzt davor"
 * (weil er sie in dieser Reihenfolge selbst zusammenbaut), würde eine
 * künftige Umsortierung im echten Skript nicht bemerken — nur echter, an Ort
 * und Stelle ausgeführter Quelltext tut das.
 *
 * **Seit Oktober 2026 gibt es keinen Token mehr** (der Installer verbindet
 * den Server am Ende per `pulse-connect`). Die frühe Prüfung bleibt: sie
 * verhindert jetzt, dass ein von Anfang an aussichtsloser Lauf eine
 * Konfiguration hinterlässt. Der Reihenfolge-Test misst deshalb, ob
 * `pulse.env` geschrieben wurde, statt ob ein `curl` lief.
```

**Teil 2 — alte Zeilen 257–371 ersetzen.** Alt (115 Zeilen, Leerzeilen mitgezählt) — ab Zeile 257:

```ts
  /** Wurde `curl` (= die Token-Einlösung) überhaupt aufgerufen? */
  tokenAngefasst: boolean;
  /** Wurde das Ende des Ausschnitts erreicht (nach der Einlösung)? */
```

bis Zeile 371:

```ts
  // erneuter Versuch mit demselben Token wäre möglich.
  const ergebnis = pruefeUebernahme({ image: 'postgres:16' });
  assert.match(ergebnis.meldung, /already been redeemed/i);
```

Neu:

```ts
  /** Wurde die Konfiguration (`pulse.env`) geschrieben — die erste Änderung? */
  konfigGeschrieben: boolean;
  /** Wurde das Ende des Ausschnitts erreicht (nach dem Schreiben)? */
  ueberlebt: boolean;
  /** Die an `die` übergebene Meldung (leer, wenn nicht abgebrochen). */
  meldung: string;
}

/**
 * Führt den echten, wörtlich herausgeschnittenen Ausschnitt von `check_ports`
 * bis zur Zeile nach dem Schreiben der Konfiguration aus — inklusive der
 * frühen `pruefe_container_konflikt`-Zeile UND des echten
 * `schreibe_konfiguration`-Aufrufs. Ob `pulse.env` danach existiert, ist der
 * direkte Beweis, ob schon etwas verändert wurde, nicht nur eine Vermutung
 * über eine Zeilennummer.
 */
function reihenfolgeTest(container: { image: string } | null): Reihenfolge {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-reihenfolge-'));
  const pulseDir = join(dir, 'pulsedir');

  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  inspect)
    case "$*" in
      *Config.Image*) ${container ? `echo '${container.image}'` : 'exit 1'} ;;
      *State.Running*) ${container ? "echo 'true'" : 'exit 1'} ;;
      *) ${container ? 'exit 0' : 'exit 1'} ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  const skript = `
set -euo pipefail
CONTAINER=pulse
IMAGE="ghcr.io/oblivion-pictures/pulse:stable"
MODE=greenfield
TLS_MODE=auto
HTTP_PORT=8080
PULSE_DIR="${pulseDir}"
ENV_FILE="${join(pulseDir, 'pulse.env')}"
DRY_RUN=""
SRV_HOST=chat.example.org
CLOUD_ORIGIN=http://cloud.invalid
ADMIN_EMAIL=""
CLIENT_ID=""
CLIENT_SECRET=""
BESTAND_ZEILEN=""
log()  { :; }
warn() { :; }
err()  { :; }
die()  { printf '__DIE__%s\\n' "$*"; exit 9; }
port_busy() { return 1; }
udp_port_busy() { return 1; }
${funktion(quelle, 'eigener_container_laeuft')}
${funktion(quelle, 'ist_unser_container')}
${funktion(quelle, 'pruefe_container_konflikt')}
${funktion(quelle, 'pruefe_registry_zugang')}
${funktion(quelle, 'check_ports')}
${funktion(quelle, 'pruefe_pulse_dir_schreibbar')}
${funktion(quelle, 'schreibe_konfiguration')}
${bereich(quelle, 'check_ports', 'log "Configuration written: ${ENV_FILE} (readable by root only)"')}
echo __UEBERLEBT__
`;
  let stdout = '';
  try {
    stdout = execFileSync('bash', ['-c', skript], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8'
    });
  } catch (fehler) {
    const f = fehler as { stdout?: string };
    stdout = f.stdout ?? '';
  }

  const treffer = stdout.match(/__DIE__([\s\S]*?)(?:\n__UEBERLEBT__)?$/);
  return {
    konfigGeschrieben: existsSync(join(pulseDir, 'pulse.env')),
    ueberlebt: stdout.includes('__UEBERLEBT__'),
    meldung: treffer ? treffer[1] : ''
  };
}

test('ein fremder Container namens pulse wird nicht angerührt', () => {
  const ergebnis = pruefeUebernahme({ image: 'postgres:16' });
  assert.equal(ergebnis.abgebrochen, true);
  assert.match(ergebnis.meldung, /PULSE_CONTAINER/);
});

test('die späte Meldung sagt, dass die Konfiguration schon steht und ein neuer Lauf sicher ist', () => {
  // An der SPÄTEN Stelle ist pulse.env im echten Ablauf schon geschrieben —
  // die Meldung soll das sagen, statt den Eindruck zu erwecken, es sei noch
  // nichts geschehen.
  const ergebnis = pruefeUebernahme({ image: 'postgres:16' });
  assert.match(ergebnis.meldung, /running this command again is safe/i);
});

test('das öffentliche Bild ghcr.io/oblivion-pictures/pulse gilt als unser Container, auch mit anderem Tag', () => {
  const ergebnis = pruefeUebernahme(
    { image: 'ghcr.io/oblivion-pictures/pulse:edge' },
    'ghcr.io/oblivion-pictures/pulse:stable'
  );
  assert.equal(ergebnis.abgebrochen, false);
});

test('Gegenprobe: ein Cloud-Bild derselben Organisation (pulse-auth) bleibt fremd', () => {
  const ergebnis = pruefeUebernahme(
    { image: 'ghcr.io/oblivion-pictures/pulse-auth:latest' },
    'ghcr.io/oblivion-pictures/pulse:stable'
  );
  assert.equal(ergebnis.abgebrochen, true);
```

**Teil 3 — alte Zeilen 426–449 ersetzen.** Alt:

```ts
test('ein Fremdkonflikt bricht ab, BEVOR der Token eingelöst wird', () => {
  // Korrekturrunde 1: der Kern des Befunds. `curl` (die Token-Einlösung)
  // darf hier nicht aufgerufen worden sein — das ist der eigentliche
  // Nachweis der Reihenfolge, nicht nur, dass irgendwann abgebrochen wurde.
  const ergebnis = reihenfolgeTest({ image: 'postgres:16' });
  assert.equal(ergebnis.tokenAngefasst, false, 'curl wurde aufgerufen — die Prüfung kam zu spät');
  assert.equal(ergebnis.ueberlebt, false);
  assert.match(ergebnis.meldung, /PULSE_CONTAINER/);
  assert.match(ergebnis.meldung, /nothing has been consumed yet/i);
});

test('ohne Konflikt läuft die Token-Einlösung normal weiter (eigener Container)', () => {
  // Gegenprobe zum Reihenfolge-Test: beweist, dass die frühe Prüfung einen
  // legitimen Lauf nicht blockiert UND dass das Testgeschirr selbst in der
  // Lage ist, bis zur echten curl-Zeile durchzulaufen — sonst wäre der Test
  // oben auch bei einem kaputten Geschirr grün.
  const ergebnis = reihenfolgeTest({ image: 'registry.howispulse.com/pulse-allinone:edge' });
  assert.equal(ergebnis.tokenAngefasst, true);
  assert.equal(ergebnis.ueberlebt, true);
});

test('ohne Konflikt läuft die Token-Einlösung normal weiter (Erstinstallation)', () => {
  const ergebnis = reihenfolgeTest(null);
  assert.equal(ergebnis.tokenAngefasst, true);
```

Neu:

```ts
test('ein Fremdkonflikt bricht ab, BEVOR die Konfiguration geschrieben wird', () => {
  // Der Kern des Befunds: pulse.env darf hier nicht entstanden sein — das ist
  // der eigentliche Nachweis der Reihenfolge, nicht nur, dass irgendwann
  // abgebrochen wurde.
  const ergebnis = reihenfolgeTest({ image: 'postgres:16' });
  assert.equal(ergebnis.konfigGeschrieben, false, 'pulse.env existiert — die Prüfung kam zu spät');
  assert.equal(ergebnis.ueberlebt, false);
  assert.match(ergebnis.meldung, /PULSE_CONTAINER/);
  assert.match(ergebnis.meldung, /Nothing has been changed yet/);
});

test('ohne Konflikt wird die Konfiguration geschrieben (eigener Container)', () => {
  // Gegenprobe zum Reihenfolge-Test: beweist, dass die frühe Prüfung einen
  // legitimen Lauf nicht blockiert UND dass das Testgeschirr selbst bis zum
  // Schreiben durchlaufen kann — sonst wäre der Test oben auch bei einem
  // kaputten Geschirr grün.
  const ergebnis = reihenfolgeTest({ image: 'ghcr.io/oblivion-pictures/pulse:stable' });
  assert.equal(ergebnis.konfigGeschrieben, true);
  assert.equal(ergebnis.ueberlebt, true);
});

test('ohne Konflikt wird die Konfiguration geschrieben (Erstinstallation)', () => {
  const ergebnis = reihenfolgeTest(null);
  assert.equal(ergebnis.konfigGeschrieben, true);
```

`web/test/install-overrides.test.ts`:

**Teil 1 — alte Zeilen 187–191 ersetzen.** Alt:

```ts
  // Und sie muss vor der Token-Einloesung sitzen — das ist hier strukturell
  // erzwungen (der Test ruft nur decide_mode/build_run_args auf, niemals den
  // Token-Einloese-Teil), diese Zeile haelt die Erwartung trotzdem explizit
  // fest.
  assert.match(e.meldung, /consumed/);
```

Neu:

```ts
  // Und sie muss sagen, dass noch nichts verändert wurde — sonst fürchtet der
  // Admin einen halb eingerichteten Server. Strukturell ist das ohnehin so
  // (der Test ruft nur decide_mode/build_run_args auf), diese Zeile hält die
  // Erwartung an die Meldung trotzdem fest.
  assert.match(e.meldung, /Nothing has been changed yet/);
```

`web/test/install-proxy-erkennung.test.ts`:

**Teil 1 — alte Zeilen 346–348 ersetzen.** Alt:

```ts
  // Der Abbruch liegt vor der Token-Einloesung — das muss die Meldung sagen,
  // sonst befuerchtet der Admin einen verbrannten Token.
  assert.match(ergebnis.meldung, /consumed/);
```

Neu:

```ts
  // Der Abbruch liegt vor jeder Änderung — das muss die Meldung sagen, sonst
  // befürchtet der Admin einen halb eingerichteten Server.
  assert.match(ergebnis.meldung, /Nothing has been\s+changed yet/);
```

`web/test/install-schluss-reihenfolge.test.ts` — zwischen `decide_mode` und `pruefe_pulse_dir_schreibbar` steht jetzt `pruefe_registry_zugang`; das Bild ist das öffentliche:

**Teil 1 — alte Zeilen 13–35 ersetzen.** Alt:

```ts
 *      Laufs und lief NACH der Token-Einlösung. Wer `PULSE_DIR` ohne
 *      Schreibrechte setzt, verbrannte den Einmal-Token trotzdem — eine rohe
 *      `mkdir`-Fehlermeldung unter `set -e` sagt das nicht. Fix: eine neue
 *      `pruefe_pulse_dir_schreibbar()` läuft vor der Token-Einlösung, mit
 *      derselben "nothing has been consumed yet"-Meldungsform wie
 *      `check_ports`/`pruefe_container_konflikt`. Bewusst NACH dem
 *      Dry-Run-Ausstieg (anders als 1.): sie legt `$PULSE_DIR` tatsächlich
 *      an — ein echter, wenn auch harmloser Seiteneffekt, den ein Dry-Run
 *      ("nothing changed") nicht haben soll.
 *
 * **Wie das geht:** ein wörtlich aus `install.sh` herausgeschnittener
 * ZUSAMMENHÄNGENDER Ausschnitt des Hauptablaufs (`bereich()`, Muster aus
 * `install-fremder-container.test.ts`) — von der `decide_mode`-Zeile bis zur
 * `pruefe_pulse_dir_schreibbar`-Zeile, beides VOR der eigentlichen
 * Token-Einlösung (die selbst nicht mehr im Ausschnitt steckt). Ein Test, der
 * nur behauptet „die Prüfungen laufen vor dem Ausstieg" (weil er sie in
 * dieser Reihenfolge selbst zusammenbaut), würde eine künftige Umsortierung
 * im echten Skript nicht bemerken — nur echter, an Ort und Stelle
 * ausgeführter Quelltext tut das. `decide_mode`/`build_run_args`/
 * `print_plan` sind hier bewusst gefälscht (ihre eigene Logik hat eigene
 * Tests, u. a. `install-overrides.test.ts`) — echt bleibt nur, WAS in
 * welcher Reihenfolge läuft: `check_ports`, `ist_unser_container`,
 * `pruefe_container_konflikt`, `pruefe_pulse_dir_schreibbar`.
```

Neu:

```ts
 *      Laufs und lief erst beim Schreiben der Konfiguration. Wer `PULSE_DIR`
 *      ohne Schreibrechte setzt, bekam eine rohe `mkdir`-Fehlermeldung unter
 *      `set -e`. Fix: `pruefe_pulse_dir_schreibbar()` läuft vor der ersten
 *      Änderung, mit derselben "Nothing has been changed yet"-Meldungsform
 *      wie `check_ports`/`pruefe_container_konflikt`. Bewusst NACH dem
 *      Dry-Run-Ausstieg (anders als 1.): sie legt `$PULSE_DIR` tatsächlich
 *      an — ein echter, wenn auch harmloser Seiteneffekt, den ein Dry-Run
 *      ("nothing changed") nicht haben soll.
 *
 * **Wie das geht:** ein wörtlich aus `install.sh` herausgeschnittener
 * ZUSAMMENHÄNGENDER Ausschnitt des Hauptablaufs (`bereich()`, Muster aus
 * `install-fremder-container.test.ts`) — von der `decide_mode`-Zeile bis zur
 * `pruefe_pulse_dir_schreibbar`-Zeile, beides VOR dem Schreiben der
 * Konfiguration (das selbst nicht mehr im Ausschnitt steckt). Ein Test, der
 * nur behauptet „die Prüfungen laufen vor dem Ausstieg" (weil er sie in
 * dieser Reihenfolge selbst zusammenbaut), würde eine künftige Umsortierung
 * im echten Skript nicht bemerken — nur echter, an Ort und Stelle
 * ausgeführter Quelltext tut das. `decide_mode`/`build_run_args`/
 * `print_plan` sind hier bewusst gefälscht (ihre eigene Logik hat eigene
 * Tests, u. a. `install-overrides.test.ts`) — echt bleibt nur, WAS in
 * welcher Reihenfolge läuft: `check_ports`, `ist_unser_container`,
 * `pruefe_container_konflikt`, `pruefe_registry_zugang`,
 * `pruefe_pulse_dir_schreibbar`.
```

**Teil 2 — alte Zeile 151 ersetzen.** Alt:

```ts
IMAGE="registry.howispulse.com/pulse-allinone:edge"
```

Neu:

```ts
IMAGE="ghcr.io/oblivion-pictures/pulse:stable"
CLIENT_ID=""
CLIENT_SECRET=""
```

**Teil 3 — nach alter Zeile 168 einfügen.** Die alten Zeilen 167–169 lauten (eingefügt wird vor der letzten davon):

```ts
${funktion(quelle, 'ist_unser_container')}
${funktion(quelle, 'pruefe_container_konflikt')}
${funktion(quelle, 'pruefe_pulse_dir_schreibbar')}
```

Einfügen:

```ts
${funktion(quelle, 'pruefe_registry_zugang')}
```

**Teil 4 — alte Zeile 221 ersetzen.** Alt:

```ts
test('ein unbeschreibbares PULSE_DIR bricht ab, bevor irgendetwas verbraucht wird', () => {
```

Neu:

```ts
test('ein unbeschreibbares PULSE_DIR bricht ab, bevor irgendetwas verändert wird', () => {
```

**Teil 5 — alte Zeilen 232–241 ersetzen.** Alt:

```ts
    // Zeilenumbrüche in der Meldung: die Wendung "consumed yet" bricht
    // absichtlich um, daher whitespace-tolerant statt eines wörtlichen
    // Regex-Treffers über die Zeilengrenze.
    assert.match(e.meldung.replace(/\s+/g, ' '), /nothing has been consumed yet/i);
  } finally {
    chmodSync(basis, 0o700);
  }
});

test('ein beschreibbares PULSE_DIR läuft bis zur Token-Einlösung durch (Gegenprobe)', () => {
```

Neu:

```ts
    // Zeilenumbrüche in der Meldung: whitespace-tolerant statt eines
    // wörtlichen Regex-Treffers über eine Zeilengrenze.
    assert.match(e.meldung.replace(/\s+/g, ' '), /nothing has been changed yet/i);
  } finally {
    chmodSync(basis, 0o700);
  }
});

test('ein beschreibbares PULSE_DIR läuft bis zum Schreiben der Konfiguration durch (Gegenprobe)', () => {
```

Dann: `git rm web/test/install-jget.test.ts`.

`install-erststart-absturzschleife.test.ts`, `install-updater.test.ts`, `install-crontab.test.ts`, `install-eigener-container.test.ts`, `install-traefik-label.test.ts` bleiben unverändert: ihre Anker (`STATUS_ROH="$(docker exec …`, `Zustandserkennung Ende`, `if [ -n "$ABBRUCH_CRASH" ]; then`, `Startup is taking longer than expected`, die Funktionsnamen) stehen wörtlich in `warte_auf_start` bzw. unverändert im Skript.

- [ ] **Step 5: Alle Installer-Tests grün.**

Run: `cd web && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test test/install-*.test.ts && bash -n static/install.sh`

Expected: `ℹ tests 100`, `ℹ pass 100`, `ℹ fail 0`; `bash -n` ohne Ausgabe. (Vorher 78 Tests; −5 aus `install-jget`, +2 in `install-fremder-container`, +25 neu.)

Run: `cd web && pnpm test:unit`

Expected: `ℹ fail 0`.

- [ ] **Step 6: Adressform mit der Cloud abgleichen (Etappe 1 muss gelandet sein).** Die Cloud ist maßgeblich (`dcc_shared.hostname.normalisiere_hostname`); was der Installer als Adresse in `pulse.env` schreibt, muss sie unverändert annehmen, und was sie ablehnt, muss der Installer ablehnen.

Run: `uv run --all-packages python -c "from dcc_shared.hostname import normalisiere_hostname as n; print([n(x) for x in ['chat.example.org', 'Chat.Example.org.', 'localhost', '203.0.113.7', 'chat_example.org', '-chat.example.org']])"`

Expected: `['chat.example.org', 'chat.example.org', None, None, None, None]`. Weicht ein Wert ab, `pruefe_adresse` und die beiden Adress-Tests in `install-ohne-token.test.ts` an die Cloud angleichen (nicht umgekehrt) und Step 5 wiederholen.

- [ ] **Step 7: nginx-Kommentar.** `infra/prod/web-nginx.conf`, Zeile 416:

Alt:

```nginx
    # `curl -fsSL https://howispulse.com/install | bash -s -- <TOKEN>` lädt dieses
```

Neu:

```nginx
    # `curl -fsSL https://howispulse.com/install | bash` lädt dieses
```

- [ ] **Step 8: Vereinfachen.** `code-simplifier`-Agent über `web/static/install.sh` und die drei neuen Testdateien; danach Step 5 erneut (100 grün), dann `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 9: Commit.**

```bash
git add web/static/install.sh web/test/install-ohne-token.test.ts web/test/install-bestand.test.ts \
  web/test/install-verbinden.test.ts web/test/install-anweisungen.test.ts \
  web/test/install-fremder-container.test.ts web/test/install-overrides.test.ts \
  web/test/install-proxy-erkennung.test.ts web/test/install-schluss-reihenfolge.test.ts \
  infra/prod/web-nginx.conf
git rm web/test/install-jget.test.ts
git commit -m "feat(self-host): Installer ohne Token, verbindet den Server am Ende per pulse-connect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.2: Compose-Dateien, Beispielkonfiguration, Update-Skript

**Files:**
- Modify: `infra/self-host/docker-compose.yml:3-49`
- Modify: `infra/self-host/docker-compose.behind-proxy.yml:8-53`
- Modify: `infra/self-host/.env.example:2-45`
- Modify: `infra/self-host/pulse-update.sh:5,49-61`
- Modify: `infra/self-host/tests/pulse-update-faelle.sh:33-34,87` (läuft im Gate, Bereich `infra`)

**Interfaces:**
- Consumes: `docker exec -it pulse pulse-connect` (Etappe 2); Bild `ghcr.io/oblivion-pictures/pulse:stable`.
- Produces: Compose-Weg mit einer einzigen `.env`-Zeile `PULSE_HOSTNAME=…`; `pulse-update.sh` meldet sich nur noch am Spiegel `registry.howispulse.com` an (Bestand), nie für GHCR. Ausgeliefert unter `https://howispulse.com/self-host/{docker-compose.yml,docker-compose.behind-proxy.yml,env.example,pulse-update.sh}` (`web/Dockerfile` kopiert sie, `web/vite.config.ts` spiegelt sie im Dev).

- [ ] **Step 1: Testfälle für die Anmeldung ergänzen** (`infra/self-host/tests/pulse-update-faelle.sh`). Die Docker-Attrappe liefert das Bild aus `IMAGE_NAME` und hinterlässt bei `docker login` eine Markerdatei — das Skript leitet die Ausgabe von `docker login` nach `/dev/null`, ein Nachweis über stdout sähe nie etwas.

**Teil 1 — alte Zeilen 33–34 ersetzen.** Alt:

```bash
        --images)   echo reg/probe:t ;;
      esac; exit 0 ;;
```

Neu:

```bash
        --images)   echo "${IMAGE_NAME:-reg/probe:t}" ;;
      esac; exit 0 ;;
  # Das Skript leitet die Ausgabe von `docker login` nach /dev/null — der
  # Nachweis geht deshalb über eine Markerdatei, nicht über stdout.
  "login registry.howispulse.com") cat > /dev/null; touch "$LOGIN_MARKER"; exit 0 ;;
```

**Teil 2 — nach alter Zeile 87 einfügen.** Die alten Zeilen 86–88 lauten (eingefügt wird vor der letzten davon):

```bash
  CONTAINER_STATUS=restarting REV_NEU=bbb REV_LAUFEND=aaa

# Hinter einem Proxy liegt nur docker-compose.behind-proxy.yml im Verzeichnis.
```

Einfügen:

```bash
# Anmeldung nur am Spiegel registry.howispulse.com (Bestand). Das öffentliche
# Bild auf GHCR braucht keine — auch dann nicht, wenn die .env aus der
# Freigabe-Zeit noch Zugangsdaten trägt.
pruefe_login() {  # pruefe_login <name> <erwartet: ja|nein> <env…>
  local name="$1" erwartet="$2"; shift 2
  local ausgabe login=nein
  rm -f "$arbeit/login-aufgerufen"
  ausgabe="$(cd "$arbeit/proj" && env PATH="$arbeit/bin:$PATH" LOGIN_MARKER="$arbeit/login-aufgerufen" "$@" bash ./pulse-update.sh 2>&1 || true)"
  [ -e "$arbeit/login-aufgerufen" ] && login=ja
  if [ "$login" != "$erwartet" ]; then
    echo "✗ $name: login=$login, erwartet=$erwartet"; echo "$ausgabe" | sed 's/^/    /'; fehler=1; return
  fi
  echo "✓ $name"
}
printf 'PULSE_CLOUD_CLIENT_ID=cid\nPULSE_CLOUD_CLIENT_SECRET=geheim\n' > "$arbeit/proj/.env"
pruefe_login "Spiegel + Zugangsdaten → Anmeldung" ja \
  IMAGE_NAME=registry.howispulse.com/pulse-allinone:stable CONTAINER_STATUS=running REV_NEU=aaa REV_LAUFEND=aaa
pruefe_login "GHCR + Zugangsdaten in der .env → keine Anmeldung" nein \
  IMAGE_NAME=ghcr.io/oblivion-pictures/pulse:stable CONTAINER_STATUS=running REV_NEU=aaa REV_LAUFEND=aaa
rm -f "$arbeit/proj/.env"
pruefe_login "GHCR ohne .env → keine Anmeldung" nein \
  IMAGE_NAME=ghcr.io/oblivion-pictures/pulse:stable CONTAINER_STATUS=running REV_NEU=aaa REV_LAUFEND=aaa
```

- [ ] **Step 2: Laufen lassen — ein Fall muss scheitern.**

Run: `bash infra/self-host/tests/pulse-update-faelle.sh`

Expected: `✗ GHCR + Zugangsdaten in der .env → keine Anmeldung: login=ja, erwartet=nein`, Exit 1. (Heute meldet sich das Skript an, sobald die `.env` ein Secret trägt — egal, welches Bild die Compose-Datei zieht; ein Login-Fehler dort hielte das Update an.)

- [ ] **Step 3: `infra/self-host/pulse-update.sh` — Anmeldung nur für den Spiegel.** Die Anmeldung wandert hinter die Abfrage des Bildes:

**Block 1 — alte Zeile 5 ersetzen.** Alt:

```bash
# Update-Lauf: Registry-Login aus der .env, Image pullen, Container nur bei
```

Neu:

```bash
# Update-Lauf: Registry-Login (nur Bestand, s. unten), Image pullen, Container nur bei
```

**Block 2 — alte Zeilen 49–61 ersetzen.** Alt:

```bash
# Registry-Login aus der .env — gleiche Muster wie in Schritt 3 des Compose-
# Headers. Ohne Secret (z. B. GHCR-Image via PULSE_IMAGE) kein Login nötig.
if [ -f .env ] && grep -q '^PULSE_CLOUD_CLIENT_SECRET=' .env; then
  grep -oP '^PULSE_CLOUD_CLIENT_SECRET=\K.*' .env \
    | docker login registry.howispulse.com \
        -u "$(grep -oP '^PULSE_CLOUD_CLIENT_ID=\K.*' .env)" --password-stdin >/dev/null 2>&1 \
    || { echo "pulse-update: registry login failed, will retry next run" >&2; exit 0; }
fi

# Erster Service des Projekts (das Compose-File hat genau einen: `pulse`).
service="$(docker compose config --services | head -n1)"
image="$(docker compose config --images | head -n1)"
[ -n "$image" ] || { echo "pulse-update: kein Image in compose config" >&2; exit 1; }
```

Neu:

```bash
# Erster Service des Projekts (das Compose-File hat genau einen: `pulse`).
service="$(docker compose config --services | head -n1)"
image="$(docker compose config --images | head -n1)"
[ -n "$image" ] || { echo "pulse-update: kein Image in compose config" >&2; exit 1; }

# Registry-Login nur für den Spiegel registry.howispulse.com. Den ziehen allein
# Installationen aus der Freigabe-Zeit (vor Oktober 2026), deren .env die
# Zugangsdaten trägt. Das öffentliche Bild auf GHCR braucht keine Anmeldung —
# und ein Login-Fehler hielte das Update dort grundlos an.
case "$image" in
  registry.howispulse.com/*)
    if [ -f .env ] && grep -q '^PULSE_CLOUD_CLIENT_SECRET=' .env; then
      grep -oP '^PULSE_CLOUD_CLIENT_SECRET=\K.*' .env \
        | docker login registry.howispulse.com \
            -u "$(grep -oP '^PULSE_CLOUD_CLIENT_ID=\K.*' .env)" --password-stdin >/dev/null 2>&1 \
        || { echo "pulse-update: registry login failed, will retry next run" >&2; exit 0; }
    fi ;;
esac
```

- [ ] **Step 4: Compose-Dateien und Beispielkonfiguration.** Englisch für Betreiber in den Compose-Köpfen, Deutsch in `.env.example` (wie bisher).

`infra/self-host/docker-compose.yml`:

**Block 1 — alte Zeilen 3–49 ersetzen.** Alt (47 Zeilen, Leerzeilen mitgezählt) — ab Zeile 3:

```yaml
#   1. Get the ready-made config in the app: Settings → Your own server →
#      My Instances → "Set up server" → "Manual installation" → "Download .env".
#      It is filled in completely — the Cloud assigns instance ID, client ID and
```

bis Zeile 49:

```yaml
    # --password-stdin, not -p: the latter puts the secret into `ps aux` and
    # your shell history.
    image: registry.howispulse.com/pulse-allinone:stable
```

Neu:

```yaml
#   1. Put this file in an empty directory and create a file named .env next
#      to it with one line — the public address of your server:
#
#        PULSE_HOSTNAME=chat.example.org
#
#      The address needs a DNS record pointing at this machine.
#
#   2. docker compose up -d
#
#   3. Connect the server to your Pulse account. It shows a link and a code;
#      open the link, sign in to Pulse and confirm:
#
#        docker exec -it pulse pulse-connect
#
#      Until then the server runs, but nobody can sign in to it.
#
#   Optional switches (own certificate, PULSE_PUBLIC_IP behind NAT, backup
#   interval, log level) are in the commented reference at
#   https://howispulse.com/self-host/env.example — for looking up, not for
#   filling in.
#
# Requirement for auto-TLS: ports 80 + 443 are publicly reachable and the DNS A
# record for PULSE_HOSTNAME points at this machine — the embedded Caddy then
# fetches the Let's Encrypt certificate itself.
#
# Is a reverse proxy ALREADY running on 80/443 (nginx/Traefik/Caddy/NPM)? Then
# use docker-compose.behind-proxy.yml instead.
#
# Updates — deliberately NO auto-updater container in this file (an updater with
# a mounted Docker socket is root-equivalent on the host):
#   docker compose pull && docker compose up -d
# manually or as a host cron/timer. Ready-made update script as a template:
#   https://howispulse.com/self-host/pulse-update.sh
# (drop it next to this file — examples for cron/systemd are in the script
# header). The one-command
# installer (see the guide at https://howispulse.com/self-host/guide) sets up
# such a host systemd timer automatically — if you take the manual Compose
# path, you manage updates yourself.

services:
  pulse:
    # Public image, no login needed. Servers set up before October 2026 may
    # keep registry.howispulse.com/pulse-allinone:stable here — that one needs
    # the credentials from their .env (docker login, see pulse-update.sh).
    image: ghcr.io/oblivion-pictures/pulse:stable
```

`infra/self-host/docker-compose.behind-proxy.yml`:

**Block 1 — alte Zeilen 8–53 ersetzen.** Alt (46 Zeilen, Leerzeilen mitgezählt) — ab Zeile 8:

```yaml
#   1. Get the ready-made config in the app: Settings → Your own server →
#      My Instances → "Set up server" → "Manual installation" → "Download .env".
#      It is filled in completely — the Cloud assigns instance ID, client ID and
```

bis Zeile 53:

```yaml
    # --password-stdin, not -p: the latter puts the secret into `ps aux` and
    # your shell history.
    image: registry.howispulse.com/pulse-allinone:stable
```

Neu:

```yaml
#   1. Put this file in an empty directory and create a file named .env next
#      to it with one line — the public address of your server:
#
#        PULSE_HOSTNAME=chat.example.org
#
#   2. docker compose -f docker-compose.behind-proxy.yml up -d
#
#   3. Add ONE rule in your own proxy:
#        chat.example.com  →  http://127.0.0.1:8080
#      WebSocket upgrade must pass through (Nginx Proxy Manager: tick "WebSocket
#      Support"). If your proxy runs IN A CONTAINER it cannot reach the host's
#      127.0.0.1 — both then need a shared Docker network and the rule points at
#      the container name (`pulse:8080`). Copy-paste snippets for Caddy/nginx/NPM
#      and the container case: https://howispulse.com/self-host/guide →
#      "Add the proxy rule".
#
#   4. Connect the server to your Pulse account. It shows a link and a code;
#      open the link, sign in to Pulse and confirm:
#
#        docker exec -it pulse pulse-connect
#
#      Pulse checks from outside that the server answers under its address,
#      so the proxy rule from step 3 must be in place first. Until you connect,
#      the server runs, but nobody can sign in to it.
#
#   Optional switches (own certificate, PULSE_PUBLIC_IP behind NAT, backup
#   interval, log level) are in the commented reference at
#   https://howispulse.com/self-host/env.example — for looking up, not for
#   filling in.
#
# IMPORTANT: voice + HQ streaming run over WebRTC/UDP DIRECTLY to the server,
# bypassing the HTTP proxy — the UDP/media ports below must stay open. Without
# them chat and sign-in work, but voice calls do not.
#
# Updates: docker compose -f docker-compose.behind-proxy.yml pull && … up -d
# (deliberately no auto-updater container; see
# https://howispulse.com/self-host/guide → Running it).

services:
  pulse:
    # Public image, no login needed. Servers set up before October 2026 may
    # keep registry.howispulse.com/pulse-allinone:stable here — that one needs
    # the credentials from their .env (docker login, see pulse-update.sh).
    image: ghcr.io/oblivion-pictures/pulse:stable
```

`infra/self-host/.env.example`:

**Block 1 — alte Zeilen 2–45 ersetzen.** Alt (44 Zeilen, Leerzeilen mitgezählt) — ab Zeile 2:

```bash
# Kopiere diese Datei nach .env und trage deine Werte ein.
# Pflicht-Vars sind mit [PFLICHT] markiert — ohne sie startet der Container nicht.
# Alle anderen Vars haben sichere Defaults.
```

bis Zeile 45:

```bash
# Wird für Let's Encrypt ACME-Anmeldung verwendet (Cert-Ablauf-Warnungen).
# Auch für Health-Probe-Notifications (DE 10c).
PULSE_ADMIN_EMAIL=admin@firma.de
```

Neu:

```bash
# Pflicht ist nur PULSE_HOSTNAME. Alles andere hat sichere Vorgaben.
#
# DIESE DATEI IST NUR EINE REFERENZ. Für den Start genügt eine .env mit einer
# einzigen Zeile (PULSE_HOSTNAME=…); diese Datei erklärt, was die übrigen
# Variablen bedeuten.

# ==========================================================================
# Pflicht
# ==========================================================================

# [PFLICHT] Die öffentliche Adresse deines Servers — braucht einen DNS-Eintrag
# auf diese Maschine. Caddy holt dafür das Let's-Encrypt-Zertifikat.
PULSE_HOSTNAME=chat.firma.de

# ==========================================================================
# Verbindung mit deinem Pulse-Konto
# ==========================================================================

# Nach dem ersten Start: docker exec -it pulse pulse-connect
# Das Werkzeug zeigt einen Link und einen Code; du bestätigst im Browser, und
# der Server holt seine Zugangsdaten selbst ab. Sie liegen danach im
# Datenvolumen (/data/pulse/verbindung.env), nicht in dieser Datei.
#
# Server, die vor Oktober 2026 mit Freigabe eingerichtet wurden, tragen die
# Werte stattdessen hier — sie bleiben gültig und gewinnen vor der Datei im
# Volumen:
# PULSE_INSTANCE_ID=1234567890
# PULSE_INSTANCE_OWNER_ID=1234567890
# PULSE_CLOUD_CLIENT_ID=sh_live_xxxxxxxxxxxxxxxxxxxx
# PULSE_CLOUD_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# [OPTIONAL] Mail-Adresse für Let's Encrypt (Warnungen vor Zertifikatsablauf).
# Ohne sie läuft alles genauso; beim Verbinden übernimmt der Server die Adresse
# deines Pulse-Kontos, falls die Cloud eine liefert.
# PULSE_ADMIN_EMAIL=admin@firma.de
```

- [ ] **Step 5: Prüfen.**

Run: `bash infra/self-host/tests/pulse-update-faelle.sh`

Expected: zwölf Zeilen mit `✓`, zuletzt `✓ self-host pulse-update: alle Fälle wie erwartet`.

Run:
```bash
T="$(mktemp -d)" && cp infra/self-host/docker-compose.yml infra/self-host/docker-compose.behind-proxy.yml "$T/" \
  && printf 'PULSE_HOSTNAME=chat.example.org\n' > "$T/.env" \
  && docker compose -f "$T/docker-compose.yml" config --images \
  && docker compose -f "$T/docker-compose.behind-proxy.yml" config --images
```

Expected: zweimal `ghcr.io/oblivion-pictures/pulse:stable`, kein Fehler. (Die Kopie ins Temp-Verzeichnis, weil `env_file: .env` relativ zur Compose-Datei aufgelöst wird und im Repo keine `.env` liegt.)

Run: `grep -n "Download .env\|docker login registry\|My Instances" infra/self-host/docker-compose.yml infra/self-host/docker-compose.behind-proxy.yml infra/self-host/.env.example`

Expected: keine Ausgabe.

- [ ] **Step 6: Vereinfachen.** `code-simplifier` über `infra/self-host/pulse-update.sh` und `infra/self-host/tests/pulse-update-faelle.sh`; Step 5 erneut; `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 7: Commit.**

```bash
git add infra/self-host/docker-compose.yml infra/self-host/docker-compose.behind-proxy.yml \
  infra/self-host/.env.example infra/self-host/pulse-update.sh infra/self-host/tests/pulse-update-faelle.sh
git commit -m "feat(self-host): Compose ohne Zugangsdaten, Anmeldung nur noch am Spiegel für Bestandsserver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.3: Anleitungen für Betreiber

`docs/self-host-guide.html` wird ausgeliefert: `web/Dockerfile:85` kopiert sie nach `/usr/share/nginx/html/self-host/guide`, `infra/prod/web-nginx.conf:433` liefert sie als `https://howispulse.com/self-host/guide` aus (`text/html`), `web/vite.config.ts:65` spiegelt sie im Dev. Eine reine Änderung unter `docs/` löste den Web-Bau nicht aus (`paths-ignore` in `ci.yml`); hier landet sie zusammen mit `web/static/install.sh`, also wird gebaut.

**Files:**
- Modify: `docs/self-host-guide.html:510-512,551-555,588-658,674-691,713-793,809,872-889,996,1011-1020`
- Modify: `infra/self-host/README.md:3,10-26,61-62,71-72,80-86,97-100,163-164`
- Modify: `docs/selfhost-erreichbarkeit.md:9,24`

**Interfaces:**
- Consumes: Befehle und Meldungen aus Task 4.1/4.2 und Etappe 2 (`pulse-connect`, `"verbunden":true`, `Connected to <name>`, Log-Zeile „not connected to a Pulse account“).
- Produces: Anleitung ohne Antrag, ohne `.env`-Download, ohne `docker login`. Die Menü-Pfade in der App („Settings → Your own server → My Instances“) bleiben bis Etappe 6 stehen — Etappe 5 baut sie um, Etappe 6 (Task 6.3) zieht den Text nach.

Kein Test; Prüfung per `grep` und Augenschein (Step 4).

- [ ] **Step 1: `docs/self-host-guide.html`.** Von unten nach oben anwenden.

**Block 1 — alte Zeilen 510–512 ersetzen.** Alt:

```html
    <li><span><strong>An approved instance.</strong> In the app: create an
      account, enable MFA, apply under <strong>Settings &rarr; Your own
      server</strong>, wait for approval.</span></li>
```

Neu:

```html
    <li><span><strong>A Pulse account.</strong> At the end of the installation
      you connect the server to it; that account becomes the server&rsquo;s
      admin.</span></li>
```

**Block 2 — alte Zeilen 551–555 ersetzen.** Alt:

```html
  <p>One command, and the server keeps itself up to date afterwards. Generate it
  under <strong>Settings &rarr; Your own server &rarr; Set up server</strong>.</p>

  <div class="cmd">
    <pre>curl -fsSL https://howispulse.com/install | PULSE_BOOTSTRAP_TOKEN=&lt;YOUR_TOKEN&gt; bash</pre>
```

Neu:

```html
  <p>One command, and the server keeps itself up to date afterwards:</p>

  <div class="cmd">
    <pre>curl -fsSL https://howispulse.com/install | bash</pre>
  </div>

  <p>The installer asks for your server&rsquo;s address, starts the server and
  connects it to your Pulse account at the end: it shows a link and a short
  code, and you confirm in the browser. Only confirm a code you just saw in
  your own console.</p>

  <p>Without a terminal (cloud-init, a CI job) pass the address up front and
  connect afterwards:</p>

  <div class="cmd">
    <pre>curl -fsSL https://howispulse.com/install | PULSE_HOSTNAME=chat.example.com bash
docker exec -it pulse pulse-connect</pre>
```

**Block 3 — alte Zeilen 588–658 ersetzen.** Alt (71 Zeilen, Leerzeilen mitgezählt) — ab Zeile 588:

```html
        <span class="weg-schritte">5 steps</span>
      </div>
    </summary>
```

bis Zeile 658:

```html
      your shell history.</p>

      <div class="step"><span class="step-n">04</span><h3>Start it</h3></div>
```

Neu:

```html
        <span class="weg-schritte">4 steps</span>
      </div>
    </summary>

    <div class="weg-inhalt">

      <div class="step"><span class="step-n">01</span><h3>Get the files</h3></div>

      <div class="cmd">
        <pre>mkdir pulse &amp;&amp; cd pulse
curl -fsSLO https://howispulse.com/self-host/docker-compose.yml
printf 'PULSE_HOSTNAME=chat.example.com\n' &gt; .env</pre>
      </div>

      <p>Use your own address instead of <code>chat.example.com</code>. The
      filename <code>.env</code> is mandatory &mdash; Compose looks for exactly
      that, in the same directory. Nothing else has to go into it; every other
      switch has a safe default.</p>

      <div class="step"><span class="step-n">02</span><h3>Start it</h3></div>
```

**Block 4 — alte Zeilen 674–691 ersetzen.** Alt:

```html
      <div class="step"><span class="step-n">05</span><h3>Verify and sign in</h3></div>

      <div class="cmd">
        <pre>curl https://chat.example.com/health                        <span class="c"># {"status":"ok"}</span>
curl https://chat.example.com/.well-known/pulse-server-info</pre>
      </div>

      <p>The second one carries the most information. It must show your
      <code>instance_id</code> and, in <code>capabilities</code>, the entry
      <strong><code>server-ticket</code></strong>.</p>

      <div class="note danger">No <code>server-ticket</code> means the server
      predates 28 August 2026 and will accept nobody. An update alone is not
      enough &mdash; it has to be set up again.</div>

      <p>Then: <a href="https://howispulse.com">howispulse.com</a> &rarr;
      <strong>Add server</strong> &rarr; your hostname. Sign in with the account
      that applied (step 1) &mdash; only that one becomes admin.</p>
```

Neu:

```html
      <div class="step"><span class="step-n">03</span><h3>Connect it to your Pulse account</h3></div>

      <div class="cmd">
        <pre>docker exec -it pulse pulse-connect</pre>
      </div>

      <p>It shows a link and a short code. Open the link, sign in to Pulse with
      the account that should own the server and confirm. The console then says
      <code>Connected to &lt;your name&gt;</code> and restarts the server. That
      account becomes the server&rsquo;s admin.</p>

      <div class="note warn"><strong>Only confirm a code you just saw in your own
      console.</strong> If someone sends you such a link, cancel it.</div>

      <div class="step"><span class="step-n">04</span><h3>Verify</h3></div>

      <div class="cmd">
        <pre>curl https://chat.example.com/health                        <span class="c"># {"status":"ok"}</span>
curl https://chat.example.com/.well-known/pulse-server-info</pre>
      </div>

      <p>The second one carries the most information. It must show
      <code>"verbunden":true</code> and, in <code>capabilities</code>, the entry
      <strong><code>server-ticket</code></strong>.</p>

      <div class="note danger">No <code>server-ticket</code> means the server
      predates 28 August 2026 and will accept nobody. An update alone is not
      enough &mdash; it has to be set up again.</div>

      <p>The server now appears in Pulse on every device of your account. Open
      it there and create the first community with its plus button.</p>
```

**Block 5 — alte Zeilen 713–793 ersetzen.** Alt (81 Zeilen, Leerzeilen mitgezählt) — ab Zeile 713:

```html
        <span class="weg-schritte">6 steps</span>
      </div>
    </summary>
```

bis Zeile 793:

```html
      your shell history.</p>

      <div class="step"><span class="step-n">04</span><h3>Start it</h3></div>
```

Neu:

```html
        <span class="weg-schritte">5 steps</span>
      </div>
    </summary>

    <div class="weg-inhalt">

      <div class="note"><strong>Two things differ from the standalone path.</strong>
      Every <code>docker compose</code> command carries
      <code>-f docker-compose.behind-proxy.yml</code>, updates included &mdash; or
      set <code>COMPOSE_FILE=docker-compose.behind-proxy.yml</code> in your shell
      and drop the flag. And there is one extra step at the end: the proxy
      rule.</div>

      <div class="step"><span class="step-n">01</span><h3>Get the files</h3></div>

      <div class="cmd">
        <pre>mkdir pulse &amp;&amp; cd pulse
curl -fsSLO https://howispulse.com/self-host/docker-compose.behind-proxy.yml
printf 'PULSE_HOSTNAME=chat.example.com\n' &gt; .env</pre>
      </div>

      <p>Use your own address instead of <code>chat.example.com</code>. The
      filename <code>.env</code> is mandatory &mdash; Compose looks for exactly
      that, in the same directory. <code>PULSE_TLS_MODE</code> is deliberately
      absent &mdash; this Compose file sets it to <code>behind-proxy</code>
      itself.</p>

      <div class="step"><span class="step-n">02</span><h3>Start it</h3></div>
```

**Block 6 — alte Zeile 809 ersetzen.** Alt:

```html
      <div class="step"><span class="step-n">05</span><h3>Add the proxy rule</h3></div>
```

Neu:

```html
      <div class="step"><span class="step-n">03</span><h3>Add the proxy rule</h3></div>
```

**Block 7 — alte Zeilen 872–889 ersetzen.** Alt:

```html
      <div class="step"><span class="step-n">06</span><h3>Verify and sign in</h3></div>

      <div class="cmd">
        <pre>curl https://chat.example.com/health                        <span class="c"># {"status":"ok"}</span>
curl https://chat.example.com/.well-known/pulse-server-info</pre>
      </div>

      <p>The second one carries the most information. It must show your
      <code>instance_id</code> and, in <code>capabilities</code>, the entry
      <strong><code>server-ticket</code></strong>.</p>

      <div class="note danger">No <code>server-ticket</code> means the server
      predates 28 August 2026 and will accept nobody. An update alone is not
      enough &mdash; it has to be set up again.</div>

      <p>Then: <a href="https://howispulse.com">howispulse.com</a> &rarr;
      <strong>Add server</strong> &rarr; your hostname. Sign in with the account
      that applied (step 1) &mdash; only that one becomes admin.</p>
```

Neu:

```html
      <div class="step"><span class="step-n">04</span><h3>Connect it to your Pulse account</h3></div>

      <div class="cmd">
        <pre>docker exec -it pulse pulse-connect</pre>
      </div>

      <p>Pulse first checks from outside that the server answers under its
      address, so the proxy rule from step 3 must be in place. Then it shows a
      link and a short code. Open the link, sign in to Pulse with the account
      that should own the server and confirm. The console then says
      <code>Connected to &lt;your name&gt;</code> and restarts the server. That
      account becomes the server&rsquo;s admin.</p>

      <div class="note warn"><strong>Only confirm a code you just saw in your own
      console.</strong> If someone sends you such a link, cancel it.</div>

      <div class="step"><span class="step-n">05</span><h3>Verify</h3></div>

      <div class="cmd">
        <pre>curl https://chat.example.com/health                        <span class="c"># {"status":"ok"}</span>
curl https://chat.example.com/.well-known/pulse-server-info</pre>
      </div>

      <p>The second one carries the most information. It must show
      <code>"verbunden":true</code> and, in <code>capabilities</code>, the entry
      <strong><code>server-ticket</code></strong>.</p>

      <div class="note danger">No <code>server-ticket</code> means the server
      predates 28 August 2026 and will accept nobody. An update alone is not
      enough &mdash; it has to be set up again.</div>

      <p>The server now appears in Pulse on every device of your account. Open
      it there and create the first community with its plus button.</p>
```

**Block 8 — alte Zeile 996 ersetzen.** Alt:

```html
        <tr><td>Not admin on your own server</td><td>Signed in with a different account than the one that applied</td><td>See below</td></tr>
```

Neu:

```html
        <tr><td>Nobody can sign in, the log says &ldquo;not connected to a Pulse account&rdquo;</td><td>The server was never connected</td><td><code>docker exec -it pulse pulse-connect</code></td></tr>
        <tr><td>Not admin on your own server</td><td>Signed in with a different account than the one that confirmed the connection</td><td>See below</td></tr>
```

**Block 9 — alte Zeilen 1011–1020 ersetzen.** Alt:

```html
  <p>The server logs both the configured owner and who signed in:</p>

  <div class="cmd">
    <pre>docker logs pulse 2&gt;&amp;1 | grep -iE "instance owner|Cloud account"</pre>
  </div>

  <p>Two different numbers means the wrong account. To move the server to another
  account, change <code>PULSE_INSTANCE_OWNER_ID</code> in the <code>.env</code>
  and restart. Needs <code>PULSE_LOG_LEVEL=info</code>, which is the default
  &mdash; if neither line appears, the container is running quieter than that.</p>
```

Neu:

```html
  <p>The admin is the account that confirmed the connection. The server logs
  both its owner and who signed in:</p>

  <div class="cmd">
    <pre>docker logs pulse 2&gt;&amp;1 | grep -iE "instance owner|Cloud account"</pre>
  </div>

  <p>Two different numbers means the wrong account. To hand the server to
  another account, run <code>docker exec -it pulse pulse-connect</code> again and
  confirm with that account. Servers set up before October 2026 carry the owner
  as <code>PULSE_INSTANCE_OWNER_ID</code> in their <code>.env</code> instead;
  change it there and restart. Needs <code>PULSE_LOG_LEVEL=info</code>, which is
  the default &mdash; if neither line appears, the container is running quieter
  than that.</p>
```

- [ ] **Step 2: `infra/self-host/README.md`.** Etappe 0 hat in Zeile 14 schon `ghcr.io/oblivion-pictures/pulse` eingetragen; Block 2 (Zeilen 10–26) ersetzt außer dem Satz zur Anleitung den ganzen Absatz „**Two registries, one image.** …“; das zitierte Alt zeigt Zeile 14 noch im Stand vor Etappe 0 — Anker ist der Absatz, nicht der Wortlaut dieser Zeile. Der neue `docker run` bekommt `--restart unless-stopped`: `pulse-connect` startet die Dienste nach dem Verbinden neu, indem es den Container beendet (Vertrag, Etappe 2), und ohne Neustartregel bliebe er danach stehen.

**Block 1 — alte Zeile 3 ersetzen.** Alt:

```markdown
`registry.howispulse.com/pulse-allinone:stable` — one container that bundles every
```

Neu:

```markdown
`ghcr.io/oblivion-pictures/pulse:stable` — one container that bundles every
```

**Block 2 — alte Zeilen 10–26 ersetzen.** Alt:

```markdown
docs (Cloud-approval, DNS, port-forwarding) land in `docs/self-host-guide.html` —
written in Phase 6.B.

**Two registries, one image.** `.github/workflows/allinone.yml` builds and
pushes to `ghcr.io/oblivion8282-1337/pulse-allinone` first, then its `merge`
job mirrors every tag (`imagetools create`) to `registry.howispulse.com/pulse-allinone`
under the identical tag name. **Operators pull from `registry.howispulse.com`,
never from GHCR** — the `pulse-*` GHCR packages are private, while
`registry.howispulse.com` gates access per-instance via the `PULSE_CLOUD_CLIENT_ID`/
`PULSE_CLOUD_CLIENT_SECRET` from the Cloud approval (`docker login
registry.howispulse.com -u <client_id> -p <client_secret>`). Both `:edge`
(every `main` push) and `:stable` (tagged releases) exist on both registries;
during the current early/security phase every `main` push tags **both**
identically (see the `PHASEN-POLICY` comment in `allinone.yml`) — they diverge
once real tagged releases start. The installer (`web/static/install.sh`)
defaults to `:edge`, overridable via `PULSE_IMAGE`; this file's Compose/`docker
run` examples below pin `:stable`.
```

Neu:

```markdown
docs (DNS, ports, connecting the server to a Pulse account) are in
`docs/self-host-guide.html`, served as https://howispulse.com/self-host/guide.

**One image, two addresses.** `.github/workflows/allinone.yml` builds and
pushes `ghcr.io/oblivion-pictures/pulse` — **public, no login needed** — and
its `merge` job mirrors every tag (`imagetools create`) to
`registry.howispulse.com/pulse-allinone` under the identical tag name. The
mirror only serves servers set up before October 2026: it gates access
per-instance via their `PULSE_CLOUD_CLIENT_ID`/`PULSE_CLOUD_CLIENT_SECRET`
(`docker login registry.howispulse.com`), and their update scripts keep pulling
from it. New servers pull from GHCR. Both `:edge` (every `main` push) and
`:stable` exist on both; during the current early/security phase every `main`
push tags **both** identically (see the `PHASEN-POLICY` comment in
`allinone.yml`) — they diverge once real tagged releases start. The installer
(`web/static/install.sh`) and the Compose files use `:stable`; the installer
takes another image via `PULSE_IMAGE`.
```

**Block 3 — alte Zeilen 61–62 ersetzen.** Alt:

```markdown
cp .env.example .env      # 6 Pflicht-Vars eintragen (.env-Download via "Meine Instanzen")
docker compose up -d      # bzw. docker compose -f docker-compose.behind-proxy.yml up -d
```

Neu:

```markdown
printf 'PULSE_HOSTNAME=chat.example.com\n' > .env   # einzige Pflicht-Variable
docker compose up -d      # bzw. docker compose -f docker-compose.behind-proxy.yml up -d
docker exec -it pulse pulse-connect   # Link + Code, im Browser bestätigen
```

**Block 4 — alte Zeilen 71–72 ersetzen.** Alt:

```markdown
docker login registry.howispulse.com -u <client_id> -p <client_secret>  # aus dem .env-Download
docker run -d --name pulse \
```

Neu:

```markdown
docker run -d --name pulse --restart unless-stopped \
```

**Block 5 — alte Zeilen 80–86 ersetzen.** Alt:

````markdown
    -e PULSE_INSTANCE_ID=... \
    -e PULSE_INSTANCE_OWNER_ID=... \
    -e PULSE_CLOUD_CLIENT_ID=... \
    -e PULSE_CLOUD_CLIENT_SECRET=... \
    -e PULSE_ADMIN_EMAIL=admin@example.com \
    registry.howispulse.com/pulse-allinone:stable
```
````

Neu:

````markdown
    ghcr.io/oblivion-pictures/pulse:stable
docker exec -it pulse pulse-connect
```

`--restart unless-stopped` ist Pflicht: `pulse-connect` startet die Dienste
nach dem Verbinden neu, indem es den Container beendet — die Neustartregel
holt ihn zurück. Ohne sie bliebe er nach dem Verbinden gestoppt.
````

**Block 6 — alte Zeilen 97–100 ersetzen.** Alt:

```markdown
The six `-e` vars are mandatory; cont-init aborts with a clear error otherwise.
`PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID`, `PULSE_CLOUD_CLIENT_ID` and the
secret come from the Cloud approval — the ready-made `.env` under "Meine
Instanzen" on howispulse.com carries all but the secret.
```

Neu:

```markdown
Only `PULSE_HOSTNAME` is mandatory; cont-init aborts with a clear error
without it. `pulse-connect` fetches instance ID, owner and the cloud credentials
once you confirm in the browser and stores them in the volume
(`/data/pulse/verbindung.env`, `chmod 600`). Values set in the environment win
over that file — that is how servers set up before October 2026 (instance ID,
owner and credentials in their `.env`) keep running unchanged.
`PULSE_ADMIN_EMAIL` is optional: without it, Let's Encrypt runs without an
account address.
```

**Block 7 — alte Zeilen 163–164 ersetzen.** Alt:

```markdown
`docker-compose.yml`, it reads the registry credentials from `.env`; examples
for cron/systemd are in its header). End-user docs:
```

Neu:

```markdown
`docker-compose.yml`; it signs in to `registry.howispulse.com` only when the
Compose file still pulls from there (servers set up before October 2026, with
the credentials in `.env`); examples for cron/systemd are in its header). End-user docs:
```

- [ ] **Step 3: `docs/selfhost-erreichbarkeit.md`.**

**Block 1 — alte Zeile 9 ersetzen.** Alt:

```markdown
  - **Cloud, von aussen**: `POST /selfhost/diagnose/{id}` (`routes_selfhost_diagnose.py` + `selfhost_probe.py`/`selfhost_probe_dienst.py`). Besitzer per Sitzung **oder** die Instanz selbst per `client_id`/`client_secret` (der Weg des Installers); Fremde bekommen 404, nie 403.
```

Neu:

```markdown
  - **Cloud, von aussen**: `POST /selfhost/diagnose/{id}` (`routes_selfhost_diagnose.py` + `selfhost_probe.py`/`selfhost_probe_dienst.py`). Besitzer per Sitzung **oder** die Instanz selbst per `client_id`/`client_secret` (der Weg des Installers — er liest sie nach dem Verbinden aus `/data/pulse/verbindung.env` im Container und reicht sie curl über stdin, nie über die Befehlszeile); Fremde bekommen 404, nie 403.
```

**Block 2 — alte Zeile 24 ersetzen.** Alt:

```markdown
  - **Der Installer prüft alle Ports VOR dem Token-Einlösen** (der Token ist einmalig, `docker run` kommt erst zwei Schritte später) und liest den Startfortschritt per `docker exec`, **nicht** über HTTP: im Modus `greenfield` ist der externe Weg genau so lange tot, wie Caddy noch kein Zertifikat hat.
```

Neu:

```markdown
  - **Der Installer prüft alle Ports, bevor er etwas verändert** (`docker run` kommt erst nach dem Schreiben der Konfiguration und dem Pull) und liest den Startfortschritt per `docker exec`, **nicht** über HTTP: im Modus `greenfield` ist der externe Weg genau so lange tot, wie Caddy noch kein Zertifikat hat. Ob der Server schon verbunden ist, fragt er ebenfalls von innen (`127.0.0.1:8002/.well-known/pulse-server-info` per `docker exec`) — ein Abruf über den eigenen Namen scheitert in Netzen ohne Hairpin-NAT, und dann verbände er einen längst verbundenen Server neu.
```

- [ ] **Step 4: Prüfen, dass nichts Altes stehen bleibt.**

Run: `grep -n -i "bootstrap_token\|PULSE_BOOTSTRAP_TOKEN\|wait for approval\|Download .env\|docker login registry\|the account that applied\|approved instance" docs/self-host-guide.html infra/self-host/README.md infra/self-host/docker-compose*.yml`

Expected: genau eine Zeile, `infra/self-host/README.md` Zeile 19 („docker login registry.howispulse.com …, and their update scripts keep pulling“) — sie beschreibt den Spiegel für die Bestandsserver und bleibt.

Run: `grep -c "pulse-connect" docs/self-host-guide.html`

Expected: `5`.

Die Seite einmal im Browser öffnen (`cd web && pnpm dev`, dann `http://127.0.0.1:5173/self-host/guide`): beide aufklappbaren Wege zeigen 4 bzw. 5 Schritte in fortlaufender Nummerierung, die Kopier-Knöpfe sitzen an jedem Befehl.

- [ ] **Step 5: Commit.**

```bash
git add docs/self-host-guide.html infra/self-host/README.md docs/selfhost-erreichbarkeit.md
git commit -m "docs(self-host): Anleitung ohne Antrag, ohne .env-Download, mit pulse-connect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.4: Paket öffentlich, Probe auf einer Wegwerf-VM

**Files:** keine.

**Interfaces:**
- Consumes: Etappen 0–3 live; Zweig `feat/selfhost-vordertuer` mit Task 4.1–4.3.
- Produces: `ghcr.io/oblivion-pictures/pulse` ist öffentlich (**endgültig** — GitHub lässt das nicht zurücknehmen); ein Probedurchlauf von Installation bis „Connected“ auf echter Hardware.

- [ ] **Step 1: Voraussetzungen prüfen (nur lesen).**

Run: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://howispulse.com/api/auth/selfhost/verbinden/start`

Expected: `422` (Route da, Eingabe unvollständig; zählt höchstens einen der zehn Versuche je Stunde und IP). `404` heißt: Etappe 1 ist nicht live — hier anhalten.

Run: `gh repo view oblivion-pictures/pulse --json visibility -q .visibility`

Expected: `PUBLIC`. `infra/prod/DEPLOY.md` (Abschnitt Registry) hält fest, dass ein mit einem **privaten** Repo verknüpftes Paket nicht öffentlich sein kann; ist das Repo privat, hier anhalten und mit dem Eigentümer klären.

Im Browser (Eigentümer): `https://howispulse.com/verbinden` zeigt das Eingabefeld für den Code (Etappe 3).

- [ ] **Step 2: Paket öffentlich stellen (Eigentümer, im Browser).** `https://github.com/orgs/oblivion-pictures/packages/container/package/pulse` → *Package settings* → *Danger Zone* → *Change visibility* → *Public* → Paketnamen zur Bestätigung eintippen. **Endgültig.** Nur dieses eine Paket; die Cloud-Pakete `pulse-auth`, `pulse-chat-gateway`, `pulse-voice-signaling`, `pulse-media-svc`, `pulse-mediamtx-auth-hook`, `pulse-relay-frps-plugin`, `pulse-web` bleiben privat (Spec §7).

- [ ] **Step 3: Von außen prüfen, ohne Anmeldung.**

Run:
```bash
TOKEN="$(curl -fsS 'https://ghcr.io/token?scope=repository:oblivion-pictures/pulse:pull' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/oblivion-pictures/pulse/manifests/stable
DOCKER_CONFIG="$(mktemp -d)" docker manifest inspect ghcr.io/oblivion-pictures/pulse:stable >/dev/null && echo OEFFENTLICH
```

Expected: `200` und `OEFFENTLICH`. (Der Token ist ein anonymer Lese-Token, kein Geheimnis; er wird nicht ausgegeben.)

Gegenprobe, ein Cloud-Paket muss privat bleiben:

Run: `DOCKER_CONFIG="$(mktemp -d)" docker manifest inspect ghcr.io/oblivion-pictures/pulse-auth:latest >/dev/null 2>&1 && echo OEFFENTLICH || echo PRIVAT`

Expected: `PRIVAT`.

- [ ] **Step 4: Wegwerf-VM vorbereiten (Eigentümer).** Eine frische VM (z. B. Hetzner Cloud CX22 oder netcup, Debian 13), **nicht** der Hetzner-Dev-Stack `77.42.71.166` (eng, fremde Dienste) und **nicht** die Cloud `159.195.150.54`. Docker installieren (`curl -fsSL https://get.docker.com | sh`). DNS: ein A-Eintrag, z. B. `probe.unicutmedia.com`, auf die IP der VM — **nicht** unter `howispulse.com`, solche Adressen lehnt die Cloud ab (`adresse_gesperrt`). Ports 80, 443, 3478, 1936, 7882–7892/udp, 8189/udp offen. Zwei Test-Konten in Pulse bereithalten: A und B.

Im Folgenden steht `PROBE` für die gewählte Adresse und `VM` für die IP der VM; beides vor dem Lauf als Shell-Variable setzen, z. B. `PROBE=probe.unicutmedia.com VM=203.0.113.50`.

- [ ] **Step 5: Installer vom Zweig auf die VM bringen und laufen lassen.** Der neue Installer ist noch nicht unter `howispulse.com/install` — er kommt per `scp`. `ssh -t`, damit `pulse-connect` ein Terminal hat.

```bash
scp web/static/install.sh "root@${VM}:/root/install.sh"
ssh -t "root@${VM}" "PULSE_HOSTNAME=${PROBE} bash /root/install.sh"
```

Expected, in dieser Reihenfolge: `Server address: <PROBE>`, `Pulling image ghcr.io/oblivion-pictures/pulse:stable…` **ohne** vorheriges `Logging in`, die Checkliste bis `+ startup complete`, `Your server answers under https://<PROBE>.`, dann die Ausgabe von `pulse-connect` mit Link und Code. Den Link im Browser mit Konto A öffnen, auf der Seite „Ja, das ist mein Server“ wählen. Danach in der Konsole: `Connected to <Name von A>.`, `Restarting Pulse with the new connection…`, erneut die Checkliste, die Prüfung aus der Cloud (`YOUR SERVER IS REACHABLE FROM THE INTERNET.` oder das erste rote Glied samt Handgriff), `Done.`

- [ ] **Step 6: Ergebnis auf der VM und in der Cloud prüfen.**

Run: `ssh "root@${VM}" 'grep -c "^PULSE_CLOUD_CLIENT_SECRET=" /opt/pulse/pulse.env; grep -c "^REG_" /opt/pulse/pulse-update.sh; docker exec pulse stat -c %a /data/pulse/verbindung.env'`

Expected: `0`, `0`, `600` (die Zahlen `0` kommen mit Exit 1 von `grep -c`; das ist hier der Erfolgsfall).

Run: `curl -fsS "https://${PROBE}/.well-known/pulse-server-info"`

Expected: enthält `"verbunden":true` und eine `instance_id`.

Run: `ssh michael@159.195.150.54 "docker exec pulse_postgres psql -U dcc -d dcc -Atc \"select origin, ohne_freigabe, worker_id_chat is null, status from auth.registered_instances where hostname = '${PROBE}'\""`

Expected: `vps|t|t|active`.

Auf einem **zweiten Gerät** mit Konto A angemeldet (anderer Browser oder Handy, Seite neu laden): der Server steht in der Leiste; öffnen, über sein Plus eine Community anlegen — das klappt nur als Admin.

- [ ] **Step 7: Erneuter Lauf auf demselben Volumen (Neuinstallation, schon verbunden).**

```bash
ssh -t "root@${VM}" "PULSE_HOSTNAME=${PROBE} bash /root/install.sh"
```

Expected: `This server is already connected to a Pulse account.` und **kein** Link, kein Code; am Ende `Done.`; die `instance_id` aus Step 6 ist unverändert (`curl -fsS "https://${PROBE}/.well-known/pulse-server-info"`).

- [ ] **Step 8: Neuinstallation mit frischem Volumen und Konto B übernimmt die Adresse.** Erst die alte Instanz-Nummer merken, dann Container und Volumen wegwerfen und neu installieren:

```bash
ALT="$(curl -fsS "https://${PROBE}/.well-known/pulse-server-info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["instance_id"])')"
ssh "root@${VM}" 'docker rm -f pulse && docker volume rm pulse-data'
ssh -t "root@${VM}" "PULSE_HOSTNAME=${PROBE} bash /root/install.sh"
```

Im Browser mit Konto B bestätigen. Expected in der Konsole: `Connected to <Name von B>.`

Run: `ssh michael@159.195.150.54 "docker exec pulse_postgres psql -U dcc -d dcc -Atc \"select status, registered_by from auth.registered_instances where id = ${ALT}\""`

Expected: `deleted|<ID von A>`.

Run: `curl -fsS https://howispulse.com/.well-known/pulse-suspended-instances | grep -c "${ALT}"`

Expected: `1` (der alte Eintrag steht auf der Sperrliste). Auf A's Gerät verschwindet der Server aus der Leiste, auf B's erscheint er.

- [ ] **Step 9: Probe abbauen.** In Pulse mit Konto B den Probe-Server löschen (heute: „Meine Instanzen“ → Löschen), dann die VM löschen und den DNS-Eintrag entfernen.

### Task 4.5: Landen

**Files:** keine.

**Interfaces:**
- Consumes: Task 4.1–4.4 erledigt, Probe grün.
- Produces: `https://howispulse.com/install` und `https://howispulse.com/self-host/*` in der neuen Fassung.

- [ ] **Step 1: Gate.**

Run: `bash scripts/gate.sh`

Expected: `✓ Test-Gate grün.` (Bereiche `web` und `infra`).

- [ ] **Step 2: Freigabe des Eigentümers einholen, dann landen.** Landen ist Prod-Deploy.

Run: `bash scripts/ship.sh`

- [ ] **Step 3: Ausgelieferte Dateien prüfen** (nach dem CI-Lauf, ≤ 5 min Cron).

Run: `curl -fsSL https://howispulse.com/install | sed -n 5,6p`

Expected:
```
#   curl -fsSL https://howispulse.com/install | bash
#   curl -fsSL https://howispulse.com/install | PULSE_HOSTNAME=chat.example.org bash
```

Run: `curl -fsSL https://howispulse.com/self-host/docker-compose.yml | grep -n "image:"`

Expected: `ghcr.io/oblivion-pictures/pulse:stable`.

Run: `curl -fsSL https://howispulse.com/self-host/guide | grep -c pulse-connect`

Expected: `5`.

- [ ] **Step 4: Bestandsserver unverändert.** Die drei Bestands-VPS haben den Installer nicht neu laufen lassen; ihr Update-Skript zieht weiter vom Spiegel. Prüfen, dass sie da sind, ihre Nummer behalten haben und den neuen Stand bekommen (Bild-Bau ~8 min plus Updater-Takt 5 min nach dem Merge):

Run:
```bash
curl -fsS https://howispulse.com/.well-known/pulse-server-info \
  | python3 -c 'import json,sys; print("cloud", json.load(sys.stdin)["build_version"])'
ssh michael@159.195.150.54 "docker exec pulse_postgres psql -U dcc -d dcc -Atc \"select id, hostname from auth.registered_instances where status = 'active' and origin = 'vps' and not ohne_freigabe order by id\"" \
  | while IFS='|' read -r id host; do
      printf '%s %s ' "$id" "$host"
      curl -fsS -m 10 "https://${host}/.well-known/pulse-server-info" \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("instance_id"), d.get("verbunden"), d.get("build_version"))'
    done
```

Expected: drei Zeilen; je Zeile ist die Zahl nach der Adresse gleich der ersten (Instanz-Nummer unverändert), `verbunden` ist `True`, und spätestens 20 Minuten nach dem Merge steht dort derselbe `build_version` wie bei `cloud`. Bleibt ein Server zurück, zuerst seinen Updater prüfen (Spec E10: er hört bei einem Anmeldefehler still auf).

---

## Etappe 5 — Web: neue Einstiege, „Meine Server“, Admin-Oberfläche

Danach richtet man einen eigenen Server über das Plus jeder Server-Gruppe (am
Handy über das Menü der Räume) ein, findet ihn unter „Meine Server“ im
Konto-Menü und im Du-Bereich, der Server-Knopf unten in der Leiste ist weg, und
der Admin-Bereich kennt keine Anträge mehr.

Voraussetzung: Etappen 1 (Felder `ohne_freigabe`, `server_verbinden_gesperrt`,
Ereignis `instanz_verbunden` beim Abholen), 3 und 4 (Installer ohne Token) sind
gelandet. Etappe 6 entfernt danach die
Antrags-Routen; diese Etappe sorgt dafür, dass das Web sie vorher nicht mehr ruft.

**Reihenfolge der Tasks gegenüber dem Auftrag getauscht** (erst Dialog, dann
„Meine Server“): Bis der Dialog steht, ist die Seite `/app/server` der einzige
Ort mit dem Download der Server-App. Wer zuerst „Meine Server“ entschlackt, hat
einen Commit ohne Download und ohne grüne E2E-Tests dazwischen.

Zweig: `git checkout main && git pull --ff-only && git checkout -b feat/eigener-server-einstieg`

### Task 5.1: Dialog „Eigenen Server einrichten“ mit Einstieg im Plus und in den Räumen

**Files:**
- Create: `web/src/lib/components/selfhost/SelfHostInstallCard.svelte`
- Create: `web/src/lib/components/selfhost/EigenerServerDialog.svelte`
- Create: `web/src/lib/components/GuildRailPlusMenu.svelte`
- Create: `web/src/lib/components/mobile/RaeumeMenue.svelte`
- Create: `web/tests/e2e/eigener-server.spec.ts`
- Delete: `web/tests/e2e/heim-server.spec.ts` (beide Prüfungen wandern in `eigener-server.spec.ts`)
- Modify: `web/src/lib/stores/uiOverlays.svelte.ts:13-15`
- Modify: `web/src/lib/components/GuildRail.svelte:18,20,27,28` (Importe weg), `:65` (Import dazu), `:692-738` (Plus-Block)
- Modify: `web/src/routes/app/rooms/+page.svelte:15-18` (Importe), `:120-158` (Menü)
- Modify: `web/src/routes/app/+layout.svelte:67` (Import), `:560` (Mount)
- Modify: `web/src/lib/components/account/ServerAppDownload.svelte:1-9,33`
- Modify: `web/messages/de.json`, `web/messages/en.json` (Ende)

**Interfaces:**
- Consumes: `CLOUD_HOSTNAME` (`web/src/lib/api/servers.svelte.ts:90`, `'https://howispulse.com'`), `BottomSheet` (`web/src/lib/components/mobile/BottomSheet.svelte`), `Dialog` (`web/src/lib/components/ui/dialog/index.ts`), `ServerAppDownload`, `viewport.isMobile` (nur im App-Layout), Paraglide-Bestand `hosting_apply_mode_label`, `hosting_apply_mode_managed_title`, `hosting_apply_mode_managed_badge`, `hosting_apply_mode_managed_desc` (heute im Antragsformular, Texte decken sich wörtlich mit der Skizze).
- Produces:
  - `uiOverlays.eigenerServerOpen: boolean`
  - `EigenerServerDialog` (Prop `blatt: boolean`), einmal gemountet im App-Layout
  - `SelfHostInstallCard` (ohne Props)
  - `GuildRailPlusMenu` (Props `serverId: string`, `darfAnlegen: boolean`, `onAnlegen: () => void`, `onBeitreten?: () => void`)
  - `RaeumeMenue` (ohne Props)
  - `data-testid`: `guild-eigener-server`, `rooms-eigener-server`, `eigener-server-dialog` (Inhalt in beiden Hüllen), `eigener-server-blatt`, `eigener-server-schliessen`, `eigener-server-rechner`, `eigener-server-gemietet`, `eigener-server-gehostet`, `self-host-install-card`, `self-host-install-command`, `self-host-install-copy`, `self-host-install-guide`.

- [ ] **Step 1: Playwright-Test schreiben.** `web/tests/e2e/eigener-server.spec.ts`:

```ts
/**
 * „Eigenen Server einrichten“ (Spec 2026-10-09-selfhost-ohne-freigabe-design.md
 * §5): Einstieg im Plus jeder Server-Gruppe (Rechner) und im Menü der Räume
 * (Handy), ein Dialog bzw. ein Blatt von unten mit den Wegen Server-App,
 * gemieteter Server und „Von Pulse gehostet (Bald)“.
 *
 * Ersetzt heim-server.spec.ts: dessen Prüfungen (Download ohne Sperre, kein
 * Antragsformular) stehen jetzt hier am Dialog statt auf /app/server.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const RECHNER = { width: 1440, height: 900 };
const HANDY = { width: 390, height: 844 };

async function registrieren(page: Page, name: string): Promise<void> {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(name);
  await page.getByTestId('reg-email').fill(`${name}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill(PW);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

test.describe.configure({ mode: 'serial' });

test.describe('Eigenen Server einrichten', () => {
  test('am Rechner: das Plus öffnet den Dialog mit allen Wegen', async ({ browser }) => {
    const page = await browser.newPage({ viewport: RECHNER });
    await registrieren(page, `es_desk_${TAG}`);

    await page.locator('[data-testid^="guild-create-menu-"]').first().click();
    await page.getByTestId('guild-eigener-server').click();
    const dialog = page.getByTestId('eigener-server-dialog');
    await expect(dialog).toBeVisible();

    await expect(dialog.getByTestId('self-host-install-command')).toHaveText(
      'curl -fsSL https://howispulse.com/install | bash'
    );
    await expect(dialog.getByTestId('self-host-install-guide')).toHaveAttribute(
      'href',
      'https://howispulse.com/self-host/guide'
    );
    // Heim-Server ohne Sperre und ohne Antrag; „Desktop Chrome“ meldet Windows.
    await expect(dialog.getByTestId('server-app-download')).toBeVisible();
    await expect(dialog.getByTestId('server-app-download-windows')).toBeVisible();
    await expect(dialog.getByTestId('eigener-server-gehostet')).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(page.getByTestId('self-host-application')).toHaveCount(0);

    // Schließen per Knopf IM Dialog: belegt, dass der aus dem Menü geöffnete
    // Dialog bedienbar ist (bits-ui macht sonst den Inhalt still inert).
    await dialog.getByTestId('eigener-server-schliessen').click();
    await expect(page.getByTestId('eigener-server-dialog')).toHaveCount(0);
    await page.close();
  });

  test('am Handy: das Menü der Räume öffnet dasselbe als Blatt', async ({ browser }) => {
    // Geräteklasse hängt am ZEIGER (geraetKlasse.ts): ohne Finger-Emulation
    // wäre jede Breite nur ein schmales Desktop-Fenster.
    const ctx = await browser.newContext({
      viewport: HANDY,
      locale: 'de-DE',
      isMobile: true,
      hasTouch: true
    });
    const page = await ctx.newPage();
    await registrieren(page, `es_handy_${TAG}`);

    await page.goto('/app/rooms');
    await page.getByTestId('rooms-menu').click();
    await page.getByTestId('rooms-eigener-server').click();
    await expect(page.getByTestId('eigener-server-blatt')).toBeVisible();
    await expect(
      page.getByTestId('eigener-server-dialog').getByTestId('self-host-install-command')
    ).toBeVisible();

    await page.getByTestId('eigener-server-schliessen').click();
    await expect(page.getByTestId('eigener-server-blatt')).toHaveCount(0);
    await ctx.close();
  });
});
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm exec playwright test tests/e2e/eigener-server.spec.ts`
Expected: FAIL — `guild-eigener-server` nicht gefunden.

- [ ] **Step 3: Texte.** `web/messages/de.json` (Ende):

```json
  "eigener_server_einrichten": "Eigenen Server einrichten",
  "eigener_server_rechner_titel": "Auf diesem Rechner",
  "eigener_server_rechner_text": "Mit der Pulse Server-App. Dein Rechner ist der Server, solange er läuft. Keine eigene Domain nötig.",
  "eigener_server_gemietet_titel": "Auf einem gemieteten Server",
  "eigener_server_gemietet_text": "Ein Linux-Rechner mit Docker und eigener Adresse. Läuft rund um die Uhr.",
  "eigener_server_befehl_hinweis": "Der Installer verbindet den Server am Ende mit deinem Konto.",
  "eigener_server_kopieren": "Kopieren",
  "eigener_server_kopiert": "Kopiert",
  "eigener_server_anleitung": "Ausführliche Anleitung",
  "eigener_server_schliessen": "Schließen"
```

`web/messages/en.json` (Ende):

```json
  "eigener_server_einrichten": "Set up your own server",
  "eigener_server_rechner_titel": "On this computer",
  "eigener_server_rechner_text": "With the Pulse Server app. Your computer is the server while it is running. No domain of your own needed.",
  "eigener_server_gemietet_titel": "On a rented server",
  "eigener_server_gemietet_text": "A Linux machine with Docker and its own address. Runs around the clock.",
  "eigener_server_befehl_hinweis": "At the end, the installer connects the server to your account.",
  "eigener_server_kopieren": "Copy",
  "eigener_server_kopiert": "Copied",
  "eigener_server_anleitung": "Detailed guide",
  "eigener_server_schliessen": "Close"
```

- [ ] **Step 4: Schalter im Overlay-Store.** `web/src/lib/stores/uiOverlays.svelte.ts` nach Zeile 15 (`diagnoseOpen = $state(false);`):

```ts
  /** „Eigenen Server einrichten“ — gesetzt vom Plus jeder Server-Gruppe
   *  (`GuildRailPlusMenu`) und vom Menü der Räume (`RaeumeMenue`), gemountet
   *  einmal im App-Layout (`EigenerServerDialog`). */
  eigenerServerOpen = $state(false);
```

- [ ] **Step 5: `web/src/lib/components/selfhost/SelfHostInstallCard.svelte` anlegen.**

```svelte
<!--
  Installationsbefehl für einen gemieteten Server (seit 2026-10 ohne Antrag
  und ohne Token): ein Befehl für alle, kein Geheimnis darin — deshalb
  statisch, ohne API. Den Rest erledigt der Installer: am Ende ruft er
  `pulse-connect`, das den Server über die Bestätigungsseite `/verbinden` mit
  dem Konto verbindet (Spec 2026-10-09, E1/E6).

  Befehl und Anleitung nennen immer die Cloud (`CLOUD_HOSTNAME`), nicht die
  Adresse, von der diese Seite geladen wurde: Self-Hosts liefern dieselbe
  Web-App aus (`infra/self-host/Dockerfile`, Stage `web-build`), aber weder
  `/install` noch `/self-host/guide` — ein Befehl mit ihrer Adresse liefe ins
  Leere.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import CheckIcon from '@lucide/svelte/icons/check';
  import { CLOUD_HOSTNAME } from '$lib/api/servers.svelte';
  import { m } from '$lib/paraglide/messages.js';

  const BEFEHL = `curl -fsSL ${CLOUD_HOSTNAME}/install | bash`;
  const ANLEITUNG = `${CLOUD_HOSTNAME}/self-host/guide`;

  let kopiert = $state(false);
  let zuruecksetzen: ReturnType<typeof setTimeout> | undefined;

  async function kopieren(): Promise<void> {
    try {
      await navigator.clipboard.writeText(BEFEHL);
    } catch {
      // Zwischenablage verweigert (ältere WebView, fehlende Berechtigung) —
      // der Befehl steht markierbar da (`select-all`).
      return;
    }
    kopiert = true;
    clearTimeout(zuruecksetzen);
    zuruecksetzen = setTimeout(() => (kopiert = false), 2000);
  }

  onDestroy(() => clearTimeout(zuruecksetzen));
</script>

<div class="flex flex-col gap-2" data-testid="self-host-install-card">
  <div class="flex items-center gap-2">
    <code
      class="bg-bg-input text-text-bright min-w-0 flex-1 overflow-x-auto rounded-md px-2 py-1.5 font-mono text-xs whitespace-nowrap select-all"
      data-testid="self-host-install-command">{BEFEHL}</code
    >
    <Button size="xs" variant="outline" onclick={kopieren} data-testid="self-host-install-copy">
      {#if kopiert}
        <CheckIcon class="size-3.5" />
        {m.eigener_server_kopiert()}
      {:else}
        <CopyIcon class="size-3.5" />
        {m.eigener_server_kopieren()}
      {/if}
    </Button>
  </div>
  <p class="text-text-muted text-xs">{m.eigener_server_befehl_hinweis()}</p>
  <a
    class="text-primary w-fit text-xs underline-offset-2 hover:underline"
    href={ANLEITUNG}
    target="_blank"
    rel="noopener"
    data-testid="self-host-install-guide"
  >
    {m.eigener_server_anleitung()}
  </a>
</div>
```

- [ ] **Step 6: `web/src/lib/components/selfhost/EigenerServerDialog.svelte` anlegen.**

```svelte
<!--
  „Eigenen Server einrichten“ (Spec 2026-10-09-selfhost-ohne-freigabe-design.md
  §5) — der eine Einstieg für alle Wege zu einem eigenen Server. Ersetzt die
  Seite „Eigener Server“ mit Antragsformular: kein Antrag, kein Warten.

  Ein Inhalt, zwei Hüllen: am Rechner und Tablet ein Dialog, am Handy ein Blatt
  von unten. Welche, entscheidet der Mount-Punkt im App-Layout (`blatt`) —
  Geräte-Trennung: diese Komponente fragt nicht selbst nach dem Gerät. Das
  Blatt läuft über `BottomSheet` (Portal; `glass-panel` hat `backdrop-filter`,
  `position: fixed` bezöge sich sonst nicht aufs Fenster).

  Geöffnet über `uiOverlays.eigenerServerOpen` — vom Plus jeder Server-Gruppe
  (`GuildRailPlusMenu`) und vom Menü der Räume (`RaeumeMenue`).
-->
<script lang="ts">
  import type { Component } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import BottomSheet from '$lib/components/mobile/BottomSheet.svelte';
  import ServerAppDownload from '$lib/components/account/ServerAppDownload.svelte';
  import SelfHostInstallCard from './SelfHostInstallCard.svelte';
  import MonitorIcon from '@lucide/svelte/icons/monitor';
  import ServerIcon from '@lucide/svelte/icons/server';
  import CloudIcon from '@lucide/svelte/icons/cloud';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { blatt }: { blatt: boolean } = $props();

  function schliessen(): void {
    uiOverlays.eigenerServerOpen = false;
  }

  const KARTE = 'border-border bg-bg-input/40 flex flex-col gap-3 rounded-2xl border p-4';
</script>

{#snippet kopf(icon: Component, titel: string, text: string)}
  {@const Icon = icon}
  <div class="flex items-start gap-3 text-left">
    <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
      <Icon class="size-5" />
    </span>
    <div class="flex min-w-0 flex-col gap-0.5">
      <h3 class="text-text-bright text-sm font-semibold">{titel}</h3>
      <p class="text-text-muted text-xs">{text}</p>
    </div>
  </div>
{/snippet}

{#snippet wege()}
  <p class="text-text-muted text-sm">{m.hosting_apply_mode_label()}</p>
  <section class={KARTE} data-testid="eigener-server-rechner">
    {@render kopf(MonitorIcon, m.eigener_server_rechner_titel(), m.eigener_server_rechner_text())}
    <ServerAppDownload />
  </section>
  <section class={KARTE} data-testid="eigener-server-gemietet">
    {@render kopf(ServerIcon, m.eigener_server_gemietet_titel(), m.eigener_server_gemietet_text())}
    <SelfHostInstallCard />
  </section>
  <!-- „Von Pulse gehostet“ gibt es noch nicht. Der Hinweis hing am
       Antragsformular und wäre mit ihm verschwunden — ausgegraut stehen lassen
       (Entscheid des Eigentümers, 2026-10-10). -->
  <div
    class="{KARTE} cursor-not-allowed opacity-60"
    aria-disabled="true"
    data-testid="eigener-server-gehostet"
  >
    <div class="flex items-start gap-3 text-left">
      <span class="bg-bg-input text-text-muted flex size-9 shrink-0 items-center justify-center rounded-full">
        <CloudIcon class="size-5" />
      </span>
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="flex items-center gap-1.5">
          <h3 class="text-text-bright text-sm font-semibold">{m.hosting_apply_mode_managed_title()}</h3>
          <span
            class="bg-bg-input text-text-muted rounded-full px-1.5 py-0.5 text-2xs font-medium tracking-wide uppercase"
            >{m.hosting_apply_mode_managed_badge()}</span
          >
        </span>
        <p class="text-text-muted text-xs">{m.hosting_apply_mode_managed_desc()}</p>
      </div>
    </div>
  </div>
  <Button variant="outline" class="w-full" onclick={schliessen} data-testid="eigener-server-schliessen">
    {m.eigener_server_schliessen()}
  </Button>
{/snippet}

{#if blatt}
  <BottomSheet
    open={uiOverlays.eigenerServerOpen}
    testid="eigener-server-blatt"
    closeLabel={m.eigener_server_schliessen()}
    panelClass="bg-popover text-popover-foreground border-border relative flex max-h-[85dvh] flex-col gap-4 overflow-y-auto rounded-t-[22px] border-t p-4 pb-[max(1rem,var(--safe-bottom))] shadow-2xl"
    panelTestid="eigener-server-dialog"
    onClose={schliessen}
  >
    <div class="bg-border mx-auto h-1 w-9 shrink-0 rounded-full"></div>
    <h2 class="text-text-bright text-lg font-semibold">{m.eigener_server_einrichten()}</h2>
    {@render wege()}
  </BottomSheet>
{:else}
  <Dialog.Root
    open={uiOverlays.eigenerServerOpen}
    onOpenChange={(v) => {
      if (!v) schliessen();
    }}
  >
    <Dialog.Content
      class="max-h-[90dvh] gap-4 overflow-y-auto nicht-handy:max-w-lg"
      data-testid="eigener-server-dialog"
    >
      <Dialog.Title>{m.eigener_server_einrichten()}</Dialog.Title>
      {@render wege()}
    </Dialog.Content>
  </Dialog.Root>
{/if}
```

- [ ] **Step 7: Doppelten Einleitungssatz aus `ServerAppDownload` nehmen.** Der Dialog trägt den Untertitel selbst; `server_app_download_intro` („… Kein Antrag, kein VPS.“) stünde sonst darunter noch einmal. `web/src/lib/components/account/ServerAppDownload.svelte` — Zeilen 1–9 alt:

```svelte
<!--
  Heim-Server: Download der Pulse Server-App.

  Seit dem Selbstbedienungs-Entscheid (2026-09-27) braucht es keine
  Freischaltung und keinen Antrag mehr: Server-App installieren, mit dem
  howispulse.com-Konto einloggen — die Registrierung passiert beim ersten
  Start von selbst. Diese Karte zeigt den Download für das laufende System;
  ohne erkennbare Plattform alle drei.
-->
```

neu:

```svelte
<!--
  Heim-Server: Download der Pulse Server-App, im Dialog „Eigenen Server
  einrichten“ unter „Auf diesem Rechner“ (EigenerServerDialog — der trägt die
  Erklärung, hier steht nur noch der Knopf).

  Seit dem Selbstbedienungs-Entscheid (2026-09-27) braucht es keine
  Freischaltung und keinen Antrag mehr: Server-App installieren, mit dem
  howispulse.com-Konto einloggen — die Registrierung passiert beim ersten
  Start von selbst. Gezeigt wird der Download für das laufende System; ohne
  erkennbare Plattform alle drei.
-->
```

Zeile 33 (`<p class="text-text-muted text-sm">{m.server_app_download_intro()}</p>`) löschen.

- [ ] **Step 8: Plus-Menü aus der GuildRail herausziehen und erweitern.** Die Leiste hat 874 Zeilen und liegt weit über der Grenze; der neue Eintrag geht in eine eigene Komponente, die Leiste schrumpft dabei. `web/src/lib/components/GuildRailPlusMenu.svelte`:

```svelte
<!--
  Das „+“ unter jeder Server-Gruppe der GuildRail: Community erstellen (nur mit
  Erstellrecht), Community beitreten, und — nach einem Trenner, in jedem Plus
  gleich — „Eigenen Server einrichten“ (Spec 2026-10-09 §5; ersetzt den
  Server-Knopf unten in der Leiste). Herausgezogen aus `GuildRail.svelte`,
  damit die Leiste schrumpft statt wächst.

  Bewusst kleiner als die Community-Symbole (gestrichelt), damit es als
  Sektions-Aktion liest. Der Aufrufer aktiviert vor `onAnlegen`/`onBeitreten`
  den Server — die neue Community landet garantiert auf DIESEM Server.
-->
<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import UsersRoundIcon from '@lucide/svelte/icons/users-round';
  import LogInIcon from '@lucide/svelte/icons/log-in';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let {
    serverId,
    darfAnlegen,
    onAnlegen,
    onBeitreten
  }: {
    serverId: string;
    /** Admin oder `allow_guild_creation` (lib/servers/erstellrecht.ts). */
    darfAnlegen: boolean;
    onAnlegen: () => void;
    onBeitreten?: () => void;
  } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <!-- KEIN Tooltip-Wrapper: ein zweiter Trigger-Spread (tipProps)
           überschreibt die Klick-Handler des DropdownMenu-Triggers, dann
           öffnet das Menü nur per Tastatur, nicht per Maus. aria-label
           deckt die Zugänglichkeit ab. -->
      <button
        {...props}
        class="border-primary/40 text-primary flex size-12 shrink-0 items-center justify-center rounded-xl border border-dashed nicht-handy:size-10 bg-transparent transition-all hover:bg-primary/10"
        data-testid={`guild-create-menu-${serverId}`}
        aria-label={darfAnlegen ? m.guild_rail_create_community() : m.guild_rail_join_community()}
      >
        <PlusIcon class="size-4" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content side="right" align="start" class="w-56">
    {#if darfAnlegen}
      <DropdownMenu.Item onSelect={onAnlegen} data-testid="guild-create">
        <UsersRoundIcon />
        {m.guild_rail_create_community()}
      </DropdownMenu.Item>
    {/if}
    {#if onBeitreten}
      <DropdownMenu.Item onSelect={onBeitreten} data-testid="guild-join">
        <LogInIcon />
        {m.guild_rail_join_community()}
      </DropdownMenu.Item>
    {/if}
    <DropdownMenu.Separator />
    <!-- `onclick` wie die Dialog-Einträge im Konto-Menü (UserFooter: Einstellungen,
         Problem melden). Dass der Dialog danach bedienbar ist, belegt
         eigener-server.spec.ts mit einem Klick auf „Schließen“ im Dialog. -->
    <DropdownMenu.Item
      onclick={() => (uiOverlays.eigenerServerOpen = true)}
      data-testid="guild-eigener-server"
    >
      <ServerIcon />
      {m.eigener_server_einrichten()}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
```

In `web/src/lib/components/GuildRail.svelte`:
- Zeilen 18, 20, 27, 28 löschen (`import * as DropdownMenu …`, `import PlusIcon …`, `import UsersRoundIcon …`, `import LogInIcon …`) — nach dem Herausziehen nirgends mehr benutzt (geprüft: `grep -n "DropdownMenu\|PlusIcon\|UsersRoundIcon\|LogInIcon"` trifft nur die Zeilen 699–737).
- Nach Zeile 65 (`import ServerAdminButton from './ServerAdminButton.svelte';`): `  import GuildRailPlusMenu from './GuildRailPlusMenu.svelte';`
- Zeilen 692–738 alt (Kommentar `<!-- Per-Server-„+": Mini-Menü …` bis zum schließenden `{/if}` nach `</DropdownMenu.Root>`) ersetzen durch:

```svelte
      <!-- Per-Server-„+": Mini-Menü für DIESEN Server (GuildRailPlusMenu).
           IMMER sichtbar (jedes Mitglied kann einer Community beitreten und
           einen eigenen Server einrichten); nur „Community erstellen“ ist
           gegatet (``canCreateOnServer`` = Admin oder allow_guild_creation). -->
      {#if onCreateClick || onJoinClick}
        <GuildRailPlusMenu
          serverId={server.id}
          darfAnlegen={!!onCreateClick && canCreateOnServer(server)}
          onAnlegen={() => createOnServer(server.id)}
          onBeitreten={onJoinClick ? () => joinOnServer(server.id) : undefined}
        />
      {/if}
```

- [ ] **Step 9: Menü der Räume herausziehen und erweitern.** Die Route hat 267 Zeilen; das Menü wandert nach `components/mobile/` (bedingungslos mobile Fläche, Geräte-Trennung erlaubt). `web/src/lib/components/mobile/RaeumeMenue.svelte`:

```svelte
<!--
  Menü oben rechts im Räume-Bereich (Handy und Tablet). Herausgezogen aus
  `routes/app/rooms/+page.svelte`, als „Eigenen Server einrichten“ dazukam —
  das Gegenstück zum Plus der GuildRail, die es hier nicht gibt (Spec
  2026-10-09 §5).

  Drei-Punkte wie in Chats und Freunde: Entdecken ist der Ausgang ins
  Verzeichnis, kein dauerhaft sichtbarer Zustand der eigenen Räume. „Community
  beitreten“ = Server per Adresse beitreten (Erstkontakt, kein Invite-Code):
  `/app?add=join` wie die GuildRail; warum es diesen Einstieg auf Handy und
  Tablet braucht, steht in `CommunityBeitretenKnopf.svelte`.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import CompassIcon from '@lucide/svelte/icons/compass';
  import LogInIcon from '@lucide/svelte/icons/log-in';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import ServerIcon from '@lucide/svelte/icons/server';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { uiOverlays } from '$lib/stores/uiOverlays.svelte';
  import { m } from '$lib/paraglide/messages.js';
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        class="text-text-muted hover:bg-bg-hover hover:text-text-bright flex size-12 items-center justify-center rounded-[14px] transition-colors"
        data-testid="rooms-menu"
        aria-label={m.chats_menu()}
      >
        <EllipsisIcon class="size-6" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-56">
    <DropdownMenu.Item
      onclick={() => void goto('/app?add=join')}
      data-testid="rooms-menu-join"
      class="flex items-center gap-2"
    >
      <LogInIcon class="size-4" />
      {m.guild_rail_join_community()}
    </DropdownMenu.Item>
    <DropdownMenu.Item
      onclick={() => void goto('/app/discover')}
      data-testid="rooms-menu-discover"
      class="flex items-center gap-2"
    >
      <CompassIcon class="size-4" />
      {m.rooms_discover_short()}
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item
      onclick={() => (uiOverlays.eigenerServerOpen = true)}
      data-testid="rooms-eigener-server"
      class="flex items-center gap-2"
    >
      <ServerIcon class="size-4" />
      {m.eigener_server_einrichten()}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
```

In `web/src/routes/app/rooms/+page.svelte`:
- Zeilen 15–18 (`CompassIcon`, `LogInIcon`, `EllipsisIcon`, `DropdownMenu`) löschen; nach Zeile 26 (`import SelfHostRoomsButton …`, fällt in Task 5.2) einfügen: `  import RaeumeMenue from '$lib/components/mobile/RaeumeMenue.svelte';`
- Zeilen 120–158 alt (`{#snippet handlung()}` … `{/snippet}` samt Kommentar und `DropdownMenu.Root`) ersetzen durch:

```svelte
    {#snippet handlung()}
      <RaeumeMenue />
    {/snippet}
```

Die `w-52` des alten Menüs wird `w-56`: „Eigenen Server einrichten“ mit Symbol passt nicht in 13 rem.

- [ ] **Step 10: Dialog im App-Layout montieren.** `web/src/routes/app/+layout.svelte` nach Zeile 67 (`import EinladungDialog …`):

```ts
  import EigenerServerDialog from '$lib/components/selfhost/EigenerServerDialog.svelte';
```

Nach Zeile 560 (`<EinladungDialog />`):

```svelte
  <!-- „Eigenen Server einrichten“: EIN Mount für beide Einstiege (Plus der
       Leiste, Menü der Räume). Die Hülle wählt hier die Geräteklasse —
       Geräte-Trennung, die Komponente fragt nicht selbst. -->
  <EigenerServerDialog blatt={viewport.isMobile} />
```

- [ ] **Step 11: Alte Heim-Server-Prüfung entfernen.** Beide Tests aus `web/tests/e2e/heim-server.spec.ts` sind in Step 1 am Dialog abgedeckt (Download sofort sichtbar, Windows-Knopf, kein Antragsformular):

```bash
cd /home/michael/Dokumente/pulse && git rm web/tests/e2e/heim-server.spec.ts
grep -rn "heim-server.spec" web docs scripts .github | grep -v "heim-server-direkt"
```
Expected: keine Treffer (`heim-server-direkt.spec.ts` ist eine andere Datei und bleibt).

- [ ] **Step 12: Prüfen.**

```bash
cd /home/michael/Dokumente/pulse/web && wc -l src/lib/components/GuildRail.svelte src/routes/app/rooms/+page.svelte \
  src/lib/components/selfhost/EigenerServerDialog.svelte src/lib/components/GuildRailPlusMenu.svelte \
  src/lib/components/mobile/RaeumeMenue.svelte \
  && pnpm check && pnpm build && pnpm test:unit && cd .. && bash scripts/geraete-trennung.sh
cd /home/michael/Dokumente/pulse/web && pnpm exec playwright test tests/e2e/eigener-server.spec.ts tests/e2e/selfhost-einstieg.spec.ts
```
Expected: GuildRail etwa 840 Zeilen (vorher 874), Räume-Route etwa 230 (vorher 267), neue Komponenten ≤ 250; 0 Fehler; Geräte-Trennung grün (`viewport` nur im Layout); beide Playwright-Dateien grün (`selfhost-einstieg.spec.ts` prüft bis Task 5.2 noch den alten Knopf, der hier unberührt bleibt).

- [ ] **Step 13: Vereinfachen, committen.**

```bash
cd /home/michael/Dokumente/pulse && bash .claude/hooks/simplify-stamp.sh
git add web/src/lib/components/selfhost/SelfHostInstallCard.svelte \
  web/src/lib/components/selfhost/EigenerServerDialog.svelte \
  web/src/lib/components/GuildRailPlusMenu.svelte web/src/lib/components/mobile/RaeumeMenue.svelte \
  web/src/lib/components/GuildRail.svelte web/src/routes/app/rooms/+page.svelte \
  web/src/routes/app/+layout.svelte web/src/lib/stores/uiOverlays.svelte.ts \
  web/src/lib/components/account/ServerAppDownload.svelte \
  web/messages/de.json web/messages/en.json web/tests/e2e/eigener-server.spec.ts
git commit -m "feat(web): „Eigenen Server einrichten“ im Plus und im Menü der Räume

Ein Dialog (am Handy ein Blatt) mit Server-App, Installationsbefehl und
„Von Pulse gehostet (Bald)“. Plus-Menü und Räume-Menü als eigene
Komponenten, damit Leiste und Route schrumpfen.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.2: „Meine Server“ statt Server-Knopf; Einrichtung und Antragsbeobachtung entfernen

**Files:**
- Create: `web/src/lib/selfhost/eigeneServer.ts`
- Create: `web/test/eigene-server.test.ts`
- Modify: `web/src/lib/components/UserFooter.svelte:15-21` (Importe), `:36-40`, `:74-85`
- Modify: `web/src/lib/components/mobile/MeSectionList.svelte:1-14,15-31,84-87,118-133`
- Modify (ganz ersetzen): `web/src/routes/app/server/+page.svelte`, `web/src/lib/components/account/MyInstances.svelte`
- Modify: `web/src/lib/navigation/tabs.ts:41-45,54-58,104-109`, `web/test/tabs.test.ts:42-48,85-91`
- Modify: `web/src/lib/components/GuildRail.svelte:66` (Import), `:742-748` (Kommentar), `:771` (Mount), `:794-810` (Betreiber-Hinweis) — nach Task 5.1 liegen diese Stellen etwa 35 Zeilen höher
- Modify: `web/src/routes/app/rooms/+page.svelte:26` (Import), `:255-261` (Knopf) — nach Task 5.1 etwa 37 Zeilen höher
- Modify: `web/src/routes/app/+layout.svelte:24`, `:280-282`, `:290-292`, `:365` (nach Task 5.1: +1 ab Zeile 68)
- Modify: `web/src/lib/stores/auth.svelte.ts:319-324`, `:454-462`
- Modify: `web/src/lib/ws/handlers/admin.ts` (ganz ersetzen)
- Modify: `web/tests/e2e/eigener-server.spec.ts` (Tests anfügen)
- Delete: `web/src/lib/components/selfhost/SelfHostPanel.svelte`, `SelfHostRailButton.svelte`, `SelfHostRoomsButton.svelte`; `web/src/lib/selfhost/hinweis.svelte.ts`; `web/src/lib/stores/myInstanceApplications.svelte.ts`; `web/src/lib/components/account/SelfHostApplication.svelte`, `InlineResetPanel.svelte`, `ComposeDownloadLinks.svelte`, `setup/InstanceSetupPanel.svelte`, `setup/SetupSchnellweg.svelte`, `setup/SetupManuell.svelte`; `web/test/selfhost-einstieg-gating.test.ts`; `web/tests/e2e/selfhost-einstieg.spec.ts`
- Modify: `web/messages/de.json`, `web/messages/en.json` (Ende)

**Interfaces:**
- Produces: `hatEigeneServer(server: ReadonlyArray<{ isCloud: boolean; role?: string | null }>): boolean`; `data-testid` `user-footer-meine-server`, `me-meine-server`.
- Consumes: `serversStore.servers` (`ServerEntry.role`, gefüllt aus `GET /me/instances` über `hydrateFromBackend`/`instanzNachzug`), `instancesApi.listMyInstances/deleteMyInstance` (bleiben).
- Verhalten, das sich bewusst ändert: `/app/server` gehört zum Bereich „Du“ (vorher „Räume“) und ist am Handy ein Detail-Bildschirm (Bereichs-Leiste weg, Zurück führt nach `/app/me`) — der Einstieg sitzt dort jetzt im Du-Bereich.

- [ ] **Step 1: Test für die Sichtbarkeits-Rechnung.** `web/test/eigene-server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hatEigeneServer } from '../src/lib/selfhost/eigeneServer.ts';

const CLOUD = { isCloud: true, role: null };

test('nur die Cloud: kein eigener Server', () => {
  assert.equal(hatEigeneServer([CLOUD]), false);
  assert.equal(hatEigeneServer([]), false);
});

test('ein beigetretener fremder Server zählt nicht', () => {
  assert.equal(hatEigeneServer([CLOUD, { isCloud: false, role: 'member' }]), false);
});

test('ein eigener Server zählt, egal an welcher Stelle der Liste', () => {
  // Die Liste ist die des KONTOS, nicht die des aktiven Servers — die Reihenfolge
  // (und welcher davon gerade aktiv ist) spielt keine Rolle.
  assert.equal(hatEigeneServer([{ isCloud: false, role: 'owner' }, CLOUD]), true);
  assert.equal(
    hatEigeneServer([CLOUD, { isCloud: false, role: 'member' }, { isCloud: false, role: 'owner' }]),
    true
  );
});

test('unbekannte Rolle (Alt-Eintrag ohne Cloud-Abgleich) zählt nicht', () => {
  assert.equal(hatEigeneServer([CLOUD, { isCloud: false }, { isCloud: false, role: null }]), false);
});

test('eine Owner-Rolle an der Cloud ist kein eigener Server', () => {
  assert.equal(hatEigeneServer([{ isCloud: true, role: 'owner' }]), false);
});
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit`
Expected: FAIL — `Cannot find module '../src/lib/selfhost/eigeneServer.ts'`.

- [ ] **Step 3: `web/src/lib/selfhost/eigeneServer.ts` anlegen.**

```ts
/**
 * Hat dieses Konto einen eigenen Server? — reine Rechnung, importfrei
 * (Node-Unit-Test, s. `pnpm test:unit`-Falle in CLAUDE.md).
 *
 * Entscheidet, ob „Meine Server“ im Konto-Menü (`UserFooter`) und im
 * Du-Bereich (`MeSectionList`) erscheint (Spec 2026-10-09 §5). Eine Stelle für
 * beide, damit sie nicht auseinanderlaufen.
 *
 * **Quelle ist die Server-Liste des Kontos, nie der aktive Server.** Die Rolle
 * kommt aus `GET /me/instances` (`hydrateFromBackend`), also aus der Cloud,
 * und gilt unabhängig davon, welcher Server gerade aktiv ist. Bis 2026-08-28
 * hing der damalige Einstieg am aktiven Server — und fehlte ausgerechnet dem,
 * der auf seinem eigenen Server nach der Verwaltung suchte.
 *
 * Instanzen, deren Zugangsdaten nie abgeholt wurden (`set_up === false`),
 * stehen nicht in der Liste und zählen deshalb nicht. Für neue Server gibt es
 * diesen Zustand nicht mehr: verbunden heißt abgeholt (Spec E3).
 */
export function hatEigeneServer(
  server: ReadonlyArray<{ isCloud: boolean; role?: string | null }>
): boolean {
  return server.some((s) => !s.isCloud && s.role === 'owner');
}
```

- [ ] **Step 4: Unit-Test grün.** Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit` → PASS.

- [ ] **Step 5: Texte.** `web/messages/de.json` (Ende):

```json
  "eigener_server_meine_server": "Meine Server",
  "eigener_server_liste_leer": "Du hast noch keinen eigenen Server.",
  "eigener_server_status_aktiv": "Aktiv",
  "eigener_server_eingetragen_am": "Eingetragen am {date}",
  "eigener_server_loeschen_text": "{hostname} wird endgültig aus deinem Konto entfernt. Ein noch laufender Server stellt den Betrieb ein, und die Adresse wird wieder frei. Die Daten auf deinem Server (Docker-Volume) bleiben unberührt, die löschst du selbst. Das kann nicht rückgängig gemacht werden.",
  "eigener_server_verlassen_text": "{label} gehört dir, verlassen geht nicht. Wenn du den Server loswerden willst, lösche ihn unter „Meine Server“."
```

`web/messages/en.json` (Ende):

```json
  "eigener_server_meine_server": "My servers",
  "eigener_server_liste_leer": "You do not have a server of your own yet.",
  "eigener_server_status_aktiv": "Active",
  "eigener_server_eingetragen_am": "Added on {date}",
  "eigener_server_loeschen_text": "{hostname} will be removed from your account for good. A server that is still running stops operating, and the address becomes free again. The data on your server (Docker volume) stays untouched; you delete it yourself. This cannot be undone.",
  "eigener_server_verlassen_text": "{label} belongs to you, so you cannot leave it. If you want to get rid of the server, delete it under “My servers”."
```

- [ ] **Step 6: Konto-Menü.** `web/src/lib/components/UserFooter.svelte`:
- Nach Zeile 18 (`import StatusPicker …`):

```ts
  import { serversStore } from '$lib/api/servers.svelte';
  import { hatEigeneServer } from '$lib/selfhost/eigeneServer';
```

- Nach Zeile 21 (`import BugIcon …`): `  import ServerIcon from '@lucide/svelte/icons/server';`
- Zeilen 36–40 alt (Kommentar „Der „dein Antrag ist durch"-Punkt sass bis 2026-08-27 HIER …“) ersetzen durch:

```ts
  // „Meine Server“ nur, wenn das Konto einen eigenen Server hat (Spec
  // 2026-10-09 §5). Die Rolle kommt aus der Server-Liste des Kontos, nicht vom
  // aktiven Server — Begründung in `selfhost/eigeneServer.ts`.
  let meineServer = $derived(hatEigeneServer(serversStore.servers));
```

- Zeilen 75–77 alt:

```svelte
  <!-- Profilbild ändern/löschen wohnt jetzt ausschließlich im Profil-Tab der
       Einstellungen — hier bewusst nur noch Einstellungen + Abmelden, damit das
       Menü schlank bleibt und nichts doppelt anbietet. -->
```

neu:

```svelte
  <!-- Profilbild ändern/löschen wohnt ausschließlich im Profil-Tab der
       Einstellungen — hier bewusst nur Einstellungen, „Meine Server“ (nur mit
       eigenem Server), Problem melden und Abmelden, damit das Menü schlank
       bleibt und nichts doppelt anbietet. -->
```

- Nach Zeile 81 (das `</DropdownMenu.Item>` des Einstellungen-Eintrags) einfügen:

```svelte
  {#if meineServer}
    <DropdownMenu.Item onclick={() => goto('/app/server')} data-testid="user-footer-meine-server">
      <ServerIcon class="size-4" />
      {m.eigener_server_meine_server()}
    </DropdownMenu.Item>
  {/if}
```

- [ ] **Step 7: Du-Bereich.** `web/src/lib/components/mobile/MeSectionList.svelte`:
- Zeile 3 alt `   * Die Liste des Du-Bereichs: Profil, Status, Einstellungen, Abmelden.` → neu `   * Die Liste des Du-Bereichs: Profil, Status, Medien, Meine Server (nur mit eigenem Server), Einstellungen, Abmelden.`
- Nach Zeile 17 (`import ImageIcon …`): `  import ServerIcon from '@lucide/svelte/icons/server';`
- Nach Zeile 28 (`import StatusPicker …`):

```ts
  import { serversStore } from '$lib/api/servers.svelte';
  import { hatEigeneServer } from '$lib/selfhost/eigeneServer';
```

- Nach Zeile 87 (`let medienOffen = $state(false);`):

```ts

  /** „Meine Server“ — nur mit eigenem Server (Rechnung in
   *  `selfhost/eigeneServer.ts`, dieselbe wie im Konto-Menü am Rechner). */
  let meineServer = $derived(hatEigeneServer(serversStore.servers));
```

- Zeile 118 `<!-- Medien-Archiv -->` → `<!-- Medien-Archiv und eigene Server: Bestände, keine Einstellungen -->`
- Nach Zeile 132 (das `</button>` des Medien-Eintrags, vor dem schließenden `</div>` der Karte) einfügen:

```svelte
      {#if meineServer}
        <button
          class="hover:bg-bg-hover border-border flex min-h-12 w-full items-center gap-3 border-t px-3 py-3 text-left transition-colors"
          onclick={() => goto('/app/server')}
          data-testid="me-meine-server"
        >
          <ServerIcon class="text-text-muted size-5 shrink-0" />
          <span class="text-text-bright flex-1 truncate text-sm font-medium"
            >{m.eigener_server_meine_server()}</span
          >
          <ChevronRightIcon class="text-text-muted size-4 shrink-0" />
        </button>
      {/if}
```

- [ ] **Step 8: Route `/app/server` ersetzen.** `web/src/routes/app/server/+page.svelte` vollständig:

```svelte
<!--
  /app/server — „Meine Server“: die eigenen Server des Kontos mit Diagnose und
  Löschen (Spec 2026-10-09 §5). Seit dem Wegfall der Freigabe (2026-10) steht
  hier nur noch die Verwaltung; Einrichten läuft über den Dialog „Eigenen
  Server einrichten“ (Plus der Leiste, Menü der Räume).

  Einstiege: „Meine Server“ im Konto-Menü (am Rechner) und im Du-Bereich (Handy
  und Tablet), beide nur mit eigenem Server; dazu der Betreiber-Hinweis
  „Verlassen geht nicht“ und „Eigene Server verwalten“ im Kontextmenü eines
  eigenen Servers in der Leiste.

  Der Rahmen folgt `/app/invites`: am Rechner die GuildRail daneben, darunter
  ein Vollbild mit Zurück-Kopf wie `/app/me/[section]`.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
  import GuildRail from '$lib/components/GuildRail.svelte';
  import MyInstances from '$lib/components/account/MyInstances.svelte';
  import { guilds } from '$lib/stores/guilds.svelte';
  import { currentServerUserId } from '$lib/stores/currentServerUser';
  import { selectGuild } from '$lib/navigation/railNavi';
  import { viewport } from '$lib/stores/viewport.svelte';
  import { m } from '$lib/paraglide/messages.js';

  // Zurück dorthin, wo der Einstieg steht: auf Handgeräten der Du-Bereich, am
  // Rechner die Startseite (das Konto-Menü ist kein Ort, zu dem man
  // zurückkehrt). Klasse statt Fensterbreite — s. `viewport.svelte.ts`.
  let zurueckZiel = $derived(viewport.isDesktop ? '/app' : '/app/me');
</script>

<GuildRail
  guilds={guilds.list}
  activeGuildId={''}
  currentUserId={currentServerUserId()}
  onSelect={selectGuild}
  onCreateClick={() => goto('/app?add=create')}
  onJoinClick={() => goto('/app?add=join')}
/>

<section
  class="glass-panel flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none nicht-handy:rounded-2xl"
  data-testid="self-host-page"
>
  <!-- Der Weg zurück gehört auf JEDE Größe: das hier ist ein aufgeschobener
       Bildschirm, keine der vier Bereichs-Seiten (deshalb auch kein
       `BereichsKopf`, der trägt bewusst keine Zurück-Geste). -->
  <header class="border-border text-text-bright flex h-14 shrink-0 items-center gap-1 border-b px-2">
    <button
      class="text-text-muted hover:text-primary flex min-h-12 min-w-12 items-center justify-center"
      onclick={() => goto(zurueckZiel)}
      data-testid="self-host-back"
      aria-label={m.settings_dialog_back()}
    >
      <ChevronLeftIcon class="size-6" />
    </button>
    <span class="truncate text-base font-bold tracking-tight">{m.eigener_server_meine_server()}</span>
  </header>

  <div class="flex-1 overflow-y-auto p-4 nicht-handy:p-6">
    <!-- Die Liste holt ihre Daten über `cookieFetch` und damit immer von der
         Cloud, unabhängig vom aktiven Server. -->
    <MyInstances />
  </div>
</section>
```

- [ ] **Step 9: `MyInstances` entschlacken.** `web/src/lib/components/account/MyInstances.svelte` vollständig:

```svelte
<!--
  „Meine Server“ — die eigenen Server des Kontos (Route `/app/server`).
  Endpoint: GET /me/instances (Cookie-Auth via instancesApi).

  Seit dem Wegfall der Freigabe (2026-10, Spec 2026-10-09 §5) steht hier nur
  die Verwaltung: Diagnose und Löschen. Das Einrichten eines freigegebenen VPS
  („Server einrichten“ mit Installer-Befehl und `.env`) ist entfallen — ein
  neuer Server verbindet sich beim Installieren selbst (`pulse-connect`).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { m } from '$lib/paraglide/messages.js';
  import { currentLocale } from '$lib/i18n';
  import { instancesApi, type Instance } from '$lib/api/instances';
  import { serversStore } from '$lib/api/servers.svelte';
  import { removeServerLocally } from '$lib/api/server-removal';
  import InstanceDiagnose from './InstanceDiagnose.svelte';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';

  let instances = $state<Instance[]>([]);
  let loading = $state(true);
  let deleteTarget = $state<Instance | null>(null);
  let deleteConfirmOpen = $state(false);
  let deleting = $state(false);

  function openDelete(inst: Instance) {
    deleteTarget = inst;
    deleteConfirmOpen = true;
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    deleting = true;
    const id = deleteTarget.id;
    try {
      await instancesApi.deleteMyInstance(id);
      instances = instances.filter((i) => i.id !== id);
      // Auch aus der eigenen Server-Leiste entfernen (Match über die
      // Instanz-ID) — andere Geräte/User räumt der Start-Sweep auf
      // (deleted-instance-sweep.ts).
      const localEntry = serversStore.servers.find((s) => s.instance_id === id);
      if (localEntry) removeServerLocally(localEntry.id);
      toast.success(m.my_instances_delete_success());
    } catch {
      toast.error(m.my_instances_delete_error());
    } finally {
      deleting = false;
      deleteConfirmOpen = false;
      deleteTarget = null;
    }
  }

  onMount(async () => {
    try {
      // Nur EIGENE Instanzen: die Antwort enthält auch Server, denen man bloß
      // beigetreten ist (Account-basierte Server-Liste) — die gehören in die
      // Server-Leiste, nicht hierher. Ohne den Filter bot diese Liste einem
      // Mitglied das Löschen eines fremden Servers an; die Routen sind
      // owner-verriegelt, der Knopf sah nur echt aus.
      instances = (await instancesApi.listMyInstances()).filter((i) => i.role === 'owner');
    } catch {
      // Nicht kritisch
    } finally {
      loading = false;
    }
  });

  function statusClass(s: string): string {
    return s === 'active' ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive';
  }
</script>

<div class="flex flex-col gap-5" data-testid="my-instances">
  {#if loading}
    <LoadingState label={m.my_instances_loading()} />
  {:else if instances.length === 0}
    <EmptyState message={m.eigener_server_liste_leer()} />
  {:else}
    <div class="flex flex-col gap-2">
      {#each instances as inst (inst.id)}
        <div
          class="border-border bg-bg-input/30 flex flex-col gap-2 rounded-xl border p-3"
          data-testid="instance-row-{inst.id}"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-text-bright truncate text-sm font-medium">{inst.hostname}</p>
              <p class="text-text-muted mt-0.5 text-xs">
                {#if inst.origin === 'app_host'}
                  {m.my_instances_apphost_label()} ·
                {/if}
                {m.eigener_server_eingetragen_am({
                  date: new Date(inst.registered_at).toLocaleDateString(currentLocale())
                })}
              </p>
            </div>
            <!-- „Aktiv“ statt des früheren „Freigegeben“ (Skizze des Eigentümers,
                 2026-10-10): eine Freigabe gibt es nicht mehr. Die Pille sagt
                 weiter nur, ob die Cloud den Server gesperrt hat — nicht, ob er
                 läuft; das beantwortet die Verbindungsprüfung darunter. -->
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium {statusClass(inst.status)}">
              {inst.status === 'active'
                ? m.eigener_server_status_aktiv()
                : m.my_instances_status_suspended()}
            </span>
          </div>
          <!-- Ob der Server von draußen ankommt, kann er selbst nicht sagen.
               Gilt seit dem Verbindungs-Check (2026-09-30) auch für Heim-Server:
               die Kette läuft gegen die Relay-Adresse. -->
          <InstanceDiagnose instanceId={inst.id} />
          <div class="mt-1 flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="xs"
              onclick={() => openDelete(inst)}
              data-testid="instance-delete-btn-{inst.id}"
            >
              <Trash2Icon class="size-3.5" />
              {m.my_instances_delete_button()}
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Lösch-Bestätigung -->
<AlertDialog.Root bind:open={deleteConfirmOpen}>
  <AlertDialog.Content data-testid="instance-delete-dialog">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.my_instances_delete_title()}</AlertDialog.Title>
      <AlertDialog.Description>
        {deleteTarget?.origin === 'app_host'
          ? m.my_instances_apphost_delete_description()
          : m.eigener_server_loeschen_text({ hostname: deleteTarget?.hostname ?? '' })}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{m.my_instances_delete_cancel()}</AlertDialog.Cancel>
      <AlertDialog.Action onclick={confirmDelete} disabled={deleting} data-testid="instance-delete-confirm">
        {m.my_instances_delete_action()}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
```

- [ ] **Step 10: Bereich und Detail-Bildschirm.** `web/test/tabs.test.ts` Zeilen 42–48 alt (`it('ordnet den eigenen Server den Raeumen zu', …)`) ersetzen durch:

```ts
  it('ordnet „Meine Server“ dem Du-Bereich zu', () => {
    // `/app/server` ist „Meine Server“; auf Tablet und Handy sitzt der
    // Einstieg seit 2026-10 im Du-Bereich (vorher am Fuss der Raeume-Liste).
    assert.equal(aktiverBereich('/app/server'), 'me');
  });
```

Nach dem Test „zaehlt Entdecken als Detail …“ (endet Zeile 91) einfügen:

```ts
  it('zaehlt „Meine Server“ als Detail, obwohl es eine eigene Wurzel ist', () => {
    // Aufgeschoben aus dem Du-Bereich wie `/app/me/<sektion>` — dort ist die
    // Leiste ebenfalls weg und der Pfeil oben fuehrt zurueck.
    assert.equal(istDetailScreen('/app/server'), true);
  });
```

Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit` → FAIL bei beiden neuen Erwartungen.

`web/src/lib/navigation/tabs.ts` Zeilen 41–45 alt:

```ts
 * `/app/guilds/...`, `/app/discover` und `/app/server` gehoeren zu „Raeume",
 * obwohl sie nicht unter `/app/rooms` liegen: der Kanal-Chat ist die dritte Ebene des
 * Raeume-Bereichs, und Entdecken ist der Ausgang aus seinem Leerzustand. Wer
 * hier nur das erste Segment vergleicht, verliert im offenen Kanal die
 * Hervorhebung.
```

neu:

```ts
 * `/app/guilds/...` und `/app/discover` gehoeren zu „Raeume", obwohl sie nicht
 * unter `/app/rooms` liegen: der Kanal-Chat ist die dritte Ebene des
 * Raeume-Bereichs, und Entdecken ist der Ausgang aus seinem Leerzustand. Wer
 * hier nur das erste Segment vergleicht, verliert im offenen Kanal die
 * Hervorhebung. `/app/server` („Meine Server“) gehoert aus demselben Grund zu
 * „Du“.
```

Zeilen 54–58 alt (Kommentar „Der eigene Server gehoert zu „Raeume" …“ und `['/app/server', 'rooms'],`) ersetzen durch:

```ts
  // „Meine Server“ gehoert zu „Du“, obwohl es nicht darunter liegt: auf Tablet
  // und Handy sitzt der Einstieg im Du-Bereich (seit 2026-10, vorher am Fuss
  // der Raeume-Liste). Ohne den Eintrag stuende beim Oeffnen kein Bereich
  // hervorgehoben da.
  ['/app/server', 'me'],
```

Zeilen 104–109 alt:

```ts
  // Entdecken ist ein AUFGESCHOBENER Bildschirm ueber den Raeumen, kein
  // fuenfter Bereich: man kommt aus dem Raeume-Bereich dorthin und mit dem
  // Pfeil oben wieder zurueck. Ohne diese Zeile stuenden Zurueck-Pfeil UND
  // Bereichs-Leiste gleichzeitig da — das liest sich wie zwei Aussagen
  // darueber, wo man gerade ist.
  if (p === '/app/discover') return true;
```

neu:

```ts
  // Entdecken und „Meine Server“ sind AUFGESCHOBENE Bildschirme ueber ihrem
  // Bereich (Raeume bzw. Du), kein fuenfter Bereich: man kommt von dort hin und
  // mit dem Pfeil oben wieder zurueck. Ohne diese Zeile stuenden Zurueck-Pfeil
  // UND Bereichs-Leiste gleichzeitig da — das liest sich wie zwei Aussagen
  // darueber, wo man gerade ist.
  if (p === '/app/discover' || p === '/app/server') return true;
```

Run: `pnpm test:unit` → PASS.

- [ ] **Step 11: Server-Knöpfe und Betreiber-Hinweis in der Leiste.** `web/src/lib/components/GuildRail.svelte`:
- Import `import SelfHostRailButton from '$lib/components/selfhost/SelfHostRailButton.svelte';` (heute Zeile 66) löschen.
- Im Kommentar über dem Fuß-Block (heute Zeilen 742–748) alt:

```svelte
  <!-- Unten in der Rail (mt-auto schiebt den Block ans Ende): der Remote-
       Rechner-Einstieg (Standplatz, unter Windows die Fernsteuerung), der
       Käfer DIREKT über dem Server-Symbol (Wunsch 2026-09-22 — im Störfall
       ohne Scrollen und ohne Menü-Klick erreichbar), der Server-Symbol-
       Einstieg und das Admin-Schild (nur Admins). Der eigene User wohnt im
```

neu:

```svelte
  <!-- Unten in der Rail (mt-auto schiebt den Block ans Ende): der Remote-
       Rechner-Einstieg (Standplatz, unter Windows die Fernsteuerung), der
       Käfer (Wunsch 2026-09-22 — im Störfall ohne Scrollen und ohne
       Menü-Klick erreichbar) und das Admin-Schild (nur Admins). Der
       Server-Knopf ist seit 2026-10 weg: Einrichten steckt im Plus jeder
       Server-Gruppe, „Meine Server“ im Konto-Menü. Der eigene User wohnt im
```

- Zeile `    <SelfHostRailButton />` (heute 771) löschen.
- Betreiber-Hinweis (heute Zeilen 794–810): Kommentar `<!-- Betreiber-Hinweis: Verlassen unmöglich, Löschen geht in den Einstellungen -->` → `<!-- Betreiber-Hinweis: Verlassen unmöglich, Löschen geht unter „Meine Server“ -->`; `{m.guild_rail_owner_leave_body({ label: ownerLeaveLabel })}` → `{m.eigener_server_verlassen_text({ label: ownerLeaveLabel })}`; `{m.guild_rail_owner_leave_open_settings()}` → `{m.eigener_server_meine_server()}`. `data-testid="owner-leave-open-settings"` bleibt (keine Verhaltensänderung am Ziel `/app/server`).

- [ ] **Step 12: Knopf am Ende der Räume-Liste.** `web/src/routes/app/rooms/+page.svelte`: Import `import SelfHostRoomsButton …` löschen; den Block (heute Zeilen 255–261, Kommentar „Der eigene Server ganz unten …“ und `<SelfHostRoomsButton />`) löschen.

- [ ] **Step 13: Antragsbeobachtung aus Layout, Anmeldung und WS entfernen.**

`web/src/routes/app/+layout.svelte` (Zeilen nach Task 5.1 ab 68 um +1 verschoben):
- `  import { myInstanceApplications } from '$lib/stores/myInstanceApplications.svelte';` (Zeile 24) löschen.
- Löschen:

```ts
    // Owner-Benachrichtigung: toastet, wenn ein eigener Antrag genehmigt/
    // abgelehnt wird. Interner Guard pollt nur bei offenem eigenen Antrag.
    myInstanceApplications.start();
```

- Den verwaisten Kommentar löschen:

```ts
    // Dasselbe für App-Hosting-Anträge — app-weit, nicht erst wenn die
    // Hosting-Karte gemountet ist: sonst gäbe es keinen roten Punkt, der den
    // frisch freigeschalteten User überhaupt erst dorthin führt.
```

- Im `onDestroy` `    myInstanceApplications.stop();` löschen.

`web/src/lib/stores/auth.svelte.ts`:
- Zeilen 319–324 löschen:

```ts
      // Self-Host-Antrags-Beobachter zurücksetzen (Memory pendingSetup + die
      // flachen Watch-/Ack-Keys), sonst zeigt der neue User den „genehmigt"-
      // Punkt des Vorgängers — und _poll räumt eine approved Watch-Map nie.
      void import('$lib/stores/myInstanceApplications.svelte').then((mod) =>
        mod.myInstanceApplications.reset(),
      );
```

- Zeilen 454–462 löschen (der Reset-Block und der danach verwaiste Kommentar über den App-Host-Antrags-Beobachter, zu dem es keinen Code mehr gibt):

```ts
    // Self-Host-Antrags-Beobachter (gerätelokaler Watch-/Ack-State + roter
    // Punkt) leeren — sonst erbt der nächste User am selben Gerät den
    // „genehmigt"-Punkt des Vorgängers (dyn. Import gegen Circular-Import).
    void import('$lib/stores/myInstanceApplications.svelte').then((mod) =>
      mod.myInstanceApplications.reset(),
    );
    // App-Host-Antrags-Beobachter desselben Vorgängers (Liste + localStorage-
    // Watch-Map) — analog myInstanceApplications, sonst bleibt die App-Host-
    // Antragsliste des alten Users stehen.
```

`web/src/lib/ws/handlers/admin.ts` vollständig (die Datei fällt in Task 5.4 ganz):

```ts
/**
 * Hosting-Anträge in Echtzeit — nur noch die Admin-Seite.
 *
 * `admin_application_pending` (admin:events → nur Admin-Sockets): ein neuer
 * Antrag liegt vor. Das Gegenstück `application_decided` an den Antragsteller
 * ist mit „Meine Server“ entfallen (2026-10): es gibt keinen eigenen Antrag
 * mehr zu beobachten.
 *
 * Das Ereignis trägt nur das Signal, keine Antragsdaten — der Store lädt seine
 * Liste danach über den regulären REST-Endpoint nach.
 */
import { pendingAppHostApplications } from '$lib/stores/pendingAppHostApplications.svelte';
import { pendingInstanceApps } from '$lib/stores/pendingInstanceApps.svelte';
import { registerWsHandler } from '../handler-registry';

export function register(): void {
  registerWsHandler('admin_application_pending', (evt) => {
    if (evt.kind === 'app_host') pendingAppHostApplications.refresh();
    else pendingInstanceApps.refresh();
  });
}
```

- [ ] **Step 14: Dateien löschen.**

```bash
cd /home/michael/Dokumente/pulse && git rm \
  web/src/lib/components/selfhost/SelfHostPanel.svelte \
  web/src/lib/components/selfhost/SelfHostRailButton.svelte \
  web/src/lib/components/selfhost/SelfHostRoomsButton.svelte \
  web/src/lib/selfhost/hinweis.svelte.ts \
  web/src/lib/stores/myInstanceApplications.svelte.ts \
  web/src/lib/components/account/SelfHostApplication.svelte \
  web/src/lib/components/account/InlineResetPanel.svelte \
  web/src/lib/components/account/ComposeDownloadLinks.svelte \
  web/src/lib/components/account/setup/InstanceSetupPanel.svelte \
  web/src/lib/components/account/setup/SetupSchnellweg.svelte \
  web/src/lib/components/account/setup/SetupManuell.svelte \
  web/test/selfhost-einstieg-gating.test.ts \
  web/tests/e2e/selfhost-einstieg.spec.ts
grep -rnE "SelfHostPanel|SelfHostRailButton|SelfHostRoomsButton|selfhost/hinweis|myInstanceApplications|SelfHostApplication|InlineResetPanel|ComposeDownloadLinks|InstanceSetupPanel|SetupSchnellweg|SetupManuell|selfHostEinstiegSichtbar|selfHostHinweisOffen|open-self-host|rooms-open-self-host|selfhost-einstieg" web/src web/test web/tests
```
Expected: keine Treffer. Die Lehre aus `selfhost-einstieg-gating.test.ts` („Einstieg hängt am Konto, nicht am aktiven Server“) steht jetzt im Kopf von `eigeneServer.ts` und in `eigene-server.test.ts`. `instancesApi.submitApplication/listMyApplications/mintBootstrapToken/downloadEnvFile` sind damit im Web unbenutzt; sie fallen in Task 5.4.

- [ ] **Step 15: E2E für „Meine Server“ anfügen.** In `web/tests/e2e/eigener-server.spec.ts` die Import-Zeile erweitern zu `import { test, expect, type BrowserContext, type Page } from '@playwright/test';`, nach `const HANDY …` einfügen:

```ts
const HOST = 'meine-server.dcc-test.example.com';
const INSTANZ = '7300000000000000001';

/** Täuscht einen eigenen, verbundenen Server in der Konto-Serverliste vor.
 *  Den Server selbst gibt es nicht — Anfragen an ihn werden sofort
 *  abgewiesen, statt in die Zeitüberschreitung zu laufen. */
async function eigenerServerVortaeuschen(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/api/auth/me/instances', (route) =>
    route.fulfill({
      json: [
        {
          id: INSTANZ,
          hostname: HOST,
          client_id: 'c-e2e',
          worker_id_chat: null,
          worker_id_voice: null,
          worker_id_media: null,
          status: 'active',
          origin: 'vps',
          ohne_freigabe: true,
          registered_at: '2026-10-10T12:00:00Z',
          notification_mode: 'all',
          role: 'owner',
          set_up: true,
          anzeigename: null,
          online: null
        }
      ]
    })
  );
  await ctx.route(`https://${HOST}/**`, (route) => route.abort());
}
```

und im `describe` nach den beiden Dialog-Tests anfügen:

```ts
  test('ohne eigenen Server: kein „Meine Server“, kein Server-Knopf', async ({ browser }) => {
    const page = await browser.newPage({ viewport: RECHNER });
    await registrieren(page, `es_ohne_${TAG}`);
    await expect(page.getByTestId('open-self-host')).toHaveCount(0);
    await page.getByTestId('user-footer-trigger').first().click();
    await expect(page.getByTestId('open-settings')).toBeVisible();
    await expect(page.getByTestId('user-footer-meine-server')).toHaveCount(0);
    await page.close();
  });

  test('am Rechner: „Meine Server“ im Konto-Menü führt zur Liste', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: RECHNER, serviceWorkers: 'block' });
    await eigenerServerVortaeuschen(ctx);
    const page = await ctx.newPage();
    await registrieren(page, `es_mit_${TAG}`);

    await page.getByTestId('user-footer-trigger').first().click();
    await page.getByTestId('user-footer-meine-server').click();
    await page.waitForURL(/\/app\/server/);
    await expect(page.getByTestId(`instance-row-${INSTANZ}`)).toBeVisible();
    await expect(page.getByTestId(`instance-delete-btn-${INSTANZ}`)).toBeVisible();
    await expect(page.getByTestId(`instance-setup-btn-${INSTANZ}`)).toHaveCount(0);

    await page.getByTestId('self-host-back').click();
    await page.waitForURL((u) => !u.pathname.startsWith('/app/server'));
    await ctx.close();
  });

  test('am Handy: „Meine Server“ im Du-Bereich, zurück führt dorthin', async ({ browser }) => {
    const handy = { viewport: HANDY, locale: 'de-DE', isMobile: true, hasTouch: true };

    const ohneCtx = await browser.newContext(handy);
    const ohne = await ohneCtx.newPage();
    await registrieren(ohne, `es_hohne_${TAG}`);
    await ohne.goto('/app/rooms');
    await expect(ohne.getByTestId('rooms-page')).toBeVisible();
    await expect(ohne.getByTestId('rooms-open-self-host')).toHaveCount(0);
    await ohne.goto('/app/me');
    await expect(ohne.getByTestId('me-page')).toBeVisible();
    await expect(ohne.getByTestId('me-meine-server')).toHaveCount(0);
    await ohneCtx.close();

    const ctx = await browser.newContext({ ...handy, serviceWorkers: 'block' });
    await eigenerServerVortaeuschen(ctx);
    const page = await ctx.newPage();
    await registrieren(page, `es_hmit_${TAG}`);
    await page.goto('/app/me');
    const eintrag = page.getByTestId('me-meine-server');
    await expect(eintrag).toBeVisible();
    // Trefferfläche wie überall auf schmalen Geräten: mindestens 48 dp.
    expect((await eintrag.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await eintrag.click();
    await page.waitForURL(/\/app\/server/);
    await expect(page.getByTestId(`instance-row-${INSTANZ}`)).toBeVisible();
    await page.getByTestId('self-host-back').click();
    await page.waitForURL((u) => u.pathname === '/app/me');
    await ctx.close();
  });
```

- [ ] **Step 16: Prüfen.**

```bash
cd /home/michael/Dokumente/pulse/web && wc -l src/lib/components/UserFooter.svelte src/lib/components/mobile/MeSectionList.svelte \
  src/lib/components/account/MyInstances.svelte src/routes/app/rooms/+page.svelte \
  && pnpm check && pnpm build && pnpm test:unit && cd .. && bash scripts/geraete-trennung.sh
cd /home/michael/Dokumente/pulse/web && pnpm exec playwright test tests/e2e/eigener-server.spec.ts \
  tests/e2e/mobile-treffflaechen.spec.ts tests/e2e/mobile-rooms.spec.ts
```
Expected: UserFooter etwa 160, MeSectionList etwa 190, MyInstances etwa 170, Räume-Route etwa 222 Zeilen; 0 Fehler; Unit grün (Zahl: −2 aus dem gelöschten Gating-Test, +5 neu, +1 tabs); `eigener-server.spec.ts` 5 Tests grün. Die beiden Mobil-Dateien sind auf `main` als rot bekannt (CLAUDE.md, Stand 2026-08-26) — hier zählt nur, dass KEIN neuer Fehler dazukommt: vor dem Lauf auf `main` dieselben zwei Dateien fahren und die Fehlerliste vergleichen.

- [ ] **Step 17: Vereinfachen, committen.**

```bash
cd /home/michael/Dokumente/pulse && bash .claude/hooks/simplify-stamp.sh
git add -A web/src web/test web/tests web/messages
git status --short   # nur die in **Files** genannten Pfade dürfen erscheinen
git commit -m "feat(web): „Meine Server“ im Konto-Menü und im Du-Bereich statt Server-Knopf

Der Knopf unten in der Leiste und am Ende der Räume-Liste entfällt,
ebenso die Einrichtung freigegebener Server und die Beobachtung eigener
Anträge. „Meine Server“ erscheint nur mit eigenem Server.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.3: Neuer Server erscheint sofort auf allen Geräten (`instanz_verbunden`)

Mit `myInstanceApplications` (Task 5.2) ist der bisherige Anstoß für
`serversStore.hydrateFromBackend()` weg — er kam aus der Freigabe
(`application_decided`). Ohne Ersatz erschiene ein frisch verbundener Server
auf schon offenen Geräten erst nach Neuanmeldung oder Neuladen; Spec E3 sagt
„in der Leiste aller seiner Geräte“. Teil A publiziert dafür nach dem Abholen
auf `user:events` an den Besitzer `{"op": "instanz_verbunden", "data":
{"instance_id": str}}`.

**Files:**
- Create: `web/test/hintergrund-allowlist.test.ts`
- Modify: `web/src/lib/ws/handlers/instanzen.ts:1-13` (Kopf), `:20-34` (`register`)
- Modify: `web/src/lib/ws/handlers/types.ts:440-446` (nach `instance_status`)
- Modify: `web/src/lib/ws/dispatch-rules.ts:65-68`
- Modify: `web/src/routes/verbinden/+page.svelte` (Kommentar über `leisteSpaeterAbgleichen`, aus Etappe 3)

**Interfaces:**
- Consumes (Teil A, Etappe 1): `user:events` → `{"op": "instanz_verbunden", "data": {"instance_id": str}}` an den Besitzer, nach erfolgreichem `abholen`.
- Consumes: `serversStore.hydrateFromBackend()` (`web/src/lib/api/servers.svelte.ts:372`, idempotent, entfernt nie), `dispatchingIsCloud()` (`web/src/lib/ws/gateway-connection.ts:135`), `registerWsHandler` (`web/src/lib/ws/handler-registry.ts:24`).
- Produces: `ServerEvent`-Glied `{ op: 'instanz_verbunden'; data: { instance_id: string } }`; Eintrag `'instanz_verbunden'` in `PURE_SOCIAL_OPS`.
- Kein neues Handler-Modul: `handlers/instanzen.ts` gibt es schon (nimmt `instance_status` an, gleiche Quelle, gleiche Cloud-Prüfung) und ist in `handlers/index.ts` direkt nach `admin.register()` registriert — die Registrierung bleibt, wenn `admin.ts` in Task 5.4 fällt.

**Warum die Allowlist zwingend ist:** Ist ein Self-Host aktiv, läuft die
Cloud-Verbindung im Hintergrund und dispatcht nur, was `backgroundEligible`
(`ws/dispatch-rules.ts`) erlaubt. Ohne Eintrag käme `instanz_verbunden` genau
dann nicht an — und das ist der Normalfall für einen Betreiber, der gerade auf
seinem eigenen Server ist. Dieselbe Fehlerklasse wie `postfach_neu` bis
2026-09-03 (CLAUDE.md, Abschnitt E2E-DMs); einen Test für die Allowlist gab es
bisher nur als Hetzner-E2E (`e2e-dm-hintergrund-hetzner.spec.ts`, nur
`postfach_neu`), keinen im Gate.

- [ ] **Step 1: Test schreiben.** `dispatch-rules.ts` importiert Svelte-Stores (`directMessages.svelte`) und ist für Nodes Läufer nicht ladbar (`$state is not defined`); der Test liest deshalb die Quelle — Muster `postfach-ready-echte-abos.test.ts`. `web/test/hintergrund-allowlist.test.ts`:

```ts
/**
 * Die Hintergrund-Allowlist der Cloud-Verbindung (`ws/dispatch-rules.ts`)
 * muss jedes Ereignis tragen, das NUR die Cloud schickt und auch bei aktivem
 * Self-Host ankommen muss.
 *
 * Die Fehlerklasse ist belegt: `postfach_neu` fehlte bis 2026-09-03, und eine
 * verschlüsselte DM erschien bei aktivem Self-Host erst nach einem Reload —
 * kein Test im Gate sah es (CLAUDE.md, Abschnitt E2E-DMs). Seit 2026-10 kommt
 * `instanz_verbunden` dazu: fehlt es, erscheint ein frisch verbundener Server
 * auf einem Gerät mit aktivem Self-Host erst nach einer Neuanmeldung.
 *
 * Warum die Quelle gelesen wird statt `backgroundEligible` aufzurufen:
 * `dispatch-rules.ts` importiert Svelte-Stores, Nodes Testläufer stirbt daran
 * (`$state is not defined`, s. `pnpm test:unit`-Falle in CLAUDE.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Quelltext ohne Kommentare — ein Op-Name im Kommentar zählt nicht. */
function quelle(pfad: string): string {
  return readFileSync(new URL(pfad, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function opsImHintergrund(): Set<string> {
  const code = quelle('../src/lib/ws/dispatch-rules.ts');
  const block = code.match(/const PURE_SOCIAL_OPS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'PURE_SOCIAL_OPS in ws/dispatch-rules.ts nicht gefunden');
  return new Set([...block[1].matchAll(/'([a-z_]+)'/g)].map((t) => t[1]));
}

test('die Gegenprobe: der Leser findet die bekannten Einträge', () => {
  // Ein Leser, der nichts findet, machte den nächsten Test immer rot — oder,
  // bei leerer Handler-Liste, immer grün. Diese Einträge stehen seit Monaten.
  const ops = opsImHintergrund();
  for (const op of ['friend_request_received', 'postfach_neu', 'instance_status']) {
    assert.ok(ops.has(op), op);
  }
});

test('jedes Ereignis aus handlers/instanzen.ts darf im Hintergrund durch', () => {
  // instanzen.ts nimmt nur Cloud-Ereignisse an (`dispatchingIsCloud()`), und
  // bei aktivem Self-Host läuft genau diese Verbindung im Hintergrund.
  const handler = quelle('../src/lib/ws/handlers/instanzen.ts');
  const registriert = [...handler.matchAll(/registerWsHandler\(\s*'([a-z_]+)'/g)].map((t) => t[1]);
  assert.ok(registriert.includes('instanz_verbunden'), 'instanz_verbunden fehlt in instanzen.ts');
  const ops = opsImHintergrund();
  for (const op of registriert) {
    assert.ok(ops.has(op), `${op} fehlt in PURE_SOCIAL_OPS (ws/dispatch-rules.ts)`);
  }
});
```

- [ ] **Step 2: Test laufen lassen, er muss scheitern.**

Run: `cd /home/michael/Dokumente/pulse/web && pnpm test:unit`
Expected: Gegenprobe PASS (nachgefahren am 2026-10-10: der Leser findet 18 Einträge), zweiter Test FAIL — `instanz_verbunden fehlt in instanzen.ts`.

- [ ] **Step 3: Ereignis-Typ.** `web/src/lib/ws/handlers/types.ts` nach Zeile 446 (das `}` des `instance_status`-Glieds) einfügen:

```ts
  // Ein eigener Server hat seine Zugangsdaten abgeholt (`pulse-connect`,
  // Spec E3). auth-svc über user:events, nur an den Besitzer. Nur von der
  // Cloud-Verbindung angenommen (handlers/instanzen.ts).
  | { op: 'instanz_verbunden'; data: { instance_id: string } }
```

- [ ] **Step 4: Empfänger.** `web/src/lib/ws/handlers/instanzen.ts` — Kopf (Zeilen 1–13) alt:

```ts
/**
 * Heim-Server läuft / läuft nicht / heißt jetzt so (`instance_status`, von
 * auth-svc über `user:events`, 2026-10-08).
```

neu (Rest des Kopfes bleibt):

```ts
/**
 * Heim-Server läuft / läuft nicht / heißt jetzt so (`instance_status`, von
 * auth-svc über `user:events`, 2026-10-08) — und ein eigener Server ist gerade
 * verbunden worden (`instanz_verbunden`, 2026-10).
```

In `register()` nach dem `instance_status`-Handler (vor der schließenden `}` in Zeile 34) einfügen:

```ts

  // Ein eigener Server hat seine Zugangsdaten abgeholt (Spec E3): erst jetzt
  // zählt er als eingerichtet (`set_up`), und der Abgleich holt ihn in die
  // Leiste DIESES Geräts. Die Instanz-ID wird nicht gebraucht —
  // `hydrateFromBackend` gleicht die ganze Liste ab, idempotent und ohne zu
  // entfernen. Ersetzt den Anstoß, der bis 2026-10 aus der Freigabe kam
  // (`application_decided`).
  registerWsHandler('instanz_verbunden', () => {
    if (!dispatchingIsCloud()) return;
    void serversStore.hydrateFromBackend();
  });
```

(`serversStore` und `dispatchingIsCloud` sind in Zeilen 14 und 17 schon importiert.)

- [ ] **Step 5: Allowlist.** `web/src/lib/ws/dispatch-rules.ts` Zeilen 65–68 alt:

```ts
  // Heim-Server an/aus/umbenannt (2026-10-08): kommt nur über die Cloud und
  // muss auch dann ankommen, wenn gerade ein Self-Host aktiv ist — sonst
  // bliebe ein gestoppter Server in der Leiste stehen.
  'instance_status',
```

neu:

```ts
  // Heim-Server an/aus/umbenannt (2026-10-08): kommt nur über die Cloud und
  // muss auch dann ankommen, wenn gerade ein Self-Host aktiv ist — sonst
  // bliebe ein gestoppter Server in der Leiste stehen.
  'instance_status',
  // Eigener Server frisch verbunden (2026-10): dieselbe Quelle, derselbe
  // Grund — wer gerade auf seinem Self-Host ist, sähe den neuen Server sonst
  // erst nach einer Neuanmeldung. Gedeckt von `hintergrund-allowlist.test.ts`.
  'instanz_verbunden',
```

- [ ] **Step 6: Kommentar der Bestätigungsseite nachziehen.** `web/src/routes/verbinden/+page.svelte` (aus Task 3.2) — den Kommentar über `leisteSpaeterAbgleichen` alt:

```ts
  /** Der neue Server zählt für die Leiste erst als eingerichtet, wenn
   *  `pulse-connect` die Zugangsdaten abgeholt hat (Spec E3) — das geschieht im
   *  Abfrage-Abstand der Konsole (5 s) NACH diesem Klick; ein Abgleich jetzt
   *  sähe ihn noch nicht. Einmalig und ohne Abbau beim Verlassen: der Store ist
   *  app-weit, und wer sofort „Zu Pulse“ klickt, soll den Server trotzdem
   *  bekommen. */
```

neu:

```ts
  /** Der neue Server zählt für die Leiste erst als eingerichtet, wenn
   *  `pulse-connect` die Zugangsdaten abgeholt hat (Spec E3) — das geschieht im
   *  Abfrage-Abstand der Konsole (5 s) NACH diesem Klick; ein Abgleich jetzt
   *  sähe ihn noch nicht. Andere Geräte holt das Ereignis `instanz_verbunden`
   *  (handlers/instanzen.ts); dieser Tab hat keine WebSocket, die Seite liegt
   *  außerhalb von /app. Einmalig und ohne Abbau beim Verlassen: der Store ist
   *  app-weit, und wer sofort „Zu Pulse“ klickt, soll den Server trotzdem
   *  bekommen. */
```

- [ ] **Step 7: Prüfen.**

```bash
cd /home/michael/Dokumente/pulse/web && pnpm check && pnpm build && pnpm test:unit \
  && cd .. && bash scripts/geraete-trennung.sh
```
Expected: 0 Fehler, Bau grün, beide neuen Unit-Tests grün (Testzahl +2).

Gegenprobe von Hand: `'instanz_verbunden',` in `dispatch-rules.ts` kurz auskommentieren → `pnpm test:unit` muss mit `instanz_verbunden fehlt in PURE_SOCIAL_OPS` scheitern; Zeile wiederherstellen.

Ein Laufzeit-Test fehlt bewusst: die Cloud schickt das Ereignis erst beim echten Abholen, und Playwrights WebSocket-Attrappe müsste die ganze Gateway-Begrüßung nachbauen. Geprüft wird es in Task 5.6 Step 3 von Hand.

- [ ] **Step 8: Vereinfachen, committen.**

```bash
cd /home/michael/Dokumente/pulse && bash .claude/hooks/simplify-stamp.sh
git add web/test/hintergrund-allowlist.test.ts web/src/lib/ws/handlers/instanzen.ts \
  web/src/lib/ws/handlers/types.ts web/src/lib/ws/dispatch-rules.ts \
  web/src/routes/verbinden/+page.svelte
git commit -m "feat(web): neu verbundener Server erscheint sofort auf allen Geräten

Empfänger für instanz_verbunden, auch bei aktivem Self-Host
(Hintergrund-Allowlist der Cloud-Verbindung) — mit Test im Gate.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.4: Admin-Oberfläche ohne Freigabe

**Files:**
- Modify (ganz ersetzen): `web/src/lib/api/instances.ts`, `web/src/lib/components/admin/AdminInstances.svelte`, `web/src/lib/components/admin/AdminInstancesActive.svelte`
- Modify: `web/src/routes/app/admin/+page.svelte:1-12,27,32-35,63-68,81,101-113,186-190`
- Modify: `web/src/lib/components/admin/AdminInstancesSuspended.svelte:26-30`
- Modify: `web/src/lib/components/ServerAdminButton.svelte:7-10,18-19,33-43,72`
- Modify: `web/src/lib/components/admin/AdminUserRow.svelte:1-6,17-21,78-85,127-133`
- Modify: `web/src/lib/components/admin/AdminUsers.svelte:25,36-41,98-109`
- Modify: `web/src/lib/api/admin.ts:16-29,284-301`
- Modify: `web/src/lib/ws/handlers/index.ts:27,53`, `web/src/lib/ws/handlers/types.ts:426-439`
- Modify: `web/src/routes/app/+layout.svelte` (heute Zeilen 22, 272–274, 362)
- Modify: `web/src/lib/stores/pendingComplaints.svelte.ts:4`
- Modify: `web/tests/e2e/admin.spec.ts:133-155` und Ende
- Delete: `web/src/lib/components/admin/AdminInstancesPending.svelte`, `AdminAppHostRevoke.svelte`, `web/src/lib/stores/pendingInstanceApps.svelte.ts`, `pendingAppHostApplications.svelte.ts`, `web/src/lib/ws/handlers/admin.ts`
- Modify: `web/messages/de.json`, `web/messages/en.json` (Ende)

**Interfaces:**
- Consumes (Etappe 1): `InstanceOut`/Admin-Instanzliste mit `ohne_freigabe: bool`, Worker-IDs `int | None`; Admin-Nutzer mit `server_verbinden_gesperrt: bool`, `PATCH /admin/users/{id}` mit `server_verbinden_gesperrt: bool | None`.
- Produces: `Instance.ohne_freigabe`, `AdminInstance.ohne_freigabe`, Worker-IDs `number | null`; `AdminUser.server_verbinden_gesperrt`; `data-testid` `admin-instance-ohne-freigabe`, `admin-instance-rotate-<id>`, `admin-instance-suspend-<id>`, `toggle-verbinden-btn` (`data-erlaubt="ja"|"nein"`).
- Unverändert: Reiter-ID `applications` (`admin-tab-applications`) — `admin.spec.ts` und jeder andere Verweis hängen daran; nur die Beschriftung wird „Server“.

- [ ] **Step 1: E2E erweitern.** In `web/tests/e2e/admin.spec.ts` im Test „navigating opens the panel with the cloud-admin sections“ nach der `for`-Schleife (vor dessen schließendem `});`, heute nach Zeile 154) einfügen:

```ts
    // Seit dem Wegfall der Freigabe (2026-10): Reiter „Server“ ohne Zähler,
    // kein Unterreiter „Ausstehend“.
    await page.getByTestId('admin-tab-applications').click();
    await expect(page.getByTestId('admin-tab-applications').locator('span')).toHaveCount(0);
    await expect(page.getByTestId('instances-tab-pending')).toHaveCount(0);
    await expect(page.getByTestId('instances-tab-active')).toBeVisible();
```

Am Ende des `describe` (nach „audit-log shows the DM-limits change“, damit keine Protokollzeile den Audit-Test stört) anfügen:

```ts
  test('Server-Liste: Vermerk „ohne Freigabe“, Secret rotieren nur bei freigegebenen', async () => {
    const FREI = '7300000000000000011';
    const OHNE = '7300000000000000012';
    const eintrag = (id: string, hostname: string, ohne_freigabe: boolean) => ({
      id,
      hostname,
      client_id: `c-${id}`,
      worker_id_chat: ohne_freigabe ? null : 1,
      worker_id_voice: ohne_freigabe ? null : 2,
      worker_id_media: ohne_freigabe ? null : 3,
      status: 'active',
      registered_at: '2026-10-10T12:00:00Z',
      registrar_username: ALICE.username,
      origin: 'vps',
      ohne_freigabe
    });
    const liste = /\/api\/auth\/admin\/instances\?status=active$/;
    await page.route(liste, (route) =>
      route.fulfill({
        json: [
          eintrag(FREI, 'frei.dcc-test.example.com', false),
          eintrag(OHNE, 'ohne.dcc-test.example.com', true)
        ]
      })
    );
    await page.reload();
    await openAdminTab('applications');
    await expect(
      page.getByTestId(`active-instance-${OHNE}`).getByTestId('admin-instance-ohne-freigabe')
    ).toBeVisible();
    await expect(
      page.getByTestId(`active-instance-${FREI}`).getByTestId('admin-instance-ohne-freigabe')
    ).toHaveCount(0);
    await expect(page.getByTestId(`admin-instance-rotate-${FREI}`)).toBeVisible();
    await expect(page.getByTestId(`admin-instance-rotate-${OHNE}`)).toHaveCount(0);
    await expect(page.getByTestId(`admin-instance-suspend-${OHNE}`)).toBeVisible();
    await page.unroute(liste);
  });

  test('Nutzerliste: „Darf Server verbinden“ statt Hosting-Schalter', async () => {
    await openAdminTab('users');
    await expect(page.getByTestId('admin-users-filter-self_host')).toHaveCount(0);
    await page.getByTestId('admin-users-search').fill(BOB.username);
    const zeile = page.getByTestId('admin-user-row').filter({ hasText: BOB.username });
    await expect(zeile).toHaveCount(1, { timeout: 5_000 });
    await expect(zeile.getByTestId('badge-selfhost')).toHaveCount(0);

    await zeile.getByTestId('admin-user-actions').click();
    await expect(page.getByTestId('toggle-selfhost-btn')).toHaveCount(0);
    const schalter = page.getByTestId('toggle-verbinden-btn');
    await expect(schalter).toHaveAttribute('data-erlaubt', 'ja');
    await schalter.click();
    // Die Zeile rendert aus der Antwort von PATCH /admin/users/{id} neu.
    await expect(schalter).toHaveAttribute('data-erlaubt', 'nein', { timeout: 5_000 });
  });
```

Run: `cd /home/michael/Dokumente/pulse/web && pnpm exec playwright test tests/e2e/admin.spec.ts`
Expected: FAIL — `instances-tab-pending` noch vorhanden.

- [ ] **Step 2: Texte.** `web/messages/de.json` (Ende):

```json
  "admin_tab_servers": "Server",
  "admin_instances_description_frei": "Alle Server, die die Cloud kennt — freigegebene und solche ohne Freigabe. Sperren wirkt sofort für neue Anmeldungen.",
  "admin_instances_ohne_freigabe": "ohne Freigabe",
  "admin_users_darf_verbinden": "Darf Server verbinden",
  "admin_users_verbinden_updated": "Erlaubnis zum Verbinden aktualisiert.",
  "admin_badge_meldungen_aria": "Offene Meldungen"
```

`web/messages/en.json` (Ende):

```json
  "admin_tab_servers": "Servers",
  "admin_instances_description_frei": "All servers the cloud knows — approved ones and those without approval. Suspending takes effect for new sign-ins immediately.",
  "admin_instances_ohne_freigabe": "no approval",
  "admin_users_darf_verbinden": "May connect servers",
  "admin_users_verbinden_updated": "Permission to connect servers updated.",
  "admin_badge_meldungen_aria": "Open reports"
```

- [ ] **Step 3: `web/src/lib/api/instances.ts` vollständig ersetzen.** Vorher die Verbraucher prüfen:

```bash
cd /home/michael/Dokumente/pulse && grep -rnF "api/instances'" web/src | grep -v "web/src/lib/api/instances.ts"
grep -rnE "submitApplication|listMyApplications|mintBootstrapToken|downloadEnvFile|listApplications|approveApplication|rejectApplication|revokeAppHostApplication|InstanceApplication|AdminApplication" web/src desktop/electron
```
Expected: die zweite Suche trifft nur noch `instances.ts` selbst, `AdminInstances.svelte`, `AdminInstancesActive.svelte`, `AdminInstancesPending.svelte`, `AdminAppHostRevoke.svelte`, `pendingInstanceApps.svelte.ts`, `pendingAppHostApplications.svelte.ts`, `routes/app/admin/+page.svelte` — alle werden in diesem Task ersetzt oder gelöscht. Trifft sie etwas unter `desktop/electron`, **anhalten** und die Server-App-Abhängigkeit klären.

Neuer Inhalt:

```ts
/**
 * API-Client der Self-Host-Instanzen (auth-svc).
 *
 * Alle User-Endpoints nutzen Cookie-Auth (pulse_session HttpOnly) via
 * credentials:'include'. Admin-Endpoints ebenfalls — auth-svc prüft
 * is_admin server-seitig.
 *
 * Wichtig: RotateSecretResult.client_secret NIE in console.log/localStorage/
 * sessionStorage speichern — nur transient im UI anzeigen.
 *
 * Antrag, Freigabe und `.env`-Download sind seit 2026-10 aus der Oberfläche
 * entfernt (Spec 2026-10-09-selfhost-ohne-freigabe-design.md, E11): ein neuer
 * Server verbindet sich über `pulse-connect` und die Seite `/verbinden`
 * (`api/verbinden.ts`).
 *
 * Backend-Quelle:
 *   routes_instance_applications.py (User: /me/instances …)
 *   routes_admin_instances.py       (Admin)
 */

import { cookieFetch } from './cookie-client';

type InstanceStatus = 'active' | 'suspended';

/** Spiegelt InstanceOut (User-Route, kein client_secret). */
export interface Instance {
  id: string;
  hostname: string;
  client_id: string;
  /** Snowflake-Worker-Nummern; `null` bei Einträgen seit 2026-10 (Spec E7). */
  worker_id_chat: number | null;
  worker_id_voice: number | null;
  worker_id_media: number | null;
  status: InstanceStatus;
  /** vps = gemieteter Server mit eigener Adresse, app_host = Heim-Server (Server-App). */
  origin: 'vps' | 'app_host';
  /** Selbst verbunden (`pulse-connect`, Spec E1) statt vom Admin freigegeben. */
  ohne_freigabe: boolean;
  registered_at: string;
  /** Geräteübergreifender Notification-Modus aus der Membership (account-basiert).
   *  (Das Backend führt zusätzlich ein dormantes ``user_label`` — der
   *  persönliche Server-Name wurde entfernt; den Namen bestimmt der Admin.) */
  notification_mode: 'all' | 'mentions' | 'none';
  /** Eigene Rolle auf dieser Instanz. Die Liste enthält AUCH Server, denen man
   *  nur beigetreten ist (damit sie auf allen Geräten in der Server-Leiste
   *  stehen) — nur `owner` darf löschen und sieht „Meine Server“. */
  role: 'owner' | 'member';
  /** Sind die Zugangsdaten dieses Servers schon abgeholt (Installer bzw.
   *  `pulse-connect`, Server-App)? Erst dann nimmt `serversStore` ihn in die
   *  Server-Leiste auf. Optional, weil ein älterer Cloud-Stand das Feld noch
   *  nicht schickt; wird dort wie `true` behandelt (s. `hydrateFromBackend`). */
  set_up?: boolean;
  /** Vom Betreiber vergebener Name (der Server meldet ihn der Cloud) —
   *  `null` = keiner. Optional: ältere Cloud schickt das Feld nicht. */
  anzeigename?: string | null;
  /** Nur Heim-Server (`app_host`): läuft er? `null` = unbekannt (VPS). */
  online?: boolean | null;
}

/** Spiegelt InstanceOut (Admin-Route — trägt registrar_username). */
export interface AdminInstance {
  id: string;
  hostname: string;
  client_id: string;
  worker_id_chat: number | null;
  worker_id_voice: number | null;
  worker_id_media: number | null;
  status: string;
  registered_at: string;
  registrar_username: string;
  origin: 'vps' | 'app_host';
  /** Selbst verbunden statt freigegeben — kein „Secret rotieren“ (Spec §5). */
  ohne_freigabe: boolean;
}

/** Spiegelt RotateSecretOut. */
export interface RotateSecretResult {
  instance_id: string;
  client_secret: string;
  warning: string;
}

/** Ein Glied der Kette (spiegelt SchrittAus in routes_selfhost_diagnose.py).
 *
 *  `titel`, `was_ist` und `was_tun` kommen FERTIG vom Server
 *  (`dcc_auth/diagnose_texte.py`) und werden hier nur noch angezeigt. Der
 *  Grund steht dort: dieselben Sätze erscheinen im Installer-Terminal, und
 *  zwei Kataloge beschrieben denselben Zustand nach kurzer Zeit verschieden.
 *  `befund` bleibt der maschinenlesbare Schlüssel — für Tests und Protokolle. */
interface DiagnoseSchritt {
  schritt: string;
  ok: boolean;
  befund: string;
  einzelheit: string | null;
  titel: string;
  was_ist: string;
  /** Leer, wenn der Schritt sitzt. */
  was_tun: string;
}

/** Spiegelt DiagnoseAus. `gesamt` ist 'ok' oder der Name des ERSTEN Schritts,
 *  der nicht sass — nicht des letzten: alles danach ist Folge, nicht Ursache. */
export interface DiagnoseErgebnis {
  hostname: string;
  gesamt: string;
  schritte: DiagnoseSchritt[];
  /** Glieder, die wegen eines früheren Fehlschlags gar nicht geprüft wurden.
   *  Müssen sichtbar bleiben — sonst liest sich eine abgebrochene Kette wie
   *  eine vollständige. */
  nicht_geprueft: string[];
}

// ---------------------------------------------------------------------------
// User-Endpoints (/me/*)
// ---------------------------------------------------------------------------

export const instancesApi = {
  /** Eigene und beigetretene Instanzen (kein client_secret). */
  listMyInstances(): Promise<Instance[]> {
    return cookieFetch<Instance[]>('/me/instances');
  },

  /**
   * Membership auf einer Self-Host-Instanz in der Cloud eintragen — macht den
   * per Einladung beigetretenen Server auch auf anderen Geräten (Browser)
   * sichtbar. Idempotent; vom Client NUR nach erfolgreichem Ticket-Login
   * aufgerufen. Owner-Rolle wird nie herabgestuft.
   */
  joinInstanceMembership(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/membership`, { method: 'POST' });
  },

  /**
   * Cloud-Membership wieder entfernen, wenn der User den Server entfernt
   * (austritt). 403 für den Owner (der bleibt Mitglied). Idempotent.
   */
  leaveInstanceMembership(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/membership`, { method: 'DELETE' });
  },

  /**
   * Geräteübergreifenden Notification-Modus setzen, damit Stummschalten auf
   * allen Geräten gilt (nicht nur lokal). Das Backend akzeptiert weiterhin ein
   * dormantes ``label`` (persönlicher Server-Name entfernt) — der Client sendet
   * es nicht mehr.
   */
  updateInstancePreferences(
    instanceId: string,
    prefs: { notification_mode?: 'all' | 'mentions' | 'none' }
  ): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}/preferences`, {
      method: 'PATCH',
      body: prefs
    });
  },

  /**
   * Erreichbarkeitsprüfung von aussen: die Cloud geht die ganze Kette ab
   * (DNS, TCP, Zertifikat, /health, Identität, CORS, WebSocket-Upgrade, UDP)
   * und benennt das Glied, das fehlt. Das ist das Einzige, was der Server über
   * sich selbst nicht sagen kann.
   *
   * Dauert bis zu 40 s (der Server deckelt), deshalb ein eigener Zeitrahmen im
   * Aufrufer statt eines Spinners ins Blaue.
   */
  diagnose(instanceId: string): Promise<DiagnoseErgebnis> {
    return cookieFetch<DiagnoseErgebnis>(`/selfhost/diagnose/${instanceId}`, {
      method: 'POST'
    });
  },

  /**
   * Eigene Instanz löschen (Soft-Delete, irreversibel). Die Adresse wird
   * wieder frei; ein noch laufender Server landet auf der Sperrliste und
   * stellt den Betrieb ein.
   */
  deleteMyInstance(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/me/instances/${instanceId}`, { method: 'DELETE' });
  }
};

// ---------------------------------------------------------------------------
// Admin-Endpoints (/admin/*)
// ---------------------------------------------------------------------------

export const adminInstancesApi = {
  /** Registrierte Instanzen auflisten. */
  listInstances(status: 'all' | 'active' | 'suspended' = 'all'): Promise<AdminInstance[]> {
    return cookieFetch<AdminInstance[]>(`/admin/instances?status=${status}`);
  },

  /** Instanz suspendieren (soft-delete). */
  suspendInstance(instanceId: string, reason?: string): Promise<void> {
    const qs = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return cookieFetch<void>(`/admin/instances/${instanceId}${qs}`, { method: 'DELETE' });
  },

  /** Instanz entsperren. */
  unsuspendInstance(instanceId: string): Promise<void> {
    return cookieFetch<void>(`/admin/instances/${instanceId}/unsuspend`, { method: 'POST' });
  },

  /** Secret rotieren — gibt client_secret EINMALIG zurück. */
  rotateSecret(instanceId: string): Promise<RotateSecretResult> {
    return cookieFetch<RotateSecretResult>(`/admin/instances/${instanceId}/rotate-secret`, {
      method: 'POST'
    });
  }
};
```

- [ ] **Step 4: `web/src/lib/components/admin/AdminInstances.svelte` vollständig ersetzen.**

```svelte
<!--
  Admin: alle Server, die die Cloud kennt (Reiter „Server“). Drei Unterreiter:
  Aktiv · Gesperrt · Diagnose. Der Unterreiter „Ausstehend“ und sein Zähler
  sind mit der Freigabe entfallen (2026-10, Spec 2026-10-09 §5) — neue Server
  tauchen unter „Aktiv“ auf, sobald ihr Betreiber sie verbindet.
-->
<script lang="ts">
  import AdminInstancesActive from './AdminInstancesActive.svelte';
  import AdminInstancesSuspended from './AdminInstancesSuspended.svelte';
  import AdminDiagnose from './AdminDiagnose.svelte';
  import AdminTabBar from './AdminTabBar.svelte';
  import ServerIcon from '@lucide/svelte/icons/server';
  import { m } from '$lib/paraglide/messages.js';

  type Tab = 'active' | 'suspended' | 'diagnose';
  let activeTab = $state<Tab>('active');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'active', label: m.admin_instances_tab_active() },
    { id: 'suspended', label: m.admin_instances_tab_suspended() },
    { id: 'diagnose', label: m.admin_diagnose_tab() }
  ];
</script>

<section class="rounded-2xl border border-border bg-bg-input p-5" data-testid="admin-instances">
  <div class="mb-4 flex items-start gap-3">
    <ServerIcon class="text-text-muted mt-0.5 size-5 shrink-0" />
    <div class="min-w-0">
      <h2 class="text-text-bright text-base font-semibold">{m.admin_instances_heading()}</h2>
      <p class="text-text-muted mt-0.5 text-xs">{m.admin_instances_description_frei()}</p>
    </div>
  </div>

  <AdminTabBar bind:active={activeTab} {tabs} testIdPrefix="instances-tab" />

  {#if activeTab === 'active'}
    <AdminInstancesActive />
  {:else if activeTab === 'suspended'}
    <AdminInstancesSuspended />
  {:else}
    <AdminDiagnose />
  {/if}
</section>
```

- [ ] **Step 5: `web/src/lib/components/admin/AdminInstancesActive.svelte` vollständig ersetzen.**

```svelte
<!--
  Admin: aktive Server (gemietete und Heim-Server, mit Herkunfts-Chip).
  Aktionen: „Sperren“ für alle. „Secret rotieren“ nur bei Einträgen aus der
  Freigabe-Zeit — ein selbst verbundener Eintrag (`ohne_freigabe`, Spec E1)
  trägt stattdessen den Vermerk „ohne Freigabe“: sein Betreiber verbindet bei
  Bedarf neu (`pulse-connect`), und das neue Secret landet dann auf dem Server
  statt in diesem Fenster (Skizze des Eigentümers, 2026-10-10).

  Bis 2026-10 bekamen Heim-Server mit genehmigtem Antrag hier „Freischaltung
  zurücknehmen“ statt „Sperren“ (AdminAppHostRevoke). Mit dem Antrag ist der
  Weg entfallen; „Sperren“ trägt den Teil, der wirkte: der Server landet auf
  der Sperrliste und stellt den Betrieb ein.

  Das rotierte Secret erscheint EINMALIG im Dialog.
-->
<script lang="ts">
  import { errText } from '$lib/utils/errText';
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import {
    adminInstancesApi,
    type AdminInstance,
    type RotateSecretResult
  } from '$lib/api/instances';
  import RotatedSecretDialog from './RotatedSecretDialog.svelte';
  import { m } from '$lib/paraglide/messages.js';
  import { Button } from '$lib/components/ui/button';
  import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
  import ReasonDialog from '$lib/components/feedback/ReasonDialog.svelte';
  import EmptyState from '$lib/components/feedback/EmptyState.svelte';
  import FieldError from '$lib/components/feedback/FieldError.svelte';
  import LoadingState from '$lib/components/feedback/LoadingState.svelte';

  let instances = $state<AdminInstance[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let busy = $state<Record<string, boolean>>({});

  // Suspend flow
  let suspendTarget = $state<AdminInstance | null>(null);
  let suspendOpen = $state(false);
  let suspending = $state(false);
  let rotating = $state(false);

  // Rotate flow
  let rotateTarget = $state<AdminInstance | null>(null);
  let rotateResult = $state<RotateSecretResult | null>(null);
  let rotateDialogOpen = $state(false);

  onMount(async () => {
    await reload();
  });

  async function reload() {
    loading = true;
    loadError = null;
    try {
      instances = await adminInstancesApi.listInstances('active');
    } catch (e) {
      loadError = errText(e);
    } finally {
      loading = false;
    }
  }

  function removeInstance(id: string): void {
    instances = instances.filter((i) => i.id !== id);
  }

  async function doSuspend(reason: string) {
    if (!suspendTarget) return;
    suspending = true;
    try {
      await adminInstancesApi.suspendInstance(suspendTarget.id, reason.trim() || undefined);
      removeInstance(suspendTarget.id);
      toast.success(m.admin_instances_active_suspended({ hostname: suspendTarget.hostname }));
      suspendOpen = false;
      suspendTarget = null;
    } catch (e) {
      toast.error(m.admin_instances_active_suspend_failed(), {
        description: errText(e)
      });
    } finally {
      suspending = false;
    }
  }

  // Rotate-Confirm über den gemeinsamen Dienst (statt handgebautem Dialog).
  async function askRotate(inst: AdminInstance) {
    const ok = await confirmDialog({
      title: m.admin_instances_active_rotate_title(),
      description: `${inst.hostname} — ${m.admin_instances_active_rotate_warning()}`,
      confirmLabel: m.admin_instances_active_btn_rotate_confirm(),
      cancelLabel: m.admin_instances_active_btn_cancel()
    });
    if (!ok) return;
    rotateTarget = inst;
    doRotate();
  }

  async function doRotate() {
    // rotating-Guard (wie suspending bei doSuspend): ohne ihn feuert ein
    // Doppelklick auf "Bestätigen" zwei rotateSecret-Calls — der zweite
    // rotiert das gerade angezeigte Secret sofort wieder weg.
    if (!rotateTarget || rotating) return;
    rotating = true;
    busy[rotateTarget.id] = true;
    try {
      rotateResult = await adminInstancesApi.rotateSecret(rotateTarget.id);
      rotateDialogOpen = true;
    } catch (e) {
      toast.error(m.admin_instances_active_rotate_failed(), {
        description: errText(e)
      });
    } finally {
      busy[rotateTarget.id] = false;
      rotating = false;
      rotateTarget = null;
    }
  }

  function onRotateClose() {
    rotateDialogOpen = false;
    rotateResult = null;
  }
</script>

{#if loading}
  <LoadingState label={m.admin_instances_active_loading()} />
{:else if loadError}
  <FieldError message={m.admin_instances_active_load_error({ error: loadError })} />
{:else if instances.length === 0}
  <EmptyState message={m.admin_instances_active_empty()} />
{:else}
  <div class="flex flex-col gap-2">
    {#each instances as inst (inst.id)}
      <div
        class="border-border bg-bg-hover/30 flex flex-col gap-2 rounded-xl border p-3"
        data-testid="active-instance-{inst.id}"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-text-bright text-sm font-medium">{inst.hostname}</p>
            <p class="text-text-muted mt-0.5 text-xs">
              {inst.registrar_username}{#if inst.worker_id_chat !== null}
                · Workers: {inst.worker_id_chat}/{inst.worker_id_voice}/{inst.worker_id_media}{/if}
            </p>
            <p class="text-text-muted text-xs">
              {new Date(inst.registered_at).toLocaleDateString('de-DE')}
            </p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {#if inst.ohne_freigabe}
              <span
                class="border-border text-text-muted rounded-full border px-2 py-0.5 text-xs"
                data-testid="admin-instance-ohne-freigabe"
              >
                {m.admin_instances_ohne_freigabe()}
              </span>
            {/if}
            <span
              class="border-border text-text-muted rounded-full border px-2 py-0.5 text-xs"
              data-testid="admin-instance-origin-chip"
            >
              {inst.origin === 'app_host' ? m.hosting_origin_app() : m.hosting_origin_vps()}
            </span>
            <span class="bg-success/20 text-success rounded-full px-2 py-0.5 text-xs"
              >{m.admin_instances_active_status_active()}</span
            >
          </div>
        </div>
        <div class="flex gap-2">
          {#if !inst.ohne_freigabe}
            <Button
              variant="outline"
              size="xs"
              onclick={() => askRotate(inst)}
              disabled={!!busy[inst.id]}
              data-testid="admin-instance-rotate-{inst.id}"
            >
              {m.admin_instances_active_btn_rotate()}
            </Button>
          {/if}
          <Button
            variant="destructive-solid"
            size="xs"
            onclick={() => {
              suspendTarget = inst;
              suspendOpen = true;
            }}
            disabled={!!busy[inst.id]}
            data-testid="admin-instance-suspend-{inst.id}"
          >
            {m.admin_instances_active_btn_suspend()}
          </Button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Suspend Dialog -->
<ReasonDialog
  bind:open={suspendOpen}
  title={m.admin_instances_active_suspend_title()}
  description={suspendTarget?.hostname}
  label={`${m.admin_instances_active_reason_label()} (${m.admin_instances_active_reason_optional()})`}
  maxlength={500}
  rows={2}
  busy={suspending}
  busyLabel={m.admin_instances_active_suspending()}
  confirmLabel={m.admin_instances_active_btn_suspend()}
  cancelLabel={m.admin_instances_active_btn_cancel()}
  confirmVariant="destructive-solid"
  testId="suspend-dialog"
  onConfirm={doSuspend}
/>

<!-- Neues Secret — kein auto-dismiss! (ausgelagert, Größen-Policy) -->
<RotatedSecretDialog open={rotateDialogOpen} result={rotateResult} onClose={onRotateClose} />
```

- [ ] **Step 6: Gesperrte Server.** `web/src/lib/components/admin/AdminInstancesSuspended.svelte` Zeilen 26–30 alt:

```ts
      // Gleicher UI-Filter wie im Aktiv-Tab: app_host-Instanzen leben im
      // App-Hosting-Anträge-Tab, nicht hier.
      instances = (await adminInstancesApi.listInstances('suspended')).filter(
        (i) => i.origin !== 'app_host'
      );
```

neu:

```ts
      // Alle Herkünfte. Gesperrte Heim-Server waren hier bis 2026-10
      // ausgefiltert, mit Verweis auf einen Antrags-Reiter, den es nicht mehr
      // gibt — sie waren damit nirgends zu sehen und nicht zu entsperren.
      instances = await adminInstancesApi.listInstances('suspended');
```

- [ ] **Step 7: Admin-Seite.** `web/src/routes/app/admin/+page.svelte`:
- Zeilen 3–7 alt:

```svelte
  `auth.user.is_admin`). Reiter-Schale: die Bereiche sind auf sechs Tabs
  verteilt (Übersicht · Nutzer · Anträge · Meldungen · Einstellungen ·
  Protokoll), jeder Tab-Inhalt lebt in seiner eigenen Komponente unter
  `$lib/components/admin/`. Self-Host sieht nur vier Tabs (Anträge/Meldungen
  sind reine Cloud-Funktionen).
```

neu:

```svelte
  `auth.user.is_admin`). Reiter-Schale: die Bereiche sind auf sechs Tabs
  verteilt (Übersicht · Nutzer · Server · Meldungen · Einstellungen ·
  Protokoll), jeder Tab-Inhalt lebt in seiner eigenen Komponente unter
  `$lib/components/admin/`. Self-Host sieht nur vier Tabs (Server/Meldungen
  sind reine Cloud-Funktionen).
```

- Zeile 27 `  import { adminInstancesApi } from '$lib/api/instances';` löschen.
- Zeilen 32–35 alt:

```ts
  // Self-Host-Instanzen verwalten (Anträge genehmigen/sperren) ist eine reine
  // Cloud-Funktion — nur howispulse.com entscheidet, wer self-hosten darf. Auf
  // jedem Self-Host-Server blenden wir die Bereiche aus (Backend riegelt zusätzlich
  // per PULSE_INSTANCE_MODE ab).
```

neu:

```ts
  // Server verwalten (sperren, Diagnose) ist eine reine Cloud-Funktion — nur
  // howispulse.com kennt alle Server. Auf jedem Self-Host-Server blenden wir die
  // Bereiche aus (Backend riegelt zusätzlich per PULSE_INSTANCE_MODE ab).
```

- Zeilen 63–68 alt:

```ts
  // Tab-Badges: warten Anträge/Meldungen? Die jeweiligen Bereiche zählen intern
  // noch einmal, aber der Tab-Badge muss den Stand auch zeigen, wenn der Tab
  // gerade NICHT offen ist — also hier auf Panel-Ebene mitzählen.
  let instancesPending = $state(0);
  let complaintsNew = $state(0);
  let applicationsBadge = $derived(instancesPending);
```

neu:

```ts
  // Tab-Badge: warten Meldungen? Der Bereich zählt intern noch einmal, aber der
  // Reiter muss den Stand auch zeigen, wenn er gerade NICHT offen ist. Der
  // Antrags-Zähler am Reiter „Server“ ist mit der Freigabe entfallen (2026-10).
  let complaintsNew = $state(0);
```

- Zeile 81 alt `          { id: 'applications' as const, label: m.admin_tab_applications(), badge: applicationsBadge },` → neu:

```ts
          // ID bleibt `applications` (admin.spec.ts und Verweise hängen daran).
          { id: 'applications' as const, label: m.admin_tab_servers(), badge: 0 },
```

- In `refreshBadges()` (Zeilen 101–113) den ersten `try`-Block löschen:

```ts
    try {
      instancesPending = (await adminInstancesApi.listApplications('pending', 'vps')).length;
    } catch {
      /* still — Badge bleibt einfach aus */
    }
```

- Zeilen 187–189 alt:

```svelte
        <!-- Instanz-Verwaltung mit Pending/Aktiv/Gesperrt-Untertabs; seit der
             Vereinheitlichung leben app_host-Instanzen samt Revoke im Aktiv-Tab
             (kein separater App-Host-Freischaltungen-Block mehr). -->
```

neu:

```svelte
        <!-- Server-Verwaltung mit Aktiv/Gesperrt/Diagnose-Untertabs (seit 2026-10
             ohne „Ausstehend“: es gibt keine Anträge mehr). -->
```

- [ ] **Step 8: Admin-Schild.** `web/src/lib/components/ServerAdminButton.svelte`:
- Zeilen 7–10 alt:

```svelte
  Nur das Schild-Symbol (kein Text), im Stil der runden Rail-Icons. Der Punkt
  zählt offene Admin-Sachen (Instanz-/App-Hosting-Anträge, Betreiber-
  Beschwerden). Der „mein eigener Antrag ist durch"-Punkt bleibt am Avatar
  (UserFooter) — das ist ein User-Hinweis, kein Admin-Alert.
```

neu:

```svelte
  Nur das Schild-Symbol (kein Text), im Stil der runden Rail-Icons. Der Punkt
  zählt offene Meldungen (Betreiber-Beschwerden). Der Antrags-Zähler ist mit
  der Freigabe entfallen (2026-10).
```

- Zeilen 18–19 (`pendingInstanceApps`, `pendingAppHostApplications`) löschen.
- Zeilen 33–43 alt (Kommentar „Alle offenen Admin-Sachen …“ und `let alertCount = …`) neu:

```ts
  // Offene Meldungen leben nur auf der Cloud und nur für Cloud-Admins. Auf
  // einem Self-Host führt das Symbol aufs lokale Panel, das davon nichts weiß
  // → kein Punkt.
  let alertCount = $derived(
    (activeServer.current?.isCloud ?? false) && (auth.user?.is_admin ?? false)
      ? pendingComplaints.count
      : 0
  );
```

- Zeile 72 `aria-label={m.instance_apps_badge_aria()}` → `aria-label={m.admin_badge_meldungen_aria()}`.

- [ ] **Step 9: Nutzerliste.** `web/src/lib/api/admin.ts` Zeilen 16–29 (`AdminUser`) — nach `  self_host_enabled: boolean;` einfügen und die Zeile davor kommentieren:

```ts
  /** Server-App-Freischaltung (Spec E8). Die Oberfläche schaltet sie seit
   *  2026-10 nicht mehr; der Server liefert das Feld weiter. */
  self_host_enabled: boolean;
  /** Riegel gegen ein Konto, das nach einer Sperre immer neue Server verbindet
   *  (Spec E8). Vorgabe aus; der Schalter heißt „Darf Server verbinden“. */
  server_verbinden_gesperrt: boolean;
```

(die bisherige Zeile `  self_host_enabled: boolean;` wird durch diesen Block ersetzt). In `listUsers` (Zeile 289) `filter?: 'admins' | 'disabled' | 'self_host';` → `filter?: 'admins' | 'disabled';`. In `patchUser` (Zeile 299) `payload: { is_admin?: boolean; disabled?: boolean; self_host_enabled?: boolean }` → `payload: { is_admin?: boolean; disabled?: boolean; server_verbinden_gesperrt?: boolean }`.

`web/src/lib/components/admin/AdminUsers.svelte`:
- Zeile 25 → `  type FilterMode = 'all' | 'admins' | 'disabled';`
- In Zeilen 36–41 die Zeile `    { id: 'self_host', label: m.admin_users_filter_self_host() }` löschen (Komma der Zeile davor entfernen).
- Zeilen 98–109 alt (`function toggleSuccessMessage …` bis zur Signatur von `toggle`) neu:

```ts
  type Feld = 'is_admin' | 'disabled' | 'server_verbinden_gesperrt';

  function toggleSuccessMessage(field: Feld) {
    switch (field) {
      case 'is_admin':
        return m.admin_users_admin_status_updated();
      case 'server_verbinden_gesperrt':
        return m.admin_users_verbinden_updated();
      default:
        return m.admin_users_ban_updated();
    }
  }

  async function toggle(u: AdminUser, field: Feld, next: boolean) {
```

`web/src/lib/components/admin/AdminUserRow.svelte`:
- Zeilen 1–6 alt:

```svelte
<!--
  Eine Zeile der Admin-User-Liste: Avatar + Name/E-Mail, Status-Badges
  (Owner/Admin/Gesperrt/Self-Host) und das Aktions-Popover (Admin-Rolle,
  Sperren, Self-Host-Freischaltung). Ausgelagert aus AdminUsers.svelte, damit
  die Liste unter der Komponenten-Größen-Policy bleibt.
-->
```

neu:

```svelte
<!--
  Eine Zeile der Admin-User-Liste: Avatar + Name/E-Mail, Status-Badges
  (Owner/Admin/Gesperrt) und das Aktions-Popover (Admin-Rolle, Sperren,
  „Darf Server verbinden“). Ausgelagert aus AdminUsers.svelte, damit die Liste
  unter der Komponenten-Größen-Policy bleibt. Abzeichen und Schalter
  „Hosting“/„Selbst-Hosting erlauben“ sind 2026-10 entfallen (Spec §5).
-->
```

- Nach Zeile 17 (`import ServerIcon …`): `  import CheckIcon from '@lucide/svelte/icons/check';`
- Zeile 21 → `  type Field = 'is_admin' | 'disabled' | 'server_verbinden_gesperrt';`
- Zeilen 78–85 (der `{#if user.self_host_enabled}`-Block mit `badge-selfhost`) löschen.
- Zeilen 127–133 alt:

```svelte
        <MenuRow
          onclick={() => ontoggle(user, 'self_host_enabled', !user.self_host_enabled)}
          data-testid="toggle-selfhost-btn"
        >
          <ServerIcon class="size-4" />
          {user.self_host_enabled ? m.admin_users_self_host_revoke() : m.admin_users_self_host_grant()}
        </MenuRow>
```

neu:

```svelte
        <!-- Ein Schalter, kein Paar „erlauben/entziehen“: der Haken zeigt den
             Stand (Spec E8, Skizze 2026-10-10). Auch beim Owner sichtbar — der
             Riegel betrifft nur das Verbinden neuer Server. -->
        <MenuRow
          onclick={() =>
            ontoggle(user, 'server_verbinden_gesperrt', !user.server_verbinden_gesperrt)}
          aria-pressed={!user.server_verbinden_gesperrt}
          data-testid="toggle-verbinden-btn"
          data-erlaubt={user.server_verbinden_gesperrt ? 'nein' : 'ja'}
        >
          <ServerIcon class="size-4" />
          <span class="flex-1">{m.admin_users_darf_verbinden()}</span>
          {#if !user.server_verbinden_gesperrt}
            <CheckIcon class="size-4" />
          {/if}
        </MenuRow>
```

- [ ] **Step 10: Antragszähler, Stores und WS-Handler entfernen.**
- `web/src/routes/app/+layout.svelte`: `  import { pendingInstanceApps } from '$lib/stores/pendingInstanceApps.svelte';` (Zeile 22) löschen; im `onMount` löschen:

```ts
    // Cloud-Admin-Benachrichtigung: pollt offene Self-Host-Anträge (Badge im
    // UserFooter + Toast bei Zuwachs). Interner Guard pollt nur für Admins.
    pendingInstanceApps.start();
```

  im `onDestroy` `    pendingInstanceApps.stop();` löschen.
- `web/src/lib/ws/handlers/index.ts`: `import * as admin from './admin';` (Zeile 27) und `  admin.register();` (Zeile 53) löschen.
- `web/src/lib/ws/handlers/types.ts` Zeilen 426–439 löschen (die Union-Glieder `admin_application_pending` und `application_decided` samt Kommentaren; der Server sendet sie bis Etappe 6 weiter, unbekannte Ops verwirft der Dispatcher still).
- `web/src/lib/stores/pendingComplaints.svelte.ts` Zeile 4 alt ` * Spiegel von [[pendingAppHostApplications]]: pollt periodisch die Anzahl neuer` → neu ` * Pollt periodisch die Anzahl neuer`.

```bash
cd /home/michael/Dokumente/pulse && git rm \
  web/src/lib/components/admin/AdminInstancesPending.svelte \
  web/src/lib/components/admin/AdminAppHostRevoke.svelte \
  web/src/lib/stores/pendingInstanceApps.svelte.ts \
  web/src/lib/stores/pendingAppHostApplications.svelte.ts \
  web/src/lib/ws/handlers/admin.ts
grep -rnE "AdminInstancesPending|AdminAppHostRevoke|pendingInstanceApps|pendingAppHostApplications|handlers/admin|admin_application_pending|application_decided|listApplications|instancesPending|applicationsBadge|toggle-selfhost|badge-selfhost|filter_self_host|instance_apps_badge_aria" web/src web/test web/tests
```
Expected: keine Treffer.

- [ ] **Step 11: Prüfen.**

```bash
cd /home/michael/Dokumente/pulse/web && pnpm check && pnpm build && pnpm test:unit \
  && cd .. && bash scripts/geraete-trennung.sh
cd /home/michael/Dokumente/pulse/web && pnpm exec playwright test tests/e2e/admin.spec.ts
```
Expected: 0 Fehler, Bau und Unit grün, `admin.spec.ts` grün (verlangt den lokalen Backend-Stand aus Etappe 1: Feld `server_verbinden_gesperrt` in `PATCH /admin/users/{id}`). `admin.spec` flakt unter Volllast (CLAUDE.md) — bei einem wandernden Fehler die Datei allein nachfahren.

- [ ] **Step 12: Vereinfachen, committen.**

```bash
cd /home/michael/Dokumente/pulse && bash .claude/hooks/simplify-stamp.sh
git add -A web/src web/tests/e2e/admin.spec.ts web/messages
git status --short   # nur die in **Files** genannten Pfade
git commit -m "feat(web): Admin-Bereich ohne Anträge — Vermerk „ohne Freigabe“, „Darf Server verbinden“

Reiter „Server“ ohne Zähler und ohne „Ausstehend“, „Secret rotieren“ nur
bei freigegebenen Einträgen, gesperrte Heim-Server wieder sichtbar.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.5: Changelog

**Files:**
- Modify: `web/static/changelog.json` (neuer Eintrag oben in `entries`)

- [ ] **Step 1: Dem Eigentümer drei Vorschläge im Stil „Sachlich“ vorlegen** (keine Emojis, echte Umlaute; `id`/`date` = Ausgabe von `date +%F` am Landetag, steht an dem Tag schon ein Eintrag, `.N` hochzählen):

Vorschlag A — drei Punkte, nach Ort:

```json
    {
      "id": "JJJJ-MM-TT",
      "date": "JJJJ-MM-TT",
      "style": "Sachlich",
      "title": "Eigener Server ohne Antrag",
      "items": [
        "Einen eigenen Pulse-Server richtest du jetzt ohne Antrag und ohne Warten ein: Plus in der Leiste, dann „Eigenen Server einrichten“. Am Handy steht der Eintrag im Menü oben rechts in den Räumen.",
        "Für einen gemieteten Server genügt ein Befehl. Am Ende verbindet der Installer den Server mit deinem Konto, du bestätigst das einmal im Browser.",
        "Deine Server findest du unter „Meine Server“ im Konto-Menü unten links und im Du-Bereich. Der Eintrag erscheint, sobald du einen eigenen Server hast."
      ]
    },
```

Vorschlag B — mit Einleitung, knapper:

```json
    {
      "id": "JJJJ-MM-TT",
      "date": "JJJJ-MM-TT",
      "style": "Sachlich",
      "title": "Eigenen Server einrichten, ohne zu warten",
      "intro": "Der Antrag für einen eigenen Server entfällt.",
      "items": [
        "Neu im Plus jeder Server-Gruppe: „Eigenen Server einrichten“ mit der Server-App für deinen Rechner und einem Installationsbefehl für gemietete Server.",
        "Der Installer verbindet den neuen Server am Ende mit deinem Konto. Danach steht er auf all deinen Geräten in der Leiste.",
        "„Meine Server“ im Konto-Menü und im Du-Bereich ersetzt den Server-Knopf unten in der Leiste."
      ]
    },
```

Vorschlag C — zwei Wege nebeneinander:

```json
    {
      "id": "JJJJ-MM-TT",
      "date": "JJJJ-MM-TT",
      "style": "Sachlich",
      "title": "Zwei Wege zum eigenen Server",
      "items": [
        "Auf deinem Rechner: Server-App laden und mit deinem Pulse-Konto anmelden.",
        "Auf einem gemieteten Server: einen Befehl kopieren und in die Konsole einfügen. Der Installer verbindet den Server am Ende mit deinem Konto, ein Klick im Browser bestätigt das.",
        "Beides findest du im Plus der Leiste unter „Eigenen Server einrichten“, am Handy im Menü der Räume. Eigene Server verwaltest du unter „Meine Server“."
      ],
      "outro": "Ein Antrag ist nicht mehr nötig."
    },
```

`JJJJ-MM-TT` steht hier nur, weil der Landetag beim Schreiben des Plans nicht feststeht; beim Eintragen durch das Datum ersetzen.

- [ ] **Step 2: Gewählten Eintrag oben in `entries` einfügen** (direkt nach `"entries": [`).

Run: `cd /home/michael/Dokumente/pulse/web && node -e "const j=require('./static/changelog.json'); if(!j.entries[0].id.match(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/)) throw new Error('id'); console.log(j.entries[0].title)"`
Expected: der gewählte Titel, kein Fehler.

- [ ] **Step 3: Committen.**

```bash
cd /home/michael/Dokumente/pulse && git add web/static/changelog.json
git commit -m "chore: Changelog — eigener Server ohne Antrag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.6: Landen

- [ ] **Step 1: Volles Gate.** Run: `cd /home/michael/Dokumente/pulse && bash scripts/gate.sh` → grün.
- [ ] **Step 2: Playwright der berührten Dateien noch einmal zusammen** (Gate deckt es nicht ab):

```bash
cd /home/michael/Dokumente/pulse/web && pnpm exec playwright test tests/e2e/eigener-server.spec.ts \
  tests/e2e/admin.spec.ts tests/e2e/verbinden.spec.ts
```
Expected: grün.
- [ ] **Step 3: Im echten Browser ansehen** (Rechner und Handy-Emulation in den DevTools mit Touch): Plus → Dialog, Kopieren-Knopf schreibt den Befehl in die Zwischenablage; Räume-Menü → Blatt; mit einem Konto, das einen eigenen Server hat, „Meine Server“ im Konto-Menü und im Du-Bereich; Admin-Bereich mit einem Cloud-Admin. **`instanz_verbunden` (Task 5.3):** gegen einen Stack mit Etappen 1 und 2 auf einem zweiten Gerät einen Self-Host aktiv lassen, auf einem Testserver `docker exec -it pulse pulse-connect` laufen lassen und bestätigen — der neue Server muss auf dem zweiten Gerät ohne Neuladen in der Leiste erscheinen. Geht das erst nach dem Landen (kein passender Stack), gehört der Schritt in die Probe von Etappe 4 bzw. die Abnahme nach dem Deploy.
- [ ] **Step 4: Landen nach ausdrücklicher Freigabe des Eigentümers:** `bash scripts/ship.sh`.
- [ ] **Step 5: Nach dem Deploy** auf howispulse.com mit dem Eigentümer-Konto: „Meine Server“ zeigt die drei Bestands-VPS und den eigenen Heim-Server; Admin-Bereich „Server“ zeigt die Bestandsserver ohne Vermerk und mit „Secret rotieren“. Danach `git tidy`.

---

---

## Etappe 6 — Aufräumen: Antrag, Freigabe und `.env`-Download entfernen

Danach gibt es keinen Antrag, keine Admin-Freigabe und keinen `.env`-Download mehr — weder als Route noch im Klienten noch in den Texten —, und `CLAUDE.md`, Konzept und Gedächtnis beschreiben den Weg per `pulse-connect`.

Zweig: `git checkout main && git pull --ff-only && git checkout -b chore/freigabe-aufraeumen`

**Voraussetzung:** Etappe 5 ist live, und kein Klient ruft die alten Routen mehr. Was bleibt (Spec E11): Bootstrap-Token und `POST /selfhost/bootstrap` (Server-App), `POST /me/instances/{id}/bootstrap-token` (Server-App, `desktop/electron/serverProvision.ts:297`), `self_host_enabled` (Spec E8), die Tabelle `auth.instance_applications` (Historie, Beschwerde-Kontakte), die Spalte `env_file_downloaded_at` (zählt für den per `.env` eingerichteten Bestands-VPS weiter als „eingerichtet“), `routes_registry_auth.py` und der Spiegel (Bestand, Spec E10).

### Task 6.1: Antrag, Freigabe, `.env`-Download und Worker-ID-Vergabe im auth-svc entfernen

**Files:**
- Delete: `services/auth/src/dcc_auth/routes_applications.py`, `services/auth/src/dcc_auth/routes_admin_applications.py`, `services/auth/src/dcc_auth/instance_env_file.py`
- Modify: `services/auth/src/dcc_auth/app.py:24-28,274,290`
- Modify: `services/auth/src/dcc_auth/routes_instance_applications.py:3-19,32,45,70-106,137,199,219-220,341-455,507` (Zeilen Stand heute; Etappe 1 ändert in derselben Datei `InstanceOut` und `_versorgte_instanzen` — die zitierten alten Texte sind die Anker)
- Modify: `services/auth/src/dcc_auth/admin_events.py` (ganz)
- Modify: `services/auth/src/dcc_auth/routes_admin_instances.py:10-11,23,96-143`
- Modify: `services/auth/src/dcc_auth/routes_instance_delete.py:8-14,106-110`
- Modify: `services/auth/src/dcc_auth/models_instances.py:155-159`
- Delete: `services/auth/tests/test_unified_applications.py`, `services/auth/tests/test_admin_app_host.py`
- Modify: `services/auth/tests/test_instance_applications_me.py`, `test_admin_instances.py`, `test_self_host_gate.py`, `test_instance_delete.py`, `test_bootstrap_token.py:195-196,211`

**Interfaces:**
- Consumes: Etappe 1 (`routes_verbinden.py`; Worker-ID-Spalten nullable; `instance_provisioning.py` vergibt keine Worker-IDs mehr), Etappe 5 (kein Klient ruft `/me/instance-applications`, `/admin/instance-applications*`, `/me/instances/{id}/env-file`).
- Produces: Diese drei Routen-Gruppen antworten 404. `admin_events.py` behält nur `USER_EVENTS_CHANNEL` (genutzt von `instance_status.py`). `_allocate_worker_ids` existiert nicht mehr. `POST /me/instances/{id}/bootstrap-token` meldet nach dem Einlösen `Bootstrap bereits eingelöst — neu ausstellen nur mit reset=true`.

App-Host-Widerruf: Der Heim-Server-Weg braucht nichts aus `routes_admin_applications.py`. Seit 2026-09-27 legt sich ein Heim-Server selbst an (`POST /me/instances`); `approve` antwortet für `app_host` schon heute 410, und die Widerrufs-Route `/admin/app-host-applications/{id}/revoke`, die `web/src/lib/api/instances.ts` noch ruft, gibt es im Server nicht mehr (`routes_admin_app_host_revoke.py` ist entfernt). `reject` war nur noch für alte, offene Anträge da — Step 1 prüft, dass es keine gibt.

- [ ] **Step 1: Prüfen, dass niemand die Routen mehr braucht (nur lesen).**

Run: `ssh michael@159.195.150.54 "docker exec pulse_postgres psql -U dcc -d dcc -Atc \"select status, count(*) from auth.instance_applications group by status order by 1\""`

Expected: keine Zeile mit `pending`. Gibt es offene Anträge, dem Eigentümer zeigen; er lehnt sie vor dem Landen über die heutige Admin-Oberfläche ab oder lässt sie als Historie stehen.

Run: `ssh michael@159.195.150.54 'docker logs --since 72h pulse_web 2>&1 | grep -c "instance-applications\|/env-file"'`

Expected: `0` (nach dem Ausrollen von Etappe 5 ruft kein Klient sie mehr; einzelne Treffer aus alten, nie neu geladenen Tabs sind möglich — dann 24 h später erneut prüfen).

Run: `git grep -n "instance-applications\|/env-file\|app-host-applications\|routes_applications\|routes_admin_applications\|instance_env_file\|publish_application\|_require_self_host_enabled" -- services shared web/src desktop/electron desktop/src infra Dockerfile.service ':!services/auth/tests'`

Expected: Treffer nur in den Dateien dieses Tasks (`app.py`, `routes_applications.py`, `routes_admin_applications.py`, `routes_instance_applications.py`, `admin_events.py`, `routes_admin_instances.py`), im Docstring der Migration `20260628_1200_0036_env_file_one_shot.py` (Historie, bleibt), und unter `web/` nirgends mehr — heute stehen dort noch `instances.ts`, `SelfHostApplication.svelte` und `pendingInstanceApps.svelte.ts`, die Teil C in Etappe 5 ersetzt bzw. löscht. Ein Treffer unter `web/` heißt: Etappe 5 ist nicht wie geplant gelandet, anhalten. Ein Treffer unter `desktop/` heißt ebenfalls anhalten: dann hängt die Server-App doch daran.

Run: `git grep -n "_allocate_worker_ids" -- services`

Expected: nur `routes_admin_instances.py` (Definition), `routes_admin_applications.py` (Aufruf) und der Docstring von `routes_instance_delete.py` (Zeile 9, Step 4 schreibt ihn um). Steht `instance_provisioning.py` noch dabei, ist Etappe 1 dort nicht wie vereinbart gelandet — dann `_allocate_worker_ids` in Step 4 stehen lassen und das unter „Offene Punkte“ vermerken.

- [ ] **Step 2: Riegel-Tests schreiben (vor dem Entfernen).** Sie halten fest, dass die Routen weg sind, und dass ein per `.env` eingerichteter Bestandsserver weiter als eingerichtet gilt. Die übrigen Test-Änderungen dieses Steps entfernen Tests für Entferntes und ersetzen das Anlegen über Antrag + Freigabe durch direktes Anlegen.

`services/auth/tests/test_instance_applications_me.py` (Zeilen Stand heute; Etappe 1 ergänzt hier womöglich Tests — die zitierten alten Texte sind die Anker):

**Teil 1 — alte Zeilen 1–13 ersetzen.** Alt:

```python
"""Tests für /me/instance-applications + /me/instances (Phase 2.2)."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio

from sqlalchemy import select, update

from dcc_auth.models import User
```

Neu:

```python
"""Tests für /me/instances (Phase 2.2).

Antrag (``/me/instance-applications``) und ``.env``-Download sind seit
Oktober 2026 entfernt (Spec E11); ``test_antrag_und_env_download_sind_entfernt``
hält das fest.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime

import pytest
import pytest_asyncio

from sqlalchemy import update
```

**Teil 2 — alte Zeilen 39–46 löschen.** Alt:

```python
_VALID_APP = {
    "hostname": "pulse.example.com",
    "purpose": "privat",
    "expected_users": 5,
    "contact_email": "alice@dcc-test.example.com",
    "notes": "Kleines Team",
}
```

**Teil 3 — alte Zeilen 63–88 ersetzen.** Alt:

```python
async def _enable_self_host(session_factory, client, cookie: str) -> None:
    """④-Gate: die Credential-Endpunkte (env-file, bootstrap-token) verlangen
    self_host_enabled. Diese Datei testet die Instanz-Workflows, nicht das Gate,
    also schalten die Fixtures es frei (das Gate selbst deckt test_self_host_gate ab)."""
    r = await client.get("/me", headers={"Cookie": cookie})
    assert r.status_code == 200, r.text
    uid = int(r.json()["id"])
    async with session_factory() as session:
        await session.execute(
            update(User).where(User.id == uid).values(self_host_enabled=True)
        )
        await session.commit()


@pytest_asyncio.fixture
async def alice_cookie(session_factory, client) -> str:
    cookie = await _reg_and_login(client, _REG_A, _LOGIN_A)
    await _enable_self_host(session_factory, client, cookie)
    return cookie


@pytest_asyncio.fixture
async def bob_cookie(session_factory, client) -> str:
    cookie = await _reg_and_login(client, _REG_B, _LOGIN_B)
    await _enable_self_host(session_factory, client, cookie)
    return cookie
```

Neu:

```python
@pytest_asyncio.fixture
async def alice_cookie(client) -> str:
    return await _reg_and_login(client, _REG_A, _LOGIN_A)


@pytest_asyncio.fixture
async def bob_cookie(client) -> str:
    return await _reg_and_login(client, _REG_B, _LOGIN_B)
```

**Teil 4 — alte Zeilen 133–371 ersetzen.** Alt (239 Zeilen, Leerzeilen mitgezählt) — ab Zeile 133:

```python
async def test_post_application_requires_cookie(client):
    r = await client.post("/me/instance-applications", json=_VALID_APP)
    assert r.status_code == 401
```

bis Zeile 371:

```python
    )
    assert r2.status_code == 200
    assert len(r2.json()) == 0
```

Neu:

```python
async def test_get_instances_requires_cookie(client):
    r = await client.get("/me/instances")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_antrag_und_env_download_sind_entfernt(client, alice_cookie, alice_instance):
    """Seit Oktober 2026 gibt es weder Antrag noch ``.env``-Download (Spec E11).

    Ein Server verbindet sich per Gerätecode selbst (``routes_verbinden.py``).
    Die alten Wege dürfen nicht still weiterleben: der eine legte Anträge an,
    die niemand mehr bearbeitet, der andere gab frische Zugangsdaten aus.
    """
    h = {"Cookie": alice_cookie}
    r = await client.post(
        "/me/instance-applications", json={"hostname": "neu.example.com"}, headers=h
    )
    assert r.status_code == 404
    assert (await client.get("/me/instance-applications", headers=h)).status_code == 404
    r = await client.post(f"/me/instances/{alice_instance.id}/env-file", headers=h)
    assert r.status_code == 404
```

**Teil 5 — alte Zeilen 426–432 ersetzen.** Alt:

```python
async def test_set_up_nach_env_download(client, alice_cookie, alice_instance):
    """Der manuelle Weg zaehlt: die Zugangsdaten sind beim Nutzer."""
    r = await client.post(
        f"/me/instances/{alice_instance.id}/env-file",
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 200, r.text
```

Neu:

```python
async def test_set_up_bleibt_fuer_bestand_mit_env_download(
    client, alice_cookie, alice_instance, session_factory
):
    """Der ``.env``-Download ist entfernt, sein Zeitstempel zählt weiter.

    Ein Server aus der Freigabe-Zeit, der per ``.env`` eingerichtet wurde, hat
    nur ``env_file_downloaded_at`` — kein eingelöstes Token, kein Verbinden.
    Fiele er aus ``set_up``, verschwände er aus der Leiste seiner Mitglieder.
    """
    async with session_factory() as session:
        await session.execute(
            update(RegisteredInstance)
            .where(RegisteredInstance.id == alice_instance.id)
            .values(env_file_downloaded_at=datetime.now(UTC))
        )
        await session.commit()
```

**Teil 6 — alte Zeilen 466–710 löschen.** Alt (245 Zeilen, Leerzeilen mitgezählt) — ab Zeile 468:

```python
# ---------------------------------------------------------------------------
# POST /me/instances/{id}/env-file
# ---------------------------------------------------------------------------
```

bis Zeile 710:

```python
        headers={"Cookie": alice_cookie},
    )
    assert r.status_code == 404
```

`services/auth/tests/test_admin_instances.py` — `_seed_instance` legt eine Instanz an wie einen Bestandsserver (mit Worker-IDs; die Spalten sind nach Etappe 1 nullable, Werte sind weiter erlaubt):

**Teil 1 — alte Zeilen 5–19 ersetzen.** Alt:

```python
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_instances import (
    InstanceApplication,
    RegisteredInstance,
    SuspendedInstance,
    UserInstanceMembership,
)
from dcc_auth.security import verify_password
```

Neu:

```python

Antrag und Freigabe (``/admin/instance-applications``) sind seit Oktober 2026
entfernt (Spec E11). Die Instanzen dieser Suite entstehen deshalb direkt in
der Datenbank (``_seed_instance``) — so, wie ein Bestandsserver aus der
Freigabe-Zeit dort steht.
"""

from __future__ import annotations

import secrets

import pytest
from sqlalchemy import select

from dcc_auth.models import User
from dcc_auth.models_instances import (
    RegisteredInstance,
    SuspendedInstance,
    UserInstanceMembership,
)
from dcc_auth.security import hash_password, verify_password
from dcc_auth.snowflake import next_id
```

**Teil 2 — alte Zeilen 56–74 ersetzen.** Alt:

```python
async def _seed_application(session_factory, *, user_id: int, hostname: str) -> int:
    """Insert a pending InstanceApplication and return its id."""
    from dcc_auth.snowflake import next_id

    app_id = next_id()
    async with session_factory() as s:
        s.add(
            InstanceApplication(
                id=app_id,
                applicant_user_id=user_id,
                hostname=hostname,
                purpose="privat",
                expected_users=5,
                contact_email="op@dcc-test.example.com",
                notes=None,
            )
        )
        await s.commit()
    return app_id
```

Neu:

```python
async def _seed_instance(
    session_factory, *, user_id: int, hostname: str
) -> tuple[str, str]:
    """Aktive VPS-Instanz samt Besitzer-Mitgliedschaft anlegen, wie ein
    Bestandsserver aus der Freigabe-Zeit (mit Worker-IDs, die neue Einträge
    seit Oktober 2026 nicht mehr bekommen).

    Gibt ``(Instanz-ID als String, Klartext-Secret)`` zurück.
    """
    iid = next_id()
    secret = secrets.token_urlsafe(32)
    async with session_factory() as s:
        s.add(
            RegisteredInstance(
                id=iid,
                hostname=hostname,
                client_id=f"ci_{iid}",
                client_secret=hash_password(secret),
                worker_id_chat=900,
                worker_id_voice=901,
                worker_id_media=902,
                status="active",
                registered_by=user_id,
            )
        )
        s.add(UserInstanceMembership(user_id=user_id, instance_id=iid, role="owner"))
        await s.commit()
    return str(iid), secret
```

**Teil 3 — alte Zeile 104 ersetzen.** Alt:

```python
    """Register a throwaway user and return their id (for seeding applications)."""
```

Neu:

```python
    """Register a throwaway user and return their id (for seeding instances)."""
```

**Teil 4 — alte Zeilen 114–141 löschen.** Alt:

```python


@pytest.mark.asyncio
async def test_list_applications_403(client, regular_token):
    r = await client.get(
        "/admin/instance-applications",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_approve_403(client, regular_token):
    r = await client.post(
        "/admin/instance-applications/1/approve",
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_reject_403(client, regular_token):
    r = await client.post(
        "/admin/instance-applications/1/reject",
        json={"rejection_reason": "nope"},
        headers={"Authorization": f"Bearer {regular_token}"},
    )
    assert r.status_code == 403
```

**Teil 5 — alte Zeilen 181–378 ersetzen.** Alt (198 Zeilen, Leerzeilen mitgezählt) — ab Zeile 181:

```python
# 2. List applications                                                          #
# --------------------------------------------------------------------------- #
```

bis Zeile 378:

```python
    await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
```

Neu:

```python
# 2. Antrag und Freigabe sind entfernt                                          #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_antrags_verwaltung_ist_entfernt(client, admin_token):
    """Seit Oktober 2026 gibt es keine Freigabe mehr (Spec E11) — die Routen
    sind weg, auch für Admins. Ein 404 statt 403: es gibt sie schlicht nicht."""
    h = {"Authorization": f"Bearer {admin_token}"}
    assert (await client.get("/admin/instance-applications", headers=h)).status_code == 404
    r = await client.post("/admin/instance-applications/1/approve", headers=h)
    assert r.status_code == 404
    r = await client.post(
        "/admin/instance-applications/1/reject", json={"rejection_reason": "x"}, headers=h
    )
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# 3. List instances — no client_secret in response                              #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_list_instances_no_secret(client, admin_token, session_factory, applicant_user_id):
    await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="sec-check.example.com"
```

**Teil 6 — alte Zeilen 394–399 ersetzen.** Alt:

```python
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="filter-test.example.com"
    )
    await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
```

Neu:

```python
    await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="filter-test.example.com"
```

**Teil 7 — alte Zeilen 418–431 ersetzen.** Alt:

```python
# 8. Suspend → DB state                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_suspend_happy(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="suspend-me.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]
```

Neu:

```python
# 4. Suspend → DB state                                                         #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_suspend_happy(client, admin_token, session_factory, applicant_user_id):
    inst_id, _ = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="suspend-me.example.com"
    )
```

**Teil 8 — alte Zeilen 450–457 ersetzen.** Alt:

```python
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="suspend-idem.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]
```

Neu:

```python
    inst_id, _ = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="suspend-idem.example.com"
    )
```

**Teil 9 — alte Zeilen 470–483 ersetzen.** Alt:

```python
# 9. Unsuspend → row gone, status active                                        #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_unsuspend_happy(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="unsuspend-me.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]
```

Neu:

```python
# 5. Unsuspend → row gone, status active                                        #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_unsuspend_happy(client, admin_token, session_factory, applicant_user_id):
    inst_id, _ = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="unsuspend-me.example.com"
    )
```

**Teil 10 — alte Zeilen 505–512 ersetzen.** Alt:

```python
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="unsuspend-idem.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]
```

Neu:

```python
    inst_id, _ = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="unsuspend-idem.example.com"
    )
```

**Teil 11 — alte Zeilen 523–538 ersetzen.** Alt:

```python
# 10. Rotate secret                                                              #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_rotate_secret(client, admin_token, session_factory, applicant_user_id):
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="rotate-me.example.com"
    )
    approval = await client.post(
        f"/admin/instance-applications/{app_id}/approve",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    inst_id = approval.json()["instance_id"]
    inst_id_int = int(inst_id)
    old_secret_plain = approval.json()["client_secret"]
```

Neu:

```python
# 6. Rotate secret                                                               #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_rotate_secret(client, admin_token, session_factory, applicant_user_id):
    inst_id, old_secret_plain = await _seed_instance(
        session_factory, user_id=applicant_user_id, hostname="rotate-me.example.com"
    )
    inst_id_int = int(inst_id)
```

**Teil 12 — alte Zeilen 591–614 löschen.** Alt:

```python

@pytest.mark.asyncio
async def test_approve_reject_require_owner(
    client, admin_token, session_factory, applicant_user_id
):
    """Owner-Stufe: ein Admin OHNE Owner-Recht darf weder genehmigen noch ablehnen."""
    await _register(client, username="modonly", email="modonly@dcc-test.example.com")
    await _promote(session_factory, "modonly", owner=False)  # Admin, aber kein Owner
    mod_token = await _login(client, username="modonly")
    app_id = await _seed_application(
        session_factory, user_id=applicant_user_id, hostname="self9.example.com"
    )
    h = {"Authorization": f"Bearer {mod_token}"}
    assert (
        await client.post(f"/admin/instance-applications/{app_id}/approve", headers=h)
    ).status_code == 403
    assert (
        await client.post(
            f"/admin/instance-applications/{app_id}/reject",
            json={"rejection_reason": "x"},
            headers=h,
        )
    ).status_code == 403
```

`services/auth/tests/test_self_host_gate.py` — die `.env`-Gate-Tests und ihre Fixtures entfallen; die beiden Flag-Tests bleiben:

**Teil 1 — alte Zeilen 1–13 ersetzen.** Alt:

```python
"""Tests for the self_host_enabled gate on mint_bootstrap_token and /me."""

from __future__ import annotations

import secrets

import pytest
import pytest_asyncio

from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance

_FAKE_HASH = "$argon2id$v=19$m=65536,t=3,p=4$fakehash"
```

Neu:

```python
"""Tests für das Flag ``self_host_enabled``: Admin-Schalter und ``/me``.

Bis Oktober 2026 gab es dazu ein Gate am ``.env``-Download; der Download ist
entfernt (Spec E11), das Flag bleibt für den Server-App-Weg (Spec E8).
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from dcc_auth.models import User
```

**Teil 2 — alte Zeilen 64–173 löschen.** Alt (110 Zeilen, Leerzeilen mitgezählt) — ab Zeile 64:

```python
@pytest_asyncio.fixture
async def carol_instance(session_factory, carol) -> RegisteredInstance:
    async with session_factory() as s:
```

bis Zeile 171:

```python
    )
    assert r.status_code == 200, r.text
    assert "PULSE_CLOUD_CLIENT_SECRET=" in r.text
```

`services/auth/tests/test_instance_delete.py` — „Adresse wieder frei für einen neuen Antrag“ entfällt (die Umbenennung auf `deleted-<id>.invalid` prüft `test_delete_happy_path`); der Abschluss-Test prüft den geschlossenen Antrag nur noch in der Datenbank:

**Teil 1 — alte Zeilen 236–263 löschen.** Alt:

```python
async def test_delete_frees_hostname_for_new_application(
    client, owner_cookie, owner_instance, session_factory
):
    # Vor der Löschung: Hostname ist belegt → Antrag 409.
    app_payload = {
        "hostname": _HOSTNAME,
        "purpose": "privat",
        "expected_users": 5,
        "contact_email": "owner@dcc-test.example.com",
    }
    r = await client.post(
        "/me/instance-applications", json=app_payload, headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 409

    r = await client.delete(
        f"/me/instances/{owner_instance.id}", headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 204

    # Nach der Löschung: Hostname wieder frei.
    r = await client.post(
        "/me/instance-applications", json=app_payload, headers={"Cookie": owner_cookie}
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
```

**Teil 2 — alte Zeilen 343–346 ersetzen.** Alt:

```python
    Ohne den Cleanup behielten Mitglieder eine Server-Kachel ohne Server,
    das Direktpfad-Telefonbuch nannte eine tote Adresse, und der genehmigte
    Ursprungs-Antrag zeigte auf jedem Gerät weiter den roten
    "einrichten"-Punkt (myInstanceApplications zählt status='approved').
```

Neu:

```python
    Ohne den Cleanup behielten Mitglieder eine Server-Kachel ohne Server, und
    das Direktpfad-Telefonbuch nannte eine tote Adresse. Der genehmigte
    Ursprungs-Antrag wird geschlossen — die Anträge sind seit Oktober 2026 nur
    noch Historie (Spec E11), und die soll stimmen: eine gelöschte Instanz hat
    keinen „genehmigten" Antrag mehr.
```

**Teil 3 — alte Zeilen 410–415 löschen.** Alt:

```python
    # Der geschlossene Antrag zählt für den Owner nirgends mehr als
    # approved — der rote Punkt stirbt server-abgeleitet auf jedem Gerät.
    r = await client.get("/me/instance-applications", headers={"Cookie": owner_cookie})
    assert r.status_code == 200
    assert [a["status"] for a in r.json()] == ["closed"]
```

`services/auth/tests/test_bootstrap_token.py` — die Meldung nach dem Einlösen darf keinen Antrag mehr verlangen:

**Teil 1 — alte Zeilen 195–196 ersetzen.** Alt:

```python
    'setup-komplett' — weitere Mints sind geblockt, User muss neuen Antrag
    stellen."""
```

Neu:

```python
    'setup-komplett' — weitere Mints sind geblockt; nur der bewusste Reset
    (``reset=true``) stellt neu aus. Einen Antrag gibt es seit Oktober 2026
    nicht mehr, die Meldung darf deshalb auch nicht auf einen verweisen."""
```

**Teil 2 — nach alter Zeile 211 einfügen.** Die alten Zeilen 210–212 lauten (eingefügt wird vor der letzten davon):

```python
    assert r2.status_code == 403
    assert "bereits eingelöst" in r2.json()["detail"]
```

Einfügen:

```python
    assert "Antrag" not in r2.json()["detail"]
```

Dann: `git rm services/auth/tests/test_unified_applications.py services/auth/tests/test_admin_app_host.py` (beide testen nur Antrag/Freigabe).

- [ ] **Step 3: Laufen lassen — drei Tests müssen scheitern.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests -n 8`

Expected: genau diese drei rot — `test_antrag_und_env_download_sind_entfernt` (`assert 201 == 404`), `test_antrags_verwaltung_ist_entfernt` (`assert 200 == 404`), `test_mint_blocked_after_successful_redeem` (`assert "Antrag" not in …`); alle anderen grün.

- [ ] **Step 4: Entfernen.**

`git rm services/auth/src/dcc_auth/routes_applications.py services/auth/src/dcc_auth/routes_admin_applications.py services/auth/src/dcc_auth/instance_env_file.py`

`services/auth/src/dcc_auth/app.py`:

**Block 1 — alte Zeilen 24–28 ersetzen.** Alt:

```python
from dcc_auth.routes_admin_applications import router as admin_applications_router
from dcc_auth.routes_admin_backup import router as admin_backup_router
from dcc_auth.routes_admin_instances import router as admin_instances_router
from dcc_auth.routes_admin_smtp import router as admin_smtp_router
from dcc_auth.routes_applications import router as applications_router
```

Neu:

```python
from dcc_auth.routes_admin_backup import router as admin_backup_router
from dcc_auth.routes_admin_instances import router as admin_instances_router
from dcc_auth.routes_admin_smtp import router as admin_smtp_router
```

**Block 2 — alte Zeile 274 löschen.** Alt:

```python
    app.include_router(admin_applications_router)
```

**Block 3 — alte Zeile 290 löschen.** Alt:

```python
    app.include_router(applications_router)
```

`services/auth/src/dcc_auth/routes_instance_applications.py` — `_require_self_host_enabled` (einziger Nutzer war der `.env`-Download) und die Route `POST /me/instances/{id}/env-file` fallen weg, die Importe `asyncio`, `Response`, `render_instance_env`, `hash_password` mit ihnen; die Kommentare zum Download werden Vergangenheit. Danach ist die Datei ~380 statt 524 Zeilen lang (unter der harten Grenze von 500).

**Block 1 — alte Zeilen 3–19 ersetzen.** Alt:

```python
GET    /me/instances                    -- eigene registrierte Instanzen
POST   /me/instances/{id}/env-file            -- fertige .env (inkl. frischem Secret)
POST   /me/instances/{id}/bootstrap-token     -- One-Time-Installer-Token

Die Antrags-Endpoints (``/me/instance-applications``) leben seit dem vereinten
Antragssystem (Migration 0044) in ``routes_applications.py``; Beitritt, Austritt
und die Server-Präferenzen in ``routes_instance_membership.py`` (Größen-Policy).
"""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response, status
```

Neu:

```python
POST   /me/instances                          -- eigenen Heim-Server anlegen
GET    /me/instances                          -- eigene registrierte Instanzen
POST   /me/instances/{id}/bootstrap-token     -- One-Time-Token (Server-App)

Antrag (``/me/instance-applications``) und ``.env``-Download sind seit Oktober
2026 entfernt (Spec E11) — ein gemieteter Server verbindet sich per Gerätecode
selbst (``routes_verbinden.py``). Beitritt, Austritt und die Server-Präferenzen
liegen in ``routes_instance_membership.py`` (Größen-Policy).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
```

**Block 2 — alte Zeile 32 löschen.** Alt:

```python
from dcc_auth.instance_env_file import render_instance_env
```

**Block 3 — alte Zeile 45 löschen.** Alt:

```python
from dcc_auth.security import hash_password
```

**Block 4 — alte Zeilen 70–106 löschen.** Alt:

```python


def _require_self_host_enabled(user: User) -> None:
    """Cloud-Gate (④) — sitzt nur auf ``generate_env_file``, und dort nur fuer
    ``origin == "app_host"``.

    **Einschraenkung 2026-08-27 (gemeldeter Fehler).** Das Flag ist durchweg ein
    APP-HOST-Begriff: ``_guard_app_host`` sperrt damit Doppelantraege, der
    Widerruf loescht es und suspendiert dabei genau die ``app_host``-Instanzen.
    ``_approve_vps`` setzt es deshalb nie (festgehalten in
    ``test_unified_applications``) — womit es fuer einen VPS-Eigentuemer nicht
    ein Gate war, sondern eine Mauer: der ``.env``-Download, also Schritt 1 des
    manuellen Compose-Wegs, war fuer die einzige Zielgruppe dieses Wegs
    dauerhaft zu. Der Absatz unten wusste das schon („Flag greift bei denen
    nie") und zog daraus nur den Schluss fuer den Mint. Sichtbar wurde es nie,
    weil die Oberflaeche jeden 403 als „schon heruntergeladen" auslegte.

    Den VPS-Fall deckt seither dasselbe wie den Bootstrap-Mint (s.u.), der
    dieselben Zugangsdaten liefert: Eigentuemer-Check plus eine vom Admin
    genehmigte, **aktive** Instanz — der Status wird dafuer jetzt ausdruecklich
    geprueft, vorher stand dort nur „nicht geloescht", eine suspendierte
    Instanz haette also frische Zugangsdaten ziehen koennen.

    Entscheidung 2026-07-13 (der frühere Docstring verlangte das Gate auch auf
    ``mint_bootstrap_token`` — das war veraltet, nicht der Code): Der
    Bootstrap-Mint ist bereits über den Owner-Check (``registered_by ==
    user.id``) plus eine vom Admin genehmigte, aktive Instanz gedeckt, und der
    Redeem verweigert nicht-aktive Instanzen. Die Server-App nutzt den Mint
    außerdem mit ``reset=true`` zur Crash-/Gerätewechsel-Recovery — ein
    ``self_host_enabled``-Gate dort würde App-Host-Owner nach einem Admin-
    Revoke+Re-Approve-Zyklus oder VPS-Owner (Flag greift bei denen nie)
    aussperren. Fuer App-Host-Instanzen bleibt
    das Flag am env-File-Download noetig, weil der jederzeit ein frisches
    ``client_secret`` rotieren kann und das Loeschen des Flags dort der
    Widerruf IST (s. CLAUDE.md „Self-Host-Approval-Flow")."""
    if not user.self_host_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="self-hosting not enabled")
```

**Block 5 — alte Zeile 137 ersetzen.** Alt:

```python
    # Installer wurde eingelöst ODER die ``.env`` heruntergeladen (dieselbe
```

Neu:

```python
    # Installer wurde eingelöst ODER (bis Oktober 2026) die ``.env`` heruntergeladen (dieselbe
```

**Block 6 — alte Zeile 199 ersetzen.** Alt:

```python
        # Verwaltungs-Routen (env-file, bootstrap-token, DELETE) verriegeln
```

Neu:

```python
        # Verwaltungs-Routen (bootstrap-token, DELETE) verriegeln
```

**Block 7 — alte Zeilen 219–220 ersetzen.** Alt:

```python
    dort zählen BEIDE Wege: das eingelöste Installer-Token und der
    ``.env``-Download. Ein bloss ausgestelltes Token zählt nicht; wer den
```

Neu:

```python
    dort zählen BEIDE Wege: das eingelöste Installer-Token und der frühere
    ``.env``-Download (entfernt im Oktober 2026; sein Zeitstempel
    ``env_file_downloaded_at`` zählt für Bestandsserver weiter, sonst fielen
    sie aus der Leiste ihrer Mitglieder). Ein bloss ausgestelltes Token zählt nicht; wer den
```

**Block 8 — alte Zeilen 341–455 ersetzen.** Alt (115 Zeilen, Leerzeilen mitgezählt) — ab Zeile 341:

```python
    """Optionaler Body der beiden „Zugang neu ausstellen"-Pfade.

    ``reset=true`` hebt die jeweilige One-Shot-Sperre auf (``.env``-Download
```

bis Zeile 455:

```python
            "Content-Disposition": f'attachment; filename="pulse-instance-{inst.id}.env"'
        },
    )
```

Neu:

```python
    """Optionaler Body des „Zugang neu ausstellen"-Pfads am Bootstrap-Mint.

    ``reset=true`` hebt die One-Shot-Sperre auf — der bewusste Recovery-Weg
    nach Geräteverlust (Server-App). Das Einlösen rotiert die Credentials,
    alte sterben sofort. Bis Oktober 2026 teilte sich der ``.env``-Download
    dasselbe Modell; der Download ist entfernt (Spec E11).
    """

    reset: bool = False
```

**Block 9 — alte Zeile 507 ersetzen.** Alt:

```python
            detail="Bootstrap bereits eingelöst — für weitere Server neuen Antrag stellen",
```

Neu:

```python
            detail="Bootstrap bereits eingelöst — neu ausstellen nur mit reset=true",
```

`services/auth/src/dcc_auth/admin_events.py` — vollständig ersetzen durch (die beiden Antrags-Meldungen und ihre Hilfen entfallen; `USER_EVENTS_CHANNEL` bleibt, `instance_status.py` importiert ihn):

```python
"""Kanalname für Benachrichtigungen von auth-svc an einzelne Nutzer (Redis Pub/Sub).

``USER_EVENTS_CHANNEL`` (``user:events``) stellt chat-gateway genau einem
Nutzer zu; ``instance_status.py`` meldet darüber, ob ein Heim-Server läuft.

Bis Oktober 2026 lagen hier auch die Antrags-Meldungen
(``admin_application_pending`` an die Admins über ``admin:events``,
``application_decided`` an den Antragsteller). Mit Antrag und Freigabe sind
sie entfallen (Spec E11).
"""

from __future__ import annotations

# Direct-Delivery an genau einen User. chat-gateway routet über
# ``_target_user_id`` und streift das Feld vor der Zustellung ab.
USER_EVENTS_CHANNEL = "user:events"
```

`services/auth/src/dcc_auth/routes_admin_instances.py` — Docstring:

**Block 1 — alte Zeilen 10–11 ersetzen.** Alt:

```python
Die Antrags-Endpoints (``/admin/instance-applications``) leben seit dem
vereinten Antragssystem (Migration 0044) in ``routes_admin_applications.py``.
```

Neu:

```python
Antrag und Freigabe (``/admin/instance-applications``) sind seit Oktober 2026
entfernt (Spec E11); Server verbinden sich per Gerätecode selbst
(``routes_verbinden.py``).
```

und, wenn Step 1 es bestätigt hat, die Worker-ID-Vergabe: alte Zeilen 96–143 löschen (vom Kopf `# Helpers` über `_SELF_HOST_WORKER_START`, `_WORKER_ID_MAX` und `_allocate_worker_ids` bis zur Leerzeile vor `# 4. GET /admin/instances`) und Zeile 23

```python
from sqlalchemy import delete, func, select
```

ersetzen durch

```python
from sqlalchemy import delete, select
```

`services/auth/src/dcc_auth/routes_instance_delete.py` — die Begründung des Soft-Delete und der Kommentar zum Schließen des Antrags stimmen nicht mehr:

**Block 1 — alte Zeilen 8–14 ersetzen.** Alt:

```python
Warum Soft-Delete statt Hard-Delete: Die Worker-IDs (chat/voice/media) werden
per max+1 vergeben (``_allocate_worker_ids``) — eine hart gelöschte Zeile würde
ihre IDs für die nächste Approval freigeben, und die neue Instanz würde
Snowflakes minten, die mit bereits existierenden IDs der gelöschten Instanz
kollidieren. Die Zeile bleibt deshalb bestehen (``status='deleted'``), nur der
Hostname wird auf einen Platzhalter unter ``.invalid`` (RFC 2606) umbenannt,
damit er für Neuanträge wieder frei ist.
```

Neu:

```python
Warum Soft-Delete statt Hard-Delete: Bis Oktober 2026 vergab die Cloud
Worker-IDs (chat/voice/media) per max+1 — eine hart gelöschte Zeile hätte ihre
IDs für die nächste Instanz freigegeben, deren Snowflakes dann mit denen der
gelöschten kollidiert wären. Bestandszeilen tragen diese IDs weiter; neue
Einträge bekommen keine mehr (Spec E7). Die Zeile bleibt deshalb bestehen
(``status='deleted'``), nur der Hostname wird auf einen Platzhalter unter
``.invalid`` (RFC 2606) umbenannt, damit die Adresse wieder verbunden werden
kann.
```

**Block 2 — alte Zeilen 106–110 ersetzen.** Alt:

```python
    # Ursprungs-Antrag schließen: 'approved' zählt clientseitig als "wartet
    # auf Einrichtung" (roter Punkt am UserFooter, myInstanceApplications).
    # Ohne den Endstatus lebte der Punkt auf jedem neuen Gerät weiter, obwohl
    # die Instanz weg ist. 'closed' ist bewusst KEIN 'rejected' — sonst
    # bekäme der Owner nachträglich einen Ablehnungs-Toast.
```

Neu:

```python
    # Ursprungs-Antrag schließen: Anträge sind seit Oktober 2026 nur noch
    # Historie (Spec E11), und die soll stimmen — eine gelöschte Instanz hat
    # keinen „genehmigten" Antrag mehr. 'closed' ist bewusst KEIN 'rejected':
    # abgelehnt wurde nichts.
```

`services/auth/src/dcc_auth/models_instances.py` — Docstring von `InstanceApplication`:

**Block 1 — alte Zeilen 155–159 ersetzen.** Alt:

```python
    Workflow: User stellt Antrag → status='pending' → Admin reviewt →
    approved (VPS: legt RegisteredInstance an + approved_instance_id;
    app_host: setzt self_host_enabled + provisioniert Relay-Instanz) oder
    rejected. Vorbereitung auf Monetarisierung: „approved" wird später
    „bezahlt" — ein Statusfeld, ein Antragsweg.
```

Neu:

```python
    **Seit Oktober 2026 nur noch Historie** (Spec E11): Antrag und Freigabe
    sind entfernt, keine Route legt neue Zeilen an. Die Tabelle bleibt für
    Beschwerde-Kontakte und die Spur der Bestandsserver; die Löschung einer
    Instanz schließt ihren Antrag noch (``routes_instance_delete.py``).

    Früherer Ablauf: User stellt Antrag → status='pending' → Admin reviewt →
    approved (VPS: legt RegisteredInstance an + approved_instance_id;
    app_host: setzt self_host_enabled + provisioniert Relay-Instanz) oder
    rejected.
```

- [ ] **Step 5: Laufen lassen — grün.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests -n 8`

Expected: alles grün (gegen den Stand vor Etappe 1 gemessen: 636 passed; nach Etappe 1 entsprechend mehr, nach Task 6.3 vier mehr).

Run: `git grep -n "instance-applications\|env-file\|routes_applications\|routes_admin_applications\|instance_env_file\|publish_application\|_require_self_host_enabled\|_allocate_worker_ids" -- services`

Expected: Treffer nur noch im Docstring der Migration `20260628_1200_0036_env_file_one_shot.py` (Historie, bleibt), in den Docstrings von `routes_instance_applications.py` und `routes_admin_instances.py` (Vergangenheitsform) und in den Riegel-Tests von `test_instance_applications_me.py` und `test_admin_instances.py`.

- [ ] **Step 6: Vereinfachen.** `code-simplifier` über die geänderten Dateien unter `services/auth/`; Step 5 erneut; `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 7: Commit.**

```bash
git add -A services/auth
git commit -m "chore(auth): Antrag, Freigabe, .env-Download und Worker-ID-Vergabe entfernt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6.2: Gemeinsames Ereignis `application_decided` entfernen, Web-Reste prüfen

Teil C entfernt in Etappe 5 (Tasks 5.2 und 5.3) alles, was im Web-Klienten an Antrag, Freigabe und `.env`-Download hing: `web/src/lib/api/instances.ts` wird vollständig ersetzt (ohne Antrags-Typen, `submitApplication`, `listMyApplications`, `mintBootstrapToken`, `downloadEnvFile`, `listApplications`, `approveApplication`, `rejectApplication`, `revokeAppHostApplication`), die Stores `myInstanceApplications`, `pendingInstanceApps` und `pendingAppHostApplications` fallen weg, ebenso `web/src/lib/ws/handlers/admin.ts`, die Union-Glieder `admin_application_pending`/`application_decided` in `web/src/lib/ws/handlers/types.ts`, `web/src/lib/selfhost/hinweis.svelte.ts`, das Antragsformular und die Einrichtungsoberfläche. **Im Web bleibt danach nichts übrig, und dieser Task entfernt dort nichts** — er prüft es nur. Übrig ist allein das Ereignis `application_decided` im gemeinsamen Paket `shared/`: Teil C fasst `shared/` nicht an, und nach Task 6.1 veröffentlicht es niemand mehr.

Die Widerrufs-Route `/admin/app-host-applications/{id}/revoke`, die Teil C als „in Etappe 6 entfernbar“ vermerkt, gibt es im auth-svc schon heute nicht mehr (`routes_admin_app_host_revoke.py` ist entfernt; `git grep -n "app-host-applications" -- services` trifft nur einen Docstring in `routes_admin_applications.py`, der mit Task 6.1 verschwindet). Nichts zu tun.

**Files:**
- Delete: `shared/src/dcc_shared/events/applications.py`
- Modify: `shared/src/dcc_shared/events/__init__.py:72,198,286`
- Modify: `shared/tests/test_events.py:159-162`

**Interfaces:**
- Consumes: Task 6.1 (niemand veröffentlicht `application_decided` mehr); Etappe 5 (Teil C, Tasks 5.2/5.3: Web ohne Antrags-Aufrufe).
- Produces: `EVENT_REGISTRY` ohne `application_decided`. Die Server-App ruft ihre Routen über eigene `netJson`-Aufrufe (`desktop/electron/serverProvision.ts`) und braucht nichts aus `web/src/lib/api/instances.ts`.

Kein neuer Test: reine Löschung. Nachweis sind die bestehenden Suiten (`shared/tests/test_events.py` iteriert über `EVENT_REGISTRY`) und der leere `git grep`.

- [ ] **Step 1: Web und Server-App prüfen (nur lesen).**

Run: `git grep -n "submitApplication\|listMyApplications\|mintBootstrapToken\|downloadEnvFile\|listApplications\|approveApplication\|rejectApplication\|revokeAppHostApplication\|InstanceApplication\b\|AdminApplication\|myInstanceApplications\|pendingInstanceApps\|pendingAppHostApplications\|admin_application_pending\|application_decided\|selfhost/hinweis\|instance-applications\|/env-file" -- web/src web/test desktop/electron desktop/src`

Expected: keine Ausgabe. Trifft der grep etwas unter `web/`, ist Etappe 5 nicht wie geplant gelandet — anhalten und mit Teil C klären, statt hier Oberflächen nachzubauen oder abzureißen. Ein Treffer unter `desktop/` heißt ebenfalls anhalten: dann hängt die Server-App doch an einer entfernten Route.

- [ ] **Step 2: Ereignis aus dem gemeinsamen Paket entfernen.**

`git rm shared/src/dcc_shared/events/applications.py`

`shared/src/dcc_shared/events/__init__.py` — drei Zeilen löschen:

Zeile 72:

```python
from dcc_shared.events.applications import ApplicationDecidedEvent
```

Zeile 198:

```python
    "application_decided": ApplicationDecidedEvent,
```

Zeile 286:

```python
    "ApplicationDecidedEvent",
```

`shared/tests/test_events.py` — den Eintrag `"application_decided"` (heute Zeilen 159–162) löschen; die Beispiel-Nutzlast hinge sonst ohne Eintrag im Register:

```python
    "application_decided": {
        "op": "application_decided",
        "data": {"kind": "app_host", "status": "approved", "rejection_reason": None},
    },
```

Der Weiterleiter für `admin:events` im chat-gateway (`pubsub_channel_handlers.py:340`) bleibt: er ist allgemein und hat einen eigenen Test (`test_admin_events.py`), der `admin_application_pending` nur als Beispiel-Op benutzt.

- [ ] **Step 3: Prüfen.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q shared/tests services/chat-gateway/tests/test_event_validation.py services/chat-gateway/tests/test_admin_events.py`

Expected: alles grün (gegen den heutigen Stand gemessen: 158 passed, 2 skipped).

Run: `git grep -n "application_decided\|ApplicationDecided" -- shared services web/src`

Expected: keine Ausgabe (`test_admin_events.py` benutzt `admin_application_pending`, das trifft das Muster nicht).

- [ ] **Step 4: Vereinfachen.** `code-simplifier` über `shared/src/dcc_shared/events/__init__.py`; Step 3 erneut; `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 5: Commit.**

```bash
git add -A shared
git commit -m "chore(shared): Ereignis application_decided entfernt — niemand veröffentlicht es mehr

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6.3: Texte, die noch auf den alten Weg zeigen

Die Diagnose-Texte für das Betreiber-Glied raten heute, `PULSE_INSTANCE_OWNER_ID` in `/etc/pulse/pulse.env` aus „Meine Instanzen“ einzutragen. Der Installer schreibt nie nach `/etc/pulse` (sondern nach `/opt/pulse` bzw. `~/.pulse`), und bei einem verbundenen Server kommt der Besitzer aus dem Verbinden. Dazu die App-Bezeichnung „Meine Instanzen“, die Etappe 5 in „Meine Server“ umbenannt hat, in `pulse-doctor`, im Installer und in der Anleitung.

**Files:**
- Modify: `services/auth/src/dcc_auth/diagnose_texte_betreiber.py:31-58`, `services/auth/src/dcc_auth/diagnose_texte.py:6`
- Test: `services/auth/tests/test_diagnose_texte.py` (neuer Test am Ende)
- Modify: `infra/self-host/s6/usr/local/bin/pulse-doctor:114,132,208`
- Modify: `web/static/install.sh` (die Zeile `    warn "Or in the Pulse app: My Instances → Check connection."` aus Task 4.1)
- Modify: `docs/self-host-guide.html` (vier Stellen „My Instances“ nach Task 4.3)
- Modify: `web/Dockerfile:81`

**Interfaces:**
- Consumes: Etappe 5 — der Eintrag heißt „Meine Server“ / englisch „My servers“ und sitzt im Konto-Menü unten links (Spec §5). Steht in `web/messages/en.json` eine andere englische Bezeichnung, die Texte dieses Tasks daran angleichen.
- Produces: `was_tun` der Befunde `betreiber/andere_kennung` und `betreiber/nicht_konfiguriert` nennt `sudo docker exec -it {container} pulse-connect`.

- [ ] **Step 1: Test schreiben** — am Ende von `services/auth/tests/test_diagnose_texte.py` anfügen (mit zwei Leerzeilen Abstand zum letzten Test):

```python
@pytest.mark.parametrize("befund", ["andere_kennung", "nicht_konfiguriert"])
@pytest.mark.parametrize("sprache", ["de", "en"])
def test_betreiber_texte_zeigen_auf_pulse_connect(befund: str, sprache: str) -> None:
    """Seit Oktober 2026 entsteht der Besitzer beim Verbinden, nicht in einer
    ``.env`` aus „Meine Instanzen". Der Handgriff muss deshalb ``pulse-connect``
    nennen — und darf keinen Pfad behaupten, den kein Installer je schreibt
    (``/etc/pulse/pulse.env`` stand hier, der Installer schreibt nach
    ``/opt/pulse`` bzw. ``~/.pulse``)."""
    _, was_tun = dt.erklaerung("betreiber", befund, False, sprache, container="mein-server")
    assert "docker exec -it mein-server pulse-connect" in was_tun
    assert "/etc/pulse/pulse.env" not in was_tun
    assert "Meine Instanzen" not in was_tun
    assert "My instances" not in was_tun
```

- [ ] **Step 2: Laufen lassen — vier Fälle rot.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_diagnose_texte.py`

Expected: 4 failed (`test_betreiber_texte_zeigen_auf_pulse_connect[de-andere_kennung]` usw., `AssertionError` auf `docker exec -it mein-server pulse-connect`).

- [ ] **Step 3: Texte ändern.** `services/auth/src/dcc_auth/diagnose_texte_betreiber.py`:

**Block 1 — alte Zeilen 31–58 ersetzen.** Alt:

```python
            "Trage auf der Maschine in /etc/pulse/pulse.env bei PULSE_INSTANCE_OWNER_ID die Kennung "
            "ein, die dir in „Meine Instanzen“ angezeigt wird, und starte den Server neu: "
            "sudo docker restart {container}. Danach in der App einmal neu laden.",
        ),
        (
            "This server is configured with a different account as its owner — not yours. That makes "
            "you an ordinary member there: you cannot create a community or open the server settings, "
            "even though the server is yours. The most common cause is a configuration file carried "
            "over from an earlier server.",
            "On the machine, set PULSE_INSTANCE_OWNER_ID in /etc/pulse/pulse.env to the identifier "
            "shown to you under \"My instances\", then restart the server: "
            "sudo docker restart {container}. Afterwards reload the app once.",
        ),
    ),
    ("betreiber", "nicht_konfiguriert"): (
        (
            "Dieser Server weiss gar nicht, wem er gehört. Damit kann ihn niemand verwalten — auch du "
            "nicht.",
            "Trage auf der Maschine in /etc/pulse/pulse.env bei PULSE_INSTANCE_OWNER_ID die Kennung "
            "ein, die dir in „Meine Instanzen“ angezeigt wird, und starte den Server neu: "
            "sudo docker restart {container}.",
        ),
        (
            "This server does not know who it belongs to. Nobody can administer it that way — not "
            "even you.",
            "On the machine, set PULSE_INSTANCE_OWNER_ID in /etc/pulse/pulse.env to the identifier "
            "shown to you under \"My instances\", then restart the server: "
            "sudo docker restart {container}.",
```

Neu:

```python
            "Verbinde den Server neu mit dem Konto, dem er gehören soll: sudo docker exec -it "
            "{container} pulse-connect — dann den angezeigten Link öffnen und mit diesem Konto "
            "bestätigen; danach in der App einmal neu laden. Ausnahme: Ein Server, der vor Oktober "
            "2026 mit Freigabe eingerichtet wurde, trägt den Besitzer als PULSE_INSTANCE_OWNER_ID in "
            "seiner Konfigurationsdatei (Installer: /opt/pulse/pulse.env bzw. ~/.pulse/pulse.env, "
            "Compose: .env neben der Compose-Datei). Dort die Kennung korrigieren und "
            "sudo docker restart {container}.",
        ),
        (
            "This server is configured with a different account as its owner — not yours. That makes "
            "you an ordinary member there: you cannot create a community or open the server settings, "
            "even though the server is yours. The most common cause is a configuration file carried "
            "over from an earlier server.",
            "Connect the server again with the account that should own it: sudo docker exec -it "
            "{container} pulse-connect — then open the link it shows and confirm with that account; "
            "afterwards reload the app once. Exception: a server set up before October 2026 with an "
            "approval carries its owner as PULSE_INSTANCE_OWNER_ID in its configuration file "
            "(installer: /opt/pulse/pulse.env or ~/.pulse/pulse.env, Compose: the .env next to the "
            "compose file). Correct the identifier there and run sudo docker restart {container}.",
        ),
    ),
    ("betreiber", "nicht_konfiguriert"): (
        (
            "Dieser Server weiss gar nicht, wem er gehört. Damit kann ihn niemand verwalten — auch du "
            "nicht.",
            "Verbinde den Server mit deinem Konto: sudo docker exec -it {container} pulse-connect — "
            "dann den angezeigten Link öffnen und bestätigen. Ausnahme: Ein Server, der vor Oktober "
            "2026 mit Freigabe eingerichtet wurde, trägt den Besitzer als PULSE_INSTANCE_OWNER_ID in "
            "seiner Konfigurationsdatei (Installer: /opt/pulse/pulse.env bzw. ~/.pulse/pulse.env, "
            "Compose: .env neben der Compose-Datei). Dort die Kennung eintragen und "
            "sudo docker restart {container}.",
        ),
        (
            "This server does not know who it belongs to. Nobody can administer it that way — not "
            "even you.",
            "Connect the server to your account: sudo docker exec -it {container} pulse-connect — "
            "then open the link it shows and confirm. Exception: a server set up before October 2026 "
            "with an approval carries its owner as PULSE_INSTANCE_OWNER_ID in its configuration file "
            "(installer: /opt/pulse/pulse.env or ~/.pulse/pulse.env, Compose: the .env next to the "
            "compose file). Enter the identifier there and run sudo docker restart {container}.",
```

`services/auth/src/dcc_auth/diagnose_texte.py`:

**Block 1 — alte Zeile 6 ersetzen.** Alt:

```python
„Meine Instanzen", und ``pulse-doctor`` im Container. Läge der Text an jeder
```

Neu:

```python
„Meine Server", und ``pulse-doctor`` im Container. Läge der Text an jeder
```

- [ ] **Step 4: Laufen lassen — grün.**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 PULSE_INSTANCE_MODE=cloud PULSE_INSTANCE_ID=0 uv run --all-packages pytest -q services/auth/tests/test_diagnose_texte.py`

Expected: alles grün, auch `test_kein_text_nagelt_den_containernamen_fest` (die neuen Sätze tragen `{container}`).

- [ ] **Step 5: Bezeichnung „Meine Server“ an den übrigen Stellen.**

`infra/self-host/s6/usr/local/bin/pulse-doctor`:

**Block 1 — alte Zeile 114 ersetzen.** Alt:

```bash
        rat "in der App unter Meine Instanzen -> Verbindung pruefen."
```

Neu:

```bash
        rat "in der App unter Meine Server -> Verbindung pruefen."
```

**Block 2 — alte Zeile 132 ersetzen.** Alt:

```bash
        rat "Meine Instanzen -> Verbindung pruefen."
```

Neu:

```bash
        rat "Meine Server -> Verbindung pruefen."
```

**Block 3 — alte Zeile 208 ersetzen.** Alt:

```bash
    echo "in der App unter Meine Instanzen -> Verbindung pruefen."
```

Neu:

```bash
    echo "in der App unter Meine Server -> Verbindung pruefen."
```

`web/static/install.sh` (Zeile aus Task 4.1, Schritt 9 des Ablaufs):

```bash
    warn "Or in the Pulse app: My Instances → Check connection."
```

→

```bash
    warn "Or in the Pulse app: My servers → Check connection."
```

`docs/self-host-guide.html` — Zeilennummern Stand **nach** Task 4.3:

**Block 1 — alte Zeilen 667–669 ersetzen.** Alt:

```html
      <p>Finally run <strong>Settings &rarr; Your own server &rarr; My Instances
      &rarr; Check connection</strong>. That is the view from outside, and it
      catches what a server cannot see about itself.</p>
```

Neu:

```html
      <p>Finally run <strong>My servers &rarr; Check connection</strong> in the
      account menu (bottom left). That is the view from outside, and it catches
      what a server cannot see about itself.</p>
```

**Block 2 — alte Zeilen 827–830 ersetzen.** Alt:

```html
      <p>Finally run <strong>Settings &rarr; Your own server &rarr; My Instances
      &rarr; Check connection</strong>. That is the view from outside, and it
      catches what a server cannot see about itself &mdash; above all a proxy that
      drops WebSockets.</p>
```

Neu:

```html
      <p>Finally run <strong>My servers &rarr; Check connection</strong> in the
      account menu (bottom left). That is the view from outside, and it catches
      what a server cannot see about itself &mdash; above all a proxy that drops
      WebSockets.</p>
```

**Block 3 — alte Zeilen 892–893 ersetzen.** Alt:

```html
  <p>From outside: <strong>Settings &rarr; Your own server &rarr; My Instances
  &rarr; Check connection</strong>. Green inside and red outside means DNS,
```

Neu:

```html
  <p>From outside: <strong>My servers &rarr; Check connection</strong> in the
  account menu (bottom left). Green inside and red outside means DNS,
```

**Block 4 — alte Zeilen 1006–1007 ersetzen.** Alt:

```html
  <p>Afterwards delete the instance in the app under <strong>My Instances</strong>,
  which frees the hostname. Members remove the server from their own list by
```

Neu:

```html
  <p>Afterwards delete the server in the app under <strong>My servers</strong>,
  which frees the address. Members remove the server from their own list by
```

`web/Dockerfile`, Zeile 81:

```dockerfile
# Die Self-Host-Anleitung selbst — verlinkt aus dem InstanceSetupDialog,
```

→

```dockerfile
# Die Self-Host-Anleitung selbst — verlinkt aus der App (Eigenen Server einrichten),
```

Run: `git grep -n "Meine Instanzen\|My Instances\|My instances" -- infra web/static docs/self-host-guide.html services/auth/src web/Dockerfile`

Expected: keine Ausgabe.

- [ ] **Step 6: Vereinfachen.** `code-simplifier` über `diagnose_texte_betreiber.py`; Step 4 erneut; `bash .claude/hooks/simplify-stamp.sh`.

- [ ] **Step 7: Commit.**

```bash
git add services/auth/src/dcc_auth/diagnose_texte_betreiber.py services/auth/src/dcc_auth/diagnose_texte.py \
  services/auth/tests/test_diagnose_texte.py infra/self-host/s6/usr/local/bin/pulse-doctor \
  web/static/install.sh docs/self-host-guide.html web/Dockerfile
git commit -m "fix(self-host): Diagnose-Texte und Hinweise zeigen auf pulse-connect und „Meine Server“

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6.4: Doku, CLAUDE.md, Gedächtnis

**Files:**
- Modify: `CLAUDE.md:187,193,195,197,208,417,431,509`
- Modify: `IDENTITY_CONCEPT.md` (Nachtrag nach Zeile 130)
- Modify: `docs/INSTANCE_APPROVAL_POLICY.md:1-4`
- Modify: `infra/prod/DEPLOY.md:238-243`
- Modify (maschinenlokal, nicht im Repo): `~/.claude/projects/-home-michael-Dokumente-pulse/memory/project_unified_hosting_applications.md`, `~/.claude/projects/-home-michael-Dokumente-pulse/memory/MEMORY.md:21`

**Interfaces:**
- Consumes: Etappen 0–6 live; Namen aus dem Vertrag (`routes_verbinden.py`, `verbinden*.py`, `verbinden_cli.py`, `/data/pulse/verbindung.env`, Migration `0056_verbinden`).
- Produces: Doku, die den heutigen Weg beschreibt.

- [ ] **Step 1: Fundstellen sammeln** (Regel „eine Behauptung wird nie an nur einer Stelle korrigiert“, auch beim Löschen).

Run: `git grep -n -i "Approval = Single-Bootstrap\|Antragsteller\|neuer Antrag\|\.env-Download\|env-file\|Meine Instanzen\|oblivion8282-1337/pulse" -- CLAUDE.md IDENTITY_CONCEPT.md docs/*.md infra/prod/DEPLOY.md infra/self-host/README.md`

Expected: die Stellen unten; jede weitere Fundstelle mit derselben Sorgfalt nachziehen (datierte Dokumente unter `docs/plans/`, `docs/superpowers/` und `docs/2026-*` sind Historie und bleiben). Die Adresse `249562202+oblivion8282-1337@users.noreply.github.com` und der Pin `ghcr.io/oblivion8282-1337/pulse-mediamtx:1.19.1-pulse7` bleiben.

- [ ] **Step 2: `CLAUDE.md`.** Neun Ersetzungen; jede alte Zeichenkette kommt heute genau einmal vor (mit `str.count` geprüft), alle neun zusammen ließen sich auf den heutigen Stand anwenden. Die Zeilenangaben sind Stand heute. Nr. 7 und 9 nur, falls Etappe 0 sie nicht schon ersetzt hat (ihr Abschluss-`grep` nimmt `CLAUDE.md` aus).

**1. Zeile 187** — alt:

```markdown
`PULSE_INSTANCE_ID` (0 = Cloud; ≥100 = von Cloud vergeben)
```

neu:

```markdown
`PULSE_INSTANCE_ID` (0 = Cloud bzw. noch nicht verbundener Self-Host; sonst von der Cloud vergeben — aus der Umgebung oder aus `/data/pulse/verbindung.env`, die `pulse-connect` schreibt; **die Umgebung gewinnt**)
```

**2. Zeile 193** — alt:

```markdown
(`ticket.sub == PULSE_INSTANCE_OWNER_ID`, gesetzt aus `registered_by` = Antragsteller)
```

neu:

```markdown
(`ticket.sub == PULSE_INSTANCE_OWNER_ID`, gesetzt aus `registered_by` = dem Konto, das den Server beim Verbinden bestätigt hat; bei den Bestandsservern der damalige Antragsteller)
```

**3. Zeile 193** — alt:

```markdown
`sub` trägt dieselbe Zahl, die in der `.env` steht
```

neu:

```markdown
`sub` trägt dieselbe Zahl, die in der Umgebung bzw. in `/data/pulse/verbindung.env` steht
```

**4. Zeile 195** — alt:

```markdown
also ausgerechnet der Fall, den `10-check-cloud-creds.sh` schon beim Start abfängt.
```

neu:

```markdown
also ausgerechnet der Fall, den `10-check-cloud-creds.sh` damals schon beim Start abfing (seit Oktober 2026 startet ein noch nicht verbundener Server ohne Besitzer, und die Zeile ist dort zu Recht zu sehen).
```

**5. Zeile 197** — alt:

```markdown
- **Approval = Single-Bootstrap pro Antrag**: approved → User mintet **genau einmal** einen Bootstrap-Token (`POST /selfhost/bootstrap`; danach `consumed_at IS NOT NULL` blockt weitere → neuer Antrag pro Server). Container-Crash-Recovery nutzt persistierte `client_id`/`client_secret` direkt, ohne Re-Redeem.
```

neu:

```markdown
- **Keine Freigabe mehr — Verbinden per Gerätecode (seit Oktober 2026).** Jeder installiert mit `curl -fsSL https://howispulse.com/install | bash` oder Compose; Pflicht ist nur `PULSE_HOSTNAME`, das Bild `ghcr.io/oblivion-pictures/pulse` ist öffentlich. Am Ende verbindet `docker exec -it pulse pulse-connect` (Installer: von selbst) den Server mit einem Konto: Gerätecode nach RFC 8628, Bestätigung auf `howispulse.com/verbinden`, Nachweis unter `/.well-known/pulse-verbinden` — die Cloud ruft ihn vor dem Anfragen UND vor dem Eintragen ab, also kann niemand eine Adresse eintragen, die er nicht betreibt, und wer sie nachweislich betreibt, übernimmt sie (der alte Eintrag wird soft-gelöscht und landet auf der Sperrliste). Die Zugangsdaten liegen danach in `/data/pulse/verbindung.env`; **Werte aus der Umgebung gewinnen** — so laufen die drei Bestands-VPS (Zugangsdaten in ihrer `.env`; ihr Update-Skript meldet sich damit bei `registry.howispulse.com` an und hört bei einem Fehlschlag STILL auf zu aktualisieren) und die Server-App unverändert. Der Installer übernimmt die Verbindungszeilen einer alten `pulse.env` derselben Adresse und fragt „schon verbunden?“ im Container (`127.0.0.1:8002`), nicht über die eigene Adresse. Antrag, Admin-Freigabe und `.env`-Download sind entfernt; die Tabelle `auth.instance_applications` bleibt als Historie. Bootstrap-Token + `POST /selfhost/bootstrap` bleiben für die Server-App (Container-Crash-Recovery nutzt persistierte `client_id`/`client_secret` direkt, ohne Re-Redeem). Neue Einträge bekommen **keine Worker-IDs** mehr (Spalten nullable, Migration `0056_verbinden`) — der Vorrat endete bei ~307 Einträgen, und kein Self-Host las sie. Code: `dcc_auth/routes_verbinden.py`, `verbinden*.py`, chat-gateway `verbinden_cli.py`. Spec: `docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md`.
```

**6. Zeile 208** — alt:

```markdown
beim Bootstrap-Redeem automatisch eingetragen
```

neu:

```markdown
beim Bootstrap-Redeem bzw. beim Verbinden (`verbinden_eintrag.py`) automatisch eingetragen
```

**7. Zeile 417** — alt:

```markdown
(GHCR `ghcr.io/oblivion8282-1337/pulse-*:latest`)
```

neu:

```markdown
(GHCR `ghcr.io/oblivion-pictures/pulse-*:latest`, privat)
```

**8. Zeile 431** — alt:

```markdown
(`prepare`→`build`-Matrix→`merge` mit `imagetools` + `registry.howispulse.com`-Mirror)
```

neu:

```markdown
(`prepare`→`build`-Matrix→`merge` mit `imagetools` + `registry.howispulse.com`-Mirror; Bild `ghcr.io/oblivion-pictures/pulse` **öffentlich** — endgültig, GitHub nimmt das nicht zurück —, der Spiegel heißt weiter `pulse-allinone` und bedient nur noch die Bestandsserver)
```

**9. Zeile 509** — alt:

```markdown
Remote `origin` → `github.com/oblivion8282-1337/pulse.git`.
```

neu:

```markdown
Remote `origin` → `github.com/oblivion-pictures/pulse.git`.
```

- [ ] **Step 3: `IDENTITY_CONCEPT.md`** — nach Zeile 130 (Absatz „Bis dahin gilt nur: …“) und vor der Trennlinie `---` einfügen:

```markdown
**Nachtrag 2026-10 — Self-Hosts ohne Freigabe.** Wer einen Server betreibt, braucht keine Zustimmung der Cloud mehr. Der Server gehört von Anfang an jemandem: Am Ende der Installation verbindet der Betreiber ihn per Gerätecode mit seinem Konto (`pulse-connect`, Bestätigung im Browser). Danach hat er dieselben Zugangsdaten wie früher ein freigegebener Server; Tickets bleiben an die Instanz-Nummer gebunden (`aud`), Admin wird der Besitzer, Sperre und Sperrliste wirken unverändert. Die Identität bleibt zentral, die Welten bleiben isoliert — es entfällt nur der Türsteher vor dem Eröffnen einer Welt. Entwurf: `docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md`.
```

- [ ] **Step 4: `docs/INSTANCE_APPROVAL_POLICY.md`** — vor Zeile 1 einfügen:

```markdown
> **Überholt seit Oktober 2026.** Es gibt keine Freigabe mehr: Server verbinden sich per Gerätecode selbst (`docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md`). Gegen Missbrauch wirken Sperre der Instanz und der Admin-Schalter „Darf Server verbinden“ (`users.server_verbinden_gesperrt`). Der Text unten bleibt als Historie.

```

- [ ] **Step 5: `infra/prod/DEPLOY.md`** — im Abschnitt „Self-Host-Registry (registry.howispulse.com) aktivieren“ nach dem ersten Absatz (Zeile 243, endet mit `` `services/auth/src/dcc_auth/routes_registry_auth.py`.``) einfügen:

```markdown

**Stand Oktober 2026:** Neue Self-Hosts ziehen das öffentliche Bild `ghcr.io/oblivion-pictures/pulse` ohne Anmeldung. Die Registry bleibt allein für die Bestandsserver aus der Freigabe-Zeit in Betrieb — ihre Update-Skripte melden sich hier mit ihren Instanz-Zugangsdaten an und hören bei einem Fehlschlag still auf (Spec E10). Abschalten erst, wenn keiner von ihnen mehr von hier zieht.
```

- [ ] **Step 6: Prüfen.**

Run: `git grep -n -i "Approval = Single-Bootstrap\|neuer Antrag pro Server\|= Antragsteller)" -- CLAUDE.md`

Expected: keine Ausgabe.

- [ ] **Step 7: Commit.**

```bash
git add CLAUDE.md IDENTITY_CONCEPT.md docs/INSTANCE_APPROVAL_POLICY.md infra/prod/DEPLOY.md
git commit -m "docs: Self-Host ohne Freigabe in CLAUDE.md, Konzept und Betriebsdoku nachgezogen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Gedächtnis aktualisieren (maschinenlokal, nach dem Landen von Task 6.5).** In `~/.claude/projects/-home-michael-Dokumente-pulse/memory/project_unified_hosting_applications.md` den Absatz „**Stand 2026-10-10 (Fassung 2 des Entwurfs):** …“ ersetzen durch:

```markdown
**Umgesetzt (Etappen 0–6, Oktober 2026):** Self-Hosts ohne Freigabe sind live. Installer
`curl -fsSL https://howispulse.com/install | bash` bzw. Compose mit nur `PULSE_HOSTNAME`; am Ende
`docker exec -it pulse pulse-connect` (Gerätecode, Bestätigung auf howispulse.com/verbinden, Nachweis
unter /.well-known/pulse-verbinden). Zugangsdaten im Volumen (/data/pulse/verbindung.env), Umgebung
gewinnt. Bild ghcr.io/oblivion-pictures/pulse öffentlich. Antrag, Admin-Freigabe, .env-Download entfernt;
Tabelle instance_applications bleibt als Historie. Die 3 Bestands-VPS laufen unverändert weiter
(Zugangsdaten in ihrer .env, Updater am Spiegel registry.howispulse.com). Offen siehe Plan
„Offene Punkte (Teil D)“. Der Text unten ist Historie.
```

und in `~/.claude/projects/-home-michael-Dokumente-pulse/memory/MEMORY.md` die Zeile 21 ersetzen durch:

```markdown
- [Self-Host ohne Freigabe (umgesetzt 2026-10)](project_unified_hosting_applications.md) — pulse-connect per Gerätecode, Bild öffentlich, Antrag/Freigabe entfernt; Bestand läuft weiter
```

### Task 6.5: Landen

**Files:** keine.

**Interfaces:**
- Consumes: Task 6.1–6.4.
- Produces: Prod ohne Antrags-, Freigabe- und `.env`-Download-Routen.

- [ ] **Step 1: Gate.**

Run: `bash scripts/gate.sh`

Expected: `✓ Test-Gate grün.` (Bereiche `services`, `shared`, `web`, `infra`).

- [ ] **Step 2: Freigabe des Eigentümers einholen, dann landen.** Kein Changelog-Eintrag: Für Nutzer verschwindet nichts, was Etappe 5 nicht schon aus der Oberfläche genommen hat (die Warnung von `check-changelog.sh` für `services/`/`web/src` ist erwartet und hält nichts auf).

Run: `bash scripts/ship.sh`

- [ ] **Step 3: Nach dem Ausrollen prüfen** (≤ 5 min Cron).

Run: `curl -s -o /dev/null -w '%{http_code}\n' https://howispulse.com/api/auth/me/instance-applications`

Expected: `404`.

Run: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://howispulse.com/api/auth/me/instances/1/bootstrap-token`

Expected: `401` (Route besteht weiter für die Server-App; ohne Sitzung 401).

Danach Task 4.5 Step 4 (Bestandsserver) einmal wiederholen und Task 6.4 Step 8 (Gedächtnis) ausführen.

---

## Anhang — Hinweise aus der Ausplanung

Die Etappen 1 bis 6 wurden in vier Teilen gegen den Code vom 2026-10-10 ausgeplant (A: Etappe 1, B: Etappe 2, C: Etappen 3 und 5, D: Etappen 4 und 6). Hier stehen die Namen, die über den Schnittstellen-Vertrag hinaus entstanden sind, und die offenen Punkte jedes Teils. Punkte, die als „erledigt“ markiert sind, sind im Plan und im Entwurf bereits eingearbeitet.

### Neue Namen (Teil A)

Namen, die nicht im Vertrag stehen oder dort anders lauten:

- Feldlängen der Körper: `StartEin.kennung` und `AbholenEin.kennung` 32–128 Zeichen, `VorgangEin.code` 1–32 Zeichen (vor `code_normalisieren`). Start-Body und Routennamen selbst stehen seit Nachtrag 2 im Vertrag.
- `dcc_auth.verbinden`: `GUELTIG_S = 900`, `ABSTAND_S = 5`, `Status` (Literal), `class VorgangLaeuft(Exception)`. `vorgang_entscheiden(...)` gibt `bool` zurück. `vorgang_anlegen` liefert bei gleicher Kennung, gleicher Adresse und Stand `wartet` den laufenden Vorgang, sonst `VorgangLaeuft`.
- `dcc_auth.verbinden_nachweis`: `PFAD`, `FRIST_S = 8.0`, `nachweis_lesen(klient, ziel, erwartet)`, `_klient()` (Ansatzpunkt für Tests).
- `dcc_auth.verbinden_eintrag`: `HOECHSTENS_SERVER = 10`, `ZuVieleServer`, `InstanzGesperrt`, `Verbunden(instanz, abgeloest)` (Rückgabe von `instanz_verbinden`), `adresse_gesperrt(hostname, settings) -> bool`.
- `dcc_auth.email.compose_verbinden_hinweis(hostname, zeitpunkt) -> tuple[str, str]` (an das bestätigende Konto) und `dcc_auth.email.compose_verbinden_uebernahme(hostname, zeitpunkt) -> tuple[str, str]` (an den bisherigen Besitzer bei einer Übernahme, Betreff `Pulse: Dein Server wurde mit einem anderen Konto verbunden`).
- Ereignis `op = "instanz_verbunden"`, `data = {"instance_id": str}` auf `user:events` an den Besitzer, nach erfolgreichem Abholen. Modelle `InstanzVerbundenData`/`InstanzVerbundenEvent` stehen in der **vorhandenen** Datei `shared/src/dcc_shared/events/instances.py` (neben `InstanceStatusEvent`), nicht in einer neuen `instanzen.py`, damit es nicht zwei fast gleich benannte Dateien für dasselbe Thema gibt. Registriert in `EVENT_REGISTRY`. Publisher `dcc_auth.admin_events.publish_instanz_verbunden(request, *, user_id: int, instance_id: int)`.
- `dcc_auth.routes_verbinden`: Modelle `StartEin`, `StartAus`, `AbholenEin`, `VorgangEin`, `VorgangAus`, `EntscheidungEin(VorgangEin)`, `EntscheidungAus` (`VerbindenZugangOut` steht im Vertrag); Helfer `_redis`, `_bremse_je_konto`, `_offener_vorgang`, `_hinweis_mail(db, empfaenger, mail)`, `_nachweis_fehlt`.
- Zusätzliche Antworten:
  - `409 {"detail": "vorgang_laeuft"}` (Start: dieselbe Kennung für eine andere Adresse oder ein schon entschiedener Vorgang)
  - `503 {"detail": "verbinden_nicht_verfuegbar"}` (alle vier Routen, wenn Redis fehlt)
  - `403 {"detail": "instance_suspended"}` (Verbinden, wenn unter der Adresse ein gesperrter Eintrag steht)
  - `404 unbekannt` auch beim verlorenen Wettlauf zweier Klicks
  - `410 abgelaufen` auch, wenn der Eintrag zwischen Klick und Abholen gesperrt, gelöscht oder übernommen wurde
  - `429` aus den Bremsen
- Log-Ereignisse: `verbinden_uebernahme hostname=… alt=… neu=…` (warning) und `verbinden_hinweis_mail_fehlgeschlagen user_id=…: <Fehler>` (warning, Vertrag).
- Test-Fixture `redis_echt` in `services/auth/tests/conftest.py`.
- Heim-Server-Provisionierung: 503-Text `instance allocation conflict, try again` (vorher `worker-id allocation conflict, …`).

### Offene Punkte (Teil A)

1. **Erledigt durch Nachtrag 2:** Start-Body `kennung` und Code im Körper statt im Pfad. Teil C muss `holeVerbindung`/`entscheideVerbindung` auf `POST …/vorgang` und `POST …/entscheidung` bauen. Die Nachweis-Datei des Servers (Teil B) bleibt der SHA-256 (64 Hex) der Kennung.
2. **Nachtrag 1 im Vertrag** nennt für die Hinweis-Mail noch den alten Pfad `POST /me/selfhost/verbinden/{code}`. Gemeint ist `POST /me/selfhost/verbinden/entscheidung` mit `aktion = "verbinden"`, so umgesetzt in Task 1.8.
3. **Web-Typen:** `web/src/lib/api/instances.ts` führt `worker_id_*` weiter als `number`, und `ohne_freigabe` fehlt dort. `AdminInstancesActive.svelte:150` zeigt für neue Einträge „Workers: //“. Gehört zu Teil C, Etappe 5 (Admin-Oberfläche).
4. **Widerspruch im Entwurf:** §10 Prüfplan nennt „`self_host_enabled = false` → Bestätigen abgelehnt“. Das widerspricht E8 und dem Vertrag. Umgesetzt ist E8 (`server_verbinden_gesperrt`). Die Zeile im Entwurf sollte in Etappe 6 berichtigt werden.
5. **Größen-Policy:** `routes_instance_applications.py` lag schon vor dieser Etappe über der harten Grenze (524 Zeilen) und wächst um 6. Aufteilen ist hier nicht Thema. Etappe 6 entfernt den `.env`-Download (E11) und damit den größten Block der Datei.
6. **Gesperrte Adresse:** Steht unter einer Adresse ein gesperrter Eintrag, kann dort niemand neu verbinden (`403 instance_suspended`), auch kein neuer, rechtmäßiger Inhaber der Domain. Das ist bewusst so (sonst Sperrumgehung). Der Ausweg führt über den Admin.
7. **Abholen nach `GETDEL`:** Scheitert der Datenbank-Commit nach dem Entnehmen des Vorgangs, ist der Code verbraucht, und der Betreiber muss `pulse-connect` erneut starten. Ein Rückbau wäre aufwendiger als der seltene Fall.
8. **Web muss `instanz_verbunden` noch verarbeiten (Teil C):** Handler neben `instance_status` in `web/src/lib/ws/handlers/instanzen.ts` (Server-Liste neu laden, `hydrateFromBackend` in `web/src/lib/api/servers.svelte.ts:372`), Typ in `web/src/lib/ws/handlers/types.ts` (neben `op: 'instance_status'`, Zeile 444), und Eintrag in der Liste der Hintergrund-Cloud-Verbindung `web/src/lib/ws/dispatch-rules.ts` (neben `'instance_status'`, Zeile 68). Sonst verwirft ein Gerät mit aktivem Self-Host das Ereignis. Bis dahin liefert der chat-gateway das Ereignis aus, und die Oberfläche ignoriert es.
9. **Unbestätigte E-Mail-Adressen** dürfen verbinden (wie beim Serverticket). Die Hinweis-Mail geht dann an eine möglicherweise falsche Adresse.
10. **Remote-Dev-Stack:** Wer Etappe 2 gegen `pulse.unicutmedia.com` testen will, braucht dort Migration 0056 (`scripts/dev-sync.sh --migrate`, `infra/dev-remote/README.md`). Nicht geprüft.
11. **ruff** ist in keinem Gate, und seine isort-Regel widerspricht dem Bestand. Die neuen Dateien folgen dem Stil der Nachbarn, nicht ruff.

### Neue Namen (Teil B)

- **chat-gateway, Modul `dcc_chat_gateway/verbindung.py`:** `NACHWEIS_DATEI = "verbinden-nachweis"`, `VERBINDUNG_DATEI = "verbindung.env"`, `NICHT_VERBUNDEN_HINWEIS` (Wortlaut aus dem Vertrag), `ist_verbunden(settings) -> bool`, `nachweis_lesen(verzeichnis: Path) -> str | None`, `melde_verbindungsstand(settings) -> None`.
- **Route-Modul `routes/verbinden_nachweis.py`:** `router`, `NachweisAus(nachweis: str)`, `verbinden_nachweis()`.
- **`ServerInfo.verbunden: bool = True`** (Vorgabe `True`, damit kein bestehender Aufrufer des Modells bricht).
- **Modul `dcc_chat_gateway/verbinden_texte.py`:** alle englischen Ausgaben von `pulse-connect` (`BEFUNDE`, `BEFUND_UNBEKANNT`, `NACHWEIS_HILFE`, `NUR_SELF_HOST`, `OHNE_ADRESSE`, `AUS_DER_UMGEBUNG`, `SCHON_VERBUNDEN`, `NICHTS_GEAENDERT`, `BEGINN`, `ANLEITUNG`, `CLOUD_WEG`, `ADRESSE_GESPERRT`, `ADRESSE_UNGUELTIG`, `ZU_VIELE`, `UNERWARTET`, `ABGELEHNT`, `ABGELAUFEN`, `VERBUNDEN`, `NEUSTART`, `NEUSTART_VON_HAND`, `ABGEBROCHEN`).
- **`verbinden_cli.py` öffentlich:** `Umgebung`, `verbinden(...)`, `nachweis_aus_kennung`, `lies_verbindung`, `container_neustarten`, `frage_im_terminal`, `HALT`, `HOECHSTENS_S`, `ANFRAGE_FRIST_S`. Nachweis = `hashlib.sha256(kennung.encode("utf-8")).hexdigest()`, Kennung = `secrets.token_urlsafe(32)` — **Teil A muss in `dcc_auth.verbinden.nachweis_aus_kennung` genau so rechnen** (Prüfstein `test_nachweis_wie_ihn_die_cloud_rechnet`). `start` schickt `{"hostname", "kennung"}` (Vertrag, Nachtrag 2), `abholen` `{"kennung"}`; der nachgebaute Cloud-Transport im Test prüft, dass genau diese Felder mitgehen und kein `nachweis` (Gegenprobe gefahren: mit `nachweis` im Körper scheitern 10 Tests).
- **Umgebung `PULSE_VERBINDEN_DIR`** (in `env.sh` aus `${DATA}/pulse`), gelesen von `Settings.pulse_verbinden_dir`.
- **Format `verbindung.env`:** je Zeile `NAME=wert`, ohne Kommentare und Anführungszeichen; Zahlen nur Ziffern; übrige Werte nur `[A-Za-z0-9._@+-]`; `PULSE_ADMIN_EMAIL` nur, wenn die Cloud eine gültige liefert.
- **`09-init-caddy.sh`:** Variable `ENV_SH`.
- **Verzeichnis `/data/pulse`** (`pulse:pulse`, 0700) aus `01-init-data-dirs.sh`.
- **Tests:** `services/chat-gateway/tests/test_verbinden_nachweis_route.py`, `test_start_ohne_verbindung.py`, `test_verbinden_cli.py`; `infra/self-host/tests/test_caddy_wellknown.py`, `test_startpruefung.py`, `test_pulse_connect_huelle.py`.

### Offene Punkte (Teil B)

**Abweichungen vom Vertrag, mit Grund:**
1. **`pulse-connect` verweigert, wenn die Verbindung aus der Umgebung stammt** (Exit 1 mit Anleitung, auch mit `--yes`). Spec E6 sagt „ein erneuter Aufruf … verbindet mit einem anderen Konto“; das gilt hier nur für Server, die über `verbindung.env` verbunden sind. Bei Werten in `.env`/`-e` gewönne die Umgebung vor jeder neuen Datei (`07-render-env.sh`), das Verbinden wäre wirkungslos, und E10 verlangt, dass Bestandsserver nichts bemerken.
2. **`PULSE_INSTANCE_ID` und `PULSE_INSTANCE_OWNER_ID` werden unverbunden als `'0'` gerendert, nicht leer** — pydantic liest `''` nicht als `int`, der chat-gateway stürbe beim Laden der Einstellungen. Der Vertrag nennt die Rechnung `pulse_instance_id != 0`, das passt.
3. **Der Nachweis wird auf jedem Ausgang gelöscht** (Fehler, Ablehnung, Strg+C), nicht nur nach Erfolg.
4. **Neue Namen** `verbindung.py`, `verbinden_texte.py` (Größengrenze: ohne Auslagerung über 380 Zeilen) und `PULSE_VERBINDEN_DIR` (damit Pfad und `PULSE_DATA_PATH` nicht auseinanderlaufen).
5. **429/5xx beim Abholen** gelten als „wartet“ (die 15-Minuten-Frist begrenzt); der Vertrag nennt nur 200/202/403/410.

**An andere Teile:**
6. **Teil C (Etappe 3):** `nicht_verbunden` in `web/src/lib/api/anmelde-fehler-codes.ts` aufnehmen (`ABLEHNUNGSCODES` + `MELDUNGSSCHLUESSEL`); bis dahin zeigt die App für diesen Code den allgemeinen Text. Unschädlich, weil vor Etappe 4 kein Server unverbunden ist.
7. **Teil D (Etappe 4):** Installer ruft `docker exec -it pulse pulse-connect --no-restart </dev/tty`, wertet die Exit-Codes 0/1/2/3 aus und startet danach selbst neu; „schon verbunden“ erkennt er an `"verbunden": true` der Server-Info. Der Hinweistext nennt den Containernamen `pulse` (beide Compose-Dateien setzen `container_name: pulse`). In Etappe 4 nachzuziehen: `infra/self-host/.env.example` ([PFLICHT]-Marken), das `docker run`-Beispiel in `infra/self-host/README.md:70–86`, `docs/self-host-guide.html`; `pulse-doctor` (deutschsprachige Ausgabe) könnte einen Abschnitt „Verbindung“ bekommen.
8. **`desktop/electron/localBackend/containerEnv.ts:127`** („10-check will eine nicht-leere Admin-Mail“) stimmt nach dieser Etappe nicht mehr. Nicht hier geändert: jede Änderung unter `desktop/electron/**` löst Windows/mac-Bauten aus und verlangt die Bump-Frage; beim nächsten Eingriff dort mitnehmen.

**Risiken — was an einem unverbundenen Server noch hart abbrechen könnte:**
9. **Nur gegen Ausschnitte getestet, nicht gegen einen echten Start.** Die Skripttests schneiden Blöcke aus `07`/`09`; ein Fehler außerhalb der Blöcke (etwa ein Backtick im Heredoc-Kommentar von `07`) fiele erst in der Rauchprobe (Task 2.5, Step 6) auf. Sie ist deshalb Pflicht vor dem Freigeben von Etappe 4.
10. **Caddy ohne `email`:** geprüft ist das Entfernen der Zeile, nicht ein echter Caddy-Start mit der so erzeugten Datei; das deckt ebenfalls erst die Rauchprobe ab.
11. **`restart-gate.sh`:** stürzt ein Dienst unverbunden fünfmal in 60 s ab, hält der Container an. Bekannt ist kein solcher Fall (alle Stellen der Tabelle oben sind geprüft), aber nicht jede Zeile des chat-gateway wurde mit `pulse_instance_id == 0` gefahren — nur der Lifespan (Test) und die gelisteten Fundstellen.
12. **`halt` ohne Neustartregel:** wer den Container ohne `--restart unless-stopped` gestartet hat, findet ihn nach `pulse-connect` gestoppt vor. Die Meldung davor sagt nur „Restarting“; `NEUSTART_VON_HAND` greift nur, wenn `halt` selbst scheitert.
13. **`app.py` (530 Zeilen nach dieser Etappe) und `config.py` (464)** bleiben über den Grenzen der Größen-Policy; ein Aufteilen ist eigene Arbeit.
14. **Prüfstein gegen Teil A** (`test_nachweis_wie_ihn_die_cloud_rechnet`) setzt Etappe 1 auf `main` voraus; wird Etappe 2 früher gebaut, scheitert er absichtlich.

### Neue Namen (Teil C)

**Dateien (neu):**
- `web/src/lib/verbinden/code.ts`, `gemerkt.ts`, `fehler.ts`, `VerbindenKarte.svelte`
- `web/src/lib/api/verbinden.ts`
- `web/src/routes/verbinden/+page.svelte`
- `web/src/lib/selfhost/eigeneServer.ts`
- `web/src/lib/components/selfhost/EigenerServerDialog.svelte`, `SelfHostInstallCard.svelte`
- `web/src/lib/components/GuildRailPlusMenu.svelte` (Plus-Menü aus der GuildRail herausgezogen)
- `web/src/lib/components/mobile/RaeumeMenue.svelte` (Menü der Räume herausgezogen)
- Tests: `web/test/verbinden-code.test.ts`, `verbinden-gemerkt.test.ts`, `verbinden-fehler.test.ts`, `eigene-server.test.ts`, `hintergrund-allowlist.test.ts`; `web/tests/e2e/verbinden.spec.ts`, `eigener-server.spec.ts`

**WS-Ereignis (Empfänger, Sender ist Teil A):** `instanz_verbunden` (`{ op: 'instanz_verbunden'; data: { instance_id: string } }`) — Typ in `ws/handlers/types.ts`, Handler in `ws/handlers/instanzen.ts` (→ `serversStore.hydrateFromBackend()`), Eintrag in `PURE_SOCIAL_OPS` (`ws/dispatch-rules.ts`).

**Funktionen, Typen, Konstanten:**
- `code.ts`: `codeNormalisieren`, `codeAusHash`
- `gemerkt.ts`: `SPEICHER_SCHLUESSEL` (`'pulse.verbinden.gemerkt'`), `HALTBARKEIT_MS`, `Speicher`, `verbindungMerken`, `gemerkteVerbindung`, `gemerkteVerbindungVerwerfen`
- `fehler.ts`: `BEFUNDE`, `VerbindenFehler`, `verbindenFehler`, `meldungsSchluessel`
- `api/verbinden.ts`: `Verbindung`, `VerbindenErgebnis`, `holeVerbindung`, `entscheideVerbindung`
- `VerbindenKarte.svelte`: `type VerbindenZustand` (`laden | eingabe | abgemeldet | bereit | verbunden | abgelehnt | unbekannt | fehler`)
- `eigeneServer.ts`: `hatEigeneServer`
- `uiOverlays.eigenerServerOpen`
- `Ablehnungscode` `'nicht_verbunden'`
- `Instance.ohne_freigabe`, `AdminInstance.ohne_freigabe`, `AdminUser.server_verbinden_gesperrt`

**`data-testid`:** `verbinden-karte` (`data-zustand`), `verbinden-host`, `verbinden-code`, `verbinden-warnung`, `verbinden-abbrechen`, `verbinden-bestaetigen`, `verbinden-anmelden`, `verbinden-registrieren`, `verbinden-code-eingabe`, `verbinden-code-weiter`, `verbinden-erneut`, `verbinden-zu-pulse`, `verbinden-hinweis` (`data-fehler`); `guild-eigener-server`, `rooms-eigener-server`, `eigener-server-dialog`, `eigener-server-blatt`, `eigener-server-schliessen`, `eigener-server-rechner`, `eigener-server-gemietet`, `eigener-server-gehostet`, `self-host-install-card`, `self-host-install-command`, `self-host-install-copy`, `self-host-install-guide`, `user-footer-meine-server`, `me-meine-server`; `admin-instance-ohne-freigabe`, `admin-instance-rotate-<id>`, `admin-instance-suspend-<id>`, `toggle-verbinden-btn` (`data-erlaubt="ja"|"nein"`).

**Paraglide-Schlüssel:** `verbinden_*` (35, Task 3.2), `anmeldung_server_nicht_verbunden`, `eigener_server_*` (16), `admin_tab_servers`, `admin_instances_description_frei`, `admin_instances_ohne_freigabe`, `admin_users_darf_verbinden`, `admin_users_verbinden_updated`, `admin_badge_meldungen_aria`. Wiederverwendet statt verdoppelt: `hosting_apply_mode_label`, `hosting_apply_mode_managed_title/_badge/_desc` (Texte decken sich wörtlich mit der Skizze).

**Gelöscht:** siehe **Files** der Tasks 5.1–5.4, darunter `heim-server.spec.ts`, `selfhost-einstieg.spec.ts`, `selfhost-einstieg-gating.test.ts`, `ComposeDownloadLinks.svelte` (nur von `SetupManuell` benutzt; Compose-Weg steht in der Anleitung, Teil D).

### Offene Punkte (Teil C)

1. **Code im Pfad — erledigt durch Vertrag „Nachtrag 2“.** `api/verbinden.ts` ruft `POST …/vorgang` und `POST …/entscheidung` mit dem Code im Körper; die Attrappe in `verbinden.spec.ts` prüft bei jeder Anfrage, dass der Code dort steht. Teil A muss die beiden Routen genau so benennen; ein Abweichen fiele erst im Betrieb auf (die Playwright-Tests täuschen die Cloud vor) — deshalb Task 3.2 Step 15 (echter Browser gegen den lokalen Stack mit Etappe 1) nicht überspringen.
2. **Neuer Server auf schon offenen Geräten — erledigt** (Task 5.3): Teil A sendet nach dem Abholen `instanz_verbunden` an den Besitzer, `handlers/instanzen.ts` ruft `serversStore.hydrateFromBackend()`, der Eintrag in `PURE_SOCIAL_OPS` lässt es auch bei aktivem Self-Host durch (Test im Gate: `hintergrund-allowlist.test.ts`). Die 8-s-Nachfrage der Bestätigungsseite bleibt für deren eigenen Tab, der keine WebSocket hat. Ein Laufzeit-Test des Ereignisses fehlt; Abnahme von Hand (Task 5.6 Step 3).
3. **Installationsbefehl nennt immer `CLOUD_HOSTNAME`** statt der Herkunft der Seite (Abweichung vom Vertrag „`<origin>`“). Grund: Self-Host-Images liefern dieselbe Web-App, aber kein `/install`. Folge: Auf dem Remote-Dev-Stack zeigt der Dialog den Prod-Installer. Falls Teil D einen Dev-Installer braucht, bekäme `SelfHostInstallCard` eine Ausnahme für den Dev-Host.
4. **Prüfplan §10 des Entwurfs — erledigt:** im Entwurf berichtigt (Commit `1a67cd01`), maßgeblich ist `server_verbinden_gesperrt`. Die Oberfläche schaltet `self_host_enabled` nicht mehr; wer es für den Server-App-Weg braucht, setzt es per SQL.
5. **Unbestätigte E-Mail auf `/verbinden`.** Die Seite fragt die Cloud auch für Konten mit `email_verification_pending`; ob `_require_user` das zulässt, entscheidet Teil A. Über Registrieren mit aktivem E-Mail-Riegel kommt man erst nach der Bestätigung zurück — der Code (15 min) ist dann oft abgelaufen; die Seite zeigt „Dieser Code gilt nicht mehr“ mit dem `pulse-connect`-Handgriff.
6. **Heim-Server mit alter Freischaltung** verlieren im Admin-Bereich „Freischaltung zurücknehmen“; „Sperren“ ersetzt es. Die Route `/admin/app-host-applications/{id}/revoke` ist danach im Web unbenutzt — Etappe 6 (Teil D) kann sie mit den Antrags-Routen entfernen.
7. **Liegengebliebene Speicher-Schlüssel** `pulse.instanceSetupAck` und `pulse.instanceAppNotified` (aus `myInstanceApplications`) bleiben in bestehenden Browsern stehen. Harmlos, ungenutzt; kein Aufräumcode geplant.
8. **Frühes Wegnavigieren aus `/app`.** Die Startseite springt zum gemerkten Code, während das Layout gerade die Service-Worker-Registrierung abwartet (`+layout.svelte`, heute Zeile 317); danach gesetzte Handler (`_swMessageHandler`, `notifyApi.onClick`) werden nicht mehr abgebaut. Bestehende Fehlerklasse (trifft jeden frühen Wegsprung), durch Teil C nur häufiger erreicht; betrifft nur den Registrierungs-Rückweg.
9. **CLAUDE.md und Doku** (`/app/server` als „Self-Host-Bereich“, Server-Knopf, Antragsbeobachtung) zieht Etappe 6 (Teil D) nach; Teil C fasst sie nicht an.

### Neue Namen (Teil D)

| Name | Wo | Bedeutung |
|---|---|---|
| `frage_adresse`, `pruefe_adresse` | `web/static/install.sh` | Adresse aus `PULSE_HOSTNAME`/Argument/Terminal; Normalform wie `normalisiere_hostname` |
| `zugang_lesen` | `web/static/install.sh` | liest `PULSE_INSTANCE_ID`, `PULSE_CLOUD_CLIENT_ID`, `PULSE_CLOUD_CLIENT_SECRET` aus `KEY=wert`-Zeilen (stdin) |
| `bestand_uebernehmen` | `web/static/install.sh` | übernimmt die Verbindungszeilen einer alten `pulse.env` derselben Adresse |
| `pruefe_registry_zugang` | `web/static/install.sh` | `registry.howispulse.com/*` nur mit Bestands-Zugang, sonst Abbruch vor jeder Änderung |
| `schreibe_konfiguration` | `web/static/install.sh` | schreibt `pulse.env` (chmod 600) |
| `warte_auf_start` | `web/static/install.sh` | Startfortschritt aus `/data/setup-status`, zweimal benutzt |
| `server_info_innen`, `server_info_aussen`, `ist_verbunden` | `web/static/install.sh` | `pulse-server-info` im Container bzw. über die Adresse; `verbunden` (Rückfall: gesetzte `instance_id`) |
| `server_verbinden`, `verbinden_spaeter` | `web/static/install.sh` | ruft `pulse-connect --no-restart` mit Terminal, startet neu; sonst Hinweis `Connect later: …` |
| `zugang_aus_volumen` | `web/static/install.sh` | Zugangsdaten für die Prüfung aus der Cloud: Bestand aus `pulse.env`, sonst `/data/pulse/verbindung.env` |
| `TTY_GERAET` / `PULSE_TTY` | `web/static/install.sh` | Terminal für Eingaben (Vorgabe `/dev/tty`; Tests setzen eine Datei) |
| `PULSE_INSTALL_WARTE_VERSUCHE`, `PULSE_INSTALL_WARTE_INTERVALL` | `web/static/install.sh` | Wiederholungen der Server-Info-Abrufe (Vorgabe 20 × 3 s; Tests 1 × 0) |
| `ALTER_TOKEN`, `BESTAND_ZEILEN`, `VERBUNDEN` | `web/static/install.sh` | interne Variablen |
| Meldungen `Nothing has been changed yet.`, `Connect later: docker exec -it <c> pulse-connect`, `This server is already connected to a Pulse account.`, `Setup tokens are no longer needed — ignoring the token.` | Installer-Ausgabe | englisch für Betreiber |
| `web/test/install-ohne-token.test.ts`, `install-bestand.test.ts`, `install-verbinden.test.ts` | Web-Unit-Tests | neu; `install-jget.test.ts` entfällt |
| `pruefe_login`, `IMAGE_NAME`, `LOGIN_MARKER` | `infra/self-host/tests/pulse-update-faelle.sh` | Anmelde-Fälle des Compose-Updaters |
| `_seed_instance` | `services/auth/tests/test_admin_instances.py` | legt eine Bestands-Instanz direkt an |
| `test_antrag_und_env_download_sind_entfernt`, `test_antrags_verwaltung_ist_entfernt`, `test_set_up_bleibt_fuer_bestand_mit_env_download`, `test_betreiber_texte_zeigen_auf_pulse_connect` | auth-Tests | Riegel für Etappe 6 |

Entfallen: `jget`, `TOKEN`, Pflicht von `PULSE_BOOTSTRAP_TOKEN` (wird nur noch erkannt und ignoriert), `routes_applications.py`, `routes_admin_applications.py`, `instance_env_file.py`, `_require_self_host_enabled`, `_allocate_worker_ids`, `publish_application_pending`, `publish_application_decided`, `ApplicationDecidedEvent`.

### Offene Punkte (Teil D)

1. **`pulse-connect` auf einem Bestandsserver (Teil B).** Kommen `PULSE_INSTANCE_ID` und Zugangsdaten aus der Umgebung, wäre ein Verbinden wirkungslos (die Umgebung gewinnt), die Cloud hätte aber den Bestandseintrag soft-gelöscht (der Nachweis gelingt ja), und der Server liefe mit einer gesperrten Nummer weiter (4070). Teil B lässt `pulse-connect` in diesem Fall mit Exit 1 und Anleitung abbrechen (auch mit `--yes`). Der Installer ruft es dort ohnehin nie (Server-Info meldet `verbunden: true`); die Handgriffe in Task 6.3 und in der Anleitung nennen `pulse-connect` zuerst und die `.env` als Ausnahme. Vor dem Landen von Etappe 4 prüfen, dass Etappe 2 so gelandet ist.
2. **Format von `verbindung.env` (Teil B).** Teil B schreibt `NAME=wert` je Zeile, ohne Anführungszeichen — das liest `zugang_lesen`. Ändert sich das Format, schlägt nur die Prüfung aus der Cloud fehl (der Installer warnt und verweist auf `pulse-doctor`).
3. **Meldungstext in `10-check-cloud-creds.sh` (Teil B).** Die heutige Meldung verweist auf „https://howispulse.com/self-host/guide → step 1, "Download the .env"“. Teil B ersetzt die Datei vollständig; beim Landen von Etappe 4 prüfen, dass der neue Text nicht mehr auf diesen Schritt verweist (`grep -n "Download the .env" infra/self-host/s6/etc/s6-overlay/scripts/10-check-cloud-creds.sh` → keine Ausgabe).
4. **Englische Bezeichnung „My servers“ (Teil C).** Teil C legt `eigener_server_meine_server` mit „Meine Server“/„My servers“ an; Task 6.3 benutzt genau diese Wörter. Ändert Teil C sie noch, Task 6.3 angleichen.
5. **Adressform (Teil A).** `pruefe_adresse` benutzt denselben regulären Ausdruck wie `_FQDN_RE` in Teil A (`dcc_shared/hostname.py`) und dieselben Schritte (Leerraum weg, Kleinbuchstaben, Schema/Port/Pfad weg, abschließender Punkt weg); Task 4.1 Step 6 prüft das gegen den gelandeten Code. Zwei Randfälle bleiben verschieden, beide zur sicheren Seite: mehrere Punkte am Ende und `nutzer@adresse` lehnt der Installer ab, die Cloud nicht. IDN-Adressen (Umlaut-Domains) nehmen beide nur in Punycode (`xn--…`) an.
6. **TURN-Relay-Ports im Installer.** Die Compose-Dateien veröffentlichen `49160-49200/udp` (Bughunt 2026-09-20), `build_run_args` im Installer nicht, und `check_ports` prüft sie nicht. Lag schon vorher so; eigener Fix, nicht Teil dieses Plans.
7. **Server-App-Texte.** `desktop/electron/server.html:114` („Token aus „Meine Instanzen““), `desktop/electron/server.js:562` und `desktop/electron/serverProvision.ts:378` verweisen auf „Meine Instanzen“; das Token-Feld der Server-App setzt einen in der App erzeugten Bootstrap-Token voraus, den es nach Etappe 5 nicht mehr gibt (die Server-App holt ihn selbst, das Feld ist nur Rückfall). Änderungen an `desktop/electron/**` erreichen Windows-Nutzer nur mit Versionssprung — beim nächsten ohnehin fälligen Server-App-Release mitziehen, keinen eigenen Sprung dafür.
8. **`check-changelog.sh` kennt `web/test/` nicht.** Testdateien dort lösen die Changelog-Warnung aus. Harmlos; ein Eintrag `^web/test/` in `NON_USER_FACING` wäre eine eigene Kleinigkeit.
9. **`stable` = `edge`** (Spec §8): Jeder `main`-Push erreicht ab Etappe 4 binnen Minuten auch fremde Server mit Auto-Update. Organisation mit Zwei-Faktor-Pflicht (Etappe 0) ist die einzige Sicherung davor.
10. **Repo-Sichtbarkeit.** `infra/prod/DEPLOY.md` behauptet, ein mit einem privaten Repo verknüpftes Paket könne nicht öffentlich sein. Task 4.4 Step 1 hält an, wenn das Repo privat ist.
11. **`admin:events` ohne Absender.** Nach Task 6.1 veröffentlicht niemand mehr auf `admin:events`; der Weiterleiter im chat-gateway bleibt als allgemeiner Mechanismus stehen.
12. **Probe-Konten und Probe-Adresse.** Task 4.4 braucht zwei Test-Konten und eine eigene Domain außerhalb von `howispulse.com`; welche, entscheidet der Eigentümer.
13. **`pulse-doctor` ohne Abschnitt „Verbindung“.** Teil B regt an, dass `pulse-doctor` zeigt, ob der Server verbunden ist. Nicht Teil dieses Plans; der Installer und die Server-Info (`verbunden`) decken es ab.
