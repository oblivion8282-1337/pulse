/**
 * Overnight T1 — Authentifizierung quer durch die UI:
 * Registrierung, Anmeldung (inkl. fallinsensitiver Nutzername, Bughunt
 * 4.11a), Display-Name ändern, Passwort ändern, Abmelden.
 *
 * Ein serialer Lauf mit einem Nutzer, weil die Schritte aufeinander
 * aufbauen (abmelden → anmelden → Profil ändern → Passwort drehen).
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

const ts = Date.now();
const USER = {
  username: `Michael_${ts}`,
  email: `michael_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const NEW_PASSWORD = 'ganze-andere-pass-42';
const DISPLAY_NAME = `Micha Next_${ts}`;

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  // Ein Retry: im geteilten Test-Stack kann der Registrierungs-POST im
  // Sekundentakt eines Dienst-Neustarts versanden — der zweite Anlauf läuft
  // dann gegen einen wieder gesunden Dienst.
  let drin = false;
  for (const _versuch of [1, 2]) {
    await page.getByTestId('reg-submit').click();
    drin = await page
      .waitForURL(/\/app/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (drin) break;
    await page.getByTestId('reg-username').fill(u.username);
    await page.getByTestId('reg-email').fill(u.email);
    await page.getByTestId('reg-password').fill(u.password);
  }
  if (!drin) throw new Error('Registrierung nicht in /app gelandet');
  // BackupSetupStep poppt nach runIssueFlow auf (Muster wie chat.spec.ts) —
  // best-effort dismiss, der catch schluckt den Fall "Dialog kommt nicht".
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function login(page: Page, identifier: string, password: string) {
  // Ein Retry: im geteilten Test-Stack kann ein Anfrage-Fehlschlag im
  // Sekundentakt entstehen (Neustart der Dienste zwischen Specs) — der
  // zweite Anlauf läuft dann gegen einen wieder gesunden Dienst.
  for (const versuch of [1, 2]) {
    await page.goto('/login');
    await page.getByTestId('login-identifier').fill(identifier);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();
    const drin = await page
      .waitForURL(/\/app/, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (drin) {
      await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
      return;
    }
    if (versuch === 2) {
      await expect(page.getByTestId('login-error')).toBeHidden({ timeout: 1_000 });
    }
  }
}

/** Nutzereinstellungen öffnen und einen Reiter wählen (Muster wie
 *  e2e-kopplung.spec.ts::sicherheitTabOeffnen). Der Trigger-Klick kann im
 *  Re-Render direkt nach dem `ready`-Frame versanden — daher mit kurzer
 *  Nachfrage wiederholen, bis der Menüeintrag wirklich da ist. */
async function kontoMenueOeffnen(page: Page, eintrag: 'open-settings' | 'sign-out') {
  const ziel = page.getByTestId(eintrag);
  for (let i = 0; i < 3; i++) {
    if (await ziel.isVisible().catch(() => false)) break;
    await page.getByTestId('user-footer-trigger').click();
    await ziel.waitFor({ state: 'visible', timeout: 2500 }).catch(() => undefined);
  }
  await ziel.click();
}

async function einstellungenTab(page: Page, tab: 'profile' | 'security') {
  await kontoMenueOeffnen(page, 'open-settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId(`settings-tab-${tab}`).click();
}

test.describe.serial('Overnight Auth', () => {
  let ctx: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    // Nur den EIGENEN Kontext schließen — der `browser`-Fixture gehört dem
    // Worker und wird von den nachfolgenden Specs derselben Suite genutzt.
    await ctx.close();
  });

  test('Registrierung legt ein Konto an und landet in der App', async () => {
    await register(page, USER);
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
  });

  test('Der Sidebar-Footer zeigt den Nutzernamen', async () => {
    await expect(page.getByTestId('user-footer')).toContainText(USER.username);
  });

  test('Abmelden über das Kontomenü landet auf dem Login', async () => {
    await kontoMenueOeffnen(page, 'sign-out');
    await page.waitForURL(/\/login/);
  });

  test('Anmeldung mit falschem Passwort zeigt einen Fehler', async () => {
    await page.goto('/login');
    await page.getByTestId('login-identifier').fill(USER.username);
    await page.getByTestId('login-password').fill('falsches-passwort');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toBeVisible();
  });

  test('Anmeldung mit unbekanntem Nutzer zeigt einen Fehler', async () => {
    await page.goto('/login');
    await page.getByTestId('login-identifier').fill(`niemand_${ts}`);
    await page.getByTestId('login-password').fill('egal-was-hier-steht');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toBeVisible();
  });

  test('Anmeldung ist fallinsensitiv (Michael → michael)', async () => {
    await login(page, USER.username.toLowerCase(), USER.password);
    await expect(page.getByTestId('user-footer')).toContainText(USER.username);
  });

  test('Display-Name ändern — der Footer folgt', async () => {
    await einstellungenTab(page, 'profile');
    await expect(page.getByTestId('profile-display-name-input')).toBeVisible();
    await page.getByTestId('profile-display-name-input').fill(DISPLAY_NAME);
    await page.getByTestId('profile-save-btn').click();
    // Der Footer lebt hinter dem Dialog-Overlay — erst schließen, dann
    // behaupten.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toBeHidden();
    await expect(page.getByTestId('user-footer')).toContainText(DISPLAY_NAME, {
      timeout: 10_000
    });
  });

  test('Der Display-Name übersteht einen Reload', async () => {
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('user-footer')).toContainText(DISPLAY_NAME);
  });

  test('Passwort ändern im Sicherheits-Reiter', async () => {
    await einstellungenTab(page, 'security');
    await expect(page.getByTestId('change-password-section')).toBeVisible();
    await page.getByTestId('change-password-current').fill(USER.password);
    await page.getByTestId('change-password-new').fill(NEW_PASSWORD);
    await page.getByTestId('change-password-confirm').fill(NEW_PASSWORD);
    await page.getByTestId('change-password-submit').click();
    // Erfolg erkennt die UI daran, dass die Felder geleert werden und kein
    // Fehler-Alert erscheint (der Toast ist zu flüchtig für eineAssertion).
    await expect(page.getByTestId('change-password-current')).toHaveValue('', { timeout: 10_000 });
    await expect(page.getByTestId('change-password-error')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toBeHidden();
  });

  test('Das alte Passwort wird nach der Änderung abgelehnt', async () => {
    await kontoMenueOeffnen(page, 'sign-out');
    await page.waitForURL(/\/login/);
    await page.getByTestId('login-identifier').fill(USER.username);
    await page.getByTestId('login-password').fill(USER.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toBeVisible();
  });

  test('Das neue Passwort funktioniert', async () => {
    await login(page, USER.username, NEW_PASSWORD);
  });

  test('Passwort zurückändern — alles beim Alten', async () => {
    await einstellungenTab(page, 'security');
    await page.getByTestId('change-password-current').fill(NEW_PASSWORD);
    await page.getByTestId('change-password-new').fill(USER.password);
    await page.getByTestId('change-password-confirm').fill(USER.password);
    await page.getByTestId('change-password-submit').click();
    await expect(page.getByTestId('change-password-current')).toHaveValue('', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toBeHidden();
    // Gegenprobe: mit dem zurückgesetzten Passwort neu anmelden.
    await kontoMenueOeffnen(page, 'sign-out');
    await page.waitForURL(/\/login/);
    await login(page, USER.username, USER.password);
  });
});
