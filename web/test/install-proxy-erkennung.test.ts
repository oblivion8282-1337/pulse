/**
 * `detect_proxy` aus `web/static/install.sh` — gegen einen gefälschten `docker`.
 *
 * **Warum es diesen Test gibt.** Am 2026-08-25 erkannte der Installer auf einer
 * echten Maschine `pulsetest_web` als Reverse-Proxy: ein `nginx:1.27-alpine`,
 * das Port 80 nur intern exponiert und in Wahrheit die Weboberfläche eines
 * Pulse-Stacks ist. Der echte Proxy war ein `caddy`, der 80 und 443 hält. Die
 * Schleife nahm den ersten Namenstreffer aus `docker ps` — und das sortiert
 * nach Erstellzeit, neueste zuerst. Der Installer hätte den Betreiber
 * angewiesen, eine Route in einen Container einzutragen, der gar kein Proxy
 * ist.
 *
 * Ein solcher Fehlgriff meldet sich nicht: die Erkennung liefert ja *etwas*,
 * nur eben das Falsche. Deshalb steht hier die Reihenfolge ausdrücklich falsch
 * herum — genau wie auf der Maschine, auf der es passiert ist.
 *
 * **Wie das geht:** die Funktionen werden aus dem Skript herausgeschnitten
 * (`install.sh` läuft von oben nach unten durch, sourcen ginge nicht) und mit
 * einem `docker` auf dem PATH ausgeführt, das nur `ps` und `inspect` kennt.
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
 * — heredoc-bewusst (uebernommen aus install-updater.test.ts, s. dort: die
 * naive Suche nach der ersten Zeile "}" traefe eine unindentierte `}`-Zeile
 * MITTEN in einem Heredoc-Inhalt, falls eine spaeter hier geschnittene
 * Funktion einen enthaelt — kein akuter Fall fuer diese Datei heute, aber
 * derselbe Schneider wie ueberall sonst statt eines sechsten, abweichenden.
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

interface FakeContainer {
  name: string;
  image: string;
  /** Veröffentlicht der Container 80/443 nach aussen? */
  publiziert: boolean;
  /**
   * `.HostConfig.NetworkMode` — nur gesetzt, wenn der Container mit
   * `network_mode: host` läuft (dann leer statt 'bridge' etc., s.
   * `nutzt_host_netzwerk` im Skript).
   */
  netzwerkModus?: string;
}

/**
 * Führt `detect_proxy` gegen eine erfundene Container-Liste aus und gibt
 * `KIND:CONTAINER` zurück. Die Reihenfolge des Arrays ist die Reihenfolge, in
 * der `docker ps` sie ausgibt — sie ist Teil des Testfalls.
 */
function erkenne(container: FakeContainer[]): string {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-proxy-'));

  // Gefälschtes `docker`: kennt `ps --format …` und `inspect -f … <name>`.
  // `%b` statt `%s` ist Pflicht: nur damit wird `\t` zum Tabulator. Mit `%s`
  // stehen zwei literale Zeichen in der Zeile, `IFS=$'\t' read` findet keine
  // Spaltengrenze, und JEDER Fall meldet „kein Proxy gefunden" — der Test
  // sähe dann aus wie ein kaputter Fix.
  const psZeilen = container.map((c) => `${c.name}\t${c.image}`).join('\n');
  const inspectFaelle = container
    .map((c) => `    ${c.name}) echo '${c.publiziert ? '80/tcp 443/tcp ' : ''}' ;;`)
    .join('\n');
  // Zweite Tabelle fuer `docker inspect -f '{{.HostConfig.NetworkMode}}' …`
  // — eigens vom Ports-Format unterschieden (Routing unten ueber `$*`),
  // sonst laese `nutzt_host_netzwerk` dieselbe Ports-Kanne wie
  // `publishes_web_port` und haette nie eine Chance auf 'host'.
  const netzwerkFaelle = container
    .map((c) => `    ${c.name}) echo '${c.netzwerkModus ?? ''}' ;;`)
    .join('\n');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  ps) printf '%b\\n' "${psZeilen.replace(/\t/g, '\\t')}" ;;
  inspect)
    # letztes Argument ist der Containername
    for letztes in "$@"; do :; done
    case "$*" in
      *HostConfig.NetworkMode*)
        case "$letztes" in
${netzwerkFaelle}
          *) echo '' ;;
        esac ;;
      *)
        case "$letztes" in
