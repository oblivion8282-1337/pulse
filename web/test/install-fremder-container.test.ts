/**
 * `web/static/install.sh` — zwei Lücken um denselben Container-Namen (I·4, H5).
 *
 * **I·4.** `docker rm -f "$CONTAINER"` entfernt vor dem Neustart den
 * vorhandenen Container, ohne zu prüfen, ob er überhaupt Pulse gehört. Ein
 * fremder Container, der zufällig `pulse` heisst (der Vorgabename), wäre
 * kommentarlos weg. Fix: `ist_unser_container()` prüft das IMAGE
 * (Substring `pulse-allinone`, Begründung im Kommentar dort).
 *
 * **NICHT geändert und NICHT hier getestet:** das zweite `docker rm -f
 * "$CONTAINER"` im Rollback-Zweig des GENERIERTEN Updaters
 * (`write_update_script`, s. `install-updater.test.ts`). Dort wurde der
 * Container Sekunden vorher vom Updater selbst erzeugt — eine
 * Identitätsprüfung liefe dort ins Leere und würde nur den Rollback
 * brechen.
 *
 * **H5.** `check_ports` übersprang die gesamte Portprüfung, sobald
 * `docker inspect "$CONTAINER"` gelang — das gelingt auch für einen
 * Container im Zustand `created`/`exited`, der keinen einzigen Port hält.
 * Nach einem Teilabbruch (Installer stirbt zwischen `docker run` und dem
 * Ende) prüfte ein zweiter Lauf dadurch gar nichts mehr, und ein echter
 * Fremdkonflikt auf z. B. 3478 verbrannte den Einmal-Token doch noch —
 * genau der Fall, für den die Prüfung überhaupt vor die Token-Einlösung
 * gezogen wurde (s. Kommentar bei ihrem Aufruf). Fix: die Zeile fragt jetzt
 * `eigener_container_laeuft` (Task 1, `.State.Running`) statt der blossen
 * Existenz.
 *
 * **Korrekturrunde 1 — die Identitätsprüfung selbst kam zu spät.** Die
 * erste Fassung dieses Fixes rief die neue Identitätsprüfung nur an EINER
 * Stelle auf: direkt vor dem tatsächlichen `docker rm -f`, in
 * `sichere_container_ersetzung` — die läuft im Hauptablauf aber erst NACH
 * der Token-Einlösung. Ein Fremdkonflikt brach den Lauf zwar sauber ab,
 * aber der Einmal-Token war zu diesem Zeitpunkt schon verbraucht (die
 * Freigabe ist laut `CLAUDE.md` „Single-Bootstrap pro Antrag" — ein
 * verbrannter Token kostet einen kompletten neuen Antrag samt erneuter
 * Freigabe durch den Cloud-Betreiber, nicht nur einen neuen Lauf). Fix:
 * dieselbe Prüfung (`pruefe_container_konflikt`, gemeinsame Hülle um
 * `ist_unser_container` + `die`) läuft jetzt ZUSÄTZLICH früh, direkt nach
 * `check_ports` und damit VOR der Token-Einlösung. Die späte Prüfung bleibt
 * bestehen — zwischen der frühen Prüfung und dem tatsächlichen Ersetzen
 * liegen Token-Einlösung und Image-Pull, spürbare Zeit, in der sich der
 * Containername theoretisch neu belegen liesse; ein Fremdkonflikt, der
 * GENAU in dieser Lücke entsteht, fände nur noch die späte Prüfung.
 *
 * **Wie das geht:** wie in den Nachbardateien werden die Shell-Funktionen
 * aus `install.sh` herausgeschnitten (heredoc-bewusster Schneider, aus
 * `install-updater.test.ts` übernommen — kein eigenständiger fünfter
 * Zuschnitt-Algorithmus im Testbaum) und mit einem gefälschten `docker` auf
 * dem PATH ausgeführt. Der Reihenfolge-Test (`reihenfolgeTest`) geht einen
 * Schritt weiter und führt einen wörtlich aus `install.sh` herausgeschnittenen
 * ZUSAMMENHÄNGENDEN AUSSCHNITT aus — von `check_ports` bis nach der
 * Token-Einlösung, inklusive der echten `curl`-Zeile —, gegen ein
 * gefälschtes `curl`, das eine Markerdatei hinterlässt, sobald es
 * aufgerufen wird. Ein Test, der nur behauptet „die Prüfung sitzt vor der
 * Einlösung" (weil er sie in dieser Reihenfolge selbst zusammenbaut), würde
 * eine künftige Umsortierung im echten Skript nicht bemerken — nur echter,
 * an Ort und Stelle ausgeführter Quelltext tut das.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

/**
 * Eine Shell-Funktion `name() { … }` bis zur schliessenden Klammer in Spalte 0
 * — heredoc-bewusst (übernommen aus `install-updater.test.ts`). Keine der
 * hier geschnittenen Funktionen enthält einen Heredoc, die Erkennung bleibt
 * trotzdem aktiv — derselbe Schneider für alle Fälle statt ein fünfter.
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
 * zwischen zwei eindeutigen Zeilen (beide inklusive) — für den
 * Reihenfolge-Test. Anders als `funktion()` schneidet das keine benannte
 * Funktion aus, sondern ein Stück des Hauptablaufs: genau der Bereich, der
 * beweisen soll, dass die frühe Prüfung wirklich VOR der echten
 * `curl`-Zeile steht, mit echtem Quelltext statt einer im Test
 * nachgebauten Reihenfolge.
 */
