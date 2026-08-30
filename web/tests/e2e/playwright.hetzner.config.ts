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
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    headless: true,
    locale: 'de-DE'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
