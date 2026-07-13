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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * psql gegen die E2E-DB (localhost:5434/dcc_test, Passwort aus der
 * Repo-``.env``). Bevorzugt das lokale ``psql``-Binary (``execFileSync``
 * ohne Shell); fehlt es auf der Maschine (ENOENT), fällt der Helper auf
 * das ``docker exec``-Muster von admin.spec/plugins.spec zurück
 * (Compose-Container ``dcc_night_postgres``). Die SQL-Interpolation
 * bleibt auf generierte Usernamen begrenzt.
 */
function testDbSql(sql: string): string {
  const envFile = readFileSync(resolve(ROOT, '.env'), 'utf-8');
  const pgPass = envFile.match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1] ?? '';
  try {
    return execFileSync(
      'psql',
      ['-h', 'localhost', '-p', '5434', '-U', 'dcc', '-d', 'dcc_test', '-tAc', sql],
      {
        encoding: 'utf-8',
        env: { ...process.env, PGPASSWORD: pgPass },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    ).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    const docker = process.env.DOCKER_CMD ?? 'docker';
    return execFileSync(
      docker,
      ['exec', '-i', 'dcc_night_postgres', 'psql', '-U', 'dcc', '-d', 'dcc_test', '-tAc', sql],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
  }
}

const usernameFor = (suffix: string) =>
  `dropbox-e2e-${suffix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;

async function registerAndLogin(page: Page, suffix: string) {
  const uname = usernameFor(suffix);
  await page.goto('/register');
  // Testid-Selektoren wie in chat.spec.ts — das Formular trägt keine
  // name-Attribute (die alten input[name=…]-Selektoren fanden nie etwas).
  await page.getByTestId('reg-username').fill(uname);
  // email-validator rejects special-use TLDs (.test), so use .example.com
  await page.getByTestId('reg-email').fill(`${uname}@dcc-test.example.com`);
  await page.getByTestId('reg-password').fill('CorrectHorseBatteryStaple!2026');
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  // BackupSetupStep-Dialog blockiert sonst Folge-Klicks — best-effort skippen.
  await page
    .getByTestId('backup-onboarding-skip-btn')
    .click({ timeout: 2500 })
    .catch(() => undefined);
  return uname;
}

test.describe('Dropbox / Ablage', () => {
  test('create dropbox channel, upload, trash via DOM, restore via DOM', async ({
    page
  }) => {
    // Confirm/alert dialogs spawned by trashing a file must be accepted.
    page.on('dialog', (d) => void d.accept());

    const uname = await registerAndLogin(page, 'alice');
    // Admin-Flag für die Guild-Erstellung (allow_guild_creation ist default
    // false) — direkt in der E2E-DB, dann frisch einloggen damit es greift.
    testDbSql(`UPDATE auth.users SET is_admin=true WHERE username='${uname}'`);
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByTestId('login-identifier').fill(uname);
    await page.getByTestId('login-password').fill('CorrectHorseBatteryStaple!2026');
    await page.getByTestId('login-submit').click();
    await page.waitForURL(/\/app/);

    // Guild + dropbox channel — Testids wie in chat.spec.ts (frischer User
    // ohne Guilds → Empty-State-Knopf).
    await page.goto('/app');
    // Rail-Plus-Menü statt Empty-State: /app landet seit 65a050f7 auf
    // /app/friends, das Empty-State-Panel existiert dort nicht.
    await page.locator('[data-testid^="guild-create-menu-"]').first().click();
    await page.getByTestId('guild-create').click();
    await page.getByTestId('create-guild-name').fill('Dropbox Test Guild');
    await page.getByTestId('create-guild-submit').click();
    await page.waitForLoadState('networkidle');

    await page.click('[data-testid="channel-create"]');
    await page.click('[data-testid="create-channel-type-dropbox"]');
    await page.fill('[data-testid="create-channel-name"]', 'ablage');
    await page.click('[data-testid="create-channel-submit"]');

    await expect(page.getByTestId('dropbox-view')).toBeVisible();
    // toBeAttached statt toBeVisible: bei leerer Ablage ist der Füllbalken
    // 0 px breit und gilt für Playwright als "hidden".
    await expect(page.getByTestId('dropbox-quota-fill')).toBeAttached();

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

    // Download (Auswahl-ZIP, same-origin → <a download>-Pfad): die Datei kommt
    // an, OHNE dass eine Top-Level-Navigation versucht wird. Regression:
    // window.location.href feuerte beforeunload, worauf livekit-client
    // (disconnectOnPageLeave) die Voice-Verbindung kappte — ein Download warf
    // einen also aus dem Voice-Channel.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__navAttempted = false;
      window.addEventListener('beforeunload', () => {
        (window as unknown as Record<string, unknown>).__navAttempted = true;
      });
    });
    await page.getByTestId(`dropbox-entry-select-${entryId}`).click();
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.getByTestId('dropbox-download-selection').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const navAttempted = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__navAttempted
    );
    expect(navAttempted, 'Download darf keine Navigation (beforeunload) auslösen').toBe(false);
    // Auswahl aufheben, damit der Trash-Schritt den Normal-Zustand sieht.
    await page.getByTestId(`dropbox-entry-select-${entryId}`).click();

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