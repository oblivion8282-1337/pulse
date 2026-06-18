/**
 * Integrationstest: LiveKit + MediaMTX kommen mit den gerenderten Configs healthy hoch.
 *
 * Dieser Test ist die empirische Verifikation der Task-2-Renderer (media.ts):
 * ein falscher YAML-Key → Binary startet nicht → Health-Gate läuft in Timeout → Test scheitert.
 *
 * Ausführen:
 *   cd /Users/michael/Documents/pulse/desktop && \
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     --test --test-timeout=60000 \
 *     test/localBackend/media.int.test.ts
 *
 * Wird übersprungen, wenn livekit-server, mediamtx oder openssl nicht auflösbar.
 * Voraussetzung: brew install livekit mediamtx
 *
 * Hinweis: Die Ports 7880 (LiveKit) und 9997 (MediaMTX) sind fest; wenn dort
 * bereits etwas läuft, schlägt der Test laut fehl.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { resolveBinary, dataDir, BinaryNotFoundError } from '../../electron/localBackend/paths.ts';
import { tcpProbe } from '../../electron/localBackend/health.ts';
import { ensureSecrets } from '../../electron/localBackend/secrets.ts';
import { mediaComponents } from '../../electron/localBackend/media.ts';
import { SupervisedProcess } from '../../electron/localBackend/process.ts';

// ---------------------------------------------------------------------------
// Dependency-Guard
// ---------------------------------------------------------------------------

function binsAvailable(): boolean {
  for (const bin of ['livekit-server', 'mediamtx'] as const) {
    try {
      resolveBinary(bin);
    } catch (e) {
      if (e instanceof BinaryNotFoundError) {
        console.log(`[media.int.test] Überspringe: ${bin} nicht gefunden.`);
        return false;
      }
    }
  }
  try {
    execFileSync('openssl', ['version'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    console.log('[media.int.test] Überspringe: openssl nicht gefunden.');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Test-Suite
// ---------------------------------------------------------------------------

describe('LiveKit + MediaMTX Integrationstest', { skip: !binsAvailable() }, () => {
  let tmpDir: string;
  let livekitProc: SupervisedProcess;
  let mediamtxProc: SupervisedProcess;
  let livekitCfgPath: string;
  let mediamtxCfgPath: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pulse-media-int-test-'));
    const dirs = dataDir(tmpDir);

    // Alle benötigten Verzeichnisse anlegen
    mkdirSync(dirs.root, { recursive: true });
    mkdirSync(dirs.secrets, { recursive: true });

    const secrets = await ensureSecrets(dirs.secrets);

    const specs = mediaComponents({
      dirs,
      secrets,
      env: {},
      voicePort: 8003,
      authHookPort: 55546,
      domain: '127.0.0.1',
    });

    // Spec-Namen für spätere Config-Pfad-Bestimmung merken
    livekitCfgPath = join(dirs.root, 'livekit.yaml');
    mediamtxCfgPath = join(dirs.root, 'mediamtx.yml');

    const [livekitSpec, mediamtxSpec] = specs;

    livekitProc = new SupervisedProcess(livekitSpec);
    mediamtxProc = new SupervisedProcess(mediamtxSpec);

    // Sequentiell starten — beide haben eigene Health-Gates (7880 / 9997)
    await livekitProc.start();
    await mediamtxProc.start();
  }, { timeout: 60_000 });

  after(async () => {
    try { await livekitProc?.stop(); } catch (e) { console.error('[test] LiveKit stop-Fehler:', e); }
    try { await mediamtxProc?.stop(); } catch (e) { console.error('[test] MediaMTX stop-Fehler:', e); }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignorieren */ }
  }, { timeout: 30_000 });

  test('LiveKit: Port 7880 antwortet (Signaling-Listener)', async () => {
    const ok = await tcpProbe(7880);
    assert.ok(ok, 'LiveKit Port 7880 sollte erreichbar sein');
  });

  test('MediaMTX: Port 9997 antwortet (API-Listener)', async () => {
    const ok = await tcpProbe(9997);
    assert.ok(ok, 'MediaMTX Port 9997 sollte erreichbar sein');
  });

  test('livekit.yaml existiert und enthält use_external_ip: true', () => {
    assert.ok(existsSync(livekitCfgPath), `livekit.yaml fehlt: ${livekitCfgPath}`);
    const content = readFileSync(livekitCfgPath, 'utf8');
    assert.match(content, /use_external_ip: true/, 'livekit.yaml muss use_external_ip: true enthalten');
  });

  test('mediamtx.yml existiert und enthält webrtcAdditionalHosts', () => {
    assert.ok(existsSync(mediamtxCfgPath), `mediamtx.yml fehlt: ${mediamtxCfgPath}`);
    const content = readFileSync(mediamtxCfgPath, 'utf8');
    assert.match(content, /webrtcAdditionalHosts/, 'mediamtx.yml muss webrtcAdditionalHosts enthalten');
  });
});
