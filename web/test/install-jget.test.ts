/**
 * `jget` aus `web/static/install.sh` — JSON-Feld auslesen, python3-Zweig UND
 * Rueckfallzweig ohne python3 (Task 14, III·3).
 *
 * **Warum es diesen Test gibt.**
 *   1. `json.load(sys.stdin).get('$2','')` liefert das Vorgabe-`''` NUR, wenn
 *      der Schlüssel FEHLT. Steht der Schlüssel mit JSON-`null` im Feld
 *      (z. B. `admin_email` bei einem Bootstrap ohne hinterlegte Mail),
 *      liefert `.get()` das echte `None` zurück — `print(None)` schreibt den
 *      literalen Text `None` in die generierte `pulse.env`, keinen leeren
 *      String.
 *   2. Der Rückfallzweig ohne python3 endet bei einem NICHT gefundenen Feld
 *      mit `grep -o` ohne Treffer — das ist Exit 1. Unter `set -euo
 *      pipefail` (Skriptkopf) tötet das die Zuweisung `VAR="$(jget …)"`
 *      wortlos, unmittelbar nach dem Einlösen des Bootstrap-Tokens: eine
 *      Variablenzuweisung, deren Kommandosubstitution nicht-null endet,
 *      zählt in bash als fehlgeschlagener Befehl.
 *
 * **Wie das geht:** `jget` wird unverändert aus `install.sh` geschnitten
 * (derselbe heredoc-bewusste Schneider wie in den Nachbartests) und einmal
 * mit echtem `python3` auf dem PATH ausgeführt, einmal mit einem PATH, der
 * `python3` ausdrücklich NICHT enthält — ein auf grep/sed/tr/head reduziertes
 * Verzeichnis, damit `command -v python3` garantiert scheitert und nicht
 * zufällig doch ein System-python3 findet (der Testfall prüfte sonst den
 * falschen Zweig, ohne dass das auffiele).
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
 * — heredoc-bewusst (übernommen aus den Nachbartests, z. B.
 * `install-proxy-erkennung.test.ts`). Findet sie die Funktion nicht, schlägt
 * der Test hart fehl statt gegen eine leere Shell zu laufen und daran grün
 * vorbeizukommen.
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

/** Einfaches Escaping für ein einzelnes bash-single-quote-Literal. */
function shQuote(wert: string): string {
  return `'${wert.replace(/'/g, `'\\''`)}'`;
}

// Absoluter Pfad zu bash, einmalig über den normalen PATH aufgelöst. Für den
// Rückfalltest wird bash darüber DIREKT (ohne PATH-Suche) gestartet — der
// kuratierte PATH dort enthält bewusst nur die Werkzeuge, die `jget` selbst
// im Rückfallzweig braucht, nicht bash.
const BASH_ABS = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

/** Ruft `jget` MIT echtem python3 auf dem PATH auf (Normalfall). */
function jget(json: string, feld: string): string {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const skript = `
set -euo pipefail
${funktion(quelle, 'jget')}
jget ${shQuote(json)} ${shQuote(feld)}
`;
  return execFileSync(BASH_ABS, ['-c', skript], { encoding: 'utf8' }).trim();
}

interface Ergebnis {
  exit: number;
  wert: string;
}

/**
 * Ruft `jget` OHNE python3 auf dem PATH auf. Der PATH wird komplett auf ein
 * frisches Verzeichnis reduziert (nicht nur vorangestellt — sonst fände die
 * Suche python3 einfach weiter hinten im ererbten PATH), das nur
 * Wrapper-Skripte für grep/sed/tr/head enthält, die auf die echten Binaries
 * verweisen. python3 fehlt darin absichtlich.
 */
function jgetOhnePython3(json: string, feld: string): Ergebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-jget-'));
  for (const werkzeug of ['grep', 'sed', 'tr', 'head']) {
    const echterPfad = execFileSync(BASH_ABS, ['-c', `command -v ${werkzeug}`], {
      encoding: 'utf8'
    }).trim();
    writeFileSync(join(dir, werkzeug), `#!/bin/sh\nexec "${echterPfad}" "$@"\n`, { mode: 0o755 });
    chmodSync(join(dir, werkzeug), 0o755);
  }
  const skript = `
set -euo pipefail
${funktion(quelle, 'jget')}
jget ${shQuote(json)} ${shQuote(feld)}
`;
  try {
    const wert = execFileSync(BASH_ABS, ['-c', skript], {
      env: { PATH: dir },
      encoding: 'utf8'
    }).trim();
    return { exit: 0, wert };
  } catch (fehler) {
    const f = fehler as { status?: number | null };
    return { exit: f.status ?? 1, wert: '' };
  }
}

/**
 * Ruft `jget` MIT echtem python3 auf dem PATH auf, fängt einen Abbruch aber
 * ab statt ihn als Testinfrastruktur-Fehler zu werten — für N7
 * (Nachprüfung): eine Antwort mit Statuscode 200, die kein gültiges JSON
 * ist (Captive Portal, transparenter Proxy, WAF-Zwischenseite — `curl
 * -fsSL` folgt Weiterleitungen, `-f` greift nur bei Nicht-2xx), lässt
 * `json.load` mit `JSONDecodeError` abbrechen.
 */
function jgetMitPython3RobustAufrufen(json: string, feld: string): Ergebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const skript = `
set -euo pipefail
${funktion(quelle, 'jget')}
jget ${shQuote(json)} ${shQuote(feld)}
`;
  try {
    const wert = execFileSync(BASH_ABS, ['-c', skript], { encoding: 'utf8' }).trim();
    return { exit: 0, wert };
  } catch (fehler) {
    const f = fehler as { status?: number | null };
    return { exit: f.status ?? 1, wert: '' };
  }
}

test('JSON-null wird zu leer, nicht zum Text None', () => {
  assert.equal(jget('{"admin_email":null}', 'admin_email'), '');
});

test('N7: der python3-Zweig stirbt nicht wortlos an einer 200er-Antwort, die kein JSON ist', () => {
  const e = jgetMitPython3RobustAufrufen('<html><body>Captive Portal</body></html>', 'instance_id');
  assert.equal(e.exit, 0, `jget starb (Exit ${e.exit}) statt leer zurückzugeben`);
  assert.equal(e.wert, '');
});

test('der Rueckfallzweig ohne python3 toetet den Installer nicht', () => {
  // grep ohne Treffer endet mit 1; unter pipefail + set -e stirbt die
  // Zuweisung — wortlos, unmittelbar nach dem Einlösen des Tokens.
  const e = jgetOhnePython3('{"admin_email":null}', 'admin_email');
  assert.equal(e.exit, 0, `jget starb (Exit ${e.exit}) statt leer zurückzugeben`);
  assert.equal(e.wert, '');
});

test('der python3-Zweig liest ein vorhandenes Feld weiterhin normal', () => {
  // Gegenprobe: der Fix darf den Normalfall nicht kaputt machen.
  assert.equal(jget('{"admin_email":"a@b.example"}', 'admin_email'), 'a@b.example');
});

test('der Rueckfallzweig ohne python3 liest ein vorhandenes Feld weiterhin normal', () => {
  const e = jgetOhnePython3('{"admin_email":"a@b.example"}', 'admin_email');
  assert.equal(e.exit, 0);
  assert.equal(e.wert, 'a@b.example');
});
