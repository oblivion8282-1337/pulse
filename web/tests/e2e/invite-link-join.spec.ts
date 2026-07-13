/**
 * End-zu-End-Beweis des Link-Beitrittswegs über das Universal-Beitrittsfeld:
 *
 * 1. User A registriert sich, legt eine Community an.
 * 2. A erzeugt im Leute-einladen-Dialog ("Oder Link teilen") einen
 *    Einladungslink — gelesen aus dem UI-Element (headless-stabil, keine
 *    Clipboard-API).
 * 3. User B (eigener Kontext) fügt den VOLLEN Link ins Beitreten-Feld ein
 *    und landet in der Community.
 * 4. Negativ: ein erfundener Code zeigt die Fehlermeldung.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `ilj_alice_${ts}`,
  email: `ilj_alice_${ts}@dcc-test.example.com`,
  password: 'ilj-secret-pass'
};
const BOB = {
  username: `ilj_bob_${ts}`,
  email: `ilj_bob_${ts}@dcc-test.example.com`,
  password: 'ilj-secret-pass'
};

const GUILD_NAME = 'Link Join Guild';

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

test.describe.serial('Invite-Link Join E2E', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let inviteLink = '';
  let guildId = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('Alice registriert sich und legt eine Community an', async () => {
    await register(alicePage, ALICE);
    // Über das Plus-Menü der Server-Leiste (der Empty-State erscheint je nach
    // Viewport/Route nicht zuverlässig — das Rail-Menü ist immer da).
    await alicePage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await alicePage.getByTestId('guild-create').click();
    await alicePage.getByTestId('create-guild-name').fill(GUILD_NAME);
    await alicePage.getByTestId('create-guild-submit').click();
    await alicePage.waitForURL(/\/app\/guilds\/(\d+)\/channels\/\d+/);
    guildId = alicePage.url().match(/\/app\/guilds\/(\d+)/)![1];
  });

  test('Alice erzeugt den Einladungslink über "Oder Link teilen"', async () => {
    await alicePage.getByTestId('invite-open-btn').click();
    await expect(alicePage.getByTestId('invite-dialog')).toBeVisible();
    // Der Abschnitt existiert nur mit CREATE_INVITES — die Ownerin hat es.
    await expect(alicePage.getByTestId('invite-link-share')).toBeVisible();
    await alicePage.getByTestId('invite-share-create').click();
    // Link aus dem UI lesen (NICHT Clipboard — headless-stabil). Ein
    // Clipboard-Fehler toastet nur; der Link wird trotzdem angezeigt.
    const linkEl = alicePage.getByTestId('invite-share-link');
    await expect(linkEl).toBeVisible({ timeout: 10_000 });
    inviteLink = (await linkEl.textContent())!.trim();
    expect(inviteLink).toMatch(/^http:\/\/127\.0\.0\.1:5173\/invite\/[A-Za-z0-9]{6,}$/);
    await alicePage.keyboard.press('Escape');
  });

  test('Bob: erfundener Code zeigt die Fehlermeldung', async () => {
    await register(bobPage, BOB);
    await bobPage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await bobPage.getByTestId('guild-join').click();
    await expect(bobPage.getByTestId('create-guild-dialog')).toBeVisible();
    await bobPage.getByTestId('join-guild-input').fill('INVALID0');
    await bobPage.getByTestId('join-guild-submit').click();
    await expect(bobPage.getByTestId('join-guild-error')).toBeVisible({ timeout: 10_000 });
  });

  test('Bob tritt über den vollen Link bei und landet in der Community', async () => {
    await bobPage.getByTestId('join-guild-input').fill(inviteLink);
    await bobPage.getByTestId('join-guild-submit').click();
    await bobPage.waitForURL(new RegExp(`/app/guilds/${guildId}/channels/\\d+`), {
      timeout: 15_000
    });
    await expect(bobPage.getByTestId('active-channel-name')).toBeVisible({ timeout: 10_000 });
    // Die Community selbst ist sichtbar (Name in Sidebar/Rail).
    await expect(bobPage.getByText(GUILD_NAME).first()).toBeVisible();
  });
});
