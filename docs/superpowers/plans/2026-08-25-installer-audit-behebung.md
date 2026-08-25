# Installer-Audit: Behebung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Self-Host-Installation geht sauber durch, ordnet alles richtig zu, und kein Schritt meldet Erfolg, ohne seine Wirkung geprüft zu haben.

**Architecture:** Vier Phasen, jede für sich lieferbar und landbar. Phase A repariert, was einen laufenden Server zerstört; B, was still nicht funktioniert; C, was falsch informiert; D die Anleitung. Jede Änderung an Shell-Code bekommt einen Test, der die Funktion aus dem Original **herausschneidet** und gegen gefälschte Kommandos fährt — das Muster steht bereits in `web/test/install-proxy-erkennung.test.ts`.

**Tech Stack:** bash (install.sh, cont-init), Python 3.13/pytest (Cloud + neue Container-Tests), Node-Testläufer (Installer-Tests, kein Vitest).

**Spec:** `docs/superpowers/plans/2026-08-25-installer-audit-bericht.md` (Befundbericht, siehe Artefakt) — die Befund-Nummern I·1 … IV stammen von dort.

## Global Constraints

- **Kein Fix ohne vorher roten Test.** Wer den Test nicht hat fallen sehen, weiss nicht, ob er das Richtige prüft.
- **Ein Fix pro Commit.** Kein „while I'm here".
- **Prüfstände brauchen einen Wächter.** Jeder Testaufbau, der Funktionen aus einer Datei schneidet, muss laut scheitern, wenn er nichts findet — sonst ist ein leerer Lauf grün. (Beim Bauen dieses Plans zweimal passiert.)
- **Deutsche Kommentare, englische Nutzerausgabe** im Installer (bestehende Konvention, `install.sh:12-13`).
- **Keine Emojis**, echte Umlaute in Commit-Messages.
- **Kein `Co-Authored-By`-Footer.**
- Test-Gate vor dem Push: `REDIS_URL=redis://127.0.0.1:6380/1 uv run --all-packages pytest -q`, `cd web && pnpm check && pnpm test:unit`.

---

## Vorarbeit: Ein Zuhause für Shell-Tests

Für `infra/self-host/s6/**` gibt es heute **keinen** Testort. Ohne den kann Phase B nicht nach TDD arbeiten.

### Task 0: Testverzeichnis für die Container-Skripte

**Files:**
- Create: `infra/self-host/tests/__init__.py` (leer)
- Create: `infra/self-host/tests/conftest.py`
- Modify: `pyproject.toml:37-44` (testpaths)

**Interfaces:**
- Produces: pytest-Fixture `skript_funktion(datei: str, name: str) -> str` — schneidet eine Shell-Funktion aus einem Skript und gibt ihren Quelltext zurück; wirft, wenn sie fehlt.

- [ ] **Step 1: Testverzeichnis anlegen und in testpaths eintragen**

`pyproject.toml`, testpaths um eine Zeile ergänzen:

```toml
testpaths = [
    "shared/tests",
    "services/auth/tests",
    "services/chat-gateway/tests",
    "services/voice-signaling/tests",
    "services/media-svc/tests",
    "services/mediamtx-auth-hook/tests",
    "infra/self-host/tests",
]
```

- [ ] **Step 2: conftest.py mit dem Schneide-Helfer**

`infra/self-host/tests/conftest.py`:

```python
"""Testwerkzeug für die Shell-Skripte des Self-Host-Containers.

Die cont-init-Skripte laufen im Container von oben nach unten durch; sourcen
geht deshalb nicht. Stattdessen wird die zu prüfende Funktion herausgeschnitten
und einzeln gefahren.
"""

from __future__ import annotations

import pathlib
import subprocess

import pytest

S6 = pathlib.Path(__file__).resolve().parents[1] / "s6"


def _schneide(quelle: str, name: str) -> str:
    zeilen = quelle.split("\n")
    start = next(
        (i for i, z in enumerate(zeilen) if z.startswith(f"{name}() ") or z.startswith(f"{name}()")),
        None,
    )
    assert start is not None, f"Funktion {name}() nicht gefunden — Skript umgebaut?"
    ende = next((i for i, z in enumerate(zeilen) if i > start and z == "}"), None)
    assert ende is not None, f"kein Ende fuer {name}()"
    return "\n".join(zeilen[start : ende + 1])


@pytest.fixture
def skript_funktion():
    """Gibt den Quelltext einer Shell-Funktion aus einem Skript unter s6/ zurück."""

    def hole(pfad: str, name: str) -> str:
        datei = S6 / pfad
        assert datei.is_file(), f"{datei} fehlt"
        return _schneide(datei.read_text(encoding="utf-8"), name)

    return hole


@pytest.fixture
def bash_lauf(tmp_path):
    """Führt ein bash-Skript mit einem PATH aus, auf dem gefälschte Kommandos liegen."""

    def lauf(skript: str, faelschungen: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        binde = tmp_path / "bin"
        binde.mkdir(exist_ok=True)
        for name, inhalt in (faelschungen or {}).items():
            ziel = binde / name
            ziel.write_text(inhalt, encoding="utf-8")
            ziel.chmod(0o755)
        import os

        umgebung = {**os.environ, "PATH": f"{binde}:{os.environ['PATH']}"}
        return subprocess.run(
            ["bash", "-c", skript], capture_output=True, text=True, env=umgebung
        )

    return lauf
```

