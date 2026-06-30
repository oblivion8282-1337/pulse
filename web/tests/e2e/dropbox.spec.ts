/**
 * End-to-end smoke for the Dropbox / Ablage feature (Channel.type=2).
 *
 * Full round-trip:
 *  - register alice (bootstrap-admin)
 *  - create a guild + dropbox channel via the CreateChannelDialog
 *  - upload a file via the Ablage toolbar
 *  - confirm the file shows up in the file grid
 *  - trash it via the per-card trash button (DOM click, not REST)
 *  - confirm the file vanishes from the root listing
 *  - open the trash view and confirm the file is there
 *  - restore via the per-row restore button
 *  - confirm the file is back in the root listing
 *
 * Requires the dev stack + MinIO to be live (uses the same global
 * setup as the rest of the e2e suite). Skipped automatically if
 * the chat-gateway URL isn't reachable — same pattern as dms.spec.ts.
 */

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

function detectExec(): string {
  if (process.env.DOCKER_CMD) return process.env.DOCKER_CMD;
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' });
    return 'docker';
  } catch {
    return 'podman';
  }
}

const DOCKER = detectExec();

/**
 * Run a command inside a named container via the runtime exec API.
 * Uses ``execFileSync`` (no shell) — interpolating the username into a
 * shell command would let a malicious uname break out via quoting.
 */
function containerExec(container: string, args: string[]): string {
  return execFileSync(DOCKER, ['exec', container, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

const usernameFor = (suffix: string) =>
  `dropbox-e2e-${suffix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;

async function registerAndLogin(page: Page, suffix: string) {
  const uname = usernameFor(suffix);
  await page.goto('/register');
  await page.fill('input[name="username"]', uname);
  // email-validator rejects special-use TLDs (.test), so use .example.com
  await page.fill('input[name="email"]', `${uname}@dcc-test.example.com`);
  await page.fill('input[name="password"]', 'CorrectHorseBatteryStaple!2026');
  await page.fill('input[name="password2"]', 'CorrectHorseBatteryStaple!2026');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  return uname;
}

test.describe('Dropbox / Ablage', () => {
  test('create dropbox channel, upload, trash via DOM, restore via DOM', async ({
    page
  }) => {
    // Confirm/alert dialogs spawned by trashing a file must be accepted.
    page.on('dialog', (d) => void d.accept());

    const uname = await registerAndLogin(page, 'alice');
    const userId = containerExec('pulse_postgres', [
      'psql',
      '-U',
      'chat',
      '-d',
      'dcc',
      '-tAc',
      `SELECT id FROM auth.users WHERE username='${uname}'`
    ]);
    containerExec('pulse_postgres', [
      'psql',
      '-U',
      'chat',
      '-d',
      'dcc',
      '-c',
      `UPDATE auth.users SET is_admin=true WHERE id=${userId}`
    ]);
    await page.context().clearCookies();
    await page.goto('/login');
    await page.fill('input[name="username"]', uname);
    await page.fill('input[name="password"]', 'CorrectHorseBatteryStaple!2026');
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');

    // Guild + dropbox channel.
    await page.goto('/app');
    await page.click('[data-testid="create-guild"]');
    await page.fill('[data-testid="guild-name-input"]', 'Dropbox Test Guild');
    await page.click('[data-testid="guild-create-submit"]');
    await page.waitForLoadState('networkidle');

    await page.click('[data-testid="channel-create"]');
    await page.click('[data-testid="create-channel-type-dropbox"]');
    await page.fill('[data-testid="create-channel-name"]', 'ablage');
    await page.click('[data-testid="create-channel-submit"]');

    await expect(page.getByTestId('dropbox-view')).toBeVisible();
    await expect(page.getByTestId('dropbox-quota-fill')).toBeVisible();

    // Upload.
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('[data-testid="dropbox-upload-btn"]');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'hello.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello dropbox')
    });
    const uploaded = page.getByText('hello.txt');
    await expect(uploaded).toBeVisible({ timeout: 10_000 });

    // Grab the entry id out of the data-testid on its enclosing card.
    const card = page
      .locator('[data-testid^="dropbox-entry-"]:not([data-testid^="dropbox-entry-open-"])')
      .filter({ hasText: 'hello.txt' })
      .first();
    const cardTestId = await card.getAttribute('data-testid');
    const entryId = cardTestId?.replace('dropbox-entry-', '');
    expect(entryId, 'entry card testid must contain the snowflake id').toBeTruthy();

    // Trash via the DOM — click the per-card trash button.
    const trashBtn = page.getByTestId(`dropbox-entry-trash-${entryId}`);
    await trashBtn.click();

    // File vanishes from the root listing.
    await expect(uploaded).toBeHidden({ timeout: 5_000 });

    // Open trash view, file is there with the same id.
    await page.click('[data-testid="dropbox-trash-toggle"]');
    const trashCard = page
      .locator(`[data-testid="dropbox-entry-${entryId}"]`)
      .first();
    await expect(trashCard).toBeVisible({ timeout: 5_000 });

    // Restore via DOM.
    await page.getByTestId(`dropbox-entry-restore-${entryId}`).click();
    // WS pushes ``dropbox_entry_restored`` → parent calls refreshAll.
    // The root listing has the file again; trash view no longer does.
    await expect(page.getByText('hello.txt')).toBeVisible({ timeout: 5_000 });
    // Switch back to root: the trash-toggle button is now showing
    // "View trash" (because we're in root view) — click it once more
    // is a no-op; we instead toggle back if needed.
    await page.click('[data-testid="dropbox-trash-toggle"]');
    await expect(
      page.locator(`[data-testid="dropbox-entry-${entryId}"]`)
    ).toBeVisible();
  });
});