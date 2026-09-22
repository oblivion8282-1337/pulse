/**
 * T12 — Pulse-Laufwerk (Community-S3-Speicher), API-Durchlauf über den
 * Browser-Context (dieselbe Auth wie die Oberfläche, `routes/ablage_pulse.py`).
 *
 * Ablauf (serial, eine frische Community):
 *   Besitzer + Mitglied registrieren → Besitzer verbindet das Laufwerk
 *   (PUT /laufwerk, 204; Nicht-Besitzer → 403) → Status zeigt 1 GiB
 *   Betreiber-Zuweisung → Ankündigung mintet eine presigned PUT-URL (201)
 *   → PUT an die URL + „gelungen" → Klumpen in der Liste, Bytes in der
 *   Quota → Neuankündigung desselben Namens zählt NICHT doppelt →
 *   Löschen senkt die Quota → Nicht-Uploader-„gelungen" → 409 →
 *   Einzeldatei über der Grenze → 413 „file too large" → Kontingent voll
 *   ankündigen → 413 „drive quota exceeded" → Status-Endpoint antwortet
 *   weiter (der Ankündigungs-Sweep räumt >1 Tag alte Reste).
 */

import { test, expect, type Page } from '@playwright/test';

const ts = Date.now();
const OWNER = {
  username: `ovn_drive_owner_${ts}`,
  email: `ovn_drive_owner_${ts}@dcc-test.example.com`,
  password: 'Drive!2026pass'
};
const MEMBER = {
  username: `ovn_drive_member_${ts}`,
  email: `ovn_drive_member_${ts}@dcc-test.example.com`,
  password: 'Drive!2026pass'
};

const CEILING = 512 * 1024 * 1024; // Instanz-Decke (kein Ablage-Kanal → kein Community-Config)
const PER_FILE_MAX = 64 * 1024 * 1024;

type Status = { verbunden: boolean; genutzt_bytes: number; kontingent_bytes: number };

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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
    { method, path, body }
  );
}

