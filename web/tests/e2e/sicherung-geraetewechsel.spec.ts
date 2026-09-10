import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Der Nachweis für den Geräte-Wechsel über die Sicherung (2026-09-10):
 * „Nachricht kam am anderen Rechner an, Laufwerk verbunden, Passwort
 * eingegeben — und trotzdem war sie nicht da."
 *
 * Drei Lücken wurden dafür geschlossen (`sicherung-anschluss.test.ts` hütet
 * sie auf Quelltext-Ebene); dieser Lauf prüft das Zusammenspiel ECHT:
 *
 *   1. Bob schreibt verschlüsselt, Alice empfängt UND spiegelt ins Archiv.
 *   2. Alice meldet ab, ihre lokalen Datenbanken werden gelöscht — das ist
 *      das „andere/frische Gerät": neue Geräteschlüssel, leerer Verlauf.
 *      Das Postfach kann nichts mehr liefern (der Umschlag für das alte
 *      Gerät ist quittiert/gelöscht) — das ARCHIV ist der einzige Weg.
 *   3. Alice verbindet das Laufwerk, gibt das Sicherungs-Passwort ein —
 *      und die Nachricht ist wieder da, inklusive Toast.
 *
 * **Warum ein fake Ordner über einen HTTP-Speicher:** Der Nextcloud-Weg ist
 * lokal durch den SSRF-Wächter blockiert (`ablage_ssrf.py` verweigert
 * Loopback), und ein echter File-System-Access-Handle ließe sich nicht
 * zwischen zwei Browser-Kontexten teilen. Der Picker wird deshalb durch ein
 * Fenster Objekt ersetzt, das Dateien an einen hier gestarteten HTTP-Server
 * durchreicht — beide Kontexte sehen denselben „Ordner". Zwei Haken dafür:
 *   * Ein fake Handle überlebt den IndexedDB-Umweg von `ziele.ts` nicht
 *     (structuredClone streift die Methoden). `ordnerAdapterAbrufPatch`
 *     fängt die Vite-Antwort für `syncOrdner.ts` ab und setzt in
 *     `adapterAusVerzeichnis` eine Rehydrierung auf das live Objekt —
 *     dasselbe Muster wie `schalterEinschalten` in `e2e-dm.spec.ts`.
 *   * Die Kanal-„Ordner" (`<kanalId>/dev-…-puls`) sind im fake flache
 *     Schlüssel mit Schrägstrich — `KANAL_ORDNER_MUSTER` passt auch so.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const ts = Date.now();
const ALICE = {
  username: `alice_2geraet_${ts}`,
  email: `alice_2geraet_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_2geraet_${ts}`,
  email: `bob_2geraet_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const SICHERUNGS_PASSWORT = 'sicher-pass-123';

/** Der geteilte „Ordner": in-memory Map, HTTP auf 127.0.0.1, Port vom OS. */
async function starteSpeicher(): Promise<{ url: string; stop: () => Promise<void>; namen: () => string[]; inhalt: (n: string) => Promise<Buffer | null> }> {
  const dateien = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type'
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    const name = url.searchParams.get('n') ?? '';
    if (url.pathname === '/liste' && req.method === 'GET') {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify([...dateien.keys()]));
      return;
    }
    if (url.pathname === '/datei') {
      if (req.method === 'GET') {
        const daten = dateien.get(name);
        if (daten === undefined) {
          res.writeHead(404, cors).end();
          return;
        }
        res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' }).end(daten);
        return;
      }
      if (req.method === 'PUT') {
        const stuecke: Buffer[] = [];
        req.on('data', (stueck: Buffer) => stuecke.push(stueck));
        req.on('end', () => {
          dateien.set(name, Buffer.concat(stuecke));
          res.writeHead(204, cors).end();
        });
        return;
      }
      if (req.method === 'DELETE') {
        dateien.delete(name);
        res.writeHead(204, cors).end();
        return;
      }
    }
    res.writeHead(400, cors).end();
  });
  await new Promise<void>((aufgeloest) => server.listen(0, '127.0.0.1', aufgeloest));
  const adresse = server.address();
  if (adresse === null || typeof adresse === 'string') throw new Error('kein Port vom Speicher');
  return {
    url: `http://127.0.0.1:${adresse.port}`,
    stop: () => new Promise((aufgeloest) => server.close(() => aufgeloest())),
    namen: () => [...dateien.keys()],
    inhalt: async (n) => dateien.get(n) ?? null
  };
}

