/**
 * Overnight T4 — Rollenverwaltung über die UI:
 * Anlegen (mit KICK-Recht), Reihenfolge tauschen, Rollen zuordnen und
 * wieder abziehen (Trägerzahl live, Entscheidung 3.2), Rolle löschen
 * (@everyone fängt auf), Rang-Hierarchie: Mod sieht keinen Kick-Knopf
 * für den höher stehenden Admin.
 *
 * Vier Nutzer in einer Community: Owner (bedient die Einstellungen),
 * bob (Admin), carol (Mod, führt den Kick-Probe), dave (rollenlos).
 */

import { test, expect, type Page, type BrowserContext, type Browser } from '@playwright/test';

const ts = Date.now();
const PASSWORD = 'sup3r-secret-pass';

const bit = (n: number) => (1n << BigInt(n)).toString();
const KICK = bit(8); // 256

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
  await page
    .locator('[data-testid=backup-onboarding-skip-btn]')
    .click({ timeout: 2500 })
    .catch(() => undefined);
}

async function login(page: Page, u: { username: string; password: string }) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
}

async function userId(page: Page): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const value = await page.evaluate(() => {
      const raw = localStorage.getItem('dcc.tokens.access');
      if (!raw) return null;
      const parts = raw.split('.');
      if (parts.length !== 3) return null;
      try {
        return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
      } catch {
        return null;
      }
    });
    if (value) return value;
    if (Date.now() - t0 > 15000) {
      const zustand = await page.evaluate(() => ({
        url: location.href,
        keys: Object.keys(localStorage),
        shell: !!document.querySelector('[data-testid=app-shell]')
      }));
      throw new Error(`kein Token: ${JSON.stringify(zustand)}`);
    }
    await page.waitForTimeout(250);
  }
}

