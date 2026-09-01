/**
 * Eigene Playwright-Fassung für den Hetzner-Zwei-Geräte-Nachweis: OHNE
 * `globalSetup` (der startet lokale Dienste) und mit einem Vite, dessen
 * API-Ziel per `PULSE_API_ORIGIN` auf den Hetzner zeigt. Das E2E-Spec
 * (`e2e-dm-hetzner.spec.ts`) schaltet den Client-Schalter per Vite-Abfangen
 * selbst ein — der Quelltext bleibt unangetastet.
 *
 *   cd web && pnpm exec playwright test tests/e2e/e2e-dm-hetzner.spec.ts \
 *     --config=tests/e2e/playwright.hetzner.config.ts
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testMatch: /e2e-dm-hetzner\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  /**
   * Vite mit dem API-Ziel auf dem Hetzner. **Dieser Block hat bis zum
   * 2026-09-01 gefehlt**, obwohl der Kopf von `e2e-dm-hetzner.spec.ts` ihn
   * seit jeher als vorhanden beschrieb („Vite muss NICHT extra gestartet
   * werden"). Der Lauf scheiterte dadurch nicht am Nachweis, sondern schon
   * am Aufschlagen der Anmeldeseite — ein Fehlerbild, das wie ein kaputter
   * Stack aussieht und keiner ist.
   *
   * **`reuseExistingServer` steht bewusst auf `false`.** Mit `true` uebernimmt
   * der Lauf einen beliebigen fremden Vite auf 5173 — und der zeigt im
   * Regelfall auf die LOKALEN Dienste, nicht auf den Hetzner. Genau so
   * passiert am 2026-09-01: ein vergessener Vite aus einer frueheren Sitzung
   * lieferte 504, der Nachweis lief zwei Mal ins Zeitlimit, und das
   * Fehlerbild (Anmeldeseite kommt nicht) zeigte auf den Server statt auf
   * den eigenen Rechner. Mit `false` scheitert ein belegter Port sofort und
   * benennbar — wer `pnpm dev:remote` laufen hat, beendet es vorher.
   */
  webServer: {
    command: 'pnpm dev',
    cwd: '../..',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PULSE_API_ORIGIN: process.env.PULSE_API_ORIGIN ?? 'https://pulse.unicutmedia.com' }
  },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    headless: true,
    locale: 'de-DE'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
