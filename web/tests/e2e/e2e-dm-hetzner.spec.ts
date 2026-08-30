/**
 * Zwei-Geräte-Nachweis gegen den REMOTE-Dev-Stack (Hetzner) — angepasst an
 * `e2e-dm.spec.ts`, aber mit Login statt Frischregistrierung und der
 * Postgres-Gegenprobe per SSH (`E2E_PG_VIA_SSH`, Container
 * `pulsetest_postgres`, DB `pulse`).
 *
 * Lauf (vom Repo-Root aus, Vite muss NICHT extra gestartet werden — der
 * `webServer`-Block startet ihn mit PULSE_API_ORIGIN auf den Hetzner):
 *
 *   cd web && pnpm exec playwright test tests/e2e/e2e-dm-hetzner.spec.ts \
 *     --config=tests/e2e/playwright.hetzner.config.ts
 *
 * Geprüft wird der zusammengesetzte Weg-A-Stand: Login → Geraete-Anmeldung
 * (runIssueFlow, ohne Zertifikat) → Schluesselbuendel veroeffentlicht →
 * verschluesselte DM → Empfaenger liest Klartext → der Server hat den
 * Klartext nie gesehen (chat.messages bleibt leer, Postfach quittiert leer).
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const SSH_ZIEL = process.env.E2E_PG_VIA_SSH ?? 'michael@77.42.71.166';

const DEV = { username: 'dev', password: 'test1234' };
const DEV2 = { username: 'dev2', password: 'test1234' };

/** Faengt die Vite-Dev-Antwort fuer `schalter.ts` ab und dreht die Konstante
 *  auf `true` — der Quelltext bleibt unangetastet (Muster wie e2e-dm.spec.ts). */
async function schalterEinschalten(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/krypto/schalter.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const gepatcht = text.replace('E2E_DMS_ENABLED = false', 'E2E_DMS_ENABLED = true');
    if (gepatcht === text) {
      throw new Error('Textmuster "E2E_DMS_ENABLED = false" nicht in schalter.ts gefunden');
    }
    await route.fulfill({ response: antwort, body: gepatcht });
  });
}

/** Taeuscht die Electron-Bruecke — die Koexistenz-Regel verschluesselt nur
 *  zwischen dauerhaften Geraeten (Muster wie e2e-dm.spec.ts). */
async function alsElektronGeraetAusgeben(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const leer = async () => undefined;
    const abmelden = () => () => undefined;
    (window as unknown as { pulse: unknown }).pulse = {
      platform: 'electron',
      appVersion: '0.0.0-e2e-stub',
      store: {
        get: leer,
        getAll: async () => ({}),
        getAllSync: () => ({}),
        set: leer,
        setAll: leer
      },
      gsr: {
        health: leer,
        gpuInfo: leer,
        listMonitors: leer,
        listWindows: leer,
        buildArgv: leer,
        start: leer,
        stop: leer,
        onEvent: abmelden
      },
      notify: { show: async () => 'stub', onClick: abmelden }
    };
  });
}

async function login(page: Page, u: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

async function currentUserId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = localStorage.getItem('dcc.tokens.access');
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub as string;
  });
  if (!value) throw new Error('kein Access-Token im localStorage');
  return value;
}

async function becomeFriends(pageA: Page, uidA: string, pageB: Page, uidB: string): Promise<void> {
  const send = async (page: Page, targetId: string) => {
    const r = await page.evaluate(async (uid) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch('/api/chat/friend-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target_user_id: uid })
      });
      return { status: resp.status, body: await resp.text() };
    }, targetId);
    // 201 = angelegt; 409/400 = besteht bereits — beides gut genug.
    if (r.status !== 201 && r.status !== 409 && r.status !== 400) {
      throw new Error(`friend-request failed ${r.status}: ${r.body}`);
    }
  };
  await send(pageA, uidB);
  await send(pageB, uidA);
}

async function createDmChannel(page: Page, targetUserId: string): Promise<string> {
  const resp = await page.evaluate(async (uid) => {
    const token = localStorage.getItem('dcc.tokens.access');
    const r = await fetch('/api/chat/dm-channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_user_id: uid })
    });
    return { status: r.status, body: await r.text() };
  }, targetUserId);
  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`dm-channels failed ${resp.status}: ${resp.body}`);
  }
  return (JSON.parse(resp.body) as { id: string }).id;
}

