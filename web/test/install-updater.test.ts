/**
 * `write_update_script` aus `web/static/install.sh` — der Updater, den der
 * Installer als eigenständiges Skript auf den Host schreibt (systemd-Timer
 * oder Cron, alle fünf Minuten).
 *
 * **Warum es diesen Test gibt.** `docker run -d` liefert Exit-Code 0, sobald
 * der Container ERZEUGT wurde — nicht, wenn er tatsächlich läuft. Der
 * Updater wertete das bislang als Erfolg: er löschte die Rollback-Kopie
 * (`<name>-old`) UND das zuletzt funktionierende Image. Da `IMAGE` ein
 * rollender Tag ist (`:edge`), ist die Vorversion danach nicht mehr
 * adressierbar — ein Image, das startet und sofort wieder stirbt, reisst
 * damit JEDEN Self-Host gleichzeitig um, ohne Rückweg, binnen fünf Minuten.
 *
 * **Wie das geht — zweistufig, weil das Prüfobjekt nicht `install.sh`
 * selbst ist, sondern das Skript, das `install.sh` GENERIERT:**
 *   1. `write_update_script` wird aus `install.sh` herausgeschnitten und mit
 *      Fake-Konfiguration ausgeführt — sie schreibt einen echten Updater auf
 *      die Platte. Das ist der eigentliche Prüfling.
 *   2. Dieser generierte Updater wird gegen ein gefälschtes `docker` auf dem
 *      PATH ausgeführt, das jeden Aufruf mitprotokolliert und `run -d`
 *      erfolgreich, `inspect -f '{{.State.Running}}'` aber je nach Szenario
 *      `true` oder `false` beantwortet.
 *
 * Ein Test, der nur `write_update_script` prüft (Textvergleich am
 * generierten Skript), würde eine Regression in der SHELL-LOGIK selbst nicht
 * fangen — deshalb läuft der generierte Updater hier wirklich.
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
 * — heredoc-bewusst. `write_update_script` enthält zwei Heredocs
 * (`<<'HEADER'`, `<<'BODY'`), deren Inhalt eigene, unindentierte
 * `}`-Zeilen trägt (z. B. die generierte `_trim_log()`-Funktion). Die naive
 * Suche nach der ersten Zeile "}" in Spalte 0 träfe eine davon — mitten im
 * Heredoc, lange vor dem echten Ende von `write_update_script` — und würde
 * den Prüfling stillschweigend abschneiden.
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

interface Szenario {
  /** Antwort von `docker inspect -f '{{.State.Running}}' <container>` nach dem Start. */
  laeuftStabil: boolean;
}

/**
 * Erzeugt via `write_update_script` einen echten Updater auf der Platte und
 * führt IHN gegen ein gefälschtes `docker` aus. Gibt jede protokollierte
 * `docker`-Aufrufzeile zurück (Argumente, space-getrennt, ohne `docker`
 * selbst — z. B. `"rm -f pulse-old"`).
 */
