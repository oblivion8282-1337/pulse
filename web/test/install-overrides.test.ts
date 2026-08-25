/**
 * `decide_mode` + `build_run_args` aus `web/static/install.sh` — die beiden
 * harten Overrides `PULSE_TLS_MODE` und `PULSE_NETWORK` (Task 10, II·9).
 *
 * **Warum es diesen Test gibt.** Beide Overrides wirkten bis hierher nur
 * halb, und beide schwiegen darüber:
 *
 *   1. `PULSE_TLS_MODE` kannte nur den Wert `auto` — der Container versteht
 *      `auto | provided | behind-proxy` (s. `09-init-caddy.sh`). Ein Admin,
 *      der `behind-proxy` setzt (der naheliegende Name für den Fall, den er
 *      korrigieren will), oder sich vertippt, sieht: nichts. Der Wert wird
 *      still verworfen, die Auto-Erkennung bleibt am Ruder.
 *   2. `PULSE_NETWORK` hob `MODE` nur von `greenfield` auf `static-docker`.
 *      Aus `hostproxy` heraus — genau der Modus, den ein Admin korrigieren
 *      will, wenn die Erkennung einen Docker-Proxy übersieht — wurde
 *      `PROXY_NET` zwar gesetzt, aber nie in `RUN_ARGS` verbaut.
 *   3. Beide zusammen überstimmten sich unangekündigt: ein `PULSE_NETWORK`
 *      neben einem ausdrücklichen `PULSE_TLS_MODE=auto` zog den Modus doch
 *      wieder auf `static-docker`, obwohl der Admin ausdrücklich Let's-
 *      Encrypt-Auto-TLS verlangt hatte.
 *
 * **Wie das geht:** `decide_mode` und `build_run_args` werden unverändert aus
 * `install.sh` geschnitten (wie in `install-proxy-erkennung.test.ts`) und mit
 * gefälschten Sonden ausgeführt. `detect_proxy` selbst (welcher Container
 * gewinnt) hat eigene Tests dort — hier zählt nur, was NACH der Erkennung mit
 * den beiden Overrides passiert. Die Sonden `port_busy`/
 * `eigener_container_laeuft` erzeugen deshalb nur die zwei Ausgangslagen, die
 * für die Overrides einen Unterschied machen: kein Proxy gefunden, Ports frei
 * (→ MODE=greenfield) und kein Proxy gefunden, Ports belegt (→
 * MODE=hostproxy, der Loopback-Ersatz). Kein `docker` auf dem PATH nötig —
 * `PROXY_KIND` bleibt in jedem Testfall `none`, `discovery` wird hier nicht
 * erreicht (das deckt `install-proxy-erkennung.test.ts` ab).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), '../static/install.sh');

/**
 * Eine Shell-Funktion `name() { … }` bis zur schliessenden Klammer in Spalte 0
 * — heredoc-bewusst (übernommen aus install-updater.test.ts). Weder
 * `decide_mode` noch `build_run_args` enthalten heute einen Heredoc, aber der
 * einfache Schneider (naive erste `}`-Zeile) hat schon einmal einen falschen
 * Treffer geliefert, wenn eine SPÄTERE Änderung einen einzieht — der
 * heredoc-bewusste Schneider kostet hier nichts und bleibt der Standard.
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
  /** `PULSE_TLS_MODE` — leer heisst „nicht gesetzt". */
  tlsMode?: string;
  /** `PULSE_NETWORK` — leer heisst „nicht gesetzt". */
  netzwerk?: string;
  /**
   * Ausgangslage VOR den Overrides, wie sie `decide_mode` aus dem
   * `PROXY_KIND=none`-Zweig herleiten würde: `greenfield` = kein Proxy
   * gefunden, Ports 80/443 frei; `hostproxy` = kein Proxy gefunden, Ports
   * belegt (der Loopback-Ersatz, den ein Admin mit `PULSE_NETWORK` gezielt
   * korrigieren will). Default `greenfield`.
   */
  modeVorher?: 'greenfield' | 'hostproxy';
}

interface Ergebnis {
  mode: string;
  tlsMode: string;
  runArgs: string[];
  abgebrochen: boolean;
  meldung: string;
}

