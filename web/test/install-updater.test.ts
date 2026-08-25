/**
 * `write_update_script` aus `web/static/install.sh` — der Updater, den der
 * Installer als eigenständiges Skript auf den Host schreibt (systemd-Timer
 * oder Cron, alle fünf Minuten).
 *
 * **Warum es diesen Test gibt (Task 2).** `docker run -d` liefert Exit-Code 0,
 * sobald der Container ERZEUGT wurde — nicht, wenn er tatsächlich läuft. Der
 * Updater wertete das ursprünglich als Erfolg: er löschte die Rollback-Kopie
 * (`<name>-old`) UND das zuletzt funktionierende Image. Da `IMAGE` ein
 * rollender Tag ist (`:edge`), ist die Vorversion danach nicht mehr
 * adressierbar — ein Image, das startet und sofort wieder stirbt, reisst
 * damit JEDEN Self-Host gleichzeitig um, ohne Rückweg, binnen fünf Minuten.
 * Task 2 hat dagegen eine 15-Sekunden-Stabilitätsprüfung nach `docker run`
 * eingezogen.
 *
 * **Der Rest der Lücke (Task 2b).** Ein Container, der die 15 Sekunden
 * übersteht und danach stirbt, galt bis hier weiter als Erfolg — beide
 * Rückwege waren da schon gelöscht. Fix: der Erfolgszweig löscht `<name>-old`
 * und das alte Image nicht mehr sofort, sondern erst der NÄCHSTE Lauf, und
 * auch nur dann, wenn er `<name>-old` vorfindet UND der aktuelle Container zu
 * diesem Zeitpunkt nachweislich noch läuft. Das Beobachtungsfenster wird
 * damit der ganze Fünf-Minuten-Takt statt einer 15-Sekunden-Stichprobe.
 *
 * **Wie das geht — zweistufig, weil das Prüfobjekt nicht `install.sh`
 * selbst ist, sondern das Skript, das `install.sh` GENERIERT:**
 *   1. `write_update_script` wird aus `install.sh` herausgeschnitten und mit
 *      Fake-Konfiguration ausgeführt — sie schreibt einen echten Updater auf
 *      die Platte. Das ist der eigentliche Prüfling.
 *   2. Dieser generierte Updater wird gegen ein gefälschtes `docker` auf dem
 *      PATH ausgeführt. Anders als bei Task 2 muss dieses `docker` jetzt
 *      ZUSTANDSBEHAFTET sein: die Aufräumfrage aus Task 2b lässt sich nicht
 *      innerhalb eines einzigen Laufs beantworten, sie braucht zwei — Lauf 1
 *      legt den Rückweg an, Lauf 2 entscheidet, ob er bleibt oder geht. Der
 *      Zustand (welcher Container existiert, mit welchem Image, läuft er)
 *      liegt dafür in Dateien unter einem gemeinsamen `STATE_DIR` und
 *      überlebt mehrere Aufrufe des generierten Updaters.
 *
 * Ein Test, der nur `write_update_script` prüft (Textvergleich am
 * generierten Skript), würde eine Regression in der SHELL-LOGIK selbst nicht
 * fangen — deshalb läuft der generierte Updater hier wirklich.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
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

interface Umgebung {
  /** Enthält das gefälschte `docker` — kommt bei jedem Lauf auf den PATH. */
  arbeitsdir: string;
  /** Eine Datei je Containername (`image=…`/`running=…`), überlebt mehrere Läufe. */
  stateDir: string;
  dockerLog: string;
  updateSh: string;
}

interface LaufOptionen {
  /** Antwort von `docker image inspect --format '{{.Id}}'` — die "neu gepullte" Image-Kennung. */
  neuesImage: string;
  /** Stirbt der frisch erzeugte Container sofort (Stabilitätsprüfung schlägt fehl)? Default nein. */
  stirbtSofort?: boolean;
}

function containerDatei(umgebung: Umgebung, name: string): string {
  return join(umgebung.stateDir, `container-${name}`);
}

/** Legt einen Container-Zustand an oder überschreibt ihn — ohne einen einzigen `docker`-Aufruf. */
function initContainer(umgebung: Umgebung, name: string, image: string, laeuft: boolean): void {
  writeFileSync(containerDatei(umgebung, name), `image=${image}\nrunning=${laeuft}\n`);
}

/** Liest den aktuellen Zustand eines Containers — `null`, wenn er (mehr) existiert. */
function zustandVon(umgebung: Umgebung, name: string): { image: string; laeuft: boolean } | null {
  const pfad = containerDatei(umgebung, name);
  if (!existsSync(pfad)) return null;
  const inhalt = readFileSync(pfad, 'utf8');
  const image = /^image=(.*)$/m.exec(inhalt)?.[1] ?? '';
  const laeuft = /^running=(.*)$/m.exec(inhalt)?.[1] === 'true';
  return { image, laeuft };
}

