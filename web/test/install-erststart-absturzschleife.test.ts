/**
 * `web/static/install.sh` — die Warteschleife der Erstinstallation
 * (Abschnitt "6) Warten, bis der Container fertig ist"), Nachtrag zur
 * Schlussprüfung von Fund 1.
 *
 * **Der Fund.** Der Kommentar über der Prüfung sagte schon das Richtige
 * ("Ein Container, der nicht mehr läuft, wird auch nicht mehr fertig"), aber
 * die Bedingung erkannte den häufigsten Fall nicht: sie fragte nur
 * `.State.Running`, das Docker — genau wie bei Fund 1 — während der
 * GESAMTEN Neustart-Rückstufung auf `true` hält. Ein Container im
 * Absturzkarussell (falsches Env, kaputtes Volume, …) sass die Schleife
 * also bis zum Zeitlimit aus, statt sofort erkannt zu werden — der
 * wahrscheinlichste Fehlschlag einer Erstinstallation überhaupt, und genau
 * der Fall, für den dieser ganze Abschnitt existiert (er soll sagen, WO es
 * hängt).
 *
 * **Der Fix.** Dieselbe Erkennung wie in `container_laeuft_stabil()`
 * (Fund 1): `.RestartCount` + `.State.Status` in einem Aufruf. Steigt der
 * Zähler, ist es eine Neustartschleife — und bekommt eine EIGENE Meldung,
 * nicht "the step marked FAILED above is where it stopped": in diesem Fall
 * steht dort oben gar kein FAILED, der Container starb, bevor er einen
 * weiteren Schritt in `setup-status` schreiben konnte.
 *
 * **Wie das geht:** zwei wörtlich aus `install.sh` herausgeschnittene
 * Ausschnitte (Muster aus `install-fremder-container.test.ts`/
 * `install-schluss-reihenfolge.test.ts`):
 *   1. Die Erkennung EINER Schleifenrunde — kein echtes `sleep`, keine 60
 *      Wiederholungen (das wäre dasselbe Zeitlimit, das der Fund gerade
 *      umgeht — die Wiederholung selbst ist nicht Teil des Fundes, nur die
 *      Erkennung innerhalb einer Runde).
 *   2. Der Meldungsblock danach, der entscheidet, welcher Text erscheint.
 *
 * **`set -euo pipefail`, nicht nur `-uo pipefail` (Nachtrag, Nachprüfung
 * N3).** Das echte `install.sh` läuft mit `-e`; ohne sie in diesem
 * Testgeschirr hätte die Suite N1 (unten) gar nicht fangen können — eine
 * ungeschützte `WERTE="$(docker inspect … )"` OHNE `|| WERTE=""` stirbt
 * unter `-e` wortlos, wenn `docker inspect` fehlschlägt, bleibt aber unter
 * blossem `-u` folgenlos (die Variable wird einfach leer). Das war der
 * blinde Fleck, durch den der Fehler durchrutschte.
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

interface RundenOptionen {
  /** '.RestartCount' laut Docker. Ignoriert, wenn `inspectSchlaegtFehl`. */
  restartCount?: number;
  /** '.State.Status' laut Docker (z. B. 'running', 'restarting', 'exited'). */
  status?: string;
  /**
   * `docker inspect` schlägt komplett fehl (leere Ausgabe, Exit ungleich 0)
   * — der Fall aus N1 (Nachprüfung): der Container ist zwischen zwei Runden
   * ganz verschwunden, oder die Docker-API hustet einmal.
   */
  inspectSchlaegtFehl?: boolean;
}

interface RundenErgebnis {
  abbruch: boolean;
  abbruchCrash: boolean;
  /**
   * Ist das Skript VOR "__UEBERLEBT__" gestorben? N1: eine ungeschützte
   * Kommandosubstitution unter `set -e` tötet das Skript wortlos, sobald
   * `docker inspect` fehlschlägt — kein `ABBRUCH`, keine Meldung, einfach
   * nichts mehr.
   */
  abgestuerzt: boolean;
}

/**
 * Führt GENAU EINE Runde der Erkennungslogik aus — `docker exec … cat
 * /data/setup-status` schlägt in jedem Fall fehl (STATUS_ROH bleibt leer):
 * das bildet exakt den vom Fund beschriebenen Fall ab, in dem der Container
 * stirbt, bevor er überhaupt einen weiteren Schritt schreiben konnte.
 */
function laufeRunde(optionen: RundenOptionen): RundenErgebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-absturzschleife-'));

  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  exec) exit 1 ;;
  inspect)
    ${
      optionen.inspectSchlaegtFehl
        ? 'exit 1'
        : `printf '%s %s\\n' "${optionen.restartCount ?? 0}" "${optionen.status ?? 'running'}"`
    } ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  // Echte Ein-Runden-Schleife statt des nackten Ausschnitts: der enthält
  // 'break' (aus dem uebernommenen awk-Zweig UND der neuen Erkennung) —
  // ausserhalb einer echten Schleife meldet bash das als Warnung auf
  // stderr, statt einfach den naechsten Schleifendurchlauf zu beenden.
  //
  // 'set -euo pipefail', nicht nur '-uo pipefail' — s. Dateikopf (N3). Die
  // ECHTE install.sh läuft mit '-e'; das Testgeschirr muss das auch, sonst
  // kann es N1 (ungeschützte Kommandosubstitution) gar nicht sehen.
  const skript = `
set -euo pipefail
CONTAINER=pulse
GESEHEN=0
FERTIG=""
ABBRUCH=""
ABBRUCH_CRASH=""
for _ in 1; do
${bereich(
  quelle,
  'STATUS_ROH="$(docker exec "$CONTAINER" cat /data/setup-status 2>/dev/null || true)"',
  'Zustandserkennung Ende'
)}
done
echo "ABBRUCH=$ABBRUCH"
echo "ABBRUCH_CRASH=$ABBRUCH_CRASH"
echo "__UEBERLEBT__"
`;
  try {
    const ausgabe = execFileSync('bash', ['-c', skript], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8'
    });
    return {
      abbruch: /^ABBRUCH=1$/m.test(ausgabe),
      abbruchCrash: /^ABBRUCH_CRASH=1$/m.test(ausgabe),
      abgestuerzt: !ausgabe.includes('__UEBERLEBT__')
    };
  } catch (fehler) {
    // Ein nicht-abgefangener Fehler (set -e) beendet bash mit Exit != 0 —
    // execFileSync wirft dann, statt die Ausgabe schlicht zurückzugeben.
    // Genau DAS ist der Fall, den N1 beschreibt: kein 'ABBRUCH=…', keine
    // Meldung, das Skript ist einfach weg.
    const f = fehler as { stdout?: string };
    const ausgabe = f.stdout ?? '';
    return {
      abbruch: /^ABBRUCH=1$/m.test(ausgabe),
      abbruchCrash: /^ABBRUCH_CRASH=1$/m.test(ausgabe),
      abgestuerzt: true
    };
  }
}

