/**
 * `install.sh` — zwei unerfüllbare bzw. unterdrückte Anweisungen (Task 10b,
 * II·6, II·7).
 *
 * **Fall 1 — der Loopback-Rückfall in `decide_mode`.** Erkennt `detect_proxy`
 * einen Proxy-CONTAINER (statisch oder Auto-Discovery), aber der hängt nur
 * am Default-Bridge-Netz (kein eigenes Nutzer-Netz), fiel der Modus bisher
 * auf `hostproxy`: Pulse bindet `127.0.0.1:8080` auf dem HOST, und die
 * Anweisung unten lautet, die Proxy-Route auf `127.0.0.1:8080` zu legen.
 * Gemessen: das Ziel wäre innerhalb des Proxy-CONTAINERS dessen EIGENES
 * Loopback — weder über `127.0.0.1` noch über die Bridge-IP von dort aus
 * erreichbar. Der Betreiber bekäme eine Anweisung, die nie funktionieren
 * kann. Fix: statt des Rückfalls wird jetzt abgebrochen und nach
 * `PULSE_NETWORK` gefragt — genau der Weg, den `_set_proxy` bei mehreren
 * Netzen schon lange geht (s. `install-proxy-erkennung.test.ts`).
 *
 * **Fall 2 — `systemctl`/`crontab` unterdrückten die Pflicht-Route.** Die
 * Auto-Update-Einrichtung (`install_update_timer`/`install_update_cron`)
 * stand unguarded im Hauptablauf. Scheiterte einer ihrer externen Aufrufe
 * (kaputtes systemd in einem Container, kein Cron-Daemon), riss `set -e`
 * den GESAMTEN Installer ab — NACHDEM der Container schon läuft und BEVOR
 * die Proxy-Route (Schritt 7, die einzige noch offene Pflichtanweisung)
 * ausgegeben wurde. Auto-Update ist optional, die Route nicht. Fix: beide
 * Aufrufe fangen ihren Fehlschlag jetzt mit `|| warn "…"` ab.
 *
 * **Abweichung vom Task-Brief:** der Brief nennt den zweiten Test
 * `laufMitStub({ systemctlRc: 1 })`. Der echte systemd-Zweig
 * (`install_update_timer`) schreibt aber nach `/etc/systemd/system/` und
 * braucht `id -u == 0` — beides darf ein Unit-Test nicht anfassen (ein
 * versehentlicher Lauf als root auf einer echten systemd-Maschine würde
 * sonst echte Systemdateien schreiben). Der Fix ist an beiden Stellen
 * strukturell identisch, deshalb prüft `laufMitStub` unten den ohne root
 * erreichbaren, gleichwertigen Crontab-Zweig End-zu-Ende (echtes
 * `install_update_cron` + die echten Schritte 6/7 aus `install.sh`), und
 * `installiereTimer` deckt `install_update_timer` separat und sicher ab —
 * dort werden NUR IM TESTHARNESS (nicht in `install.sh`) die beiden
 * `/etc/systemd/system/…`-Zielpfade auf ein Temp-Verzeichnis umgebogen,
 * damit die echte Funktion samt ihrer beiden `|| warn`-Absicherungen läuft,
 * ohne je eine reale Systemdatei anzufassen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

/**
 * Eine Shell-Funktion `name() { … }` bis zur schliessenden Klammer in Spalte 0
 * — heredoc-bewusst (übernommen aus den Nachbartests). Findet sie die
 * Funktion nicht, schlägt der Test hart fehl statt gegen eine leere Shell zu
 * laufen und daran grün vorbeizukommen.
 */
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
    if (zeile === '}') {
      return zeilen.slice(start, i + 1).join('\n');
    }
  }
  assert.fail(`kein Ende für ${name}() gefunden — Skript umgebaut?`);
}