/**
 * Simuliert, dass ein Container OHNE Zutun des Updaters stirbt (Absturz,
 * OOM-Kill …) — direkt an der Zustandsdatei vorbei an `docker`, weil genau
 * das der Punkt ist: der Updater bekommt davon zwischen zwei Läufen nichts
 * mit, ausser durch seine eigene nächste `docker inspect`-Abfrage.
 */
function containerToeten(umgebung: Umgebung, name: string): void {
  const bisher = zustandVon(umgebung, name);
  assert.ok(bisher, `Container ${name} existiert nicht — kann nicht sterben`);
  initContainer(umgebung, name, bisher!.image, false);
}

/**
 * Erzeugt via `write_update_script` einen echten Updater auf der Platte und
 * ein gefälschtes, zustandsbehaftetes `docker` daneben. Beides liegt fest;
 * nur der Aufruf des Updaters selbst (`laufAusfuehren`) passiert wiederholt.
 */
function neueUmgebung(): Umgebung {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const funktionstext = funktion(quelle, 'write_update_script');

  const arbeitsdir = mkdtempSync(join(tmpdir(), 'pulse-updater-'));
  const stateDir = join(arbeitsdir, 'state');
  mkdirSync(stateDir);
  const pulseDir = join(arbeitsdir, 'pulse');
  const updateSh = join(pulseDir, 'pulse-update.sh');
  const dockerLog = join(arbeitsdir, 'docker-aufrufe.log');
  writeFileSync(dockerLog, '');

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

  // Schritt 2: gefälschtes, zustandsbehaftetes `docker`. Zustand liegt unter
  // $STATE_DIR als eine Datei je Containername (`image=…`/`running=…`).
  // `inspect`-Aufrufe parsen `-f`/`--format` an beliebiger Position (beide
  // Formen kommen im generierten Skript vor). Ein "docker run" liest den
  // Zielnamen aus `--name` und legt ihn mit $NEW_IMAGE_ID und $NEU_LAEUFT an
  // — beide werden je Lauf frisch über die Umgebung hereingereicht
  // (`laufAusfuehren`), nicht hier fest eingebacken.
  writeFileSync(
    join(arbeitsdir, 'docker'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"

datei() { printf '%s/container-%s' "$STATE_DIR" "$1"; }

case "$1" in
  login) exit 0 ;;
  pull) exit 0 ;;
  image)
    case "$2" in
      inspect) printf '%s\\n' "$NEW_IMAGE_ID" ;;
    esac
    exit 0 ;;
  run)
    name=""
    vorher=""
    for arg in "$@"; do
      if [ "$vorher" = "--name" ]; then name="$arg"; fi
      vorher="$arg"
    done
    printf 'image=%s\\nrunning=%s\\n' "$NEW_IMAGE_ID" "\${NEU_LAEUFT:-true}" > "$(datei "$name")"
    exit 0 ;;
  rename)
    quelle="$(datei "$2")"
    ziel="$(datei "$3")"
    [ -f "$quelle" ] && mv "$quelle" "$ziel"
    exit 0 ;;
  stop)
    f="$(datei "$2")"
    if [ -f "$f" ]; then
      bild="$(sed -n 's/^image=//p' "$f")"
      printf 'image=%s\\nrunning=false\\n' "$bild" > "$f"
    fi
    exit 0 ;;
  start)
    f="$(datei "$2")"
    if [ -f "$f" ]; then
      bild="$(sed -n 's/^image=//p' "$f")"
      printf 'image=%s\\nrunning=true\\n' "$bild" > "$f"
    fi
    exit 0 ;;
  rm)
    # in diesem Skript immer "rm -f <name>"
    rm -f "$(datei "$3")"
    exit 0 ;;
  inspect)
    shift
    format=""
    name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -f|--format) shift; format="$1" ;;
        *) name="$1" ;;
      esac
      shift
    done
    f="$(datei "$name")"
    [ -f "$f" ] || exit 1
    case "$format" in
      *State.Running*) sed -n 's/^running=//p' "$f" ;;
      *Image*) sed -n 's/^image=//p' "$f" ;;
    esac
    exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(join(arbeitsdir, 'docker'), 0o755);

  return { arbeitsdir, stateDir, dockerLog, updateSh };
}

/**
 * Führt den generierten Updater EINMAL aus und gibt die docker-Aufrufe DIESES
 * Laufs zurück (das Log wird vorher geleert — Zustand in $STATE_DIR bleibt
 * über den Aufruf hinaus bestehen). Der Rollback-Zweig endet bewusst mit
 * `exit 1` — das ist hier ein gültiges Testergebnis, kein Infrastrukturfehler,
 * also wird nur DIESER Exit-Code geschluckt.
 */
