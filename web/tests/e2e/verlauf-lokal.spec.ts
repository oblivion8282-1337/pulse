import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Ersetzt den manuellen Schritt aus Task 2 Schritt 5 des Etappe-C1-Plans
 * (`docs/superpowers/plans/2026-08-28-etappe-c1-lokaler-verlauf.md`):
 * "App starten, eine DM öffnen, eine Nachricht schreiben, in den
 * Entwicklerwerkzeugen unter Application → IndexedDB → pulse-verlauf
 * nachsehen". Hier automatisch über `page.evaluate` gegen die echte
 * IndexedDB des Browserkontexts.
 *
 * Drei Behauptungen, die tragende zweite zuerst gedacht: nur DM-Kanäle
 * landen lokal, Community-Kanäle NICHT (Spec §9) — ohne diese Prüfung
 * bewiese der Test kaum mehr als "IndexedDB existiert".
 */

const ts = Date.now();
const ALICE = {
  username: `alice_verlauf_${ts}`,
  email: `alice_verlauf_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_verlauf_${ts}`,
  email: `bob_verlauf_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
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

async function addMemberToGuild(adminPage: Page, guildId: string, userId: string) {
  const response = await adminPage.evaluate(
    async ([gid, uid]) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/guilds/${gid}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: uid })
      });
      return { status: r.status, body: await r.text() };
    },
    [guildId, userId]
  );
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`addMember failed ${response.status}: ${response.body}`);
  }
}

/** Muster aus dms.spec.ts: DMs sind seit Phase 2 friend-gated. */
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
    if (r.status !== 201) {
      throw new Error(`friend-request failed ${r.status}: ${r.body}`);
    }
  };
  await send(pageA, uidB);
  await send(pageB, uidA); // reverse → auto-accept
}

/** Row eines im `pulse-verlauf`-Objektspeicher abgelegten Satzes — siehe
 *  `web/src/lib/verlauf/schema.ts::Satz`. Hier nur importfrei nachgebildet,
 *  weil `page.evaluate` keinen Zugriff auf Modul-Importe hat. */
type Satz = {
  kanalId: string;
  nachrichtId: string;
  inhalt: string;
  geloescht: boolean;
};

/** Liest den kompletten `nachrichten`-Objektspeicher aus der `pulse-verlauf`-
 *  IndexedDB des aktuellen Browserkontexts — die automatisierte Fassung des
 *  manuellen Blicks in Application → IndexedDB. */
async function alleSaetze(page: Page): Promise<Satz[]> {
  // Die Wiederholung ist kein Schoenheitsfehler: die App ist eine
  // Einzelseiten-Anwendung und navigiert nach dem Senden noch clientseitig
  // weiter. Faellt das `evaluate` in genau dieses Fenster, stirbt es mit
  // „Execution context was destroyed" — das ist eine Aussage ueber den
  // Zeitpunkt, nicht ueber den Speicher. Wer den Fehler durchreicht, liest
  // ihn als „nichts gespeichert" und sucht danach an der falschen Stelle.
  for (let versuch = 0; versuch < 5; versuch += 1) {
    try {
      await page.waitForLoadState('domcontentloaded');
      return await page.evaluate(
        async () => {
          // ZUERST nachsehen, OB es die Datenbank gibt — und sie nicht durch
          // das Nachsehen erschaffen.
          //
          // `indexedDB.open(name)` ohne Version LEGT DIE DATENBANK AN, wenn
          // sie fehlt: leer, auf Version 1, ohne Objektspeicher. Danach findet
          // die App beim Öffnen mit Version 1 eine bestehende Version 1 vor,
          // `onupgradeneeded` feuert nie, `nachrichten` entsteht nicht, und
          // jeder Schreibversuch scheitert an einer fehlenden Objektablage —
          // still, weil der Schreibweg seine Fehler absichtlich schluckt.
          //
          // Dieser Test hat sich damit selbst kaputtgemacht: der erste
          // Testfall legte die leere Datenbank an, alle folgenden maßen
          // daraufhin einen Speicher, den sie selbst unbrauchbar gemacht
          // hatten — und der Fall „Community-Nachricht wird NICHT abgelegt"
          // war grün, weil gar nichts abgelegt wurde. Ein Messgerät, das
          // seinen Gegenstand verändert.
          const vorhanden = (await indexedDB.databases()).some((d) => d.name === 'pulse-verlauf');
          if (!vorhanden) return [] as Satz[];

          return new Promise<Satz[]>((resolve, reject) => {
            const req = indexedDB.open('pulse-verlauf');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('nachrichten')) {
                resolve([]);
                return;
              }
              const tx = db.transaction('nachrichten', 'readonly');
              const store = tx.objectStore('nachrichten');
              const getAll = store.getAll();
              getAll.onsuccess = () => resolve(getAll.result as Satz[]);
              getAll.onerror = () => reject(getAll.error);
            };
          });
        }
      );
    } catch (fehler) {
      if (!String(fehler).includes('Execution context was destroyed')) throw fehler;
      await page.waitForTimeout(300);
    }
  }
  throw new Error('IndexedDB nicht lesbar — die Seite navigierte wiederholt dazwischen');
}

test.describe.serial('lokaler Verlauf (IndexedDB) E2E', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let guildId = '';
  let channelId = '';
  let bobUserId = '';

  const dmText = `dm geheimtext ${ts}`;
  const dmDeleteText = `dm zu loeschen ${ts}`;
  const guildText = `community nachricht ${ts}`;

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    for (const ctx of [aliceCtx, bobCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('setup: beide registrieren, befreunden, Community mit Kanal', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    bobUserId = await currentUserId(bobPage);
    const aliceUserId = await currentUserId(alicePage);
    await becomeFriends(alicePage, aliceUserId, bobPage, bobUserId);

    await alicePage.locator('[data-testid^="guild-create-menu-"]').first().click();
    await alicePage.getByTestId('guild-create').click();
    await alicePage.getByTestId('create-guild-name').fill('Verlauf Crew');
    await alicePage.getByTestId('create-guild-submit').click();
    await alicePage.waitForURL(/\/app\/guilds\/\d+\/channels\/\d+/);
    const url = new URL(alicePage.url());
    const parts = url.pathname.split('/');
    guildId = parts[3];
    channelId = parts[5];
    await addMemberToGuild(alicePage, guildId, bobUserId);
  });

  test('eine Community-Nachricht landet NICHT im lokalen Verlauf', async () => {
    // Das ist die tragende Hälfte: der lokale Speicher ist DM-only (Spec §9).
    // Ohne diese Prüfung bewiese der Test kaum mehr, als dass IndexedDB
    // existiert.
    await alicePage.goto(`/app/guilds/${guildId}/channels/${channelId}`);
    await expect(alicePage.getByTestId('active-channel-name')).toHaveText('general', {
      timeout: 15_000
    });
    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill(guildText);
    await alicePage.getByTestId('message-input').press('Enter');
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: guildText })
    ).toBeVisible({ timeout: 10_000 });

    const saetze = await alleSaetze(alicePage);
    expect(saetze.some((s) => s.inhalt === guildText)).toBe(false);
    expect(saetze.some((s) => s.kanalId === channelId)).toBe(false);
  });

  test('eine Direktnachricht landet im lokalen Verlauf', async () => {
    await alicePage.goto(`/app/guilds/${guildId}/channels/${channelId}`);
    await alicePage.getByTestId('member-list-toggle').click();
    const bobRow = alicePage
      .getByTestId('member-item')
      .and(alicePage.locator(`[data-user-id="${bobUserId}"]`));
    await expect(bobRow).toBeVisible({ timeout: 10_000 });
    await bobRow.click({ button: 'right' });
    await alicePage.getByTestId('popover-dm-btn').click();
    await alicePage.waitForURL(/\/app\/@me\/\d+/, { timeout: 10_000 });
    const dmChannelId = new URL(alicePage.url()).pathname.split('/').pop()!;

    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill(dmText);
    await alicePage.getByTestId('message-input').press('Enter');
    await expect(
      alicePage.locator('[data-testid="message-content"]', { hasText: dmText })
    ).toBeVisible({ timeout: 10_000 });

    // `verlaufSpeichern` läuft ohne await ("void verlaufSpeichern(...)",
    // s. Plan) — der Schreibvorgang kann dem Rendern der Nachricht ein paar
    // Millisekunden hinterherhängen. expect.poll statt eines festen Timeouts.
    //
    // ZWEI Erwartungen statt einer, und das ist Absicht: „nichts gefunden"
    // unterscheidet sonst nicht zwischen „gar nichts gespeichert" und „unter
    // einem anderen Schlüssel gespeichert". Das sind völlig verschiedene
    // Fehler — der eine sitzt im Torwächter, der andere in der Satzform —
    // und ein Test, der sie zusammenwirft, schickt den Suchenden in die
    // falsche Datei.
    await expect
      .poll(
        async () => {
          const anzahl = (await alleSaetze(alicePage)).length;
          if (anzahl > 0) return anzahl;
          // Null Sätze hat zwei sehr verschiedene Ursachen: die Datenbank
          // wurde nie angelegt (dann hat NIEMAND je verlaufSpeichern bis zum
          // Schreiben durchlaufen — der Torwächter blockt), oder sie ist da
          // und leer (dann scheitert das Schreiben selbst). Ohne diese
          // Unterscheidung sucht man in der falschen Datei.
          const banken = await alicePage.evaluate(async () =>
            (await indexedDB.databases()).map((d) => d.name)
          );
          return { anzahl, vorhandeneDatenbanken: banken };
        },
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const alle = await alleSaetze(alicePage);
          const treffer = alle.find((s) => s.kanalId === dmChannelId && s.inhalt === dmText);
          // Bei Fehlschlag zeigt Playwright den letzten Rückgabewert an —
          // deshalb im Nicht-Treffer-Fall zeigen, was STATTDESSEN da liegt.
          return treffer ?? { gesucht: { dmChannelId, dmText }, vorhanden: alle };
        },
        { timeout: 10_000 }
      )
      .toHaveProperty('inhalt', dmText);

    const saetze = await alleSaetze(alicePage);
    const dmSatz = saetze.find((s) => s.kanalId === dmChannelId && s.inhalt === dmText);
    expect(dmSatz).toBeTruthy();
    expect(dmSatz!.geloescht).toBe(false);

    // Die Community-Nachricht aus dem vorigen Test darf immer noch nicht da
    // sein — derselbe Speicher, zwei verschiedene Kanäle.
    expect(saetze.some((s) => s.inhalt === guildText)).toBe(false);
  });

  test('eine gelöschte Direktnachricht bleibt als Grabstein', async () => {
    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill(dmDeleteText);
    await alicePage.getByTestId('message-input').press('Enter');
    const row = alicePage.locator('[data-testid="message-item"]', { hasText: dmDeleteText });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const nachrichtId = await row.getAttribute('data-message-id');
    expect(nachrichtId).toBeTruthy();

    await row.hover();
    await row.getByTestId('message-action-delete').click();
    await alicePage.getByTestId('confirm-dialog-confirm').click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });

    await expect
      .poll(async () => {
        const saetze = await alleSaetze(alicePage);
        return saetze.find((s) => s.nachrichtId === nachrichtId)?.geloescht;
      }, { timeout: 10_000 })
      .toBe(true);
  });

  test('C2: nach einem Reload steht der Verlauf sofort da — vor der Serverantwort', async () => {
    // Die Behauptung von C2 ist nur pruefbar, wenn die Serverantwort
    // kuenstlich verzoegert wird — auf einer schnellen Leitung waere "vor
    // der Serverantwort da" sonst Zufall statt Beleg.
    let serverantwortFreigeben: () => void = () => {};
    const serverantwortHaelt = new Promise<void>((resolve) => {
      serverantwortFreigeben = resolve;
    });
    await alicePage.route('**/api/chat/channels/*/messages*', async (route) => {
      // NUR den Erstladen (kein `before=` in der Query) verzoegern — das
      // Hochscroll-Nachladen aus `MessageList` traegt `before=` und darf
      // ungebremst durchlaufen, sonst konkurrieren zwei Anfragen um dieselbe
      // Route (Playwright: "Route is already handled").
      if (new URL(route.request().url()).searchParams.has('before')) {
        await route.continue().catch(() => undefined);
        return;
      }
      await serverantwortHaelt;
      // `route.continue()` kann hier auf ein bereits abgeschlossenes Route-
      // Objekt treffen (ein `reload()` kann die alte Anfrage kappen, waehrend
      // die neue dieselbe Query traegt) — das ist kein Testfehler, sondern
      // ein Playwright-Implementierungsdetail des Reloads.
      await route.continue().catch(() => undefined);
    });

    try {
      await alicePage.reload();

      // dmText liegt seit dem zweiten Testfall lokal — es muss sichtbar sein,
      // WAEHREND die Serverantwort noch haengt (sie wird erst unten
      // freigegeben). Ohne C2 gäbe es hier nichts zu sehen, bis die Route
      // freigegeben wird.
      await expect(
        alicePage.locator('[data-testid="message-content"]', { hasText: dmText })
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      serverantwortFreigeben();
      await alicePage.unroute('**/api/chat/channels/*/messages*');
    }

    // Der Server wird trotzdem gefragt (kein Skip nur weil lokal etwas da
    // war) — nach der Freigabe muss die Serverantwort ankommen und die Seite
    // bleibt benutzbar (kein Fehlerzustand haengen).
    await expect(alicePage.getByTestId('load-error')).toHaveCount(0);
  });
});
