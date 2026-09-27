import { test, expect, type Page } from '@playwright/test';

/**
 * Heim-Server (2026-09-27): Klicktests der Weboberfläche nach dem Umbau auf
 * Selbstbedienung. Der Nutzer-Weg ist: Download-Karte OHNE Sperre/Antrag,
 * Antragsformular nur noch VPS, keine App-Host-Kachel mehr. Die Server-App
 * selbst (Electron) registriert sich per API — die deckt die Auth-Integrationstests
 * (test_instance_selfservice.py) ab; hier ist die sichtbare Oberfläche dran.
 */

const ts = Date.now();

async function register(page: Page, u: { username: string; email: string; password: string }) {
  // Die Anmeldung bounct sporadisch zurück auf /register (produktseitig) —
  // zweiter Klick fängt das (Muster wie in den anderen Specs).
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  for (let versuch = 0; versuch < 2; versuch++) {
    await page.getByTestId('reg-submit').click();
    try {
      await page.waitForURL(/\/app/, { timeout: 20_000 });
      break;
    } catch {
      if (versuch === 1) throw new Error('register blieb hängen');
    }
  }
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

/** Das Server-Panel lebt auf /app/server (Einstieg: Rail-/Rooms-Knopf). */
async function oeffneServerPanel(page: Page): Promise<void> {
  await page.goto('/app/server');
  await expect(page.getByTestId('self-host-panel')).toBeVisible({ timeout: 15_000 });
}

test.describe('Heim-Server: Selbstbedienung in der Oberfläche', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await register(page, {
      username: `heim_${ts}`,
      email: `heim_${ts}@dcc-test.example.com`,
      password: 'sup3r-secret-pass'
    });
  });

  test('Server-App-Karte zeigt den Download ohne Sperre oder Antrag', async () => {
    await oeffneServerPanel(page);
    await expect(page.getByTestId('server-app-download')).toBeVisible({ timeout: 15_000 });
    // Kein locked-Zustand mehr: der Download ist SOFORT da, ohne Antrag.
    // Die Suite-Cheats melden Windows — der Windows-Link muss da sein
    // (seit Baustein 5 gibt es für alle drei Systeme Pakete).
    await expect(page.getByTestId('server-app-download-windows')).toBeVisible();
    await expect(page.getByTestId('local-host-locked')).toHaveCount(0);
  });

  test('Antragsformular: nur noch VPS, keine App-Host-Kachel', async () => {
    await oeffneServerPanel(page);
    const formular = page.locator('form', { has: page.getByTestId('hosting-mode-vps') });
    await expect(formular).toBeVisible({ timeout: 15_000 });
    // Die App-Host-Kachel ist weg (Selbstbedienung ersetzt den Antrag).
    await expect(page.getByTestId('hosting-mode-app-host')).toHaveCount(0);
    // Der VPS-Weg bleibt unverändert.
    await expect(page.getByTestId('hosting-mode-vps')).toBeVisible();
    await expect(page.locator('#sha-hostname')).toBeVisible();
  });
});
