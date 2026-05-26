/**
 * E2E coverage for the account-recovery UI surface.
 *
 *  - /forgot-password: form submits + transitions to the success view. The
 *    backend always returns 204 here (enumeration prevention) even for
 *    unknown identifiers, so we use a definitely-unknown one and assert the
 *    "Prüf dein Postfach" panel renders. No SMTP needed.
 *  - /reset-password/[token]: client-side validation (password mismatch +
 *    minimum length) — purely UI. No backend round-trip.
 *  - /login: the "Passwort vergessen?" link routes to /forgot-password.
 *  - /verify-email/[token]: with a clearly bogus token the page surfaces the
 *    error state. Doesn't require any verified seed user.
 *
 * 2FA login flow can't be exercised without a TOTP-seeded user — those
 * scenarios are deliberately left to a backend integration test that can
 * seed `totp_enabled=true`. We at least guard the route shape exists.
 */

import { test, expect } from '@playwright/test';

test.describe('account recovery flows', () => {
  test('forgot-password form shows enumeration-safe success view', async ({ page }) => {
    await page.goto('/forgot-password');
    await expect(page.getByTestId('forgot-identifier')).toBeVisible();

    await page.getByTestId('forgot-identifier').fill('does-not-exist@dcc-test.example.com');
    await page.getByTestId('forgot-submit').click();

    // Backend returns 204 → success panel appears.
    await expect(page.getByTestId('forgot-success')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('forgot-back-to-login')).toBeVisible();
  });

  test('login page links to /forgot-password', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('login-forgot')).toHaveAttribute('href', '/forgot-password');
    await page.getByTestId('login-forgot').click();
    await page.waitForURL(/\/forgot-password/);
    await expect(page.getByTestId('forgot-identifier')).toBeVisible();
  });

  test('reset-password rejects mismatched passwords client-side', async ({ page }) => {
    await page.goto('/reset-password/anything-here');
    await page.getByTestId('reset-password').fill('hunter2hunter2');
    await page.getByTestId('reset-confirm').fill('differentpassword');
    await page.getByTestId('reset-submit').click();
    await expect(page.getByTestId('reset-error')).toContainText(
      /stimmen nicht überein/i
    );
  });

  test('reset-password rejects too-short passwords client-side', async ({ page }) => {
    await page.goto('/reset-password/anything-here');
    await page.getByTestId('reset-password').fill('short');
    await page.getByTestId('reset-confirm').fill('short');
    // The inputs carry HTML5 `minlength=8`, which blocks the submit before our
    // onsubmit handler runs — but the JS-side length check is what's under
    // test here. Disable native validation on the <form>: `locator.evaluate`
    // auto-waits for the form (the SPA mounts it after `goto` resolves), and
    // `noValidate` on the stable form node survives the `bind:value`
    // re-renders that `fill` triggers.
    await page.locator('form').evaluate((form: HTMLFormElement) => {
      form.noValidate = true;
    });
    await page.getByTestId('reset-submit').click();
    await expect(page.getByTestId('reset-error')).toContainText(
      /mindestens 8 Zeichen/i
    );
  });

  test('verify-email surfaces the error state on a bogus token', async ({ page }) => {
    await page.goto('/verify-email/this-is-not-a-real-token');
    // Card renders, error state shows up after the onMount fetch resolves.
    await expect(page.getByTestId('verify-email-card')).toBeVisible();
    await expect(page.getByTestId('verify-email-error')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('active sessions UI', () => {
  // The /sessions endpoints may not exist in the auth-service yet at the time
  // this UI lands (parallel backend work). We mock them at the network layer
  // so the test is independent of the backend contract — only verifying the
  // frontend renders + dispatches the right requests.
  test('settings → security tab lists sessions and revokes one', async ({ page }) => {
    const ts = Date.now();
    const username = `sess_${ts}`;
    const email = `${username}@dcc-test.example.com`;
    const password = 'sup3r-secret-pass';

    // Two mock sessions: the current one (with badge) + one stale.
    const STALE_ID = '900000000000000001';
    const CURRENT_ID = '900000000000000002';
    let listCalls = 0;
    let revokedSingleId: string | null = null;

    await page.route('**/api/auth/sessions', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        listCalls++;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: CURRENT_ID,
              user_agent:
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              created_at: new Date(Date.now() - 60 * 1000).toISOString(),
              last_used_at: new Date(Date.now() - 5 * 1000).toISOString(),
              is_current: true,
              ip_hash_prefix: 'a1b2c3d4'
            },
            {
              id: STALE_ID,
              user_agent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1',
              created_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
              last_used_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
              is_current: false,
              ip_hash_prefix: 'e5f6a7b8'
            }
          ])
        });
        return;
      }
      // DELETE all-but-current
      if (method === 'DELETE') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ revoked_count: 1 })
        });
        return;
      }
      await route.continue();
    });

    await page.route(`**/api/auth/sessions/${STALE_ID}`, async (route) => {
      if (route.request().method() === 'DELETE') {
        revokedSingleId = STALE_ID;
        await route.fulfill({ status: 204 });
        return;
      }
      await route.continue();
    });

    // Register a real user so the app reaches /app and the settings dialog
    // is mountable. We're not testing the auth flow here — just need a
    // logged-in shell.
    await page.goto('/register');
    await page.getByTestId('reg-username').fill(username);
    await page.getByTestId('reg-email').fill(email);
    await page.getByTestId('reg-password').fill(password);
    await page.getByTestId('reg-submit').click();
    await page.waitForURL(/\/app/);
    // BackupSetupStep poppt nach runIssueFlow auf (s. issue-flow.ts) — der
    // Dialog blockiert sonst die nächsten Klicks per Overlay. Best-effort
    // dismiss; wenn der Dialog nicht erscheint, schluckt der catch.
    await page
      .locator('[data-testid=backup-onboarding-skip-btn]')
      .click({ timeout: 2500 })
      .catch(() => undefined);

    // Open user-footer menu → Settings → Security tab. `open-settings` is a
    // dropdown item, so the footer trigger has to be opened first.
    await page.getByTestId('user-footer-trigger').click();
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.getByTestId('settings-tab-security').click();

    // Sessions section appears + both rows rendered.
    const section = page.getByTestId('sessions-section');
    await expect(section).toBeVisible();
    await expect(page.getByTestId('sessions-list')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('session-row')).toHaveCount(2);

    // The current-session row carries the badge + no revoke button.
    const currentRow = page.locator(`[data-session-id="${CURRENT_ID}"]`);
    await expect(currentRow.getByTestId('session-current-badge')).toBeVisible();
    await expect(currentRow.getByTestId('session-revoke')).toHaveCount(0);

    // The stale row exposes the revoke button — click + assert request fired.
    const staleRow = page.locator(`[data-session-id="${STALE_ID}"]`);
    await staleRow.getByTestId('session-revoke').click();
    await expect(staleRow).toHaveCount(0, { timeout: 3_000 });
    expect(revokedSingleId).toBe(STALE_ID);
    expect(listCalls).toBeGreaterThan(0);
  });
});
