/**
 * Etappe 5 — Friends-Polish UI tests.
 *
 * Covers:
 *  1. Block-Flow: A blockiert B → B kann A über die Suche nicht mehr finden
 *     (show_in_search false after block, oder simpler: blockierte User tauchen
 *     in der Suche auf aber der "Hinzufügen"-Button fehlt / zeigt "blockiert").
 *     A entblockiert → B taucht wieder als addbar auf.
 *  2. Status-Wechsel: A setzt Status auf DND via StatusPicker → A's myStatus
 *     in der UI zeigt DND-Label.
 *  3. PrivacyPane Save: show_in_search toggle speichert und bleibt nach
 *     Seitenwechsel erhalten.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();

function userFixture(role: 'alpha' | 'beta', salt: string) {
  return {
    username: `${role}_polish_${salt}`,
    email: `${role}_polish_${salt}@dcc-test.example.com`,
    password: 'sup3r-secret-pass'
  };
}

async function register(
  page: Page,
  u: { username: string; email: string; password: string }
) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
}

// -------------------------------------------------------------------------
// Suite 1: Block-Flow
// -------------------------------------------------------------------------
test.describe.serial('Block flow', () => {
  let alphaCtx: BrowserContext;
  let alphaPage: Page;
  let betaCtx: BrowserContext;
  let betaPage: Page;

  const ALPHA = userFixture('alpha', `${ts}_b`);
  const BETA = userFixture('beta', `${ts}_b`);

  test.beforeAll(async ({ browser }) => {
    alphaCtx = await browser.newContext();
    betaCtx = await browser.newContext();
    alphaPage = await alphaCtx.newPage();
    betaPage = await betaCtx.newPage();
  });

  test.afterAll(async () => {
    await alphaCtx.close();
    await betaCtx.close();
  });

  test('register both users', async () => {
    await register(alphaPage, ALPHA);
    await register(betaPage, BETA);
  });

  test('alpha blockiert beta', async () => {
    // Use the REST API directly to block beta (no UI for direct block in search yet).
    const betaId = await betaPage.evaluate(() => {
      const raw = localStorage.getItem('dcc.tokens.access');
      if (!raw) return null;
      const parts = raw.split('.');
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.sub as string;
    });
    expect(betaId).toBeTruthy();

    const result = await alphaPage.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/chat/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return r.status;
    }, betaId!);
    expect([200, 201]).toContain(result);
  });

  test('alpha sucht beta — beta erscheint als blockiert, nicht als addbar', async () => {
    await alphaPage.goto('/app/friends?tab=add');
    await alphaPage.getByTestId('add-friend-input').fill(BETA.username);
    await expect(alphaPage.locator('[data-testid="search-hit"]')).toBeVisible({
      timeout: 5000
    });
    // The search hit should not show the "add" button (blocked).
    await expect(alphaPage.getByTestId('search-hit-add')).toHaveCount(0);
    // Status label should mention "Blockiert".
    await expect(alphaPage.getByTestId('search-hit-status')).toContainText('Blockiert', {
      timeout: 2000
    });
  });

  test('alpha entblockiert beta via REST → beta taucht wieder als addbar auf', async () => {
    const betaId = await betaPage.evaluate(() => {
      const raw = localStorage.getItem('dcc.tokens.access');
      if (!raw) return null;
      const parts = raw.split('.');
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.sub as string;
    });

    const unblockStatus = await alphaPage.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/blocks/${uid}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      return r.status;
    }, betaId!);
    expect([200, 204]).toContain(unblockStatus);

    // Search again.
    await alphaPage.getByTestId('add-friend-input').clear();
    await alphaPage.getByTestId('add-friend-input').fill(BETA.username);
    await expect(alphaPage.locator('[data-testid="search-hit"]')).toBeVisible({
      timeout: 5000
    });
    // Now the add button should be visible again.
    await expect(alphaPage.getByTestId('search-hit-add')).toBeVisible({ timeout: 3000 });
  });
});

// -------------------------------------------------------------------------
// Suite 2: Status-Picker DND
// -------------------------------------------------------------------------
test.describe('Status picker', () => {
  let ctx: BrowserContext;
  let page: Page;

  const USER = userFixture('alpha', `${ts}_s`);

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await register(page, USER);
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  test('StatusPicker is visible in UserFooter', async () => {
    await page.goto('/app');
    await expect(page.getByTestId('status-picker-trigger')).toBeVisible({ timeout: 5000 });
  });

  test('set status to DND via StatusPicker', async () => {
    await page.getByTestId('status-picker-trigger').click();
    await expect(page.getByTestId('status-option-dnd')).toBeVisible({ timeout: 3000 });
    await page.getByTestId('status-option-dnd').click();
    // Trigger label should now show "Nicht stören" or the DND dot.
    await expect(page.getByTestId('status-picker-trigger')).toContainText('Nicht stören', {
      timeout: 3000
    });
  });

  test('set status back to online', async () => {
    await page.getByTestId('status-picker-trigger').click();
    await expect(page.getByTestId('status-option-online')).toBeVisible({ timeout: 3000 });
    await page.getByTestId('status-option-online').click();
    await expect(page.getByTestId('status-picker-trigger')).toContainText('Online', {
      timeout: 3000
    });
  });
});

// -------------------------------------------------------------------------
// Suite 3: PrivacyPane — show_in_search toggle
// -------------------------------------------------------------------------
test.describe('Privacy settings', () => {
  let ctx: BrowserContext;
  let page: Page;

  const USER = userFixture('alpha', `${ts}_p`);

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext();
    page = await ctx.newPage();
    await register(page, USER);
  });

  test.afterAll(async () => {
    await ctx.close();
  });

  test('PrivacyPane is reachable in SettingsDialog', async () => {
    await page.goto('/app');
    // Open settings via user footer.
    await page.getByTestId('user-footer-trigger').click();
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('settings-tab-privacy').click();
    await expect(page.getByTestId('settings-privacy-panel')).toBeVisible({ timeout: 3000 });
  });

  test('toggle show_in_search off and back on', async () => {
    const toggle = page.getByTestId('privacy-show-in-search');
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    // Optimistic — verify via REST that the change was persisted.
    const privacy = await page.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/chat/me/privacy', {
        headers: { Authorization: `Bearer ${token}` }
      });
      return r.json();
    });
    expect((privacy as { show_in_search: boolean }).show_in_search).toBe(false);

    // Restore.
    await toggle.click();
    await expect(toggle).toBeChecked();
  });
});