function laufAusfuehren(umgebung: Umgebung, optionen: LaufOptionen): string[] {
  writeFileSync(umgebung.dockerLog, '');
  try {
    execFileSync(umgebung.updateSh, [], {
      env: {
        ...process.env,
        PATH: `${umgebung.arbeitsdir}:${process.env.PATH}`,
        DOCKER_LOG: umgebung.dockerLog,
        STATE_DIR: umgebung.stateDir,
        NEW_IMAGE_ID: optionen.neuesImage,
        NEU_LAEUFT: optionen.stirbtSofort ? 'false' : 'true',
        PULSE_UPDATE_STABIL_VERSUCHE: '1',
        PULSE_UPDATE_STABIL_INTERVALL: '0'
      },
      encoding: 'utf8'
    });
  } catch (fehler) {
    const status = (fehler as { status?: number | null }).status;
    if (status !== 1) throw fehler;
  }
  return readFileSync(umgebung.dockerLog, 'utf8')
    .split('\n')
    .filter((z) => z.length > 0);
}

/** Ausgangslage der Mehr-Lauf-Tests: ein erster Lauf, der erfolgreich durchläuft. */
function ersterLaufErfolgreich(umgebung: Umgebung, neuesImage: string): void {
  initContainer(umgebung, 'pulse', 'sha256:alt', true);
  laufAusfuehren(umgebung, { neuesImage });
}

test('ein Container, der sofort stirbt, gilt NICHT als erfolgreicher Start', () => {
  const umgebung = neueUmgebung();
  initContainer(umgebung, 'pulse', 'sha256:alt', true);

  const befehle = laufAusfuehren(umgebung, { neuesImage: 'sha256:neu', stirbtSofort: true });

  // Kein "rm -f *-old" auf einem frischen ersten Lauf: die frühere
  // bedingungslose Vorab-Räumung ("Rest eines früheren Fehlversuchs") ist mit
  // Task 2b entfallen. Ihr Fall (ein abgebrochener früherer Lauf) deckt jetzt
  // derselbe Aufräum-Block ab, der einen bestätigt erfolgreichen Wechsel
  // erkennt — s. die Mehr-Lauf-Tests unten.
  const rmAlt = befehle.filter((z) => z.startsWith('rm -f') && z.endsWith('-old')).length;
  assert.equal(rmAlt, 0, `erwartet 0x "rm -f *-old", bekommen: ${JSON.stringify(befehle)}`);

  assert.equal(
    befehle.some((z) => z.startsWith('image rm')),
    false,
    'das alte Image wurde entfernt, obwohl der neue Container nicht stabil lief'
  );

  assert.ok(befehle.includes('rename pulse-old pulse'), 'Rollback fehlt: pulse-old wurde nicht zu pulse zurückbenannt');
  assert.ok(befehle.includes('start pulse'), 'Rollback fehlt: pulse wurde nach dem Zurückbenennen nicht gestartet');

  // Der Rollback muss auch WIRKLICH die alte Version zurückgebracht haben.
  assert.deepEqual(zustandVon(umgebung, 'pulse'), { image: 'sha256:alt', laeuft: true });
  assert.equal(zustandVon(umgebung, 'pulse-old'), null, 'pulse-old haette nach dem Rollback nicht mehr existieren duerfen');
});

test('ein Container, der stabil läuft, gilt als Erfolg — der Rückweg bleibt aber bis zum nächsten Lauf stehen', () => {
  // Gegenprobe zum vorigen Test — sonst bestünde er auch, wenn der Updater
  // nach einem erfolgreichen Update gar nichts mehr täte.
  const umgebung = neueUmgebung();
  initContainer(umgebung, 'pulse', 'sha256:alt', true);

  const befehle = laufAusfuehren(umgebung, { neuesImage: 'sha256:neu' });

  // Der Kern von Task 2b: anders als bei Task 2 räumt der Erfolgszweig NICHT
  // mehr sofort auf — genau das war die verbliebene Lücke (ein Container, der
  // die 15-Sekunden-Stichprobe übersteht und danach stirbt, wäre sonst ohne
  // Rückweg gewesen). Das Aufräumen verschiebt sich auf den nächsten Lauf.
  assert.equal(
    befehle.some((z) => z.startsWith('rm -f') && z.endsWith('-old')),
    false,
    'der Rückweg wurde bereits im Erfolgszweig entfernt — er muss bis zum nächsten Lauf stehen bleiben'
  );
  assert.equal(
    befehle.some((z) => z.startsWith('image rm')),
    false,
    'das alte Image wurde bereits im Erfolgszweig entfernt'
  );
  assert.ok(!befehle.includes('start pulse'), 'kein Rollback erwartet, aber pulse wurde neu gestartet');

  assert.deepEqual(zustandVon(umgebung, 'pulse'), { image: 'sha256:neu', laeuft: true });
  assert.deepEqual(
    zustandVon(umgebung, 'pulse-old'),
    { image: 'sha256:alt', laeuft: false },
    'der Rückweg fehlt — genau das darf nach einem erfolgreichen Lauf nicht sein'
  );
});

