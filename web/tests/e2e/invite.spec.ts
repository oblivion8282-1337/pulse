import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `inv_alice_${ts}`,
  email: `inv_alice_${ts}@dcc-test.example.com`,
  password: 'inv-secret-pass'
};
const BOB = {
  username: `inv_bob_${ts}`,
  email: `inv_bob_${ts}@dcc-test.example.com`,
  password: 'inv-secret-pass'
};
const CARA = {
  username: `inv_cara_${ts}`,
  email: `inv_cara_${ts}@dcc-test.example.com`,
  password: 'inv-secret-pass'
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

async function login(page: Page, u: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
}

/** Erstellt einen Invite-Code per API auf der Seite von `page` (hat Token im localStorage). */
async function createInviteCode(page: Page, guildId: string): Promise<string> {
  const result = await page.evaluate(async (gid: string) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch(`/api/chat/guilds/${gid}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ max_uses: 1, expires_in_seconds: 86400 })
    });
    if (!r.ok) throw new Error(`createInvite failed: ${r.status}`);
    const data = await r.json() as { code: string };
    return data.code;
  }, guildId);
  return result;
}

test.describe.serial('Invite Flow E2E', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let caraCtx: BrowserContext;
  let caraPage: Page;
  let inviteCode = '';
  let guildId = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    caraCtx = await browser.newContext();
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
    caraPage = await caraCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
    await caraCtx.close();
  });

  test('Alice and Bob register', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    await bobPage.getByTestId('user-footer-trigger').click();
    await bobPage.getByTestId('sign-out').click();
    await bobPage.waitForURL(/\/login/);
  });

  test('Alice creates a guild', async () => {
    // Rail-Plus-Menü statt Empty-State: /app landet seit 65a050f7 auf
    // /app/friends, das Empty-State-Panel existiert dort nicht.
    await alicePage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await alicePage.getByTestId('guild-create').click();
    await alicePage.getByTestId('create-guild-name').fill('Invite Test Guild');
    await alicePage.getByTestId('create-guild-submit').click();
    await alicePage.waitForURL(/\/app\/guilds\/(\d+)\/channels\/\d+/);
    const m = alicePage.url().match(/\/app\/guilds\/(\d+)/);
    guildId = m![1];
  });

  test('Alice opens the invite dialog (friend picker visible)', async () => {
    await expect(alicePage.getByTestId('invite-open-btn')).toBeVisible();
    await alicePage.getByTestId('invite-open-btn').click();
    const dialog = alicePage.getByTestId('invite-dialog');
    await expect(dialog).toBeVisible();
    // Neuer Dialog zeigt den Friend-Picker
    await expect(alicePage.getByTestId('invite-friend-picker')).toBeVisible();
    await alicePage.keyboard.press('Escape');
  });

  test('Alice creates an invite code via API and shares it with Cara via URL', async () => {
    inviteCode = await createInviteCode(alicePage, guildId);
    expect(inviteCode).toMatch(/^[A-Za-z0-9]{6,}$/);
  });

  test('Cara joins via the "+" dialog — bad code shows an error, the real code joins', async () => {
    await register(caraPage, CARA);
    await caraPage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await caraPage.getByTestId('guild-join').click();
    await expect(caraPage.getByTestId('create-guild-dialog')).toBeVisible();
    await caraPage.getByTestId('join-guild-input').fill('INVALID0');
    await caraPage.getByTestId('join-guild-submit').click();
    await expect(caraPage.getByTestId('join-guild-error')).toBeVisible({ timeout: 10_000 });
    await caraPage.getByTestId('join-guild-input').fill(inviteCode);
    await caraPage.getByTestId('join-guild-submit').click();
    await caraPage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });
    await expect(caraPage.getByTestId('active-channel-name')).toBeVisible({ timeout: 10_000 });
  });

  test('Bob logs in and joins via bare code', async () => {
    await login(bobPage, BOB);
    // Neuen Invite-Code erstellen (der erste war single-use und von Cara verbraucht)
    const bobCode = await createInviteCode(alicePage, guildId);
    await bobPage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await bobPage.getByTestId('guild-join').click();
    await bobPage.getByTestId('join-guild-input').fill(bobCode);
    await bobPage.getByTestId('join-guild-submit').click();
    await bobPage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });
  });

  test('Bob sees the guild in the sidebar', async () => {
    await expect(bobPage.getByTestId('app-shell')).toBeVisible();
    await expect(bobPage.getByTestId('active-channel-name')).toBeVisible({ timeout: 10_000 });
  });
});
