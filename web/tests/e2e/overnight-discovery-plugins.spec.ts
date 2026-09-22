import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Overnight Bughunt T19 — Entdecken + Plugins.
 *
 * Eine Community wird über die öffentliche Adresse auffindbar gemacht
 * (Handle + öffentlich + gelistet), taucht im Verzeichnis auf und wird über
 * /c/<handle> betreten. Danach die Plugin-Kette: Admin-Allowlist →
 * Guild-Toggle → Tamagotchi-Widget im Kanal → füttern → Toggle OFF.
 *
 * Struktur wie `plugins.spec.ts` (Bootstrap-Slot verbrennen, is_admin per
 * SQL, Einladung per API) — die UI-Pfade stammen aus derselben Datei und
 * `admin.spec.ts`.
 */

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
const HANDLE = `bughunt-${ts}`;
const GUILD_NAME = `T19 Community ${ts}`;
const OWNER = {
  username: `owner_t19_${ts}`,
  email: `owner_t19_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const JOINER = {
  username: `joiner_t19_${ts}`,
  email: `joiner_t19_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

async function register(page: Page, u: { username: string; email: string; password: string }) {
  // Die Anmeldung bounct sporadisch zurück auf /register (produktseitig,
  // nicht laufspezifisch) — ein zweiter Versuch mit frischem Suffix fängt
  // das; der erste Lauf kann den Namen bereits verbraucht haben.
  for (let versuch = 0; versuch < 2; versuch++) {
    await page.goto('/register');
    await page.getByTestId('reg-username').fill(u.username);
    await page.getByTestId('reg-email').fill(u.email);
    await page.getByTestId('reg-password').fill(u.password);
    await page.getByTestId('reg-submit').click();
    try {
      await page.waitForURL(/\/app/, { timeout: 20_000 });
      break;
    } catch (e) {
      if (versuch === 1) throw e;
      u.username = `${u.username}w`;
      u.email = `${u.email}.w`;
    }
  }
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function login(page: Page, u: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
}

async function guildSettingsTab(page: Page, guildId: string, tab: string): Promise<void> {
  await page.getByTestId(`guild-${guildId}`).click({ button: 'right' });
  await page.getByTestId('guild-settings').click();
  await expect(page.getByTestId('guild-settings-dialog')).toBeVisible();
  await page.getByTestId(`settings-tab-${tab}`).click();
}

test.describe.serial('Overnight T19 — Entdecken und Plugins', () => {
  let ownerCtx: BrowserContext;
  let owner: Page;
  let joinerCtx: BrowserContext;
  let joiner: Page;
  let guildId = '';

  test.beforeAll(async ({ browser }) => {
    ownerCtx = await browser.newContext();
    joinerCtx = await browser.newContext();
    for (const ctx of [ownerCtx, joinerCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    owner = await ownerCtx.newPage();
    joiner = await joinerCtx.newPage();
  });

  test.afterAll(async () => {
    await ownerCtx?.close();
    await joinerCtx?.close();
  });

  test('Vorbereitung: Owner registriert, wird Admin, legt die Community an', async () => {
    // Erster Test des Laufs: Bootstrap-Brennen + drei Registrierungen sind
    // viel für die Vorgabe-30s.
    test.setTimeout(240_000);
    // Bootstrap-Admin-Slot verbrennen (wie in plugins.spec.ts), damit der
    // Joiner nicht automatisch befördert wird.
    const bootCtx = await owner.context().browser()!.newContext();
    const bootPage = await bootCtx.newPage();
    await register(bootPage, {
      username: `bootstrap_t19_${ts}`,
      email: `bootstrap_t19_${ts}@dcc-test.example.com`,
      password: 'sup3r-secret-pass'
    });
    await bootCtx.close();

    await register(owner, OWNER);
    await register(joiner, JOINER);

    // Dieselbe Datenbank wie der Lauf — mit isolierter DB (PULSE_E2E_DB,
    // s. _globalSetup.ts) landet das UPDATE sonst in der falschen, und der
    // Owner blieb unverwandelt.
    const testDb = process.env.PULSE_E2E_DB ?? 'dcc_test';
    execSync(
      `${CONTAINER_EXEC} exec -i dcc_night_postgres psql -U dcc -d ${testDb} -c "UPDATE auth.users SET is_admin=true WHERE username='${OWNER.username}'"`,
      { stdio: 'ignore' }
    );
    // Neu anmelden, damit der Claim im frischen JWT landet.
    await owner.goto('/login');
    await owner.evaluate(() => localStorage.clear());
    await login(owner, OWNER);

    // Community über das Rail-Plus-Menü anlegen (Weg wie plugins.spec.ts).
    // Der erste Menü-Klick frisst sich gelegentlich tot — Paar nachsetzen.
    await owner.goto('/app');
    for (let versuch = 0; versuch < 4; versuch++) {
      await owner.locator('[data-testid^="guild-create-menu-"]').first().click();
      try {
        await owner.getByTestId('guild-create').click({ timeout: 2500 });
        break;
      } catch {
        // Menü hat nicht geöffnet — neu klicken.
      }
    }
    await owner.getByTestId('create-guild-name').fill(GUILD_NAME);
    await owner.getByTestId('create-guild-submit').click();
    await owner.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    guildId = owner.url().match(/\/app\/guilds\/(\d+)/)![1];
  });

  test('Öffentliche Adresse: Handle setzen, öffentlich + gelistet, speichern', async () => {
    await guildSettingsTab(owner, guildId, 'publicaddress');
    await owner.getByTestId('guild-handle-input').fill(HANDLE);
    await owner.getByTestId('guild-public-toggle').click();
    await owner.getByTestId('guild-listed-toggle').click();
    await owner.getByTestId('guild-public-address-save').click();
    await expect(owner.getByTestId('guild-public-url')).toContainText(`/c/${HANDLE}`, {
      timeout: 10_000
    });
  });

  test('Zweiter Nutzer: /app/discover listet die Community', async () => {
    await joiner.goto('/app/discover');
    await expect(joiner.getByTestId('discover-page')).toBeVisible();
    await expect(joiner.getByTestId(`discover-card-${HANDLE}`)).toBeVisible({ timeout: 15_000 });
  });

  test('Suche filtert das Verzeichnis', async () => {
    const suche = joiner.getByTestId('discover-search');
    // Entprellte Suche (300 ms): erst ein Treffer, der nichts findet …
    await suche.fill('gibt-es-nicht');
    await expect(joiner.getByText(/Hier ist noch nichts/)).toBeVisible({ timeout: 10_000 });
    await expect(joiner.getByTestId(`discover-card-${HANDLE}`)).toHaveCount(0);
    // … dann der Community-NAME (die Verzeichnissuche matcht nur auf den
    // Namen, nicht auf den Handle — `public_community.py`), und die Karte
    // ist wieder da.
    await suche.fill(GUILD_NAME);
    await expect(joiner.getByTestId(`discover-card-${HANDLE}`)).toBeVisible({ timeout: 10_000 });
  });

  test('/c/<handle>: Karte zeigt den Community-Namen, Join landet in der Community', async () => {
    await joiner.goto(`/c/${HANDLE}`);
    await expect(joiner.getByTestId('public-community-card')).toBeVisible({ timeout: 15_000 });
    await expect(joiner.getByTestId('public-community-name')).toHaveText(GUILD_NAME);
    await joiner.getByTestId('public-community-join').click();
    await joiner.waitForURL(/\/app\/guilds\/\d+/, { timeout: 20_000 });
    expect(joiner.url()).toContain(`/app/guilds/${guildId}`);
  });

  test('Admin schaltet Tamagotchi in der Plugin-Allowlist frei', async () => {
    test.setTimeout(90_000);
    // Frischer Seitenaufbau: nach mehreren Tests in derselben Session friest
    // sich der Klick gelegentlich an einer Hydratation tot — ein Reload
    // beendet das, und der Klick setzt danach nach, falls noetig.
    await owner.reload();
    await expect(owner.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
    for (let versuch = 0; versuch < 4; versuch++) {
      try {
        await owner.getByTestId('open-admin').click({ timeout: 5000 });
        break;
      } catch {
        // Neu klicken.
      }
    }
    await owner.waitForURL(/\/app\/admin/, { timeout: 15_000 });
    await owner.getByTestId('admin-tab-settings').click();
    await expect(owner.getByTestId('admin-plugins')).toBeVisible();
    const toggle = owner.getByTestId('admin-plugin-toggle-tamagotchi');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 7_000 });
  });

  test('Guild-Settings: Tamagotchi ON → Widget erscheint im Kanal', async () => {
    // Der vorige Test lief im Admin-Panel — zurueck in die App, sonst steht
    // die Guild-Rail fuer den Rechtsklick nicht.
    test.setTimeout(120_000);
    await owner.goto('/app');
    await expect(owner.getByTestId(`guild-${guildId}`)).toBeVisible({ timeout: 15_000 });
    await guildSettingsTab(owner, guildId, 'plugins');
    const toggle = owner.getByTestId('guild-plugin-toggle-tamagotchi');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 7_000 });
    await owner.keyboard.press('Escape');

    // Der Unterstrich-Kanal redirectet auf den ersten Textkanal.
    await owner.goto(`/app/guilds/${guildId}/channels/_`);
    await owner.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    await expect(owner.getByTestId('guild-plugin-rail')).toBeVisible({ timeout: 15_000 });
    await expect(owner.getByTestId('tamagotchi-widget')).toBeVisible({ timeout: 15_000 });
    await expect(owner.getByTestId('tamagotchi-bar-hunger')).toHaveAttribute('aria-valuenow', '80', {
      timeout: 10_000
    });
  });

  test('Tamagotchi füttern — Zähler ändert sich; Toggle OFF lässt das Widget verschwinden', async () => {
    await owner.getByTestId('tamagotchi-feed').click();
    await expect(owner.getByTestId('tamagotchi-bar-hunger')).toHaveAttribute(
      'aria-valuenow',
      '100',
      { timeout: 10_000 }
    );

    // Plugin wieder aus — nach einem Neuladen (frischer Plugin-Cache) ist
    // die Rail weg.
    await guildSettingsTab(owner, guildId, 'plugins');
    const toggle = owner.getByTestId('guild-plugin-toggle-tamagotchi');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 7_000 });
    await owner.keyboard.press('Escape');
    await owner.reload();
    await owner.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    await expect(owner.getByTestId('tamagotchi-widget')).toHaveCount(0);
    await expect(owner.getByTestId('guild-plugin-rail')).toHaveCount(0);
  });
});
