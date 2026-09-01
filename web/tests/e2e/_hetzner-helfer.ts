/**
 * Gemeinsame Bausteine der Nachweise gegen den REMOTE-Dev-Stack (Hetzner).
 *
 * Herausgeloest am 2026-09-01, als der zweite solche Nachweis dazukam
 * (`e2e-ablage-hetzner.spec.ts`): Anmeldung, Geraete-Vortaeuschung,
 * Freundschaft und die Postgres-Gegenprobe waeren sonst ein zweites Mal
 * wortgleich im Baum gestanden.
 *
 * **Der `_`-Praefix ist Pflicht, nicht Geschmack** — `playwright.config.ts`
 * schliesst Dateien mit fuehrendem Unterstrich vom Testlauf aus (Eintrag
 * `testIgnore`). Ohne ihn suchte Playwright hier nach Tests und meldete die
 * Datei als leere Suite.
 *
 * Das Glob-Muster steht hier bewusst NICHT ausgeschrieben: es enthaelt die
 * Zeichenfolge, die einen Blockkommentar beendet, und hat genau diese Datei
 * beim Anlegen einmal zerlegt — alles darunter stand ploetzlich ausserhalb
 * des Kommentars, und die Fehlermeldung lautete „is not a module".
 */

import { expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';

export const SSH_ZIEL = process.env.E2E_PG_VIA_SSH ?? 'michael@77.42.71.166';

export const DEV = { username: 'dev', password: 'test1234' };
export const DEV2 = { username: 'dev2', password: 'test1234' };

/** Faengt die Vite-Dev-Antwort fuer `schalter.ts` ab und dreht die Konstante
 *  auf `true` — der Quelltext bleibt unangetastet (Muster wie e2e-dm.spec.ts). */
export async function schalterEinschalten(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/krypto/schalter.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const gepatcht = text.replace('E2E_DMS_ENABLED = false', 'E2E_DMS_ENABLED = true');
    if (gepatcht === text && !text.includes('E2E_DMS_ENABLED = true')) {
      throw new Error(`Weder "E2E_DMS_ENABLED = false" noch "= true" in schalter.ts gefunden`);
    }
    await route.fulfill({ response: antwort, body: gepatcht });
  });
}

/** Taeuscht die Electron-Bruecke — die Koexistenz-Regel verschluesselt nur
 *  zwischen dauerhaften Geraeten (Muster wie e2e-dm.spec.ts). */
export async function alsElektronGeraetAusgeben(ctx: BrowserContext): Promise<void> {
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

export async function login(page: Page, u: { username: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(u.username);
  await page.getByTestId('login-password').fill(u.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

export async function currentUserId(page: Page): Promise<string> {
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

export async function becomeFriends(pageA: Page, uidA: string, pageB: Page, uidB: string): Promise<void> {
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

export async function createDmChannel(page: Page, targetUserId: string): Promise<string> {
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

export async function warteAufSchluesselbuendel(page: Page, userId: string): Promise<void> {
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

/** Postgres-Gegenprobe per SSH gegen den Stack-Container.
 *
 *  Scheitert das `ssh`, liegt es fast immer an der Maschine und nicht am
 *  Produkt: der Schluessel haengt auf manchen Rechnern an einem Host-Eintrag
 *  in `~/.ssh/config` (etwa `pulse-hetzner-dev`) statt an der blanken IP, die
 *  hier vorgegeben ist. Ohne diesen Hinweis liest sich der Abbruch wie ein
 *  Fehler im Anmeldeweg — deshalb sagt er, welcher Handgriff fehlt. */
export function pgQuery(sql: string): string {
  try {
    return execFileSync(
      'ssh',
      [
        SSH_ZIEL,
        `docker exec pulsetest_postgres psql -U pulse -d pulse -tAc "${sql.replace(/"/g, '\\"')}"`,
      ],
      { encoding: 'utf8' },
    ).trim();
  } catch (fehler) {
    throw new Error(
      `Die Postgres-Gegenprobe kam nicht auf den Stack (${SSH_ZIEL}). ` +
        `Das ist Maschinen-Einrichtung, kein Produktfehler: setze ` +
        `E2E_PG_VIA_SSH auf den Host-Eintrag aus deiner ~/.ssh/config ` +
        `(hier: pulse-hetzner-dev). Gegenprobe: ` +
        `\`ssh pulse-hetzner-dev 'docker ps'\`. Urspruenglich: ${String(fehler)}`,
    );
  }
}
