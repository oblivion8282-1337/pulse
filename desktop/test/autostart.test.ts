import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyAutostart, autostartDesktopEntry, linuxExecLine, FLATPAK_SERVER_APP_ID,
  type AutostartDeps,
} from '../electron/autostart.ts';

test('linuxExecLine: Flatpak → flatpak run <app-id>, sonst gequoteter Binary-Pfad', () => {
  assert.equal(linuxExecLine(true, '/usr/bin/x'), `flatpak run ${FLATPAK_SERVER_APP_ID}`);
  assert.equal(linuxExecLine(false, '/opt/My App/pulse'), '"/opt/My App/pulse"');
});

test('autostartDesktopEntry: XDG-Pflichtfelder + X-Flatpak nur im Flatpak', () => {
  const fp = autostartDesktopEntry('flatpak run x', true);
  assert.match(fp, /^\[Desktop Entry\]$/m);
  assert.match(fp, /^Type=Application$/m);
  assert.match(fp, /^Exec=flatpak run x$/m);
  assert.match(fp, new RegExp(`^X-Flatpak=${FLATPAK_SERVER_APP_ID}$`, 'm'));
  assert.equal(autostartDesktopEntry('"/usr/bin/x"', false).includes('X-Flatpak'), false);
});

function linuxDeps(home: string, over: Partial<AutostartDeps> = {}): AutostartDeps {
  return {
    platform: 'linux', flatpak: false, execPath: '/usr/bin/pulse-server', home,
    setLoginItems: () => { throw new Error('nicht auf Linux'); },
    ...over,
  };
}

test('applyAutostart linux: enabled schreibt .desktop, disabled entfernt sie', () => {
  const home = mkdtempSync(join(tmpdir(), 'pulse-autostart-'));
  try {
    const file = join(home, '.config', 'autostart', 'pulse-server.desktop');
    assert.deepEqual(applyAutostart(true, linuxDeps(home)), { ok: true });
    assert.equal(existsSync(file), true);
    assert.match(readFileSync(file, 'utf8'), /^Exec="\/usr\/bin\/pulse-server"$/m);
    assert.deepEqual(applyAutostart(false, linuxDeps(home)), { ok: true });
    assert.equal(existsSync(file), false);
    // disabled ohne existierende Datei bleibt ok (idempotent).
    assert.deepEqual(applyAutostart(false, linuxDeps(home)), { ok: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('applyAutostart win32/darwin: delegiert an setLoginItems', () => {
  const calls: boolean[] = [];
  const deps = linuxDeps('/nope', {
    platform: 'win32',
    setLoginItems: (open) => { calls.push(open); },
  });
  assert.deepEqual(applyAutostart(true, deps), { ok: true });
  assert.deepEqual(applyAutostart(false, { ...deps, platform: 'darwin' }), { ok: true });
  assert.deepEqual(calls, [true, false]);
});

test('applyAutostart: Fehler (setLoginItems wirft) → ok:false, kein throw', () => {
  const deps = linuxDeps('/nope', {
    platform: 'win32',
    setLoginItems: () => { throw new Error('boom'); },
  });
  assert.deepEqual(applyAutostart(true, deps), { ok: false });
});