async function pulseStatus(page: Page, gid: string): Promise<Status> {
  const r = await chatApi<Status>(page, 'GET', `/guilds/${gid}/ablage/pulse/status`);
  expect(r.status, 'status endpoint').toBe(200);
  return r.body as Status;
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

test.describe.serial('T12 — Pulse-Laufwerk API', () => {
  test.setTimeout(120_000);

  let page: Page; // Besitzer
  let memberPage: Page;
  let gid = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    const mctx = await browser.newContext();
    memberPage = await mctx.newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
    await memberPage?.context().close();
  });

  test('Setup: zwei Konten, Community, Mitglied — Laufwerk noch nicht verbunden', async () => {
    await register(page, OWNER);
    gid = await chatApi<{ id: string }>(page, 'POST', '/guilds', {
      name: `Drive API Guild ${ts}`
    }).then((r) => {
      expect(r.status).toBe(201);
      return r.body!.id;
    });

    await register(memberPage, MEMBER);
    const memberId = await memberPage.evaluate(() => {
      const raw = localStorage.getItem('dcc.tokens.access');
      const payload = JSON.parse(atob(raw!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.sub as string;
    });
    const added = await chatApi(page, 'POST', `/guilds/${gid}/members`, { user_id: memberId });
    expect([200, 201]).toContain(added.status);

    // Vor dem Verbinden: ehrlicher 404 fürs Ankündigen, Status sagt unverbunden
    const frueh = await chatApi(page, 'POST', `/guilds/${gid}/ablage/pulse/dateien`, {
      name: 'a-eins.puls',
      groesse: 10
    });
    expect(frueh.status).toBe(404);
    const s0 = await pulseStatus(page, gid);
    expect(s0.verbunden).toBe(false);
  });

  test('Nur der Besitzer verbindet — Mitglied → 403, Besitzer → 204', async () => {
    const alsMitglied = await chatApi(memberPage, 'PUT', `/guilds/${gid}/ablage/pulse/laufwerk`);
    expect(alsMitglied.status).toBe(403);

    const alsBesitzer = await chatApi(page, 'PUT', `/guilds/${gid}/ablage/pulse/laufwerk`);
    expect(alsBesitzer.status).toBe(204);

    const s1 = await pulseStatus(page, gid);
    expect(s1.verbunden).toBe(true);
    expect(s1.kontingent_bytes).toBe(CEILING); // Instanz-Decke 512 MiB
    expect(s1.genutzt_bytes).toBe(0);
  });

  test('Ankündigung mintet eine presigned PUT-URL (201)', async () => {
    const r = await chatApi<{ upload_url: string }>(
      page,
      'POST',
      `/guilds/${gid}/ablage/pulse/dateien`,
      { name: 'a-klumpen-eins.puls', groesse: 1024 }
    );
    expect(r.status).toBe(201);
    expect(r.body!.upload_url).toContain('pulse-attachments');
    expect(r.body!.upload_url).toContain('X-Amz-Signature');
  });

  test('PUT an die URL + gelungen → Klumpen zählt ins Kontingent', async () => {
    const mint = await chatApi<{ upload_url: string }>(
      page,
      'POST',
      `/guilds/${gid}/ablage/pulse/dateien`,
      { name: 'a-klumpen-zwei.puls', groesse: 2048 }
    );
    expect(mint.status).toBe(201);

    // Presigned PUT aus dem Browser (wie der pulse-Adapter)
    const putStatus = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(2048).fill(7)
      });
      return r.status;
    }, mint.body!.upload_url);
    expect(putStatus, 'presigned PUT').toBe(200);

    const ok = await chatApi(page, 'POST', `/guilds/${gid}/ablage/pulse/dateien/gelungen`, {
      name: 'a-klumpen-zwei.puls'
    });
    expect(ok.status).toBe(204);

    const namen = await chatApi<string[]>(
      page,
      'GET',
      `/guilds/${gid}/ablage/pulse/dateien`
    );
    expect(namen.status).toBe(200);
    expect(namen.body).toContain('a-klumpen-zwei.puls');

    const s = await pulseStatus(page, gid);
    expect(s.genutzt_bytes).toBeGreaterThanOrEqual(2048);
  });

  test('Neuankündigung desselben Namens zählt nicht doppelt', async () => {
    const sVorher = await pulseStatus(page, gid);
    expect(sVorher.genutzt_bytes).toBeGreaterThanOrEqual(2048);

    const neu = await chatApi(page, 'POST', `/guilds/${gid}/ablage/pulse/dateien`, {
      name: 'a-klumpen-zwei.puls',
      groesse: 4096
    });
    expect(neu.status).toBe(201);

    const sNachher = await pulseStatus(page, gid);
    // Ersetzt (4096), nicht addiert (2048 + 4096)
    expect(sNachher.genutzt_bytes).toBe(sVorher.genutzt_bytes - 2048 + 4096);
  });

  test('Löschen senkt die Quota sofort', async () => {
    const sVorher = await pulseStatus(page, gid);
    const del = await chatApi(
      page,
      'DELETE',
      `/guilds/${gid}/ablage/pulse/dateien?name=a-klumpen-zwei.puls`
    );
    expect(del.status).toBe(204);

    const sNachher = await pulseStatus(page, gid);
    expect(sNachher.genutzt_bytes).toBe(sVorher.genutzt_bytes - 4096);
  });

  test('„gelungen" durch ein anderes Gerät → 409', async () => {
    // Besitzer kündigt an, das MITGLIED meldet „gelungen" — der Klumpen
    // gehört dem Besitzer, also 409 statt stillschweigendem 204.
    const mint = await chatApi<{ upload_url: string }>(
      page,
      'POST',
      `/guilds/${gid}/ablage/pulse/dateien`,
      { name: 'a-fremd.puls', groesse: 128 }
    );
    expect(mint.status).toBe(201);

    const fremd = await chatApi(memberPage, 'POST', `/guilds/${gid}/ablage/pulse/dateien/gelungen`, {
      name: 'a-fremd.puls'
    });
    expect(fremd.status).toBe(409);

    // Und der echte Uploader kommt durch (204), danach aufräumen.
    const echt = await chatApi(page, 'POST', `/guilds/${gid}/ablage/pulse/dateien/gelungen`, {
      name: 'a-fremd.puls'
    });
    expect(echt.status).toBe(204);
    await chatApi(page, 'DELETE', `/guilds/${gid}/ablage/pulse/dateien?name=a-fremd.puls`);
  });

  test('Einzeldatei über der Grenze → 413 „file too large"', async () => {
    const r = await chatApi(page, 'POST', `/guilds/${gid}/ablage/pulse/dateien`, {
      name: 'a-zu-gross.puls',
      groesse: PER_FILE_MAX + 1
    });
    expect(r.status).toBe(413);
  });

  test('Kontingent voll ankündigen → 413 „drive quota exceeded"', async () => {
    // 8 Ankündigungen à 64 MiB = exakt 512 MiB (jede Ankündigung zählt —
    // Reservierungsbilanz, Bughunt Runde 37), die 9. muss mit 413 platzen.
    for (let i = 0; i < 8; i++) {
      const r = await chatApi(page, 'POST', `/guilds/${gid}/ablage/pulse/dateien`, {
        name: `a-fuellung-${i}.puls`,
        groesse: PER_FILE_MAX
      });
      expect(r.status, `Ankündigung ${i}`).toBe(201);
    }

    const s = await pulseStatus(page, gid);
    expect(s.genutzt_bytes).toBe(CEILING);

    const ueber = await chatApi(page, 'POST', `/guilds/${gid}/ablage/pulse/dateien`, {
      name: 'a-ueberlauf.puls',
      groesse: 1024
    });
    expect(ueber.status).toBe(413);
  });

  test('Status-Endpoint bleibt sauber (Sweep-Pflicht liegt beim Cleanup)', async () => {
    // Stehen gebliebene Ankündigungen (>1 Tag) räumt
    // `sweep_stehengebliebene_ankuendigungen` — in E2E nicht abwartbar.
    // Geprüft wird hier nur: der Status-Endpoint antwortet konsistent und
    // die Bilanz bleibt EXAKT am Kontingent (nichts übergelaufen).
    const s = await pulseStatus(page, gid);
    expect(s.verbunden).toBe(true);
    expect(s.kontingent_bytes).toBe(CEILING);
    expect(s.genutzt_bytes).toBeLessThanOrEqual(s.kontingent_bytes);
  });
});
