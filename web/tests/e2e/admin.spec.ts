/**
 * End-to-end admin-panel flow:
 *   register alice + bob → flip alice's is_admin via SQL bootstrap →
 *   alice re-logs in so the JWT carries the admin claim → opens the
 *   UserFooter dropdown, navigates to /app/admin, checks all five
 *   sections render → changes DM-limits and verifies it persists →
 *   toggles bob's disabled flag → audit-log shows the entry.
 *
 * The is_admin promotion uses the container runtime auto-detected at
 * setup time (docker or podman). ``$DOCKER_CMD`` overrides it.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

function detectExec(): string {
  if (process.env.DOCKER_CMD) return process.env.DOCKER_CMD;
  try {
    execSync('docker --version', { stdio: 'ignore' });
    return 'docker';
  } catch {
    return 'podman';
  }
}
const CONTAINER_EXEC = detectExec();

const ts = Date.now();
const ALICE = {
  username: `admin_${ts}`,
  email: `admin_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `regular_${ts}`,
  email: `regular_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: typeof ALICE) {
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

async function login(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(identifier);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
}

function promoteToAdmin(username: string) {
  execSync(
    `${CONTAINER_EXEC} exec -i dcc_night_postgres psql -U dcc -d dcc_test -c "UPDATE auth.users SET is_admin=true WHERE username='${username}'"`,
    { stdio: 'ignore' }
  );
}

test.describe.serial('admin-panel E2E', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  test('register both users', async () => {
    // Burn the bootstrap-admin slot first: on a freshly-truncated dcc_test
    // the FIRST registrant becomes a global admin (COUNT(*)==1 rule). Without
    // this throwaway user, ALICE would arrive as an admin and the "non-admin"
    // assertion below — plus the explicit promotion test — would be moot.
    const bootCtx = await page.context().browser()!.newContext();
    const bootPage = await bootCtx.newPage();
    await register(bootPage, {
      username: `bootstrap_${ts}`,
      email: `bootstrap_${ts}@dcc-test.example.com`,
      password: 'sup3r-secret-pass'
    });
    await bootCtx.close();

    await register(page, ALICE);
    // Bob registers in the same context — easier than juggling two pages
    // for this flow; we don't need to act as Bob, just to have him exist.
    const bobCtx = await page.context().browser()!.newContext();
    const bobPage = await bobCtx.newPage();
    await register(bobPage, BOB);
    await bobCtx.close();
  });

  test('non-admin does not see the Server-Admin entry', async () => {
    await page.getByTestId('user-footer-trigger').click();
    // The "Server-Admin" item must NOT be in the dropdown for a regular user.
    await expect(page.getByTestId('open-admin')).toHaveCount(0);
    // Close the dropdown by pressing Escape.
    await page.keyboard.press('Escape');
  });

  test('admin promotion makes the entry appear after re-login', async () => {
    promoteToAdmin(ALICE.username);
    // The current access-token was issued *before* the flip — to pick up
    // `admin: true` we need a fresh token (i.e. log in again).
    await page.goto('/login');
    await page.evaluate(() => localStorage.clear());
    await login(page, ALICE.username, ALICE.password);

    await page.getByTestId('user-footer-trigger').click();
    await expect(page.getByTestId('open-admin')).toBeVisible();
  });

  test('navigating opens the panel with the cloud-admin sections', async () => {
    await page.getByTestId('open-admin').click();
    await page.waitForURL(/\/app\/admin/);
    await expect(page.getByTestId('admin-panel')).toBeVisible();
    for (const id of [
      'admin-overview',
      'admin-attachments',
      'admin-registration',
      'admin-smtp',
      'admin-instances',
      'admin-complaints',
      'admin-users',
      'admin-audit-log'
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test('a submitted abuse report appears in the complaints section', async () => {
    // Public endpoint, no auth — file a complaint straight through the proxy.
    const resp = await page.request.post('/api/auth/reports', {
      data: {
        body: 'E2E complaint: this content needs a moderator review.',
        target_url: `https://e2e-abuse-${ts}.example.com/post`
      }
    });
    expect(resp.status()).toBe(201);

    await page.reload();
    // The "new" tab is the default; the freshly-filed report must show up.
    await expect(page.getByTestId('complaints-new-badge')).toBeVisible({ timeout: 5_000 });
    // Scope to the section so the prefix can't catch the portal dialogs.
    const card = page
      .getByTestId('admin-complaints')
      .locator('[data-testid^="complaint-"]')
      .first();
    await expect(card).toBeVisible();

    // Resolve it and confirm it leaves the "new" list.
    await card.getByText('Als erledigt markieren').click();
    const dialog = page.getByTestId('complaint-resolve-dialog');
    await dialog.getByRole('textbox').fill('Handled in E2E.');
    await dialog.getByText('Erledigt', { exact: true }).click();
    await expect(page.getByTestId('admin-complaints').locator('[data-testid^="complaint-"]')).toHaveCount(
      0,
      { timeout: 5_000 }
    );
  });

  test('SMTP-Config PATCH flips the status badge to "Aktiv"', async () => {
    // Fresh DB: smtp_settings starts unconfigured → "Nicht eingerichtet".
    await expect(page.getByTestId('smtp-status-inactive')).toBeVisible();
    // Pick the Custom preset so host/port stay editable, fill creds.
    await page.getByTestId('smtp-provider').selectOption('custom');
    await page.getByTestId('smtp-host').fill('smtp.test.example');
    await page.getByTestId('smtp-from').fill('noreply@test.example');
    await page.getByTestId('smtp-pass').fill('secret-not-tested');
    await page.getByTestId('smtp-save').click();
    // After save the row has host+from_email → configured=true.
    await expect(page.getByTestId('smtp-status-configured')).toBeVisible({
      timeout: 5_000
    });
    // Revert to unconfigured. A configured SMTP singleton activates the
    // email-verification gate — without this revert every register flow in
    // every test file after admin.spec bounces to /verify-email-required.
    // Doubles as coverage of the un-configure path (configured → false).
    await page.getByTestId('smtp-host').fill('');
    await page.getByTestId('smtp-save').click();
    await expect(page.getByTestId('smtp-status-inactive')).toBeVisible({
      timeout: 5_000
    });
  });

  test('DM-limits PATCH persists', async () => {
    const sizeInput = page.getByTestId('dm-max-size-input');
    await expect(sizeInput).toHaveValue('25', { timeout: 5_000 });
    await sizeInput.fill('40');
    await page.getByTestId('dm-limits-save').click();
    // Toast confirms; refresh and verify the new value.
    await page.reload();
    await expect(page.getByTestId('dm-max-size-input')).toHaveValue('40', { timeout: 5_000 });
  });

  test('audit-log shows the DM-limits change', async () => {
    // The merged log fetches both auth+chat. After our PATCH there must
    // be at least one entry mentioning the dm_limits action.
    await page.getByTestId('admin-audit-refresh').click();
    await expect(
      page.locator('[data-testid="audit-entry"]', { hasText: 'DM-Limits' })
    ).toHaveCount(1, { timeout: 5_000 });
  });
});
