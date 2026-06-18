/**
 * E2E fur die LocalHosting-Komponente (Electron-only Host-auf-diesem-Gerat-UI).
 *
 * Strategie: `addInitScript` setzt `window.pulse = { platform: 'electron', host: {...} }`
 * BEVOR der SPA-Code lauft, so dass `isElectron()` true ergibt und `hostStore.available`
 * true ist. Der gemockte `host`-Stub speichert den `onPhase`-Callback und
 * legt einen Test-Hook `window.__emitHostPhase(e)` frei, uber den der Test
 * Phasen treiben kann.
 *
 * Drei Tests:
 *   1. 0 Instanzen → idle zeigt local-host-no-instance, KEIN start-Knopf.
 *   2. 1 Instanz → start → pair → live → Server-Verankerung.
 *   3. (Legacy) Phasen-Walk checking-network → live → not-possible-here.
 *
 * Gemockte Routen:
 *   GET  /api/auth/me/instances            → je nach Test [] oder [eine aktive]
 *   POST /api/auth/me/instances/:id/bootstrap-token → { token, expires_at, ttl_seconds }
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_INSTANCE = {
  id: '123',
  hostname: 'mein-pc',
  client_id: 'c',
  worker_id_chat: 100,
  worker_id_voice: 101,
  worker_id_media: 102,
  status: 'active',
  registered_at: '2026-06-18T00:00:00Z',
};

const BOOTSTRAP_TOKEN_RESPONSE = {
  token: 'plse_boot_x',
  expires_at: '2026-06-18T01:00:00Z',
  ttl_seconds: 300,
};

/** Fugt das window.pulse-Mock (mit host.pair/getPairing/unpair) per addInitScript ein.
 *  Muss VOR dem ersten page.goto() aufgerufen werden. */
async function addPulseMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let _phaseCb: ((e: { phase: string; detail?: unknown }) => void) | null = null;
    let _paired = false;

    const pairingUnpaired = { paired: false };
    const pairingPaired = {
      paired: true,
      hostname: 'mein-pc',
      instanceId: '123',
      relaySubdomain: 'brave-otter.relay.howispulse.com',
    };

    (window as unknown as Record<string, unknown>).pulse = {
      platform: 'electron',
      host: {
        start: (_opts: unknown) => Promise.resolve(),
        stop: () => Promise.resolve(),
        getStatus: () => Promise.resolve({ phase: 'idle' }),
        onPhase: (cb: (e: { phase: string; detail?: unknown }) => void) => {
          _phaseCb = cb;
          return () => { _phaseCb = null; };
        },
        getPairing: () =>
          Promise.resolve(_paired ? pairingPaired : pairingUnpaired),
        pair: (_token: string) => {
          _paired = true;
          (window as unknown as Record<string, unknown>).__pairCalled = true;
          return Promise.resolve({
            paired: true,
            status: pairingPaired,
          });
        },
        unpair: () => {
          _paired = false;
          return Promise.resolve();
        },
      },
      __emitHostPhase: (e: { phase: string; detail?: unknown }) => {
        if (_phaseCb) _phaseCb(e);
      },
    };

    // Test-Hook direkt auf window legen (einfacherer Zugriff im page.evaluate).
    (window as unknown as Record<string, unknown>).__emitHostPhase = (
      e: { phase: string; detail?: unknown }
    ) => {
      const p = (window as unknown as { pulse?: { __emitHostPhase?: (e: unknown) => void } }).pulse;
      if (p?.__emitHostPhase) p.__emitHostPhase(e);
    };
  });
}

