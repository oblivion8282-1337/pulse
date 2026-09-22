import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';

/**
 * Overnight Bughunt T17 — Sicherung als Klick-Durchlauf.
 *
 * Nach der Vorlage `sicherung-geraetewechsel.spec.ts`: der Ordner-Provider
 * wird über einen fake File-System-Access-Adapter an einen lokalen HTTP-
 * Speicher angebunden (beide Browser-Kontexte teilen denselben „Ordner",
 * wie ein Laufwerk, das nicht mitgelöscht wird). Geprüft wird die
 * Oberfläche: Ziel verbinden → Status „Aktiv" → Passwort ändern (Re-Wrap)
 * → Gerätewechsel mit Wiederherstellung → Backup entfernen → Klick ohne
 * Ziel endet in einer Fehlermeldung.
 *
 * Das Passwort wird zwischendurch GEÄNDERT — die Wiederherstellung im
 * Gerätewechsel-Test muss deshalb das NEUE Passwort benutzen und beweist
 * damit, dass der Re-Wrap im geteilten Archiv gelandet ist.
 */

const ts = Date.now();
const ALICE = {
  username: `alice_t17_${ts}`,
  email: `alice_t17_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_t17_${ts}`,
  email: `bob_t17_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const PASSWORT_ALT = 'erstes-sicher-pass';
const PASSWORT_NEU = 'zweites-sicher-pass';
const KLARTEXT = 'nachricht fuer die wiederherstellung';

/** Der geteilte „Ordner": in-memory Map, HTTP auf 127.0.0.1, Port vom OS. */
async function starteSpeicher(): Promise<{
  url: string;
  stop: () => Promise<void>;
  namen: () => string[];
}> {
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
    namen: () => [...dateien.keys()]
  };
}

/** Setzt den fake Ordner (File-System-Access-Form, über HTTP) ins Fenster. */
async function ordnerStubs(ctx: BrowserContext, speicherUrl: string): Promise<void> {
  await ctx.addInitScript(
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
      (fenster as { __e2eOrdnerAbruf?: () => unknown }).__e2eOrdnerAbruf = () =>
        fenster.__e2eSicherungOrdner;
    },
    speicherUrl
  );
}

/** Rehydriert den fake Ordner nach dem IndexedDB-Umweg in `ziele.ts` —
 *  Kopie aus `sicherung-geraetewechsel.spec.ts` (dort ausführlich begründet). */
async function ordnerAdapterAbrufPatch(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/ablage/syncOrdner.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
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

/** Der Ordner-Anbieter existiert nur als „Elektron-Gerät" — das Browser-
 *  Fenster muss sich entsprechend ausgeben (Kopie aus der Vorlage). */
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
  // Die Anmeldung bounct sporadisch zurueck auf /login (produktseitig,
  // nicht laufspezifisch) — ein zweiter Klick faengt das auf.
  for (let versuch = 0; versuch < 2; versuch++) {
    await page.getByTestId('login-submit').click();
    try {
      await page.waitForURL(/\/app/, { timeout: 20_000 });
      break;
    } catch (e) {
      if (versuch === 1) throw e;
    }
  }
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });
}

/** Der Backup-Onboarding-Dialog poppt nach Anmeldung auf, wenn auf diesem
 *  Gerät keine Sicherung eingerichtet ist (z. B. nach dem IDB-Rückbau im
 *  Gerätewechsel) — er blockiert sonst alle Klicks per Overlay. */
async function onboardingWegklicken(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const skip = page.locator('[data-testid=backup-onboarding-skip-btn]');
    if ((await skip.count()) === 0) return;
    await skip.click({ timeout: 1000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
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

async function sicherungTabOeffnen(page: Page): Promise<void> {
  // Der erste Klick auf den Footer-Trigger frisst sich gelegentlich an der
  // Hydratation tot — das Menü öffnet nicht. Erst nachzusetzen (Trigger +
  // Eintrag als Paar) hält das hier robust.
  for (let versuch = 0; versuch < 4; versuch++) {
    await page.getByTestId('user-footer-trigger').click();
    try {
      await page.getByTestId('open-settings').click({ timeout: 2500 });
      break;
    } catch {
      // Menü hat nicht geöffnet — neu klicken.
    }
  }
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-tab-sicherung').click();
}

/** Einstellungen → Sicherung: Ordner verbinden und Passwort festlegen
 *  (`bestaetigen`) bzw. vorhandenes Archiv öffnen (`!bestaetigen`). */
async function sicherungEinrichten(page: Page, passwort: string, bestaetigen: boolean): Promise<void> {
  await sicherungTabOeffnen(page);
  await page.getByTestId('sicherung-ziel-verbinden-ordner').click();
  const felder = page.locator('[data-testid="settings-dialog"] input[type="password"]');
  await felder.first().fill(passwort);
  if (bestaetigen) await felder.nth(1).fill(passwort);
  await page
    .getByRole('button', { name: bestaetigen ? 'Sicherung aktivieren' : 'Öffnen' })
    .click();
  await expect(page.getByTestId('sicherung-status')).toHaveText('Aktiv', { timeout: 15_000 });
}

test.describe.serial('Overnight T17 — Sicherung', () => {
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
      await alsElektronGeraetAusgeben(ctx);
      await ordnerStubs(ctx, speicher.url);
      await ordnerAdapterAbrufPatch(ctx);
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx?.close();
    await bobCtx?.close();
    await speicher?.stop();
  });

  test('Backup-Ziel verbinden (Ordner) — Status zeigt "Aktiv"', async () => {
    // Erster Test des Laufs: Vite kompiliert die App hier kalt.
    test.setTimeout(120_000);
    await register(alicePage, ALICE);
    await sicherungEinrichten(alicePage, PASSWORT_ALT, true);
  });

  test('Ziel zeigt "verbunden", das Archiv liegt im Ordner', async () => {
    await expect(alicePage.getByTestId('sicherung-ziel-verbunden')).toBeVisible();
    // key.puls ist der Beweis, dass die Erstsicherung den Schlüssel in den
    // geteilten Ordner geschrieben hat — ohne ihn wäre jedes spätere
    // Öffnen ein Neuanfang mit frischem Schlüssel.
    await expect
      .poll(async () => speicher.namen().some((n) => n === 'key.puls'), { timeout: 10_000 })
      .toBe(true);
    // Persistenz: nach einem Neuladen weiter "Aktiv" (Ziel + Schlüssel-
    // Zwischenlager leben im Browser-Profil).
    await alicePage.reload();
    await sicherungTabOeffnen(alicePage);
    await expect(alicePage.getByTestId('sicherung-status')).toHaveText('Aktiv', {
      timeout: 15_000
    });
  });

  test('Bobs verschlüsselte Nachricht wird ins Archiv gespiegelt', async () => {
    test.setTimeout(300_000); // Spiegel-Spülung läuft im 60-s-Takt

    await register(bobPage, BOB);
    const aliceUserId = await currentUserId(alicePage);
    const bobUserId = await currentUserId(bobPage);
    await becomeFriends(alicePage, aliceUserId, bobPage, bobUserId);
    await warteAufSchluesselbuendel(alicePage, aliceUserId);
    await warteAufSchluesselbuendel(bobPage, bobUserId);
    dmChannelId = await createDmChannel(alicePage, bobUserId);
    expect(dmChannelId).toMatch(/^\d+$/);

    // Alice steht IM Gespräch (Abonnement), Bob schreibt verschlüsselt.
    await alicePage.goto(`/app/@me/${dmChannelId}`);
    await bobPage.goto(`/app/@me/${dmChannelId}`);
    await bobPage.getByTestId('message-input').fill(KLARTEXT);
    await bobPage.getByTestId('message-input').press('Enter');
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: KLARTEXT })
    ).toBeVisible({ timeout: 10_000 });

    // Die Segment-Datei dieses Kanals landet im geteilten Ordner.
    await expect
      .poll(
        async () =>
          speicher.namen().filter((n) => n.startsWith(`${dmChannelId}/dev-`) && n.endsWith('.puls'))
            .length,
        { timeout: 180_000 }
      )
      .toBeGreaterThan(0);
  });

  test('Backup-Passwort ändern → Erfolgsmeldung', async () => {
    await sicherungTabOeffnen(alicePage);
    // In die Ziel-Verwaltung (Aktiv-Zustand → "Verwalten"), dann Re-Wrap.
    await alicePage.getByTestId('sicherung-verwalten-ordner').click();
    await alicePage.getByTestId('sicherung-passwort-aendern').click();
    const felder = alicePage.locator('[data-testid="settings-dialog"] input[type="password"]');
    await felder.nth(0).fill(PASSWORT_ALT);
    await felder.nth(1).fill(PASSWORT_NEU);
    await felder.nth(2).fill(PASSWORT_NEU);
    await alicePage.getByRole('button', { name: 'Passwort speichern' }).click();
    await expect(alicePage.getByText('Passwort geändert')).toBeVisible({ timeout: 10_000 });
  });

  test('Gerätewechsel: abmelden, alles Lokale weg, neues Passwort stellt die Nachricht wieder her', async () => {
    test.setTimeout(180_000); // Abmelden + Wiedereinstieg + Wiederherstellung
    for (let versuch = 0; versuch < 4; versuch++) {
      await alicePage.getByTestId('user-footer-trigger').click();
      try {
        await alicePage.getByTestId('sign-out').click({ timeout: 2500 });
        break;
      } catch {
        // Menü hat nicht geöffnet — neu klicken.
      }
    }
    await alicePage.waitForURL(/\/login/);

    // "Frisches Gerät": Identität, Sicherungs-Zwischenlager und Verlauf
    // löschen — nur der Ordner überlebt. Das Passwort wurde vorher geändert,
    // die Wiederherstellung muss also das NEUE benutzen.
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
    await alicePage.evaluate(() => localStorage.clear());

    await login(alicePage, ALICE);
    await onboardingWegklicken(alicePage);
    // Der Kanal ist lokal leer — die Nachricht kann NUR aus dem Archiv kommen.
    await alicePage.goto(`/app/@me/${dmChannelId}`);
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: KLARTEXT })
    ).toHaveCount(0);

    await sicherungEinrichten(alicePage, PASSWORT_NEU, false);
    await expect(
      alicePage.getByText(/Nachricht(?:en)? aus der Sicherung wiederhergestellt/)
    ).toBeVisible({ timeout: 20_000 });

    // Und der Bestand ist wirklich da: Kanal neu öffnen zeigt die Nachricht.
    await alicePage.goto('/app/@me');
    await alicePage.goto(`/app/@me/${dmChannelId}`);
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: KLARTEXT })
    ).toBeVisible({ timeout: 15_000 });
  });

  test('Backup entfernen → Status zeigt "Nicht aktiv"', async () => {
    await sicherungTabOeffnen(alicePage);
    await alicePage.getByTestId('sicherung-verwalten-ordner').click();
    await alicePage.getByTestId('sicherung-entfernen').click();
    await expect(alicePage.getByTestId('sicherung-status')).toHaveText('Nicht aktiv', {
      timeout: 10_000
    });
    // Der Verbinden-Zustand ist zurück — der Ordner-Ziel-Knopf bietet
    // sich wieder an.
    await expect(alicePage.getByTestId('sicherung-ziel-verbinden-ordner')).toBeVisible();
  });

  test('Klick auf Verbinden ohne erreichbares Ziel → Fehlermeldung statt stiller Zustand', async () => {
    // Frisches Konto, Elektron-Stub, aber der Picker wirft (Laufwerk nicht
    // erreichbar). Ohne `showDirectoryPicker` würde die Ordner-Zeile gar
    // nicht erst gerendert — mit werfendem Picker bleibt sie da, und die
    // Sektion muss den Fehlschlag sichtbar machen statt still zu bleiben.
    const ctx = await alicePage.context().browser()!.newContext();
    await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    await alsElektronGeraetAusgeben(ctx);
    await ctx.addInitScript(() => {
      (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
        throw new Error('e2e: ziel nicht erreichbar');
      };
    });
    const page = await ctx.newPage();
    await register(page, {
      username: `charlie_t17_${ts}`,
      email: `charlie_t17_${ts}@dcc-test.example.com`,
      password: 'sup3r-secret-pass'
    });

    await sicherungTabOeffnen(page);
    await page.getByTestId('sicherung-ziel-verbinden-ordner').click();
    await expect(
      page.locator('[data-testid="settings-dialog"] p.text-destructive')
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="settings-dialog"] p.text-destructive')).toContainText(
      'e2e: ziel nicht erreichbar'
    );
    await expect(page.getByTestId('sicherung-status')).toHaveText('Nicht aktiv');

    await ctx.close();
  });
});