/** Führt den Meldungsblock nach der Schleife aus und liefert die stderr-Ausgabe. */
function meldungFuer(abbruch: boolean, abbruchCrash: boolean): string {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const skript = `
set -euo pipefail
CONTAINER=pulse
FERTIG=""
ABBRUCH="${abbruch ? '1' : ''}"
ABBRUCH_CRASH="${abbruchCrash ? '1' : ''}"
err()  { printf '%s\\n' "$*" >&2; }
warn() { printf '%s\\n' "$*" >&2; }
${bereich(quelle, 'if [ -n "$ABBRUCH_CRASH" ]; then', 'Startup is taking longer than expected')}
`;
  try {
    execFileSync('bash', ['-c', skript], { encoding: 'utf8' });
    return '';
  } catch (fehler) {
    const f = fehler as { stderr?: string };
    return f.stderr ?? '';
  }
}

test('eine Neustartschleife (RestartCount > 0) wird erkannt, obwohl State.Running true bleibt', () => {
  const ergebnis = laufeRunde({ restartCount: 3, status: 'restarting' });
  assert.equal(ergebnis.abbruchCrash, true, 'die Absturzschleife wurde nicht erkannt');
  assert.equal(ergebnis.abbruch, true, 'ABBRUCH muss bei einer Absturzschleife ebenfalls gesetzt sein');
});

test('Gegenprobe: eine gesunde, noch laufende Erstinstallation bricht nicht ab', () => {
  // Sonst bestünde der Test oben auch, wenn die Erkennung JEDEN Container
  // fälschlich als Absturzschleife werten würde.
  const ergebnis = laufeRunde({ restartCount: 0, status: 'running' });
  assert.equal(ergebnis.abbruch, false);
  assert.equal(ergebnis.abbruchCrash, false);
});

test('N1: ein fehlschlagender docker inspect tötet die Warteschleife nicht wortlos', () => {
  // Nachprüfung, N1 (landungskritisch): 'WERTE="$(docker inspect …)"' ohne
  // '|| WERTE=""' — unter 'set -e' ist der Exit-Status einer einfachen
  // Zuweisung der Exit-Status der Kommandosubstitution. Schlägt
  // 'docker inspect' fehl (Container zwischen zwei Runden verschwunden,
  // Docker-API hustet einmal), stirbt das Skript an dieser Stelle sofort
  // und wortlos — kein ABBRUCH, keine Meldung, einfach nichts mehr. Nach
  // verbranntem Token, vor der Routen-Anweisung, vor der Aussen-Prüfung.
  const ergebnis = laufeRunde({ inspectSchlaegtFehl: true });
  assert.equal(
    ergebnis.abgestuerzt,
    false,
    'das Skript ist wortlos gestorben, statt geordnet weiterzulaufen'
  );
  // Kein Container mehr erreichbar ist derselbe Fall wie "existiert nicht
  // mehr" — generischer Abbruch, keine Absturzschleife (die ist ja gerade
  // NICHT nachgewiesen, nur nicht mehr erreichbar).
  assert.equal(ergebnis.abbruch, true);
  assert.equal(ergebnis.abbruchCrash, false);
});

test('ein manuell gestoppter Container (RestartCount 0, nicht running) bricht weiterhin ab — aber NICHT als Absturzschleife', () => {
  // Der ursprüngliche Fall, für den die Prüfung ursprünglich geschrieben
  // wurde (Container existiert, läuft aber nicht mehr, hat sich nie
  // neu gestartet) — bleibt erhalten, mit der ALTEN, generischen Meldung.
  const ergebnis = laufeRunde({ restartCount: 0, status: 'exited' });
  assert.equal(ergebnis.abbruch, true);
  assert.equal(ergebnis.abbruchCrash, false);
});

test('die Absturzschleifen-Meldung ersetzt "the step marked FAILED", statt sie zu verdoppeln', () => {
  const ausgabe = meldungFuer(true, true);
  assert.match(ausgabe, /restart loop/i);
  assert.doesNotMatch(ausgabe, /step marked FAILED/);
  assert.match(ausgabe, /docker logs pulse/);
});

test('Gegenprobe: der saubere Abbruch zeigt weiterhin "the step marked FAILED"', () => {
  // Sonst bestünde der Test oben auch, wenn die Fallunterscheidung im
  // Meldungsblock verlorenginge und immer dieselbe Meldung erschiene.
  const ausgabe = meldungFuer(true, false);
  assert.match(ausgabe, /step marked FAILED/);
  assert.doesNotMatch(ausgabe, /restart loop/i);
});