/** Registriert einen eindeutigen User, wartet auf /app, klickt ggf. Onboarding weg. */
async function registerAndLoad(page: Page): Promise<void> {
  const ts = Date.now();
  const username = `lhost_${ts}`;
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(username);
  await page.getByTestId('reg-email').fill(`${username}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill('sup3r-secret-pass');
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);

  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 3_000 })
    .catch(() => undefined);
}

/** Offnet den Settings-Dialog und klickt den Self-Host-Tab. */
async function openSelfHostSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // @ts-expect-error - Vite-served path resolved at browser runtime
    const { uiOverlays } = await import(/* @vite-ignore */ '/src/lib/stores/uiOverlays.svelte.ts');
    uiOverlays.settingsOpen = true;
  });

  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('settings-tab-self-host').click();
  await expect(page.getByTestId('local-hosting-section')).toBeVisible({ timeout: 5_000 });
}

// ---------------------------------------------------------------------------
// Test 1: 0 Instanzen — kein Start-Knopf
// ---------------------------------------------------------------------------

test('local-hosting: 0 Instanzen → local-host-no-instance sichtbar, kein Start-Knopf', async ({ page }) => {
  await addPulseMock(page);

  // Route VOR goto() registrieren.
  await page.route('**/api/auth/me/instances', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    } else {
      void route.continue();
    }
  });

  await registerAndLoad(page);
  await openSelfHostSettings(page);

  // idle mit 0 Instanzen → no-instance-Meldung
  await expect(page.getByTestId('local-host-no-instance')).toBeVisible({ timeout: 5_000 });
  // Start-Knopf darf NICHT vorhanden sein
  await expect(page.getByTestId('local-host-start')).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2: 1 Instanz → start → pair → live → Server-Verankerung
// ---------------------------------------------------------------------------

test('local-hosting: 1 Instanz — start → pair → live → Server-Verankerung', async ({ page }) => {
  await addPulseMock(page);

  await page.route('**/api/auth/me/instances', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([ACTIVE_INSTANCE]),
      });
    } else {
      void route.continue();
    }
  });

  await page.route('**/api/auth/me/instances/*/bootstrap-token', (route) => {
    if (route.request().method() === 'POST') {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(BOOTSTRAP_TOKEN_RESPONSE),
      });
    } else {
      void route.continue();
    }
  });

  await registerAndLoad(page);
  await openSelfHostSettings(page);

  // idle mit 1 Instanz → Start-Knopf sichtbar
  await expect(page.getByTestId('local-host-start')).toBeVisible({ timeout: 5_000 });

  // Start klicken → triggert mintBootstrapToken + host.pair intern (asynchron)
  await page.getByTestId('local-host-start').click();

  // Warten bis das async Pairing abgeschlossen ist (host.pair setzt __pairCalled).
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__pairCalled === true, undefined, { timeout: 5_000 });
  const pairCalled = await page.evaluate(() => (window as unknown as Record<string, unknown>).__pairCalled);
  expect(pairCalled).toBe(true);

  // Phasen treiben: checking-network
  await page.evaluate((e) => {
    (window as unknown as { __emitHostPhase: (e: unknown) => void }).__emitHostPhase(e);
  }, { phase: 'checking-network' });
  await expect(page.getByTestId('local-host-progress')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId('local-host-progress')).not.toBeEmpty();

  // live-Phase
  const relayUrl = 'https://brave-otter.relay.howispulse.com';
  await page.evaluate((e) => {
    (window as unknown as { __emitHostPhase: (e: unknown) => void }).__emitHostPhase(e);
  }, { phase: 'live', detail: { relayUrl } });
  await expect(page.getByTestId('local-host-live')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId('local-host-url')).toContainText(relayUrl);

  // Server-Verankerung: serversStore muss einen Eintrag mit instance_id '123' haben.
  // Import uber Vite-Dev-Server (gleiche Instanz wie die App).
  const anchored = await page.evaluate(async () => {
    const importDev = (p: string) => import(/* @vite-ignore */ p);
    const { serversStore } = await importDev('/src/lib/api/servers.svelte.ts');
    return (serversStore.servers as Array<{ instance_id: string | null }>).some(
      (s) => s.instance_id === '123'
    );
  });
  expect(anchored).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3: Phasen-Walk (Legacy — benotigt 1 Instanz-Mock, damit idle-Start sichtbar)
// ---------------------------------------------------------------------------

test('local-hosting: Phasen-UI durchlaufen (checking-network → live → not-possible-here)', async ({ page }) => {
  await addPulseMock(page);

  await page.route('**/api/auth/me/instances', (route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([ACTIVE_INSTANCE]),
      });
    } else {
      void route.continue();
    }
  });

  await registerAndLoad(page);
  await openSelfHostSettings(page);

  // idle: Start-Knopf sichtbar
  await expect(page.getByTestId('local-host-start')).toBeVisible({ timeout: 5_000 });

  // checking-network
  await page.evaluate((e) => {
    (window as unknown as { __emitHostPhase: (e: unknown) => void }).__emitHostPhase(e);
  }, { phase: 'checking-network' });
  await expect(page.getByTestId('local-host-progress')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId('local-host-progress')).not.toBeEmpty();

  // live
  const relayUrl = 'https://demo-abc.howispulse.com';
  await page.evaluate((e) => {
    (window as unknown as { __emitHostPhase: (e: unknown) => void }).__emitHostPhase(e);
  }, { phase: 'live', detail: { relayUrl } });
  await expect(page.getByTestId('local-host-live')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId('local-host-url')).toContainText(relayUrl);

  // not-possible-here
  await page.evaluate((e) => {
    (window as unknown as { __emitHostPhase: (e: unknown) => void }).__emitHostPhase(e);
  }, { phase: 'not-possible-here' });
  await expect(page.getByTestId('local-host-cgnat')).toBeVisible({ timeout: 3_000 });
});
