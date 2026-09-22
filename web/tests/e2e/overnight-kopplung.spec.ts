import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Overnight Bughunt T16 — Geräte-Kopplung als Klick-Durchlauf.
 *
 * Anders als `e2e-kopplung.spec.ts` (der die serverseitige Ciphertext-
 * Gegenprobe über Postgres fährt) prüft diese Datei nur die OBERFLÄCHE:
 * Code erzeugen → auf dem zweiten Gerät einlösen → Balken → übernehmen →
 * verwerfen → falscher Code. Der Verlauf-Nachweis läuft über die IndexedDB
 * des Browsers (`pulse-verlauf`), nicht über die Datenbank — der Test soll
 * ohne Docker-Umweg lesbar bleiben.
 *
 * Der Schalter `GERAETE_KOPPLUNG_ENABLED` ist Vorgabe AUS und wird wie in
 * der Vorlage über die Vite-Antwort umgeschaltet; `E2E_DMS_ENABLED` wird
 * mit ausgeschaltet, damit der lokale Verlauf Klartext trägt und sich die
 * übernommenen Sätze auf Gerät B direkt gegenprüben lassen.
 */

const ts = Date.now();
const ALICE = {
  username: `alice_overnight_${ts}`,
  email: `alice_overnight_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_overnight_${ts}`,
  email: `bob_overnight_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

const NACHRICHTEN = [
  'erste nachricht vor der kopplung',
  'zweite nachricht, damit es mehr als eine ist',
  'dritte nachricht fuer den stueckzaehler'
];

async function schalterUmschalten(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/krypto/schalter.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const ohneKrypto = text.replace('E2E_DMS_ENABLED = true', 'E2E_DMS_ENABLED = false');
    const gepatcht = ohneKrypto.replace(
      'GERAETE_KOPPLUNG_ENABLED = false',
      'GERAETE_KOPPLUNG_ENABLED = true'
    );
    if (!gepatcht.includes('GERAETE_KOPPLUNG_ENABLED = true')) {
      throw new Error('GERAETE_KOPPLUNG_ENABLED nicht gefunden — schalter.ts geändert?');
    }
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

async function sicherheitTabOeffnen(page: Page): Promise<void> {
  await page.getByTestId('user-footer-trigger').click();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-tab-security').click();
  await expect(page.getByTestId('geraete-kopplung')).toBeVisible();
}

/** Alle Sätze des lokalen Verlaufs (`pulse-verlauf`) direkt aus der IndexedDB —
 *  wie `e2e-kopplung.spec.ts::lokalerVerlaufInhalt`, ohne DB-Umweg. */
async function lokalerVerlaufInhalt(page: Page, kontoId: string): Promise<string[]> {
  return page.evaluate((kontoId) => {
    return new Promise<string[]>((resolve, reject) => {
      const oeffnen = indexedDB.open('pulse-verlauf');
      oeffnen.onerror = () => reject(oeffnen.error);
      oeffnen.onsuccess = () => {
        const db = oeffnen.result;
        if (!db.objectStoreNames.contains('nachrichten')) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction('nachrichten', 'readonly');
        const anfrage = tx.objectStore('nachrichten').getAll();
        anfrage.onsuccess = () => {
          const alle = anfrage.result as { kontoId: string; inhalt: string }[];
          resolve(alle.filter((s) => s.kontoId === kontoId).map((s) => s.inhalt));
          db.close();
        };
        anfrage.onerror = () => reject(anfrage.error);
      };
    });
  }, kontoId);
}

test.describe.serial('Overnight T16 — Geräte-Kopplung', () => {
  let ctxA: BrowserContext;
  let seiteA: Page; // Alice, Gerät A (Sender)
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let ctxB: BrowserContext;
  let seiteB: Page; // Alice, Gerät B (Empfänger)
  let aliceUserId = '';
  let dmChannelId = '';

  test.beforeAll(async ({ browser }) => {
    ctxA = await browser.newContext();
    bobCtx = await browser.newContext();
    for (const ctx of [ctxA, bobCtx]) {
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
      await schalterUmschalten(ctx);
    }
    seiteA = await ctxA.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await bobCtx?.close();
    await ctxB?.close();
  });

  test('Vorbereitung: Alice und Bob befreundet, drei Nachrichten im lokalen Verlauf', async () => {
    // Erster Test des Laufs: Vite kompiliert die App hier kalt.
    test.setTimeout(120_000);
    await register(seiteA, ALICE);
    await register(bobPage, BOB);
    aliceUserId = await currentUserId(seiteA);
    const bobUserId = await currentUserId(bobPage);
    await becomeFriends(seiteA, aliceUserId, bobPage, bobUserId);
    dmChannelId = await createDmChannel(seiteA, bobUserId);
    expect(dmChannelId).toMatch(/^\d+$/);

    // Bob muss VOR dem Senden auf der DM-Seite stehen (WS-Abonnement),
    // sonst kommt die zweite Nachricht nicht live an — und Alice genauso,
    // sonst geht ihr erstes Senden ins Leere.
    await bobPage.goto(`/app/@me/${dmChannelId}`);
    await expect(bobPage.getByTestId('active-channel-name')).toHaveText(ALICE.username, {
      timeout: 10_000
    });
    await seiteA.goto(`/app/@me/${dmChannelId}`);
    await expect(seiteA.getByTestId('active-channel-name')).toHaveText(BOB.username, {
      timeout: 10_000
    });

    for (const text of NACHRICHTEN) {
      await seiteA.getByTestId('message-input').fill(text);
      await seiteA.getByTestId('message-input').press('Enter');
      await expect(
        bobPage.locator('[data-testid="message-content"]', { hasText: text })
      ).toBeVisible({ timeout: 10_000 });
    }

    await expect
      .poll(() => lokalerVerlaufInhalt(seiteA, aliceUserId), { timeout: 10_000 })
      .toHaveLength(NACHRICHTEN.length);
  });

  test('Gerät A erzeugt einen Kopplungscode', async () => {
    await sicherheitTabOeffnen(seiteA);
    await seiteA.getByTestId('kopplung-tab-zeigen').click();
    await seiteA.getByTestId('kopplung-code-erzeugen').click();
    const code = await seiteA.getByTestId('kopplung-code').innerText();
    expect(code.replace(/[\s-]/g, '')).toHaveLength(20);
  });

  test('Gerät B löst den Code ein — Balken erscheint, Gerät A meldet "fertig"', async ({
    browser
  }) => {
    test.setTimeout(90_000);
    ctxB = await browser.newContext();
    await ctxB.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
    await schalterUmschalten(ctxB);
    seiteB = await ctxB.newPage();

    await login(seiteB, ALICE);
    expect(await currentUserId(seiteB)).toBe(aliceUserId);

    await sicherheitTabOeffnen(seiteB);
    await seiteB.getByTestId('kopplung-tab-eingeben').click();
    await seiteB.getByTestId('kopplung-eingabe').fill(await seiteA.getByTestId('kopplung-code').innerText());
    await seiteB.getByTestId('kopplung-einloesen').click();

    // Je nachdem, wie weit Gerät A mit dem Schieben war: Wartezweig
    // (`kopplung-stand-pruefen`), fertiger Zweig (`kopplung-uebernehmen`)
    // oder Fehler — dieselben drei Folgezustaende wie in der Vorlage.
    await expect(
      seiteB
        .getByTestId('kopplung-fehler')
        .or(seiteB.getByTestId('kopplung-stand-pruefen'))
        .or(seiteB.getByTestId('kopplung-empfang-fortschritt'))
        .or(seiteB.getByTestId('kopplung-uebernehmen'))
    ).toBeVisible({ timeout: 15_000 });
    if ((await seiteB.getByTestId('kopplung-fehler').count()) > 0) {
      throw new Error(`Einlösen fehlgeschlagen: ${await seiteB.getByTestId('kopplung-fehler').innerText()}`);
    }

    // Gerät B klickt "Stand prüfen", bis der Übernehmen-Knopf (mit dem
    // Empfangs-Balken) erscheint — es gibt keinen Push dafür.
    await expect
      .poll(
        async () => {
          const knopf = seiteB.getByTestId('kopplung-stand-pruefen');
          if ((await knopf.count()) > 0) await knopf.click();
          return seiteB.getByTestId('kopplung-uebernehmen').count();
        },
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0);
    await expect(seiteB.getByTestId('kopplung-empfang-fortschritt')).toBeVisible();

    // Gerät A meldet "fertig", sobald das letzte Stück übertragen ist.
    await expect(seiteA.getByTestId('kopplung-zeigen-fertig')).toBeVisible({ timeout: 15_000 });
  });

  test('Verlauf übernehmen — die drei Nachrichten landen auf Gerät B', async () => {
    await seiteB.getByTestId('kopplung-uebernehmen').click();
    await expect(seiteB.getByTestId('kopplung-uebernommen')).toBeVisible({ timeout: 15_000 });
    await expect(seiteB.getByTestId('kopplung-uebernommen')).toContainText(
      String(NACHRICHTEN.length)
    );

    // Der eigentliche Nachweis: derselbe Verlauf wie auf Gerät A.
    await expect
      .poll(() => lokalerVerlaufInhalt(seiteB, aliceUserId), { timeout: 10_000 })
      .toHaveLength(NACHRICHTEN.length);
    const inhaltB = await lokalerVerlaufInhalt(seiteB, aliceUserId);
    expect(new Set(inhaltB)).toEqual(new Set(NACHRICHTEN));
  });

  test('Kopplung verwerfen — Gerät B landet wieder bei der Code-Eingabe', async () => {
    test.setTimeout(90_000);

    // Neuer Code auf Gerät A: die alte Kopplung ist nach dem Übernehmen
    // abgeschlossen, das Fenster zeigt noch den alten Code → erst abbrechen.
    await seiteA.getByTestId('kopplung-abbrechen').click();
    await seiteA.getByTestId('kopplung-code-erzeugen').click();
    const code2 = await seiteA.getByTestId('kopplung-code').innerText();
    expect(code2.replace(/[\s-]/g, '')).toHaveLength(20);

    // Gerät B: frischer Komponenten-Stand (Neuladen setzt den Zustand
    // des Empfaenger-Formulars zurueck), dann einlösen.
    await seiteB.reload();
    await sicherheitTabOeffnen(seiteB);
    await seiteB.getByTestId('kopplung-tab-eingeben').click();
    await seiteB.getByTestId('kopplung-eingabe').fill(code2);
    await seiteB.getByTestId('kopplung-einloesen').click();
    await expect(
      seiteB
        .getByTestId('kopplung-stand-pruefen')
        .or(seiteB.getByTestId('kopplung-empfang-fortschritt'))
        .or(seiteB.getByTestId('kopplung-uebernehmen'))
    ).toBeVisible({ timeout: 15_000 });

    // Widerrufen: der Verwerfen-Knopf bricht ab und bringt die Eingabe zurück.
    await seiteB.getByTestId('kopplung-verwerfen').click();
    await expect(seiteB.getByTestId('kopplung-eingabe')).toBeVisible();
    await expect(seiteB.getByTestId('kopplung-uebernehmen')).toHaveCount(0);
    await expect(seiteB.getByTestId('kopplung-empfang-fortschritt')).toHaveCount(0);
  });

  test('Falscher Code → Fehlermeldung', async () => {
    await seiteB.getByTestId('kopplung-eingabe').fill('DAS-IST-KEIN-CODE');
    await seiteB.getByTestId('kopplung-einloesen').click();
    await expect(seiteB.getByTestId('kopplung-fehler')).toBeVisible({ timeout: 10_000 });
  });
});
