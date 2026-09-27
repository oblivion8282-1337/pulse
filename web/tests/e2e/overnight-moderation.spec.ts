/**
 * T13 — Moderations-Warteschlange einer Community (Mod-Queue).
 *
 * Ablauf (serial, ein Guild-Verbund mit vier Konten):
 *   Besitzer + Mod (Rolle mit MANAGE_MESSAGES|BAN_MEMBERS|MANAGE_GUILD)
 *   + Melder + Ziel → Meldung über den Meldungs-Dialog (UI) → Mod öffnet
 *   das Warteschlangen-Panel im Community-Einstellungen-Dialog (Badge!)
 *   → mit Grund abschließen (API) → Meldung wandert in „Erledigt",
 *   Badge sinkt → Verwerfen senkt den Zähler ebenfalls → Audit-Log
 *   Eintrag → Bann-Fluss: „Bannen" sperrt das Ziel, Beitritt per Invite
 *   → 403 → Entbannen über „Gesperrt" → Beitritt klappt → >50 offene
 *   Meldungen: Pagination mit before/before_id (Komposit-Cursor) liefert
 *   Seite 2 lückenlos → ohne Mod-Rechte gibt es weder Tab noch API.
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
const PASSWORD = 'Mod!2026pass';
const OWNER = `ovn_mod_owner_${ts}`;
const MOD = `ovn_mod_mod_${ts}`;
const REPORTER = `ovn_mod_melder_${ts}`;
const TARGET = `ovn_mod_ziel_${ts}`;
const ACCOUNTS = [OWNER, MOD, REPORTER, TARGET].map((u) => ({
  username: u,
  email: `${u}@dcc-test.example.com`,
  password: PASSWORD
}));

// Permission-Bits (dcc_shared.permissions)
const MANAGE_GUILD = 1 << 1;
const BAN_MEMBERS = 1 << 9;
const MANAGE_MESSAGES = 1 << 23;

function pgQuery(sql: string): string {
  const db = process.env.PULSE_E2E_DB ?? 'dcc_test';
  return execSync(
    `${CONTAINER_EXEC} exec dcc_night_postgres psql -U dcc -d ${db} -tAc "${sql}"`,
    { encoding: 'utf8' }
  ).trim();
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

/** Authentifizierter chat-gateway-Fetch aus dem Browser-Context. */
async function chatApi<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: T | null }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
    { method, path, body }
  );
}

async function userId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    const payload = JSON.parse(atob(raw!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
}

/** Kanal kalt ansteuern: erst /app laden und den Community-Avatar abwarten
 *  (der Routen-Wächter wirft sonst auf die Freunde-Seite zurück, bevor die
 *  Guild-Liste geladen hat), dann in den Kanal gehen. */
async function oeffneKanal(page: Page, gid: string, channelId: string) {
  await page.goto('/app');
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`guild-${gid}`)).toBeVisible({ timeout: 15_000 });
  await page.goto(`/app/guilds/${gid}/channels/${channelId}`);
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
}