function fahreUpdate(szenario: Szenario): string[] {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const funktionstext = funktion(quelle, 'write_update_script');

  const arbeitsdir = mkdtempSync(join(tmpdir(), 'pulse-updater-'));
  const pulseDir = join(arbeitsdir, 'pulse');
  const updateSh = join(pulseDir, 'pulse-update.sh');
  const dockerLog = join(arbeitsdir, 'docker-aufrufe.log');

  // Schritt 1: den echten Updater erzeugen. Kein Docker im Spiel — reines
  // Schreiben. IMAGE zeigt bewusst NICHT auf registry.howispulse.com, damit
  // der Registry-Login-Zweig (separat getestet gehörig) hier aussen vor
  // bleibt; CLIENT_ID/CLIENT_SECRET sind trotzdem gesetzt, weil
  // write_update_script sie unbedingt referenziert, sobald das Muster doch
  // greifen sollte.
  const generator = `
set -uo pipefail
PULSE_DIR="${pulseDir}"
IMAGE="ghcr.io/beispiel/pulse-allinone:edge"
CONTAINER="pulse"
UPDATE_SH="${updateSh}"
CLIENT_ID="dummy-client"
CLIENT_SECRET="dummy-secret"
RUN_ARGS=( -d --name "$CONTAINER" --restart unless-stopped ghcr.io/beispiel/pulse-allinone:edge )
${funktionstext}
write_update_script
`;
  execFileSync('bash', ['-c', generator], { encoding: 'utf8' });

  // Schritt 2: gefälschtes `docker` — protokolliert jeden Aufruf vollständig
  // und antwortet auf `inspect -f '{{.State.Running}}'` gemäss Szenario. Der
  // Formatstring (falls vorhanden) kann bei `inspect` an beliebiger Position
  // stehen (`-f FMT ZIEL` oder `--format FMT ZIEL`) — deshalb wird über alle
  // Argumente nach einem `{{…}}`-Muster gesucht statt eine feste Position
  // anzunehmen.
  writeFileSync(
    join(arbeitsdir, 'docker'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "\${DOCKER_LOG}"
case "$1" in
  pull) exit 0 ;;
  image)
    case "$2" in
      inspect) echo 'sha256:neu'; exit 0 ;;
      rm) exit 0 ;;
    esac
    exit 0 ;;
  inspect)
    format=""
    for arg in "$@"; do
      case "$arg" in
        *'{{'*) format="$arg" ;;
      esac
    done
    case "$format" in
      *State.Running*)
        if [ "\${LAEUFT_STABIL}" = "1" ]; then echo 'true'; else echo 'false'; fi
        exit 0 ;;
      *Image*) echo 'sha256:alt'; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(join(arbeitsdir, 'docker'), 0o755);

  // Schritt 3: den generierten Updater wirklich ausführen — das ist der
  // Prüfling, nicht sein Quelltext. VERSUCHE/INTERVALL auf das Minimum
  // gesetzt, damit der Testlauf nicht die produktiven 15 Sekunden wartet.
  // Der Rollback-Zweig endet bewusst mit `exit 1` — das ist hier ein
  // gültiges Testergebnis, kein Infrastrukturfehler, also wird der Exit-Code
  // nicht durchgereicht.
  try {
    execFileSync(updateSh, [], {
      env: {
        ...process.env,
        PATH: `${arbeitsdir}:${process.env.PATH}`,
        DOCKER_LOG: dockerLog,
        LAEUFT_STABIL: szenario.laeuftStabil ? '1' : '0',
        PULSE_UPDATE_STABIL_VERSUCHE: '1',
        PULSE_UPDATE_STABIL_INTERVALL: '0'
      },
      encoding: 'utf8'
    });
  } catch (fehler) {
    // Nur ein regulärer Nicht-Null-Exit (Rollback) ist erwartet — alles
    // andere (z. B. das Skript wurde gar nicht gefunden/ausgeführt) soll
    // durchschlagen.
    const status = (fehler as { status?: number | null }).status;
    if (status !== 1) throw fehler;
  }

  return readFileSync(dockerLog, 'utf8')
    .split('\n')
    .filter((z) => z.length > 0);
}

test('ein Container, der sofort stirbt, gilt NICHT als erfolgreicher Start', () => {
  const befehle = fahreUpdate({ laeuftStabil: false });

  // "rm -f <name>-old" darf hier nur EINMAL vorkommen — die Aufräumzeile VOR
  // dem Update (Rest eines früheren Fehlversuchs). Die zweite, die den
  // Rollback-Container nach einem vermeintlichen Erfolg löscht, darf nicht
  // laufen.
  const rmAlt = befehle.filter((z) => z.startsWith('rm -f') && z.endsWith('-old')).length;
  assert.equal(rmAlt, 1, `erwartet genau 1x "rm -f *-old", bekommen: ${JSON.stringify(befehle)}`);

  // Das alte Image darf nicht weg sein — sonst ist die Vorversion nicht mehr
  // adressierbar (rollender Tag).
  assert.equal(
    befehle.some((z) => z.startsWith('image rm')),
    false,
    'das alte Image wurde entfernt, obwohl der neue Container nicht stabil lief'
  );

  // Der Rollback muss tatsächlich stattgefunden haben: der alte Container
  // kommt zurück und wird gestartet.
  assert.ok(befehle.includes('rename pulse-old pulse'), 'Rollback fehlt: pulse-old wurde nicht zu pulse zurückbenannt');
  assert.ok(befehle.includes('start pulse'), 'Rollback fehlt: pulse wurde nach dem Zurückbenennen nicht gestartet');
});

test('ein Container, der stabil läuft, gilt als Erfolg', () => {
  // Gegenprobe — sonst bestünde der erste Test auch, wenn der Updater nach
  // einem erfolgreichen Update gar nichts mehr täte.
  const befehle = fahreUpdate({ laeuftStabil: true });

  const rmAlt = befehle.filter((z) => z.startsWith('rm -f') && z.endsWith('-old')).length;
  assert.equal(rmAlt, 2, `erwartet 2x "rm -f *-old" (vorher + Erfolgspfad), bekommen: ${JSON.stringify(befehle)}`);

  assert.equal(
    befehle.some((z) => z.startsWith('image rm')),
    true,
    'das alte Image wurde nach einem erfolgreichen Update nicht entfernt'
  );

  assert.ok(!befehle.includes('start pulse'), 'kein Rollback erwartet, aber pulse wurde neu gestartet');
});