async function warteAufSchluesselbuendel(page: Page, userId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const antwort = await page.evaluate(async (uid) => {
          const token = localStorage.getItem('dcc.tokens.access');
          const r = await fetch('/api/chat/keys/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ user_ids: [uid] })
          });
          return { status: r.status, body: await r.text() };
        }, userId);
        if (antwort.status !== 200) return null;
        const geraete = (JSON.parse(antwort.body) as Record<string, { curve25519?: string }[]>)[
          userId
        ];
        return geraete?.find((g) => g.curve25519) ?? null;
      },
      { timeout: 20_000 }
    )
    .toBeTruthy();
}

/** Postgres-Gegenprobe per SSH gegen den Stack-Container. */
function pgQuery(sql: string): string {
  return execFileSync(
    'ssh',
    [
      SSH_ZIEL,
      `docker exec pulsetest_postgres psql -U pulse -d pulse -tAc "${sql.replace(/"/g, '\\"')}"`,
    ],
    { encoding: 'utf8' },
  ).trim();
}

function anhangSpalten(channelId: string): string[] {
  const raw = pgQuery(
    `SELECT coalesce(filename,'-') || '|' || coalesce(mime,'-') || '|' ` +
      `|| coalesce(width::text,'-') || '|' || coalesce(height::text,'-') || '|' ` +
      `|| coalesce(message_id::text,'-') ` +
      `FROM chat.message_attachments WHERE channel_id = ${channelId};`,
  );
  return raw ? raw.split('\n') : [];
}

function anzahlKlartextNachrichten(channelId: string): number {
  return Number(pgQuery(`SELECT count(*) FROM chat.messages WHERE channel_id = ${channelId};`));
}

function nutzlastDatenFuerKanal(channelId: string): string[] {
  const raw = pgQuery(
    `SELECT string_agg(daten, '|') FROM chat.dm_nutzlasten WHERE channel_id = ${channelId};`,
  );
  return raw ? raw.split('|') : [];
}

async function nutzlastDatenBisVorhanden(channelId: string, timeoutMs = 8_000): Promise<string[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const gefunden = nutzlastDatenFuerKanal(channelId);
    if (gefunden.length > 0) return gefunden;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

/** Raeumt die Alt-Geraete und alten Test-Kanaele beider Nutzer weg — jede
 *  Runde erzeugt frische Geraete; ohne Reset faechert jede Nachricht auch an
 *  die Verlassenen aus, deren Zustellungen nie quittiert werden koennen. */
function resetTestdaten(erster: string, zweiter: string): void {
  const ids = `select id from auth.users where username in ('${erster}','${zweiter}')`;
  pgQuery(
    `delete from chat.dm_zustellungen where nutzlast_id in ` +
      `(select id from chat.dm_nutzlasten where channel_id in ` +
      `(select id from chat.direct_message_channels where user_a_id in (${ids}) or user_b_id in (${ids})));`,
  );
  pgQuery(
    `delete from chat.dm_nutzlasten where channel_id in ` +
      `(select id from chat.direct_message_channels where user_a_id in (${ids}) or user_b_id in (${ids}));`,
  );
  pgQuery(
    `delete from chat.direct_message_channels where user_a_id in (${ids}) or user_b_id in (${ids});`,
  );
  pgQuery(`delete from chat.device_key_bundles where user_id in (${ids});`);
}

function anzahlOffenerZustellungen(channelId: string): number {
  return Number(
    pgQuery(
      `SELECT count(*) FROM chat.dm_zustellungen z ` +
        `JOIN chat.dm_nutzlasten n ON n.id = z.nutzlast_id ` +
        `WHERE n.channel_id = ${channelId};`,
    ),
  );
}

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
    '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae' +
    '426082',
  'hex'
);

