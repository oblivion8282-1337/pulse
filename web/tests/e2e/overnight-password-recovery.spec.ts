/**
 * Overnight T2 — Passwort-Wiederherstellung:
 * Forgot-Password-UI (Erfolg ohne Nutzer-Enumeration), Token-Erzeugung
 * (DB-Gegenprobe), kompletter Reset-Fluss und der Ungültig-Token-Weg.
 *
 * Der Klartext-Token liegt NIE in der DB (nur SHA-256, s.
 * `dcc_auth/recovery.py`) und ohne SMTP wird auch keine Mail gebaut —
 * für den echten Reset säht der Test deshalb selbst einen Token-Hash in
 * `auth.password_reset_tokens` und kennt den Klartext per Konstruktion.
 * Die DB-Gegenprobe läuft per `docker exec` gegen den Test-Stack
 * (`dcc_night_postgres` / `dcc_test`, dieselbe DB wie in _globalSetup).
 */

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ts = Date.now();
const USER = {
  username: `reset_${ts}`,
  email: `reset_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const NEW_PASSWORD = 'wiederhergestellt-77';

function dbQuery(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', 'dcc_night_postgres', 'psql', '-U', 'dcc', '-d', 'dcc_test', '-tAc', sql],
    { encoding: 'utf8' }
  ).trim();
}

async function register(page: Page, u: typeof USER) {
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

async function forgotSubmit(page: Page, identifier: string) {
  await page.goto('/forgot-password');
  await page.getByTestId('forgot-identifier').fill(identifier);
  await page.getByTestId('forgot-submit').click();
}

test.describe.serial('Overnight Passwort-Wiederherstellung', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newContext().then((c) => c.newPage());
  });

  test.afterAll(async ({ browser }) => {
    await browser.close();
  });

  test('Registrierung als Ausgangspunkt', async () => {
    await register(page, USER);
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
  });

  test('Forgot mit bekannter E-Mail: Erfolg und zurück zum Login', async () => {
    // Der Endpoint limitiert pro IP auf 2/minute — diese Spec macht daher
    // insgesamt nur ZWEI Forgot-Requests (hier + der Unbekannt-Fall unten).
    await forgotSubmit(page, USER.email);
    await expect(page.getByTestId('forgot-success')).toBeVisible();
    await expect(page.getByTestId('forgot-success')).toContainText('Prüf dein Postfach');
    await page.getByTestId('forgot-back-to-login').click();
    await page.waitForURL(/\/login/);
  });

  test('Forgot mit unbekannter E-Mail zeigt denselben Erfolg (kein Nutzer-Scraping)', async () => {
    await forgotSubmit(page, `unbekannt_${ts}@dcc-test.example.com`);
    await expect(page.getByTestId('forgot-success')).toBeVisible();
  });

  test('Für den bekannten Nutzer wurde ein gültiger Token erzeugt', async () => {
    const count = dbQuery(`
      SELECT count(*) FROM auth.password_reset_tokens t
      JOIN auth.users u ON u.id = t.user_id
      WHERE u.username = '${USER.username}' AND t.used_at IS NULL
    `);
    expect(Number(count)).toBeGreaterThanOrEqual(1);
  });

  test('Kompletter Reset mit gültigem Token — altes Passwort tot, neues lebendig', async () => {
    // Selbst gesäter Token: Klartext kennen WIR, die DB nur den SHA-256 —
    // exakt der Weg, den die E-Mail normalerweise geht.
    const userId = dbQuery(`SELECT id FROM auth.users WHERE username = '${USER.username}'`);
    expect(userId).toMatch(/^\d+$/);
    const plaintext = `e2e-reset-${ts}-${USER.username}-token`;
    const digest = createHash('sha256').update(plaintext).digest('hex');
    dbQuery(`
      INSERT INTO auth.password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (${userId}, '${digest}', now() + interval '1 hour')
    `);

    await page.goto(`/reset-password/${plaintext}`);
    await page.getByTestId('reset-password').fill(NEW_PASSWORD);
    await page.getByTestId('reset-confirm').fill(NEW_PASSWORD);
    await page.getByTestId('reset-submit').click();
    await page.waitForURL(/\/login/);

    // Das alte Passwort wird abgelehnt …
    await page.getByTestId('login-identifier').fill(USER.username);
    await page.getByTestId('login-password').fill(USER.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toBeVisible();

    // … das neue angemeldet.
    await page.goto('/login');
    await page.getByTestId('login-identifier').fill(USER.username);
    await page.getByTestId('login-password').fill(NEW_PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
  });

  test('Ungültiger Token zeigt Fehler und den Weg zu einem neuen Link', async () => {
    await page.goto('/reset-password/total-unbekannt-token');
    await page.getByTestId('reset-password').fill('noch-ein-pass-99');
    await page.getByTestId('reset-confirm').fill('noch-ein-pass-99');
    await page.getByTestId('reset-submit').click();
    await expect(page.getByTestId('reset-error')).toBeVisible();
    await expect(page.getByTestId('reset-request-new')).toBeVisible();
    await page.getByTestId('reset-request-new').click();
    await page.waitForURL(/\/forgot-password/);
  });
});