/** Setzt den fake Ordner (File-System-Access-Form, über HTTP) ins Fenster. */
function ordnerStubs(ctx: BrowserContext, speicherUrl: string): Promise<void> {
  return ctx.addInitScript(
    (basis) => {
      const fenster = globalThis as unknown as {
        __e2eSicherungOrdner: unknown;
        showDirectoryPicker?: (o?: { mode?: string }) => Promise<unknown>;
      };
      fenster.__e2eSicherungOrdner = {
        name: 'e2e-sicherung',
        async getFileHandle(name: string, optionen?: { create?: boolean }) {
          const probe = await fetch(`${basis}/datei?n=${encodeURIComponent(name)}`, { method: 'GET' });
          if (probe.status === 404 && !(optionen && optionen.create)) {
            throw Object.assign(new Error('nicht gefunden'), { name: 'NotFoundError' });
          }
          return {
            async createWritable() {
              const teile: BlobPart[] = [];
              return {
                async write(t: BlobPart) {
                  teile.push(t);
                },
                async close() {
                  await fetch(`${basis}/datei?n=${encodeURIComponent(name)}`, {
                    method: 'PUT',
                    body: new Blob(teile)
                  });
                }
              };
            },
            async getFile() {
              const r = await fetch(`${basis}/datei?n=${encodeURIComponent(name)}`);
              return await r.blob();
            }
          };
        },
        async removeEntry(name: string) {
          await fetch(`${basis}/datei?n=${encodeURIComponent(name)}`, { method: 'DELETE' });
        },
        async *entries() {
          const namen: string[] = await (await fetch(`${basis}/liste`)).json();
          for (const n of namen) yield [n, { kind: 'file' }] as [string, { kind: string }];
        }
      };
      fenster.showDirectoryPicker = async () => fenster.__e2eSicherungOrdner;
      // Rehydrierungs-Haken für den syncOrdner.ts-Patch (s. Modulkopf).
      (fenster as { __e2eOrdnerAbruf?: () => unknown }).__e2eOrdnerAbruf = () =>
        fenster.__e2eSicherungOrdner;
    },
    speicherUrl
  );
}

/** Rehydriert den fake Ordner nach dem IndexedDB-Umweg in `ziele.ts`:
 *  der gespeicherte Eintrag verliert seine Methoden (structuredClone wirft
 *  auf Funktionen), deshalb legt der ziele-Patch nur einen klonbaren Marker
 *  ab und dieser Patch lässt `adapterAusVerzeichnis` das live Objekt
 *  benutzen. */
async function ordnerAdapterAbrufPatch(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/ablage/syncOrdner.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    // Vite serviert das Modul bereits nach JS transformiert — ohne
    // Typ-Annotationen. Der Abgleich gegen die reine Signatur haelt den
    // Patch von der TypeScript-Schreibweise unabhaengig.
    const marke = 'export function adapterAusVerzeichnis(verzeichnis) {';
    if (!text.includes(marke)) {
      throw new Error('adapterAusVerzeichnis-Signatur nicht gefunden — syncOrdner.ts geändert?');
    }
    const gepatcht = text.replace(
      marke,
      marke +
        '\n\tconst rehy = globalThis.__e2eOrdnerAbruf?.();' +
        '\n\tif (rehy) verzeichnis = rehy;'
    );
    await route.fulfill({ response: antwort, body: gepatcht });
  });
  await ctx.route('**/sicherung/ziele.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const marke = 'kopie.ordner = { verzeichnis: z.ordner.verzeichnis };';
    if (!text.includes(marke)) {
      throw new Error('zieleSchreiben-Ordnerzeile nicht gefunden — ziele.ts geändert?');
    }
    const gepatcht = text.replace(
      marke,
      'kopie.ordner = { verzeichnis: { e2e: true } }; // e2e: Marker, s. Spec-Kopf'
    );
    await route.fulfill({ response: antwort, body: gepatcht });
  });
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

async function login(page: Page, identifier: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(identifier);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app/);
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
  if (!value) throw new Error('no access token found in localStorage');
  return value;
}