function bereich(quelle: string, vonZeile: string, bisZeileEnthaelt: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.trim() === vonZeile);
  assert.notEqual(start, -1, `Startanker "${vonZeile}" nicht gefunden — Skript umgebaut?`);
  const ende = zeilen.findIndex((z, i) => i > start && z.includes(bisZeileEnthaelt));
  assert.notEqual(ende, -1, `Endanker "${bisZeileEnthaelt}" nicht gefunden — Skript umgebaut?`);
  return zeilen.slice(start, ende + 1).join('\n');
}

interface Uebernahme {
  /** Hat `sichere_container_ersetzung` mit `die` abgebrochen? */
  abgebrochen: boolean;
  /** Die an `die` übergebene Meldung (leer, wenn nicht abgebrochen). */
  meldung: string;
}

/**
 * Führt `sichere_container_ersetzung` — die SPÄTE Prüfung, direkt vor dem
 * tatsächlichen `docker rm -f` — gegen ein gefälschtes `docker` aus.
 * `container === null` heisst: es existiert noch gar kein Container namens
 * `$CONTAINER` (Erstinstallation auf einer frischen Maschine) — `docker
 * inspect` scheitert dann komplett, kein Konflikt möglich, kein Abbruch.
 */
function pruefeUebernahme(container: { image: string } | null): Uebernahme {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-fremder-container-'));

  // Gefälschtes `docker`: `inspect "$CONTAINER"` (blosse Existenz) und
  // `inspect -f '{{.Config.Image}}' "$CONTAINER"` (Identität). Beide Aufrufe
  // betreffen denselben Container, brauchen aber unterschiedliche Antworten
  // — Unterscheidung über den Inhalt von `"$*"`, wie in
  // `install-eigener-container.test.ts`.
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  inspect)
    case "$*" in
      *Config.Image*) ${container ? `echo '${container.image}'` : 'exit 1'} ;;
      *) ${container ? 'exit 0' : 'exit 1'} ;;
    esac ;;
  rm) exit 0 ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  // `die` wird durch eine Markerzeile ersetzt statt die echte (farbige,
  // mehrzeilige) Fassung zu prüfen — hier zählt nur: wurde abgebrochen, und
  // mit welcher Meldung. Eine Markerzeile NACH dem Aufruf zeigt den
  // Nicht-Abbruch-Pfad an (dasselbe Muster wie in install-crontab.test.ts).
  const skript = `
set -uo pipefail
CONTAINER=pulse
die() { printf '__DIE__%s\\n' "$*"; exit 9; }
${funktion(quelle, 'ist_unser_container')}
${funktion(quelle, 'pruefe_container_konflikt')}
${funktion(quelle, 'sichere_container_ersetzung')}
sichere_container_ersetzung
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
    abgebrochen: !stdout.includes('__UEBERLEBT__'),
    meldung: treffer ? treffer[1] : ''
  };
}

/**
 * Führt `check_ports` gegen ein gefälschtes `docker` aus, das den
 * EXISTIERENDEN eigenen Container im gewünschten Laufzustand meldet.
 * `port_busy` meldet dabei IMMER "belegt" — das macht sichtbar, ob
 * `check_ports` wirklich bis zur Portprüfung durchläuft (dann `die`, der
 * Prozess stirbt) oder vorher überspringt (dann läuft er glatt durch).
 */
function portpruefungLaeuft(optionen: { running: boolean }): boolean {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-portpruefung-'));

  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) echo '${optionen.running ? 'true' : 'false'}' ;;
      *) exit 0 ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  const skript = `
