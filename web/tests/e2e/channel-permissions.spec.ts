/**
 * E2E für den Exklusiv-Weg in ChannelOverridesEditor: „Nur für diese Rolle"
 * macht den Kanal exklusiv — die Rolle bekommt VIEW_CHANNEL erlaubt, @everyone
 * verboten, und Mitglieder ohne die Rolle verlieren den Kanal aus der Leiste.
 *
 * Nachgezogen mit dem Umbau der Kanalrechte-Ansicht (2026-08-16): die beiden
 * Auswahlfelder „Rolle/Mitglied hinzufügen" gibt es nicht mehr — links stehen
 * jetzt alle Ziele, getrennt in „Mit Abweichung" und „Ohne Abweichung", und
 * gespeichert wird über eine Leiste unten statt je Zeile. Die Testids der
 * Dreizustands-Knöpfe sind absichtlich gleich geblieben.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `chperm_alice_${ts}`,
  email: `chperm_alice_${ts}@dcc-test.example.com`,
  password: 'chperm-secret-pass'
};
const BOB = {
  username: `chperm_bob_${ts}`,
  email: `chperm_bob_${ts}@dcc-test.example.com`,
  password: 'chperm-secret-pass'
};

async function register(page: Page, u: typeof ALICE) {
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

/** Authenticated fetch inside the page context (same pattern as roles.spec). */
async function api<T>(page: Page, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(
    async ({ path, init }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat${path}`, {
        method: init?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body)
      });
      if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
      return (await r.json()) as never;
    },
    { path, init }
  );
}

test.describe.serial('Channel permissions — exclusive role add', () => {
  let aliceCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let alice: Page;
  let bob: Page;
  let guildId = '';
  let vipChannelId = '';
  let vipRoleId = '';
  let everyoneRoleId = '';

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

  test('setup: users, guild, bob joins, VIP role + channel exist', async () => {
    await register(alice, ALICE);
    await register(bob, BOB);

    // Rail-Plus-Menü statt Empty-State: /app landet seit 65a050f7 auf
    // /app/friends, das Empty-State-Panel existiert dort nicht.
    await alice.locator('[data-testid^="guild-create-menu-"]').first().click();
    await alice.getByTestId('guild-create').click();
    await alice.getByTestId('create-guild-name').fill('ChPerm Guild');
    await alice.getByTestId('create-guild-submit').click();
    await alice.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    guildId = alice.url().match(/\/app\/guilds\/(\d+)/)![1];

    const invite = await api<{ code: string }>(alice, `/guilds/${guildId}/invites`, {
      method: 'POST',
      body: { max_uses: 1, expires_in_seconds: 86400 }
    });
    await bob.locator('[data-testid^="guild-create-menu-"]').first().click();
    await bob.getByTestId('guild-join').click();
    await bob.getByTestId('join-guild-input').fill(invite.code);
    await bob.getByTestId('join-guild-submit').click();
    await bob.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });

    // VIP role (no members assigned — bob must NOT have it) + VIP channel,
    // both via API: the creation UIs are covered elsewhere.
    const role = await api<{ id: string }>(alice, `/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'VIP' }
    });
    vipRoleId = role.id;
    // @everyone-Id für die Gegenprobe: die Ansicht adressiert Ziele über
    // `<art>:<id>`, und die implizite Rolle hat keinen festen Namen im DOM.
    const alleRollen = await api<{ id: string; is_everyone: boolean }[]>(
      alice,
      `/guilds/${guildId}/roles`
    );
    everyoneRoleId = alleRollen.find((r) => r.is_everyone)!.id;
    const channel = await api<{ id: string }>(alice, `/guilds/${guildId}/channels`, {
      method: 'POST',
      body: { name: 'vip-lounge', type: 0 }
    });
    vipChannelId = channel.id;

    // Public at creation: bob sees the channel once his list refreshes.
    await bob.reload();
    await expect(bob.getByTestId(`channel-${vipChannelId}`)).toBeVisible({ timeout: 15_000 });
  });

  test('alice macht den Kanal exklusiv — @everyone wird ausgeschlossen', async () => {
    // The permissions page reads the channel from the client-side guild
    // store, so navigate like a user would: app shell first, then the
    // channel context menu (which is the feature's real entry point).
    await alice.goto(`/app/guilds/${guildId}/channels/${vipChannelId}`);
    await expect(alice.getByTestId(`channel-${vipChannelId}`)).toBeVisible({ timeout: 15_000 });
    await alice.getByTestId(`channel-${vipChannelId}`).click({ button: 'right' });
    await alice.getByTestId(`channel-permissions-${vipChannelId}`).click();
    await expect(alice.getByTestId('channel-overrides')).toBeVisible({ timeout: 15_000 });

    // Ziel links wählen, dann „Nur für diese Rolle" — das setzt beide Hälften
    // als Entwurf (Rolle erlauben, @everyone entziehen).
    await alice.getByTestId(`perm-target-0:${vipRoleId}`).click({ timeout: 10_000 });
    await alice.getByTestId('perm-exclusive-btn').click();

    const viewBit = (1n << 20n).toString();
    await expect(
      alice.getByTestId(`override-toggle-0:${vipRoleId}-${viewBit}-allow`)
    ).toHaveAttribute('aria-pressed', 'true');

    // Erst Speichern führt es aus; danach ist die Leiste wieder leer.
    await alice.getByTestId('perm-save').click();
    await expect(alice.getByText('Kanalrechte gespeichert')).toBeVisible({ timeout: 10_000 });
    await expect(alice.getByTestId('perm-save')).toBeDisabled();

    // Gegenprobe an @everyone: „Kanal ansehen" steht auf verboten.
    await alice.getByTestId(`perm-target-0:${everyoneRoleId}`).click();
    await expect(
      alice.getByTestId(`override-toggle-0:${everyoneRoleId}-${viewBit}-deny`)
    ).toHaveAttribute('aria-pressed', 'true');
    // Und die Ergebnis-Spalte sagt es in Worten statt nur über einen Schalter.
    await expect(
      alice.getByTestId(`perm-result-0:${everyoneRoleId}-${viewBit}`)
    ).toContainText('hier verboten');
  });

  test('bob (without the role) no longer sees the channel', async () => {
    await bob.reload();
    // His remaining channels still render…
    await expect(bob.locator('[data-testid^="channel-"]').first()).toBeVisible({
      timeout: 15_000
    });
    // …but the VIP channel is gone (server-side filter in list_channels).
    await expect(bob.getByTestId(`channel-${vipChannelId}`)).toHaveCount(0);
  });

  test('alice still sees the channel (owner bypass) — with a lock icon', async () => {
    await alice.goto(`/app/guilds/${guildId}/channels/${vipChannelId}`);
    await expect(alice.getByTestId(`channel-${vipChannelId}`)).toBeVisible({ timeout: 15_000 });
    // The sidebar marks the exclusive channel with the lock indicator
    // (restricted flag from GET /guilds/:id/channels).
    await expect(alice.getByTestId(`channel-lock-${vipChannelId}`)).toBeVisible();
    // The public default channel has no lock.
    const lockedChannels = alice.locator('[data-testid^="channel-lock-"]');
    await expect(lockedChannels).toHaveCount(1);
  });
});