test.describe.serial('Zwei-Geraete-Nachweis auf dem Hetzner-Stack (Weg A)', () => {
  let devCtx: BrowserContext;
  let devPage: Page;
  let dev2Ctx: BrowserContext;
  let dev2Page: Page;
  let dmChannelId = '';

  test.beforeAll(async ({ browser }) => {
    devCtx = await browser.newContext();
    dev2Ctx = await browser.newContext();
    for (const ctx of [devCtx, dev2Ctx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
      await schalterEinschalten(ctx);
      await alsElektronGeraetAusgeben(ctx);
    }
    devPage = await devCtx.newPage();
    dev2Page = await dev2Ctx.newPage();
    resetTestdaten('dev', 'dev2');
  });

  test.afterAll(async () => {
    await devCtx.close();
    await dev2Ctx.close();
  });

  test('dev und dev2 melden sich an, Buendel werden durch den Login-Hook veroeffentlicht', async () => {
    await login(devPage, DEV);
    await login(dev2Page, DEV2);
    const devId = await currentUserId(devPage);
    const dev2Id = await currentUserId(dev2Page);
    expect(devId).not.toEqual(dev2Id);

    await warteAufSchluesselbuendel(devPage, devId);
    await warteAufSchluesselbuendel(dev2Page, dev2Id);
  });

  test('Freundschaft, DM-Kanal, verschluesseltes Senden — der Server bleibt blind', async () => {
    const devId = await currentUserId(devPage);
    const dev2Id = await currentUserId(dev2Page);
    await becomeFriends(devPage, devId, dev2Page, dev2Id);
    dmChannelId = await createDmChannel(devPage, dev2Id);
    expect(dmChannelId).toMatch(/^\d+$/);

    await dev2Page.goto(`/app/@me/${dmChannelId}`);
    await expect(dev2Page.getByTestId('active-channel-name')).toHaveText('dev', {
      timeout: 15_000,
    });

    await devPage.goto(`/app/@me/${dmChannelId}`);
    const KLARTEXT = 'hetzner-nachweis nur dev und dev2 lesen das';

    await devPage.getByTestId('message-input').click();
    await devPage.getByTestId('message-input').fill(KLARTEXT);
    await devPage.getByTestId('message-input').press('Enter');

    const umschlaege = await nutzlastDatenBisVorhanden(dmChannelId);
    expect(umschlaege.length, 'kein Umschlag im Postfach gefunden').toBeGreaterThan(0);
    for (const daten of umschlaege) {
      expect(daten).not.toContain(KLARTEXT);
      const dekodiert = Buffer.from(daten, 'base64').toString('utf8');
      expect(dekodiert).not.toContain(KLARTEXT);
    }

    await expect(
      dev2Page.locator('[data-testid="message-content"]', { hasText: KLARTEXT })
    ).toBeVisible({ timeout: 15_000 });

    expect(anzahlKlartextNachrichten(dmChannelId)).toBe(0);
    await expect
      .poll(() => anzahlOffenerZustellungen(dmChannelId), { timeout: 15_000 })
      .toBe(0);
  });

  test('dev schickt dev2 einen Anhang verschlüsselt — Metadaten bleiben dem Server verborgen', async () => {
    await devPage.getByTestId('attachment-file-input').setInputFiles({
      name: 'geheim.png',
      mimeType: 'image/png',
      buffer: TINY_PNG,
    });
    await expect(devPage.getByTestId('attachment-preview')).toBeVisible({ timeout: 10_000 });
    await expect(devPage.getByTestId('message-send')).toBeEnabled({ timeout: 30_000 });

    const KRZEL = 'anhang-nachweis';
    await devPage.getByTestId('message-input').fill(KRZEL);
    await devPage.getByTestId('message-send').click();

    const dev2Zeile = dev2Page.getByTestId('message-item').filter({ hasText: KRZEL });
    await expect(dev2Zeile).toBeVisible({ timeout: 15_000 });
    const kachel = dev2Zeile.getByTestId('attachment-image');
    await expect(kachel).toBeVisible({ timeout: 15_000 });
    // Objekt-URL statt Objektspeicher-Verweis: Holen → Entschlüsseln → blob.
    await expect
      .poll(async () => (await kachel.locator('img').getAttribute('src')) ?? '', {
        timeout: 15_000,
      })
      .toMatch(/^blob:/);

    // Der Server speichert zu verschlüsselten Anhängen keine Beschreibung.
    const spalten = anhangSpalten(dmChannelId);
    expect(spalten.length).toBeGreaterThan(0);
    for (const zeile of spalten) {
      expect(zeile, 'Name/Typ/Maße/Nachrichtenzeile müssen alle NULL sein').toBe('-|-|-|-|-');
    }
  });

});
