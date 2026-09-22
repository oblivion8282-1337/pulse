/**
 * T11 — Community-Dateiablage (Ablage-Kanal auf dem Pulse-Laufwerk),
 * Klick-Durchlauf in Einzelschritten.
 *
 * Ablauf (serial, ein Guild-Verbund):
 *   Besitzer registriert → Community + Ablage-Kanal anlegen → Laufwerk
 *   verbinden (genau ein Anbieter: Pulse) → Quota-Gauge zeigt die
 *   Betreiber-Zuweisung (1 GiB) → Datei hochladen (Ankündigung →
 *   presigned PUT → gelungen, alles hinter `DateiSpeicher`) → Karte
 *   erscheint, Quota-Anzeige steigt → Suche filtert → Ordner anlegen +
 *   öffnen → Datei löschen (MIT Rückfrage, Bughunt 2026-09-20 Runde 2) →
 *   Datei über der Einzeldatei-Grenze → 413 → Zweitgerät ohne Schlüssel
 *   sieht den ehrlichen Ohne-Schlüssel-Zustand.
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const OWNER = {
  username: `ovn_ablage_owner_${ts}`,
  email: `ovn_ablage_owner_${ts}@dcc-test.example.com`,
  password: 'Ablage!2026pass'
};
const GAST = {
  username: `ovn_ablage_gast_${ts}`,
  email: `ovn_ablage_gast_${ts}@dcc-test.example.com`,
  password: 'Ablage!2026pass'
};

const PER_FILE_MAX_BYTES = 64 * 1024 * 1024; // config.pulse_laufwerk_max_datei_bytes

async function register(page: Page, u: { username: string; email: string; password: string }) {
  await page.goto('/register');
  await page.getByTestId('reg-username').fill(u.username);
  await page.getByTestId('reg-email').fill(u.email);
  await page.getByTestId('reg-password').fill(u.password);
  await page.getByTestId('reg-submit').click();
  await page.waitForURL(/\/app/);
  // BackupSetupStep poppt nach runIssueFlow auf — best-effort dismiss.
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

async function createGuild(page: Page, name: string): Promise<string> {
  return page.evaluate(async (guildName) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch('/api/chat/guilds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: guildName })
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`guild create failed: ${r.status} ${JSON.stringify(body)}`);
    return body.id as string;
  }, name);
}

async function currentUserId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) throw new Error('no access token');
    const payload = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
}

/** Ablage-Kanal über das Plus-Menü anlegen und landen (Kanal-Route). */
async function legeAblageKanalAn(page: Page, gid: string): Promise<void> {
  await page.goto(`/app/rooms/${gid}`);
  await page.getByTestId('channel-create').click();
  await expect(page.getByTestId('create-channel-dialog')).toBeVisible();
  await page.waitForTimeout(800); // Hydration abwarten — sonst verpufft der Submit-Klick
  await page.getByTestId('create-channel-type-dropbox').click();
  await page.getByTestId('create-channel-name').fill('Test-Ablage');
  await page.getByTestId('create-channel-submit').click();
  await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
}

