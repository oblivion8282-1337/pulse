/**
 * Overnight T5 — Kanalrechte-Overwrites über die UI:
 * VIEW-Entzug für eine Rolle, CREATE_INVITES kanalskopiert (entziehen und
 * gezielt erlauben), SEND-Entzug, User-Overwrite gegen eine einzelne
 * Person, Voice-Bit CONNECT.
 *
 * Die Overwrites setzt der Owner im Kanalrechte-Editor
 * (ChannelOverridesEditor); die Wirkung wird an Bobs Seite geprüft —
 * UI (Kanal verschwindet) und Server-Wahrheit (`/permissions/me`,
 * Message-403, Invite-Mint).
 *
 * Bits (dcc_shared/permissions.py): VIEW=20 SEND=22 CREATE_INVITES=26
 * CONNECT=30.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const PASSWORD = 'sup3r-secret-pass';

const bit = (n: number) => (1n << BigInt(n)).toString();
const VIEW = bit(20);
const SEND = bit(22);
const CREATE_INVITES = bit(26);
const CONNECT = bit(30);

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

async function userId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
  });
  if (!value) throw new Error('kein Access-Token im localStorage');
  return value;
}

async function apiStatus(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ path, init }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat${path}`, {
        method: init?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body)
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
    { path, init }
  );
}

async function api<T>(page: Page, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await apiStatus(page, path, init);
  if (r.status >= 300) throw new Error(`${path} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** Aufgelöste Kanalrechte der eigenen Person — die Server-Wahrheit. */
async function meineKanalRechte(page: Page, channelId: string): Promise<string> {
  return (await api<{ permissions: string }>(page, `/channels/${channelId}/permissions/me`)).permissions;
}

const hatBit = (bitfield: string, bitWert: string) => (BigInt(bitfield) & BigInt(bitWert)) !== 0n;

/** Overwrite im Kanalrechte-Editor setzen: Kanal-Kontextmenü → Rechte,
 *  Ziel wählen, Dreizustands-Knopf auf allow/deny, speichern. */
async function overwriteSetzen(
  page: Page,
  channelId: string,
  ziel: string,
  bitWert: string,
  richtung: 'allow' | 'deny'
) {
  await page.getByTestId(`channel-${channelId}`).click({ button: 'right' });
  await page.getByTestId(`channel-permissions-${channelId}`).click();
  await expect(page.getByTestId('channel-overrides')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`perm-target-${ziel}`).click({ timeout: 10_000 });
  await page.getByTestId(`override-toggle-${ziel}-${bitWert}-${richtung}`).click();
  await expect(
    page.getByTestId(`override-toggle-${ziel}-${bitWert}-${richtung}`)
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('perm-save').click();
  await expect(page.getByText('Kanalrechte gespeichert')).toBeVisible({ timeout: 10_000 });
  // Zurück in den Kanal, damit der nächste Rechtsklick wieder greift.
  await page.goto(`/app/guilds/${page.url().match(/\/app\/guilds\/(\d+)/)![1]}/channels/${channelId}`);
  await expect(page.getByTestId(`channel-${channelId}`)).toBeVisible({ timeout: 15_000 });
}

/** Community über das Rail-Plus-Menü beitreten. Die Dropdown-Einträge
 *  kommen als Portal manchmal nicht zur Ruhe (Re-Render der Rail) —
 *  Sichtbarkeit erzwingen und den sichtbaren Eintrag mit Klick erzwingen. */
async function guildBeitreten(page: Page, code: string) {
  await page.locator('[data-testid^="guild-create-menu-"]').first().click();
  const join = page.getByTestId('guild-join');
  await expect(join).toBeAttached();
  await join.click({ force: true });
  await page.getByTestId('join-guild-input').fill(code);
  await page.getByTestId('join-guild-submit').click();
  await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });
}

