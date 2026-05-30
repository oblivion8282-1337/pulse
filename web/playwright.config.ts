import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config for the Discord clone.
 *
 * Requires the auth-svc (port 8001), chat-gateway (port 8002),
 * postgres (5434) and redis (6380) to be running. The web dev server
 * is started by Playwright via `webServer`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/_*.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  globalSetup: './tests/e2e/_globalSetup.ts',
  globalTeardown: './tests/e2e/_globalTeardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    headless: true,
    // i18n: Browser-Sprache auf Deutsch pinnen, damit die UI in der Quellsprache
    // rendert (die Tests assert'en auf deutsche Texte). Paraglide wählt über
    // preferredLanguage → 'de'; ohne Pin könnte die CI-Locale Englisch liefern.
    locale: 'de-DE'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