test.describe.serial('T11 — Community-Dateiablage', () => {
  test.setTimeout(120_000);

  let page: Page;
  let gid = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test('Anlegen + Verbinden: Ansicht rendert mit Betreiber-Zuweisung', async () => {
    await register(page, OWNER);
    gid = await createGuild(page, 'Ablage Overnight Guild');
    await legeAblageKanalAn(page, gid);

    // Genau ein Anbieter: Pulse-Laufwerk
    await page.getByTestId('community-ablage-verbinden').click();
    const dialog = page.getByTestId('ablage-verbinden-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('anbieter-pulse')).toBeVisible();
    expect(await page.getByTestId('anbieter-dropbox').count()).toBe(0);
    expect(await page.getByTestId('anbieter-nextcloud').count()).toBe(0);
    await page.getByTestId('anbieter-pulse').click();
    await page.getByTestId('pulse-verbinden').click();

    const ansicht = page.getByTestId('community-ablage-ansicht');
    await expect(ansicht).toBeVisible({ timeout: 10_000 });
    const gauge = page.getByTestId('community-ablage-kontingent');
    await expect(gauge).toContainText('1.00 GB', { timeout: 10_000 });
    // Noch leer: 0 B belegt
    await expect(gauge).toContainText('0 B von 1.00 GB belegt');
  });

  test('Upload: Datei erscheint, Quota-Anzeige steigt', async () => {
    const ansicht = page.getByTestId('community-ablage-ansicht');
    await ansicht.locator('input[type=file]').setInputFiles({
      name: 'hallo-geheim.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('PULSE-TEST-GEHEIM — darf nie am Speicher lesbar sein.', 'utf8')
    });
    await expect(ansicht.getByText('hallo-geheim.txt')).toBeVisible({ timeout: 15_000 });

    // Genutzt ist nicht mehr 0 — die Ankündigung zählt (Klumpen +
    // verzeichnis.puls), die Anzeige enthält jedenfalls keine „0 B" mehr.
    const gauge = page.getByTestId('community-ablage-kontingent');
    await expect(gauge).not.toContainText('0 B von 1.00 GB belegt', { timeout: 10_000 });
  });

  test('Suche filtert die Liste', async () => {
    const ansicht = page.getByTestId('community-ablage-ansicht');
    // Treffer
    await page.getByTestId('community-ablage-suche').fill('hallo');
    await expect(ansicht.getByText('hallo-geheim.txt')).toBeVisible();
    // Kein Treffer → Leer-Hinweis mit dem Query (so wie er im Feld steht)
    await page.getByTestId('community-ablage-suche').fill('ExistiertNicht');
    await expect(ansicht.getByText('Keine Treffer für „ExistiertNicht“')).toBeVisible();
    await expect(ansicht.getByText('hallo-geheim.txt')).toHaveCount(0);
    await page.getByTestId('community-ablage-suche').fill('');
    await expect(ansicht.getByText('hallo-geheim.txt')).toBeVisible();
  });

  test('Ordner anlegen → Ordner-Karte erscheint, öffnen + zurück', async () => {
    const ansicht = page.getByTestId('community-ablage-ansicht');
    await page.getByTestId('community-ablage-ordner-anlegen').click();
    await page.getByTestId('dropbox-folder-name-input').fill('Fotos');
    await page.waitForTimeout(800); // Dialog-Hydration
    await page.getByTestId('dropbox-folder-create').click();

    const ordnerKarte = ansicht.locator('[data-testid^=community-ablage-datei-]', {
      hasText: 'Fotos'
    });
    await expect(ordnerKarte).toBeVisible();

    // Hinein — die Suche ist im Ordner wieder da, Datei aus der Wurzel nicht
    await ordnerKarte.locator('button').first().click();
    await expect(page.getByTestId('community-ablage-suche')).toBeVisible();
    await expect(ansicht.getByText('hallo-geheim.txt')).toHaveCount(0);

    // Brotkrumen zurück zur Wurzel
    await page
      .getByRole('button', { name: /Zurück zur Ablage-Wurzel/ })
      .first()
      .click();
    await expect(ansicht.getByText('Fotos')).toBeVisible();
  });

  test('Ansicht umschalten: Liste zeigt Zeilen', async () => {
    await page.getByTestId('community-ablage-ansicht-umschalten').click();
    const ansicht = page.getByTestId('community-ablage-ansicht');
    await expect(ansicht.getByText('hallo-geheim.txt')).toBeVisible();
    await page.getByTestId('community-ablage-ansicht-umschalten').click();
    await expect(ansicht.getByText('hallo-geheim.txt')).toBeVisible();
  });

  test('Löschen: Datei fragt nach und ist dann weg, Quota sinkt', async () => {
    const ansicht = page.getByTestId('community-ablage-ansicht');
    const gauge = page.getByTestId('community-ablage-kontingent');
    const vorher = (await gauge.textContent()) ?? '';

    const karte = ansicht.locator('[data-testid^=community-ablage-datei-]', {
      hasText: 'hallo-geheim.txt'
    });
    await karte.locator('[data-testid^=community-ablage-loeschen-]').click();
    // Rückfrage (gilt seit Bughunt 2026-09-20 Runde 2 auch für EINZELNE
    // Dateien) — der ConfirmDialog hängt als Portal AM WURZEL-LAYOUT,
    // nicht in der Ablage-Ansicht.
    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText('„hallo-geheim.txt“ endgültig löschen?');
    await page.getByTestId('confirm-dialog-confirm').click();

    await expect(ansicht.getByText('hallo-geheim.txt')).toHaveCount(0);
    // Der gelöschte Klumpen fliegt aus der Reservierungsbilanz — die
    // Anzeige fällt (verzeichnis.puls bleibt als kleiner Rest liegen).
    await expect(gauge).not.toHaveText(vorher, { timeout: 10_000 });
  });

  test('Datei über der Einzeldatei-Grenze → 413', async () => {
    const ansicht = page.getByTestId('community-ablage-ansicht');
    await ansicht.locator('input[type=file]').setInputFiles({
      name: 'zu-gross.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(PER_FILE_MAX_BYTES + 1024, 1)
    });
    // Der Server lehnt die Ankündigung mit 413 „file too large“ ab — die
    // Oberfläche zeigt das Detail im Fehlerkasten.
    await expect(ansicht.getByText('file too large')).toBeVisible({ timeout: 30_000 });
    await expect(ansicht.getByText('zu-gross.bin')).toHaveCount(0);
  });

  test('Zweitbenutzer ohne Schlüssel sieht ehrlichen Zustand', async ({ browser }) => {
    const gastId = await page.evaluate(async (user) => {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(user)
      });
      const body = await r.json();
      if (!r.ok && !('access_token' in body)) throw new Error(`register failed ${r.status}`);
      const token = body.access_token as string;
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.sub as string;
    }, GAST);
    await page.evaluate(async ({ gid, gastId }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      await fetch(`/api/chat/guilds/${gid}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: gastId })
      });
    }, { gid, gastId });

    const gastCtx = await browser.newContext();
    const gastPage = await gastCtx.newPage();
    await login(gastPage, GAST.username, GAST.password);
    await gastPage.goto(page.url());
    await expect(gastPage.getByTestId('community-ablage-ohne-schluessel')).toBeVisible({
      timeout: 10_000
    });
    await gastCtx.close();
  });
});