/**
 * Ein zusammenhängender, wörtlich übernommener Ausschnitt des Skripts
 * zwischen zwei eindeutigen Zeilen (beide inklusive) — nach dem Vorbild aus
 * `install-fremder-container.test.ts`. Anders als `funktion()` schneidet das
 * keine benannte Funktion aus, sondern ein Stück des Hauptablaufs.
 *
 * Der Endanker wird EXAKT (getrimmt) verglichen, nicht per `.includes()`
 * wie im Vorbild: der hier gesuchte Anker `EOF` ist zugleich Teilstring der
 * ÖFFNENDEN Heredoc-Zeile `cat <<EOF` — ein `.includes()`-Vergleich träfe
 * also die falsche, frühere Zeile und schnitte den Heredoc-Körper samt
 * seines echten Endes ab (genau das ist beim Bau dieses Tests passiert: die
 * generierte Shell endete dann mitten im Heredoc, „Unerwartetes Dateiende").
 */
function bereich(quelle: string, vonZeile: string, bisZeile: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.trim() === vonZeile);
  assert.notEqual(start, -1, `Startanker "${vonZeile}" nicht gefunden — Skript umgebaut?`);
  const ende = zeilen.findIndex((z, i) => i > start && z.trim() === bisZeile);
  assert.notEqual(ende, -1, `Endanker "${bisZeile}" nicht gefunden — Skript umgebaut?`);
  return zeilen.slice(start, ende + 1).join('\n');
}

// --------------------------------------------------------------------- //
// Fall 1: der Loopback-Rückfall in decide_mode
// --------------------------------------------------------------------- //

interface EntscheideOptionen {
  /** Name des erkannten Proxy-Containers. */
  proxyContainer: string;
  /** Netze, die das gefälschte `docker inspect` für ihn melden soll — leer heisst „nur Default-Bridge". */
  proxyNetze: string[];
  /** PROXY_KIND, wie `detect_proxy` es gesetzt hätte. */
  proxyKind?: string;
}

interface EntscheideErgebnis {
  abgebrochen: boolean;
  meldung: string;
  mode: string;
}

/**
 * Führt `decide_mode` mit einem gestubbten `detect_proxy` aus (welcher
 * Container gewinnt, ist Sache von `detect_proxy` selbst und hat eigene
 * Tests in `install-proxy-erkennung.test.ts` — hier zählt nur, was
 * `decide_mode` aus PROXY_KIND + PROXY_NET macht). `proxy_netze` und
 * `_set_proxy` werden UNVERÄNDERT aus der Quelle geschnitten, nicht
 * nachgebaut — die Netz-Ermittlung selbst ist nicht der Testgegenstand.
 */
function entscheide(optionen: EntscheideOptionen): EntscheideErgebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-anweisungen-netz-'));

  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  inspect) printf '%b\\n' "${optionen.proxyNetze.join('\\n')}" ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  const skript = `
set -euo pipefail
err() { printf '[pulse] ERROR: %s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
warn() { :; }
${funktion(quelle, 'proxy_netze')}
${funktion(quelle, '_set_proxy')}
${funktion(quelle, 'decide_mode')}
detect_proxy() { _set_proxy '${optionen.proxyContainer}' '${optionen.proxyKind ?? 'static-caddy'}'; }
FORCE_NETWORK=""
FORCE_TLS_MODE=""
decide_mode
echo "MODE:\${MODE}"
`;
  try {
    const ausgabe = execFileSync('bash', ['-c', skript], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8'
    });
    const zeile = ausgabe.split('\n').find((z) => z.startsWith('MODE:')) ?? 'MODE:';
    return { abgebrochen: false, meldung: '', mode: zeile.slice(5) };
  } catch (fehler) {
    const f = fehler as { status?: number; stderr?: string };
    return { abgebrochen: true, meldung: f.stderr ?? '', mode: '' };
  }
}

