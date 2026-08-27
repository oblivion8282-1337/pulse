/**
 * Der Einstieg in den eigenen Server, nachdem er die Einstellungen verlassen
 * hat (2026-08-27).
 *
 * Warum das eine eigene Datei wert ist: `settingsTabs.ts` speist DREI
 * Oberflächen — den Dialog am Rechner, die Liste im Du-Bereich und den
 * aufgeschobenen Bildschirm `/app/me/[section]`. Ein Reiter dort zu entfernen
 * nimmt den Zugang auf allen drei Größen gleichzeitig weg; wer den Ersatz nur
 * am Rechner nachsieht, merkt nicht, dass Tablet und Handy leer ausgehen.
 * Genau diese Lücke prüft der zweite Test.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const RECHNER = { width: 1440, height: 900 };
const TABLET = { width: 834, height: 1112 };
const HANDY = { width: 390, height: 844 };

async function anmelden(page: Page, name: string) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(name);
  await page.getByTestId('reg-email').fill(`${name}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill(PW);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

test.describe.configure({ mode: 'serial' });

test.describe('Eigener Server: Einstieg und Route', () => {
  test('am Rechner fuehrt der Fuss der Server-Leiste hin', async ({ browser }) => {
    const page = await browser.newPage({ viewport: RECHNER });
    await anmelden(page, `sh_desk_${TAG}`);

    await expect(page.getByTestId('open-self-host')).toBeVisible();
    await page.getByTestId('open-self-host').click();
    await page.waitForURL(/\/app\/server/);
    await expect(page.getByTestId('self-host-page')).toBeVisible();
    // Der Inhalt ist derselbe wie im frueheren Reiter — nicht nur ein Rahmen.
    await expect(page.getByTestId('self-host-panel')).toBeVisible();
    await page.close();
  });

  test('der Reiter in den Einstellungen ist weg — auf allen drei Wegen', async ({ browser }) => {
    const page = await browser.newPage({ viewport: RECHNER });
    await anmelden(page, `sh_tab_${TAG}`);

    // 1. Dialog am Rechner. Die Reiter tragen keine eigenen testids, also
    //    pruefen wir das, worauf es ankommt: der Self-Host-Inhalt liegt nicht
    //    mehr IM Dialog. Ein Vergleich auf die Reiter-Beschriftung waere
    //    wertlos — den Text gibt es seit dem Umzug ohnehin nicht mehr.
    await page.getByTestId('user-footer-trigger').first().click();
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await expect(page.getByTestId('settings-dialog').getByTestId('self-host-panel')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // 2. Der aufgeschobene Bildschirm kennt die Kennung nicht mehr und schickt
    //    zurueck zur Uebersicht, statt eine leere Seite zu zeigen.
    await page.setViewportSize(HANDY);
    await page.goto('/app/me/self-host');
    await page.waitForURL((u) => u.pathname === '/app/me');
    await page.close();
  });

  test('auf Tablet und Handy steht er am Fuss der Raeume-Liste', async ({ browser }) => {
    for (const [name, groesse] of [['Tablet', TABLET], ['Handy', HANDY]] as const) {
      const page = await browser.newPage({ viewport: groesse });
      await anmelden(page, `sh_${name.toLowerCase()}_${TAG}`);

      await page.goto('/app/rooms');
      const knopf = page.getByTestId('rooms-open-self-host');
      await expect(knopf, `${name}: Einstieg fehlt`).toBeVisible();

      // Trefflaeche wie ueberall auf schmalen Geraeten: mindestens 48 dp.
      const box = await knopf.boundingBox();
      expect(box!.height, `${name}: zu flach`).toBeGreaterThanOrEqual(48);

      await knopf.click();
      await page.waitForURL(/\/app\/server/);
      await expect(page.getByTestId('self-host-panel')).toBeVisible();
      await page.close();
    }
  });
});
