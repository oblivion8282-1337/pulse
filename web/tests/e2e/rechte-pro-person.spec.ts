import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rechte pro Person — der Nachweis für die zwei Flächen, auf denen eine
 * Community Einzelnmitglieder konfiguriert (2026-09-11):
 *
 *   A. KANAL-EBENE: User-Overwrites (target_type 1) je Kanal — inklusive
 *      der Voice-Bits (CONNECT/SPEAK/STREAM), die den Bühnen-Zugang je
 *      Person einzeln regeln. User-Overwrite schlägt dabei die Rollen-Ebene
 *      (allow für EINE Person, während @everyone deny trägt).
 *   B. COMMUNITY-EBENE: Rollen an Einzelne — @everyone wird ein Bit
 *      entzogen, eine Einzelrolle gibt es gezielt zurück; plus Anti-
 *      Eskalation und Hierarchie live (niederer Mod gegen Owner/Peers).
 *
 * Server-Wahrheit steht im Vordergrund (`/permissions/me`,
 * stream-token-403, message-403): UI-Gates spiegeln dieselben Bits, aber
 * der Riegel, der zählt, ist der Server. UI-Probes (Schloss, Kanal-
 * verschwinden) ergänzen die zwei sichtbarsten Fälle.
 *
 * Bits (shared/dcc_shared/permissions.py): VIEW=20 READ=21 SEND=22
 * MANAGE_MESSAGES=23 CONNECT=30 SPEAK=31 STREAM=32 KICK=8 MANAGE_ROLES=3.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const ts = Date.now();
const OWNER = {
  username: `permown_${ts}`,
  email: `permown_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `permbob_${ts}`,
  email: `permbob_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const CAROL = {
  username: `permcarol_${ts}`,
  email: `permcarol_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

const bit = (n: number) => (1n << BigInt(n)).toString();
const VIEW = bit(20);
const SEND = bit(22);
const MANAGE_MESSAGES = bit(23);
const KICK = bit(8);
const MANAGE_ROLES = bit(3);

async function register(page: Page, u: typeof OWNER) {
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

/** API-Abruf im Seitenkontext; liefert den Status MIT, damit 403-Behauptungen
 *  möglich sind (Vorlage: channel-permissions.spec.ts, um den Status erweitert). */
async function apiStatus(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ path, init }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat${path}`, {
        method: init?.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body)
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
    { path, init }
  );
}

