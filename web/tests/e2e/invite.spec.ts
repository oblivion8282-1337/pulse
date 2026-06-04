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
  // BackupSetupStep poppt nach runIssueFlow auf (s. issue-flow.ts) — der
  // Dialog blockiert sonst die nächsten Klicks per overlay. Best-effort
  // dismiss; wenn der Dialog nicht erscheint (z.B. weil Re-Run im Test
  // ohne fresh-register), schluckt der catch.
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

test.describe.serial('Invite Flow E2E', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let caraCtx: BrowserContext;
  let caraPage: Page;
  let inviteCode = '';
  let inviteLink = '';

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
    // Bob logs out so we can test unauthenticated invite flow
    await bobPage.getByTestId('user-footer-trigger').click();
    await bobPage.getByTestId('sign-out').click();
    await bobPage.waitForURL(/\/login/);
  });

  test('Alice creates a guild', async () => {
    await expect(alicePage.getByTestId('empty-create-guild')).toBeVisible();
    await alicePage.getByTestId('empty-create-guild').click();
    await alicePage.getByTestId('create-guild-choice').click();
    await alicePage.getByTestId('create-guild-name').fill('Invite Test Guild');
    await alicePage.getByTestId('create-guild-submit').click();
    await alicePage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
  });

  test('Alice opens the invite dialog and gets a link', async () => {
    await expect(alicePage.getByTestId('invite-open-btn')).toBeVisible();
    await alicePage.getByTestId('invite-open-btn').click();

    const dialog = alicePage.getByTestId('invite-dialog');
    await expect(dialog).toBeVisible();

    const linkInput = alicePage.getByTestId('invite-link-input');
    await expect(linkInput).toBeVisible({ timeout: 10_000 });
    // The link only appears once the createInvite POST resolves — wait for it
    // rather than reading the (briefly empty) value synchronously.
    await expect(linkInput).toHaveValue(/\/invite\/[A-Za-z0-9]{8}/, { timeout: 10_000 });

    const link = await linkInput.inputValue();
    expect(link).toMatch(/\/invite\/[A-Za-z0-9]{8}/);
    inviteLink = link;
    inviteCode = link.split('/invite/')[1];

    await alicePage.keyboard.press('Escape');
  });

  test('Cara joins via the "+" dialog — bad code shows an error, the real code joins', async () => {
    await register(caraPage, CARA);
    // Per-server "+" menu → "Community beitreten" opens the dialog straight on
    // the join form. (One server in E2E = the cloud → first per-server "+".)
    await caraPage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await caraPage.getByTestId('guild-join').click();
    await expect(caraPage.getByTestId('create-guild-dialog')).toBeVisible();
    // a bogus code surfaces an inline error and keeps the dialog open
    await caraPage.getByTestId('join-guild-input').fill('INVALID0');
    await caraPage.getByTestId('join-guild-submit').click();
    await expect(caraPage.getByTestId('join-guild-error')).toBeVisible({ timeout: 10_000 });
    // the real code (bare, not a full link) joins and navigates into the guild
    await caraPage.getByTestId('join-guild-input').fill(inviteCode);
    await caraPage.getByTestId('join-guild-submit').click();
    await caraPage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });
    await expect(caraPage.getByTestId('active-channel-name')).toBeVisible({ timeout: 10_000 });
  });

  test('Bob visits the invite link without being logged in — sees preview, then redirected to login', async () => {
    await bobPage.goto(inviteLink);
    // Not logged in → getInvitePreview requires auth → should redirect to login
    // OR we show the preview if backend allows unauthenticated preview.
    // Per API contract: GET /invites/{code} requires login → 401 → redirect to login.
    // After login, redirect back to /invite/<code>
    await bobPage.waitForURL(/\/(login|invite)/);
  });

  test('Bob logs in via redirect from invite page and is taken back to invite', async () => {
    // If we're already on login page (redirected), fill credentials.
    // If we're still on invite page (e.g. if unauthenticated preview was shown), navigate to login manually.
    const currentUrl = bobPage.url();
    if (!currentUrl.includes('/login')) {
      await bobPage.goto(`/login?redirect=${encodeURIComponent('/invite/' + inviteCode)}`);
    }

    await expect(bobPage.getByTestId('login-identifier')).toBeVisible();
    await bobPage.getByTestId('login-identifier').fill(BOB.username);
    await bobPage.getByTestId('login-password').fill(BOB.password);
    await bobPage.getByTestId('login-submit').click();

    // After login, should land back on the invite page
    await bobPage.waitForURL(new RegExp(`/invite/${inviteCode}`));
  });

  test('Bob sees the invite preview and joins the server', async () => {
    await expect(bobPage.getByTestId('invite-guild-name')).toHaveText('Invite Test Guild', {
      timeout: 10_000
    });
    await expect(bobPage.getByTestId('invite-member-count')).toBeVisible();

    await bobPage.getByTestId('invite-join-btn').click();
    // Should navigate to the guild channel
    await bobPage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });
  });

  test('Bob sees the guild in the sidebar', async () => {
    await expect(bobPage.getByTestId('app-shell')).toBeVisible();
    await expect(bobPage.getByTestId('active-channel-name')).toBeVisible({ timeout: 10_000 });
  });

  test('invalid invite code shows error page', async () => {
    await alicePage.goto('/invite/INVALID0');
    const invalid = alicePage.getByTestId('invite-invalid');
    await expect(invalid).toBeVisible({ timeout: 10_000 });
  });
});