set -uo pipefail
CONTAINER=pulse
MODE=greenfield
HTTP_PORT=8080
die() { exit 9; }
port_busy() { return 0; }
udp_port_busy() { return 1; }
${funktion(quelle, 'eigener_container_laeuft')}
${funktion(quelle, 'check_ports')}
check_ports
`;
  try {
    execFileSync('bash', ['-c', skript], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8'
    });
    return false; // durchgerauscht -> die Portpruefung hat NICHT wirklich stattgefunden
  } catch {
    return true; // die() wurde erreicht -> die Portpruefung lief wirklich
  }
}

interface Reihenfolge {
  /** Wurde `curl` (= die Token-Einlösung) überhaupt aufgerufen? */
  tokenAngefasst: boolean;
  /** Wurde das Ende des Ausschnitts erreicht (nach der Einlösung)? */
  ueberlebt: boolean;
  /** Die an `die` übergebene Meldung (leer, wenn nicht abgebrochen). */
  meldung: string;
}

/**
 * Führt den echten, wörtlich herausgeschnittenen Ausschnitt von `check_ports`
 * bis zur Zeile nach der Token-Einlösung aus — inklusive der frühen
 * `pruefe_container_konflikt`-Zeile UND der echten `curl`-Zeile. `curl` ist
 * gefälscht und hinterlässt eine Markerdatei, sobald es aufgerufen wird —
 * das ist der direkte Beweis, ob die Token-Einlösung versucht wurde, nicht
 * nur eine Vermutung über eine Zeilennummer. Liefert bei Erfolg zusätzlich
 * eine gültige JSON-Antwort, damit der Gegenprobe-Fall (kein Konflikt)
 * tatsächlich bis ans Ende durchläuft, statt an einer geschluckten
 * `jget`-Fehlermeldung hängenzubleiben — sonst bliebe unklar, ob ein
 * Nicht-Erreichen am Konflikt oder an einem kaputten Testgeschirr liegt.
 */
function reihenfolgeTest(container: { image: string } | null): Reihenfolge {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-reihenfolge-'));
  const curlMarker = join(dir, 'curl-aufgerufen');

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

  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/bash
touch "${curlMarker}"
cat <<'JSON'
{"instance_id":"1","owner_user_id":"2","hostname":"test.invalid","client_id":"cid","client_secret":"csecret","admin_email":"a@test.invalid","cloud_origin":"http://cloud.invalid"}
JSON
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'curl'), 0o755);

  const skript = `
set -uo pipefail
CONTAINER=pulse
MODE=greenfield
HTTP_PORT=8080
CLOUD_ORIGIN=http://cloud.invalid
TOKEN=testtoken
log()  { :; }
warn() { :; }
err()  { :; }
die()  { printf '__DIE__%s\\n' "$*"; exit 9; }
port_busy() { return 1; }
udp_port_busy() { return 1; }
${funktion(quelle, 'eigener_container_laeuft')}
${funktion(quelle, 'ist_unser_container')}
${funktion(quelle, 'pruefe_container_konflikt')}
${funktion(quelle, 'check_ports')}
${funktion(quelle, 'jget')}
${bereich(quelle, 'check_ports', 'log "Instance: ${SRV_HOST} (ID ${INSTANCE_ID})"')}
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
    tokenAngefasst: existsSync(curlMarker),
    ueberlebt: stdout.includes('__UEBERLEBT__'),
    meldung: treffer ? treffer[1] : ''
  };
}

test('ein fremder Container namens pulse wird nicht angerührt', () => {
  const ergebnis = pruefeUebernahme({ image: 'postgres:16' });
  assert.equal(ergebnis.abgebrochen, true);
  assert.match(ergebnis.meldung, /PULSE_CONTAINER/);
});

test('die späte Meldung sagt ausdrücklich: der Token ist schon verbraucht', () => {
  // Ergänzung aus Korrekturrunde 1: an der SPÄTEN Stelle ist der
  // Einmal-Token zu diesem Zeitpunkt im echten Ablauf bereits eingelöst —
  // die Meldung soll das sagen, statt den Eindruck zu erwecken, ein
  // erneuter Versuch mit demselben Token wäre möglich.
  const ergebnis = pruefeUebernahme({ image: 'postgres:16' });
  assert.match(ergebnis.meldung, /already been redeemed/i);
});

test('unser eigener Container wird übernommen', () => {
  const ergebnis = pruefeUebernahme({ image: 'registry.howispulse.com/pulse-allinone:edge' });
  assert.equal(ergebnis.abgebrochen, false);
});

test('ein eigenes Image an einem eigenen Spiegel wird trotz anderem Registry-Pfad erkannt', () => {
  // PULSE_IMAGE ist überschreibbar — ein Betreiber mit eigenem Spiegel/Fork
  // darf nicht ausgesperrt werden, solange der Repository-Name erhalten
  // bleibt. Gegenprobe zum Substring-Kriterium.
  const ergebnis = pruefeUebernahme({ image: 'ghcr.io/eigenerfork/pulse-allinone:v2' });
  assert.equal(ergebnis.abgebrochen, false);
});

test('keine Kollision, wenn noch gar kein Container existiert', () => {
  const ergebnis = pruefeUebernahme(null);
  assert.equal(ergebnis.abgebrochen, false);
});

test('ein GESTOPPTER eigener Container schaltet die Portprüfung nicht ab', () => {
  // `docker inspect` gelingt auch für exited-Container, die keinen Port halten.
  assert.equal(portpruefungLaeuft({ running: false }), true);
});

test('ein LAUFENDER eigener Container schaltet die Portprüfung weiterhin ab', () => {
  // Gegenprobe — sonst bestünde der Test oben auch, wenn check_ports die
  // Ausnahme für einen laufenden eigenen Container ganz verloren hätte.
  assert.equal(portpruefungLaeuft({ running: true }), false);
});

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
  assert.equal(ergebnis.ueberlebt, true);
});
