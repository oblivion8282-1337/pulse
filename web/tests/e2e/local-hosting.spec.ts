/**
 * E2E fur die LocalHosting-Komponente (Electron-only Host-auf-diesem-Gerat-UI).
 *
 * Strategie: `addInitScript` setzt `window.pulse = { platform: 'electron', host: {...} }`
 * BEVOR der SPA-Code lauft, so dass `isElectron()` true ergibt und `hostStore.available`
 * true ist. Der gemockte `host`-Stub speichert den `onPhase`-Callback und
 * legt einen Test-Hook `window.__emitHostPhase(e)` frei, uber den der Test
 * Phasen treiben kann.
 *
 * Ablauf:
 *   1. Registrierung → /app (setzt pulse_session-Cookie + ladt Vite-Module).
 *   2. Einstellungen offnen → Self-Host-Tab anklicken.
 *   3. idle: `local-host-start` sichtbar.
 *   4. Phase `checking-network` emittieren → `local-host-progress` sichtbar.
 *   5. Phase `live` emittieren → `local-host-live` + `local-host-url` sichtbar.
 *   6. Phase `not-possible-here` emittieren → `local-host-cgnat` sichtbar.
 */

import { test, expect } from '@playwright/test';

test('local-hosting: Phasen-UI durchlaufen', async ({ page }) => {
  // Mock MUSS vor dem ersten Seitenaufruf gesetzt werden, damit isElectron() true
  // ergibt, wenn der Svelte-Code beim Laden ausgefuhrt wird.
  await page.addInitScript(() => {
    let _phaseCb: ((e: { phase: string; detail?: unknown }) => void) | null = null;

    (window as unknown as Record<string, unknown>).pulse = {
      platform: 'electron',
      host: {
        start: (_opts: unknown) => Promise.resolve(),
        stop: () => Promise.resolve(),
        getStatus: () => Promise.resolve({ phase: 'idle' }),
        onPhase: (cb: (e: { phase: string; detail?: unknown }) => void) => {
          _phaseCb = cb;
          return () => { _phaseCb = null; };
        }
      },
      __emitHostPhase: (e: { phase: string; detail?: unknown }) => {
        if (_phaseCb) _phaseCb(e);
      }
    };

    // Test-Hook direkt auf window legen (einfacherer Zugriff im page.evaluate).
    (window as unknown as Record<string, unknown>).__emitHostPhase = (
      e: { phase: string; detail?: unknown }
    ) => {
      const p = (window as unknown as { pulse?: { __emitHostPhase?: (e: unknown) => void } }).pulse;
      if (p?.__emitHostPhase) p.__emitHostPhase(e);
    };
  });

  // Registrierung — gibt pulse_session-Cookie + ladt die App-Module.
  const ts = Date.now();
  const username = `lhost_${ts}`;
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(username);
  await page.getByTestId('reg-email').fill(`${username}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill('sup3r-secret-pass');
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);

  // Eventuellen Onboarding-Dialog wegklicken.
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 3_000 })
    .catch(() => undefined);

  // Einstellungen offnen: uiOverlays.settingsOpen per evaluate setzen.
  // Das Modul ist bereits als Teil der SPA geladen; wir importieren es per
  // Vite-Server-Pfad (kein TS-Modul-Resolving → @vite-ignore + @ts-expect-error).
  await page.evaluate(async () => {
    // @ts-expect-error - Vite-served path resolved at browser runtime
    const { uiOverlays } = await import(/* @vite-ignore */ '/src/lib/stores/uiOverlays.svelte.ts');
    uiOverlays.settingsOpen = true;
  });

  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5_000 });

  // Self-Host-Tab anklicken.
  await page.getByTestId('settings-tab-self-host').click();

  // ── idle: Start-Knopf sichtbar ──────────────────────────────────────────────
  await expect(page.getByTestId('local-hosting-section')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('local-host-start')).toBeVisible();

  // ── checking-network: Fortschritts-Anzeige ──────────────────────────────────
  await page.evaluate((e) => {
    (window as unknown as { __emitHostPhase: (e: unknown) => void }).__emitHostPhase(e);
  }, { phase: 'checking-network' });
  await expect(page.getByTestId('local-host-progress')).toBeVisible({ timeout: 3_000 });
  // Muss einen nicht-leeren Satz zeigen.
  await expect(page.getByTestId('local-host-progress')).not.toBeEmpty();

  // ── live: URL-Anzeige ────────────────────────────────────────────────────────
  const relayUrl = 'https://demo-abc.howispulse.com';
  await page.evaluate((e) => {
    (window as unknown as { __emitHostPhase: (e: unknown) => void }).__emitHostPhase(e);
  }, { phase: 'live', detail: { relayUrl } });
  await expect(page.getByTestId('local-host-live')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId('local-host-url')).toContainText(relayUrl);

  // ── not-possible-here: CGNAT-Karte ──────────────────────────────────────────
  await page.evaluate((e) => {
    (window as unknown as { __emitHostPhase: (e: unknown) => void }).__emitHostPhase(e);
  }, { phase: 'not-possible-here' });
  await expect(page.getByTestId('local-host-cgnat')).toBeVisible({ timeout: 3_000 });
});
