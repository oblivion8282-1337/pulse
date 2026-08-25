/**
 * `build_run_args` aus `web/static/install.sh` — der Traefik-Zweig des
 * `discovery`-Modus (Task 8).
 *
 * **Warum es diesen Test gibt.** Traefik zerlegt Label-SCHLÜSSEL an Punkten
 * (`traefik.http.routers.<name>.rule`), um sie per Reflection auf eine
 * verschachtelte Konfigurationsstruktur abzubilden. Der Router-Name stand
 * bisher unverändert für den echten Hostnamen — inklusive dessen Punkten
 * (`pulse-chat.example.com`). Am echten Traefik v3.5 gemessen (nicht nur aus
 * der Doku abgeleitet — die verbietet ausdrücklich nur `@`): ein Punkt im
 * Router-Namen lässt den Parser mit `field not found, node: example`
 * abbrechen, und zwar für die GESAMTE Label-Konfiguration des Containers,
 * nicht nur für dieses eine Label. Der `discovery`-Modus verspricht
 * `"the proxy picks it up automatically. No manual step."` — dieses
 * Versprechen hat für keinen einzigen echten Hostnamen je gestimmt.
 *
 * Die Host-REGEL (`rule=Host(\`chat.example.com\`)`) muss die Punkte
 * trotzdem behalten — dort ist es ein Label-WERT, den Traefik nicht
 * aufspaltet. Nur der Name im Label-Pfad selbst muss bereinigt werden.
 *
 * **Wie das geht:** `build_run_args` (plus die Helfer, die es referenziert)
 * wird aus `install.sh` herausgeschnitten und mit einer gefälschten
 * `discovery`/`traefik`-Konfiguration ausgeführt. Kein echter Traefik im
 * Spiel — dessen Parser-Verhalten ist die Begründung oben, nicht Teil dieses
 * Tests.
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
 * — heredoc-bewusst (übernommen aus install-updater.test.ts /
 * install-proxy-erkennung.test.ts: derselbe Schneider statt eines eigenen,
 * abweichenden). `build_run_args` selbst enthält keinen Heredoc, aber der
 * Schneider soll trotzdem robust gegen einen künftigen bleiben.
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
 * Führt `build_run_args` im `discovery`/`traefik`-Modus für den gegebenen
 * Hostnamen aus und gibt die Label-INHALTE zurück (das Argument, das jeweils
 * direkt auf ein `--label` in RUN_ARGS folgt — ohne das führende `--label`
 * selbst). `docker` ist gefälscht und antwortet auf `ps -q` mit nichts, damit
 * `detect_traefik_certresolver` (von `build_run_args` mitgezogen) leer
 * durchläuft, statt einen echten Docker-Daemon zu brauchen.
 */
function baueLabels(host: string): string[] {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'pulse-traefik-label-'));

  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/bash
case "$1" in
  ps) exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(join(dir, 'docker'), 0o755);

  const skript = `
set -uo pipefail
${funktion(quelle, 'detect_traefik_certresolver')}
${funktion(quelle, 'build_run_args')}
MODE=discovery
PROXY_KIND=traefik
PROXY_NET="testnet"
SRV_HOST="${host}"
HTTP_PORT="8080"
ADMIN_EMAIL="admin@example.com"
CONTAINER="pulse"
ENV_FILE="/dev/null"
VOLUME="pulse-data"
IMAGE="test-image"
build_run_args
# NUL-getrennt statt zeilenweise: ein Label-Wert (die Host-Regel) enthaelt
# selbst keine Newlines, aber NUL ist die robustere, allgemeine Wahl fuer
# Array-Elemente.
printf '%s\\0' "\${RUN_ARGS[@]}"
`;

  const ausgabe = execFileSync('bash', ['-c', skript], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  });

  const elemente = ausgabe.split('\0').filter((_, i, arr) => i < arr.length - 1);
  const labels: string[] = [];
  for (let i = 0; i < elemente.length; i++) {
    if (elemente[i] === '--label') labels.push(elemente[i + 1]);
  }
  return labels;
}

test('der Router-Name enthaelt keine Punkte', () => {
  const labels = baueLabels('chat.example.com');
  const router = labels.find((l) => l.startsWith('traefik.http.routers.'));
  assert.ok(router, `kein Router-Label gefunden: ${JSON.stringify(labels)}`);
  const name = router!.split('.')[3];
  assert.equal(name.includes('.'), false);
  assert.equal(name, 'pulse-chat-example-com');
});

test('die Host-Regel traegt weiterhin den echten Namen', () => {
  const labels = baueLabels('chat.example.com');
  assert.ok(labels.some((l) => l.includes('Host(`chat.example.com`)')));
});

test('der Service-Name (loadbalancer) ist mit dem Router-Namen bereinigt', () => {
  // Traefik zerlegt jeden Label-Schluessel gleich, nicht nur den der Router
  // — ein Service-Name mit Punkten waere derselbe Bruch, nur eine Zeile
  // weiter unten.
  const labels = baueLabels('chat.example.com');
  const service = labels.find((l) => l.startsWith('traefik.http.services.'));
  assert.ok(service, `kein Service-Label gefunden: ${JSON.stringify(labels)}`);
  const name = service!.split('.')[3];
  assert.equal(name, 'pulse-chat-example-com');
});

test('ein Hostname mit Bindestrichen bleibt lesbar (keine Doppel-Bereinigung)', () => {
  // Bindestriche sind fuer tr -c '[:alnum:]' '-' bereits Nicht-Alnum und
  // werden durch sich selbst ersetzt — kein Grund, warum ein bestehender
  // Bindestrich im Hostnamen den Namen kaputt machen sollte.
  const labels = baueLabels('chat-test.example.com');
  const router = labels.find((l) => l.startsWith('traefik.http.routers.'));
  const name = router!.split('.')[3];
  assert.equal(name, 'pulse-chat-test-example-com');
});

test('Sonderzeichen im Hostnamen (Angriffsversuch auf den Label-Parser) werden entfernt', () => {
  // Kein realer FQDN sieht so aus (die Cloud liefert SRV_HOST), aber der
  // Bereiniger soll sich nicht auf "kommt schon nur ein Punkt vor" verlassen
  // — jedes Zeichen, das Traefiks Reflection-Parser (Punkt als
  // Feldtrenner, `@` als Provider-Trenner, `[...]` als Index-Syntax in
  // aelteren Versionen) eine Sonderbedeutung gibt, muss draussen bleiben.
  const labels = baueLabels('evil@example.com/[0]');
  const router = labels.find((l) => l.startsWith('traefik.http.routers.'));
  const name = router!.split('.')[3];
  assert.match(name, /^[A-Za-z0-9-]+$/, `Name enthaelt Sonderzeichen: ${name}`);
  assert.equal(name.includes('.'), false);
  assert.equal(name.includes('@'), false);
  assert.equal(name.includes('['), false);
});

test('ein sehr langer Hostname sprengt den Bereiniger nicht (keine Kuerzung noetig, keine leere Ausgabe)', () => {
  const langesLabel = 'a'.repeat(200) + '.example.com';
  const labels = baueLabels(langesLabel);
  const router = labels.find((l) => l.startsWith('traefik.http.routers.'));
  assert.ok(router, `kein Router-Label gefunden: ${JSON.stringify(labels)}`);
  const name = router!.split('.')[3];
  assert.ok(name.length > 200, `Name unerwartet kurz: ${name.length}`);
  assert.equal(name.includes('.'), false);
});
