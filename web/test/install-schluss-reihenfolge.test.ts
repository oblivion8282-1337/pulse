/**
 * `web/static/install.sh` — Hauptablauf-Reihenfolge, Fund 4 der Schlussprüfung.
 *
 * **Zwei Reihenfolge-Kleinigkeiten:**
 *
 *   1. `--dry-run` stieg VOR `check_ports`/`pruefe_container_konflikt` aus.
 *      Beide lesen nur und verbrauchen nichts — der Vorschau-Modus ist gerade
 *      der, in dem man einen Konflikt sehen will. Ein Dry-Run auf einer
 *      Maschine mit belegtem Port oder einem fremden `pulse`-Container
 *      meldete trotzdem einen grünen Plan. Fix: beide Prüfungen laufen jetzt
 *      VOR dem Dry-Run-Ausstieg.
 *   2. `mkdir -p "$PULSE_DIR"` war der erste Dateisystemzugriff des ganzen
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
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

/**
 * Eine Shell-Funktion `name() { … }` bis zur schliessenden Klammer in Spalte 0
 * — heredoc-bewusst (übernommen aus `install-updater.test.ts`/
 * `install-fremder-container.test.ts`).
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
  assert.fail(`kein Ende fuer ${name}() gefunden — Skript umgebaut?`);
}

/**
 * Ein zusammenhängender, WÖRTLICH übernommener Ausschnitt des Skripts
 * zwischen zwei eindeutigen Zeilen (beide inklusive) — übernommen aus
 * `install-fremder-container.test.ts`.
 */
function bereich(quelle: string, vonZeile: string, bisZeileEnthaelt: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.trim() === vonZeile);
  assert.notEqual(start, -1, `Startanker "${vonZeile}" nicht gefunden — Skript umgebaut?`);
  const ende = zeilen.findIndex((z, i) => i > start && z.includes(bisZeileEnthaelt));
  assert.notEqual(ende, -1, `Endanker "${bisZeileEnthaelt}" nicht gefunden — Skript umgebaut?`);
  return zeilen.slice(start, ende + 1).join('\n');
}

interface Optionen {
  dryRun?: boolean;
  /** `port_busy` meldet "belegt" für jeden Port. */
  portBelegt?: boolean;
  /** Ein vorhandener Container mit fremdem Image (`postgres:16`). */
  fremderContainer?: boolean;
  /** Default: ein frisches, beschreibbares Temp-Verzeichnis. */
  pulseDir?: string;
}

interface Ergebnis {
  /** Wurde `die()` erreicht? */
  abgebrochen: boolean;
  /** Die an `die` übergebene Meldung (leer, wenn nicht abgebrochen). */
  meldung: string;
  /** Wurde die "DRY RUN — nothing changed"-Zeile ausgegeben? */
  dryRunGemeldet: boolean;
  /** Wurde das Ende des Ausschnitts erreicht (`pruefe_pulse_dir_schreibbar` durchlaufen)? */
  ueberlebt: boolean;
}

function laufe(optionen: Optionen): Ergebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-schluss-reihenfolge-'));
  const pulseDir = optionen.pulseDir ?? join(dir, 'pulsedir');

  // Gefälschtes `docker`: nur `inspect -f '{{.Config.Image}}' pulse` für
  // `ist_unser_container` relevant. Ohne fremden Container schlägt jedes
  // `docker inspect` fehl (kein Container vorhanden — der Normalfall bei
  // einer Erstinstallation).
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  inspect)
    if [ "\${FREMDER_CONTAINER:-}" = "true" ]; then
      case "$*" in
        *Config.Image*) echo 'postgres:16' ;;
        *) exit 0 ;;
      esac
    else
      exit 1
    fi ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  const skript = `
set -uo pipefail
CONTAINER=pulse
IMAGE="registry.howispulse.com/pulse-allinone:edge"
HTTP_PORT=8080
PULSE_DIR="${pulseDir}"
DRY_RUN="${optionen.dryRun ? '1' : ''}"
log()  { printf '__LOG__%s\\n' "$*"; }
warn() { :; }
err()  { :; }
die()  { printf '__DIE__%s\\n' "$*"; exit 9; }
port_busy() { ${optionen.portBelegt ? 'return 0' : 'return 1'}; }
udp_port_busy() { return 1; }
eigener_container_laeuft() { return 1; }
# Gefälscht — ihre eigene Logik hat eigene Tests (s. Kommentar oben).
decide_mode() { MODE=greenfield; PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""; }
build_run_args() { RUN_ARGS=( -d --name "$CONTAINER" "$IMAGE" ); }
print_plan() { log "Detected mode: \${MODE}"; }
${funktion(quelle, 'check_ports')}
${funktion(quelle, 'ist_unser_container')}
${funktion(quelle, 'pruefe_container_konflikt')}
${funktion(quelle, 'pruefe_pulse_dir_schreibbar')}
${bereich(quelle, 'decide_mode', 'pruefe_pulse_dir_schreibbar')}
echo __UEBERLEBT__
`;

  let stdout = '';
  try {
    stdout = execFileSync('bash', ['-c', skript], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FREMDER_CONTAINER: optionen.fremderContainer ? 'true' : 'false'
      },
      encoding: 'utf8'
    });
  } catch (fehler) {
    const f = fehler as { stdout?: string };
    stdout = f.stdout ?? '';
  }

  const treffer = stdout.match(/__DIE__([\s\S]*?)(?:\n__UEBERLEBT__)?$/);
  return {
    abgebrochen: stdout.includes('__DIE__'),
    meldung: treffer ? treffer[1] : '',
    dryRunGemeldet: stdout.includes('DRY RUN — nothing changed'),
    ueberlebt: stdout.includes('__UEBERLEBT__')
  };
}

