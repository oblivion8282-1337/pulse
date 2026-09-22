/**
 * T14 — Server-Admin-Panel (/app/admin), Cloud-Modus (Annahme der Suite).
 *
 * Ablauf (serial):
 *   Zwei Konten registrieren → Admin per SQL befördert (is_admin +
 *   is_owner — der Bootstrap-Slot gehört je nach Laufreihenfolge einem
 *   anderen Spec) → Re-Login holt die Claims in den JWT → Panel rendert
 *   mit allen Reitern → Einstellungen: Registrierungsmodus umschalten,
 *   SMTP-Status-Badge, DM-Limits persistieren, Backup-Bereich, Stream-/
 *   Voice-Limits ändern + nach Reload wiederlesen, Plugin-Allowlist
 *   umschalten (und ZURÜCK — sonst leckt der Toggle in plugins.spec) →
 *   Nutzer-Liste + Suche → Communities (Owner-Reiter) → Protokoll zeigt
 *   die getätigten Änderungen → Nicht-Admin bleibt draußen.
 *
 * Alles, was der Test global dreht (DM-Limits, Registrierungsmodus,
 * Allowlist), dreht er am Ende zurück.
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
const ADMIN = {
  username: `ovn_admin_${ts}`,
  email: `ovn_admin_${ts}@dcc-test.example.com`,
  password: 'Admin!2026pass'
};
const REGULAR = {
  username: `ovn_admin_normal_${ts}`,
  email: `ovn_admin_normal_${ts}@dcc-test.example.com`,
  password: 'Admin!2026pass'
};

function promoteToAdmin(username: string) {
  execSync(
    `${CONTAINER_EXEC} exec dcc_night_postgres psql -U dcc -d dcc_test -c "UPDATE auth.users SET is_admin=true, is_owner=true WHERE username='${username}'"`,
    { stdio: 'ignore' }
  );
}

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

async function login(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(identifier);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
}

test.describe.serial('T14 — Server-Admin-Panel', () => {
  test.setTimeout(180_000);

  let admin: Page;
  let regular: Page;
  let guildId = '';

  test.beforeAll(async ({ browser }) => {
    admin = await (await browser.newContext()).newPage();
    regular = await (await browser.newContext()).newPage();
  });

  test.afterAll(async () => {
    await admin?.context().close();
    await regular?.context().close();
  });

  test('Setup: beide Konten, Beförderung per SQL, Re-Login', async () => {
    await register(admin, ADMIN);
    await register(regular, REGULAR);

    promoteToAdmin(ADMIN.username);
    // Der Access-Token trägt die Claims erst nach einem frischen Login.
    await admin.goto('/login');
    await admin.evaluate(() => localStorage.clear());
    await login(admin, ADMIN.username, ADMIN.password);
    await expect(admin.getByTestId('open-admin')).toBeVisible();
  });

  test('Community für den Communities-Reiter anlegen', async () => {
    guildId = await admin.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/chat/guilds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: `Admin Panel Guild ${ts}` })
      });
      const body = await r.json();
      if (!r.ok) throw new Error(`guild create failed: ${r.status}`);
      return body.id as string;
    });
    expect(guildId).toMatch(/^\d+$/);
  });

  test('Panel öffnet, alle Reiter vorhanden', async () => {
    await admin.getByTestId('open-admin').click();
    await admin.waitForURL(/\/app\/admin/);
    await expect(admin.getByTestId('admin-panel')).toBeVisible();
    for (const tab of ['overview', 'settings', 'users', 'communities', 'audit']) {
      await expect(admin.getByTestId(`admin-tab-${tab}`)).toBeVisible();
    }
    await expect(admin.getByTestId('admin-tab-overview')).toHaveClass(/border-primary/);
  });

  test('Übersicht rendert', async () => {
    await admin.getByTestId('admin-tab-overview').click();
    await expect(admin.getByTestId('admin-overview')).toBeVisible();
  });

  test('Einstellungen: Registrierungsmodus umschalten + zurück', async () => {
    await admin.getByTestId('admin-tab-settings').click();
    await expect(admin.getByTestId('admin-registration')).toBeVisible();

    // Frische DB: Modus „open"
    await expect(admin.getByTestId('reg-mode-open')).toBeChecked({ timeout: 7_000 });
    await admin.getByTestId('reg-mode-closed').check();
    await admin.getByTestId('reg-mode-save').click();
    // Reload bestätigt Persistenz (Panel startet auf Übersicht → zurück)
    await admin.reload();
    await admin.getByTestId('admin-tab-settings').click();
    await expect(admin.getByTestId('reg-mode-closed')).toBeChecked({ timeout: 7_000 });

    // Zurück auf open — sonst springt jede spätere Registrierung ab
    await admin.getByTestId('reg-mode-open').check();
    await admin.getByTestId('reg-mode-save').click();
    await expect(admin.getByTestId('reg-mode-open')).toBeChecked({ timeout: 7_000 });
  });

  test('Einstellungen: SMTP-Status-Badge zeigt „Nicht eingerichtet"', async () => {
    await expect(admin.getByTestId('admin-smtp')).toBeVisible();
    await expect(admin.getByTestId('smtp-status-inactive')).toBeVisible();
  });

  test('Einstellungen: DM-Limits persistieren (und zurücksetzen)', async () => {
    const sizeInput = admin.getByTestId('dm-max-size-input');
    await expect(sizeInput).toHaveValue('25', { timeout: 7_000 });
    await sizeInput.fill('40');
    await admin.getByTestId('dm-limits-save').click();
    await admin.reload();
    await admin.getByTestId('admin-tab-settings').click();
    await expect(admin.getByTestId('dm-max-size-input')).toHaveValue('40', { timeout: 7_000 });

    // Sauber zurückstellen — der Wert darf nicht in den nächsten Lauf lecken
    await admin.getByTestId('dm-max-size-input').fill('25');
    await admin.getByTestId('dm-limits-save').click();
    await expect(admin.getByTestId('dm-max-size-input')).toHaveValue('25', { timeout: 7_000 });
  });

  test('Einstellungen: Backup-Bereich rendert', async () => {
    await expect(admin.getByTestId('admin-backup')).toBeVisible();
    // Unkonfiguriert ist der Normalzustand der Testinstanz
    await expect(
      admin
        .getByTestId('admin-backup')
        .locator('[data-testid^=admin-backup-state-]')
        .first()
    ).toBeVisible();
  });

  test('Stream-Limits (HQ) ändern + nach Reload persistiert + zurück', async () => {
    const section = admin.getByTestId('admin-stream-limits');
    await expect(section).toBeVisible();
    const max = section.getByTestId('hq-bitrate-max');
    const original = await max.inputValue();
    const neu = original === '42' ? '43' : '42';
    await max.fill(neu);
    await section.getByTestId('hq-limits-save').click();

    await admin.reload();
    await admin.getByTestId('admin-tab-settings').click();
    await expect(admin.getByTestId('admin-stream-limits').getByTestId('hq-bitrate-max')).toHaveValue(
      neu,
      { timeout: 7_000 }
    );

    // chat_settings kennt keinen Truncate-Reset — hier zurückstellen
    const frisch = admin.getByTestId('admin-stream-limits').getByTestId('hq-bitrate-max');
    await frisch.fill(original);
    await admin.getByTestId('admin-stream-limits').getByTestId('hq-limits-save').click();
    await expect(frisch).toHaveValue(original, { timeout: 7_000 });
  });

  test('Voice-Limits ändern + nach Reload persistiert + zurück', async () => {
    const section = admin.getByTestId('admin-voice-limits');
    await expect(section).toBeVisible();
    const max = section.getByTestId('voice-bitrate-max');
    const original = await max.inputValue();
    const neu = original === '96' ? '95' : '96';
    await max.fill(neu);
    await section.getByTestId('voice-limits-save').click();

    await admin.reload();
    await admin.getByTestId('admin-tab-settings').click();
    await expect(
      admin.getByTestId('admin-voice-limits').getByTestId('voice-bitrate-max')
    ).toHaveValue(neu, { timeout: 7_000 });

    // chat_settings kennt keinen Truncate-Reset — hier zurückstellen
    const frisch = admin.getByTestId('admin-voice-limits').getByTestId('voice-bitrate-max');
    await frisch.fill(original);
    await admin.getByTestId('admin-voice-limits').getByTestId('voice-limits-save').click();
    await expect(frisch).toHaveValue(original, { timeout: 7_000 });
  });

  test('Plugin-Allowlist: Toggle an + nach Reload dran + wieder aus', async () => {
    // tamagotchi ist per Migration NICHT in der Allowlist — Toggle OFF
    const toggle = admin.getByTestId('admin-plugin-toggle-tamagotchi');
    await expect(admin.getByTestId('admin-plugin-row-tamagotchi')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 7_000 });

    await admin.reload();
    await admin.getByTestId('admin-tab-settings').click();
    await expect(admin.getByTestId('admin-plugin-toggle-tamagotchi')).toHaveAttribute(
      'aria-checked',
      'true',
      { timeout: 7_000 }
    );

    // Zurück auf OFF — sonst scheitert plugins.spec an der Allowlist-Annahme
    await admin.getByTestId('admin-plugin-toggle-tamagotchi').click();
    await expect(admin.getByTestId('admin-plugin-toggle-tamagotchi')).toHaveAttribute(
      'aria-checked',
      'false',
      { timeout: 7_000 }
    );
  });

  test('Nutzer-Reiter: Liste + Suche findet das normale Konto', async () => {
    await admin.getByTestId('admin-tab-users').click();
    await expect(admin.getByTestId('admin-users')).toBeVisible();
    await admin.getByTestId('admin-users-search').fill(REGULAR.username);
    const row = admin.getByTestId('admin-user-row').filter({ hasText: REGULAR.username });
    await expect(row).toBeVisible({ timeout: 7_000 });
    await expect(row.getByTestId('badge-admin')).toHaveCount(0);
  });

  test('Communities-Reiter (Owner): Liste zeigt die Test-Community', async () => {
    await admin.getByTestId('admin-tab-communities').click();
    await expect(admin.getByTestId('admin-communities')).toBeVisible();
    await admin.getByTestId('admin-communities-search').fill(`Admin Panel Guild ${ts}`);
    const row = admin
      .getByTestId('admin-community-row')
      .filter({ hasText: `Admin Panel Guild ${ts}` });
    await expect(row).toBeVisible({ timeout: 7_000 });
  });

  test('Protokoll: Einträge zu den gerade gemachten Änderungen', async () => {
    await admin.getByTestId('admin-tab-audit').click();
    await expect(admin.getByTestId('admin-audit-log')).toBeVisible();
    await admin.getByTestId('admin-audit-refresh').click();
    await expect(admin.getByTestId('audit-entry').first()).toBeVisible({ timeout: 7_000 });
  });

  test('Nicht-Admin: kein Eintritt', async () => {
    await expect(regular.getByTestId('open-admin')).toHaveCount(0);
    await regular.goto('/app/admin');
    // Client-Weiche schickt Nicht-Admins zurück
    await expect(regular).not.toHaveURL(/\/app\/admin/);
  });
});
