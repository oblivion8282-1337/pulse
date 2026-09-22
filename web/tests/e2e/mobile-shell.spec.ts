/**
 * Die Layout-Regel des chat-first-Umbaus, an echten GERAETEKLASSEN geprueft:
 * wer navigiert in welcher Klasse, und verschwindet die Bereichs-Leiste auf
 * einem Detail-Bildschirm?
 *
 * **Warum als E2E und nicht als Unit-Test:** die Rechnung dahinter
 * (`tabs.ts`) hat eigene Unit-Tests. Was die hier nicht abdecken koennen, ist
 * das Zusammenspiel mit `viewport` und den Tailwind-Breakpoints — genau die
 * Stelle, an der eine falsche Klasse dazu fuehrt, dass zwei Navigationen
 * gleichzeitig dastehen oder gar keine. Das sieht man nur im echten Fenster.
 *
 * **Geraeteklassen-Vertrag (2026-09-04):** die Klasse haengt am ZEIGER
 * (`geraetKlasse.ts`), nicht an der Breite. Jede Klasse bekommt hier ihren
 * eigenen BrowserContext mit Finger-Emulation (bzw. ohne, beim Rechner) —
 * eine Seite per `setViewportSize` umzuklassifizieren ist seitdem kein
 * Testweg mehr.
 */
import { test, expect, type Page, type Browser, type BrowserContext } from '@playwright/test';

const PW = 'Passwort123!';
const HANDY = { width: 390, height: 844 };
const TABLET = { width: 834, height: 1112 };
const RECHNER = { width: 1440, height: 900 };

async function register(page: Page, u: { username: string; email: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(PW);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function login(page: Page, u: { username: string; email: string }) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(PW);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

function handyKontext(browser: Browser, groesse = HANDY): Promise<BrowserContext> {
  return browser.newContext({
    viewport: groesse,
    locale: 'de-DE',
    isMobile: true,
    hasTouch: true
  });
}

const NUTZER = {
  username: `shell_${Date.now().toString(36)}`,
  email: `shell_${Date.now().toString(36)}@dcc-test.example.com`
};

test.describe('Mobile-Shell: die Layout-Regel', () => {
  let handyCtx: BrowserContext;
  let tabletCtx: BrowserContext;
  let rechnerCtx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    handyCtx = await handyKontext(browser);
    page = await handyCtx.newPage();
    await register(page, NUTZER);
  });

  test.afterAll(async () => {
    await handyCtx?.close();
    await tabletCtx?.close();
    await rechnerCtx?.close();
  });

  test('Handy: Bereichs-Leiste unten, keine Server-Leiste', async () => {
    await page.goto('/app/@me');
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    await expect(page.getByTestId('tablet-nav-rail')).toBeHidden();
    // Die GuildRail ist per `hidden lg:flex` weg — sie existiert im Markup,
    // darf aber nicht sichtbar sein.
    await expect(page.getByTestId('guild-rail')).toBeHidden();
  });

  test('Handy: alle vier Bereiche sind erreichbar', async () => {
    for (const [id, pfad] of [
      ['rooms', '/app/rooms'],
      ['friends', '/app/friends'],
      ['me', '/app/me'],
      ['chats', '/app/@me']
    ] as const) {
      await page.getByTestId(`tab-${id}`).click();
      await page.waitForURL(new RegExp(pfad.replace('@', '@')));
      await expect(page.getByTestId(`tab-${id}`)).toHaveAttribute('data-active', 'true');
      await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    }
  });

  test('Handy: auf einem Detail-Bildschirm verschwindet die Leiste', async () => {
    await page.goto('/app/me/appearance');
    await expect(page.getByTestId('me-section-page')).toBeVisible();
    await expect(page.getByTestId('mobile-tab-bar')).toBeHidden();
    // Zurueck fuehrt auf die Uebersicht, und die Leiste ist wieder da.
    await page.getByTestId('me-section-back').click();
    await page.waitForURL(/\/app\/me$/);
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
  });

  test('Handy: die System-Zurueck-Geste tut dasselbe wie der Pfeil', async () => {
    await page.goto('/app/me');
    await page.getByTestId('me-section-appearance').click();
    await page.waitForURL(/\/app\/me\/appearance$/);
    await page.goBack();
    await page.waitForURL(/\/app\/me$/);
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
  });

  test('Tablet: Spalte links statt Leiste unten', async ({ browser }) => {
    tabletCtx = await handyKontext(browser, TABLET);
    const tablet = await tabletCtx.newPage();
    await login(tablet, NUTZER);
    await tablet.goto('/app/rooms');
    // Erster App-Aufbau in diesem Kontext — je nachdem, welcher Spec die
    // Route als erster beruehrt, zahlt er die Vite-Kaltkompilierung.
    await expect(tablet.getByTestId('tablet-nav-rail')).toBeVisible({ timeout: 30_000 });
    await expect(tablet.getByTestId('mobile-tab-bar')).toBeHidden();
    await expect(tablet.getByTestId('guild-rail')).toBeHidden();
  });

  test('Rechner: keines von beidem, die Server-Leiste steht wieder', async ({ browser }) => {
    rechnerCtx = await browser.newContext({ viewport: RECHNER, locale: 'de-DE' });
    const rechner = await rechnerCtx.newPage();
    await login(rechner, NUTZER);
    await rechner.goto('/app/@me');
    await expect(rechner.getByTestId('mobile-tab-bar')).toBeHidden();
    await expect(rechner.getByTestId('tablet-nav-rail')).toBeHidden();
    await expect(rechner.getByTestId('guild-rail')).toBeVisible();
  });
});

