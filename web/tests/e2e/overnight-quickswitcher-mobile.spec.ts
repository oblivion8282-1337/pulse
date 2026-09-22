import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Overnight Bughunt T20 — QuickSwitcher und Mobile-Shell.
 *
 * Der QuickSwitcher ist ab Werk UNBELEGT (`actions.ts`: jede Aktion startet
 * ohne Tastenkürzel, um System-Kollisionen zu vermeiden) — der Test belegt
 * ihn deshalb zuerst über Einstellungen → Tastatur mit Strg+K und fährt
 * dann den echten Klick-Und-Tastatur-Weg: öffnen, tippen, Enter, Escape.
 *
 * Der Mobile-Teil fährt dieselbe Shell wie `mobile-shell.spec.ts` mit
 * 390×844: vier Bereiche, Chats-Suche, Räume-Kachel, Du-Bereich mit
 * Abmelden.
 */

const ts = Date.now();
const PASSWORT = 'sup3r-secret-pass';
const NUTZER = {
  username: `nutzer_t20_${ts}`,
  email: `nutzer_t20_${ts}@dcc-test.example.com`,
  password: PASSWORT
};
const PARTNER = {
  username: `partner_t20_${ts}`,
  email: `partner_t20_${ts}@dcc-test.example.com`,
  password: PASSWORT
};
const GUILD_NAME = `T20 Lounge ${ts}`;

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

async function login(page: Page, u: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
}

async function currentUserId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
  if (!value) throw new Error('no access token found in localStorage');
  return value;
}

async function becomeFriends(pageA: Page, uidA: string, pageB: Page, uidB: string): Promise<void> {
  const send = async (page: Page, targetId: string) => {
    const r = await page.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: resp.status, body: await resp.text() };
    }, targetId);
    if (r.status !== 201) throw new Error(`friend-request failed ${r.status}: ${r.body}`);
  };
  await send(pageA, uidB);
  await send(pageB, uidA);
}

async function createDmChannel(page: Page, targetUserId: string): Promise<string> {
  const resp = await page.evaluate(async (uid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch('/api/chat/dm-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_user_id: uid })
    });
    return { status: r.status, body: await r.text() };
  }, targetUserId);
  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`dm-channels failed ${resp.status}: ${resp.body}`);
  }
  return (JSON.parse(resp.body) as { id: string }).id;
}