- [ ] **Step 3: Wächter-Test, der beweist, dass das Werkzeug greift**

`infra/self-host/tests/test_werkzeug.py`:

```python
"""Ohne diesen Test wäre ein kaputtes Schneidewerkzeug wortlos grün."""


def test_schneidet_eine_bekannte_funktion(skript_funktion):
    quelle = skript_funktion("etc/s6-overlay/scripts/03-init-secrets.sh", "write_if_missing")
    assert "write_if_missing()" in quelle
    assert quelle.rstrip().endswith("}")


def test_meldet_eine_fehlende_funktion(skript_funktion):
    import pytest

    with pytest.raises(AssertionError, match="nicht gefunden"):
        skript_funktion("etc/s6-overlay/scripts/03-init-secrets.sh", "gibt_es_nicht")


def test_bash_lauf_nutzt_die_faelschung(bash_lauf):
    ergebnis = bash_lauf('docker ps', {"docker": '#!/bin/bash\necho GEFAELSCHT\n'})
    assert ergebnis.stdout.strip() == "GEFAELSCHT"
```

- [ ] **Step 4: Lauf**

Run: `REDIS_URL=redis://127.0.0.1:6380/1 uv run --all-packages pytest infra/self-host/tests -q`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml infra/self-host/tests
git commit -m "test(self-host): ein Zuhause fuer die Shell-Skripte des Containers

Die cont-init-Skripte hatten bisher keinen Testort. Ohne den laesst sich an
ihnen nicht nach TDD arbeiten — und genau dort sass der still kaputte
provided-Modus."
```

---

## Phase A — Was einen laufenden Server zerstört

### Task 1: Der zweite Lauf darf einen greenfield-Server nicht herunterstufen (I·1)

**Files:**
- Modify: `web/static/install.sh` (`detect_proxy`, `decide_mode`)
- Test: `web/test/install-eigener-container.test.ts` (neu)

**Interfaces:**
- Consumes: das Schneide-Muster aus `web/test/install-proxy-erkennung.test.ts` (Funktion `funktion(quelle, name)`).
- Produces: Shell-Funktion `ist_eigener_container(name) -> 0/1` in `install.sh`.

- [ ] **Step 1: Failing test**

`web/test/install-eigener-container.test.ts` — Aufbau wie `install-proxy-erkennung.test.ts` (dort abschauen: `funktion()`, gefälschtes `docker` mit `%b`-printf, Wächter-Assertions). Kern:

```typescript
test('ein zweiter Lauf laesst einen greenfield-Server greenfield', () => {
  // Pulses EIGENER Container laeuft und haelt 80/443.
  const ergebnis = entscheide({
    container: [{ name: 'pulse', image: 'registry.howispulse.com/pulse-allinone:edge', publiziert: true }],
    portBelegt: true
  });
  assert.equal(ergebnis.mode, 'greenfield');
});

test('ein hostproxy-Server hinter host-nativem Proxy bleibt hostproxy', () => {
  // Der eigene Container laeuft, veroeffentlicht 80/443 aber NICHT — die Ports
  // gehoeren einem Proxy ausserhalb von Docker, den `docker ps` nie sieht.
  const ergebnis = entscheide({
    container: [{ name: 'pulse', image: 'registry.howispulse.com/pulse-allinone:edge', publiziert: false }],
    portBelegt: true
  });
  assert.equal(ergebnis.mode, 'hostproxy');
});

