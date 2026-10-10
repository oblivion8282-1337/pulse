/**
 * Die Einladungsseite (Spec 2026-10-10). Anders als invite-link-join.spec.ts,
 * das den Link nur ins Beitrittsfeld kopiert, RUFT dieser Test den Link auf —
 * genau die Lücke, durch die die fehlende Route vier Monate unbemerkt blieb.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_BASE_URL } from './_ports';

/** Die Content-Security-Policy, die Prod ausliefert (Repo-Fassung der nginx-Vorlage).
 *  Der Vite-Dev-Server schickt sie an SvelteKit-Seiten NICHT mit — ohne diese Quelle
 *  bliebe die Prüfung unten blind für eine fehlende Freigabe. */
function prodCsp(): string {
  const inc = readFileSync(new URL('../../../infra/prod/security-headers.inc', import.meta.url), 'utf8');
  const treffer = inc.match(/add_header Content-Security-Policy "([^"]+)"/);
  if (!treffer) throw new Error('CSP in security-headers.inc nicht gefunden');
  return treffer[1];
}

const ts = Date.now();
const ALICE = {
  username: `ein_alice_${ts}`,
  email: `ein_alice_${ts}@dcc-test.example.com`,
  password: 'ein-secret-pass'
};
const BOB = {
  username: `ein_bob_${ts}`,
  email: `ein_bob_${ts}@dcc-test.example.com`,
  password: 'ein-secret-pass'
};
const CAROL = {
  username: `ein_carol_${ts}`,
  email: `ein_carol_${ts}@dcc-test.example.com`,
  password: 'ein-secret-pass'
};
const RUNDE = 'Einladungsrunde';
const ZWEITE = 'Zweite Runde';

