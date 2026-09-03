/**
 * Zwei-Geraete-Nachweis gegen den REMOTE-Dev-Stack: eine verschluesselte DM
 * (Text UND Bild) bleibt sichtbar, nachdem der Empfaenger den Chat verlassen
 * und wieder geoeffnet hat — und nach einem Neuladen.
 *
 * Gemeldet 2026-09-03: „das Bild kam an, dann bin ich aus dem Chat raus,
 * dann wieder rein, und dann waren das Bild und die Nachricht nicht mehr
 * da". Der Server hat fuer verschluesselte DMs keinen Verlauf — was beim
 * Wiederoeffnen erscheint, kommt allein aus dem lokalen Verlauf des Geraets.
 *
 *   cd web && pnpm exec playwright test tests/e2e/e2e-dm-verlauf-hetzner.spec.ts \
 *     --config=tests/e2e/playwright.hetzner.config.ts
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  DEV,
  DEV2,
  schalterEinschalten,
  alsElektronGeraetAusgeben,
  login,
  currentUserId,
  becomeFriends,
  createDmChannel,
  warteAufSchluesselbuendel
} from './_hetzner-helfer.ts';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

async function bildSichtbar(page: Page, kuerzel: string): Promise<void> {
  const zeile = page.getByTestId('message-item').filter({ hasText: kuerzel });
  await expect(zeile).toBeVisible({ timeout: 15_000 });
  const kachel = zeile.getByTestId('attachment-image');
  await expect(kachel).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => (await kachel.locator('img').getAttribute('src')) ?? '', { timeout: 15_000 })
    .toMatch(/^blob:/);
}

test.describe.serial('Verschluesselte DM bleibt nach Verlassen und Wiederoeffnen', () => {
  let devCtx: BrowserContext;
  let dev2Ctx: BrowserContext;
  let devPage: Page;
  let dev2Page: Page;
  let cid = '';

  test.beforeAll(async ({ browser }) => {
    devCtx = await browser.newContext();
    dev2Ctx = await browser.newContext();
    for (const ctx of [devCtx, dev2Ctx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
      await schalterEinschalten(ctx);
      await alsElektronGeraetAusgeben(ctx);
    }
    devPage = await devCtx.newPage();
    dev2Page = await dev2Ctx.newPage();
    await login(devPage, DEV);
    await login(dev2Page, DEV2);
    const devId = await currentUserId(devPage);
    const dev2Id = await currentUserId(dev2Page);
    await warteAufSchluesselbuendel(devPage, devId);
    await warteAufSchluesselbuendel(dev2Page, dev2Id);
    await becomeFriends(devPage, devId, dev2Page, dev2Id);
    cid = await createDmChannel(devPage, dev2Id);
    await dev2Page.goto(`/app/@me/${cid}`);
    await expect(dev2Page.getByTestId('message-input')).toBeVisible({ timeout: 15_000 });
    await devPage.goto(`/app/@me/${cid}`);
    await expect(devPage.getByTestId('active-channel-name')).toHaveText('dev2', { timeout: 15_000 });
  });

  test.afterAll(async () => {
    await devCtx.close();
    await dev2Ctx.close();
  });

  test('Text: live da, nach Verlassen/Wiederoeffnen und nach Neuladen noch da', async () => {
    const TEXT = `verlauf-nachweis ${Date.now()}`;
    await dev2Page.getByTestId('message-input').fill(TEXT);
    await dev2Page.getByTestId('message-input').press('Enter');
    const zeile = () => devPage.locator('[data-testid="message-content"]', { hasText: TEXT });
    await expect(zeile()).toBeVisible({ timeout: 15_000 });

    await devPage.goto('/app/@me');
    await expect(devPage.getByTestId('message-input')).toBeHidden({ timeout: 10_000 });
    await devPage.goto(`/app/@me/${cid}`);
    await expect(zeile(), 'nach Verlassen/Wiederoeffnen weg').toBeVisible({ timeout: 15_000 });

    await devPage.reload();
    await expect(zeile(), 'nach Neuladen weg').toBeVisible({ timeout: 20_000 });
  });

  test('Bild: live da, nach Verlassen/Wiederoeffnen und nach Neuladen noch da', async () => {
    await dev2Page.getByTestId('attachment-file-input').setInputFiles({
      name: 'bild.png',
      mimeType: 'image/png',
      buffer: TINY_PNG
    });
    await expect(dev2Page.getByTestId('attachment-preview')).toBeVisible({ timeout: 10_000 });
    await expect(dev2Page.getByTestId('message-send')).toBeEnabled({ timeout: 30_000 });
    const KRZ = `bild-nachweis ${Date.now()}`;
    await dev2Page.getByTestId('message-input').fill(KRZ);
    await dev2Page.getByTestId('message-send').click();
    await bildSichtbar(devPage, KRZ);

    await devPage.goto('/app/@me');
    await expect(devPage.getByTestId('message-input')).toBeHidden({ timeout: 10_000 });
    await devPage.goto(`/app/@me/${cid}`);
    await bildSichtbar(devPage, KRZ);

    await devPage.reload();
    await bildSichtbar(devPage, KRZ);
  });
});
