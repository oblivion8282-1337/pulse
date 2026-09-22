/**
 * Overnight T8 — Freunde-Verwaltung über die UI:
 * Suche + Anfrage, Annehmen, Beidseitige Liste, Filter der Liste,
 * Status-Picker (DND → online, vom Gegenüber gesehen), DM-Button aus dem
 * Profil-Popover, Blockieren/Entblockieren, Entfreunden.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `fr_alice_${ts}`,
  email: `fr_alice_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `fr_bob_${ts}`,
  email: `fr_bob_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const CARL = {
  username: `fr_carl_${ts}`,
  email: `fr_carl_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

/** Anfrage über die UI schicken (Tab „Freund hinzufügen“). */
async function anfrageSenden(page: Page, target: string) {
  await page.goto('/app/friends?tab=add');
  await page.getByTestId('add-friend-input').fill(target);
  await expect(page.getByTestId('search-hit')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('search-hit-add').click();
  await expect(page.getByTestId('search-hit-status')).toContainText('Anfrage offen', {
    timeout: 5000
  });
}

/** Offene Anfrage über die UI annehmen (Tab „Offen“). */
async function anfrageAnnehmen(page: Page, from: string) {
  await page.goto('/app/friends?tab=pending');
  const zeile = page.getByTestId('pending-in-row').filter({ hasText: from });
  await expect(zeile).toBeVisible({ timeout: 10_000 });
  await zeile.getByTestId('pending-accept-btn').click();
  await expect(zeile).toHaveCount(0, { timeout: 10_000 });
}

test.describe.serial('Overnight T8 — Freunde', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let carlCtx: BrowserContext;
  let carlPage: Page;

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    carlCtx = await browser.newContext();
    for (const ctx of [aliceCtx, bobCtx, carlCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
    carlPage = await carlCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
    await carlCtx.close();
  });

  test('Aufbau: drei Nutzer registriert', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    await register(carlPage, CARL);
  });

  test('Alice schickt Bob eine Anfrage — sie erscheint bei Bob offen', async () => {
    await anfrageSenden(alicePage, BOB.username);
    // Bei Alice steht sie unter „Gesendet“.
    await alicePage.goto('/app/friends?tab=pending');
    await expect(
      alicePage.getByTestId('pending-out-row').filter({ hasText: BOB.username })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Bob nimmt an — beide sehen sich unter „Alle Freunde“', async () => {
    await anfrageAnnehmen(bobPage, ALICE.username);

    await bobPage.goto('/app/friends?tab=all');
    await expect(
      bobPage.getByTestId('friend-row').filter({ hasText: ALICE.username })
    ).toBeVisible({ timeout: 10_000 });

    await alicePage.goto('/app/friends?tab=all');
    await expect(
      alicePage.getByTestId('friend-row').filter({ hasText: BOB.username })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Zweite Freundschaft: Alice ↔ Carl', async () => {
    await anfrageSenden(alicePage, CARL.username);
    await anfrageAnnehmen(carlPage, ALICE.username);
    await alicePage.goto('/app/friends?tab=all');
    await expect(alicePage.getByTestId('friend-row')).toHaveCount(2, { timeout: 10_000 });
  });

  test('Freunde-Suche filtert die Liste', async () => {
    const suche = alicePage.getByTestId('friends-input');
    await expect(suche).toBeVisible({ timeout: 10_000 });
    await suche.fill(BOB.username);
    await expect(alicePage.getByTestId('friend-row')).toHaveCount(1, { timeout: 10_000 });
    await expect(
      alicePage.getByTestId('friend-row').filter({ hasText: BOB.username })
    ).toBeVisible();
    // Carl ist rausgefiltert — weitergetippt bleibt nur Bob.
    await suche.fill('niemand-passendes');
    await expect(alicePage.getByTestId('friends-empty')).toBeVisible({ timeout: 10_000 });
    await suche.fill('');
    await expect(alicePage.getByTestId('friend-row')).toHaveCount(2, { timeout: 10_000 });
  });

  test('Status-Picker: Bobs DND erscheint bei Alice, zurück zu online', async () => {
    await bobPage.getByTestId('status-picker-trigger').click();
    await bobPage.getByTestId('status-option-dnd').click();
    await expect(bobPage.getByTestId('status-picker-trigger')).toContainText('Nicht stören', {
      timeout: 5000
    });

    // Alices Ansicht kriegt die Präsenz über den WS — Label in der Freundeszeile.
    await alicePage.goto('/app/friends?tab=all');
    const bobZeile = alicePage.getByTestId('friend-row').filter({ hasText: BOB.username });
    await expect(bobZeile).toContainText('beschäftigt', { timeout: 10_000 });

    // Und wieder zurück.
    await bobPage.getByTestId('status-picker-trigger').click();
    await bobPage.getByTestId('status-option-online').click();
    await expect(bobZeile).toContainText('online', { timeout: 10_000 });
  });

  test('Profil-Popover → DM-Button führt in den DM-Kanal', async () => {
    await alicePage.goto('/app/friends?tab=all');
    const bobZeile = alicePage.getByTestId('friend-row').filter({ hasText: BOB.username });
    // Das Profil-Menü öffnet ausschließlich per Rechtsklick (Linksklick
    // springt bei Voice-Aktivität in die Community — steht so am Button).
    await bobZeile.getByTestId('friend-profile-trigger').click({ button: 'right' });

    const popover = alicePage.getByTestId('user-profile-popover');
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await popover.getByTestId('popover-dm-btn').click();

    await alicePage.waitForURL(/\/app\/@me\/(\d+)/, { timeout: 10_000 });
    await expect(alicePage.getByTestId('active-channel-name')).toHaveText(BOB.username, {
      timeout: 10_000
    });
  });

  test('Blockieren: Carl landet auf der Blockierliste, Entblockieren räumt ab', async () => {
    await alicePage.goto('/app/friends?tab=all');
    const carlZeile = alicePage.getByTestId('friend-row').filter({ hasText: CARL.username });
    // Rechtsklick — siehe DM-Test oben.
    await carlZeile.getByTestId('friend-profile-trigger').click({ button: 'right' });
    const popover = alicePage.getByTestId('user-profile-popover');
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await popover.getByTestId('popover-block-btn').click();
    // Blockieren fragt erst per Bestätigungsdialog nach.
    await alicePage.getByTestId('confirm-dialog-confirm').click();

    await alicePage.goto('/app/friends?tab=blocked');
    const blockZeile = alicePage.getByTestId('blocked-row').filter({ hasText: CARL.username });
    await expect(blockZeile).toBeVisible({ timeout: 10_000 });

    await blockZeile.getByTestId('blocked-unblock-btn').click();
    await expect(alicePage.getByTestId('blocked-empty')).toBeVisible({ timeout: 10_000 });
  });

  test('Entfreunden: Zeile weg — bei beiden Seiten', async () => {
    await alicePage.goto('/app/friends?tab=all');
    const bobZeile = alicePage.getByTestId('friend-row').filter({ hasText: BOB.username });
    await expect(bobZeile).toBeVisible({ timeout: 10_000 });
    await bobZeile.getByTestId('friend-remove-btn').click();
    await alicePage.getByTestId('confirm-dialog-confirm').click();
    await expect(
      alicePage.getByTestId('friend-row').filter({ hasText: BOB.username })
    ).toHaveCount(0, { timeout: 10_000 });

    await bobPage.goto('/app/friends?tab=all');
    await expect(
      bobPage.getByTestId('friend-row').filter({ hasText: ALICE.username })
    ).toHaveCount(0, { timeout: 10_000 });
  });
});