test('ein Proxy-Container ohne Nutzer-Netz bekommt keine Loopback-Anweisung', () => {
  // Das Ziel 127.0.0.1:8080 wäre im Proxy-CONTAINER dessen eigenes Loopback.
  // Gemessen: weder über 127.0.0.1 noch über die Bridge-IP erreichbar.
  const e = entscheide({ proxyContainer: 'caddy', proxyNetze: [] });
  assert.equal(e.abgebrochen, true);
  // Der Brief prüft hier `/Netz/` — dieses Skript ist aber user-facing
  // Englisch (s. Skriptkopf: "User-Output ist Englisch"), "Netz" kommt darin
  // nie vor. Geprüft wird stattdessen auf "network" (die Meldung erklärt das
  // Problem) und den konkreten Ausweg PULSE_NETWORK.
  assert.match(e.meldung, /network/i);
  assert.match(e.meldung, /PULSE_NETWORK/);
});

test('derselbe Rückfall gilt auch für einen Auto-Discovery-Proxy (traefik/nginx-proxy/caddy-docker-proxy)', () => {
  // Die zweite Stelle mit demselben Fehler — eigener Test, damit ein Fix, der
  // nur den static-*-Zweig repariert, hier auffliegt.
  const e = entscheide({ proxyContainer: 'traefik', proxyNetze: [], proxyKind: 'traefik' });
  assert.equal(e.abgebrochen, true);
  assert.match(e.meldung, /network/i);
  assert.match(e.meldung, /PULSE_NETWORK/);
});

test('Gegenprobe: mit einem echten Nutzer-Netz wird weiterhin nicht abgebrochen', () => {
  // Sonst bestünden die beiden Tests oben auch, wenn decide_mode jetzt IMMER
  // abbricht — das wäre kein Fix, sondern ein neuer, breiterer Fehler.
  const e = entscheide({ proxyContainer: 'caddy', proxyNetze: ['pulse-selfhost-net'] });
  assert.equal(e.abgebrochen, false);
  assert.equal(e.mode, 'static-docker');
});

// --------------------------------------------------------------------- //
// Fall 2: systemctl/crontab dürfen die Routen-Anweisung nicht unterdrücken
// --------------------------------------------------------------------- //

interface StubErgebnis {
  exit: number;
  ausgabe: string;
}

/**
 * Führt die echten Schritte 5–7 aus `install.sh` End-zu-Ende aus (Schritt 5:
 * Auto-Update-Einrichtung; Schritt 6: Startfortschritt, hier vom gefälschten
 * `docker` sofort als „fertig" gemeldet — kein 60×5s-Warten im Test; Schritt
 * 7: die Proxy-Route). `id` wird gefälscht, damit IMMER der Crontab-Zweig
 * greift (s. Docstring oben, warum nicht der systemd-Zweig).
 */