async function becomeFriends(
  pageA: Page,
  uidA: string,
  pageB: Page,
  uidB: string
): Promise<void> {
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
    if (r.status !== 201) throw new Error(`friend-request failed ${r.status}: ${r.body}`);
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
      { timeout: 15_000 }
    )
    .toBeTruthy();
}

function pgQuery(sql: string): string {
  const dotenv: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) dotenv[m[1]] = m[2];
    }
  } catch {
    // .env fehlt -> Vorgaben unten greifen.
  }
  const pgUser = dotenv.POSTGRES_USER ?? 'dcc';
  return execFileSync(
    'docker',
    ['exec', 'dcc_night_postgres', 'psql', '-U', pgUser, '-d', 'dcc_test', '-tAc', sql],
    { encoding: 'utf8' }
  ).trim();
}

/** Einstellungen → Sicherung: Ordner verbinden, Passwort festlegen/eingeben. */
async function sicherungEinrichten(
  page: Page,
  passwort: string,
  bestaetigen: boolean
): Promise<void> {
  await page.getByTestId('user-footer-trigger').click();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-tab-sicherung').click();
  await page.getByTestId('sicherung-ziel-verbinden-ordner').click();
  const felder = page.locator('[data-testid="settings-dialog"] input[type="password"]');
  await felder.first().fill(passwort);
  if (bestaetigen) await felder.nth(1).fill(passwort);
  await page
    .getByRole('button', { name: bestaetigen ? 'Sicherung aktivieren' : 'Öffnen' })
    .click();
  await expect(page.getByTestId('sicherung-status')).toHaveText('Aktiv', { timeout: 15_000 });
}

