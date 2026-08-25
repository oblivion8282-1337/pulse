/**
 * `decide_mode` aus `web/static/install.sh` gegen einen gefälschten `docker` —
 * speziell den Fall „zweiter Lauf auf einem laufenden greenfield-Server".
 *
 * **Warum es diesen Test gibt.** Am 2026-08-25 stufte sich der Installer beim
 * ZWEITEN Lauf selbst herunter: im greenfield-Modus hält Pulses eigener
 * Container 80 und 443, das Image (`registry.howispulse.com/pulse-allinone`)
 * passt auf kein Proxy-Muster, und `detect_proxy` findet deshalb keinen
 * Treffer — PROXY_KIND bleibt `none`. Der `none`-Zweig kannte bis dahin nur
 * "sind 80/443 belegt?" und schloss daraus auf einen fremden Reverse-Proxy.
 * Ergebnis: TLS kippt auf `behind-proxy`, ACME stellt ein, der Server
 * verschwindet aus dem Internet — während der Container weiterläuft und die
 * Portprüfung grün ist (`check_ports` kennt die Ausnahme längst, s. dort).
 *
 * **Wie das geht:** wie in `install-proxy-erkennung.test.ts` werden die
 * Shell-Funktionen aus `install.sh` herausgeschnitten und mit einem `docker`
 * auf dem PATH ausgeführt, das `ps` und `inspect` kennt. Zusätzlich zu
 * `detect_proxy` wird hier `decide_mode` selbst ausgeführt — sie ist die
 * Stelle, die den Fehler enthielt.
 *
 * **Zweite Runde.** Der erste Fix setzte `MODE=greenfield`, sobald der eigene
 * Container läuft — egal, ob er 80/443 überhaupt veröffentlicht. Das bricht
 * einen gleichwertigen, gültigen Fall: ein Server hinter einem host-nativen
 * Reverse-Proxy (nginx/Caddy auf dem Host, nicht in Docker — Fall 4 im
 * Kopfkommentar). `detect_proxy` sieht dort nichts (kein Docker-Container),
 * der eigene Container läuft im `hostproxy`-Modus aber nur auf Loopback
 * (`-p 127.0.0.1:8080:8080`, s. `build_run_args`), veröffentlicht 80/443 also
 * nicht. Das unterscheidende Merkmal ist deshalb nicht „läuft der Container",
 * sondern „veröffentlicht er 80/443" — dieselbe Prüfung, die `publishes_web_port`
 * schon für die Proxy-Erkennung liefert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

/** Eine Shell-Funktion `name() { … }` bis zur schliessenden Klammer in Spalte 0. */
function funktion(quelle: string, name: string): string {
  const zeilen = quelle.split('\n');
  const start = zeilen.findIndex((z) => z.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `Funktion ${name}() nicht gefunden — Skript umgebaut?`);
  const ende = zeilen.findIndex((z, i) => i > start && z === '}');
  assert.notEqual(ende, -1, `kein Ende fuer ${name}()`);
  return zeilen.slice(start, ende + 1).join('\n');
}

interface FakeContainer {
  name: string;
  image: string;
  /** Veröffentlicht der Container 80/443 nach aussen? */
  publiziert: boolean;
}

interface Konfiguration {
  /** Reihenfolge = Reihenfolge von `docker ps` (neueste zuerst). */
  container: FakeContainer[];
  /** Sind 80/443 auf dem Host belegt? (Vorbedingung dieses Testfalls.) */
  portBelegt: boolean;
}

/**
 * Führt `decide_mode` gegen eine erfundene Container-Liste aus und gibt den
 * gewählten Modus zurück. `docker ps` listet nur LAUFENDE Container — ein
 * Container aus `konfig.container` gilt deshalb im gefälschten `docker`
 * immer als laufend, genau wie im echten.
 */