function entscheide(optionen: Optionen): Ergebnis {
  const quelle = readFileSync(SKRIPT, 'utf8');
  const portFrei = (optionen.modeVorher ?? 'greenfield') === 'greenfield';

  const skript = `
set -euo pipefail
err() { printf '[pulse] ERROR: %s\\n' "$*" >&2; }
die() { err "$*"; exit 1; }
warn() { :; }

# Sonden fuer den PROXY_KIND=none-Zweig von decide_mode — kein docker auf dem
# PATH noetig, die Container-Wahl selbst hat ihre eigenen Tests.
detect_proxy() { PROXY_KIND=none; PROXY_CONTAINER=""; PROXY_NET=""; }
eigener_container_laeuft() { return 1; }
port_busy() { ${portFrei ? 'return 1' : 'return 0'}; }

CONTAINER="pulse"
IMAGE="registry.howispulse.com/pulse-allinone:edge"
VOLUME="pulse-data"
ENV_FILE="/dev/null"
HTTP_PORT="8080"
SRV_HOST="<hostname>"
ADMIN_EMAIL=""

FORCE_TLS_MODE="${optionen.tlsMode ?? ''}"
FORCE_NETWORK="${optionen.netzwerk ?? ''}"

${funktion(quelle, 'decide_mode')}
${funktion(quelle, 'build_run_args')}

decide_mode
build_run_args
echo "MODE:\${MODE}"
echo "TLS:\${TLS_MODE}"
printf 'ARG:%s\\n' "\${RUN_ARGS[@]}"
`;

  try {
    const ausgabe = execFileSync('bash', ['-c', skript], { encoding: 'utf8' });
    const zeilen = ausgabe.split('\n');
    const mode = zeilen.find((z) => z.startsWith('MODE:'))?.slice(5) ?? '';
    const tlsMode = zeilen.find((z) => z.startsWith('TLS:'))?.slice(4) ?? '';
    const runArgs = zeilen.filter((z) => z.startsWith('ARG:')).map((z) => z.slice(4));
    return { mode, tlsMode, runArgs, abgebrochen: false, meldung: '' };
  } catch (fehler) {
    const e = fehler as { status?: number; stderr?: string };
    return { mode: '', tlsMode: '', runArgs: [], abgebrochen: true, meldung: e.stderr ?? '' };
  }
}

test('PULSE_TLS_MODE=behind-proxy wird nicht verschluckt', () => {
  const e = entscheide({ tlsMode: 'behind-proxy' });
  assert.equal(e.abgebrochen, false, e.meldung);
  assert.equal(e.tlsMode, 'behind-proxy');
  // Der Admin hat kein Netz genannt — der einzige Weg, "hinter einem Proxy"
  // ohne Netzangabe umzusetzen, ist der Loopback-Ersatz.
  assert.equal(e.mode, 'hostproxy');
  assert.ok(
    e.runArgs.includes('127.0.0.1:8080:8080'),
    `erwartet Loopback-Bind in RUN_ARGS: ${JSON.stringify(e.runArgs)}`
  );
});

test('ein unbekannter PULSE_TLS_MODE bricht ab statt still zu wirken', () => {
  const e = entscheide({ tlsMode: 'behind_proxy' }); // Tippfehler: Unterstrich statt Bindestrich
  assert.equal(e.abgebrochen, true);
  // Die Meldung muss die gueltigen Werte nennen, sonst raet der Admin weiter.
  assert.match(e.meldung, /auto/);
  assert.match(e.meldung, /provided/);
  assert.match(e.meldung, /behind-proxy/);
  // Und sie muss vor der Token-Einloesung sitzen — das ist hier strukturell
  // erzwungen (der Test ruft nur decide_mode/build_run_args auf, niemals den
  // Token-Einloese-Teil), diese Zeile haelt die Erwartung trotzdem explizit
  // fest.
  assert.match(e.meldung, /consumed/);
});

test('PULSE_NETWORK wirkt auch aus hostproxy heraus', () => {
  const e = entscheide({ netzwerk: 'mein-netz', modeVorher: 'hostproxy' });
  assert.equal(e.abgebrochen, false, e.meldung);
  assert.equal(e.mode, 'static-docker');
  assert.ok(e.runArgs.includes('--network'), `erwartet --network in RUN_ARGS: ${JSON.stringify(e.runArgs)}`);
  assert.ok(e.runArgs.includes('mein-netz'));
  // Vorher blieb es beim Loopback-Bind — der ist jetzt weg, sonst haette
  // Pulse zwei widersprüchliche Bindungen zugleich.
  assert.ok(!e.runArgs.some((a) => a.startsWith('127.0.0.1:')));
});

test('PULSE_TLS_MODE=auto wird von PULSE_NETWORK nicht ueberstimmt', () => {
  const e = entscheide({ tlsMode: 'auto', netzwerk: 'mein-netz' });
  assert.equal(e.abgebrochen, false, e.meldung);
  assert.equal(e.tlsMode, 'auto');
  assert.equal(e.mode, 'greenfield');
  assert.ok(e.runArgs.includes('80:80'), `erwartet eigene Port-Bindung: ${JSON.stringify(e.runArgs)}`);
});

test('PULSE_TLS_MODE=provided wird ehrlich durchgereicht, nicht auf auto/behind-proxy verschluckt', () => {
  // `provided` teilt sich die Port-Topologie mit `auto` (Caddy bindet 80/443
  // fuer die Site, nur ohne ACME, s. 09-init-caddy.sh) — nur das TLS_MODE-
  // Etikett im env-file unterscheidet sich. Ob das ohne eine vom Installer
  // angelegte /data/certs-Vorbereitung einen praktischen Nutzen hat, steht
  // im Task-Bericht — hier zaehlt nur: der Wert kommt unverfaelscht an.
  const e = entscheide({ tlsMode: 'provided' });
  assert.equal(e.abgebrochen, false, e.meldung);
  assert.equal(e.tlsMode, 'provided');
  assert.equal(e.mode, 'greenfield');
  assert.ok(e.runArgs.includes('80:80'));
});

test('leerer PULSE_TLS_MODE bricht nicht ab (weiterhin optional)', () => {
  const e = entscheide({});
  assert.equal(e.abgebrochen, false, e.meldung);
  assert.equal(e.tlsMode, 'auto');
  assert.equal(e.mode, 'greenfield');
});
