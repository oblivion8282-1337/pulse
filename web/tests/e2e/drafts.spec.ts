/**
 * Nachrichten-Entwürfe pro Channel (drafts.svelte.ts + MessageInput-Effects):
 * tippen → Channel wechseln → zurückkommen → Text steht noch; und der Entwurf
 * überlebt auch einen Reload (localStorage + pagehide-Flush). Gilt genauso
 * für DMs (gleicher Composer, DM-Channel-ID als Schlüssel) — der Test fährt
 * den Guild-Pfad, weil er ohne zweiten User auskommt.
 */

import { test, expect } from '@playwright/test';

const ts = Date.now();
const USER = {
  username: `draft_${ts}`,
  email: `draft_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

test('Entwurf überlebt Channel-Wechsel und Reload', async ({ page }) => {
  // Registrieren (chat.spec-Muster).
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

  // Guild anlegen → App navigiert in den auto-erstellten #general.
  // Rail-Plus-Menü statt Empty-State: /app landet seit 65a050f7 auf
  // /app/friends, das Empty-State-Panel existiert dort nicht.
  await page.locator('[data-testid^="guild-create-menu-"]').first().click();
  await page.getByTestId('guild-create').click();
  await page.getByTestId('create-guild-name').fill('Drafts Guild');
  await page.getByTestId('create-guild-submit').click();
  await expect(page.getByTestId('active-channel-name')).toHaveText('general', {
    timeout: 10_000
  });

  // Entwurf in #general tippen (NICHT senden).
  const input = page.getByTestId('message-input');
  await input.fill('halb fertiger Gedanke in general');

  // Zweiten Text-Channel anlegen → App navigiert hinein.
  await page.getByTestId('channel-create').click();
  await page.getByTestId('create-channel-type-text').click();
  await page.getByTestId('create-channel-name').fill('zweiter');
  await page.getByTestId('create-channel-submit').click();
  await expect(page.getByTestId('active-channel-name')).toHaveText('zweiter', {
    timeout: 10_000
  });

  // Frischer Channel → leerer Composer; eigenen Entwurf tippen.
  await expect(input).toHaveValue('');
  await input.fill('und hier ein anderer Entwurf');

  // Zurück nach #general: der erste Entwurf steht wieder da. Regex-Testid
  // (channel-<nur Ziffern>) — ein Prefix-Match fängt sonst auch channel-list/
  // channel-lock-* und klickt ins Leere.
  await page
    .getByTestId(/^channel-\d+$/)
    .filter({ hasText: 'general' })
    .first()
    .click();
  await expect(page.getByTestId('active-channel-name')).toHaveText('general');
  await expect(input).toHaveValue('halb fertiger Gedanke in general');

  // Und wieder vor: der zweite Entwurf ebenso.
  await page
    .getByTestId(/^channel-\d+$/)
    .filter({ hasText: 'zweiter' })
    .first()
    .click();
  await expect(input).toHaveValue('und hier ein anderer Entwurf');

  // Reload: Entwurf kommt aus localStorage zurück (pagehide-Flush).
  await page.reload();
  await page.waitForURL(/\/app/);
  await expect(page.getByTestId('message-input')).toHaveValue(
    'und hier ein anderer Entwurf',
    { timeout: 10_000 }
  );
});
