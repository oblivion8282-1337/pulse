/**
 * Die Layout-Regel des chat-first-Umbaus, an echten Bildschirmgroessen
 * geprueft: wer navigiert auf welcher Breite, und verschwindet die
 * Bereichs-Leiste auf einem Detail-Bildschirm?
 *
 * **Warum als E2E und nicht als Unit-Test:** die Rechnung dahinter
 * (`tabs.ts`) hat eigene Unit-Tests. Was die hier nicht abdecken koennen, ist
 * das Zusammenspiel mit `viewport` und den Tailwind-Breakpoints — genau die
 * Stelle, an der eine falsche Klasse dazu fuehrt, dass zwei Navigationen
 * gleichzeitig dastehen oder gar keine. Das sieht man nur im echten Fenster.
 */
import { test, expect, type Page } from '@playwright/test';

const PW = 'Passwort123!';

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

const NUTZER = {
  username: `shell_${Date.now().toString(36)}`,
  email: `shell_${Date.now().toString(36)}@dcc-test.example.com`
};

test.describe.configure({ mode: 'serial' });

test.describe('Mobile-Shell: die Layout-Regel', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await register(page, NUTZER);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('Handy: Bereichs-Leiste unten, keine Server-Leiste', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
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

  test('Tablet: Spalte links statt Leiste unten', async () => {
    await page.setViewportSize({ width: 834, height: 1112 });
    await page.goto('/app/rooms');
    await expect(page.getByTestId('tablet-nav-rail')).toBeVisible();
    await expect(page.getByTestId('mobile-tab-bar')).toBeHidden();
    await expect(page.getByTestId('guild-rail')).toBeHidden();
  });

  test('Rechner: keines von beidem, die Server-Leiste steht wieder', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/app/@me');
    await expect(page.getByTestId('mobile-tab-bar')).toBeHidden();
    await expect(page.getByTestId('tablet-nav-rail')).toBeHidden();
    await expect(page.getByTestId('guild-rail')).toBeVisible();
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
  let page: Page;
  const TABLET = { width: 834, height: 1112 };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: TABLET });
    const name = `tab_${Date.now().toString(36)}`;
    await page.goto('/register');
    await page.getByTestId('reg-username').fill(name);
    await page.getByTestId('reg-email').fill(`${name}@dcc-test.example.com`);
    await page.getByTestId('reg-password').fill('Passwort123!');
    await page.getByTestId('reg-submit').click();
    await page.waitForURL(/\/app/);
    await page
      .locator('[data-testid=backup-onboarding-skip-btn]')
      .click({ timeout: 2500 })
      .catch(() => undefined);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('Raeume: Liste links, Platzhalter rechts', async () => {
    await page.goto('/app/rooms');
    const liste = page.getByTestId('rooms-page');
    const platz = page.getByTestId('tablet-placeholder');
    await expect(liste).toBeVisible();
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

  test('auf dem Handy loest das Detail die Liste ab', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/app/me/appearance');
    await expect(page.getByTestId('me-section-page')).toBeVisible();
    await expect(page.getByTestId('me-page')).toBeHidden();
    await expect(page.getByTestId('me-section-back')).toBeVisible();
  });
});