/**
 * Tablet: Liste und Detail nebeneinander statt aufgeschoben.
 *
 * Der Test prueft die WIRKUNG, nicht die Klassen: zwei Bereiche gleichzeitig
 * sichtbar, und der eine links vom anderen. Genau das unterscheidet ein
 * Tablet-Layout von einem breit gezogenen Handy-Layout.
 */
test.describe('Tablet: Master-Detail', () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ctx = await handyKontext(browser, TABLET);
    page = await ctx.newPage();
    const name = `tab_${Date.now().toString(36)}`;
    await register(page, { username: name, email: `${name}@dcc-test.example.com` });
  });

  test.afterAll(async () => {
    await ctx?.close();
  });

  test('Raeume: Liste links, Platzhalter rechts', async () => {
    await page.goto('/app/rooms');
    const liste = page.getByTestId('rooms-page');
    const platz = page.getByTestId('tablet-placeholder');
    await expect(liste).toBeVisible({ timeout: 30_000 });
    await expect(platz).toBeVisible();
    const l = await liste.boundingBox();
    const p = await platz.boundingBox();
    expect(l!.x).toBeLessThan(p!.x);
  });

  test('Du: Liste bleibt stehen, das Detail erscheint daneben', async () => {
    await page.goto('/app/me');
    await expect(page.getByTestId('me-page')).toBeVisible();
    await page.getByTestId('me-section-appearance').click();
    await page.waitForURL(/\/app\/me\/appearance$/);
    // Die Liste ist NICHT verschwunden — das ist der Unterschied zum Handy.
    await expect(page.getByTestId('me-page')).toBeVisible();
    await expect(page.getByTestId('me-section-page')).toBeVisible();
    // Und ohne Zurueck-Pfeil: der Weg zurueck ist die Liste daneben.
    await expect(page.getByTestId('me-section-back')).toBeHidden();
  });

  test('auf dem Handy loest das Detail die Liste ab', async ({ browser }) => {
    const handyCtx = await handyKontext(browser);
    const handy = await handyCtx.newPage();
    const name = `tabh_${Date.now().toString(36)}`;
    await register(handy, { username: name, email: `${name}@dcc-test.example.com` });
    await handy.goto('/app/me/appearance');
    await expect(handy.getByTestId('me-section-page')).toBeVisible();
    await expect(handy.getByTestId('me-page')).toBeHidden();
    await expect(handy.getByTestId('me-section-back')).toBeVisible();
    await handyCtx.close();
  });
});