async function api<T>(page: Page, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await apiStatus(page, path, init);
  if (r.status >= 300) {
    throw new Error(`${path} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body as T;
}

/** Aufgelöste Kanal-Rechte der eigenen Person — die Server-Wahrheit. */
async function meineKanalRechte(page: Page, channelId: string): Promise<string> {
  const r = await api<{ permissions: string }>(page, `/channels/${channelId}/permissions/me`);
  return r.permissions;
}

async function hatBit(bitfield: string, bitWert: string): Promise<boolean> {
  return (BigInt(bitfield) & BigInt(bitWert)) !== 0n;
}

test.describe.serial('Rechte pro Person: Kanal-Overwrites (inkl. Voice) und Einzel-Rollen', () => {
  let ownerCtx: BrowserContext;
  let bobCtx: BrowserContext;
  let carolCtx: BrowserContext;
  let owner: Page;
  let bob: Page;
  let carol: Page;
  let guildId = '';
  let bobId = '';
  let carolId = '';
  let textId = '';
  let kantineId = '';
  let buehneId = '';
  let everyoneRoleId = '';

  test.beforeAll(async ({ browser }) => {
    ownerCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    carolCtx = await browser.newContext();
    for (const ctx of [ownerCtx, bobCtx, carolCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    owner = await ownerCtx.newPage();
    bob = await bobCtx.newPage();
    carol = await carolCtx.newPage();
  });

  test.afterAll(async () => {
    await ownerCtx.close();
    await bobCtx.close();
    await carolCtx.close();
  });

  test('setup: drei Nutzer, eine Community, Text- und Voice-Kanäle', async () => {
    await register(owner, OWNER);
    await register(bob, BOB);
    await register(carol, CAROL);

    await owner.locator('[data-testid^="guild-create-menu-"]').first().click();
    await owner.getByTestId('guild-create').click();
    await owner.getByTestId('create-guild-name').fill('Pro Person Guild');
    await owner.getByTestId('create-guild-submit').click();
    await owner.waitForURL(/\/app\/guilds\/(\d+)\/channels\/(\d+)/);
    guildId = owner.url().match(/\/app\/guilds\/(\d+)/)![1];

    const invite = await api<{ code: string }>(owner, `/guilds/${guildId}/invites`, {
      method: 'POST',
      body: { max_uses: 5, expires_in_seconds: 86400 }
    });
    for (const page of [bob, carol]) {
      await page.locator('[data-testid^="guild-create-menu-"]').first().click();
      await page.getByTestId('guild-join').click();
      await page.getByTestId('join-guild-input').fill(invite.code);
      await page.getByTestId('join-guild-submit').click();
      await page.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/, { timeout: 15_000 });
    }

    for (const [page, name] of [
      [bob, BOB.username],
      [carol, CAROL.username]
    ] as const) {
      const id = await page.evaluate(() => {
        const raw = localStorage.getItem('dcc.tokens.access')!;
        return JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
      });
      if (name === BOB.username) bobId = id;
      else carolId = id;
    }

    const rollen = await api<{ id: string; is_everyone: boolean }[]>(owner, `/guilds/${guildId}/roles`);
    everyoneRoleId = rollen.find((r) => r.is_everyone)!.id;

    textId = (
      await api<{ id: string }>(owner, `/guilds/${guildId}/channels`, {
        method: 'POST',
        body: { name: 'testtext', type: 0 }
      })
    ).id;
    kantineId = (
      await api<{ id: string }>(owner, `/guilds/${guildId}/channels`, {
        method: 'POST',
        body: { name: 'kantine', type: 0 }
      })
    ).id;
    buehneId = (
      await api<{ id: string }>(owner, `/guilds/${guildId}/channels`, {
        method: 'POST',
        body: { name: 'buehne', type: 1 }
      })
    ).id;
  });

  test('A1: User-Overwrite entzieht EINER Person den Kanal — die andere sieht ihn weiter', async () => {
    // Bob persönlich aus der Kantine aussperren (nur Bob, nicht carol).
    await api(owner, `/channels/${kantineId}/permissions/1/${bobId}`, {
      method: 'PUT',
      body: { allow: '0', deny: VIEW }
    });

    await bob.reload();
    await expect(bob.getByTestId(`channel-${kantineId}`)).toHaveCount(0);
    await carol.reload();
    await expect(carol.getByTestId(`channel-${kantineId}`).first()).toBeVisible({ timeout: 15_000 });

    // Server-Wahrheit je Person …
    expect(await hatBit(await meineKanalRechte(bob, kantineId), VIEW)).toBe(false);
    expect(await hatBit(await meineKanalRechte(carol, kantineId), VIEW)).toBe(true);
    // … und 404-statt-403 beim direkten Zugriff (keine Existenz-Leak).
    expect((await apiStatus(bob, `/channels/${kantineId}`)).status).toBe(404);

    // Overwrite weg — Bob sieht den Kanal wieder (rücknehmbar).
    await api(owner, `/channels/${kantineId}/permissions/1/${bobId}`, { method: 'DELETE' });
    await bob.reload();
    await expect(bob.getByTestId(`channel-${kantineId}`).first()).toBeVisible({ timeout: 15_000 });
    expect(await hatBit(await meineKanalRechte(bob, kantineId), VIEW)).toBe(true);
  });

  test('A2: User-allow schlägt @everyone-deny — die persönliche Ausnahme', async () => {
    // Kantine exklusiv für niemanden … außer carol (Einzel-Ausnahme oben drauf).
    await api(owner, `/channels/${kantineId}/permissions/0/${everyoneRoleId}`, {
      method: 'PUT',
      body: { allow: '0', deny: VIEW }
    });
    await api(owner, `/channels/${kantineId}/permissions/1/${carolId}`, {
      method: 'PUT',
      body: { allow: VIEW, deny: '0' }
    });

    expect(await hatBit(await meineKanalRechte(bob, kantineId), VIEW)).toBe(false);
    expect(await hatBit(await meineKanalRechte(carol, kantineId), VIEW)).toBe(true);
    expect(await hatBit(await meineKanalRechte(owner, kantineId), VIEW)).toBe(true);

    await carol.reload();
    await expect(carol.getByTestId(`channel-${kantineId}`).first()).toBeVisible({ timeout: 15_000 });
    await bob.reload();
    await expect(bob.getByTestId(`channel-${kantineId}`)).toHaveCount(0);
  });

  test('A3: Voice-Bits pro Person — SPEAK/CONNECT einzeln, STREAM mit echtem 403', async () => {
    // @everyone darf zuhören und reden; bob persönlich stumm (SPEAK weg),
    // carol persönlich gar nicht hinein (CONNECT weg).
    await api(owner, `/channels/${buehneId}/permissions/1/${bobId}`, {
      method: 'PUT',
      body: { allow: '0', deny: bit(31) }
    });
    await api(owner, `/channels/${buehneId}/permissions/1/${carolId}`, {
      method: 'PUT',
      body: { allow: '0', deny: bit(30) }
    });

    const bobRechte = await meineKanalRechte(bob, buehneId);
    const carolRechte = await meineKanalRechte(carol, buehneId);
    expect(await hatBit(bobRechte, bit(30))).toBe(true); // CONNECT bleibt
    expect(await hatBit(bobRechte, bit(31))).toBe(false); // SPEAK weg
    expect(await hatBit(carolRechte, bit(30))).toBe(false); // CONNECT weg
    expect(await hatBit(carolRechte, bit(31))).toBe(true); // SPEAK bliebe — aber CONNECT fehlt

    // STREAM exklusiv für bob: @everyone-deny + Einzel-allow …
    await api(owner, `/channels/${buehneId}/permissions/0/${everyoneRoleId}`, {
      method: 'PUT',
      body: { allow: '0', deny: bit(32) }
    });
    // (@everyone-deny VIEW von A2 wirkt nur auf die Kantine, nicht hier.)
    await api(owner, `/channels/${buehneId}/permissions/1/${bobId}`, {
      method: 'PUT',
      body: { allow: bit(32), deny: bit(31) }
    });

    // … und der Server-Riegel: stream-token nur mit STREAM.
    const bobToken = await apiStatus(bob, `/channels/${buehneId}/stream-token`, {
      method: 'POST',
      body: { protocol: 'rtmp', slot: 0 }
    });
    const carolToken = await apiStatus(carol, `/channels/${buehneId}/stream-token`, {
      method: 'POST',
      body: { protocol: 'rtmp', slot: 0 }
    });
    expect([200, 201, 502]).toContain(bobToken.status); // Rechte ok (502: media-svc im Testlauf nicht da)
    expect(carolToken.status).toBe(403);
  });

  test('B1: Community-weit pro Person — @everyone SEND entzogen, Einzelrolle gibt es zurück', async () => {
    // @everyone das Senden im GANZEN Server nehmen (Rollen-Patch) …
    const alle = await api<{ id: string; is_everyone: boolean; permissions: string }[]>(
      owner,
      `/guilds/${guildId}/roles`
    );
    const everyone = alle.find((r) => r.is_everyone)!;
    const ohneSend = (BigInt(everyone.permissions) & ~BigInt(SEND)).toString();
    await api(owner, `/guilds/${guildId}/roles/${everyone.id}`, {
      method: 'PATCH',
      body: { permissions: ohneSend }
    });

    expect(await hatBit(await meineKanalRechte(carol, textId), SEND)).toBe(false);
    const carolVersuch = await apiStatus(carol, `/channels/${textId}/messages`, {
      method: 'POST',
      body: { content: 'darf ich das?' }
    });
    expect(carolVersuch.status).toBe(403);

    // … und bob über eine Einzelrolle gezielt zurückgeben.
    const rolle = await api<{ id: string }>(owner, `/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'Einzelredner', permissions: SEND }
    });
    await api(owner, `/guilds/${guildId}/members/${bobId}/roles/${rolle.id}`, { method: 'PUT' });

    const bobVersuch = await apiStatus(bob, `/channels/${textId}/messages`, {
      method: 'POST',
      body: { content: 'ich darf wieder' }
    });
    expect(bobVersuch.status).toBeLessThan(300);

    // Rolle weg — bob ist wieder stumm (rücknehmbar, live).
    await api(owner, `/guilds/${guildId}/members/${bobId}/roles/${rolle.id}`, { method: 'DELETE' });
    const bobZweiterVersuch = await apiStatus(bob, `/channels/${textId}/messages`, {
      method: 'POST',
      body: { content: 'und jetzt?' }
    });
    expect(bobZweiterVersuch.status).toBe(403);
  });

  test('B2: MANAGE_MESSAGES für eine Person — fremde Nachricht löschen, dann nicht mehr', async () => {
    // Owner postet, carol (jetzt mit Mod-Rolle) löscht, dann Rolle weg.
    const nachricht = await api<{ id: string }>(owner, `/channels/${textId}/messages`, {
      method: 'POST',
      body: { content: ' zu loeschen' }
    });
    const modRolle = await api<{ id: string }>(owner, `/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'Mod-Schicht', permissions: MANAGE_MESSAGES }
    });
    await api(owner, `/guilds/${guildId}/members/${carolId}/roles/${modRolle.id}`, { method: 'PUT' });

    // Owner darf senden (Rollen-Patch aus B1 nimmt nur @everyone das SEND,
    // der Owner-Bypass greift unabhängig davon).
    const loeschMit = await apiStatus(carol, `/messages/${nachricht.id}`, {
      method: 'DELETE'
    });
    expect(loeschMit.status, `carol-DELETE mit Mod-Rolle: ${JSON.stringify(loeschMit.body)}`).toBeLessThan(300);

    const zweite = await api<{ id: string }>(owner, `/channels/${textId}/messages`, {
      method: 'POST',
      body: { content: 'noch eine' }
    });
    await api(owner, `/guilds/${guildId}/members/${carolId}/roles/${modRolle.id}`, { method: 'DELETE' });
    const loeschOhne = await apiStatus(carol, `/messages/${zweite.id}`, {
      method: 'DELETE'
    });
    expect(loeschOhne.status).toBe(403);
  });

  test('C: Anti-Eskalation und Hierarchie — ein Mod stößt an seine Grenzen', async () => {
    // Carol bekommt KICK — aber keine Chance gegen den Owner (Hierarchie)
    // und keine Rollen-Verwaltung (Anti-Eskalation).
    const kickRolle = await api<{ id: string }>(owner, `/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'Tuertor', permissions: KICK }
    });
    await api(owner, `/guilds/${guildId}/members/${carolId}/roles/${kickRolle.id}`, { method: 'PUT' });

    const ownerId = await owner.evaluate(() => {
      const raw = localStorage.getItem('dcc.tokens.access')!;
      return JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
    });
    const kickOwner = await apiStatus(carol, `/guilds/${guildId}/members/${ownerId}`, {
      method: 'DELETE'
    });
    expect(kickOwner.status).toBe(403);

    // Rollen anlegen/vergeben braucht MANAGE_ROLES — hat carol nicht.
    const rolleErzeugt = await apiStatus(carol, `/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'Selbsternaennung', permissions: MANAGE_ROLES }
    });
    expect(rolleErzeugt.status).toBe(403);

    // Und ohne jedes Recht: bob gegen die Standard-Gates. CREATE_INVITES
    // gehoert bewusst zum @everyone-Default (jedes Mitglied darf einladen,
    // MANAGE_INVITES deckt nur Listen/Widerrufen) — deshalb hier keine
    // Invite-Probe, sondern die Gates, die wirklich schliessen: Kanal anlegen,
    // Overwrites setzen, fremde Nachrichten loeschen.
    expect((await apiStatus(bob, `/guilds/${guildId}/channels`, { method: 'POST', body: { name: 'x', type: 0 } })).status).toBe(403);
    expect((await apiStatus(bob, `/channels/${textId}/permissions/0/${everyoneRoleId}`, { method: 'PUT', body: { allow: '0', deny: VIEW } })).status).toBe(403);
    expect((await apiStatus(bob, `/channels/${textId}/messages`, { method: 'POST', body: { content: 'bob sagt was' } })).status).toBe(403);
  });

  test('D: Rollen-Reorder — eine Mod kommt nicht über ihre eigene Ebene', async () => {
    // Rollenturm (Positionen: Neuanlage = max+1, @everyone fest auf 0):
    //   Untere (pos 1) < Mod-Rolle (pos 2, MANAGE_ROLES, carol) < Chef (pos 3)
    // Carol darf NUR strikt unterhalb ihrer höchsten Rolle schieben —
    // sonst huebe sie per Drag die eigene Rolle ueber die Chef-Rolle und
    // mit der Positionsgleichheit Kick/Ban (role_hierarchy.py).
    const untere = await api<{ id: string; position: number }>(owner, `/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'Untere' }
    });
    const modRolle2 = await api<{ id: string; position: number }>(owner, `/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'Mod-Rolle', permissions: MANAGE_ROLES }
    });
    const chef = await api<{ id: string; position: number }>(owner, `/guilds/${guildId}/roles`, {
      method: 'POST',
      body: { name: 'Chef' }
    });
    await api(owner, `/guilds/${guildId}/members/${carolId}/roles/${modRolle2.id}`, { method: 'PUT' });

    // Legitim: eine Rolle UNTERHALB ihrer Ebene umsortieren.
    const ok = await apiStatus(carol, `/guilds/${guildId}/roles-positions`, {
      method: 'PATCH',
      body: { positions: [{ id: untere.id, position: 1 }] }
    });
    expect(ok.status).toBeLessThan(300);

    // Verboten: die eigene Rolle auf/ueber die Chef-Ebene heben …
    const eigeneHoch = await apiStatus(carol, `/guilds/${guildId}/roles-positions`, {
      method: 'PATCH',
      body: { positions: [{ id: modRolle2.id, position: chef.position }] }
    });
    expect(eigeneHoch.status).toBe(403);

    // … und jede Rolle AN ODER OBERHALB ihrer Ebene anfassen.
    const fremdeHoch = await apiStatus(carol, `/guilds/${guildId}/roles-positions`, {
      method: 'PATCH',
      body: { positions: [{ id: chef.id, position: 1 }] }
    });
    expect(fremdeHoch.status).toBe(403);
  });

  test('Aufräumen für nachfolgende Suiten: @everyone-Send wieder herstellen', async () => {
    // Playwright truncatet die DB je Lauf nicht vollständig — dieser Test
    // stellt die bewusst geänderte @everyone-Rolle zurück, damit keine
    // andere Spec in demselben Lauf eine verstümmelte Community erbt.
    const alle = await api<{ id: string; is_everyone: boolean; permissions: string }[]>(
      owner,
      `/guilds/${guildId}/roles`
    );
    const everyone = alle.find((r) => r.is_everyone)!;
    const mitSend = (BigInt(everyone.permissions) | BigInt(SEND)).toString();
    await api(owner, `/guilds/${guildId}/roles/${everyone.id}`, {
      method: 'PATCH',
      body: { permissions: mitSend }
    });
    expect(await hatBit(await meineKanalRechte(carol, textId), SEND)).toBe(true);
  });
});

// ROOT wird von manchen Lintern bemängelt, wenn ungenutzt — hier nur zur
// Dokumentation derselben Wurzel wie in den Schwester-Specs.
void ROOT;
