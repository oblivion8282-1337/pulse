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
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  ps) printf '%b\\n' "${psZeilen.replace(/\t/g, '\\t')}" ;;
  inspect)
    # letztes Argument ist der Containername
    for letztes in "$@"; do :; done
    case "$letztes" in
${inspectFaelle}
      *) echo '' ;;
    esac ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  const skript = `
set -uo pipefail
${funktion(quelle, 'first_user_network')}
${funktion(quelle, 'publishes_web_port')}
${funktion(quelle, 'detect_proxy')}
# 80/443 gelten als belegt — das ist die Vorbedingung des zweiten Abschnitts.
port_busy() { return 0; }
PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""
_set_proxy() { PROXY_CONTAINER="$1"; PROXY_KIND="$2"; PROXY_NET="$(first_user_network "$1")"; }
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

test('Traefik gewinnt ueber den Image-Namen, ohne auf Ports zu warten', () => {
  // Abschnitt 1 bleibt absichtlich unberührt: wer das Traefik-Image faehrt,
  // IST ein Proxy — auch mit `network_mode: host`, wo er nichts veroeffentlicht.
  const ergebnis = erkenne([
    { name: 'caddy', image: 'caddy:2-alpine', publiziert: true },
    { name: 'traefik', image: 'traefik:v3', publiziert: false }
  ]);
  assert.equal(ergebnis, 'traefik:traefik');
});

test('ohne Container bleibt es bei none', () => {
  assert.equal(erkenne([]), 'none:');
});
