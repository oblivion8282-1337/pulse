// Härtung des nativen Windows-Backends — alles, was ohne Windows prüfbar ist:
// PID-Dateien/Aufräumen (injizierte Prozessabfrage), Port-Vorabprüfung,
// Export/Import (GNU-tar statt bsdtar, gleiche Aufrufform), asynchrone
// Postgres-Läufe mit Zeitgrenze, Admin-Erkennung, gepackte Pfadauflösung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  raeumeAlteLaeufe, schreibePidDatei, parsePidDatei, gehoertUns, parseProzessliste, loeschePidDateien,
  type LebenderProzess,
} from '../../electron/localBackend/nativeBackend/laufreste.ts';
import { belegtePorts, portBelegtFehler, FESTE_TCP_PORTS } from '../../electron/localBackend/nativeBackend/portPruefung.ts';
import { exportiereDaten, importiereDaten, PG_HBA_EIGEN } from '../../electron/localBackend/nativeBackend/datenTransfer.ts';
import { laufe, postgresStartFehler } from '../../electron/localBackend/nativeBackend/postgres.ts';
import { nativeRoot, resolveNativeBin } from '../../electron/localBackend/nativeBackend/paths.ts';
import { renderGarnetConf } from '../../electron/localBackend/nativeBackend/configs.ts';
import { SupervisedProcess } from '../../electron/localBackend/nativeBackend/processes.ts';
import { NATIVE_PORTS } from '../../electron/localBackend/nativeBackend/types.ts';

