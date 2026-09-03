/**
 * Zwei-Geraete-Nachweis gegen den REMOTE-Dev-Stack: eine verschluesselte DM
 * kommt auch dann LIVE an, wenn beim Empfaenger gerade ein Self-Host-Server
 * aktiv ist — die Cloud-Verbindung laeuft dann im Hintergrund, und der
 * `postfach_neu`-Weckruf muss durch ihre Allowlist (`ws/dispatch-rules.ts`).
 *
 * Befund 2026-09-03: der Weckruf fehlte in der Allowlist; der Empfaenger sah
 * die Nachricht erst nach einem Reload. Der Absender sah seine eigene Zeile
 * dabei immer — deshalb prueft dieser Lauf BEIDE Seiten, was
 * `e2e-dm-hetzner.spec.ts` fuer den Absender nie tat.
 *
 * Der Self-Host ist ein Eintrag in der geraetelokalen Serverliste, dessen
 * Adresse nicht antwortet — es geht nur darum, dass er AKTIV ist; ob die
 * Verbindung zu ihm steht, spielt fuer die Frage keine Rolle.
 *
 *   cd web && pnpm exec playwright test tests/e2e/e2e-dm-hintergrund-hetzner.spec.ts \
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

/** Traegt einen nicht erreichbaren Self-Host in die lokale Serverliste ein
 *  und macht ihn zum aktiven Server — wirkt ab dem naechsten Seitenladen.
 *
 *  Achtung, nur EIN Seitenladen weit tragfaehig: `alsElektronGeraetAusgeben`
 *  stellt einen leeren Tresor nach, und `servers.svelte.ts` zieht die
 *  localStorage-Liste beim Start dorthin um und loescht den Schluessel. Ein
 *  zweites `goto` faende den Eintrag nicht mehr, der aktive Server fiele
 *  still auf die Cloud zurueck — deshalb prueft der Test den aktiven Server
 *  nach dem Laden ausdruecklich nach. */
async function selfHostAktivieren(page: Page): Promise<void> {
  await page.evaluate(() => {
    const liste = JSON.parse(localStorage.getItem('pulse.servers') ?? '[]') as { id: string }[];
    const fremd = {
      id: 'e2e-selfhost-hintergrund',
      hostname: 'https://selfhost.e2e.invalid',
      instance_id: '87472756903383040',
      je_verbunden: true,
      label: 'E2E-Self-Host',
      server_name: 'E2E-Self-Host',
      origin: 'vps',
      isCloud: false,
      role: null
    };
    if (!liste.some((s) => s.id === fremd.id)) liste.push(fremd);
    localStorage.setItem('pulse.servers', JSON.stringify(liste));
    localStorage.setItem('pulse.active_server', fremd.id);
  });
}

test.describe.serial('Verschluesselte DM bei aktivem Self-Host (Hintergrund-Cloud)', () => {
  let devCtx: BrowserContext;
  let dev2Ctx: BrowserContext;
  let devPage: Page;
  let dev2Page: Page;

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
  });

  test.afterAll(async () => {
    await devCtx.close();
    await dev2Ctx.close();
  });

  test('Empfaenger mit aktivem Self-Host sieht die DM live, Absender seine eigene sofort', async () => {
    await login(devPage, DEV);
    await login(dev2Page, DEV2);
    const devId = await currentUserId(devPage);
    const dev2Id = await currentUserId(dev2Page);
    await warteAufSchluesselbuendel(devPage, devId);
    await warteAufSchluesselbuendel(dev2Page, dev2Id);
    await becomeFriends(devPage, devId, dev2Page, dev2Id);
    const cid = await createDmChannel(devPage, dev2Id);

    // dev2 = Empfaenger, mit fremdem aktiven Server.
    await selfHostAktivieren(dev2Page);
    await dev2Page.goto(`/app/@me/${cid}`);
    await expect(dev2Page.getByTestId('message-input')).toBeVisible({ timeout: 15_000 });
    expect(await dev2Page.evaluate(() => localStorage.getItem('pulse.active_server'))).toBe(
      'e2e-selfhost-hintergrund'
    );

    await devPage.goto(`/app/@me/${cid}`);
    await expect(devPage.getByTestId('active-channel-name')).toHaveText('dev2', {
      timeout: 15_000
    });

    const TEXT = `hintergrund-nachweis ${Date.now()}`;
    await devPage.getByTestId('message-input').click();
    await devPage.getByTestId('message-input').fill(TEXT);
    await devPage.getByTestId('message-input').press('Enter');

    // Der Absender sieht seine eigene Zeile — ohne Reload.
    await expect(
      devPage.locator('[data-testid="message-content"]', { hasText: TEXT })
    ).toBeVisible({ timeout: 10_000 });
    // Der Empfaenger auch, obwohl seine Cloud-Verbindung im Hintergrund laeuft.
    await expect(
      dev2Page.locator('[data-testid="message-content"]', { hasText: TEXT })
    ).toBeVisible({ timeout: 15_000 });
  });
});