test.describe.serial('T13 — Moderations-Warteschlange', () => {
  test.setTimeout(180_000);

  let ownerPage: Page;
  let modPage: Page;
  let reporterPage: Page;
  let targetPage: Page;
  let gid = '';
  let channelId = '';
  let modUserId = '';
  let reporterUserId = '';
  let targetUserId = '';

  test.beforeAll(async ({ browser }) => {
    const ctxs: BrowserContext[] = [];
    for (let i = 0; i < 4; i++) ctxs.push(await browser.newContext());
    ownerPage = await ctxs[0].newPage();
    modPage = await ctxs[1].newPage();
    reporterPage = await ctxs[2].newPage();
    targetPage = await ctxs[3].newPage();
  });

  test.afterAll(async () => {
    for (const p of [ownerPage, modPage, reporterPage, targetPage]) {
      await p?.context().close();
    }
  });

  test('Setup: vier Konten, Community, Mod-Rolle, Kanal + Nachricht', async () => {
    for (let i = 0; i < ACCOUNTS.length; i++) {
      const p = [ownerPage, modPage, reporterPage, targetPage][i];
      await register(p, ACCOUNTS[i]);
    }
    modUserId = await userId(modPage);
    reporterUserId = await userId(reporterPage);
    targetUserId = await userId(targetPage);

    gid = (await chatApi<{ id: string }>(ownerPage, 'POST', '/guilds', { name: `Mod Guild ${ts}` }))
      .body!.id;

    for (const uid of [modUserId, reporterUserId, targetUserId]) {
      const add = await chatApi(ownerPage, 'POST', `/guilds/${gid}/members`, { user_id: uid });
      expect([200, 201]).toContain(add.status);
    }

    // Mod-Rolle (alle drei Mod-Rechte) + Zuweisung an den Mod
    const role = await chatApi<{ id: string }>(ownerPage, 'POST', `/guilds/${gid}/roles`, {
      name: 'Mod',
      permissions: String(MANAGE_GUILD | BAN_MEMBERS | MANAGE_MESSAGES)
    });
    expect(role.status).toBe(201);
    const assign = await chatApi(
      ownerPage,
      'PUT',
      `/guilds/${gid}/members/${modUserId}/roles/${role.body!.id}`
    );
    expect(assign.status).toBe(204);

    // Textkanal + gemeldete Nachricht vom Ziel
    const channel = await chatApi<{ id: string }>(ownerPage, 'POST', `/guilds/${gid}/channels`, {
      name: 'allgemein',
      type: 0
    });
    expect(channel.status).toBe(201);
    channelId = channel.body!.id;
    const msg = await chatApi<{ id: string }>(
      targetPage,
      'POST',
      `/channels/${channelId}/messages`,
      { content: 'Diese Nachricht hier wird gemeldet.' }
    );
    expect(msg.status).toBe(201);
  });

  test('Melder meldet die Nachricht über den Dialog (UI)', async () => {
    await oeffneKanal(reporterPage, gid, channelId);
    await expect(
      reporterPage.locator('[data-testid="message-content"]', {
        hasText: 'Diese Nachricht hier wird gemeldet.'
      })
    ).toBeVisible({ timeout: 15_000 });

    // Die Aktionsleiste erscheint erst beim Überfahren der Nachrichtenzeile
    await reporterPage
      .locator('[data-testid="message-content"]', {
        hasText: 'Diese Nachricht hier wird gemeldet.'
      })
      .hover();
    await reporterPage.getByTestId('message-action-report').click();
    const dialog = reporterPage.getByTestId('report-message-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('report-body-textarea').fill('E2E: gemeldete Testnachricht.');
    await dialog.getByTestId('report-submit').click();
    await expect(
      reporterPage.getByText('Meldung gesendet — Mods werden das prüfen.')
    ).toBeVisible({ timeout: 7_000 });
  });

  test('Mod sieht die Meldung im Panel — Badge zeigt 1', async () => {
    await oeffneKanal(modPage, gid, channelId);
    await modPage.getByTestId(`guild-${gid}`).click({ button: 'right' });
    await modPage.getByTestId('guild-settings').click();
    await expect(modPage.getByTestId('guild-settings-dialog')).toBeVisible();
    await expect(modPage.getByTestId('settings-tab-modqueue')).toBeVisible();
    await expect(modPage.getByTestId('modqueue-tab-badge')).toHaveText('1', { timeout: 10_000 });

    await modPage.getByTestId('settings-tab-modqueue').click();
    const panel = modPage.getByTestId('mod-queue-panel');
    await expect(panel).toBeVisible();
    await expect(modPage.getByTestId('modqueue-report')).toHaveCount(1);
    await expect(panel.getByText('E2E: gemeldete Testnachricht.')).toBeVisible();
  });

  test('Abschließen mit Grund → Meldung in „Erledigt", Badge weg', async () => {
    const reportId = (await chatApi<{ id: string }[]>(modPage, "GET", `/guilds/${gid}/mod-queue?status=new`))
      .body![0].id;
    const resolved = await chatApi<{ status: string; resolution_note: string }>(
      modPage,
      'POST',
      `/guilds/${gid}/mod-queue/${reportId}/resolve`,
      { resolution: 'resolved', resolution_note: 'E2E-Grund: geklärt.' }
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body!.status).toBe('resolved');
    expect(resolved.body!.resolution_note).toBe('E2E-Grund: geklärt.');

    // Badge leert sich live (WS). Die OFFENE Liste selbst lädt erst beim
    // Tab-Wechsel neu — das leere Bild prüfen wir deshalb nach dem Rutsch
    // über „Erledigt" und zurück.
    await expect(modPage.getByTestId('modqueue-tab-badge')).toHaveCount(0, { timeout: 10_000 });

    // Erledigt-Tab: Ausgang „Erledigt" + Notiz sichtbar
    await modPage.getByTestId('modqueue-tab-closed').click();
    const closed = modPage.getByTestId('modqueue-report');
    await expect(closed).toHaveCount(1);
    await expect(closed.first().getByTestId('modqueue-outcome')).toHaveText('Erledigt');
    await expect(modPage.getByText('Notiz: E2E-Grund: geklärt.')).toBeVisible();

    // Zurück zu Offen: neu geladen und leer
    await modPage.getByTestId('modqueue-tab-open').click();
    await expect(modPage.getByText('Keine Reports in dieser Kategorie.')).toBeVisible({
      timeout: 10_000
    });
  });

  test('Verwerfen senkt den offenen Zähler ebenfalls', async () => {
    // Zwei weitere Meldungen per API (UI-Weg ist oben abgedeckt)
    for (const body of ['zweite Meldung', 'dritte Meldung']) {
      const r = await chatApi<{ id: string }>(reporterPage, 'POST', '/reports', {
        target_user_id: targetUserId,
        target_guild_id: gid,
        reason_code: 'spam',
        body
      });
      expect(r.status).toBe(201);
    }
    await expect(modPage.getByTestId('modqueue-tab-badge')).toHaveText('2', { timeout: 10_000 });

    // Erste per Knopfdruck verwerfen …
    await modPage.getByTestId('modqueue-tab-open').click();
    const first = modPage.getByTestId('modqueue-report').first();
    await first.getByTestId('modqueue-dismiss-btn').click();
    await expect(modPage.getByTestId('modqueue-tab-badge')).toHaveText('1', { timeout: 10_000 });

    // … zweite per API.
    const rest = await chatApi<{ id: string }[]>(modPage, "GET", `/guilds/${gid}/mod-queue?status=new`);
    expect(rest.body!.length).toBe(1);
    const dismissed = await chatApi(modPage, 'POST', `/guilds/${gid}/mod-queue/${rest.body![0].id}/resolve`, {
      resolution: 'dismissed'
    });
    expect(dismissed.status).toBe(200);
    await expect(modPage.getByTestId('modqueue-tab-badge')).toHaveCount(0, { timeout: 10_000 });
  });

  test('Audit-Log führt die Entscheidungen (Tab + API)', async () => {
    const entries = await chatApi<{ action_type: string; payload: Record<string, unknown> }[]>(
      modPage,
      'GET',
      `/guilds/${gid}/mod-audit-log`
    );
    expect(entries.status).toBe(200);
    const actions = entries.body!.map((e) => e.action_type);
    expect(actions).toContain('report_resolved');
    expect(actions).toContain('report_dismissed');

    // UI: Protokoll-Reiter im Community-Einstellungen-Dialog listet die Einträge
    await modPage.getByTestId('settings-tab-auditlog').click();
    await expect(modPage.getByTestId('audit-log-panel')).toBeVisible();
    await expect(modPage.getByTestId('audit-log-entry').first()).toBeVisible();
  });

  test('Bann-Fluss: „Bannen" sperrt das Ziel', async () => {
    const r = await chatApi<{ id: string }>(reporterPage, 'POST', '/reports', {
      target_user_id: targetUserId,
      target_guild_id: gid,
      reason_code: 'harassment',
      body: 'vierte Meldung — Bann-Fluss'
    });
    expect(r.status).toBe(201);
    await expect(modPage.getByTestId('modqueue-tab-badge')).toHaveText('1', { timeout: 10_000 });

    // Frisch ausgehender Dialog-Zustand: Sicherheitshalber schließen und
    // neu öffnen — der Offen-Tab lädt beim Reiter-Wechsel ohnehin neu.
    await modPage.keyboard.press('Escape');
    await modPage.getByTestId(`guild-${gid}`).click({ button: 'right' });
    await modPage.getByTestId('guild-settings').click();
    await expect(modPage.getByTestId('guild-settings-dialog')).toBeVisible();
    await modPage.getByTestId('settings-tab-modqueue').click();
    await expect(modPage.getByTestId('mod-queue-panel')).toBeVisible();

    await modPage.getByTestId('modqueue-ban-btn').first().click();
    const banDialog = modPage.getByTestId('modqueue-ban-dialog');
    await expect(banDialog).toBeVisible();
    await modPage.getByTestId('modqueue-ban-reason').fill('E2E-Bann: wiederholte Störung.');
    await banDialog.getByRole('button', { name: 'Bannen', exact: true }).click();

    // Meldung geschlossen, Ziel steht auf der Bannliste
    await expect(modPage.getByTestId('modqueue-tab-badge')).toHaveCount(0, { timeout: 10_000 });

    const bans = await chatApi<{ user_id: string; reason: string | null }[]>(
      modPage,
      'GET',
      `/guilds/${gid}/bans`
    );
    expect(bans.status).toBe(200);
    const entry = bans.body!.find((b) => b.user_id === targetUserId);
    expect(entry, 'Ziel auf der Bannliste').toBeTruthy();
  });

  test('Gebannt: Beitritt per Invite → 403', async () => {
    const invite = await chatApi<{ code: string }>(ownerPage, 'POST', `/guilds/${gid}/invites`, {
      max_uses: 5,
      expires_in_seconds: 3600
    });
    expect(invite.status).toBe(201);

    // Das Ziel ist nach dem Bann aus der Community draußen — ein zweiter
    // Beitritt per Invite wird mit 403 abgewiesen.
    const left = await chatApi(targetPage, 'GET', '/guilds');
    const nochDrin = (left.body as { id: string }[] | null)?.some((g) => g.id === gid) ?? false;
    if (nochDrin) {
      const leave = await chatApi(targetPage, 'DELETE', `/guilds/${gid}/members/@me`);
      expect([200, 204]).toContain(leave.status);
    }

    const join = await chatApi(targetPage, 'POST', `/invites/${invite.body!.code}/accept`);
    expect(join.status).toBe(403);
  });

  test('Entbannen über „Gesperrt" → Beitritt klappt wieder', async () => {
    await modPage.getByTestId('modqueue-tab-banned').click();
    // Über data-user-id gehen — der Anzeigename kommt asynchron aus dem
    // Nutzer-Cache und ist beim ersten Rendern noch nicht da.
    const entry = modPage.locator(`[data-testid="bans-entry"][data-user-id="${targetUserId}"]`);
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.getByTestId('bans-unban-btn').click();
    await expect(modPage.getByTestId('bans-entry')).toHaveCount(0, { timeout: 10_000 });

    // Entsperrtes Konto kommt per Invite wieder hinein
    const invite = await chatApi<{ code: string }>(ownerPage, 'POST', `/guilds/${gid}/invites`, {
      max_uses: 5,
      expires_in_seconds: 3600
    });
    const join = await chatApi(targetPage, 'POST', `/invites/${invite.body!.code}/accept`);
    expect([200, 201]).toContain(join.status);
  });

  test('>50 offene Meldungen: Pagination mit before/before_id ist lückenlos', async () => {
    // 55 Zeilen per psql (Report-Limit 10/Stunde je Melder macht den API-Weg
    // unmöglich). ALLE mit demselben created_at — genau der
    // Gleichzeitigkeits-Fall, für den es den ID-Tiebreak gibt (Runde 23).
    // BigInt, weil 9e17 jenseits von Number.MAX_SAFE_INTEGER liegt und
    // `+ i` sonst lautlos dieselbe Zahl liefert → doppelte IDs.
    const inserts: string[] = [];
    for (let i = 0; i < 55; i++) {
      const id = 900000000000000000n + BigInt(i);
      inserts.push(
        `INSERT INTO chat.reports (id, reporter_user_id, target_user_id, target_guild_id, reason_code, body, status, created_at) VALUES (${id}, ${reporterUserId}, ${targetUserId}, ${gid}, 'spam', 'pagetest ${i}', 'new', now())`
      );
    }
    pgQuery(`BEGIN; ${inserts.join('; ')}; COMMIT;`);

    const page1 = await chatApi<{ id: string; created_at: string }[]>(
      modPage,
      'GET',
      `/guilds/${gid}/mod-queue?status=new&limit=50`
    );
    expect(page1.status).toBe(200);
    expect(page1.body!.length).toBe(50);

    const letzte = page1.body![49];
    const page2 = await chatApi<{ id: string }[]>(
      modPage,
      'GET',
      `/guilds/${gid}/mod-queue?status=new&limit=50&before=${encodeURIComponent(
        letzte.created_at
      )}&before_id=${letzte.id}`
    );
    expect(page2.status).toBe(200);
    expect(page2.body!.length).toBe(5);

    const ids1 = new Set(page1.body!.map((r) => r.id));
    const ids2 = new Set(page2.body!.map((r) => r.id));
    expect(ids1.size).toBe(50);
    for (const id of ids2) expect(ids1.has(id), 'Seiten dürfen sich nicht überschneiden').toBe(false);
    expect(ids1.size + ids2.size).toBe(55);

    // Aufräumen, damit die offene Bilanz der Community wieder stimmt
    pgQuery(
      'DELETE FROM chat.reports WHERE id BETWEEN 900000000000000000 AND 900000000000000054;'
    );
  });

  test('Ohne Mod-Rechte: kein Einstiegs-Icon, API → 403', async () => {
    await oeffneKanal(reporterPage, gid, channelId);
    // Ein simpler Mitglieder-Account bekommt das Rail-Kontextmenü gar nicht
    // erst mit dem Einstellungen-Eintrag (nur Rollen/Verwaltung/Mod/Owner
    // sehen ihn) — asserted wird deshalb das Fehlen des Eintrags.
    await reporterPage.getByTestId(`guild-${gid}`).click({ button: 'right', force: true });
    await expect(reporterPage.getByTestId('guild-settings')).toHaveCount(0);
    if ((await reporterPage.getByTestId('guild-settings').count()) === 0) {
      await reporterPage.keyboard.press('Escape');
    }

    const denied = await chatApi(reporterPage, 'GET', `/guilds/${gid}/mod-queue?status=new`);
    expect(denied.status).toBe(403);
  });
});