test('ein FREMDER Proxy auf 80/443 fuehrt weiterhin zu hostproxy', () => {
  // Gegenprobe — sonst bestuende der Test auch, wenn die Erkennung tot waere.
  const ergebnis = entscheide({
    container: [{ name: 'nginx-vom-nachbarn', image: 'nginx:1.27', publiziert: true }],
    portBelegt: true
  });
  assert.notEqual(ergebnis.mode, 'greenfield');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && node --test test/install-eigener-container.test.ts`
Expected: FAIL — erster Test liefert `hostproxy` statt `greenfield`

- [ ] **Step 3: Implementierung**

In `install.sh`, direkt nach `publishes_web_port`:

```bash
# --- Helfer: ist das unser eigener, laufender Container? ----------------- #
#
# Ohne diese Frage stuft sich der Installer beim ZWEITEN Lauf selbst herunter:
# im greenfield-Modus haelt Pulse 80 und 443, das Image passt auf kein
# Proxy-Muster, und der Zweig `none` schliesst daraus auf einen fremden
# Reverse-Proxy. Ergebnis: TLS kippt auf behind-proxy, ACME stellt ein, der
# Server verschwindet aus dem Internet — waehrend der Container laeuft und die
# Checkliste gruen ist. `check_ports` kennt diese Ausnahme laengst (s. dort);
# nur die Moduswahl kannte sie nicht.
eigener_container_laeuft() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}
```

In `decide_mode`, den `none`-Zweig ersetzen:

```bash
    none)
      # Haelt unser eigener laufender Container die Ports 80/443, ist das KEIN
      # fremder Proxy — dann bleibt es greenfield.
      #
      # Die zweite Bedingung ist nicht schmueckendes Beiwerk: im Modus hostproxy
      # laeuft unser Container ebenfalls, bindet aber nur `127.0.0.1:8080`. Ohne
      # sie wuerde ein Server hinter einem host-nativen Proxy beim zweiten Lauf
      # auf greenfield hochgestuft, `docker run -p 80:80` scheiterte an den
      # fremd belegten Ports — und zwar NACH `docker rm -f`. Also derselbe
      # Schaden wie der Fehler oben, nur in der anderen Richtung.
      #
      # Dieselbe Beweisregel wie bei der Proxy-Erkennung: der Name ist kein
      # Beweis, die Portveroeffentlichung schon.
      if eigener_container_laeuft && publishes_web_port "$CONTAINER"; then
        MODE=greenfield
      elif port_busy 80 || port_busy 443; then
        MODE=hostproxy
      else
        MODE=greenfield
      fi ;;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && node --test test/install-eigener-container.test.ts`
Expected: PASS (beide)

- [ ] **Step 5: Commit**

```bash
git add web/static/install.sh web/test/install-eigener-container.test.ts
git commit -m "fix(self-host): ein zweiter Installer-Lauf nahm einen laufenden Server vom Netz"
```

### Task 2: Der Updater darf einen abstürzenden Container nicht für Erfolg halten (I·2)

**Files:**
- Modify: `web/static/install.sh` (`write_update_script`, der erzeugte Updater)
- Test: `web/test/install-updater.test.ts` (neu)

**Interfaces:**
- Consumes: `funktion()` aus dem bestehenden Testmuster.
- Produces: Shell-Funktion `container_laeuft_stabil()` im erzeugten Updater.

- [ ] **Step 1: Failing test**

```typescript
test('ein Container, der sofort stirbt, gilt NICHT als erfolgreicher Start', () => {
  // `docker run -d` liefert 0, sobald der Container erzeugt ist — nicht wenn
  // er laeuft. Genau daran haengt, ob die Rollback-Kopie geloescht wird.
  const ergebnis = starteMitStub({ runRc: 0, stateRunning: false });
  assert.equal(ergebnis.alsErfolgGewertet, false);
});

test('ein laufender Container gilt als Erfolg', () => {
  const ergebnis = starteMitStub({ runRc: 0, stateRunning: true });
  assert.equal(ergebnis.alsErfolgGewertet, true);
});
```

- [ ] **Step 2: Run — Expected: FAIL** (erster Test meldet `true`)

- [ ] **Step 3: Implementierung** — im erzeugten Updater vor dem Löschen von `-old` und dem alten Image:

```bash
# `docker run -d` sagt nur, dass der Container ERZEUGT wurde. Ein Image, das
# startet und sofort stirbt, gilt sonst als Erfolg — und der Updater loescht
# daraufhin die Rollback-Kopie UND das letzte funktionierende Image. Da der
# Tag rollt, ist die Vorversion danach nicht mehr adressierbar.
container_laeuft_stabil() {
  local i
  for i in $(seq 1 15); do
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ] || return 1
    sleep 1
  done
  return 0
}
```

Aufruf: `if docker run "${RUN_ARGS[@]}" && container_laeuft_stabil "$CONTAINER"; then …`

- [ ] **Step 4: Run — Expected: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(self-host): der Updater hielt einen abstuerzenden Container fuer erfolgreich"
```

### Task 3: Leere crontab darf den Installer nicht töten (I·3)

**Files:**
- Modify: `web/static/install.sh:435-439` (`install_update_cron`)
- Test: `web/test/install-crontab.test.ts` (neu)

- [ ] **Step 1: Failing test**

```typescript
test('erste Installation ohne bestehende crontab schreibt den Eintrag', () => {
  const ergebnis = installiereCron({ crontabLeer: true });
  assert.equal(ergebnis.exit, 0);
  assert.match(ergebnis.installiert, /pulse-update\.sh/);
});

test('ein bestehender Fremdeintrag bleibt erhalten', () => {
  const ergebnis = installiereCron({ crontabLeer: false, fremd: '0 3 * * * /usr/bin/fremd' });
  assert.match(ergebnis.installiert, /\/usr\/bin\/fremd/);
  assert.match(ergebnis.installiert, /pulse-update\.sh/);
});
```

