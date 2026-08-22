/**
 * Entdecken — das Verzeichnis öffentlicher Communities.
 *
 * Der wichtigste Test hier ist der zweite: **eine öffentliche Adresse allein
 * bringt eine Community NICHT ins Schaufenster.** Das ist eine
 * Datenschutz-Entscheidung, keine Anzeige-Kleinigkeit — wer heute eine
 * Adresse zum Teilen hat, hat einem durchsuchbaren Verzeichnis nie
 * zugestimmt. Ein Fehler an dieser Stelle sähe im Alltag wie „mehr Inhalt"
 * aus und wäre trotzdem falsch.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Passwort123!';
const TAG = Date.now().toString(36);
const HANDY = { width: 390, height: 844 };

test.describe.configure({ mode: 'serial' });

test.describe('Entdecken', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: HANDY });
    await page.goto('/register');
    await page.getByTestId('reg-username').fill(`disc_${TAG}`);
    await page.getByTestId('reg-email').fill(`disc_${TAG}@dcc-test.example.com`);
    await page.getByTestId('reg-password').fill(PW);
    await page.getByTestId('reg-submit').click();
    await page.waitForURL(/\/app/);
    await page
      .locator('[data-testid=backup-onboarding-skip-btn]')
      .click({ timeout: 2500 })
      .catch(() => undefined);

    // Zwei Communities: eine gelistet, eine nur oeffentlich.
    await page.evaluate(
      async ([tag]) => {
        const token = localStorage.getItem('dcc.tokens.access');
        const kopf = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
        const mach = async (name: string, handle: string, listed: boolean) => {
          const g = await (
            await fetch('/api/chat/guilds', {
              method: 'POST',
              headers: kopf,
              body: JSON.stringify({ name })
            })
          ).json();
          await fetch(`/api/chat/guilds/${g.id}/channels`, {
            method: 'POST',
            headers: kopf,
            body: JSON.stringify({ name: 'allgemein', type: 0 })
          });
          await fetch(`/api/chat/guilds/${g.id}`, {
            method: 'PATCH',
            headers: kopf,
            body: JSON.stringify({
              handle,
              is_public: true,
              listed,
              category: listed ? 'gaming' : ''
            })
          });
        };
        await mach(`Schaufenster ${tag}`, `schau-${tag}`, true);
        await mach(`Stille ${tag}`, `still-${tag}`, false);
      },
      [TAG] as const
    );
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('gelistete Communities erscheinen im Verzeichnis', async () => {
    await page.goto('/app/discover');
    await expect(page.getByTestId(`discover-card-schau-${TAG}`)).toBeVisible();
  });

  test('eine oeffentliche Adresse allein listet NICHT', async () => {
    await expect(page.getByTestId(`discover-card-still-${TAG}`)).toBeHidden();
  });

  test('die Suche filtert', async () => {
    await page.getByTestId('discover-search').fill(`Schaufenster ${TAG}`);
    await expect(page.getByTestId(`discover-card-schau-${TAG}`)).toBeVisible();
    await page.getByTestId('discover-search').fill('gibtesnicht-xyz');
    await expect(page.getByTestId(`discover-card-schau-${TAG}`)).toBeHidden();
    await page.getByTestId('discover-search').fill('');
    await expect(page.getByTestId(`discover-card-schau-${TAG}`)).toBeVisible();
  });

  test('die Kategorie-Chips filtern', async () => {
    await page.getByTestId('discover-category-music').click();
    await expect(page.getByTestId(`discover-card-schau-${TAG}`)).toBeHidden();
    await page.getByTestId('discover-category-gaming').click();
    await expect(page.getByTestId(`discover-card-schau-${TAG}`)).toBeVisible();
  });

  test('der Raeume-Bereich fuehrt hierher', async () => {
    await page.goto('/app/rooms');
    await page.getByTestId('rooms-discover-link').click();
    await page.waitForURL(/\/app\/discover$/);
    await expect(page.getByTestId('discover-page')).toBeVisible();
  });
});
