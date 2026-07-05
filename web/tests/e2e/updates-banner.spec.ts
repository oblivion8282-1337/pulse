/**
 * E2E für den Windows-Auto-Update-In-App-Banner (Toast-Pfad nach Splash-Phase).
 *
 * Strategie: `addInitScript` injiziert ein `window.pulse.updates`-Stub BEVOR
 * der SPA-Code läuft. Die Stub-Subs registrieren einen Callback, der vom
 * Test via Test-Hook getriggert werden kann. Das deckt den Renderer-Pfad in
 * `+layout.svelte` (Toast-Block) ab — die echten `autoUpdater`-Listener
 * leben im Electron-Main (`desktop/electron/updater.ts`) und lassen sich nur
 * in einer echten Electron-Run-Instanz verifizieren, nicht im Browser.
 *
 * Tests:
 *   1. available + ready (manual restart) → "wird geladen" → "Update bereit"
 *      mit Neu-starten-Button; Klick ruft `restartNow()` auf.
 *   2. ready mit autoRestart=true → "Update wird installiert", KEIN Button
 *      (Splash-Pfad hat bereits die Install-Entscheidung getroffen).
 *   3. progress-Event → Toast zeigt Prozent.
 *
 * Andere Layout-Kinder (TraySync, ShortcutHost) checken ihre eigenen Felder
 * per optional-chaining (`?.tray`, `?.shortcuts`) und sind No-ops, wenn diese
 * im Mock fehlen — also kein zusätzlicher Stub nötig.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock-Setup
// ---------------------------------------------------------------------------

interface Subs {
  onAvailable: ((p: { version: string }) => void) | null;
  onProgress: ((p: { percent: number }) => void) | null;
  onReady: ((p: { version: string; autoRestart: boolean }) => void) | null;
}

interface Fired {
  restartNow: boolean;
  check: number;
}

/** Injiziert ein minimal-elektron-Pulse-Mock mit steuerbaren Updates-Subs.
 *  Muss VOR page.goto() aufgerufen werden. */
async function addUpdatesPulseMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const subs: Subs = { onAvailable: null, onProgress: null, onReady: null };
    const fired: Fired = { restartNow: false, check: 0 };

    (window as unknown as Record<string, unknown>).pulse = {
      platform: 'electron',
      updates: {
        onAvailable: (cb: (p: { version: string }) => void) => {
          subs.onAvailable = cb;
          return () => {
            subs.onAvailable = null;
          };
        },
        onProgress: (cb: (p: { percent: number }) => void) => {
          subs.onProgress = cb;
          return () => {
            subs.onProgress = null;
          };
        },
        onReady: (cb: (p: { version: string; autoRestart: boolean }) => void) => {
          subs.onReady = cb;
          return () => {
            subs.onReady = null;
          };
        },
        restartNow: () => {
          fired.restartNow = true;
          return Promise.resolve();
        },
        check: () => {
          fired.check += 1;
          return Promise.resolve();
        },
      },
    };

    // Test-Hooks — direkter Zugriff ohne Type-Casting pro Call.
    (window as unknown as Record<string, unknown>).__emitAvailable = (v: string) => {
      subs.onAvailable?.({ version: v });
    };
    (window as unknown as Record<string, unknown>).__emitProgress = (p: number) => {
      subs.onProgress?.({ percent: p });
    };
    (window as unknown as Record<string, unknown>).__emitReady = (v: string, ar: boolean) => {
      subs.onReady?.({ version: v, autoRestart: ar });
    };
    (window as unknown as Record<string, unknown>).__updateFired = fired;
  });
}

/** Wartet darauf, dass `+layout.svelte`-onMount gelaufen ist und die drei
 *  Updates-Subscriptions registriert hat. Würde man die Events vorher feuern,
 *  wären die Callback-Slots im Mock null und die Events gingen verloren. */
async function waitForUpdatesSubscriptions(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const onReady = (window as { __emitReady?: (v: string, ar: boolean) => void }).__emitReady;
      return typeof onReady === 'function';
    },
    { timeout: 5_000 }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Windows Auto-Update In-App-Banner', () => {
  test('available → ready (manual) → Toast mit Neu-starten-Button ruft restartNow', async ({
    page
  }) => {
    await addUpdatesPulseMock(page);
    await page.goto('/login');
    await waitForUpdatesSubscriptions(page);

    // 1) Update gefunden → "wird geladen" ohne Prozent (initial).
    await page.evaluate(() => (window as unknown as { __emitAvailable: (v: string) => void })
      .__emitAvailable('0.5.0'));
    await expect(page.getByText('Update wird geladen', { exact: false })).toBeVisible();

    // 2) Download fertig, manuelle Variante (autoRestart=false) → "Update bereit"
    //    mit Action-Button.
    await page.evaluate(() =>
      (window as unknown as { __emitReady: (v: string, ar: boolean) => void })
        .__emitReady('0.5.0', false)
    );
    const readyToast = page.getByText('Update bereit', { exact: false });
    await expect(readyToast).toBeVisible();
    await expect(page.getByText(/Version 0\.5\.0/i)).toBeVisible();

    // Action-Button klicken → restartNow wurde gerufen (Mock-Marker).
    await page.getByRole('button', { name: 'Neu starten' }).click();
    await page.waitForFunction(
      () => (window as unknown as { __updateFired: Fired }).__updateFired.restartNow === true,
      { timeout: 2_000 }
    );
  });

  test('ready mit autoRestart=true → "wird installiert", KEIN Action-Button', async ({
    page
  }) => {
    await addUpdatesPulseMock(page);
    await page.goto('/login');
    await waitForUpdatesSubscriptions(page);

    await page.evaluate(() =>
      (window as unknown as { __emitReady: (v: string, ar: boolean) => void })
        .__emitReady('0.5.0', true)
    );
    await expect(page.getByText('Update wird installiert', { exact: false })).toBeVisible();
    // Splash-Pfad hat die Install-Entscheidung bereits getroffen — kein
    // abbrechbarer Button im Toast.
    await expect(page.getByRole('button', { name: 'Neu starten' })).not.toBeVisible();
  });

  test('progress-Event aktualisiert die Prozent-Anzeige im Toast', async ({ page }) => {
    await addUpdatesPulseMock(page);
    await page.goto('/login');
    await waitForUpdatesSubscriptions(page);

    await page.evaluate(() =>
      (window as unknown as { __emitProgress: (p: number) => void }).__emitProgress(42.7)
    );
    await expect(page.getByText('Update wird geladen', { exact: false })).toBeVisible();
    // `+layout.svelte` rendert `${Math.round(data.percent)} %` → 43 %.
    await expect(page.getByText('43 %')).toBeVisible();
  });
});