- [ ] **Step 2: Run — Expected: FAIL** (erster Test: exit 1, installiert leer)

- [ ] **Step 3: Implementierung** — ein `|| true` in die Gruppe:

```bash
  # `grep -vF` endet mit 1, wenn die crontab leer ist. Unter `pipefail` +
  # `set -e` beendet das die Gruppe, BEVOR der neue Eintrag geschrieben wird:
  # die crontab wird leer installiert und der Installer stirbt wortlos — nach
  # dem Container-Start und vor der Routen-Anweisung.
  { crontab -l 2>/dev/null | grep -vF "$UPDATE_SH" || true; echo "$entry"; } | crontab -
```

- [ ] **Step 4: Run — Expected: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(self-host): leere crontab toetete den Installer vor der Routen-Anweisung"
```

### Task 4: Fremden Container nicht zerstören, tote Container nicht als Portschutz werten (I·4, H5)

**Files:**
- Modify: `web/static/install.sh:109` (`check_ports`), `:512` (`docker rm -f`)
- Test: `web/test/install-fremder-container.test.ts` (neu)

- [ ] **Step 1: Failing test**

```typescript
test('ein fremder Container namens pulse wird nicht angeruehrt', () => {
  const ergebnis = pruefeUebernahme({ image: 'postgres:16' });
  assert.equal(ergebnis.abgebrochen, true);
  assert.match(ergebnis.meldung, /PULSE_CONTAINER/);
});

test('unser eigener Container wird uebernommen', () => {
  const ergebnis = pruefeUebernahme({ image: 'registry.howispulse.com/pulse-allinone:edge' });
  assert.equal(ergebnis.abgebrochen, false);
});

test('ein GESTOPPTER eigener Container schaltet die Portpruefung nicht ab', () => {
  // `docker inspect` gelingt auch fuer exited-Container, die keinen Port halten.
  assert.equal(portpruefungLaeuft({ running: false }), true);
});
```

- [ ] **Step 2: Run — Expected: FAIL** (alle drei)

- [ ] **Step 3: Implementierung**

```bash
# Vor dem Ersetzen pruefen, dass das WIRKLICH unser Container ist. `docker rm -f`
# fragt nicht nach; ein fremder Container, der zufaellig `pulse` heisst, waere
# ohne Rueckfrage weg.
ist_unser_container() {
  case "$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)" in
    *pulse-allinone*) return 0 ;;
    *) return 1 ;;
  esac
}
```

`check_ports`: nur überspringen, wenn der eigene Container **läuft**:

```bash
  eigener_container_laeuft && return 0
```

- [ ] **Step 4: Run — Expected: PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(self-host): fremder Container namens pulse wurde kommentarlos zerstoert"
```

### Task 5: Phase A landen

- [ ] **Step 1: Volles Gate**

```bash
REDIS_URL=redis://127.0.0.1:6380/1 uv run --all-packages pytest -q
cd web && pnpm check && pnpm test:unit && cd ..
```

