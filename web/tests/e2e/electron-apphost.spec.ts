/**
 * GUI-E2E für das App-Hosting mit ECHTEM Electron-Main-Prozess + echtem Container.
 *
 * Opt-in (läuft NICHT im normalen `playwright test`): `PULSE_ELECTRON_E2E=1`.
 * Voraussetzungen über die normale Harness hinaus:
 *   - `cd desktop && pnpm run build:electron` (macht der Test selbst)
 *   - lokal gebautes allinone-Image, Ref via `PULSE_HOST_IMAGE`
 *     (Default hier: pulse-allinone:frpc-test) — Registry-Login/Pull werden
 *     dann übersprungen (Dev-Creds existieren im Prod-Registry-Realm nicht)
 *   - Medien-Ports 1936/3478/8189/7882-7892 frei (Dev-MediaMTX vorher stoppen:
 *     `docker stop streaming-mediamtx`) — sonst skippt der Test mit Hinweis
 *   - Docker/Podman erreichbar; Desktop-Session (Electron öffnet ein Fenster)
 *
 * Ablauf: Registrierung im Electron-Fenster → Owner+Entitlement via API/psql →
 * App-Host-Antrag + Approve via API (Cookie) → die Karte verlässt live den
 * Locked-Zustand → Start-Knopf → Phasen bis 'live' (echter Container-Boot) →
 * Relay-URL sichtbar → Stop → idle. Main läuft mit PULSE_HOST_ASSUME_REACHABLE=1
 * (STUN/UDP-Diagnose ist auf Dev-Maschinen oft geblockt) und frischem
 * XDG_CONFIG_HOME (sauberer Pairing-Store).
 */

import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const AUTH = 'http://127.0.0.1:8001';
const IMAGE = process.env.PULSE_HOST_IMAGE ?? 'pulse-allinone:frpc-test';

const ts = Date.now();
const OWNER = {
  username: `hostowner_${ts}`,
  email: `hostowner_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass',
};

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); res(false); });
    s.on('error', () => res(true));
  });
}

/** Cookie-Login gegen auth-svc; gibt den pulse_session-Cookie-Header zurück. */
async function cookieLogin(): Promise<string> {
  const r = await fetch(`${AUTH}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_or_username: OWNER.username, password: OWNER.password }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const setCookie = r.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/pulse_session=[^;]+/);
  if (!m) throw new Error('no pulse_session cookie');
  return m[0];
}

test.describe('electron-apphost (opt-in)', () => {
  test.skip(process.env.PULSE_ELECTRON_E2E !== '1', 'Opt-in: PULSE_ELECTRON_E2E=1 setzen');
  test.setTimeout(420_000);

  test.afterAll(() => {
    execSync('docker rm -f pulse-host 2>/dev/null; docker volume rm pulse-host-data 2>/dev/null; true', {
      shell: '/bin/bash',
    });
  });

  test('Antrag → Approve → Start-Knopf → live (echter Container) → Stop', async () => {
    test.skip(!(await portFree(1936)), 'Port 1936 belegt — Dev-MediaMTX stoppen (docker stop streaming-mediamtx)');

    // Frisch bauen + alte Container-Reste räumen (Named Volume → sauberer initdb).
    execSync('pnpm run build:electron', { cwd: join(ROOT, 'desktop'), stdio: 'ignore' });
    execSync('docker rm -f pulse-host 2>/dev/null; docker volume rm pulse-host-data 2>/dev/null; true', {
      shell: '/bin/bash',
    });

    const req = createRequire(join(ROOT, 'desktop', 'package.json'));
    const electronBin = req('electron') as unknown as string;

    const app = await electron.launch({
      executablePath: electronBin,
      args: [join(ROOT, 'desktop')],
      env: {
        ...process.env,
        PULSE_DEV_URL: 'http://127.0.0.1:5173',
        PULSE_HOST_IMAGE: IMAGE,
        PULSE_HOST_ASSUME_REACHABLE: '1',
        // Sauberer Pairing-/Settings-Store pro Lauf (userData folgt XDG unter Linux).
        XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'pulse-e2e-')),
      },
    });

    try {
      const page = await app.firstWindow();

      // 1. Registrieren (im Electron-Fenster — gleiche SPA wie im Browser).
      await page.goto('http://127.0.0.1:5173/register');
      await page.getByTestId('reg-username').fill(OWNER.username);
      await page.getByTestId('reg-email').fill(OWNER.email);
      await page.getByTestId('reg-password').fill(OWNER.password);
      await page.getByTestId('reg-submit').click();
      await page.waitForURL(/\/app/, { timeout: 15_000 });
      await page.getByTestId('backup-onboarding-skip-btn').click({ timeout: 2_500 }).catch(() => undefined);

      // 2. Owner-Stufe direkt in der Test-DB (Approve-Route ist Owner-only).
      const envFile = readFileSync(join(ROOT, '.env'), 'utf8');
      const pgPass = envFile.match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1] ?? '';
      execFileSync(
        'psql',
        ['-h', 'localhost', '-p', '5434', '-U', 'dcc', '-d', 'dcc_test', '-c',
          `UPDATE auth.users SET is_admin=true, is_owner=true WHERE username='${OWNER.username}';`],
        { env: { ...process.env, PGPASSWORD: pgPass }, stdio: 'ignore' },
      );

      // 3. Antrag + Approve via API (Cookie-Auth wie die echte Web-App).
      const cookie = await cookieLogin();
      const appResp = await fetch(`${AUTH}/me/app-host-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ purpose: 'privat', message: 'electron gui e2e' }),
      });
      expect(appResp.status, await appResp.clone().text()).toBe(201);
      const { id: appId } = (await appResp.json()) as { id: string };
      const approve = await fetch(`${AUTH}/admin/app-host-applications/${appId}/approve`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(approve.status, await approve.clone().text()).toBe(200);

      // 4. Frisch laden (statt auf den Antrags-Poller zu warten — /me +
      //    Instanz-Liste kommen beim Boot deterministisch) und Karte öffnen.
      await page.reload();
      await page.waitForURL(/\/app/, { timeout: 15_000 });
      await page.evaluate(async () => {
        // @ts-expect-error Vite-served path resolved at browser runtime
        const { uiOverlays } = await import(/* @vite-ignore */ '/src/lib/stores/uiOverlays.svelte.ts');
        uiOverlays.settingsOpen = true;
      });
      await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5_000 });
      await page.getByTestId('settings-tab-self-host').click();
      await expect(page.getByTestId('local-hosting-section')).toBeVisible({ timeout: 5_000 });

      // 5. Start → live. Deckt Pairing (Mint+Redeem im Main-Prozess), Container-
      //    Recreate und Health-Poll ab. Erster Boot: initdb + Migrationen.
      await page.getByTestId('local-host-start').click({ timeout: 30_000 });
      await expect(page.getByTestId('local-host-live')).toBeVisible({ timeout: 300_000 });
      await expect(page.getByTestId('local-host-url')).toContainText('.relay.howispulse.com');

      // 6. Container läuft wirklich?
      const ps = execSync('docker ps --format "{{.Names}} {{.Status}}"').toString();
      expect(ps).toContain('pulse-host');

      // 7. Stop → idle (Karte zeigt wieder den Start-Zustand).
      await page.getByRole('button', { name: 'Server beenden' }).click();
      await expect(page.getByTestId('local-host-start')).toBeVisible({ timeout: 90_000 });
    } finally {
      await app.close();
    }
  });
});