test.describe.serial('Overnight Kanalrechte', () => {
  let ownerCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let carolCtx: BrowserContext;
  let owner: Page;
  let bob: Page;
  let carol: Page;
  let guildId = '';
  let generalId = '';
  let geheimId = '';
  let ladeckeId = '';
  let stummId = '';
  let buehneId = '';
  let bobId = '';
  let besucherRoleId = '';
  let everyoneRoleId = '';

  test.beforeAll(async ({ browser }) => {
    ownerCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    carolCtx = await browser.newContext();
    owner = await ownerCtx.newPage();
    bob = await bobCtx.newPage();
    carol = await carolCtx.newPage();
  });

  test.afterAll(async () => {
    for (const ctx of [ownerCtx, bobCtx, carolCtx]) await ctx.close();
  });

  test('Setup A: drei Nutzer registrieren', async () => {
    test.setTimeout(90_000);
    const users = [
      { username: `permown2_${ts}`, email: `permown2_${ts}@dcc-test.example.com` },
      { username: `permbob2_${ts}`, email: `permbob2_${ts}@dcc-test.example.com` },
      { username: `permcarol2_${ts}`, email: `permcarol2_${ts}@dcc-test.example.com` }
    ];
    for (const [i, page] of [owner, bob, carol].entries()) {
      await register(page, { ...users[i], password: PASSWORD });
    }
    bobId = await userId(bob);
  });

  test('Setup B: Community, Beitragritt, Rolle und Kanäle', async () => {
    await owner.locator('[data-testid^="guild-create-menu-"]').first().click();
    await owner.getByTestId('guild-create').click();
    await owner.getByTestId('create-guild-name').fill('Kanalrechte GmbH');
    await owner.getByTestId('create-guild-submit').click();
    await owner.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    guildId = owner.url().match(/\/app\/guilds\/(\d+)/)![1];
    generalId = owner.url().match(/channels\/(\d+)/)![1];

    const invite = await api<{ code: string }>(owner, `/guilds/${guildId}/invites`, {
      method: 'POST',
      body: { max_uses: 5, expires_in_seconds: 86400 }
    });
    for (const page of [bob, carol]) {
      await guildBeitreten(page, invite.code);
    }

    besucherRoleId = (
      await api<{ id: string }>(owner, `/guilds/${guildId}/roles`, {
        method: 'POST',
        body: { name: 'Besucher' }
      })
    ).id;
    await api(owner, `/guilds/${guildId}/members/${bobId}/roles/${besucherRoleId}`, { method: 'PUT' });
    everyoneRoleId = (await api<{ id: string; is_everyone: boolean }[]>(owner, `/guilds/${guildId}/roles`)).find(
      (r) => r.is_everyone
    )!.id;

    for (const [name, type] of [
      ['geheim', 0],
      ['ladecke', 0],
      ['stumm', 0],
      ['buehne', 1]
    ] as const) {
      const ch = await api<{ id: string }>(owner, `/guilds/${guildId}/channels`, {
        method: 'POST',
        body: { name, type }
      });
      if (name === 'geheim') geheimId = ch.id;
      else if (name === 'ladecke') ladeckeId = ch.id;
      else if (name === 'stumm') stummId = ch.id;
      else buehneId = ch.id;
    }
  });

  test('VIEW der Rolle entziehen — bob verliert den Kanal, carol behält ihn', async () => {
    await owner.goto(`/app/guilds/${guildId}/channels/${geheimId}`);
    await expect(owner.getByTestId(`channel-${geheimId}`)).toBeVisible({ timeout: 15_000 });
    await overwriteSetzen(owner, geheimId, `0:${besucherRoleId}`, VIEW, 'deny');

    await bob.reload();
    await expect(bob.getByTestId(`channel-${geheimId}`)).toHaveCount(0);
    await carol.reload();
    await expect(carol.getByTestId(`channel-${geheimId}`).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Server-Wahrheit: bobs /permissions/me ohne VIEW im geheim-Kanal', async () => {
    expect(hatBit(await meineKanalRechte(bob, geheimId), VIEW)).toBe(false);
    expect(hatBit(await meineKanalRechte(carol, geheimId), VIEW)).toBe(true);
    expect((await apiStatus(bob, `/channels/${geheimId}`)).status).toBe(404);
  });

  test('CREATE_INVITES auf der ladecke: @everyone entzogen, Besucher erlaubt', async () => {
    // Zuerst @everyone das Einladen AUF DIESEM Kanal nehmen …
    await owner.goto(`/app/guilds/${guildId}/channels/${ladeckeId}`);
    await expect(owner.getByTestId(`channel-${ladeckeId}`)).toBeVisible({ timeout: 15_000 });
    await overwriteSetzen(owner, ladeckeId, `0:${everyoneRoleId}`, CREATE_INVITES, 'deny');
    const ohne = await apiStatus(bob, `/guilds/${guildId}/invites`, {
      method: 'POST',
      body: { max_uses: 1, channel_id: ladeckeId }
    });
    expect(ohne.status).toBe(403);

    // … dann der Besucher-Rolle gezielt zurückgeben.
    await overwriteSetzen(owner, ladeckeId, `0:${besucherRoleId}`, CREATE_INVITES, 'allow');
    const mit = await apiStatus(bob, `/guilds/${guildId}/invites`, {
      method: 'POST',
      body: { max_uses: 1, channel_id: ladeckeId }
    });
    expect(mit.status).toBeLessThan(300);
  });

  test('SEND entziehen — bobs Nachricht wird mit 403 abgewiesen', async () => {
    await owner.goto(`/app/guilds/${guildId}/channels/${stummId}`);
    await expect(owner.getByTestId(`channel-${stummId}`)).toBeVisible({ timeout: 15_000 });
    await overwriteSetzen(owner, stummId, `0:${besucherRoleId}`, SEND, 'deny');

    const versuch = await apiStatus(bob, `/channels/${stummId}/messages`, {
      method: 'POST',
      body: { content: 'darf ich das?' }
    });
    expect(versuch.status).toBe(403);
    // Der Owner bleibt vom Overwrite unberührt.
    const ownerOk = await apiStatus(owner, `/channels/${stummId}/messages`, {
      method: 'POST',
      body: { content: 'owner darf' }
    });
    expect(ownerOk.status).toBeLessThan(300);
  });

  test('User-Overwrite: NUR bob verliert die insel, carol sieht sie weiter', async () => {
    await owner.goto(`/app/guilds/${guildId}/channels/${generalId}`);
    await expect(owner.getByTestId(`channel-${generalId}`)).toBeVisible({ timeout: 15_000 });
    // Ziel 1:<userId> = Nutzer-Overwrite, nicht Rolle.
    await overwriteSetzen(owner, generalId, `1:${bobId}`, VIEW, 'deny');

    await bob.reload();
    await expect(bob.getByTestId(`channel-${generalId}`)).toHaveCount(0);
    await carol.reload();
    await expect(carol.getByTestId(`channel-${generalId}`).first()).toBeVisible({ timeout: 15_000 });

    // Rücknehmen — der Kanal kommt für bob wieder zurück.
    await owner.evaluate(async (cid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      await fetch(`/api/chat/channels/${cid}/permissions/1/${bobId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
    }, generalId);
    await bob.reload();
    await expect(bob.getByTestId(`channel-${generalId}`).first()).toBeVisible({ timeout: 15_000 });
  });

  test('CONNECT auf der buehne entziehen — bob darf nicht beitreten', async () => {
    await owner.goto(`/app/guilds/${guildId}/channels/${buehneId}`);
    await expect(owner.getByTestId(`channel-${buehneId}`)).toBeVisible({ timeout: 15_000 });
    await overwriteSetzen(owner, buehneId, `0:${besucherRoleId}`, CONNECT, 'deny');

    // Voice-signaling läuft im E2E-Stack nicht — die Server-Wahrheit ist
    // das aufgelöste Recht: bob ohne CONNECT, carol (keine Rolle) mit.
    expect(hatBit(await meineKanalRechte(bob, buehneId), CONNECT)).toBe(false);
    expect(hatBit(await meineKanalRechte(carol, buehneId), CONNECT)).toBe(true);
  });
});
