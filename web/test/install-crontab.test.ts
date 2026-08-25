/**
 * `install_update_cron` aus `web/static/install.sh` — der Fallback-Pfad für
 * einen Nicht-root-Install (Docker-Gruppen-User ohne systemd): Auto-Update
 * über die eigene User-Crontab statt über einen System-Timer.
 *
 * **Warum es diesen Test gibt.** `crontab -l` endet bei leerer/fehlender
 * Crontab mit Exit 1 und schweigt. `grep -vF "$UPDATE_SH"` bekommt dann
 * leeren Input und endet EBENFALLS mit 1 (kein Treffer für `-v` = nichts
 * ausgewählt). Unter `set -euo pipefail` (Skriptkopf, Zeile 23) reisst das
 * die ganze `{ … }`-Gruppe ab, BEVOR `echo "$entry"` läuft — `crontab -`
 * bekommt leere Eingabe und installiert eine leere Crontab. Weil
 * `install_update_cron` selbst ungeprüft im Hauptablauf steht, beendet
 * `set -e` danach den GESAMTEN Installer mit Exit 1 — und zwar NACHDEM der
 * Container schon läuft und BEVOR die Proxy-Route ausgegeben wird. Der Admin
 * hat dann einen laufenden Server, einen verbrannten Einmal-Token und keine
 * Anweisung, was ihm noch fehlt.
 *
 * Betroffen ist genau die ERSTE Installation auf einer frischen Maschine
 * (dort existiert naturgemäss noch keine Crontab) — der häufigste Fall des
 * gesamten Nicht-root-Zweigs, nicht ein Rand.
 *
 * Der Fix ist ein `|| true` am Ende der Pipeline: ein leerer `grep`-Treffer
 * ist hier ein Normalzustand (keine Crontab bisher, oder die Crontab enthält
 * nach dem Herausfiltern nichts mehr), kein Fehler.
 *
 * **Zweiter, ebenso wichtiger Fall:** dieselbe Falle schnappt auch dann zu,
 * wenn die Crontab NICHT leer ist, sondern ausschliesslich den eigenen
 * `pulse-update.sh`-Eintrag aus einem früheren Lauf enthält — `grep -vF`
 * filtert dann alles heraus und steht wieder mit leerem Ergebnis da. Ein
 * Test, der nur die komplett leere Crontab prüft, würde das nicht fangen.
 *
 * **Wie das geht:** wie in `install-updater.test.ts` wird die Shell-Funktion
 * aus `install.sh` herausgeschnitten und gegen ein gefälschtes `crontab` auf
 * dem PATH ausgeführt (Funktions-Schneider hier heredoc-bewusst übernommen,
 * obwohl `install_update_cron` selbst keinen Heredoc enthält — kein
 * eigenständiger vierter Zuschnitt-Algorithmus im Testbaum). Geprüft wird
 * nicht nur der installierte Inhalt, sondern auch, ob die Zeile NACH dem
 * Funktionsaufruf überhaupt erreicht wurde (Exit-1-Fallen unter `set -e`
 * können ansonsten unbemerkt vorbeirauschen, wenn das Testgeschirr den
 * Fehler selbst verschluckt — siehe Nachtrag des Controllers im Task-Brief).
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
 * — heredoc-bewusst (übernommen aus `install-updater.test.ts`). Für
 * `install_update_cron` gibt es keinen Heredoc im Rumpf, die Heredoc-Erkennung
 * bleibt trotzdem harmlos aktiv — genau deshalb reicht dieser eine Schneider
 * für alle Fälle, statt für jede Funktion einen eigenen zu bauen.
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

interface Optionen {
  /** Es existiert noch gar keine Crontab (`crontab -l` scheitert, wie auf einer frischen Maschine). */
  crontabLeer: boolean;
  /** Eine bestehende Fremdzeile, die erhalten bleiben muss. */
  fremd?: string;
  /**
   * Die Crontab enthält bereits AUSSCHLIESSLICH unseren eigenen Eintrag aus
   * einem früheren Lauf — der zweite, leicht übersehene Auslöser derselben
   * Falle (siehe Docstring oben).
   */
  nurEigenerEintragVorher?: boolean;
}

interface Ergebnis {
  exit: number;
  /** Inhalt der Crontab NACH dem Lauf ('' wenn `crontab -` nie aufgerufen wurde oder leer geschrieben hat). */
  installiert: string;
  /** Wurde die Zeile NACH dem Aufruf von `install_update_cron` im Skript erreicht? */
  nachAufrufErreicht: boolean;
}

/**
 * Führt `install_update_cron` echt aus — gegen ein gefälschtes `crontab` auf
 * dem PATH. `crontab -l` (lesen) und `crontab -` (schreiben) liegen dabei
 * bewusst in ZWEI getrennten Dateien, nicht in einer gemeinsamen: die
 * geprüfte Pipeline startet beide Aufrufe als Teil derselben Shell-Pipeline,
 * also nebenläufig — ein einziger Zustandsspeicher für beide Richtungen
 * bringt eine Race zwischen dem `cat`, das ihn liest, und dem `cat >`, das
 * ihn im selben Moment trunkiert (erst am echten Lauf entdeckt: der
 * Fremdeintrag-Testfall schlug reproduzierbar fehl, weil der Schreiber die
 * Datei leerte, bevor der Leser fertig war — kein Bug im Skript, einer im
 * Testgeschirr). `crontab -l` verhält sich sonst exakt wie das echte
 * Kommando: existiert noch keine Crontab, endet es (unterdrückt via
 * `2>/dev/null` im Prüfling) mit Exit 1, ohne etwas auszugeben.
 */
