/**
 * End-to-end coverage for the Plugin-Admin-Aktivierungs-UI (PR2):
 *
 *   1. User-Settings haben KEINEN Plugin-Tab mehr (Regression-Guard für
 *      die alte per-User-Activation, die in PR2 weg ist).
 *   2. Bootstrap-Admin sieht die AdminPlugins-Section auf /app/admin,
 *      kann ein Plugin in die Allowlist toggeln und das Toggle persistiert.
 *   3. Guild-Admin sieht den `plugins`-Tab im GuildSettingsDialog,
 *      kann ein Allowlist-Plugin pro Guild togglen. `hello` ist disabled.
 *   4. Regulärer User sieht weder den Plugin-Tab im Guild-Settings noch
 *      die AdminPlugins-Section (kein MANAGE_GUILD, kein is_admin).
 *
 * Die is_admin-Promotion + Guild-Erstellung übernimmt der serialisierte
 * Flow analog zu `admin.spec.ts` und `roles.spec.ts`.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
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
const ADMIN = {
  username: `plug_admin_${ts}`,
  email: `plug_admin_${ts}@dcc-test.example.com`,
  password: 'plug-secret-pass'
};
const REGULAR = {
  username: `plug_user_${ts}`,
  email: `plug_user_${ts}@dcc-test.example.com`,
  password: 'plug-secret-pass'
};

async function register(page: Page, u: typeof ADMIN) {
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

test.describe.serial('Plugin-Admin-Aktivierung E2E', () => {
  let adminCtx: BrowserContext;
  let regularCtx: BrowserContext;
  let admin: Page;
  let regular: Page;
  let guildId = '';

  test.beforeAll(async ({ browser }) => {
    adminCtx = await browser.newContext();
    regularCtx = await browser.newContext();
    admin = await adminCtx.newPage();
    regular = await regularCtx.newPage();
  });

  test.afterAll(async () => {
    await adminCtx.close();
    await regularCtx.close();
  });

  test('both users register', async () => {
    // Burn the bootstrap-admin slot so neither test user is auto-promoted.
    const bootCtx = await admin.context().browser()!.newContext();
    const bootPage = await bootCtx.newPage();
    await register(bootPage, {
      username: `bootstrap_plug_${ts}`,
      email: `bootstrap_plug_${ts}@dcc-test.example.com`,
      password: 'plug-secret-pass'
    });
    await bootCtx.close();

    await register(admin, ADMIN);
    await register(regular, REGULAR);
  });

  test('user settings have no plugin tab', async () => {
    // Settings sind über UserFooter (Zahnrad) erreichbar — Tab muss fehlen.
    await regular.getByTestId('user-footer-trigger').click();
    await regular.getByTestId('open-settings').click();
    await expect(regular.getByTestId('settings-dialog')).toBeVisible();
    await expect(regular.getByTestId('settings-tab-plugins')).toHaveCount(0);
    await regular.keyboard.press('Escape');
  });

  test('admin promotion + AdminPlugins section visible', async () => {
    promoteToAdmin(ADMIN.username);
    // Re-login to pick up the admin claim in a fresh JWT.
    await admin.goto('/login');
    await admin.evaluate(() => localStorage.clear());
    await login(admin, ADMIN.username, ADMIN.password);

    // Server-Admin ist jetzt ein direkter Sidebar-Button (kein Menü-Eintrag).
    await admin.getByTestId('open-admin').click();
    await admin.waitForURL(/\/app\/admin/);
    // Plugins leben seit der Admin-Reiter-Struktur (9de03676) im
    // Einstellungen-Tab — erst dorthin wechseln.
    await admin.getByTestId('admin-tab-settings').click();
    await expect(admin.getByTestId('admin-plugins')).toBeVisible();
    // `hello` ist Bootstrap-System-Plugin und immer in der Allowlist.
    await expect(admin.getByTestId('admin-plugin-row-hello')).toBeVisible();
    // Hello-Toggle ist disabled.
    const helloToggle = admin.getByTestId('admin-plugin-toggle-hello');
    await expect(helloToggle).toBeDisabled();
  });

  test('admin allows tamagotchi via allowlist toggle', async () => {
    // Tamagotchi ist per Default NICHT in der Allowlist (Migration 0020
    // seedet nur hello). Toggle muss also OFF starten.
    const row = admin.getByTestId('admin-plugin-row-tamagotchi');
    await expect(row).toBeVisible();
    const toggle = admin.getByTestId('admin-plugin-toggle-tamagotchi');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 });
    // Reload bestätigt Server-Persistenz. Nach dem Reload landet die
    // Admin-Seite auf dem Übersicht-Tab → zurück zu Einstellungen.
    await admin.reload();
    await admin.getByTestId('admin-tab-settings').click();
    await expect(
      admin.getByTestId('admin-plugin-toggle-tamagotchi')
    ).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 });
  });

  test('admin creates a guild for the guild-toggle tests', async () => {
    // Admin hat `allow_guild_creation`-Bypass via is_admin (Backend).
    await admin.goto('/app');
    // Rail-Plus-Menü statt Empty-State: /app landet seit 65a050f7 auf
    // /app/friends, das Empty-State-Panel existiert dort nicht.
    await admin.locator('[data-testid^="guild-create-menu-"]').first().click();
    await admin.getByTestId('guild-create').click();
    await admin.getByTestId('create-guild-name').fill(`Plug Guild ${ts}`);
    await admin.getByTestId('create-guild-submit').click();
    await admin.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    const m = admin.url().match(/\/app\/guilds\/(\d+)/);
    guildId = m![1];
  });

  test('guild-owner sees the plugins tab and can toggle tamagotchi', async () => {
    // Guild-Settings über Context-Menu auf der Guild-Rail öffnen.
    await admin.getByTestId(`guild-${guildId}`).click({ button: 'right' });
    await admin.getByTestId('guild-settings').click();
    await expect(admin.getByTestId('guild-settings-dialog')).toBeVisible();
    await expect(admin.getByTestId('settings-tab-plugins')).toBeVisible();
    await admin.getByTestId('settings-tab-plugins').click();
    await expect(admin.getByTestId('guild-plugins-panel')).toBeVisible();
    // `hello` ist nicht togglebar (Backend 409, UI disabled).
    await expect(
      admin.getByTestId('guild-plugin-toggle-hello')
    ).toBeDisabled();
    // Tamagotchi: erst aus, dann anschalten.
    const tamagotchi = admin.getByTestId('guild-plugin-toggle-tamagotchi');
    await expect(tamagotchi).toHaveAttribute('aria-checked', 'false');
    await tamagotchi.click();
    await expect(tamagotchi).toHaveAttribute('aria-checked', 'true', {
      timeout: 5_000
    });
    await admin.keyboard.press('Escape');
  });

  test('regular user (non-admin, non-member) cannot reach admin panel', async () => {
    // Direkter Navigations-Versuch → Client-Redirect zurück auf /app/@me.
    await regular.goto('/app/admin');
    await regular.waitForURL(/\/app\/@me/);
  });

  test('tamagotchi widget mounts in guild + feed-click updates stat (PR3 roundtrip)', async () => {
    // Mit dem aktivierten Plugin (vorheriger Test) und der Guild von
    // `admin creates a guild` sollte das Widget in der rechten Sidebar
    // der Channel-Page auftauchen. Wir navigieren explizit zur Guild +
    // einem Channel (Owner-Guild → mindestens `general`).
    await admin.goto(`/app/guilds/${guildId}/channels/_`);
    // _-Channel → Auto-Redirect auf den ersten Text-Channel.
    await admin.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);

    // Widget muss sichtbar sein (Plugin ist freigeschaltet auf der Guild).
    const widget = admin.getByTestId('tamagotchi-widget');
    await expect(widget).toBeVisible({ timeout: 5_000 });

    // Hunger-Bar liest sich initial als 80 (Default-Pet, ohne vorherigen
    // Op auf der Guild). Wir lesen den aria-valuenow.
    const hungerBar = admin.getByTestId('tamagotchi-bar-hunger');
    await expect(hungerBar).toHaveAttribute('aria-valuenow', '80', {
      timeout: 5_000
    });

    // Feed klicken → Optimistic UI auf 100 sofort; nach Server-Echo
    // bleibt's bei 100 (Backend cappt bei 100, 80+20=100).
    await admin.getByTestId('tamagotchi-feed').click();
    await expect(hungerBar).toHaveAttribute('aria-valuenow', '100', {
      timeout: 5_000
    });
  });
});
