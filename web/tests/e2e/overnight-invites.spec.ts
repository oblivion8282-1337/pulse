/**
 * Overnight T9 — Einladungen:
 * Link über den Einladen-Dialog erzeugen, Beitritt über den Link,
 * Einzelnutzung (max_uses=1), Widerruf, Ablaufdatum, Gast-Link + Vorraum,
 * unbekannter Code. Alles UI-getrieben; wo der Kalender fehlt (abgelaufene
 * Einladung ohne 30 Minuten zu warten), legt die Suite die Einladung per
 * API mit `expires_in_seconds: 1` an — der Prüfling bleibt der Beitritt.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `inv_alice_${ts}`,
  email: `inv_alice_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `inv_bob_${ts}`,
  email: `inv_bob_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const CARA = {
  username: `inv_cara_${ts}`,
  email: `inv_cara_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const DAN = {
  username: `inv_dan_${ts}`,
  email: `inv_dan_${ts}@dcc-test.example.com`,
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

/** Plus-Menü → „Beitreten“ → Code/Link eintragen. Liefert true, wenn der
 *  Beitritt durchging (URL landet im Kanal). Ein offen gebliebener Dialog
 *  (nach Fehlversuchen) wird zuerst geschlossen — sonst schluckt sein
 *  Overlay den nächsten Klick. */