- [ ] **Step 2: Changelog-Eintrag** — user-facing, Self-Hoster bemerken es. In `web/static/changelog.json` oben ergänzen (Stil „Sachlich", keine Emojis, echte Umlaute).

- [ ] **Step 3: `bash scripts/ship.sh`**, danach Merge wie bisher (Branch-Schutz verlangt Admin-Merge).

---

## Phase B — Was still nicht funktioniert

### Task 6: Mehrdeutiges Proxy-Netz nicht mehr auswürfeln (der crewconnect-Fehler; enthält II·5)

**Files:**
- Modify: `web/static/install.sh:131-134` (`first_user_network`), `decide_mode`
- Test: `web/test/install-proxy-erkennung.test.ts` (erweitern)

- [ ] **Step 1: Failing test**

```typescript
test('bei mehreren Netzen wird nicht geraten, sondern abgebrochen', () => {
  const ergebnis = erkenneNetz(['crewconnect-net', 'cs-trading-net', 'pulse-selfhost-net']);
  assert.equal(ergebnis.abgebrochen, true);
  assert.match(ergebnis.meldung, /PULSE_NETWORK/);
  // Alle Kandidaten muessen genannt werden, sonst kann niemand waehlen.
  for (const n of ['crewconnect-net', 'cs-trading-net', 'pulse-selfhost-net']) {
    assert.match(ergebnis.meldung, new RegExp(n));
  }
});

test('bei genau einem Netz wird es genommen', () => {
  assert.equal(erkenneNetz(['nur-eins']).netz, 'nur-eins');
});

test('bei keinem Netz stirbt das Skript nicht wortlos', () => {
  // `grep -v` ohne Treffer endet mit 1; unter pipefail toetete das den Lauf,
  // und die eigens dafuer geschriebene Warnung war toter Code.
  const ergebnis = erkenneNetz([]);
  assert.equal(ergebnis.exit, 0);
  assert.equal(ergebnis.netz, '');
});
```

- [ ] **Step 2: Run — Expected: FAIL** (erster liefert `crewconnect-net`, dritter Exit 1)

- [ ] **Step 3: Implementierung** — `first_user_network` wird zu `proxy_netze` (Liste), `_set_proxy` bricht bei Mehrdeutigkeit ab:

```bash
# Alle Nutzer-Netze eines Containers, eines je Zeile. `|| true`, weil "keine
# Treffer" ein normaler Zustand ist und `grep`s Exit 1 unter `pipefail` sonst
# den ganzen Lauf beendet — samt der Warnung, die genau fuer diesen Fall
# geschrieben wurde und deshalb nie erschien.
proxy_netze() {
  docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" 2>/dev/null \
    | grep -vE '^(host|none|bridge)$' | grep -v '^$' || true
}
```

In `_set_proxy`: mehr als ein Netz → `die` mit Auflistung und Hinweis auf `PULSE_NETWORK`. **Go-Templates geben Map-Schlüssel alphabetisch aus — „das erste" ist reiner Zufall und hat auf einer Produktivmaschine dazu geführt, dass Pulse im Netz eines fremden Projekts landete.**

- [ ] **Step 4: Run — Expected: PASS**
- [ ] **Step 5: Commit**

### Task 7: Der `provided`-TLS-Modus muss das Zertifikat wirklich eintragen (II·2)

**Files:**
- Modify: `infra/self-host/s6/etc/s6-overlay/scripts/09-init-caddy.sh:43`
- Test: `infra/self-host/tests/test_caddy_tls_modi.py` (neu)

- [ ] **Step 1: Failing test**

```python
"""Der provided-Modus fuegte das Zertifikat nie ein — still, mit Exit 0.

Ein Backslash zu viel: bash loeste `\\$PULSE_HOSTNAME` zum WERT auf, gesucht
wurde also der aufgeloeste Hostname, waehrend im Template Caddys eigener
Platzhalter steht. Das Skript meldete trotzdem "Verwende bereitgestelltes Cert",
und `pulse-doctor` prueft an dieser Stelle die Dateien auf der Platte statt der
Caddy-Konfiguration — also genau das, was der Fehler trennt.
"""

import shutil


import pathlib
import subprocess

S6 = pathlib.Path(__file__).resolve().parents[1] / "s6"
TEMPLATE = S6 / "etc/caddy/Caddyfile.template"


def _fahre_zweig(tmp_path: pathlib.Path, fragment: str, **umgebung: str) -> str:
    """Kopiert das echte Template und laesst ein Skript-Fragment darauf los."""
    ziel = tmp_path / "Caddyfile"
    shutil.copy(TEMPLATE, ziel)
    vorspann = "\n".join(f'{k}="{v}"' for k, v in umgebung.items())
    subprocess.run(
        ["bash", "-c", f'set -eu\nTARGET="{ziel}"\n{vorspann}\n{fragment}'],
        check=True, capture_output=True, text=True,
    )
    return ziel.read_text(encoding="utf-8")


def test_provided_traegt_die_tls_zeile_ein(tmp_path):
    fragment = (
        'TLS_LINE="    tls ${CERT} ${KEY}"\n'
        # HIER die Zeile aus 09-init-caddy.sh einsetzen, unveraendert.
        'sed -i "/{[\\$]PULSE_HOSTNAME} {/a\\\n${TLS_LINE}" "$TARGET"'
    )
    inhalt = _fahre_zweig(
        tmp_path, fragment,
        PULSE_HOSTNAME="chat.firma.de",
        CERT="/data/certs/cert.pem", KEY="/data/certs/key.pem",
    )
    assert "tls /data/certs/cert.pem /data/certs/key.pem" in inhalt


def test_behind_proxy_schreibt_die_site_adresse_um(tmp_path):
    """Gegenprobe: der Schwesterzweig funktionierte und muss es bleiben."""
    fragment = 'sed -i "s|{[\\$]PULSE_HOSTNAME} {|:${HTTP_PORT} {|" "$TARGET"'
    inhalt = _fahre_zweig(tmp_path, fragment, PULSE_HOSTNAME="chat.firma.de", HTTP_PORT="8080")
    assert ":8080 {" in inhalt
```

- [ ] **Step 2: Run — Expected: FAIL** (`tls`-Zeile fehlt, Datei byteidentisch)

- [ ] **Step 3: Implementierung** — Escaping korrigieren **und** Nachkontrolle ergänzen, wie sie der `behind-proxy`-Zweig schon hat:

```bash
    sed -i "/{[\$]PULSE_HOSTNAME} {/a\\
${TLS_LINE}" "$TARGET"
    if ! grep -qF "$CERT" "$TARGET"; then
        echo "[07-init-caddy] FEHLER: TLS-Zeile konnte nicht eingefuegt werden." >&2
        exit 1
    fi
```

- [ ] **Step 4: Run — Expected: PASS (beide)**
- [ ] **Step 5: Commit**

### Task 8: Traefik-Router-Namen dürfen keine Punkte enthalten (II·3)

**Files:**
- Modify: `web/static/install.sh:248`
- Test: `web/test/install-traefik-label.test.ts` (neu)

- [ ] **Step 1: Failing test**

```typescript
test('der Router-Name enthaelt keine Punkte', () => {
  // Traefik zerlegt Label-Schluessel an Punkten und verwirft daraufhin die
  // KOMPLETTE Konfiguration des Containers — nicht nur ein Label.
  const labels = baueLabels('chat.example.com');
  const router = labels.find(l => l.startsWith('traefik.http.routers.'));
  const name = router.split('.')[3];
  assert.equal(name.includes('.'), false);
  assert.equal(name, 'pulse-chat-example-com');
});

test('die Host-Regel traegt weiterhin den echten Namen', () => {
  const labels = baueLabels('chat.example.com');
  assert.ok(labels.some(l => l.includes('Host(`chat.example.com`)')));
});
```

- [ ] **Step 2: Run — Expected: FAIL**
- [ ] **Step 3: Implementierung**

```bash
      # Traefik zerlegt Label-Schluessel an Punkten; ein FQDN im Router-Namen
      # laesst den Parser die GESAMTE Label-Konfiguration des Containers
      # verwerfen. Damit hat der discovery-Modus fuer keinen echten Hostnamen
      # je funktioniert — waehrend das Skript "No manual step" versprach.
      local r="pulse-$(printf '%s' "$SRV_HOST" | tr -c '[:alnum:]' '-')"
```

- [ ] **Step 4: Run — Expected: PASS**
- [ ] **Step 5: Commit**

### Task 9: Beweisregel auch im Auto-Discovery-Zweig (II·4)

**Files:** `web/static/install.sh:157-162`; Test: `web/test/install-proxy-erkennung.test.ts` (erweitern)

- [ ] **Step 1: Failing test**

```typescript
test('traefik/whoami kapert die Erkennung nicht', () => {
  // Das Demo-Image aus jeder Traefik-Anleitung. Es veroeffentlicht nichts.
  const ergebnis = erkenne([{ name: 'demo', image: 'traefik/whoami:latest', publiziert: false }]);
  assert.equal(ergebnis, 'none:');
});

test('ein echter Traefik mit Host-Networking wird weiterhin erkannt', () => {
  // Gegenprobe: `network_mode: host` veroeffentlicht nichts und ist trotzdem
  // ein Proxy — deshalb greift die Regel nur, wenn 80/443 belegt sind.
  const ergebnis = erkenne([{ name: 'traefik', image: 'traefik:v3', publiziert: false }], { portBelegt: true });
  assert.equal(ergebnis, 'traefik:traefik');
});
```

- [ ] **Step 2: Run — Expected: FAIL** (erster Test liefert `traefik:demo`)

- [ ] **Step 3: Implementierung** — die Beweisregel aus dem statischen Zweig auch hier anwenden. Der Auto-Discovery-Zweig lief bisher **unbedingt**, also auch auf einer blanken Maschine mit freien Ports:

```bash
  # Dieselbe Beweisregel wie unten im statischen Zweig: ein Image-Name ist kein
  # Beweis. Ausnahme mit Absicht — ein Proxy mit `network_mode: host`
  # veroeffentlicht nichts und IST trotzdem einer; deshalb genuegt auch, dass
  # 80/443 ueberhaupt belegt sind.
  if publishes_web_port "$name" || port_busy 80 || port_busy 443; then
```

- [ ] **Step 4: Run — Expected: PASS (beide)**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(self-host): traefik/whoami konnte die Proxy-Erkennung kapern"
```

### Task 10: `PULSE_TLS_MODE` und `PULSE_NETWORK` ehrlich behandeln (II·9)

**Files:** `web/static/install.sh:218-222`; Test: `web/test/install-overrides.test.ts` (neu)

- [ ] **Step 1: Failing test**

```typescript
test('PULSE_TLS_MODE=behind-proxy wird nicht verschluckt', () => {
  assert.equal(entscheide({ tlsMode: 'behind-proxy' }).tlsMode, 'behind-proxy');
});

test('ein unbekannter PULSE_TLS_MODE bricht ab statt still zu wirken', () => {
  const e = entscheide({ tlsMode: 'behind_proxy' });  // Tippfehler
  assert.equal(e.abgebrochen, true);
});

test('PULSE_NETWORK wirkt auch aus hostproxy heraus', () => {
  const e = entscheide({ netzwerk: 'mein-netz', modeVorher: 'hostproxy' });
  assert.equal(e.mode, 'static-docker');
  assert.ok(e.runArgs.includes('--network'));
});

test('PULSE_TLS_MODE=auto wird von PULSE_NETWORK nicht ueberstimmt', () => {
  const e = entscheide({ tlsMode: 'auto', netzwerk: 'mein-netz' });
  assert.equal(e.tlsMode, 'auto');
});
```

- [ ] **Step 2: Run — Expected: FAIL** (alle vier)

- [ ] **Step 3: Implementierung** — `FORCE_TLS_MODE` gegen die Liste des Containers prüfen (`auto|provided|behind-proxy`, s. `09-init-caddy.sh:20-62`), Unbekanntes abbrechen; `FORCE_NETWORK` auch aus `hostproxy` heraus wirken lassen; die beiden Overrides in eine Reihenfolge bringen, in der keiner den anderen still kassiert.

- [ ] **Step 4: Run — Expected: PASS (alle vier)**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(self-host): PULSE_TLS_MODE und PULSE_NETWORK wirkten nur halb"
```

### Task 10b: Unerfüllbare und unterdrückte Anweisungen (II·6, II·7)

**Files:**
- Modify: `web/static/install.sh:213` (hostproxy-Rückfall), `:426-427` (systemctl)
- Test: `web/test/install-anweisungen.test.ts` (neu)

- [ ] **Step 1: Failing test**

```typescript
test('ein Proxy-Container ohne Nutzer-Netz bekommt keine Loopback-Anweisung', () => {
  // Das Ziel 127.0.0.1:8080 waere im Proxy-CONTAINER dessen eigenes Loopback.
  // Gemessen: weder ueber 127.0.0.1 noch ueber die Bridge-IP erreichbar.
  const e = entscheide({ proxyContainer: 'caddy', proxyNetze: [] });
  assert.equal(e.abgebrochen, true);
  assert.match(e.meldung, /Netz/);
});

test('ein fehlgeschlagenes Auto-Update unterdrueckt die Routen-Anweisung nicht', () => {
  const e = laufMitStub({ systemctlRc: 1 });
  assert.equal(e.exit, 0);
  assert.match(e.ausgabe, /reverse_proxy/);
});
```

- [ ] **Step 2: Run — Expected: FAIL (beide)**

- [ ] **Step 3: Implementierung** — beim erkannten Proxy-Container ohne Nutzer-Netz abbrechen und nach `PULSE_NETWORK` fragen, statt auf ein unerreichbares Loopback zurückzufallen; `systemctl`- und `crontab`-Aufrufe mit `|| warn "…"` abfangen. **Auto-Update ist optional, die Route nicht.**

- [ ] **Step 4: Run — Expected: PASS (beide)**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(self-host): unerfuellbare Routen-Anweisung und unterdrueckte Pflichtschritte"
```

### Task 11: Phase B landen — Gate, Changelog, ship.

---

## Phase C — Was falsch informiert

### Task 12: Der 4046-Text nennt die richtige Ursache (III·1)

**Files:**
- Modify: `services/auth/src/dcc_auth/diagnose_texte.py` (Eintrag `("websocket", "server_ohne_cloud")`)
- Test: `services/auth/tests/test_diagnose_texte.py` (erweitern)

- [ ] **Step 1: Failing test**

```python
def test_4046_verweist_nicht_auf_die_ausgehende_firewall():
    """Auf einem Self-Host zeigt AUTH_JWKS_URL auf 127.0.0.1:8001 — den
    lokalen auth-svc im selben Container. 4046 heisst also "der Dienst nebenan
    antwortet nicht", nicht "kein Internet". Der alte Text schickte den
    Betreiber an die Firewall, waehrend das Problem einen Prozess entfernt sass.
    """
    for sprache in dt.SPRACHEN:
        was_ist, was_tun = dt.erklaerung("websocket", "server_ohne_cloud", False, sprache)
        gesamt = f"{was_ist} {was_tun}".lower()
        assert "firewall" not in gesamt, "verweist weiter auf die Firewall"
        assert "pulse-doctor" in gesamt or "auth" in gesamt
```

- [ ] **Step 2: Run — Expected: FAIL**
- [ ] **Step 3: Text neu fassen** (de/en), Mechanismus: lokaler auth-svc / JWKS kalt; Handgriff: `docker exec <container> pulse-doctor`, Abschnitt „Dienste im Container".
- [ ] **Step 4: Run — Expected: PASS**
- [ ] **Step 5: Commit**

- [ ] **Step 6: Im selben Durchgang III·4** — der CORS-Text sagt „das Anmelden", der geprüfte Pfad betrifft aber das **Hinzufügen** eines Servers (Browser auf howispulse.com, cross-origin gegen den Self-Host). Wer ein anderes Login-Problem sucht, wird sonst fälschlich auf CORS verwiesen. Text auf „Einrichten/Verbinden" umstellen, Test wie oben (Wortprüfung auf beide Sprachen).

### Task 13: Der Containername kommt aus der Konfiguration, nicht aus dem Text (III·2)

**Files:**
- Modify: `services/auth/src/dcc_auth/diagnose_texte.py` (4 Stellen), `routes_selfhost_diagnose.py` (Parameter durchreichen), `web/static/install.sh` (Namen mitsenden)
- Test: `services/auth/tests/test_diagnose_texte.py` (erweitern)

- [ ] **Step 1: Failing test**

```python
def test_kein_text_nagelt_den_containernamen_fest():
    """Der Installer erlaubt PULSE_CONTAINER und parametrisiert seine eigene
    Zeile korrekt — die Cloud-Texte taten es nicht. Fuer jeden, der den Namen
    geaendert hat, scheitern vier Befehle mit "No such container".
    """
    import re

    treffer = []
    for schritt, befund in dt.alle_paare():
        for sprache in dt.SPRACHEN:
            for text in dt.erklaerung(schritt, befund, False, sprache):
                if re.search(r"docker \w+ pulse\b", text):
                    treffer.append((schritt, befund, sprache))
    assert not treffer, f"fester Containername in: {treffer}"
```

- [ ] **Step 2-5:** Platzhalter einführen (z. B. `{container}`), von der Route aus füllen; Vorgabe `pulse`, wenn nichts mitkommt.

### Task 14: `jget` beidseitig reparieren (III·3)

**Files:** `web/static/install.sh:285-292`; Test: `web/test/install-jget.test.ts` (neu)

- [ ] **Step 1: Failing test**

```typescript
test('JSON-null wird zu leer, nicht zum Text None', () => {
  assert.equal(jget('{"admin_email":null}', 'admin_email'), '');
});

test('der Rueckfallzweig ohne python3 toetet den Installer nicht', () => {
  // grep ohne Treffer endet mit 1; unter pipefail + set -e stirbt die
  // Zuweisung — wortlos, unmittelbar nach dem Einloesen des Tokens.
  const e = jgetOhnePython3('{"admin_email":null}', 'admin_email');
  assert.equal(e.exit, 0);
  assert.equal(e.wert, '');
});
```

- [ ] **Step 2-5:** `or ''` im python3-Zweig, `|| true` im Rückfall.

### Task 15: Phase C landen — Gate, Changelog, ship.

---

## Phase D — Die Anleitung

### Task 16: Doku gegen die Wirklichkeit ziehen (Klasse IV)

**Files:** `docs/SELF_HOST.md`, `infra/self-host/README.md`, `infra/self-host/.env.example`

Kein Test — Prosa. Aber jede Änderung muss am Code belegt sein:

- [ ] Backup-Befehl: Datenbank heisst `dcc`, `-h 127.0.0.1` ergänzen (Vorbild: `s6-rc.d/backup/run:33`).
- [ ] Deinstallation: zwischen Installer-Weg (`pulse-data`) und Compose-Weg (`docker compose down -v`) unterscheiden.
- [ ] `/health`: `failed` enthält nur `db` und `redis`; `jwks` erscheint als eigener Zustand `warming_up`, `disk` nur im internen Endpunkt.
- [ ] Versionen: LiveKit 1.13.3, MediaMTX 1.19.1 (aus dem Dockerfile).
- [ ] Registry: eine nennen, nicht zwei.
- [ ] Kanal: dass der Installer `:edge` zieht und `PULSE_IMAGE` das ändert.
- [ ] Die neun undokumentierten `PULSE_*`-Schalter aufnehmen — vor allem `PULSE_NETWORK` und `PULSE_CONTAINER`.
- [ ] `PULSE_PUBLIC_IP`: wirkt **nur** auf coturn, nicht auf LiveKit.
- [ ] Der Portkonflikt-Text bekommt zwei Sätze: dass die Medienports nicht umlegbar sind, **weil WebRTC sie in seinen ICE-Kandidaten ansagt**, und dass eine zweite IP der Ausweg ist (`-p <IP>:7882-7892:…`).

- [ ] **Commit + ship.**

---

## Bewusst NICHT in diesem Plan

- **Die Testsuite auf uvloop umstellen.** Richtig und überfällig (sonst kommt die Klasse von II·1 zurück), aber eine eigene Entscheidung mit eigenem Risiko: es könnte weitere schlafende Fehler wecken. Gehört in einen eigenen Durchgang mit Rückfrage.
- **Die Fortschrittsanzeige auf Dienste ausserhalb der nummerierten Skripte ausweiten** (`minio-init`, `backup`). Architekturänderung, kein Fix.
- **Ein Schalter für die Medienports.** Technisch möglich, aber er müsste bis in die gerenderte Konfiguration durchgereicht werden, und ein falscher Wert erzeugt genau den Fehler, der am schwersten zu finden ist. Task 16 erklärt stattdessen den Ausweg.
- **Sprachvereinheitlichung** (`pulse-doctor` deutsch, Installer englisch). Eigenes Thema, trifft jeden Nicht-Deutschsprachigen.
- Die sechs als **vermutet** gekennzeichneten Befunde — erst messen, dann anfassen.