function entscheide(konfig: Konfiguration): { mode: string } {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-eigener-container-'));

  const psZeilen = konfig.container.map((c) => `${c.name}\t${c.image}`).join('\n');
  const laufendFaelle = konfig.container.map((c) => `        ${c.name}) echo 'true' ;;`).join('\n');
  const portsFaelle = konfig.container
    .map((c) => `        ${c.name}) echo '${c.publiziert ? '80/tcp 443/tcp ' : ''}' ;;`)
    .join('\n');

  // Gefälschtes `docker`: `ps --format …`, `inspect -f '{{.State.Running}}' …`
  // (für eigener_container_laeuft), `inspect -f '...Ports...' …` (für
  // publishes_web_port). Die Unterscheidung läuft über die FORMAT-Zeichenkette
  // ($3), nicht nur über den Containernamen — beide Abfragen betreffen
  // denselben Container, brauchen aber unterschiedliche Antworten.
  // `%b` statt `%s` ist Pflicht: nur damit wird `\t` zum Tabulator (s.
  // install-proxy-erkennung.test.ts).
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  ps) printf '%b\\n' "${psZeilen.replace(/\t/g, '\\t')}" ;;
  inspect)
    format="$3"
    for letztes in "$@"; do :; done
    case "$format" in
      *State.Running*)
        case "$letztes" in
${laufendFaelle}
          *) echo 'false' ;;
        esac ;;
      *NetworkSettings.Ports*)
        case "$letztes" in
${portsFaelle}
          *) echo '' ;;
        esac ;;
      *) echo '' ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  const skript = `
set -uo pipefail
CONTAINER=pulse
FORCE_TLS_MODE=""
FORCE_NETWORK=""
${funktion(quelle, 'proxy_netze')}
${funktion(quelle, 'publishes_web_port')}
${funktion(quelle, 'detect_proxy')}
${funktion(quelle, 'eigener_container_laeuft')}
${funktion(quelle, 'decide_mode')}
port_busy() { ${konfig.portBelegt ? 'return 0' : 'return 1'}; }
# Vereinfachte Fassung von _set_proxy: dieser Test prueft greenfield/hostproxy
# ueber den eigenen Container, nicht die Mehrdeutigkeits-Pruefung — die hat
# ihre eigenen Tests in install-proxy-erkennung.test.ts. Das gefaelschte
# docker liefert hier ohnehin nie mehr als eine Zeile.
PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""
_set_proxy() { PROXY_CONTAINER="$1"; PROXY_KIND="$2"; PROXY_NET="$(proxy_netze "$1")"; }
decide_mode
echo "$MODE"
`;
  const ausgabe = execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8'
  }).trim();
  return { mode: ausgabe };
}

test('ein zweiter Lauf lässt einen greenfield-Server greenfield', () => {
  // Pulses EIGENER Container läuft und veröffentlicht 80/443 selbst.
  const ergebnis = entscheide({
    container: [{ name: 'pulse', image: 'registry.howispulse.com/pulse-allinone:edge', publiziert: true }],
    portBelegt: true
  });
  assert.equal(ergebnis.mode, 'greenfield');
});

test('ein FREMDER Proxy auf 80/443 führt weiterhin zu hostproxy', () => {
  // Gegenprobe — sonst bestünde der Test auch, wenn die Erkennung tot wäre.
  const ergebnis = entscheide({
    container: [{ name: 'nginx-vom-nachbarn', image: 'nginx:1.27', publiziert: true }],
    portBelegt: true
  });
  assert.notEqual(ergebnis.mode, 'greenfield');
});

test('ein eigener Container ohne veröffentlichte 80/443 bleibt bei einem host-nativen Proxy hostproxy', () => {
  // Genau der Fall aus der zweiten Runde: Pulse läuft im hostproxy-Modus (nur
  // Loopback gebunden), 80/443 gehören einem host-nativen Reverse-Proxy, den
  // `docker ps` gar nicht sieht. Wer hier bedingungslos auf
  // `eigener_container_laeuft` abstellt, würde einen laufenden, korrekt
  // konfigurierten Server per Fehleinschätzung auf greenfield umstellen und
  // beim nächsten `docker run` die eigenen 80/443 gegen den fremden Proxy
  // verlieren.
  const ergebnis = entscheide({
    container: [{ name: 'pulse', image: 'registry.howispulse.com/pulse-allinone:edge', publiziert: false }],
    portBelegt: true
  });
  assert.equal(ergebnis.mode, 'hostproxy');
});