${inspectFaelle}
          *) echo '' ;;
        esac ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  const skript = `
set -uo pipefail
${funktion(quelle, 'proxy_netze')}
${funktion(quelle, 'publishes_web_port')}
${funktion(quelle, 'nutzt_host_netzwerk')}
${funktion(quelle, 'detect_proxy')}
# 80/443 gelten als belegt — das ist die Vorbedingung des zweiten Abschnitts.
port_busy() { return 0; }
# Vereinfachte Fassung von _set_proxy: dieser Test prueft die Container-Wahl
# in detect_proxy, nicht die Mehrdeutigkeits-Pruefung — die hat ihre eigenen
# Tests unten (erkenneNetz). Das gefaelschte docker liefert hier ohnehin nie
# mehr als eine Zeile.
PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""
_set_proxy() { PROXY_CONTAINER="$1"; PROXY_KIND="$2"; PROXY_NET="$(proxy_netze "$1")"; }
detect_proxy
echo "\${PROXY_KIND}:\${PROXY_CONTAINER}"
`;
  return execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8'
  }).trim();
}

test('der Container, der 80/443 haelt, gewinnt — nicht der erste Namenstreffer', () => {
  // Genau die Lage vom 2026-08-25: die App-nginx steht VOR dem echten Caddy.
  const ergebnis = erkenne([
    { name: 'pulsetest_web', image: 'nginx:1.27-alpine', publiziert: false },
    { name: 'caddy', image: 'caddy:2-alpine', publiziert: true }
  ]);
  assert.equal(ergebnis, 'static-caddy:caddy');
});

test('eine App mit nginx im Image ist kein Proxy', () => {
  const ergebnis = erkenne([
    { name: 'pulsetest_web', image: 'nginx:1.27-alpine', publiziert: false }
  ]);
  assert.equal(ergebnis, 'none:', 'ein Container ohne veroeffentlichte Ports darf nie gewinnen');
});

test('ein echter nginx-Proxy wird weiterhin erkannt', () => {
  // Die Gegenprobe — sonst wuerde der Test oben auch bestehen, wenn die
  // Erkennung gar nichts mehr fände.
  const ergebnis = erkenne([
    { name: 'app', image: 'nginx:1.27-alpine', publiziert: false },
    { name: 'proxy', image: 'nginx:1.27-alpine', publiziert: true }
  ]);
  assert.equal(ergebnis, 'static-nginx:proxy');
});

test('Traefik-Auto-Discovery gewinnt ueber die generische Caddy-Erkennung', () => {
  // Abschnitt 1 (Auto-Discovery) laeuft vor Abschnitt 2 (statisch) und
  // gewinnt deshalb, wenn beide zutreffen. Seit Task 9 gilt das aber nur
  // noch, wenn Traefik sich auch selbst beweist — hier veroeffentlicht es
  // 80/443 genau wie caddy. (Vorher stand hier `publiziert: false` fuer
  // Traefik: das war die Luecke selbst, nicht die Gegenprobe dazu — s.
  // 'traefik/whoami kapert die Erkennung nicht' unten.)
  const ergebnis = erkenne([
    { name: 'caddy', image: 'caddy:2-alpine', publiziert: true },
    { name: 'traefik', image: 'traefik:v3', publiziert: true }
  ]);
  assert.equal(ergebnis, 'traefik:traefik');
});

test('ein echter Traefik mit Host-Networking wird weiterhin erkannt', () => {
  // Die Ausnahme mit Absicht: `network_mode: host` veroeffentlicht nichts
  // und ist trotzdem ein Proxy. Dafuer gibt es `nutzt_host_netzwerk` statt
  // eines host-weiten `port_busy` (s. Test direkt unten, warum das noetig ist).
  const ergebnis = erkenne([
    { name: 'traefik', image: 'traefik:v3', publiziert: false, netzwerkModus: 'host' }
  ]);
  assert.equal(ergebnis, 'traefik:traefik');
});

test('traefik/whoami kapert die Erkennung nicht', () => {
  // Das Demo-Image aus jeder Traefik-Anleitung. Es veroeffentlicht nichts
  // und laeuft nicht mit Host-Netzwerk — nichts beweist, dass es ein Proxy
  // ist.
  const ergebnis = erkenne([{ name: 'demo', image: 'traefik/whoami:latest', publiziert: false }]);
  assert.equal(ergebnis, 'none:');
});

