/**
 * End-to-end für die Community-Dateiablage auf dem Pulse-Laufwerk
 * (Spezifikation `docs/superpowers/specs/2026-09-11-pulse-laufwerk-design.md`,
 * Festlegungen §11).
 *
 * Durchlauf:
 *  - Registrierung + Community anlegen
 *  - Plus-Menü: drei Optionen (Text, Sprache, Ablage) — Ablage wählen
 *  - Ablage-Kanal öffnet: Verbinden-Dialog zeigt GENAU EINEN Anbieter
 *    („Pulse drive") — verbinden
 *  - Quota-Gauge zeigt die Instanz-Zuweisung (512 MB Default)
 *  - Datei hochladen → Karte erscheint mit Name + Größe
 *  - Ordner anlegen → hinein → Datei im Ordner hochladen → Brotkrumen zurück
 *  - Suche filtert, Ansicht Raster/Liste umschalten
 *  - Datei löschen → weg; Ordner löschen (mit Rückfrage) → weg
 *  - Zweitbenutzer ohne Schlüssel sieht den ehrlichen Ohne-Schlüssel-Zustand
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const OWNER = {
  username: `pulsedrive_owner_${ts}`,
  email: `pulsedrive_owner_${ts}@dcc-test.example.com`,
  password: 'TestDrive!2026x'
};
const GAST = {
  username: `pulsedrive_gast_${ts}`,
  email: `pulsedrive_gast_${ts}@dcc-test.example.com`,
  password: 'TestDrive!2026x'
};

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

test.describe.configure({ retries: 2 });

test.describe('Pulse-Laufwerk — Community-Dateiablage', () => {
  test.setTimeout(120_000);
  test('anlegen, verbinden, hochladen, ordner, suchen, löschen', async ({ page }) => {
    await register(page, OWNER);
    const gid = await createGuild(page, 'Drive Test Guild');

    // Räume-Ansicht der Community: Plus öffnet das Erstellen-Menü
    await page.goto(`/app/rooms/${gid}`);
    await page.getByTestId('channel-create').click();
    await expect(page.getByTestId('create-channel-dialog')).toBeVisible();
    await page.waitForTimeout(800); // Hydration abwarten — sonst verpufft der Submit-Klick
    // Drei Optionen: Text, Sprache, Ablage
    await expect(page.getByTestId('create-channel-type-text')).toBeVisible();
    await expect(page.getByTestId('create-channel-type-voice')).toBeVisible();
    await expect(page.getByTestId('create-channel-type-dropbox')).toBeVisible();

    await page.getByTestId('create-channel-type-dropbox').click();
    await page.getByTestId('create-channel-name').fill('Test-Ablage');
    await page.getByTestId('create-channel-submit').click();

    await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);

    // Ohne verbundenem Laufwerk: Aufforderung + Verbinden-Dialog
    await page.getByTestId('community-ablage-verbinden').click();
    const dialog = page.getByTestId('ablage-verbinden-dialog');
    await expect(dialog).toBeVisible();
    // Genau ein Anbieter: Pulse-Laufwerk — keine fremden Anbieter
    await expect(page.getByTestId('anbieter-pulse')).toBeVisible();
    expect(await page.getByTestId('anbieter-dropbox').count()).toBe(0);
    expect(await page.getByTestId('anbieter-nextcloud').count()).toBe(0);
    await page.getByTestId('anbieter-pulse').click();
    await page.getByTestId('pulse-verbinden').click();

    // Verbunden: Ansicht + Quota-Gauge mit der Betreiber-Zuweisung
    // (beim Kanal-Anlegen mit der Decke 1 GiB geseedet)
    const ansicht = page.getByTestId('community-ablage-ansicht');
    await expect(ansicht).toBeVisible({ timeout: 10_000 });
    const gauge = page.getByTestId('community-ablage-kontingent');
    await expect(gauge).toContainText('1.00 GB', { timeout: 10_000 });

    // Hochladen — Datei mit bekanntem Klartext (Verschlüsselungs-Gegenprobe
    // folgt serverseitig, siehe Spec-Note unten im Dateinamen)
    const klartext = 'PULSE-TEST-GEHEIM-12345 — darf niemals am Speicher lesbar sein.';
    await ansicht.locator('input[type=file]').setInputFiles({
      name: 'hallo-geheim.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(klartext, 'utf8')
    });
    await expect(ansicht.getByText('hallo-geheim.txt')).toBeVisible({ timeout: 10_000 });

    // Ordner anlegen, hinein, Datei im Ordner hochladen
    await page.getByTestId('community-ablage-ordner-anlegen').click();
    await page.getByTestId('dropbox-folder-name-input').fill('Fotos');
    await page.waitForTimeout(800);
    await page.getByTestId('dropbox-folder-create').click();

    const ordnerKarte = ansicht.locator('[data-testid^=community-ablage-datei-]', {
      hasText: 'Fotos'
    });
    await expect(ordnerKarte).toBeVisible();
    await ordnerKarte.locator('button').first().click(); // Ordner öffnen
    await expect(page.getByTestId('community-ablage-suche')).toBeVisible();

    await ansicht.locator('input[type=file]').setInputFiles({
      name: 'bericht.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('bericht im ordner', 'utf8')
    });
    await expect(ansicht.getByText('bericht.txt')).toBeVisible({ timeout: 10_000 });

    // Brotkrumen zurück zur Wurzel (Chip = Pulse-Laufwerk)
    await page
      .getByRole('button', { name: /Zurück zur Ablage-Wurzel/ })
      .first()
      .click();
    await expect(ansicht.getByText('Fotos')).toBeVisible();

    // Suche filtert
    await page.getByTestId('community-ablage-suche').fill('hallo');
    await expect(ansicht.getByText('hallo-geheim.txt')).toBeVisible();
    await expect(ansicht.getByText('Fotos')).toHaveCount(0);
    await page.getByTestId('community-ablage-suche').fill('');

    // Ansicht umschalten: Liste zeigt Zeilen
    await page.getByTestId('community-ablage-ansicht-umschalten').click();
    await expect(ansicht.getByText('hallo-geheim.txt')).toBeVisible();

    // Datei löschen
    const halloKarte = ansicht.locator('[data-testid^=community-ablage-datei-]', {
      hasText: 'hallo-geheim.txt'
    });
    await halloKarte.locator('[data-testid^=community-ablage-loeschen-]').click();
    await expect(ansicht.getByText('hallo-geheim.txt')).toHaveCount(0);

    // Ordner löschen — mit Rückfrage (enthält bericht.txt)
    const fotosKarte = ansicht.locator('[data-testid^=community-ablage-datei-]', {
      hasText: 'Fotos'
    });
    await fotosKarte.locator('[data-testid^=community-ablage-loeschen-]').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(ansicht.getByText('Fotos')).toHaveCount(0);
  });

  test('zweitbenutzer ohne Schlüssel sieht ehrlichen Zustand', async ({ browser }) => {
    // Eigener Kontext: Owner mit verbundenem Laufwerk …
    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    await register(ownerPage, OWNER);
    const gid = await createGuild(ownerPage, 'Key Check Guild');
    await ownerPage.goto(`/app/rooms/${gid}`);
    await ownerPage.getByTestId('channel-create').click();
    await expect(ownerPage.getByTestId('create-channel-dialog')).toBeVisible();
    await ownerPage.waitForTimeout(800);
    await ownerPage.getByTestId('create-channel-type-dropbox').click();
    await ownerPage.getByTestId('create-channel-name').fill('Ablage');
    await ownerPage.getByTestId('create-channel-submit').click();
    await page2WaitChannel(ownerPage);
    await ownerPage.getByTestId('community-ablage-verbinden').click();
    await ownerPage.getByTestId('anbieter-pulse').click();
    await ownerPage.getByTestId('pulse-verbinden').click();
    await expect(ownerPage.getByTestId('community-ablage-ansicht')).toBeVisible();

    // … Gast-Konto anlegen, in die Community holen, separat anmelden …
    const gastId = await ownerPage.evaluate(async (user) => {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(user)
      });
      const body = await r.json();
      if (!r.ok && !('access_token' in body)) throw new Error(`register failed ${r.status}`);
      // User-Id aus dem Token lesen (sub-Claim)
      const token = body.access_token as string;
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.sub as string;
    }, GAST);
    await ownerPage.evaluate(async ({ gid, gastId }) => {
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
    const kanalUrl = ownerPage.url();
    await gastPage.goto(kanalUrl);
    await expect(gastPage.getByTestId('community-ablage-ohne-schluessel')).toBeVisible({
      timeout: 10_000
    });

    await ownerCtx.close();
    await gastCtx.close();
  });
});

/** Wartet, bis die Kanal-Route erreicht ist (nach dem Erstellen). */
async function page2WaitChannel(page: Page): Promise<void> {
  await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
}