test.describe.serial('Sicherung: Gerätewechsel über das Archiv (2026-09-10)', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let dmChannelId = '';
  let speicher: Awaited<ReturnType<typeof starteSpeicher>>;

  test.beforeAll(async ({ browser }) => {
    speicher = await starteSpeicher();
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    for (const ctx of [aliceCtx, bobCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
      await schalterEinschalten(ctx);
      await alsElektronGeraetAusgeben(ctx);
      await ordnerStubs(ctx, speicher.url);
      await ordnerAdapterAbrufPatch(ctx);
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
    await speicher.stop();
  });

  test('Alice und Bob registrieren sich, werden Freunde, Buendel sind veroeffentlicht', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    const aliceUserId = await currentUserId(alicePage);
    const bobUserId = await currentUserId(bobPage);
    await becomeFriends(alicePage, aliceUserId, bobPage, bobUserId);
    await warteAufSchluesselbuendel(alicePage, aliceUserId);
    await warteAufSchluesselbuendel(bobPage, bobUserId);
    dmChannelId = await createDmChannel(alicePage, bobUserId);
    expect(dmChannelId).toMatch(/^\d+$/);
  });

  test('Alice richtet die Sicherung ein (Ordner-Ziel + Passwort)', async () => {
    await sicherungEinrichten(alicePage, SICHERUNGS_PASSWORT, true);
    // key.puls liegt im gemeinsamen „Ordner" — sonst wäre jedes Oeffnen
    // ein Neuanfang mit frischem Schluessel.
    await expect
      .poll(async () => speicher.namen().some((n) => n === 'key.puls'), { timeout: 10_000 })
      .toBe(true);
  });

  test('Bob schreibt verschluesselt, Alice empfaengt und sichert ins Archiv', async () => {
    test.setTimeout(120_000); // Spiegel-Spuelung laeuft im 60-s-Takt
    const KLARTEXT = 'vom anderen rechner angekommen';

    // Alice muss IM Gespraech stehen (Abonnement), sonst kommt der
    // `postfach_neu`-Weckruf nicht live an — dasselbe Muster wie in
    // `e2e-dm.spec.ts` („bob ist schon im Gespraech, bevor alice schreibt").
    await alicePage.goto(`/app/@me/${dmChannelId}`);
    await bobPage.goto(`/app/@me/${dmChannelId}`);
    await bobPage.getByTestId('message-input').click();
    await bobPage.getByTestId('message-input').fill(KLARTEXT);
    await bobPage.getByTestId('message-input').press('Enter');

    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: KLARTEXT })
    ).toBeVisible({ timeout: 10_000 });

    // Der Server hat den Klartext nie gesehen.
    expect(
      Number(pgQuery(`SELECT count(*) FROM chat.messages WHERE channel_id = ${dmChannelId};`))
    ).toBe(0);

    // Das Archiv traegt eine Segment-Datei dieses Kanals — und der
    // Verschluesselungs-Nachweis gilt auch hier: kein Klartext, auch nicht
    // base64-verpackt.
    await expect
      .poll(
        async () =>
          speicher.namen().filter((n) => n.startsWith(`${dmChannelId}/dev-`) && n.endsWith('.puls'))
            .length,
        { timeout: 90_000 }
      )
      .toBeGreaterThan(0);
    for (const name of speicher.namen().filter((n) => n.endsWith('.puls') && n !== 'key.puls')) {
      const roh = (await speicher.inhalt(name))?.toString('utf8') ?? '';
      expect(roh).not.toContain(KLARTEXT);
      expect(Buffer.from(roh, 'base64').toString('utf8')).not.toContain(KLARTEXT);
    }
  });

  test('Abmelden und lokales Abräumen — das Archiv bleibt, der Rest ist weg', async () => {
    await alicePage.getByTestId('user-footer-trigger').click();
    await alicePage.getByTestId('sign-out').click();
    await alicePage.waitForURL(/\/login/);

    // „Frisches Gerät": Identität (Geräteschlüssel!), Sicherungs-Zwischen-
    // lager und lokaler Verlauf löschen. Nur der „Ordner" (HTTP-Speicher)
    // überlebt — wie ein Laufwerk, das nicht mitgelöscht wird.
    await alicePage.evaluate(
      () =>
        new Promise<void>((aufgeloest) => {
          let rest = 3;
          const fertig = () => (--rest === 0 && aufgeloest());
          for (const name of ['pulse-identity', 'pulse-sicherung', 'pulse-verlauf']) {
            const anfrage = indexedDB.deleteDatabase(name);
            anfrage.onsuccess = fertig;
            anfrage.onerror = fertig;
            anfrage.onblocked = fertig;
          }
        })
    );
    // Der Token muss auch weg — sonst loggt der Wiedereinstieg still ein.
    await alicePage.evaluate(() => localStorage.clear());
    expect(speicher.namen().some((n) => n === 'key.puls')).toBe(true);
  });

  test('Wiedereinstieg: Passwort oeffnet das Archiv, Toast meldet die Wiederherstellung', async () => {
    await login(alicePage, ALICE.username, ALICE.password);
    // Der Kanal ist lokal leer — die Nachricht kann NUR aus dem Archiv
    // kommen (der alte Umschlag war ans alte Geraet adressiert und ist
    // längst quittiert).
    await alicePage.goto(`/app/@me/${dmChannelId}`);
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'vom anderen rechner' })
    ).toHaveCount(0);

    await sicherungEinrichten(alicePage, SICHERUNGS_PASSWORT, false);
    await expect(
      alicePage.getByText(/Nachricht(?:en)? aus der Sicherung wiederhergestellt/)
    ).toBeVisible({ timeout: 20_000 });

    // Und der Bestand ist wirklich im Verlauf: Kanal neu oeffnen zeigt die
    // Nachricht — ohne Postfach, nur aus der Sicherung.
    await alicePage.goto('/app/@me');
    await alicePage.goto(`/app/@me/${dmChannelId}`);
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: 'vom anderen rechner' })
    ).toBeVisible({ timeout: 15_000 });
  });
});

/* ————————————————————————————————————————————————————————————————
 * Kopien der beiden Vite-Abfang-Helfer aus e2e-dm.spec.ts (dort nicht
 * exportiert, hier bewusst dupliziert statt importiert — die Spec soll
 * auch standalone lesbar bleiben).
 * ———————————————————————————————————————————————————————————————— */

async function schalterEinschalten(ctx: BrowserContext): Promise<void> {
  // Alle Schalter stehen auf `true` (Eigentümer-Entscheidung) — der Abfang-
  // Helfer bleibt der Form halber bestehen und macht dann nichts.
  await ctx.route('**/krypto/schalter.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const gepatcht = text.replace('E2E_DMS_ENABLED = false', 'E2E_DMS_ENABLED = true');
    await route.fulfill({ response: antwort, body: gepatcht });
  });
}

async function alsElektronGeraetAusgeben(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const leer = async () => undefined;
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
      notify: leer
    };
  });
}
