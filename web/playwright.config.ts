import { defineConfig, devices } from '@playwright/test';
import {
  E2E_AUTH_PORT,
  E2E_CHAT_PORT,
  E2E_VOICE_PORT,
  E2E_WEB_PORT,
  E2E_BASE_URL
} from './tests/e2e/_ports';

/**
 * Playwright E2E config for the Discord clone.
 *
 * Braucht Postgres (5434) und Redis (6380). auth-svc und chat-gateway startet
 * die Suite SELBST (`_globalSetup.ts`), den Vite startet Playwright über
 * `webServer` — beides auf eigenen Ports neben dem Dev-Stack, siehe
 * `tests/e2e/_ports.ts`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // `e2e-dm-hetzner.spec.ts` gehoert NICHT in diesen Lauf: er braucht seine
  // eigene Fassung (`tests/e2e/playwright.hetzner.config.ts`) — ohne
  // `globalSetup`, mit einem Vite, dessen API-Ziel auf den Hetzner-Stack
  // zeigt, und mit einem `ssh`-Zugang fuer die Postgres-Gegenprobe. Hier
  // mitgenommen war er dauerhaft rot, und ein dauerhaft roter Test kann
  // keine Regression mehr melden: er faerbt jeden Lauf ein und nimmt den
  // Rest seiner Datei als "did not run" mit. Fahren:
  //   pnpm exec playwright test tests/e2e/e2e-dm-hetzner.spec.ts \
  //     --config=tests/e2e/playwright.hetzner.config.ts
  testIgnore: ['**/_*.ts', '**/e2e-dm-hetzner.spec.ts'],
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
    baseURL: E2E_BASE_URL,
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
    url: E2E_BASE_URL,
    // Diese vier Variablen sind der Grund, warum die Suite neben dem Dev-Stack
    // laufen kann: der hier gestartete Vite hört auf einem eigenen Port und
    // leitet auf die Test-Dienste weiter statt auf die des Dev-Stacks. Sie
    // müssen die AUFGELÖSTEN Werte tragen — der Kindprozess erbt zwar
    // `process.env`, aber die Vorgaben stehen nur hier, nicht in der Umgebung.
    env: {
      PULSE_WEB_PORT: String(E2E_WEB_PORT),
      PULSE_API_AUTH_PORT: String(E2E_AUTH_PORT),
      PULSE_API_CHAT_PORT: String(E2E_CHAT_PORT),
      PULSE_API_VOICE_PORT: String(E2E_VOICE_PORT)
    },
    // KEIN Wiederverwenden — auch lokal nicht. Ein vorhandener Server auf dem
    // Port wird mitsamt seiner Proxy-Tabelle übernommen, und die entscheidet,
    // welche Dienste und damit welche DATENBANK die Tests erreichen. Ein alter
    // Test-Vite aus einer anderen Arbeitskopie oder von vor dieser Änderung
    // zeigt woanders hin, und der Lauf wäre still falsch — genau der Fehler,
    // gegen den diese Portgruppe gebaut ist. Ein eigener Start kostet ein paar
    // Sekunden gegen sechs Minuten Suite; `strictPort` meldet einen belegten
    // Port jetzt laut, statt daneben auszuweichen.
    reuseExistingServer: false,
    timeout: 30_000
  }
});