function installiereCron(optionen: Optionen): Ergebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const funktionstext = funktion(quelle, 'install_update_cron');

  const arbeitsdir = mkdtempSync(join(tmpdir(), 'pulse-crontab-'));
  const crontabRead = join(arbeitsdir, 'crontab-read');
  const crontabWrite = join(arbeitsdir, 'crontab-write');
  const pulseDir = join(arbeitsdir, 'pulse');
  const updateSh = join(pulseDir, 'pulse-update.sh');

  if (optionen.fremd) {
    writeFileSync(crontabRead, `${optionen.fremd}\n`);
  } else if (optionen.nurEigenerEintragVorher) {
    writeFileSync(
      crontabRead,
      `*/5 * * * * ${updateSh} >> ${pulseDir}/pulse-update.log 2>&1\n`
    );
  } else if (!optionen.crontabLeer) {
    assert.fail('Optionen widersprüchlich: crontabLeer=false ohne fremd/nurEigenerEintragVorher');
  }

  writeFileSync(
    join(arbeitsdir, 'crontab'),
    `#!/bin/bash
# Lesen ($CRONTAB_READ) und Schreiben ($CRONTAB_WRITE) sind bewusst getrennte
# Dateien — siehe Docstring von installiereCron().
case "$1" in
  -l)
    if [ -f "$CRONTAB_READ" ]; then
      cat "$CRONTAB_READ"
      exit 0
    fi
    echo "no crontab for user" >&2
    exit 1
    ;;
  -)
    cat > "$CRONTAB_WRITE"
    exit 0
    ;;
  *)
    echo "gefaelschtes crontab: unbekanntes Argument $*" >&2
    exit 2
    ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(arbeitsdir, 'crontab'), 0o755);

  // Deckt exakt die Struktur aus install.sh nach: Skriptkopf-Flags, die
  // beiden von install_update_cron referenzierten Variablen, der Prüfling,
  // dann eine Markerzeile, die nur erreicht wird, wenn der Aufruf NICHT
  // vorzeitig unter `set -e` abbricht (s. Nachtrag im Task-Brief — die Falle
  // dort war, ein `||` um den Aufruf zu legen und damit `set -e` selbst
  // auszuhebeln; hier läuft install_update_cron deshalb ungeschützt, genau
  // wie im echten Skript).
  const generator = `
set -euo pipefail
UPDATE_SH="${updateSh}"
PULSE_DIR="${pulseDir}"
${funktionstext}
install_update_cron
echo "__NACH_INSTALL_UPDATE_CRON__"
`;

  let exit = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', ['-c', generator], {
      env: {
        ...process.env,
        PATH: `${arbeitsdir}:${process.env.PATH}`,
        CRONTAB_READ: crontabRead,
        CRONTAB_WRITE: crontabWrite
      },
      encoding: 'utf8'
    });
  } catch (fehler) {
    const f = fehler as { status?: number | null; stdout?: string };
    exit = f.status ?? 1;
    stdout = f.stdout ?? '';
  }

  const installiert = existsSync(crontabWrite) ? readFileSync(crontabWrite, 'utf8') : '';
  return { exit, installiert, nachAufrufErreicht: stdout.includes('__NACH_INSTALL_UPDATE_CRON__') };
}

test('erste Installation ohne bestehende crontab schreibt den Eintrag', () => {
  const ergebnis = installiereCron({ crontabLeer: true });
  assert.equal(ergebnis.exit, 0, `Installer starb (Exit ${ergebnis.exit}) statt die crontab zu schreiben`);
  assert.ok(ergebnis.nachAufrufErreicht, 'die Zeile nach install_update_cron wurde nicht erreicht — set -e hat abgebrochen');
  assert.match(ergebnis.installiert, /pulse-update\.sh/);
});

test('ein bestehender Fremdeintrag bleibt erhalten', () => {
  const ergebnis = installiereCron({ crontabLeer: false, fremd: '0 3 * * * /usr/bin/fremd' });
  assert.equal(ergebnis.exit, 0);
  assert.ok(ergebnis.nachAufrufErreicht);
  assert.match(ergebnis.installiert, /\/usr\/bin\/fremd/);
  assert.match(ergebnis.installiert, /pulse-update\.sh/);
});

test('eine crontab, die ausschliesslich den eigenen Eintrag enthält, tappt in dieselbe Falle', () => {
  // Zweiter Auslöser derselben Ursache: nicht die leere Crontab der ersten
  // Installation, sondern ein WIEDERHOLTER Lauf, bei dem grep -vF den
  // einzigen vorhandenen (eigenen) Eintrag komplett herausfiltert und
  // ebenfalls mit leerem Ergebnis und Exit 1 dasteht. Ohne diesen Test
  // bliebe unbelegt, ob der Fix nur den Erstlauf oder wirklich die Ursache
  // (ein leeres grep-Ergebnis in der Pipeline) behebt.
  const ergebnis = installiereCron({ crontabLeer: false, nurEigenerEintragVorher: true });
  assert.equal(ergebnis.exit, 0, `Installer starb (Exit ${ergebnis.exit}) beim wiederholten Lauf`);
  assert.ok(ergebnis.nachAufrufErreicht);
  assert.match(ergebnis.installiert, /pulse-update\.sh/);
  // Kein Duplikat: der alte eigene Eintrag wurde gefiltert, nicht doppelt.
  const treffer = ergebnis.installiert.match(/pulse-update\.sh/g) ?? [];
  assert.equal(treffer.length, 1, `eigener Eintrag doppelt statt ersetzt: ${JSON.stringify(ergebnis.installiert)}`);
});
