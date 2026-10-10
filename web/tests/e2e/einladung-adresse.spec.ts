/**
 * Die öffentliche Community-Adresse /c/<handle> auf der Einladungskarte
 * (Spec 2026-10-10, Etappe 4): Abgemeldet → Anmelden → Dialog in der App →
 * Beitreten, und der Fall „gibt es nicht“. Der Pfad hatte bis dahin keinen
 * Test, der den Link wirklich aufruft.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { E2E_BASE_URL } from './_ports';

const ts = Date.now();
const HANDLE = `adr-${ts}`;
const NAME = `Adressrunde ${ts}`;
const ALICE = {
  username: `adr_alice_${ts}`,
  email: `adr_alice_${ts}@dcc-test.example.com`,
  password: 'adr-secret-pass'
};
const BOB = {
  username: `adr_bob_${ts}`,
  email: `adr_bob_${ts}@dcc-test.example.com`,
  password: 'adr-secret-pass'
};

async function registrieren(page: Page, u: typeof ALICE) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

const karte = (page: Page, zustand: string) =>
  page.locator(`[data-testid=einladung-karte][data-zustand=${zustand}]`);

test.describe.serial('Öffentliche Adresse /c/<handle>', () => {
  let aliceCtx: BrowserContext;
  let alice: Page;
  let bobCtx: BrowserContext;
  let bob: Page;
  let guildId = '';
  let kanalPfad = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    alice = await aliceCtx.newPage();
    bob = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('Alice legt eine Community mit öffentlicher Adresse an, Bob hat ein Konto', async () => {
    await registrieren(alice, ALICE);
    await alice.locator('[data-testid^="guild-create-menu-"]').first().click();
    await alice.getByTestId('guild-create').click();
    await alice.getByTestId('create-guild-name').fill(NAME);
    await alice.getByTestId('create-guild-submit').click();
    await alice.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    guildId = alice.url().match(/\/app\/guilds\/(\d+)/)![1];
    kanalPfad = new URL(alice.url()).pathname;

    for (let versuch = 0; versuch < 4; versuch++) {
      await alice.getByTestId(`guild-${guildId}`).click({ button: 'right' });
      try {
        await alice.getByTestId('guild-settings').click({ timeout: 2_500 });
        break;
      } catch {
        // Menü wurde abgebaut — neu öffnen.
      }
    }
    await expect(alice.getByTestId('guild-settings-dialog')).toBeVisible();
    await alice.getByTestId('settings-tab-publicaddress').click();
    await alice.getByTestId('guild-handle-input').fill(HANDLE);
    await alice.getByTestId('guild-public-toggle').click();
    await alice.getByTestId('guild-public-address-save').click();
    await expect(alice.getByTestId('guild-public-url')).toContainText(`/c/${HANDLE}`, {
      timeout: 10_000
    });

    await registrieren(bob, BOB);
    await bob.evaluate(() => localStorage.clear());
    await bobCtx.clearCookies();
  });

  test('Abgemeldet: die Adresse zeigt die Karte mit dem Community-Namen, Anmelden führt zurück', async () => {
    await bob.goto(`${E2E_BASE_URL}/c/${HANDLE}`);
    await expect(karte(bob, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByTestId('einladung-name')).toHaveText(NAME);
    await bob.getByTestId('einladung-anmelden').click();
    await bob.waitForURL(/\/login/);
    await bob.getByTestId('login-identifier').fill(BOB.username);
    await bob.getByTestId('login-password').fill(BOB.password);
    await bob.getByTestId('login-submit').click();
    await bob.waitForURL(/\/app/, { timeout: 20_000 });
    const dialog = bob.getByTestId('einladung-dialog');
    await expect(karte(bob, 'einladung')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId('einladung-name')).toHaveText(NAME);
    await dialog.getByTestId('einladung-beitreten').click();
    await bob.waitForURL(new RegExp(`/app/guilds/${guildId}/channels/`), { timeout: 20_000 });
    await expect(bob.getByTestId('einladung-dialog')).toHaveCount(0);
  });

  test('Abgemeldet: ein unbekannter Handle zeigt „gibt es nicht“', async () => {
    const ctx = await bobCtx.browser()!.newContext();
    const page = await ctx.newPage();
    await page.goto(`${E2E_BASE_URL}/c/gibtesnicht98`);
    await expect(karte(page, 'ungueltig')).toBeVisible({ timeout: 15_000 });
    await ctx.close();
  });

  test('Angemeldet: ein unbekannter Handle zeigt „gibt es nicht“, keinen Netzfehler', async () => {
    await bob.goto(`${E2E_BASE_URL}/c/gibtesnicht99`);
    await expect(karte(bob, 'ungueltig')).toBeVisible({ timeout: 15_000 });
    await expect(karte(bob, 'fehler')).toHaveCount(0);
  });

  test('Klick auf den /c/-Link im Chat öffnet den Dialog, keinen neuen Tab', async () => {
    // Bob ist seit dem Beitreten Mitglied (kein zweites Konto/zweiter Kanal
    // nötig, um den Link zu sehen); der Dialog zeigt dann „schon Mitglied“.
    const link = `${E2E_BASE_URL}/c/${HANDLE}`;
    await alice.goto(kanalPfad);
    await alice.getByTestId('message-input').click();
    await alice.getByTestId('message-input').fill(`Komm vorbei: ${link}`);
    await alice.getByTestId('message-input').press('Enter');

    await bob.goto(kanalPfad);
    const anker = bob.locator(`[data-testid=message-content] a[href="${link}"]`);
    await expect(anker).toBeVisible({ timeout: 15_000 });
    await anker.click();
    await expect(bob).toHaveURL(/einladung_adresse=/);
    await expect(bob.getByTestId('einladung-dialog').getByTestId('einladung-name')).toHaveText(NAME, {
      timeout: 15_000
    });
    expect(bobCtx.pages()).toHaveLength(1);
  });
});