test('ein fremder veroeffentlichter Port bewaffnet traefik/whoami nicht', () => {
  // Die Abgrenzungsfrage: ein host-weiter `port_busy 80`-Check waere HIER
  // keine gueltige Ersatz-Bedingung fuer `publishes_web_port` — er wuesste
  // nur, dass IRGENDETWAS auf der Maschine 80/443 haelt, nicht dieser
  // Container. caddy haelt hier tatsaechlich einen Port; traefik/whoami
  // bleibt trotzdem aussen vor, weil `nutzt_host_netzwerk` je Container
  // prueft statt global.
  const ergebnis = erkenne([
    { name: 'caddy', image: 'caddy:2-alpine', publiziert: true },
    { name: 'demo', image: 'traefik/whoami:latest', publiziert: false }
  ]);
  assert.equal(ergebnis, 'static-caddy:caddy');
});

test('ohne Container bleibt es bei none', () => {
  assert.equal(erkenne([]), 'none:');
});

/**
 * `_set_proxy` gegen eine erfundene Netzliste — so, als hätte `docker
 * inspect` genau diese Netze für den Proxy-Container gemeldet.
 *
 * **Warum es diese zweite Gruppe gibt.** Ebenfalls am 2026-08-25, auf der
 * Maschine eines Betreibers real passiert: ein `caddy`, der in sechs
 * Docker-Netzen hing. `first_user_network` nahm das erste — Go-Templates
 * geben Map-Schlüssel alphabetisch aus, „das erste" ist also reiner Zufall.
 * Pulse landete im Netz eines fremden Projekts (`crewconnect-net`). Es
 * funktionierte zufällig — der Proxy war auch dort —, aber die
 * Isolationsgrenze saß falsch: ein `docker compose down` des fremden Projekts
 * hätte Pulse das Netz weggerissen.
 *
 * Die Funktion `_set_proxy` und die neue `proxy_netze` (liefert ALLE
 * Nutzer-Netze, nicht nur das erste) werden dafür direkt aus dem Skript
 * geschnitten, nicht wie bei `erkenne()` oben nachgebaut — hier ist die
 * Abbruch-Logik selbst der Testgegenstand, eine Kopie könnte den Fehler
 * mitkopieren statt ihn zu prüfen.
 */
interface NetzErgebnis {
  /** Inhalt von PROXY_NET nach dem Lauf (leer, wenn abgebrochen wurde). */
  netz: string;
  abgebrochen: boolean;
  /** stderr-Text des Abbruchs — leer, wenn nicht abgebrochen wurde. */
  meldung: string;
  exit: number;
}

/**
 * @param netze Die Netze, die das gefälschte `docker inspect` für den
 *   Proxy-Container melden soll (bereits gefiltert, wie `proxy_netze` sie
 *   liefern würde — leer heisst „nur Default-Bridge").
 * @param pulseNetwork Simuliert einen bereits gesetzten `PULSE_NETWORK`
 *   (= `FORCE_NETWORK` im Skript) — der Weg, den ein Admin nach der
 *   Abbruch-Meldung tatsächlich geht.
 */
function erkenneNetz(netze: string[], pulseNetwork = ''): NetzErgebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-netz-'));

  // Gefälschtes `docker inspect`: liefert immer dieselbe Netzliste, egal für
  // welchen Container — in diesem Test gibt es ohnehin nur einen Proxy.
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  inspect) printf '%b\\n' "${netze.join('\\n')}" ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  // set -e wie im echten Skript: nur damit wäre der pipefail-Fehler (Fall
  // "kein Netz") ueberhaupt beobachtbar — err()/die() sind bewusst nicht aus
  // der Quelle geschnitten (auch sie sind Einzeiler ohne eigene `}`-Zeile,
  // wie das ehemalige _set_proxy), aber trivial genug fuer eine Handkopie.
  const skript = `
set -euo pipefail
err() { printf '[pulse] ERROR: %s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
${funktion(quelle, 'proxy_netze')}
${funktion(quelle, '_set_proxy')}
FORCE_NETWORK="${pulseNetwork}"
PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""
_set_proxy irgendein-proxy static-caddy
echo "NETZ:\${PROXY_NET}"
`;
  try {
    const ausgabe = execFileSync('bash', ['-c', skript], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8'
    });
    const zeile = ausgabe.split('\n').find((z) => z.startsWith('NETZ:')) ?? 'NETZ:';
    return { netz: zeile.slice(5), abgebrochen: false, meldung: '', exit: 0 };
  } catch (fehler) {
    const e = fehler as { status?: number; stderr?: string };
    return { netz: '', abgebrochen: true, meldung: e.stderr ?? '', exit: e.status ?? 1 };
  }
}