const TMP = mkdtempSync(join(tmpdir(), 'pulse-native-haertung-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const TAR = { tar: 'tar' };

function frischesDir(name: string): string {
  const d = join(TMP, name);
  mkdirSync(d, { recursive: true });
  return d;
}

// ── PID-Dateien ─────────────────────────────────────────────────────────────

test('Aufräumen: nur PIDs mit gleichem Image UND passender Startzeit werden beendet', async () => {
  const run = frischesDir('run-a');
  const t = Date.parse('2026-10-08T10:00:00Z');
  const img = 'C:\\Pulse\\native-bin\\pg\\bin\\postgres.exe';
  schreibePidDatei(run, 'postgres', { pid: 100, image: img, gestartet: t });
  schreibePidDatei(run, 'garnet', { pid: 200, image: 'C:\\Pulse\\native-bin\\garnet\\GarnetServer.exe', gestartet: t });
  schreibePidDatei(run, 'caddy', { pid: 300, image: 'C:\\Pulse\\native-bin\\caddy.exe', gestartet: t });
  writeFileSync(join(run, 'weed-s3.pid'), '400'); // altes Format: nackte Zahl
  const lebend = new Map<number, LebenderProzess>([
    [100, { path: 'c:/pulse/native-bin/pg/bin/POSTGRES.EXE', start: t + 800 }], // unser (Schreibweise egal)
    [200, { path: 'C:\\Windows\\explorer.exe', start: t }], // PID recycelt
    [300, { path: 'C:\\Pulse\\native-bin\\caddy.exe', start: t + 3_600_000 }], // gleiches Image, späterer Lauf
    [400, { path: 'C:\\Pulse\\native-bin\\weed.exe', start: t }],
  ]);
  const getoetet: number[] = [];
  const n = await raeumeAlteLaeufe(run, {
    prozessInfo: async () => lebend,
    kill: async (pid) => { getoetet.push(pid); },
  });
  assert.equal(n, 1);
  assert.deepEqual(getoetet, [100]);
  assert.deepEqual(readdirSync(run).filter((f) => f.endsWith('.pid')), [], 'alle PID-Dateien weg');
});

test('PID-Datei: altes Format und Müll berechtigen zu nichts', () => {
  assert.equal(parsePidDatei('1234'), null);
  assert.equal(parsePidDatei(''), null);
  assert.equal(parsePidDatei('{"pid":-1,"image":"x","gestartet":1}'), null);
  assert.deepEqual(parsePidDatei('{"pid":5,"image":"x.exe","gestartet":7}'), { pid: 5, image: 'x.exe', gestartet: 7 });
  assert.equal(gehoertUns({ pid: 5, image: 'x.exe', gestartet: 7 }, undefined), false);
  assert.equal(gehoertUns({ pid: 5, image: 'x.exe', gestartet: 7 }, { path: null, start: 7 }), false);
});

test('parseProzessliste: PowerShell-Zeilen pid|pfad|ISO', () => {
  const m = parseProzessliste('12|C:\\a\\b.exe|2026-10-08T10:00:00.0000000Z\r\n13||\r\n\r\nquatsch\n');
  assert.equal(m.get(12)?.path, 'C:\\a\\b.exe');
  assert.equal(m.get(12)?.start, Date.parse('2026-10-08T10:00:00Z'));
  assert.deepEqual(m.get(13), { path: null, start: null });
  assert.equal(m.size, 2);
});

test('loeschePidDateien: nur *.pid, Configs bleiben', () => {
  const run = frischesDir('run-b');
  writeFileSync(join(run, 'a.pid'), '{}');
  writeFileSync(join(run, 'Caddyfile'), 'x');
  loeschePidDateien(run);
  assert.deepEqual(readdirSync(run), ['Caddyfile']);
});

test('SupervisedProcess.onSpawn feuert mit PID; stderrEnde hält die letzten Zeilen', async () => {
  const proc = new SupervisedProcess({
    name: 'spawn-melder',
    command: process.execPath,
    args: ['-e', 'console.error("zeile-eins"); console.error("zeile-zwei"); setInterval(() => {}, 1000)'],
    healthCheck: async () => true,
  });
  const pids: number[] = [];
  proc.onSpawn((pid) => pids.push(pid));
  await proc.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(pids, [proc.pid]);
  assert.match(proc.stderrEnde(), /zeile-eins\nzeile-zwei/);
  await proc.stop();
});

// ── Ports ───────────────────────────────────────────────────────────────────

test('Port-Vorabprüfung: meldet jeden belegten Port mit Dienstnamen', async () => {
  const belegt = await belegtePorts(async (p) => p === NATIVE_PORTS.garnet || p === NATIVE_PORTS.s3);
  assert.deepEqual(belegt.map((b) => b.port).sort(), [NATIVE_PORTS.s3, NATIVE_PORTS.garnet].sort());
  const msg = portBelegtFehler(belegt).message;
  assert.match(msg, /6379 \(Garnet \(Redis\)\)/);
  assert.match(msg, /9000 \(S3/);
  assert.deepEqual(await belegtePorts(async () => false), []);
});

test('Port-Vorabprüfung: alle festen NATIVE_PORTS sind in der Liste', () => {
  const liste = new Set(FESTE_TCP_PORTS.map((p) => p.port));
  for (const port of Object.values(NATIVE_PORTS)) assert.ok(liste.has(port), `Port ${port} fehlt`);
});

// ── Export / Import ─────────────────────────────────────────────────────────

function baueBestand(root: string, marke: string): void {
  mkdirSync(join(root, 'pg'), { recursive: true });
  mkdirSync(join(root, 'jwt_keys'), { recursive: true });
  mkdirSync(join(root, 'run'), { recursive: true });
  writeFileSync(join(root, 'pg', 'PG_VERSION'), '15\n');
  writeFileSync(join(root, 'pg', 'postgresql.conf'), `# eigene conf ${marke}\n`);
  writeFileSync(join(root, 'pg', 'daten'), marke);
  writeFileSync(join(root, 'jwt_keys', 'postgres.password'), `pw-${marke}`);
  writeFileSync(join(root, 'run', 'frpc.toml'), 'metadatas.token = "geheim"');
  writeFileSync(join(root, 'run', 'postgres.pid'), '{"pid":1}');
}

test('Export: ohne run/ (Tunnel-Token, PID-Dateien), keine Teildatei', async () => {
  const root = frischesDir('exp/data');
  baueBestand(root, 'A');
  const ziel = join(TMP, 'exp', 'sicherung.tar');
  assert.deepEqual(await exportiereDaten(root, ziel, TAR), { ok: true });
  const inhalt = execFileSync('tar', ['-tf', ziel], { encoding: 'utf8' });
  assert.match(inhalt, /pg\/PG_VERSION/);
  assert.doesNotMatch(inhalt, /run\//);
  assert.deepEqual(readdirSync(join(TMP, 'exp')).sort(), ['data', 'sicherung.tar']);
});

test('Export-Fehler: {ok:false}, keine halbe Datei, altes Ziel bleibt', async () => {
  const root = frischesDir('exp2/data');
  baueBestand(root, 'A');
  const ziel = join(TMP, 'exp2', 'alt.tar');
  writeFileSync(ziel, 'alte sicherung');
  const r = await exportiereDaten(root, ziel, { tar: join(TMP, 'gibt-es-nicht') });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(ziel, 'utf8'), 'alte sicherung');
  assert.deepEqual(readdirSync(join(TMP, 'exp2')).sort(), ['alt.tar', 'data']);
});

test('Import: tauscht, verwirft Archiv-Konfiguration und run/, behält eigene postgresql.conf', async () => {
  const quelle = frischesDir('imp/quelle');
  baueBestand(quelle, 'NEU');
  // präparierte Sicherung
  writeFileSync(join(quelle, 'pg', 'postgresql.conf'), "archive_command = 'calc.exe'\n");
  writeFileSync(join(quelle, 'pg', 'postgresql.auto.conf'), "shared_preload_libraries = 'boese'\n");
  writeFileSync(join(quelle, 'pg', 'pg_hba.conf'), 'host all all 0.0.0.0/0 trust\n');
  writeFileSync(join(quelle, 'pg', 'postmaster.pid'), '4\n');
  const archiv = join(TMP, 'imp', 'sicherung.tar');
  execFileSync('tar', ['-cf', archiv, '-C', quelle, '.']); // inkl. run/ — wie ein Alt-Export

  const root = frischesDir('imp/data');
  baueBestand(root, 'ALT');
  assert.deepEqual(await importiereDaten(root, archiv, TAR), { ok: true });
  assert.equal(readFileSync(join(root, 'pg', 'daten'), 'utf8'), 'NEU');
  assert.equal(readFileSync(join(root, 'pg', 'postgresql.conf'), 'utf8'), '# eigene conf ALT\n');
  assert.doesNotMatch(readFileSync(join(root, 'pg', 'postgresql.auto.conf'), 'utf8'), /shared_preload/);
  assert.equal(readFileSync(join(root, 'pg', 'pg_hba.conf'), 'utf8'), PG_HBA_EIGEN);
  assert.ok(!existsSync(join(root, 'pg', 'postmaster.pid')));
  assert.ok(!existsSync(join(root, 'run')));
  // keine Reste neben dem Datenverzeichnis
  assert.deepEqual(readdirSync(join(TMP, 'imp')).sort(), ['data', 'quelle', 'sicherung.tar']);
});

test('Import kaputtes Archiv / fremdes Archiv: Bestand bleibt unangetastet', async () => {
  const dir = frischesDir('imp2');
  const root = frischesDir('imp2/data');
  baueBestand(root, 'ALT');
  const kaputt = join(dir, 'kaputt.tar');
  writeFileSync(kaputt, 'das ist kein tar');
  const r1 = await importiereDaten(root, kaputt, TAR);
  assert.equal(r1.ok, false);
  const fremd = frischesDir('imp2/fremd');
  writeFileSync(join(fremd, 'irgendwas.txt'), 'x');
  const fremdTar = join(dir, 'fremd.tar');
  execFileSync('tar', ['-cf', fremdTar, '-C', fremd, '.']);
  const r2 = await importiereDaten(root, fremdTar, TAR);
  assert.equal(r2.ok, false);
  assert.match((r2 as { error: string }).error, /keine Pulse-Server-Sicherung/);
  assert.equal(readFileSync(join(root, 'pg', 'daten'), 'utf8'), 'ALT');
  assert.ok(existsSync(join(root, 'run', 'frpc.toml')));
  assert.deepEqual(readdirSync(dir).sort(), ['data', 'fremd', 'fremd.tar', 'kaputt.tar']);
});

// ── Postgres-Läufe ──────────────────────────────────────────────────────────

test('laufe: Exit-Code ≠ 0 wirft mit Ausgabe; ignoreIfOutput schluckt', async () => {
  await laufe(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 10_000 });
  await assert.rejects(
    laufe(process.execPath, ['-e', 'console.error("kaputt"); process.exit(3)'], { label: 'probe', timeoutMs: 10_000 }),
    /probe fehlgeschlagen \(exit 3\):\nkaputt/,
  );
  await laufe(process.execPath, ['-e', 'console.error("no server running"); process.exit(1)'], {
    timeoutMs: 10_000, ignoreIfOutput: ['no server running'],
  });
});

test('laufe: hängender Prozess wird nach der Zeitgrenze abgebrochen (blockiert nicht)', async () => {
  const t0 = Date.now();
  await assert.rejects(
    laufe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { label: 'alembic', timeoutMs: 400 }),
    /alembic nach 0 s abgebrochen \(hängt\)/,
  );
  assert.ok(Date.now() - t0 < 5000);
});

test('postgresStartFehler: Administrator-Verweigerung wird klar benannt', () => {
  const e = postgresStartFehler(new Error('postgres exited during startup (code 1)'),
    'Execution of PostgreSQL by a user with administrative permissions is not\npermitted.');
  assert.match(e.message, /Administratorrechten/);
  const anders = postgresStartFehler(new Error('postgres exited'), 'FATAL: data directory has wrong ownership');
  assert.match(anders.message, /postgres exited\nFATAL/);
});

// ── Pfade / Garnet ──────────────────────────────────────────────────────────

test('nativeRoot/resolveNativeBin: gepackt kein PULSE_NATIVE_ROOT, kein PATH-Rückfall', () => {
  const env = { PULSE_NATIVE_ROOT: join(TMP, 'fremd-root'), PATH: process.env.PATH };
  assert.equal(nativeRoot(env, false), join(TMP, 'fremd-root'));
  assert.notEqual(nativeRoot(env, true), join(TMP, 'fremd-root'));
  assert.throws(() => resolveNativeBin('gibt-es-sicher-nicht', env, true), /fehlt in der Installation/);
});

test('renderGarnetConf: Passwort-Modus mit Garnet-Schlüsselnamen', () => {
  assert.deepEqual(JSON.parse(renderGarnetConf('abc')), { AuthenticationMode: 'Password', Password: 'abc' });
});
