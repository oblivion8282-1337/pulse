/**
 * Overnight T10 — Sprachkanal-Oberfläche ohne echtes WebRTC.
 *
 * **Wo diese Suite absichtlich stoppt:** ein echter Join (Teilnehmerliste,
 * Mic-/Deafen-Umschalter, Auflegen, Limit-Durchsetzung) braucht den
 * voice-signaling-Dienst + LiveKit — und die E2E-Suite fährt beides bewusst
 * NICHT (`_ports.ts`: E2E_VOICE_PORT zeigt ins Leere, damit kein Testvekehr
 * still gegen den Dev-Stack läuft; dieselbe Grenze zieht
 * `mobile-voice-bar.spec.ts`). Geprüft wird hier alles bis zu dieser Grenze:
 * Kanal anlegen, Ansicht + Beitreten-Knopf, Fehlerweg ohne Signalgeber,
 * Limit-Anzeige für beide Seiten — und dass ohne Verbindung kein
 * Auflegen-Knopf existiert.
 */

import { test, expect, type Page, type BrowserContext, type Locator } from '@playwright/test';

const ts = Date.now();
const OWNER = {
  username: `vc_owner_${ts}`,
  email: `vc_owner_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const GAST = {
  username: `vc_gast_${ts}`,
  email: `vc_gast_${ts}@dcc-test.example.com`,
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

test.describe.serial('Overnight T10 — Sprachkanal', () => {
  let ownerCtx: BrowserContext;
  let ownerPage: Page;
  let gastCtx: BrowserContext;
  let gastPage: Page;
  let guildId = '';
  let voiceKanal: Locator;

  test.beforeAll(async ({ browser }) => {
    ownerCtx = await browser.newContext();
    gastCtx = await browser.newContext();
    // Changelog-Toast stummschalten — steht unten rechts und frisst Klicks
    // (Muster aus dms.spec.ts).
    for (const ctx of [ownerCtx, gastCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    ownerPage = await ownerCtx.newPage();
    gastPage = await gastCtx.newPage();
  });

  test.afterAll(async () => {
    await ownerCtx.close();
    await gastCtx.close();
  });

  test('Aufbau: Owner registriert, Community + Sprachkanal per UI', async () => {
    await register(ownerPage, OWNER);
    await ownerPage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await ownerPage.getByTestId('guild-create').click();
    await ownerPage.getByTestId('create-guild-name').fill('Voice Guild');
    await ownerPage.getByTestId('create-guild-submit').click();
    await ownerPage.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    guildId = new URL(ownerPage.url()).pathname.split('/')[3];

    await ownerPage.getByTestId('channel-create').click();
    await ownerPage.getByTestId('create-channel-type-voice').click();
    await ownerPage.getByTestId('create-channel-name').fill('lounge');
    await ownerPage.getByTestId('create-channel-submit').click();
    voiceKanal = ownerPage.getByRole('button', { name: 'lounge', exact: true });
    await expect(voiceKanal).toBeVisible({ timeout: 10_000 });
  });

  test('Gast registriert und sieht den Sprachkanal in der Liste', async () => {
    await register(gastPage, GAST);
    // Beitritt per API (Beitritts-UI gehört in T9), dann in die Community.
    // guildId muss als Argument in die Browser-Seite hinein — im Callback
    // gibt es den Test-Scope nicht.
    const gastId = await gastPage.evaluate(() => {
      const raw = localStorage.getItem('dcc.tokens.access')!;
      return JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
    });
    const status = await ownerPage.evaluate(async ({ gid, uid }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/guilds/${gid}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: uid })
      });
      return r.status;
    }, { gid: guildId, uid: gastId });
    expect([200, 201]).toContain(status);

    await gastPage.goto('/app');
    await gastPage.getByTestId(`guild-${guildId}`).first().click();
    await expect(gastPage.getByRole('button', { name: 'lounge', exact: true })).toBeVisible({
      timeout: 15_000
    });
  });

  test('Sprachkanal öffnen: Ansicht + Beitreten-Knopf', async () => {
    await ownerPage.getByRole('button', { name: 'lounge', exact: true }).click();
    await expect(ownerPage.getByTestId('voice-channel-view')).toBeVisible({ timeout: 10_000 });
    await expect(ownerPage.getByTestId('voice-join')).toBeVisible();
    // Beim Betreten setzt die Seite den gegardeten Auto-Join ab; ohne
    // Signalgeber landet die Statuszeile auf „Fehler: …“ (sonst „Nicht
    // verbunden“). Beides ist hier richtig — verbunden ist keiner.
    await expect(ownerPage.getByTestId('voice-channel-view')).toContainText(
      /Fehler:|Nicht verbunden/,
      { timeout: 10_000 }
    );
    // Ohne Verbindung gibt es nichts zum Auflegen.
    await expect(ownerPage.getByTestId('voice-disconnect')).toHaveCount(0);
  });

  test('Beitreten ohne Signalgeber: sichtbarer Fehler, kein stiller Hänger', async () => {
    await ownerPage.getByTestId('voice-join').click();
    // Die Statuszeile schaltet auf „Fehler: …“ (voice.error), der Zustand
    // räumt sich auf — Beitreten-Knopf bleibt benutzbar, kein Auflegen-Knopf.
    await expect(ownerPage.getByTestId('voice-channel-view')).toContainText('Fehler:', {
      timeout: 15_000
    });
    await expect(ownerPage.getByTestId('voice-disconnect')).toHaveCount(0);
    await expect(ownerPage.getByTestId('voice-join')).toBeVisible();
  });

  test('Benutzerlimit 1 setzen — Badge zeigt 0/1', async () => {
    await voiceKanal.click({ button: 'right' });
    await ownerPage.getByTestId('channel-context-settings').click();
    await expect(ownerPage.getByTestId('rename-channel-dialog')).toBeVisible({ timeout: 10_000 });
    await ownerPage.getByTestId('rename-channel-user-limit').fill('1');
    await ownerPage.getByTestId('rename-channel-submit').click();

    const badge = ownerPage.getByTestId(
      `channel-user-limit-${new URL(ownerPage.url()).pathname.split('/')[5]}`
    );
    // Der Owner steht (nach dem fehlgeschlagenen Join) noch im Sprachkanal-
    // View; die Badge hängt an der Zeile in der Kanalliste.
    await expect(badge).toHaveText('0/1', { timeout: 10_000 });
  });

  test('Gast sieht dasselbe Limit-Badge und den Beitreten-Knopf', async () => {
    // Das Limit-Badge erweitert den zugänglichen Namen der Zeile ("lounge 0/1").
    await gastPage
      .getByRole('button', { name: /lounge/ })
      .click();
    await expect(gastPage.getByTestId('voice-channel-view')).toBeVisible({ timeout: 10_000 });
    await expect(gastPage.getByTestId('voice-join')).toBeVisible();
    const kanalId = new URL(gastPage.url()).pathname.split('/')[5];
    await expect(gastPage.getByTestId(`channel-user-limit-${kanalId}`)).toHaveText('0/1', {
      timeout: 10_000
    });
  });

  test('Gasts Beitreten-Versuch scheitert sichtbar am fehlenden Signalgeber', async () => {
    // Der Limit-Voll-Treffer (zweiter Join → 409) bräuchte einen LiveKit-Raum;
    // ohne Signalgeber ist der Fehlerweg der, den dieser Test sieht.
    await gastPage.getByTestId('voice-join').click();
    await expect(gastPage.getByTestId('voice-channel-view')).toContainText('Fehler:', {
      timeout: 15_000
    });
    await expect(gastPage.getByTestId('voice-disconnect')).toHaveCount(0);
  });
});
