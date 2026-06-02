/**
 * Wake-lock helper E2E (browser backend).
 *
 * Drives the real `$lib/platform/wakeLock` module in the page with a stubbed
 * `navigator.wakeLock`, asserting the refcount semantics: the underlying lock
 * engages on the first lease and releases only on the last. The Electron
 * backend (`powerSaveBlocker`) shares the same refcount/sync code, so this
 * covers the logic; the IPC bridge itself is exercised manually.
 *
 * No login / app state needed — we only load the SPA shell and import the
 * module, so this runs standalone against the dev server.
 */
import { test, expect } from '@playwright/test';

test('wake-lock refcount engages once and releases on the last lease', async ({ page }) => {
  await page.goto('/login');

  const r = await page.evaluate(async () => {
    const calls = { request: 0, release: 0 };
    const fakeSentinel = {
      released: false,
      addEventListener() {},
      release() {
        calls.release += 1;
        this.released = true;
        return Promise.resolve();
      }
    };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          calls.request += 1;
          return fakeSentinel;
        }
      }
    });

    // @ts-expect-error - Vite-served path resolved at browser runtime
    const mod = await import('/src/lib/platform/wakeLock.ts');
    const { acquireWakeLock } = mod as { acquireWakeLock: () => () => void };
    const settle = () => new Promise((res) => setTimeout(res, 25));

    const lease1 = acquireWakeLock();
    await settle();
    const afterFirst = calls.request; // 1 — engaged

    const lease2 = acquireWakeLock();
    await settle();
    const afterSecond = calls.request; // still 1 — already engaged, refcount only

    lease1();
    await settle();
    const releaseAfterOne = calls.release; // 0 — one lease still held

    lease2();
    await settle();
    const releaseAfterAll = calls.release; // 1 — last lease gone

    return { afterFirst, afterSecond, releaseAfterOne, releaseAfterAll };
  });

  expect(r.afterFirst, 'engages on first lease').toBe(1);
  expect(r.afterSecond, 'does not re-request while already held').toBe(1);
  expect(r.releaseAfterOne, 'stays held while a lease remains').toBe(0);
  expect(r.releaseAfterAll, 'releases when the last lease drops').toBe(1);
});

test('fast acquire→release in the same tick leaks no lock (race regression)', async ({ page }) => {
  await page.goto('/login');

  const r = await page.evaluate(async () => {
    const calls = { request: 0, release: 0 };
    const fakeSentinel = {
      addEventListener() {},
      release() {
        calls.release += 1;
        return Promise.resolve();
      }
    };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          calls.request += 1;
          return fakeSentinel;
        }
      }
    });

    // @ts-expect-error - Vite-served path resolved at browser runtime
    const mod = await import('/src/lib/platform/wakeLock.ts');
    const { acquireWakeLock } = mod as { acquireWakeLock: () => () => void };

    // Acquire and release within the same synchronous tick — mimics a Svelte
    // $effect teardown+re-run before the async engage() settles.
    const release = acquireWakeLock();
    release();
    await new Promise((res) => setTimeout(res, 40));

    // Net: any acquired lock must have been released — no dangling lock.
    return { netHeld: calls.request - calls.release };
  });

  // Pre-fix this was 1 (engage() set the sentinel after disengage() had already
  // run, so the lock was never released). Reconcile-serialization makes it 0.
  expect(r.netHeld, 'no lock left held after a same-tick acquire/release').toBe(0);
});