function laufMitStub(optionen: { crontabRc: number }): StubErgebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-anweisungen-stub-'));
  const pulseDir = join(dir, 'pulse');
  const updateSh = join(pulseDir, 'pulse-update.sh');

  writeFileSync(join(dir, 'id'), `#!/bin/bash\necho 1000\n`, { mode: 0o755 });
  chmodSync(join(dir, 'id'), 0o755);

  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  rm) exit 0 ;;
  exec) printf 't\\tfertig\\tok\\n' ;;
  inspect) echo true ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  writeFileSync(
    join(dir, 'crontab'),
    `#!/bin/bash
case "$1" in
  -l) exit 1 ;;
  -) cat > /dev/null; exit "\${CRONTAB_RC:-0}" ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'crontab'), 0o755);

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
  );

  const skript = `
set -euo pipefail
CONTAINER="pulse-test"
MODE="hostproxy"
HTTP_PORT="8080"
SRV_HOST="test.example.invalid"
PROXY_KIND="none"
PROXY_CONTAINER=""
PULSE_DIR="${pulseDir}"
UPDATE_SH="${updateSh}"
# Von write_update_script gebraucht (s. install-updater.test.ts) — IMAGE
# absichtlich NICHT auf registry.howispulse.com, sonst verlangt der
# Registry-Zweig CLIENT_ID/CLIENT_SECRET zusätzlich.
IMAGE="ghcr.io/beispiel/pulse-allinone:edge"
CLIENT_ID="dummy-client"
CLIENT_SECRET="dummy-secret"
RUN_ARGS=( -d --name "$CONTAINER" --restart unless-stopped "$IMAGE" )
log() { :; }
warn() { printf '__WARN__%s\\n' "$*"; }
err() { printf '__ERR__%s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
${funktion(quelle, 'write_update_script')}
${funktion(quelle, 'install_update_cron')}
${bereichText}
`;

  let exit = 0;
  let ausgabe = '';
  try {
    ausgabe = execFileSync('bash', ['-c', skript], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CRONTAB_RC: String(optionen.crontabRc)
      },
      encoding: 'utf8'
    });
  } catch (fehler) {
    const f = fehler as { status?: number | null; stdout?: string };
    exit = f.status ?? 1;
    ausgabe = f.stdout ?? '';
  }
  return { exit, ausgabe };
}

test('ein fehlgeschlagenes Auto-Update unterdrueckt die Routen-Anweisung nicht', () => {
  const e = laufMitStub({ crontabRc: 1 });
  assert.equal(e.exit, 0, `Installer starb (Exit ${e.exit}) statt die Route auszugeben:\n${e.ausgabe}`);
  assert.match(e.ausgabe, /reverse_proxy/);
});

test('Gegenprobe: ein erfolgreiches Auto-Update gibt die Route ebenso aus', () => {
  const e = laufMitStub({ crontabRc: 0 });
  assert.equal(e.exit, 0);
  assert.match(e.ausgabe, /reverse_proxy/);
});

/**
 * `install_update_timer` — die zweite Stelle desselben Fixes. Die beiden
 * `/etc/systemd/system/…`-Zielpfade werden NUR HIER, im Testharness (nicht
 * in `install.sh`), auf ein Temp-Verzeichnis umgebogen, damit die echte
 * Funktion — samt ihrer beiden `|| warn`-Absicherungen — wirklich läuft,
 * ohne je eine reale Systemdatei anzufassen.
 */
function installiereTimer(systemctlRc: number): { exit: number; ausgabe: string; erreicht: boolean } {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-systemctl-'));
  const sandboxEtc = join(dir, 'etc-systemd-system');
  mkdirSync(sandboxEtc, { recursive: true });

  const original = funktion(quelle, 'install_update_timer');
  const text = original.split('/etc/systemd/system/').join(`${sandboxEtc}/`);
  assert.notEqual(text, original, 'kein /etc/systemd/system/-Pfad in install_update_timer gefunden — Skript umgebaut?');

  writeFileSync(join(dir, 'systemctl'), `#!/bin/bash\nexit "\${SYSTEMCTL_RC:-0}"\n`, { mode: 0o755 });
  chmodSync(join(dir, 'systemctl'), 0o755);

  const skript = `
set -euo pipefail
UPDATE_SH="${join(dir, 'pulse-update.sh')}"
warn() { printf '__WARN__%s\\n' "$*"; }
${text}
install_update_timer
echo __NACH_INSTALL_UPDATE_TIMER__
`;
  let exit = 0;
  let ausgabe = '';
  try {
    ausgabe = execFileSync('bash', ['-c', skript], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SYSTEMCTL_RC: String(systemctlRc) },
      encoding: 'utf8'
    });
  } catch (fehler) {
    const f = fehler as { status?: number | null; stdout?: string };
    exit = f.status ?? 1;
    ausgabe = f.stdout ?? '';
  }
  return { exit, ausgabe, erreicht: ausgabe.includes('__NACH_INSTALL_UPDATE_TIMER__') };
}

test('ein scheiterndes systemctl bricht install_update_timer nicht ab', () => {
  const e = installiereTimer(1);
  assert.equal(e.exit, 0, `install_update_timer starb (Exit ${e.exit}) statt zu warnen:\n${e.ausgabe}`);
  assert.ok(e.erreicht, 'die Zeile nach install_update_timer wurde nicht erreicht — set -e hat abgebrochen');
  assert.match(e.ausgabe, /__WARN__/);
});

test('Gegenprobe: ein erfolgreiches systemctl warnt nicht unnoetig', () => {
  const e = installiereTimer(0);
  assert.equal(e.exit, 0);
  assert.ok(e.erreicht);
  assert.doesNotMatch(e.ausgabe, /__WARN__/);
});