test('--dry-run meldet einen Portkonflikt, statt einen grünen Plan zu zeigen', () => {
  const e = laufe({ dryRun: true, portBelegt: true });
  assert.equal(e.abgebrochen, true, `erwartet Abbruch, bekommen: ${JSON.stringify(e)}`);
  assert.match(e.meldung, /already in use/);
  assert.equal(e.dryRunGemeldet, false, 'die DRY-RUN-Erfolgszeile erschien trotz Portkonflikt');
});

test('--dry-run meldet einen fremden Container, statt einen grünen Plan zu zeigen', () => {
  const e = laufe({ dryRun: true, fremderContainer: true });
  assert.equal(e.abgebrochen, true, `erwartet Abbruch, bekommen: ${JSON.stringify(e)}`);
  assert.match(e.meldung, /PULSE_CONTAINER/);
  assert.equal(e.dryRunGemeldet, false, 'die DRY-RUN-Erfolgszeile erschien trotz Fremdkonflikt');
});

test('--dry-run zeigt weiterhin den Plan, wenn nichts kollidiert (Gegenprobe)', () => {
  // Sonst bestünden die beiden Tests oben auch, wenn --dry-run grundsätzlich
  // nie mehr erfolgreich melden würde.
  const e = laufe({ dryRun: true });
  assert.equal(e.abgebrochen, false, e.meldung);
  assert.equal(e.dryRunGemeldet, true, 'die DRY-RUN-Erfolgszeile fehlt, obwohl nichts kollidiert');
  assert.equal(e.ueberlebt, false, 'der Dry-Run haette bei "exit 0" enden müssen, nicht bei pruefe_pulse_dir_schreibbar');
});

test('ein unbeschreibbares PULSE_DIR bricht ab, bevor irgendetwas verbraucht wird', () => {
  // Ein Verzeichnis unter einem Pfad, der selbst nicht existiert UND nicht
  // anlegbar ist (Elternverzeichnis 0500 — lesbar/betretbar, nicht
  // beschreibbar): `mkdir -p` scheitert daran zuverlässig, ohne root-Rechte
  // vorauszusetzen.
  const basis = mkdtempSync(join(tmpdir(), 'pulse-unbeschreibbar-'));
  chmodSync(basis, 0o500);
  try {
    const e = laufe({ pulseDir: join(basis, 'pulse-data') });
    assert.equal(e.abgebrochen, true, `erwartet Abbruch, bekommen: ${JSON.stringify(e)}`);
    assert.match(e.meldung, /Cannot create or write/);
    // Zeilenumbrüche in der Meldung: die Wendung "consumed yet" bricht
    // absichtlich um, daher whitespace-tolerant statt eines wörtlichen
    // Regex-Treffers über die Zeilengrenze.
    assert.match(e.meldung.replace(/\s+/g, ' '), /nothing has been consumed yet/i);
  } finally {
    chmodSync(basis, 0o700);
  }
});

test('ein beschreibbares PULSE_DIR läuft bis zur Token-Einlösung durch (Gegenprobe)', () => {
  const e = laufe({});
  assert.equal(e.abgebrochen, false, e.meldung);
  assert.equal(e.ueberlebt, true, 'der Ausschnitt haette pruefe_pulse_dir_schreibbar erreichen müssen');
});
