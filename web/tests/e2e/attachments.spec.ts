/**
 * End-to-end attachment flow against the dev stack + MinIO:
 *
 *   register → create guild → upload PNG via the hidden file input →
 *   wait for upload-done (send-button enables) → send → message renders
 *   with the inline image → click → lightbox opens.
 *
 * The dev MinIO (docker-compose at the repo root) must be reachable on
 * localhost:9000 — globalSetup expects that, same as Postgres/Redis.
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const ALICE = {
  username: `alice_att_${ts}`,
  email: `alice_att_${ts}@dcc-test.example.com`,
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

// 1x1 transparent PNG — small + cheap, MinIO accepts it as image/png.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
  '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae' +
  '426082',
  'hex'
);

test.describe.serial('attachments E2E', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  test('register + create guild', async () => {
    await register(page, ALICE);
    await page.getByTestId('empty-create-guild').click();
    await page.getByTestId('create-guild-choice').click();
    await page.getByTestId('create-guild-name').fill('Attachments-Test');
    await page.getByTestId('create-guild-submit').click();
    await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    await expect(page.getByTestId('active-channel-name')).toHaveText('general');
  });

  test('upload image via file input', async () => {
    // The composer file input is `sr-only` (hidden) but Playwright can drive
    // it directly. setInputFiles fires the change event MessageInput listens
    // for, kicking off the two-phase upload.
    await page.getByTestId('attachment-file-input').setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: TINY_PNG
    });
    // Preview tile shows up.
    await expect(page.getByTestId('attachment-preview')).toBeVisible({ timeout: 5_000 });
    // Send-button is disabled while uploading, then enables when done.
    const sendBtn = page.getByTestId('message-send');
    await expect(sendBtn).toBeEnabled({ timeout: 15_000 });
  });

  test('send message with attachment', async () => {
    await page.getByTestId('message-input').fill('schau mal');
    await page.getByTestId('message-send').click();
    // The text rendered.
    await expect(
      page.locator('[data-testid="message-content"]', { hasText: 'schau mal' })
    ).toBeVisible({ timeout: 5_000 });
    // The image tile rendered.
    await expect(page.getByTestId('attachment-image')).toBeVisible({ timeout: 5_000 });
    // Preview-strip clears after send.
    await expect(page.getByTestId('attachment-preview')).toHaveCount(0);
  });

  test('click image opens lightbox', async () => {
    await page.getByTestId('attachment-image').click();
    await expect(page.getByTestId('lightbox')).toBeVisible({ timeout: 3_000 });
    // ESC closes (bits-ui Dialog default).
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('lightbox')).toHaveCount(0);
  });

  test('empty content with attachment-only is fine', async () => {
    await page.getByTestId('attachment-file-input').setInputFiles({
      name: 'second.png',
      mimeType: 'image/png',
      buffer: TINY_PNG
    });
    await expect(page.getByTestId('message-send')).toBeEnabled({ timeout: 15_000 });
    // No text — still sendable.
    await page.getByTestId('message-send').click();
    // Two image tiles now visible.
    await expect(page.getByTestId('attachment-image')).toHaveCount(2, { timeout: 5_000 });
  });
});
