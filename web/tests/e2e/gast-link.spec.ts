/**
 * Gast-Links: ein Mitglied erzeugt einen Link, ein Browser ohne Konto öffnet
 * ihn und steht im Vorraum.
 *
 * **Wo der Test aufhört und warum:** beim Klick auf „Beitreten". Dahinter
 * liegt LiveKit, und das läuft im Testaufbau nicht — ein weiterführender Test
 * prüfte nur noch, dass eine Verbindung scheitert. Der Teil, den dieser Test
 * belegt, ist trotzdem der, der am leichtesten still kaputtgeht: dass die
 * Gastseite OHNE Anmeldung erreichbar ist und der Vorraum weiss, wohin er
 * gehört. Der Rest liegt in den Backend-Tests (Ticket, Kanalbindung, Riegel)
 * und im Zwei-Geräte-Test von Hand.
 */

import { test, expect } from '@playwright/test';

const ts = Date.now();
const USER = {
  username: `gast_${ts}`,
  email: `gast_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

test('Gast-Link führt ohne Anmeldung in den Vorraum', async ({ page, context }) => {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(USER.username);
  await page.getByTestId('reg-email').fill(USER.email);
  await page.getByTestId('reg-password').fill(USER.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .getByTestId('backup-onboarding-skip-btn')
    .click({ timeout: 2500 })
    .catch(() => undefined);

  await page.locator('[data-testid^="guild-create-menu-"]').first().click();
  await page.getByTestId('guild-create').click();
  await page.getByTestId('create-guild-name').fill('Gast Guild');
  await page.getByTestId('create-guild-submit').click();
  await expect(page.getByTestId('active-channel-name')).toHaveText('general', {
    timeout: 10_000
  });

  // Eine frische Community hat KEINEN Sprachkanal ("Noch keine Sprach-Kanäle")
  // — erst einen anlegen, sonst gibt es nichts, wofür ein Gast-Link gälte.
  await page.getByTestId('channel-create').click();
  await page.getByTestId('create-channel-type-voice').click();
  await page.getByTestId('create-channel-name').fill('besprechung');
  await page.getByTestId('create-channel-submit').click();
  const sprachkanal = page.getByRole('button', { name: 'besprechung' });
  await expect(sprachkanal).toBeVisible({ timeout: 10_000 });

  // Der Gründer hält alle Rechte, also auch MOVE_MEMBERS.
  await sprachkanal.click({ button: 'right' });
  await page.locator('[data-testid^="channel-guest-links-"]').first().click();

  await page.getByTestId('gast-link-erzeugen').click();
  const url = await page.getByTestId('gast-link-url').textContent();
  expect(url).toContain('/gast/');

  // Zweiter Browser-Kontext = niemand. Kein Token, keine Sitzung, nichts.
  const gastSeite = await (await context.browser()!.newContext()).newPage();
  await gastSeite.goto(url!.trim());
  await expect(gastSeite.getByTestId('gast-name')).toBeVisible({ timeout: 10_000 });
  await expect(gastSeite.getByTestId('gast-beitreten')).toBeDisabled();
  await gastSeite.getByTestId('gast-name').fill('Frau Meier');
  await expect(gastSeite.getByTestId('gast-beitreten')).toBeEnabled();
  await gastSeite.close();
});

test('ein unbekannter Code zeigt eine Sackgasse, keine leere Seite', async ({ page }) => {
  await page.goto('/gast/gibtesnicht');
  await expect(page.getByTestId('gast-fehler')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('gast-name')).toHaveCount(0);
});