test('bei mehreren Netzen wird nicht geraten, sondern abgebrochen', () => {
  const ergebnis = erkenneNetz(['crewconnect-net', 'cs-trading-net', 'pulse-selfhost-net']);
  assert.equal(ergebnis.abgebrochen, true);
  assert.match(ergebnis.meldung, /PULSE_NETWORK/);
  // Alle Kandidaten muessen genannt werden, sonst kann niemand waehlen.
  for (const n of ['crewconnect-net', 'cs-trading-net', 'pulse-selfhost-net']) {
    assert.match(ergebnis.meldung, new RegExp(n));
  }
  // Der Abbruch liegt vor der Token-Einloesung — das muss die Meldung sagen,
  // sonst befuerchtet der Admin einen verbrannten Token.
  assert.match(ergebnis.meldung, /consumed/);
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

test('PULSE_NETWORK loest die Mehrdeutigkeit tatsaechlich auf, statt in eine Sackgasse zu laufen', () => {
  // Genau der Weg, den ein Admin nach der Abbruch-Meldung oben geht:
  // Variable setzen, Befehl erneut ausfuehren. Wuerde _set_proxy trotz
  // gesetztem PULSE_NETWORK weiter auf die Mehrdeutigkeit pruefen (statt sie
  // sofort zu ueberspringen), bräche der zweite Lauf mit derselben Meldung
  // ab — eine Sackgasse, aus der PULSE_NETWORK nicht mehr herausfuehrt.
  const ergebnis = erkenneNetz(
    ['crewconnect-net', 'cs-trading-net', 'pulse-selfhost-net'],
    'pulse-selfhost-net'
  );
  assert.equal(ergebnis.abgebrochen, false);
  assert.equal(ergebnis.netz, 'pulse-selfhost-net');
});

/**
 * Führt `decide_mode` mit einem einzelnen, mehrdeutigen Proxy-Container aus
 * (`detect_proxy` wird durch einen Stub ersetzt — welcher Containername
 * gewinnt, ist Gegenstand von `erkenne()` oben, nicht hier). Prüft die Sorge
 * hinter der vorigen Frage zu Ende: es reicht nicht, dass `_set_proxy` nicht
 * abbricht — das Endergebnis `MODE` darf nach einem PULSE_NETWORK-Rerun auch
 * nicht beim Loopback-Ersatz `hostproxy` landen, sonst liefe Pulse ohne
 * Proxy-Anbindung, obwohl der Admin die Mehrdeutigkeit korrekt aufgelöst hat.
 */
function decideModeMitProxy(
  proxyKind: string,
  netze: string[],
  pulseNetwork: string
): { mode: string; net: string } {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-decide-netz-'));

  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  inspect) printf '%b\\n' "${netze.join('\\n')}" ;;
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
detect_proxy() { _set_proxy fake-proxy ${proxyKind}; }
FORCE_NETWORK="${pulseNetwork}"
FORCE_TLS_MODE=""
decide_mode
echo "MODE:\${MODE} NET:\${PROXY_NET}"
`;
  const ausgabe = execFileSync('bash', ['-c', skript], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8'
  }).trim();
  const treffer = ausgabe.match(/^MODE:(\S*) NET:(.*)$/);
  assert.notEqual(treffer, null, `unerwartete Ausgabe: ${ausgabe}`);
  return { mode: treffer![1], net: treffer![2] };
}

test('PULSE_NETWORK fuehrt nach einer Mehrdeutigkeit wirklich zu static-docker, nicht in eine Sackgasse auf hostproxy', () => {
  // Der Vorfall aus der Testbeschreibung oben, zu Ende gedacht: ein
  // statischer caddy, mehrdeutig in drei Netzen. static-docker (nicht
  // hostproxy!) ist der Modus, den ein einzelnes, eindeutiges Netz hier
  // erzeugt haette — genau das muss auch mit PULSE_NETWORK herauskommen.
  const ergebnis = decideModeMitProxy(
    'static-caddy',
    ['crewconnect-net', 'cs-trading-net', 'pulse-selfhost-net'],
    'pulse-selfhost-net'
  );
  assert.equal(ergebnis.mode, 'static-docker');
  assert.equal(ergebnis.net, 'pulse-selfhost-net');
});
