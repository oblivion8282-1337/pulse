import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuKb, backupDateiZuMs, IMPORT_SKRIPT } from '../../electron/localBackend/dataTools.ts';
import { updateVerdict } from '../../electron/localBackend/containerBackendManager.ts';

// Update-Entscheidung (Digest-Vergleich laufender Container vs. gepulltes Image)

test('updateVerdict: unterschiedliche IDs → update', () => {
  assert.equal(updateVerdict('abc123', 'def456'), 'update');
});
test('updateVerdict: identische IDs → none', () => {
  assert.equal(updateVerdict('abc123', 'abc123'), 'none');
});
test('updateVerdict: Docker-sha256-Präfix wird normalisiert (Podman ohne Präfix)', () => {
  assert.equal(updateVerdict('sha256:abc123', 'abc123'), 'none');
  assert.equal(updateVerdict('sha256:abc123', 'sha256:def456'), 'update');
});
test('updateVerdict: Whitespace (inspect-Ausgabe endet auf \\n) wird getrimmt', () => {
  assert.equal(updateVerdict('abc123\n', ' abc123 '), 'none');
});
test('updateVerdict: leere/unklare Eingaben → none (fail-safe, kein grundloses Recreate)', () => {
  assert.equal(updateVerdict('', 'abc123'), 'none');
  assert.equal(updateVerdict('abc123', ''), 'none');
  assert.equal(updateVerdict('', ''), 'none');
});

// du-Ausgabe → Bytes

test('parseDuKb: "12345\\t/data" → 12345 KiB in Bytes', () => {
  assert.equal(parseDuKb('12345\t/data\n'), 12345 * 1024);
});
test('parseDuKb: 0 KB → 0 Bytes', () => {
  assert.equal(parseDuKb('0\t/data'), 0);
});
test('parseDuKb: kaputte/leere Ausgabe → null', () => {
  assert.equal(parseDuKb(''), null);
  assert.equal(parseDuKb('du: cannot access'), null);
});

// Backup-Dateiname → Epoche (der Name ist der UTC-Zeitstempel)

test('backupDateiZuMs: regulärer Backup-Name → korrekte UTC-Epoche', () => {
  assert.equal(backupDateiZuMs('pulse-20260929T223006Z.dump'),
    Date.UTC(2026, 8, 29, 22, 30, 6));
});
test('backupDateiZuMs: fremde Dateien im Verzeichnis → null', () => {
  assert.equal(backupDateiZuMs('pulse-20260929T223006Z.dump.part'), null);
  assert.equal(backupDateiZuMs('.bashrc'), null);
  assert.equal(backupDateiZuMs('backup-old.dump'), null);
  assert.equal(backupDateiZuMs(''), null);
});

// Import-Ablauf (Scan 2026-10-08): wirklich in einer Shell gefahren, mit einem
// Temp-Verzeichnis statt /data. Nur dort, wo sh + tar da sind.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function importFahren(daten: string, archiv: string): number {
  const skript = IMPORT_SKRIPT.replaceAll('/data', daten);
  try {
    execFileSync('sh', ['-c', skript], { input: readFileSync(archiv), stdio: ['pipe', 'ignore', 'ignore'] });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

function bestand(): string {
  const d = mkdtempSync(join(tmpdir(), 'pulse-import-'));
  mkdirSync(join(d, 'pg'));
  writeFileSync(join(d, 'pg', 'PG_VERSION'), 'alt');
  writeFileSync(join(d, '.versteckt'), 'alt');
  return d;
}

const ohneShell = process.platform === 'win32';

test('Import: kaputtes Archiv lässt den Bestand unberührt', { skip: ohneShell }, () => {
  const daten = bestand();
  const kaputt = join(mkdtempSync(join(tmpdir(), 'pulse-arch-')), 'kaputt.tar');
  writeFileSync(kaputt, 'das ist kein tar');
  assert.notEqual(importFahren(daten, kaputt), 0);
  assert.equal(readFileSync(join(daten, 'pg', 'PG_VERSION'), 'utf8'), 'alt');
  assert.equal(existsSync(join(daten, '.pulse-import')), false);
});

test('Import: fremdes Archiv ohne pg/PG_VERSION wird abgewiesen (exit 3)', { skip: ohneShell }, () => {
  const daten = bestand();
  const quelle = mkdtempSync(join(tmpdir(), 'pulse-src-'));
  writeFileSync(join(quelle, 'urlaub.jpg'), 'x');
  const archiv = join(quelle, '..', `${quelle.split('/').pop()}.tar`);
  execFileSync('tar', ['-cf', archiv, '-C', quelle, '.']);
  assert.equal(importFahren(daten, archiv), 3);
  assert.equal(readFileSync(join(daten, 'pg', 'PG_VERSION'), 'utf8'), 'alt');
});

test('Import: echtes Backup ersetzt den Bestand vollständig, samt dotfiles', { skip: ohneShell }, () => {
  const daten = bestand();
  const quelle = mkdtempSync(join(tmpdir(), 'pulse-src-'));
  mkdirSync(join(quelle, 'pg'));
  writeFileSync(join(quelle, 'pg', 'PG_VERSION'), 'neu');
  writeFileSync(join(quelle, '.neu'), 'neu');
  const archiv = join(quelle, '..', `${quelle.split('/').pop()}.tar`);
  execFileSync('tar', ['-cf', archiv, '-C', quelle, '.']);
  assert.equal(importFahren(daten, archiv), 0);
  assert.equal(readFileSync(join(daten, 'pg', 'PG_VERSION'), 'utf8'), 'neu');
  assert.equal(readFileSync(join(daten, '.neu'), 'utf8'), 'neu');
  assert.equal(existsSync(join(daten, '.versteckt')), false);
  assert.equal(existsSync(join(daten, '.pulse-import')), false);
});
