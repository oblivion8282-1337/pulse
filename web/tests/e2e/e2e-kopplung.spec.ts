import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Der Kopplungs-Nachweis fuer Etappe E11 (`docs/ablage-umsetzung-stand.md`
 * §3.2): die Geraete-Kopplung (`web/src/lib/kopplung/`,
 * `services/chat-gateway/.../routes/kopplung*.py`) ist server- und
 * klientseitig durch pytest bzw. Komponenten-Logik gedeckt, aber noch nie als
 * zusammengesetzter Zwei-Geraete-Durchlauf gefahren. Gebaut nach der Vorlage
 * `e2e-dm.spec.ts`/`e2e-ablage-kanal.spec.ts` — dieselbe Struktur, dieselbe
 * DB-Gegenprobe gegen den lokalen Postgres-Testcontainer.
 *
 * **Was die Kopplung laut Code verspricht** (Modulkoepfe von
 * `routes/kopplung.py`/`routes/kopplung_umzug.py`, gelesen VOR diesem Test):
 * ein zweites Geraet desselben Kontos loest einen auf dem ersten angezeigten
 * Code ein und bekommt danach dessen lokalen Verlauf (`lib/verlauf/**`) —
 * unabhaengig davon, ob die zugrundeliegenden DMs selbst E2E-verschluesselt
 * sind (`GERAETE_KOPPLUNG_ENABLED` ist ein EIGENER Schalter, s. dessen
 * Modulkopf in `krypto/schalter.ts`). Der lokale Verlauf fuellt sich laut
 * `verlauf/index.ts::verlaufSpeichern` fuer JEDEN DM-Kanal, verschluesselt
 * oder nicht — dieser Test faehrt deshalb bewusst den KLARTEXT-DM-Weg
 * (`E2E_DMS_ENABLED` bleibt aus) und prueft trotzdem die Kopplung: die
 * Verschluesselung des UMZUGS selbst haengt an einem eigenen, aus dem
 * angezeigten Code abgeleiteten Schluessel (`kopplung/transport.ts`), nicht
 * an der DM-Verschluesselung.
 *
 * **Der Schalter ist Vorgabe AUS** (`GERAETE_KOPPLUNG_ENABLED = false`) und
 * bleibt es fuer echte Nutzer — hier wie in der Vorlage ohne
 * Quelltextaenderung ueber die Vite-Dev-Antwort umgeschaltet.
 *
 * **Die eigentliche Gegenprobe:** waehrend die Stuecke beim Server liegen
 * (`chat.umzug_stuecke.daten`), darf dort zu KEINEM Zeitpunkt Klartext
 * stehen — weder roh noch als Base64-verpackter Klartext. Nach dem
 * Uebernehmen muessen Kopplung UND Stuecke vom Server verschwunden sein
 * (`kopplung_abschliessen`, von BEIDEN Seiten aufrufbar, hier ausgeloest vom
 * neuen Geraet ueber `verlaufUebernehmen`).
 *
 * ===========================================================================
 * GEFUNDENER PRODUKTIVFEHLER (nicht hier behoben, s. Auftragsbericht)
 * ===========================================================================
 * Dieser Test schlaegt WIEDERHOLBAR, aber nicht bei jedem Lauf fehl:
 * `POST /kopplung/stand` antwortet mit 404 `kopplung_unbekannt`, obwohl die
 * Kopplung Sekunden zuvor mit 200 eingeloest wurde. Ursache, per Netzwerk-Mit-
 * schnitt bestaetigt: `KopplungAnlegenResponse`/`KopplungEinloesenResponse`/
 * `KopplungStandResponse` (`services/chat-gateway/.../kopplung_schemas.py`)
 * geben `id: SnowflakeId` OHNE begleitenden `@field_serializer("id")` heraus
 * — anders als jedes vergleichbare Response-Model in `schemas.py` (dort hat
 * JEDES `SnowflakeId`-Feld einen `@field_serializer`, der es vor der JSON-
 * Ausgabe in einen String wandelt, s. CLAUDE.md „Snowflake-IDs als Strings").
 * Ohne den Serializer liefert FastAPI die ID als rohe JSON-Zahl; ein
 * Kopplungs-Snowflake liegt weit ueber `Number.MAX_SAFE_INTEGER`
 * (2^53 - 1 ≈ 9·10^15, eine Kopplungs-ID typischerweise ≈ 8,8·10^16), der
 * Browser rundet sie beim Parsen. Die anschliessend vom Klienten
 * zurueckgeschickte `kopplung_id` ist dann eine ANDERE Zahl als die, unter
 * der der Server die Zeile fuehrt — 404. Beobachtet z. B.: Antwort auf
 * `einloesen` nannte `88088470714589184`, die naechste Anfrage schickte
 * `88088470714589180` fuer dieselbe Kopplung. Der Fehler trifft nicht jeden
 * Lauf, weil nicht jede Snowflake beim Runden ihre letzten Ziffern verliert
 * — reine Bit-Arithmetik, kein Netzwerk-Flackern.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const ts = Date.now();
const ALICE = {
  username: `alice_e2ekopp_${ts}`,
  email: `alice_e2ekopp_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_e2ekopp_${ts}`,
  email: `bob_e2ekopp_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

/** Faengt die Vite-Dev-Antwort fuer `schalter.ts` ab und stellt die beiden
 *  Schalter, die dieser Nachweis braucht. Muss VOR jeder Navigation im
 *  Context stehen: `GeraeteKopplungSection.svelte` importiert das Modul schon
 *  beim ersten App-Laden.
 *
 *  **Zwei Schalter, und der zweite geht ABSICHTLICH in die Gegenrichtung.**
 *  `GERAETE_KOPPLUNG_ENABLED` an — das ist der Gegenstand. `E2E_DMS_ENABLED`
 *  aus, obwohl er seit dem 2026-09-01 im Quelltext an ist: dieser Nachweis
 *  prueft den Umzug eines KLARTEXT-Verlaufs, und mit angeschalteter
 *  Verschluesselung entstehen keine Klartext-Nachrichten mehr, an denen sich
 *  das zeigen liesse (so am 2026-09-01 rot geworden).
 *
 *  Das ist kein Kunstgriff, um einen Test am Leben zu halten, sondern der
 *  Fall, der beim Umlegen tatsaechlich eintritt: JEDER Bestandsnutzer hat in
 *  diesem Moment genau so einen Verlauf auf der Platte — unverschluesselt,
 *  vor der Umstellung entstanden — und koppelt sein zweites Geraet damit.
 *  Der verschluesselte Umzug ist an anderer Stelle gedeckt
 *  (`e2e-dm.spec.ts`, `e2e-dm-hetzner.spec.ts`). */
async function kopplungSchalterEinschalten(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/krypto/schalter.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const ohneKrypto = text.replace('E2E_DMS_ENABLED = true', 'E2E_DMS_ENABLED = false');
    if (ohneKrypto === text && !text.includes('E2E_DMS_ENABLED = false')) {
      throw new Error(
        'Weder "E2E_DMS_ENABLED = true" noch "= false" in schalter.ts gefunden — ' +
          'ohne diesen Schalter kann der Nachweis keinen Klartext-Verlauf anlegen.'
      );
    }
    const gepatcht = ohneKrypto.replace(
      'GERAETE_KOPPLUNG_ENABLED = false',
      'GERAETE_KOPPLUNG_ENABLED = true'
    );
    // Gegen `ohneKrypto` vergleichen, nicht gegen `text`: der Text wurde oben
    // schon einmal veraendert, ein Vergleich mit dem Original waere hier
    // immer ungleich und die Pruefung damit wirkungslos.
    if (gepatcht === ohneKrypto && !ohneKrypto.includes('GERAETE_KOPPLUNG_ENABLED = true')) {
      throw new Error(
        `Weder "GERAETE_KOPPLUNG_ENABLED = false" noch "= true" in schalter.ts gefunden — ` +
          'Datei umbenannt oder Konstante umformuliert? (Der Schalter ist seit ' +
          'dem 2026-09-01 an; dieses Abfangen haelt den Nachweis unabhaengig ' +
          'von seinem Stand.)'
      );
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

/** Wie `friends.spec.ts` — Kreuz-Anfragen, die zweite akzeptiert automatisch. */
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

/** Oeffnet die Sicherheits-Registerkarte der Nutzereinstellungen — Weg wie
 *  `passkeys.spec.ts::registerAndOpenSecurity`. */
async function sicherheitTabOeffnen(page: Page): Promise<void> {
  await page.getByTestId('user-footer-trigger').click();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-tab-security').click();
  await expect(page.getByTestId('geraete-kopplung')).toBeVisible();
}

/** Liest alle Saetze des lokalen Verlaufs (`pulse-verlauf`, Speicher
 *  `nachrichten`) eines Kontos direkt aus der IndexedDB des Browsers — kein
 *  Umweg ueber die Oberflaeche, dieselbe Datenbank, gegen die
 *  `verlauf/db.ts::verlaufAlleLesen` liest. Leere Liste, wenn die Datenbank
 *  (noch) gar nicht existiert (frisches Geraet). */
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

/** Die juengste Kopplungszeile eines Kontos — `''`, wenn noch keine existiert. */
function juengsteKopplungId(userId: string): string {
  return pgQuery(
    `SELECT id FROM chat.kopplungen WHERE user_id = ${userId} ` +
      `ORDER BY created_at DESC LIMIT 1;`
  );
}

function anzahlKopplungszeilen(kopplungId: string): number {
  return Number(pgQuery(`SELECT count(*) FROM chat.kopplungen WHERE id = ${kopplungId};`));
}

function anzahlUmzugStuecke(kopplungId: string): number {
  return Number(
    pgQuery(`SELECT count(*) FROM chat.umzug_stuecke WHERE kopplung_id = ${kopplungId};`)
  );
}

/** `daten` aller Umzug-Stuecke einer Kopplung — fuer die Ciphertext-Pruefung,
 *  NICHT nur fuer Zeilenzahlen (s. `e2e-dm.spec.ts`). */
function umzugStueckeDaten(kopplungId: string): string[] {
  const raw = pgQuery(
    `SELECT string_agg(daten, '|') FROM chat.umzug_stuecke WHERE kopplung_id = ${kopplungId};`
  );
  return raw ? raw.split('|') : [];
}

/** Pollt, bis mindestens ein Umzug-Stueck fuer die Kopplung vorliegt — Muster
 *  wie `e2e-dm.spec.ts::nutzlastDatenBisVorhanden`. */
async function umzugStueckeBisVorhanden(
  kopplungId: string,
  timeoutMs = 15_000
): Promise<string[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const gefunden = umzugStueckeDaten(kopplungId);
    if (gefunden.length > 0) return gefunden;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

test.describe.serial('E2E-Geraete-Kopplung (Etappe F, Nachweis E11)', () => {
  let aliceACtx: BrowserContext;
  let aliceAPage: Page;
  let aliceBCtx: BrowserContext;
  let aliceBPage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;

  let aliceUserId = '';
  let dmChannelId = '';

  const KLARTEXT_1 = 'erste Nachricht auf Geraet A, vor der Kopplung';
  const KLARTEXT_2 = 'antwort von bob, ebenfalls vor der Kopplung';
  const KLARTEXT_3 = 'noch eine von alice, damit es mehr als ein Stueck Verlauf sind';
  const ALLE_KLARTEXTE = [KLARTEXT_1, KLARTEXT_2, KLARTEXT_3];

  test.beforeAll(async ({ browser }) => {
    aliceACtx = await browser.newContext();
    bobCtx = await browser.newContext();
    for (const ctx of [aliceACtx, bobCtx]) {
      // Wie in der Vorlage: der Changelog-Toast darf keine Klicks abfangen.
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
      await kopplungSchalterEinschalten(ctx);
    }
    aliceAPage = await aliceACtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceACtx.close();
    await aliceBCtx?.close();
    await bobCtx.close();
  });

  test('alice und bob sind befreundet, ein DM-Kanal traegt drei Klartext-Nachrichten auf Geraet A', async () => {
    await register(aliceAPage, ALICE);
    await register(bobPage, BOB);
    aliceUserId = await currentUserId(aliceAPage);
    const bobUserId = await currentUserId(bobPage);

    await becomeFriends(aliceAPage, aliceUserId, bobPage, bobUserId);
    dmChannelId = await createDmChannel(aliceAPage, bobUserId);
    expect(dmChannelId).toMatch(/^\d+$/);

    // Bob muss VOR dem Senden auf der DM-Seite stehen (WS-Abonnement) —
    // dieselbe Begruendung wie in `e2e-dm.spec.ts`.
    await bobPage.goto(`/app/@me/${dmChannelId}`);
    await expect(bobPage.getByTestId('active-channel-name')).toHaveText(ALICE.username, {
      timeout: 10_000
    });
    await aliceAPage.goto(`/app/@me/${dmChannelId}`);
    await expect(aliceAPage.getByTestId('active-channel-name')).toHaveText(BOB.username, {
      timeout: 10_000
    });

    await aliceAPage.getByTestId('message-input').fill(KLARTEXT_1);
    await aliceAPage.getByTestId('message-input').press('Enter');
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: KLARTEXT_1 })
    ).toBeVisible({ timeout: 10_000 });

    await bobPage.getByTestId('message-input').fill(KLARTEXT_2);
    await bobPage.getByTestId('message-input').press('Enter');
    await expect(
      aliceAPage.locator('[data-testid="message-content"]', { hasText: KLARTEXT_2 })
    ).toBeVisible({ timeout: 10_000 });

    await aliceAPage.getByTestId('message-input').fill(KLARTEXT_3);
    await aliceAPage.getByTestId('message-input').press('Enter');
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: KLARTEXT_3 })
    ).toBeVisible({ timeout: 10_000 });

    // Der Klartext-DM-Weg fuellt den lokalen Verlauf unabhaengig von
    // `E2E_DMS_ENABLED` (`verlauf/index.ts::verlaufSpeichern`, jeder DM-Kanal)
    // — genau das macht den Verlauf ueberhaupt zu einer Nutzlast fuer die
    // Kopplung, bevor eine einzige DM verschluesselt ist.
    await expect
      .poll(() => lokalerVerlaufInhalt(aliceAPage, aliceUserId), { timeout: 10_000 })
      .toHaveLength(ALLE_KLARTEXTE.length);
    const inhaltGeraetA = await lokalerVerlaufInhalt(aliceAPage, aliceUserId);
    expect(new Set(inhaltGeraetA)).toEqual(new Set(ALLE_KLARTEXTE));
  });

  test('ein zweites Geraet meldet sich mit denselben Zugangsdaten an — sein lokaler Verlauf ist leer', async ({
    browser
  }) => {
    aliceBCtx = await browser.newContext();

    await aliceBCtx.route('**/changelog.json', (route) =>
      route.fulfill({ json: { entries: [] } })
    );
    await kopplungSchalterEinschalten(aliceBCtx);
    aliceBPage = await aliceBCtx.newPage();

    await login(aliceBPage, ALICE);
    expect(await currentUserId(aliceBPage)).toBe(aliceUserId);

    // Ein frisches Geraet — ohne Kopplung darf hier nichts stehen. Ist diese
    // Erwartung verletzt, waere jede spaetere Pruefung wertlos (sie koennte
    // nicht zwischen "durch die Kopplung angekommen" und "war schon da"
    // unterscheiden).
    expect(await lokalerVerlaufInhalt(aliceBPage, aliceUserId)).toEqual([]);
  });

  test('Geraet A zeigt einen Code, Geraet B loest ihn ein — der Server sieht den Verlauf nie im Klartext', async () => {
    // Grosszuegiger als die Vorgabe (30s): dieser eine Durchlauf deckt beide
    // Oberflaechen, den 2s-Poll-Takt von `KopplungZeigen.svelte` UND den
    // Umzug selbst — bewusst nicht in mehrere Tests zerlegt, weil beide
    // Geraete durchgehend denselben Kopplungszustand teilen muessen.
    test.setTimeout(90_000);

    await sicherheitTabOeffnen(aliceAPage);
    await aliceAPage.getByTestId('kopplung-tab-zeigen').click();
    await aliceAPage.getByTestId('kopplung-code-erzeugen').click();
    const codeAnzeige = await aliceAPage.getByTestId('kopplung-code').innerText();
    expect(codeAnzeige.replace(/[\s-]/g, '')).toHaveLength(20);

    await sicherheitTabOeffnen(aliceBPage);
    await aliceBPage.getByTestId('kopplung-tab-eingeben').click();
    await aliceBPage.getByTestId('kopplung-eingabe').fill(codeAnzeige);
    await aliceBPage.getByTestId('kopplung-einloesen').click();

    // Erst nachweisen, dass die Einloesung selbst gelang (nicht nur, dass
    // spaeter irgendwann ein Stueck auftaucht) — sonst waere ein Fehlschlag
    // hier vom Fehlschlag "kein Stueck gefunden" weiter unten nicht zu
    // unterscheiden. Drei moegliche Folgezustaende, je nachdem wie weit
    // Geraet A mit dem Schieben schon war, als `standPruefen()` (in
    // `einloesen()` verkettet) lief: noch nicht bereit
    // (`kopplung-stand-pruefen` — der Knopf im Wartezweig; der Text daneben
    // hat keine eigene Kennung), schon bereit (`kopplung-uebernehmen` —
    // Geraet A kann bei einem kleinen Verlauf schneller fertig sein, als
    // dieser Test zum Abtippen des Codes braucht), oder ein Fehler.
    await expect(
      aliceBPage
        .getByTestId('kopplung-fehler')
        .or(aliceBPage.getByTestId('kopplung-stand-pruefen'))
        .or(aliceBPage.getByTestId('kopplung-empfang-fortschritt'))
        .or(aliceBPage.getByTestId('kopplung-uebernehmen'))
    ).toBeVisible({ timeout: 15_000 });
    if ((await aliceBPage.getByTestId('kopplung-fehler').count()) > 0) {
      throw new Error(`Einloesen schlug fehl: ${await aliceBPage.getByTestId('kopplung-fehler').innerText()}`);
    }

    // Ab hier existiert serverseitig eine eingeloeste Kopplung — die
    // eigentliche Ciphertext-Pruefung, direkt am gespeicherten Byte-Inhalt,
    // NICHT nur an Zeilenzahlen (s. `e2e-dm.spec.ts`-Docstring fuer dieselbe
    // Begruendung).
    const kopplungId = juengsteKopplungId(aliceUserId);
    expect(kopplungId).toMatch(/^\d+$/);

    const stuecke = await umzugStueckeBisVorhanden(kopplungId, 20_000);
    expect(
      stuecke.length,
      'kein Umzug-Stueck gefunden — entweder kam der Schiebe-Vorgang nie an, ' +
        'oder Geraet A hatte den Takt (2s) noch nicht ausgeloest'
    ).toBeGreaterThan(0);
    for (const daten of stuecke) {
      for (const klartext of ALLE_KLARTEXTE) {
        // Roh: eine "Verschluesselung", die den Klartext unveraendert
        // mitfuehrt, faellt schon hier auf.
        expect(daten).not.toContain(klartext);
        // Dekodiert: der eigentliche Regressionsfall — Base64(Klartext)
        // statt echter Verschluesselung. Node toleriert fehlendes Padding
        // beim Dekodieren, hier aber ohnehin ueberfluessig: `transport.ts`
        // kodiert MIT Padding.
        const dekodiert = Buffer.from(daten, 'base64').toString('utf8');
        expect(dekodiert).not.toContain(klartext);
      }
    }

    // Geraet A meldet "fertig" (`kopplung-zeigen-fertig`), sobald das letzte
    // Stueck liegt UND `POST /kopplung/fertig` durch ist — erst dann kennt
    // Geraet B die Gesamtzahl und darf uebernehmen.
    await expect(aliceAPage.getByTestId('kopplung-zeigen-fertig')).toBeVisible({
      timeout: 15_000
    });

    // Geraet B pollt "Stand pruefen", bis der Uebernehmen-Knopf erscheint —
    // es gibt keinen Push dafuer (`KopplungEinloesen.svelte`-Modulkopf: der
    // Nutzer klickt bewusst selbst).
    await expect
      .poll(
        async () => {
          const knopf = aliceBPage.getByTestId('kopplung-stand-pruefen');
          if ((await knopf.count()) > 0) await knopf.click();
          return aliceBPage.getByTestId('kopplung-uebernehmen').count();
        },
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0);

    await aliceBPage.getByTestId('kopplung-uebernehmen').click();
    await expect(aliceBPage.getByTestId('kopplung-uebernommen')).toBeVisible({ timeout: 15_000 });
    await expect(aliceBPage.getByTestId('kopplung-uebernommen')).toContainText(
      String(ALLE_KLARTEXTE.length)
    );

    // Der eigentliche Kopplungs-Nachweis: Geraet B traegt danach denselben
    // Verlauf wie Geraet A — nicht nur dieselbe Anzahl.
    const inhaltGeraetB = await lokalerVerlaufInhalt(aliceBPage, aliceUserId);
    expect(new Set(inhaltGeraetB)).toEqual(new Set(ALLE_KLARTEXTE));

    // Und die Gegenprobe, die diese ganze Bauart traegt: nach dem Uebernehmen
    // ist `POST /kopplung/abschliessen` gelaufen (`empfangen.ts::verlaufUebernehmen`)
    // — Kopplung UND Stuecke sind vom Server verschwunden, es bleibt nichts
    // liegen, das rueckwirkend Klartext preisgeben koennte.
    await expect.poll(() => anzahlKopplungszeilen(kopplungId), { timeout: 10_000 }).toBe(0);
    expect(anzahlUmzugStuecke(kopplungId)).toBe(0);
  });
});