/** Authentifizierter Fetch im Seitenkontext (Muster channel-permissions.spec). */
async function api<T>(page: Page, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(
    async ({ path, init }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat${path}`, {
        method: init?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body)
      });
      if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
      return (await r.json()) as never;
    },
    { path, init }
  );
}

/** Leere Rolle über das Neu-Menü anlegen und den Namen setzen. Liefert die
 *  Rollen-Id; die Server-Antwort wird mitgeprüft, damit ein Misslingender
 *  Klick hier laut abstürzt statt still ins Leere zu laufen. */
async function rolleAnlegen(page: Page, name: string): Promise<string> {
  await page.getByTestId('role-create').click();
  await expect(page.getByTestId('role-create-menu')).toBeVisible();
  const createResponse = page.waitForResponse(
    (r) => r.url().endsWith(`/roles`) && r.request().method() === 'POST',
    { timeout: 10_000 }
  );
  // force: der Klick-Fänger (fixed inset-0) unter dem Menü kann den
  // Treffer beim Aufklappen sonst an sich reißen.
  await page.getByTestId('role-create-empty').click({ force: true });
  const resp = await createResponse;
  if (resp.status() >= 300) throw new Error(`role create failed: ${resp.status()}`);
  const created = (await resp.json()) as { id: string };
  // Die frische Rolle ist ausgewählt — ihre Zeile trägt den Namen als Input.
  const input = page.getByTestId(`role-name-input-${created.id}`);
  await expect(input).toHaveValue('Neue Rolle');
  await input.fill(name);
  return created.id;
}

/** Server-Wahrheit: Name der Rolle über die API (nicht über die UI-Zeile,
 *  denn die ausgewählte Zeile zeigt den Namen dauerhaft als Input). */
async function rolleNameImServer(
  page: Page,
  gildeId: string,
  roleId: string
): Promise<string | undefined> {
  const rollen = await api<{ id: string; name: string }[]>(page, `/guilds/${gildeId}/roles`);
  return rollen.find((r) => r.id === roleId)?.name;
}

test.describe.serial('Overnight Rollen', () => {
  let browser: Browser;
  let ownerCtx: BrowserContext;
  let carolCtx: BrowserContext;
  let owner: Page;
  let carol: Page;
  let guildId = '';
  let generalId = '';
  let bobId = '';
  let carolId = '';
  let daveId = '';
  let modRoleId = '';
  let adminRoleId = '';
  let waechterRoleId = '';
  let everyoneRoleId = '';

  const CAROL = { username: `rolecarol_${ts}`, password: PASSWORD };
  const DAVE = { username: `roledave_${ts}`, password: PASSWORD };

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    ownerCtx = await browser.newContext();
    owner = await ownerCtx.newPage();
  });

  test.afterAll(async () => {
    for (const ctx of [ownerCtx, carolCtx]) if (ctx) await ctx.close();
  });

  test('Owner registriert und legt die Community an', async () => {
    await register(owner, {
      username: `roleown_${ts}`,
      email: `roleown_${ts}@dcc-test.example.com`,
      password: PASSWORD
    });
    await owner.locator('[data-testid^="guild-create-menu-"]').first().click();
    await owner.getByTestId('guild-create').click();
    await owner.getByTestId('create-guild-name').fill('Rangenkette');
    await owner.getByTestId('create-guild-submit').click();
    await owner.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    guildId = owner.url().match(/\/app\/guilds\/(\d+)/)![1];
    generalId = owner.url().match(/channels\/(\d+)/)![1];

    const rollen = await api<{ id: string; is_everyone: boolean }[]>(owner, `/guilds/${guildId}/roles`);
    everyoneRoleId = rollen.find((r) => r.is_everyone)!.id;
  });

  test('bob registrieren — Owner fügt ihn per API hinzu', async () => {
    // Jeder Neben-Nutzer braucht nur zu EXISTIEREN: Registrierung, Id
    // ablesen, Kontext schließen. Der Beitragritt läuft per API
    // (addBobToGuild-Muster aus chat.spec) — der UI-Join über das Rail-Menü
    // war die flakigste Stelle der ganzen Suite.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await register(page, {
      username: `rolebob_${ts}`,
      email: `rolebob_${ts}@dcc-test.example.com`,
      password: PASSWORD
    });
    bobId = await userId(page);
    await ctx.close();
    await api(owner, `/guilds/${guildId}/members`, {
      method: 'POST',
      body: { user_id: bobId }
    });
  });

  test('carol registrieren und per API hinzufügen', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await register(page, {
      username: CAROL.username,
      email: `rolecarol_${ts}@dcc-test.example.com`,
      password: PASSWORD
    });
    carolId = await userId(page);
    await ctx.close();
    await api(owner, `/guilds/${guildId}/members`, {
      method: 'POST',
      body: { user_id: carolId }
    });
  });

  test('dave registrieren und per API hinzufügen', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await register(page, {
      username: DAVE.username,
      email: `roledave_${ts}@dcc-test.example.com`,
      password: PASSWORD
    });
    daveId = await userId(page);
    await ctx.close();
    await api(owner, `/guilds/${guildId}/members`, {
      method: 'POST',
      body: { user_id: daveId }
    });
  });

  test('Mod-Rolle mit KICK anlegen (Rollen-Reiter, Rechte-Raster)', async () => {
    await owner.getByTestId(`guild-${guildId}`).click({ button: 'right' });
    await owner.getByTestId('guild-settings').click();
    await expect(owner.getByTestId('guild-settings-dialog')).toBeVisible();
    await owner.getByTestId('settings-tab-roles').click();

    modRoleId = await rolleAnlegen(owner, 'Mod');

    await owner.getByTestId('role-tab-rechte').click();
    await owner.getByTestId(`perm-toggle-${KICK}`).check();
    await owner.getByTestId('role-save').click();
    await expect.poll(() => rolleNameImServer(owner, guildId, modRoleId), { timeout: 10_000 }).toBe('Mod');
  });

  test('Admin-Rolle anlegen — steht über der Mod-Rolle', async () => {
    adminRoleId = await rolleAnlegen(owner, 'Admin');
    await owner.getByTestId('role-save').click();
    await expect.poll(() => rolleNameImServer(owner, guildId, adminRoleId), { timeout: 10_000 }).toBe('Admin');

    // Neuanlage = höchste Position: Admin liegt ÜBER Mod in der Leiter.
    const firstRow = owner.locator('[data-testid^="role-row-"]').first();
    await expect(firstRow).toHaveAttribute('data-testid', `role-row-${adminRoleId}`);
  });

  test('Rollen umsortieren — Pfeil-Tauchgang hin und zurück', async () => {
    // Admin eine Stufe nach unten schieben → Mod liegt oben.
    await owner.getByTestId(`role-move-down-${adminRoleId}`).click();
    await expect
      .poll(async () => {
        const rows = await owner.locator('[data-testid^="role-row-"]').all();
        const ids: string[] = [];
        for (const row of rows) {
          ids.push((await row.getAttribute('data-testid'))!.replace('role-row-', ''));
        }
        return ids.slice(0, 2);
      }, { timeout: 10_000 })
      .toEqual([modRoleId, adminRoleId]);

    // Und wieder hoch — der Ausgangszustand für die Hierarchie-Probe.
    await owner.getByTestId(`role-move-up-${adminRoleId}`).click();
    await expect
      .poll(async () => {
        const rows = await owner.locator('[data-testid^="role-row-"]').all();
        const ids: string[] = [];
        for (const row of rows) {
          ids.push((await row.getAttribute('data-testid'))!.replace('role-row-', ''));
        }
        return ids.slice(0, 2);
      }, { timeout: 10_000 })
      .toEqual([adminRoleId, modRoleId]);
  });

  test('Admin-Rolle an bob zuordnen (Mitglieder-Reiter)', async () => {
    await owner.getByTestId('mitglieder-rollen-tab-mitglieder').click();
    await expect(owner.getByTestId(`member-row-${bobId}`)).toBeVisible({ timeout: 10_000 });
    await owner.getByTestId(`member-row-${bobId}`).click();
    await owner.getByTestId(`assign-${bobId}-${adminRoleId}`).check();
    await expect(owner.getByTestId(`assign-${bobId}-${adminRoleId}`)).toBeChecked();
  });

  test('Mod-Rolle an carol zuordnen', async () => {
    await owner.getByTestId(`member-row-${carolId}`).click();
    await owner.getByTestId(`assign-${carolId}-${modRoleId}`).check();
    await expect(owner.getByTestId(`assign-${carolId}-${modRoleId}`)).toBeChecked();
  });

  test('Trägerzahl steigt live (Entscheidung 3.2)', async () => {
    // Wächter anlegen, dave zuordnen — die Zahl in der Rangleiste folgt,
    // OHNE dass der Dialog geschlossen und neu geöffnet wird.
    await owner.getByTestId('mitglieder-rollen-tab-rollen').click();
    waechterRoleId = await rolleAnlegen(owner, 'Wächter');
    await owner.getByTestId('role-save').click();
    await expect
      .poll(() => rolleNameImServer(owner, guildId, waechterRoleId), { timeout: 10_000 })
      .toBe('Wächter');

    await owner.getByTestId('mitglieder-rollen-tab-mitglieder').click();
    await owner.getByTestId(`member-row-${daveId}`).click();
    await owner.getByTestId(`assign-${daveId}-${waechterRoleId}`).check();

    // Zurück in die Rangleiste: die Trägerzahl steht auf 1.
    await owner.getByTestId('mitglieder-rollen-tab-rollen').click();
    await expect(owner.getByTestId(`role-row-${waechterRoleId}`)).toContainText('1', { timeout: 10_000 });

    // Abziehen — die Zahl sinkt, ebenfalls ohne Dialog-Neustart.
    await owner.getByTestId('mitglieder-rollen-tab-mitglieder').click();
    await owner.getByTestId(`assign-${daveId}-${waechterRoleId}`).uncheck();
    await owner.getByTestId('mitglieder-rollen-tab-rollen').click();
    await expect(owner.getByTestId(`role-row-${waechterRoleId}`)).toContainText('0', { timeout: 10_000 });
  });

  test('Rolle löschen — das Mitglied fällt auf @everyone zurück', async () => {
    // Wächter wieder an dave, dann die Rolle löschen.
    await owner.getByTestId('mitglieder-rollen-tab-mitglieder').click();
    await owner.getByTestId(`member-row-${daveId}`).click();
    await owner.getByTestId(`assign-${daveId}-${waechterRoleId}`).check();

    await owner.getByTestId('mitglieder-rollen-tab-rollen').click();
    // Die ausgewählte Zeile trägt den Namen als INPUT, nicht als Text —
    // Auswahl über den Zeilen-Kern (erster Button der Zeile).
    await owner.getByTestId(`role-row-${waechterRoleId}`).locator('button').first().click();
    await owner.getByTestId('role-more-menu').click();
    await owner.getByTestId('role-delete-btn').click();
    await expect(owner.getByTestId('role-delete-confirm')).toBeVisible();
    await owner.getByTestId('role-delete-confirm-btn').click();
    await expect(owner.getByTestId(`role-row-${waechterRoleId}`)).toHaveCount(0);

    // dave hängt jetzt unter @everyone (Gruppenzähler + Zeile separat
    // behauptet — die Zeilen sind Geschwister der Gruppen-Kopfzeile).
    await owner.getByTestId('mitglieder-rollen-tab-mitglieder').click();
    await expect(owner.getByTestId(`mitglieder-gruppe-${everyoneRoleId}`)).toBeVisible({
      timeout: 10_000
    });
    await expect(owner.getByTestId(`member-row-${daveId}`)).toBeVisible({ timeout: 10_000 });
  });

  test('Hierarchie: Mod (carol) sieht keinen Kick-Knopf für Admin (bob)', async () => {
    await owner.keyboard.press('Escape');
    // Entschiedene Änderungen öffnen den Verwerfen-Dialog statt zu schließen.
    const confirm = owner.getByTestId('settings-close-confirm');
    if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
      await owner.getByRole('button', { name: 'Verwerfen' }).click();
    }
    await expect(owner.getByTestId('guild-settings-dialog')).toBeHidden();

    // carol meldet sich frisch an (ihr-setup-Kontext wurde nach dem Beitritt
    // geschlossen).
    carolCtx = await browser.newContext();
    carol = await carolCtx.newPage();
    await login(carol, CAROL);

    await carol.goto(`/app/guilds/${guildId}/channels/${generalId}`);
    await expect(carol.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
    // Die Mitgliederliste ist standardmäßig zugeklappt — erst aufklappen.
    await carol.getByTestId('member-list-toggle').click();
    const bobItem = carol.locator(`[data-testid="member-item"][data-user-id="${bobId}"]`);
    await expect(bobItem).toBeVisible({ timeout: 15_000 });
    await bobItem.click({ button: 'right' });
    // Auf das OFFENE Popover scopen — das des Vorgängers hängt beim
    // Schließen-Animieren noch im Baum (Strict-Mode-Falle bei zwei Popovers).
    const offenesPopover = carol.locator('[data-testid="user-profile-popover"][data-state="open"]');
    await expect(offenesPopover).toBeVisible();
    // carols höchste Rolle (Mod) steht UNTER bobs Admin → der Knopf ist weg.
    await expect(carol.getByTestId('popover-kick-btn')).toHaveCount(0);
    await carol.keyboard.press('Escape');
  });

  test('Dieselbe Mod sieht den Kick-Knopf für den rollenlosen dave', async () => {
    await expect(carol.getByTestId('member-list')).toBeVisible();
    const daveItem = carol.locator(`[data-testid="member-item"][data-user-id="${daveId}"]`);
    await expect(daveItem).toBeVisible({ timeout: 15_000 });
    await daveItem.click({ button: 'right' });
    await expect(
      carol.locator('[data-testid="user-profile-popover"][data-state="open"]')
    ).toBeVisible();
    await expect(carol.getByTestId('popover-kick-btn')).toBeVisible();
  });
});