async function registrieren(page: Page, u: typeof ALICE) {
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

async function communityAnlegen(page: Page, name: string): Promise<string> {
  // Die zweite Community entsteht, während die erste noch in der Adresse steht:
  // ein bloßes waitForURL(Muster) liefe sofort durch und gäbe die alte zurück.
  const vorher = page.url();
  await page.locator('[data-testid^="guild-create-menu-"]').first().click();
  await page.getByTestId('guild-create').click();
  await page.getByTestId('create-guild-name').fill(name);
  await page.getByTestId('create-guild-submit').click();
  await page.waitForURL((u) => /\/app\/guilds\/\d+\/channels\/\d+/.test(u.href) && u.href !== vorher);
  return page.url();
}

async function linkErzeugen(page: Page): Promise<string> {
  await page.getByTestId('invite-open-btn').click();
  await page.getByTestId('invite-share-create').click();
  const el = page.getByTestId('invite-share-link');
  await expect(el).toBeVisible({ timeout: 10_000 });
  const link = (await el.textContent())!.trim();
  await page.keyboard.press('Escape');
  return link;
}

const karte = (page: Page, zustand: string) =>
  page.locator(`[data-testid=einladung-karte][data-zustand=${zustand}]`);

test.describe.serial('Einladungsseite', () => {
  let aliceCtx: BrowserContext;
  let alice: Page;
  let bobCtx: BrowserContext;
  let bob: Page;
  let rundeUrl = '';
  let zweiteUrl = '';
  let link1 = '';
  let link2 = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext({
      // Ein Service Worker kann die Navigation bedienen, und Playwright-Routen sehen sie dann
      // nicht — der App-Knopf-Test setzt die Prod-CSP über eine Route.
      serviceWorkers: 'block'
    });
    alice = await aliceCtx.newPage();
    bob = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('Alice legt zwei Communitys an und erzeugt je einen Link', async () => {
    await alice.goto('/register');
    await registrieren(alice, ALICE);
    rundeUrl = await communityAnlegen(alice, RUNDE);
    link1 = await linkErzeugen(alice);
    zweiteUrl = await communityAnlegen(alice, ZWEITE);
    link2 = await linkErzeugen(alice);
    expect(link1).toContain('/invite/');
  });

  test('Abgemeldet: der Link zeigt die Einladung, keine Fehlerseite', async () => {
    await bob.goto(link1);
    await expect(karte(bob, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByTestId('einladung-name')).toHaveText(RUNDE);
    await expect(bob.getByTestId('route-error')).toHaveCount(0);
  });

  test('Konto erstellen führt nach der Registrierung zur Einladung zurück', async () => {
    await bob.getByTestId('einladung-registrieren').click();
    await bob.waitForURL(/\/register/);
    await registrieren(bob, BOB);
    const dialog = bob.getByTestId('einladung-dialog');
    await expect(karte(bob, 'einladung')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId('einladung-name')).toHaveText(RUNDE);
    await dialog.getByTestId('einladung-beitreten').click();
    const guildId = rundeUrl.match(/\/app\/guilds\/(\d+)/)![1];
    await bob.waitForURL(new RegExp(`/app/guilds/${guildId}/channels/`), { timeout: 15_000 });
    await expect(bob.getByTestId('einladung-dialog')).toHaveCount(0);
  });

  test('Schon Mitglied: Community öffnen', async () => {
    await bob.goto(link1);
    await expect(karte(bob, 'mitglied')).toBeVisible({ timeout: 15_000 });
    await bob.getByTestId('einladung-oeffnen').click();
    await bob.waitForURL(/\/app\/guilds\/\d+\/channels\//);
  });

  test('Desktop-App-Knopf: die Seite bleibt stehen, der Hinweis erscheint', async () => {
    const csp = prodCsp();
    await bob.route(/\/invite\/[^/]+$/, async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const antwort = await route.fetch();
      await route.fulfill({
        response: antwort,
        headers: { ...antwort.headers(), 'content-security-policy': csp }
      });
    });
    await bob.goto(link1);
    await expect(karte(bob, 'mitglied')).toBeVisible({ timeout: 15_000 });
    // Die CSP muss das versteckte iframe mit `pulse:` zulassen — sonst scheitert der
    // Knopf in jedem Browser still (frame-src). Verletzungen vor dem Klick mitschreiben.
    await bob.evaluate(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(e.violatedDirective));
    });
    await bob.getByTestId('einladung-app').click();
    await expect(bob.getByText('Pulse wird geöffnet', { exact: false })).toBeVisible();
    await expect(bob).toHaveURL(/\/invite\//);
    await expect(bob.locator('iframe[src^="pulse://invite?code="]')).toHaveCount(1);
    // Verletzungen werden asynchron gemeldet — kurz warten, dann lesen.
    await bob.waitForTimeout(500);
    expect(await bob.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    await bob.unroute(/\/invite\/[^/]+$/);
  });

  test('Unbekannter Code: gilt nicht mehr', async () => {
    await bob.goto(`${E2E_BASE_URL}/invite/ZZZZ9999`);
    await expect(karte(bob, 'ungueltig')).toBeVisible({ timeout: 15_000 });
  });

  test('Abgemeldet: ein unbekannter Code gilt nicht mehr', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const p = await ctx.newPage();
      await p.goto(`${E2E_BASE_URL}/invite/ZZZZ9999`);
      await expect(karte(p, 'ungueltig')).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });

  test('Klick auf einen Einladungslink im Chat öffnet den Dialog, keinen neuen Tab', async () => {
    await alice.goto(rundeUrl);
    await alice.getByTestId('message-input').click();
    await alice.getByTestId('message-input').fill(`Schau mal: ${link2}`);
    await alice.getByTestId('message-input').press('Enter');

    await bob.goto(rundeUrl);
    const anker = bob.locator(`[data-testid=message-content] a[href="${link2}"]`);
    await expect(anker).toBeVisible({ timeout: 15_000 });
    await anker.click();
    await expect(bob).toHaveURL(/einladung=/);
    await expect(bob.getByTestId('einladung-dialog').getByTestId('einladung-name')).toHaveText(ZWEITE, {
      timeout: 15_000
    });
    expect(bobCtx.pages()).toHaveLength(1);
  });

  test('Angemeldet: Beitreten direkt auf der Seite', async () => {
    await bob.goto(link2);
    await expect(karte(bob, 'einladung')).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByTestId('einladung-name')).toHaveText(ZWEITE);
    await bob.getByTestId('einladung-beitreten').click();
    const guildId = zweiteUrl.match(/\/app\/guilds\/(\d+)/)![1];
    await bob.waitForURL(new RegExp(`/app/guilds/${guildId}/channels/`), { timeout: 15_000 });
  });

  test('Abgemeldet: Anmelden mit bestehendem Konto führt zur Einladung zurück', async ({
    browser
  }) => {
    const carolCtx = await browser.newContext();
    try {
      const reg = await carolCtx.newPage();
      await reg.goto('/register');
      await registrieren(reg, CAROL);
      await reg.close();
    } finally {
      await carolCtx.close();
    }
    const ctx = await browser.newContext();
    try {
      const p = await ctx.newPage();
      await p.goto(link1);
      await expect(karte(p, 'abgemeldet')).toBeVisible({ timeout: 15_000 });
      await p.getByTestId('einladung-anmelden').click();
      await p.waitForURL(/\/login/);
      await p.getByTestId('login-identifier').fill(CAROL.username);
      await p.getByTestId('login-password').fill(CAROL.password);
      await p.getByTestId('login-submit').click();
      const dialog = p.getByTestId('einladung-dialog');
      await expect(karte(p, 'einladung')).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByTestId('einladung-name')).toHaveText(RUNDE);
      await dialog.getByTestId('einladung-beitreten').click();
      const guildId = rundeUrl.match(/\/app\/guilds\/(\d+)/)![1];
      await p.waitForURL(new RegExp(`/app/guilds/${guildId}/channels/`), { timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });

  test('Ein Discord-Link im Chat bleibt ein normaler Link', async () => {
    const text = 'Discord: https://discord.com/invite/python';
    await alice.goto(rundeUrl);
    await alice.getByTestId('message-input').click();
    await alice.getByTestId('message-input').fill(text);
    await alice.getByTestId('message-input').press('Enter');

    await bob.goto(rundeUrl);
    const zeile = bob.locator('[data-testid=message-item]', { hasText: 'Discord:' });
    await expect(zeile).toBeVisible({ timeout: 15_000 });
    await expect(zeile.locator('a[href="https://discord.com/invite/python"]')).toBeVisible();
    await expect(zeile.locator('[data-testid=invite-embed]')).toHaveCount(0);
  });
});