async function api<T>(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
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

test.describe.serial('Overnight T20 — QuickSwitcher und Mobile', () => {
  let desktopCtx: BrowserContext;
  let seite: Page;
  let partnerCtx: BrowserContext;
  let partnerPage: Page;
  let mobileCtx: BrowserContext;
  let mobile: Page;
  let guildId = '';
  let randomChannelId = '';
  let dmId = '';

  test.beforeAll(async ({ browser }) => {
    desktopCtx = await browser.newContext();
    partnerCtx = await browser.newContext();
    for (const ctx of [desktopCtx, partnerCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    seite = await desktopCtx.newPage();
    partnerPage = await partnerCtx.newPage();
  });

  test.afterAll(async () => {
    await desktopCtx?.close();
    await partnerCtx?.close();
    await mobileCtx?.close();
  });

  test('Vorbereitung: Daten per API, dann Strg+K im Tastatur-Reiter belegen', async () => {
    // Erster Test des Laufs: Vite kompiliert die App hier kalt.
    test.setTimeout(120_000);
    await register(seite, NUTZER);
    await register(partnerPage, PARTNER);
    const nutzerId = await currentUserId(seite);
    const partnerId = await currentUserId(partnerPage);
    await becomeFriends(seite, nutzerId, partnerPage, partnerId);
    dmId = await createDmChannel(seite, partnerId);
    expect(dmId).toMatch(/^\d+$/);

    const guild = await api<{ id: string }>(seite, '/guilds', {
      method: 'POST',
      body: { name: GUILD_NAME }
    });
    guildId = guild.id;
    await api(seite, `/guilds/${guildId}/channels`, {
      method: 'POST',
      body: { name: 'general', type: 0, position: 0 }
    });
    const random = await api<{ id: string }>(seite, `/guilds/${guildId}/channels`, {
      method: 'POST',
      body: { name: 'random', type: 0, position: 1 }
    });
    randomChannelId = random.id;

    // Stores hydratisieren, damit der QuickSwitcher die Kanäle kennt.
    await seite.reload();
    await expect(seite.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });

    // Kürzel belegen: Einstellungen → Tastatur → Aufnahme → Strg+K.
    await seite.getByTestId('user-footer-trigger').click();
    await seite.getByTestId('open-settings').click();
    await expect(seite.getByTestId('settings-dialog')).toBeVisible();
    await seite.getByTestId('settings-tab-keyboard').click();
    const binding = seite.getByTestId('shortcut-binding-nav.quickSwitcher');
    await binding.click();
    await seite.keyboard.press('Control+K');
    await expect(binding).toContainText('Ctrl', { timeout: 7_000 });
    await seite.keyboard.press('Escape');
    await expect(seite.getByTestId('settings-dialog')).toBeHidden();
  });

  test('Strg+K öffnet den QuickSwitcher', async () => {
    await seite.keyboard.press('Control+K');
    await expect(seite.getByTestId('quick-switcher')).toBeVisible({ timeout: 7_000 });
    await expect(seite.getByTestId('quick-switcher-input')).toBeFocused();
  });

  test('Kanalname tippen → Enter navigiert zum Kanal', async () => {
    await seite.getByTestId('quick-switcher-input').fill('rand');
    const ergebnis = seite.getByTestId('quick-switcher-result');
    await expect(ergebnis).toContainText('random', { timeout: 7_000 });
    await seite.keyboard.press('Enter');
    await seite.waitForURL(new RegExp(`/app/guilds/${guildId}/channels/${randomChannelId}`));
    await expect(seite.getByTestId('active-channel-name')).toHaveText('random', {
      timeout: 10_000
    });
    await expect(seite.getByTestId('quick-switcher')).toBeHidden();
  });

  test('ESC schließt den QuickSwitcher', async () => {
    await seite.keyboard.press('Control+K');
    await expect(seite.getByTestId('quick-switcher')).toBeVisible({ timeout: 7_000 });
    await seite.keyboard.press('Escape');
    await expect(seite.getByTestId('quick-switcher')).toBeHidden({ timeout: 7_000 });
  });

  test('Mobil (390×844): Tab-Leiste unten mit genau vier Bereichen', async ({ browser }) => {
    mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'de-DE'
    });
    await mobileCtx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    mobile = await mobileCtx.newPage();
    await login(mobile, NUTZER);

    await mobile.goto('/app/@me');
    await expect(mobile.getByTestId('mobile-tab-bar')).toBeVisible({ timeout: 15_000 });
    for (const id of ['chats', 'rooms', 'friends', 'me']) {
      await expect(mobile.getByTestId(`tab-${id}`)).toBeAttached();
    }
    // Genau vier: kein fünfter Link in der Leiste.
    await expect(
      mobile.getByTestId('mobile-tab-bar').locator('a')
    ).toHaveCount(4);
    await expect(mobile.getByTestId('guild-rail')).toBeHidden();
  });

  test('Chats-Tab: DM-Liste, Suche filtert die Gespräche', async () => {
    await mobile.getByTestId('tab-chats').click();
    await mobile.waitForURL(/\/app\/@me/);
    await expect(mobile.getByTestId('mobile-chats-list')).toBeVisible({ timeout: 15_000 });
    await expect(mobile.getByTestId(`chat-row-${dmId}`)).toBeVisible({ timeout: 15_000 });

    await mobile.getByTestId('chats-input').fill(PARTNER.username);
    // Die Suche ersetzt die Liste — der DM-Treffer erscheint als Personen-
    // zeile, die ungefilterte Liste ist weg.
    await expect(mobile.getByTestId(`search-row-person-${dmId}`)).toBeVisible({
      timeout: 10_000
    });
    await expect(mobile.getByTestId(`chat-row-${dmId}`)).toBeHidden();
  });

  test('Räume-Tab: Community-Kachel der angelegten Community', async () => {
    await mobile.getByTestId('tab-rooms').click();
    await mobile.waitForURL(/\/app\/rooms/);
    await expect(mobile.getByTestId('rooms-page')).toBeVisible({ timeout: 15_000 });
    await expect(mobile.getByTestId(`room-tile-${guildId}`)).toBeVisible({ timeout: 15_000 });
    await expect(mobile.getByTestId(`room-tile-${guildId}`)).toContainText(GUILD_NAME);
  });

  test('Freunde- und Du-Tab: Liste sichtbar, Abschnitte da, Abmelden landet im Login', async () => {
    await mobile.getByTestId('tab-friends').click();
    await mobile.waitForURL(/\/app\/friends/);
    await expect(mobile.getByTestId('friends-page')).toBeVisible({ timeout: 15_000 });

    await mobile.getByTestId('tab-me').click();
    await mobile.waitForURL(/\/app\/me$/);
    await expect(mobile.getByTestId('me-page')).toBeVisible({ timeout: 15_000 });
    // Ein Abschnitt lässt sich öffnen und wieder zurücknehmen.
    await mobile.getByTestId('me-section-appearance').click();
    await mobile.waitForURL(/\/app\/me\/appearance$/);
    await expect(mobile.getByTestId('me-section-page')).toBeVisible();
    await mobile.getByTestId('me-section-back').click();
    await mobile.waitForURL(/\/app\/me$/);
    // Abmelden.
    await mobile.getByTestId('me-sign-out').click();
    await mobile.waitForURL(/\/login/, { timeout: 15_000 });
  });
});