test('läuft der Container beim nächsten Takt noch, räumt DIESER Lauf den Rückweg auf — auch ohne neues Image', () => {
  const umgebung = neueUmgebung();
  ersterLaufErfolgreich(umgebung, 'sha256:neu');
  assert.ok(zustandVon(umgebung, 'pulse-old'), 'Vorbedingung: Rückweg muss nach Lauf 1 noch existieren');

  // Lauf 2 mit demselben Image (kein neues verfügbar) — prüft zugleich, dass
  // der Digest-Kurzschluss ("bereits aktuell", `exit 0` vor jedem Update)
  // das Aufräumen nicht überspringt: der Aufräum-Block steht davor.
  const befehle = laufAusfuehren(umgebung, { neuesImage: 'sha256:neu' });

  assert.ok(befehle.includes('rm -f pulse-old'), `Rückweg wurde nicht entfernt: ${JSON.stringify(befehle)}`);
  assert.ok(
    befehle.some((z) => z.startsWith('image rm')),
    'das alte Image wurde nicht entfernt'
  );
  assert.equal(zustandVon(umgebung, 'pulse-old'), null);

  // Und: kein neuer Update-Versuch — der Digest war identisch.
  assert.ok(
    !befehle.some((z) => z.startsWith('run ')),
    'ein neuer Container wurde erzeugt, obwohl kein neues Image vorlag'
  );
});

test('stirbt der Container zwischen zwei Läufen, bleibt der Rückweg beim nächsten Takt stehen', () => {
  const umgebung = neueUmgebung();
  ersterLaufErfolgreich(umgebung, 'sha256:neu');
  containerToeten(umgebung, 'pulse'); // stirbt ohne Zutun des Updaters, z. B. nach 2 Minuten

  const befehle = laufAusfuehren(umgebung, { neuesImage: 'sha256:neu' });

  assert.ok(
    !befehle.includes('rm -f pulse-old'),
    `Rückweg wurde fälschlich entfernt, obwohl der Container tot ist: ${JSON.stringify(befehle)}`
  );
  assert.ok(
    !befehle.some((z) => z.startsWith('image rm')),
    'das alte Image wurde fälschlich entfernt, obwohl der Container tot ist'
  );
  assert.ok(zustandVon(umgebung, 'pulse-old'), 'Rückweg fehlt — genau der Schaden, den Task 2b verhindern soll');
});

test('das Abtastfenster von container_laeuft_stabil bleibt bei 15s, nur feiner aufgeteilt', () => {
  // Nachtrag zu Task 2b: die Schleife bricht beim ersten fehlgeschlagenen
  // Check sofort ab — sie sitzt also nichts aus. Was tatsächlich zählt, ist
  // die LÜCKE zwischen zwei Stichproben: ein Container in einer
  // Neustartschleife ('--restart unless-stopped') kann zwischen zwei
  // Ein-Sekunden-Proben sterben UND wieder hochkommen, jede Probe sähe dann
  // 'true'. Das Intervall schrumpft deshalb von 1s auf 0,2s, bei
  // entsprechend mehr Versuchen (75 statt 15) — das GESAMTFENSTER (die
  // Kulanzzeit für einen langsam startenden, gesunden Container) muss dabei
  // exakt gleich bleiben. Ein Textvergleich statt eines echten 15-Sekunden-
  // Laufs, aus demselben Grund, aus dem die anderen Tests VERSUCHE/INTERVALL
  // per Env überschreiben: niemand soll für einen Konstanten-Check wirklich
  // warten müssen.
  const quelle = readFileSync(SKRIPT, 'utf8');
  const funktionstext = funktion(quelle, 'container_laeuft_stabil');

  assert.match(
    funktionstext,
    /PULSE_UPDATE_STABIL_VERSUCHE:-75\}/,
    `Default-Versuche nicht bei 75 — Funktion: ${funktionstext}`
  );
  assert.match(
    funktionstext,
    /PULSE_UPDATE_STABIL_INTERVALL:-0\.2\}/,
    `Default-Intervall nicht bei 0,2s — Funktion: ${funktionstext}`
  );
});