async function beitreten(page: Page, codeOderLink: string): Promise<boolean> {
  if (await page.getByTestId('create-guild-dialog').count()) {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('create-guild-dialog')).toBeHidden({ timeout: 5_000 });
  }
  await expect(async () => {
    await page.locator('[data-testid^="guild-create-menu-"]').first().click();
    await expect(page.getByTestId('guild-join')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('guild-join').click();
  await expect(page.getByTestId('create-guild-dialog')).toBeVisible();
  await page.getByTestId('join-guild-input').fill(codeOderLink);
  await page.getByTestId('join-guild-submit').click();
  try {
    await page.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Community-Einstellungen öffnen und auf den Einladungen-Tab, frisch vom
 *  Server geladen (die Liste lebt nur im Dialog-Zustand). */
async function invitesTabOeffnen(page: Page, gid: string) {
  await page.getByTestId('guild-settings-dialog')
    .press('Escape')
    .catch(() => undefined);
  await expect(page.getByTestId('guild-settings-dialog')).toBeHidden({ timeout: 5_000 });
  await page.getByTestId(`guild-${gid}`).click({ button: 'right' });
  await page.getByTestId('guild-settings').click();
  await expect(page.getByTestId('guild-settings-dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('settings-tab-invites').click();
  await expect(page.getByTestId('guild-invites-editor')).toBeVisible({ timeout: 10_000 });
}

test.describe.serial('Overnight T9 — Einladungen', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let caraCtx: BrowserContext;
  let caraPage: Page;
  let danCtx: BrowserContext;
  let danPage: Page;
  let gastCtx: BrowserContext;
  let guildId = '';
  let sprachkanal = '';
  let einladung = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    caraCtx = await browser.newContext();
    danCtx = await browser.newContext();
    gastCtx = await browser.newContext();
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
    caraPage = await caraCtx.newPage();
    danPage = await danCtx.newPage();
  });

  test.afterAll(async () => {
    for (const ctx of [aliceCtx, bobCtx, caraCtx, danCtx, gastCtx]) await ctx.close();
  });

  test('Aufbau: vier Nutzer, Alice legt die Community an', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    await register(caraPage, CARA);
    await register(danPage, DAN);

    await alicePage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await alicePage.getByTestId('guild-create').click();
    await alicePage.getByTestId('create-guild-name').fill('Invite Guild');
    await alicePage.getByTestId('create-guild-submit').click();
    await alicePage.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    guildId = new URL(alicePage.url()).pathname.split('/')[3];
    expect(guildId).toMatch(/^\d+$/);
  });

  test('Link über den Einladen-Dialog erzeugen', async () => {
    await alicePage.getByTestId('invite-open-btn').click();
    const dialog = alicePage.getByTestId('invite-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await alicePage.getByTestId('invite-share-create').click();
    const link = alicePage.getByTestId('invite-share-link');
    await expect(link).toBeVisible({ timeout: 10_000 });
    const text = (await link.textContent())!.trim();
    expect(text).toContain('/invite/');
    await alicePage.keyboard.press('Escape');
  });

  test('Bob tritt über den Link bei — Community erscheint in der Leiste', async () => {
    // Link frisch aus dem Dialog holen (er ist single-use-frei, aber der
    // erste war es womöglich nicht — hier bewusst ein zweiter).
    await alicePage.getByTestId('invite-open-btn').click();
    await expect(alicePage.getByTestId('invite-dialog')).toBeVisible({ timeout: 10_000 });
    await alicePage.getByTestId('invite-share-create').click();
    const link = (await alicePage.getByTestId('invite-share-link').textContent())!.trim();
    await alicePage.keyboard.press('Escape');

    expect(await beitreten(bobPage, link)).toBe(true);
    await expect(bobPage.getByTestId(`guild-${guildId}`)).toBeVisible({ timeout: 10_000 });
    await expect(bobPage.getByTestId('active-channel-name')).toBeVisible({ timeout: 10_000 });
  });

  test('Einladung mit max_uses=1 über die Einstellungen anlegen', async () => {
    await invitesTabOeffnen(alicePage, guildId);

    // Auswahl = Klick auf den Trigger, dann auf den Eintrag (hausgemachter
    // Select-Wrapper, kein natives <select>).
    await alicePage.getByTestId('invite-uses').click();
    await alicePage.getByRole('option', { name: '1', exact: true }).click();
    await alicePage.getByTestId('invite-create').click();
    // create() stellt die neue Zeile vorn.
    const zeile = alicePage.getByTestId('invite-row').first();
    await expect(zeile).toBeVisible({ timeout: 10_000 });
    await expect(zeile).toContainText('0 / 1');
    einladung = (await zeile.locator('code').textContent())!.trim();
  });

  test('Cara löst die Einzel-Einladung ein — Zähler steht auf 1/1', async () => {
    expect(await beitreten(caraPage, einladung)).toBe(true);
    // Der Zähler lebt im Dialog-Zustand — Tab neu öffnen lädt vom Server.
    await invitesTabOeffnen(alicePage, guildId);
    const zeile = alicePage.getByTestId('invite-row').filter({ hasText: einladung }).first();
    await expect(zeile).toContainText('1 / 1', { timeout: 10_000 });
  });

  test('erschöpfte Einladung: zweiter Beitritt schlägt fehl', async () => {
    expect(await beitreten(danPage, einladung)).toBe(false);
    await expect(danPage.getByTestId('join-guild-error')).toBeVisible({ timeout: 10_000 });
  });

  test('Widerruf: gelöschter Code wird abgewiesen', async () => {
    // create() stellt die neue Zeile vorn — die hat unbegrenzte Nutzung.
    await alicePage.getByTestId('invite-create').click();
    const zeile = alicePage.getByTestId('invite-row').first();
    await expect(zeile).toContainText('0 / ∞', { timeout: 10_000 });
    const code = (await zeile.locator('code').textContent())!.trim();

    await zeile.getByTestId('invite-revoke').click();
    await expect(zeile).toHaveCount(0, { timeout: 10_000 });

    expect(await beitreten(danPage, code)).toBe(false);
    await expect(danPage.getByTestId('join-guild-error')).toBeVisible({ timeout: 10_000 });
  });

  test('Ablauf: erledigte Einladung wird abgewiesen', async () => {
    // Über die UI: 30-Minuten-Ablauf wählen, anlegen, Ablaufdatum erscheint
    // (create() stellt die neue Zeile vorn).
    await alicePage.getByTestId('invite-expiry').click();
    await alicePage.getByRole('option', { name: '30 Minuten' }).click();
    await alicePage.getByTestId('invite-create').click();
    const zeile = alicePage.getByTestId('invite-row').first();
    await expect(zeile).toContainText('0 / ∞', { timeout: 10_000 });
    await expect(zeile).not.toContainText('Nie');

    // Für den echten Ablaufzeitpunkt: 1 Sekunde via API (ohne 30 Minuten zu
    // warten), dann schlägt Dans Beitritt fehl.
    const kurzerCode = await alicePage.evaluate(async (gid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/guilds/${gid}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ expires_in_seconds: 1 })
      });
      return (await r.json()).code as string;
    }, guildId);
    await alicePage.waitForTimeout(2000);

    expect(await beitreten(danPage, kurzerCode)).toBe(false);
    await expect(danPage.getByTestId('join-guild-error')).toBeVisible({ timeout: 10_000 });
  });

  test('Gast-Link erzeugen — URL erscheint', async () => {
    // Gast-Link gilt pro Sprachkanal — erst einen anlegen (Muster aus
    // gast-link.spec.ts).
    await alicePage.getByTestId('guild-settings-dialog').press('Escape');
    await alicePage.getByTestId('channel-create').click();
    await alicePage.getByTestId('create-channel-type-voice').click();
    await alicePage.getByTestId('create-channel-name').fill('gast-lounge');
    await alicePage.getByTestId('create-channel-submit').click();
    sprachkanal = alicePage.getByRole('button', { name: 'gast-lounge' });
    await expect(sprachkanal).toBeVisible({ timeout: 10_000 });

    await sprachkanal.click({ button: 'right' });
    await alicePage.locator(`[data-testid^="channel-guest-links-"]`).first().click();
    await alicePage.getByTestId('gast-link-erzeugen').click();
    const url = await alicePage.getByTestId('gast-link-url').textContent();
    expect(url).toContain('/gast/');
  });

  test('Gast-Vorraum: ohne Konto Name eingeben, Beitreten freigeschaltet', async () => {
    const url = (await alicePage.getByTestId('gast-link-url').textContent())!.trim();
    const gastSeite = await gastCtx.newPage();
    await gastSeite.goto(url);
    await expect(gastSeite.getByTestId('gast-name')).toBeVisible({ timeout: 15_000 });
    await expect(gastSeite.getByTestId('gast-beitreten')).toBeDisabled();
    await gastSeite.getByTestId('gast-name').fill('Frau Meier');
    await expect(gastSeite.getByTestId('gast-beitreten')).toBeEnabled();
    // Absichtlich KEIN Klick auf „Beitreten“: dahinter liegt LiveKit, und das
    // läuft im E2E-Aufbau nicht (Begründung wie in gast-link.spec.ts).
    await gastSeite.close();
  });

  test('Unbekannter Code zeigt die Fehlermeldung', async () => {
    expect(await beitreten(danPage, 'INVALID0')).toBe(false);
    await expect(danPage.getByTestId('join-guild-error')).toBeVisible({ timeout: 10_000 });
  });
});
