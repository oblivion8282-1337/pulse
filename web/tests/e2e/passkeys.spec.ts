/**
 * E2E coverage for the WebAuthn / passkey UI surface.
 *
 * The actual `navigator.credentials` ceremony can't run reliably in CI (it
 * needs a virtual authenticator + an rpId that matches the test origin), so
 * — exactly like the active-sessions test above it — we mock the
 * `/api/auth/webauthn/*` endpoints at the network layer and assert the
 * frontend renders + dispatches correctly. The real ceremony + crypto path
 * is covered by the backend suite (`services/auth/tests/test_webauthn.py`).
 */

import { test, expect } from '@playwright/test';

type Cred = {
  id: string;
  name: string;
  aaguid: string | null;
  transports: string[] | null;
  created_at: string;
  last_used_at: string | null;
};

async function registerAndOpenSecurity(page: import('@playwright/test').Page) {
  const ts = Date.now();
  const username = `pk_${ts}`;
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(username);
  await page.getByTestId('reg-email').fill(`${username}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill('sup3r-secret-pass');
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

  // Settings lives behind the user-footer dropdown — open the trigger first.
  await page.getByTestId('user-footer-trigger').click();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-tab-security').click();
}

test.describe('passkey settings UI', () => {
  test('security tab shows empty passkeys section + opens the add dialog', async ({ page }) => {
    await page.route('**/api/auth/webauthn/credentials', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return;
      }
      await route.continue();
    });

    await registerAndOpenSecurity(page);

    const section = page.getByTestId('passkeys-section');
    await expect(section).toBeVisible();
    await expect(section).toContainText(/Noch kein Passkey/i);

    await page.getByTestId('passkeys-add').click();
    await expect(page.getByTestId('passkey-add-dialog')).toBeVisible();
    await expect(page.getByTestId('passkey-name-input')).toBeVisible();
  });

  test('security tab lists passkeys and deletes one', async ({ page }) => {
    const KEEP_ID = '800000000000000001';
    const DROP_ID = '800000000000000002';
    let deletedId: string | null = null;

    const creds: Cred[] = [
      {
        id: KEEP_ID,
        name: 'MacBook Touch ID',
        aaguid: null,
        transports: ['internal'],
        created_at: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString(),
        last_used_at: new Date(Date.now() - 3600 * 1000).toISOString()
      },
      {
        id: DROP_ID,
        name: 'Alter YubiKey',
        aaguid: null,
        transports: ['usb'],
        created_at: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(),
        last_used_at: null
      }
    ];

    await page.route('**/api/auth/webauthn/credentials', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(creds)
        });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/auth/webauthn/credentials/${DROP_ID}`, async (route) => {
      if (route.request().method() === 'DELETE') {
        deletedId = DROP_ID;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'ok' })
        });
        return;
      }
      await route.continue();
    });

    await registerAndOpenSecurity(page);

    await expect(page.getByTestId('passkey-row')).toHaveCount(2);
    const dropRow = page.getByTestId('passkey-row').filter({ hasText: 'Alter YubiKey' });

    // Two-tap delete: first tap reveals the confirm button.
    await dropRow.getByTestId('passkey-delete').click();
    await dropRow.getByTestId('passkey-delete-confirm').click();

    await expect(page.getByTestId('passkey-row')).toHaveCount(1, { timeout: 3_000 });
    expect(deletedId).toBe(DROP_ID);
  });
});

test.describe('passkey login UI', () => {
  test('login page offers the passwordless passkey button', async ({ page }) => {
    await page.goto('/login');
    // Chromium ships the WebAuthn API, so `webauthnSupported()` is true and
    // the button renders.
    await expect(page.getByTestId('login-passkey')).toBeVisible();
  });
});
