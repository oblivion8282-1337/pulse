import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Der Nachweis, dass Etappe D2 wirklich funktioniert (Plan Task 4,
 * `docs/superpowers/plans/2026-08-28-etappe-d2-klient-verschluesselt.md`).
 *
 * Alles Bisherige — Krypto-Kern, Schluesselverzeichnis, Postfach, lokaler
 * Verlauf, Senden/Empfangen — wurde nur einzeln geprueft. Dieser Test prueft
 * das zusammengesetzte Ganze UND die eigentliche Behauptung des gesamten
 * Vorhabens: **der Server sieht den Klartext nie.** Ohne die DB-Pruefung
 * unten waere das hier nur ein Test dafuer, dass irgendeine Nachricht
 * ankommt — das leistet der bestehende Klartext-Weg (`dms.spec.ts`) schon.
 *
 * **Der Schalter ist Vorgabe AUS** (`$lib/krypto/schalter.ts`,
 * `E2E_DMS_ENABLED = false`) und bleibt es fuer echte Nutzer — das Umlegen
 * ist Handarbeit des Eigentuemers (CLAUDE.md). Fuer DIESEN Test wird er ohne
 * Quelltextaenderung eingeschaltet: `schalterEinschalten()` faengt die
 * Vite-Dev-Server-Antwort fuer genau dieses Modul ab und ersetzt NUR den
 * Konstantenwert im ausgelieferten Text — der Quelltext im Repo bleibt
 * unveraendert. Der Dev-Server serviert TS-Module unminifiziert und einzeln
 * (kein Bundling), deshalb reicht ein Text-Ersetzen an der HTTP-Antwort.
 *
 * **Die DB-Pruefung geht direkt gegen Postgres** (`docker exec` auf den von
 * `_globalSetup.ts` verwendeten Container `dcc_night_postgres`, DB
 * `dcc_test`) — dieselbe Instanz, gegen die die ganze Suite laeuft. Kein
 * neues Werkzeug, keine neue Abhaengigkeit: `_globalSetup.ts::truncateDb`
 * spricht denselben Container genauso an.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const ts = Date.now();
const ALICE = {
  username: `alice_e2edm_${ts}`,
  email: `alice_e2edm_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_e2edm_${ts}`,
  email: `bob_e2edm_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

/** Faengt die Vite-Dev-Antwort fuer `schalter.ts` ab und dreht die Konstante
 *  auf `true` — der Quelltext bleibt unangetastet, s. Modulkopf. Muss VOR
 *  jeder Navigation im Context stehen: der Handler `chat.ts` UND die DM-Seite
 *  importieren das Modul schon beim ersten App-Laden. */
async function schalterEinschalten(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/krypto/schalter.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const gepatcht = text.replace('E2E_DMS_ENABLED = false', 'E2E_DMS_ENABLED = true');
    if (gepatcht === text) {
      throw new Error(
        'Textmuster "E2E_DMS_ENABLED = false" nicht in schalter.ts gefunden — ' +
          'Datei umbenannt oder Konstante umformuliert?'
      );
    }
    await route.fulfill({ response: antwort, body: gepatcht });
  });
}

/**
 * Taeuscht die Electron-Bruecke (`window.pulse`) vor — die Koexistenz-Regel
 * (`docs/superpowers/specs/2026-08-28-e2e-dm-design.md` §3) verschluesselt
 * eine DM nur, wenn BEIDE Konten mindestens ein DAUERHAFTES Geraet haben
 * (`krypto/veroeffentlichen.ts::dauerhaft = isElectron() || isCapacitorAndroid()`,
 * `krypto/empfaengerGeraete.ts::zielgeraeteBerechnen` verlangt es auf beiden
 * Seiten). Playwright faehrt einen reinen Browser — ohne diesen Stub waere
 * `dauerhaft` immer `false` und die Suite pruefte den (voellig korrekten)
 * Klartext-Pfad statt des Krypto-Pfads.
 *
 * `isElectron()` prueft nur `window.pulse?.platform === 'electron'`
 * (`platform/runtime.ts`) — der Rest der Bruecke wird trotzdem gebraucht,
 * weil andere Stellen der App (`ShortcutHost.svelte`, `TraySync.svelte`,
 * `servers.svelte.ts::secureStore`, …) NACH `isElectron()` weitere Felder
 * lesen. Die meisten Zugriffe sind optional-chained (`window.pulse?.tray`)
 * und laufen mit einem fehlenden Feld gefahrlos ins No-op — nur `store` und
 * `notify` sind auf `PulseApi` PFLICHTFELDER (`pulse.d.ts`), und
 * `secureStore()` prueft zusaetzlich `typeof store.getAllSync === 'function'`
 * echt als Funktion. Beide sind deshalb hier vollstaendig nachgebaut, alles
 * andere bleibt bewusst weg — kein Code in Login/DM-Fluss greift darauf ohne
 * Optional-Chaining zu.
 */
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
        listApplicationAudio: leer,
        buildArgv: leer,
        start: leer,
        stop: leer,
        onEvent: abmelden
      },
      notify: {
        show: async () => 'stub',
        onClick: abmelden
      }
    };
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

/** Wie `krypto-veroeffentlichen.spec.ts` — dieselbe Route, dasselbe Muster.
 *  Hier nur zum WARTEN benutzt: bevor ein Geraet ein brauchbares Ziel ist,
 *  muss sein Buendel veroeffentlicht sein (`curve25519` gesetzt). Ohne diese
 *  Wartezeit koennte die Koexistenz-Regel greifen (kein Zielgeraet -> Test
 *  liefe klammheimlich den Klartext-Weg statt des zu pruefenden). */
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

/** `docker exec` gegen denselben Container, den `_globalSetup.ts::truncateDb`
 *  verwendet — dieselbe `dcc_test`-DB, gegen die die ganze Suite laeuft.
 *  `PATH` muss den Sudo-Wrapper aus der Betriebsanleitung enthalten (s.
 *  Aufrufbeispiel in der Aufgabenstellung), sonst scheitert schon
 *  `_globalSetup.ts` selbst — dieselbe Voraussetzung, kein Sonderfall hier. */
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

function anzahlKlartextNachrichten(channelId: string): number {
  return Number(pgQuery(`SELECT count(*) FROM chat.messages WHERE channel_id = ${channelId};`));
}

function anzahlOffenerZustellungen(channelId: string): number {
  return Number(
    pgQuery(
      `SELECT count(*) FROM chat.dm_zustellungen z ` +
        `JOIN chat.dm_nutzlasten n ON n.id = z.nutzlast_id ` +
        `WHERE n.channel_id = ${channelId};`
    )
  );
}

function anzahlNutzlasten(channelId: string): number {
  return Number(
    pgQuery(`SELECT count(*) FROM chat.dm_nutzlasten WHERE channel_id = ${channelId};`)
  );
}

/** Holt `daten` aller Nutzlasten eines Kanals — leer, wenn (noch/schon)
 *  keine da ist. Genutzt fuer die eigentliche Ciphertext-Pruefung unten,
 *  NICHT nur fuer Zeilenzahlen: eine "Verschluesselung", die zu
 *  Base64-kodiertem Klartext entartet waere, bestuende jede reine
 *  Zaehl-Pruefung anstandslos. */
function nutzlastDatenFuerKanal(channelId: string): string[] {
  const raw = pgQuery(
    `SELECT string_agg(daten, '|') FROM chat.dm_nutzlasten WHERE channel_id = ${channelId};`
  );
  return raw ? raw.split('|') : [];
}

/** Pollt auf `nutzlastDatenFuerKanal`, bis mindestens eine Zeile da ist —
 *  im Unterschied zu `expect.poll` GIBT diese Funktion den gefangenen Wert
 *  zurueck, den die eigentliche Pruefung braucht. Muss direkt nach dem
 *  Absenden aufgerufen werden, VOR dem Warten auf bobs sichtbare Nachricht:
 *  die Quittung (die die Zeile wieder loescht) kann erst nach der
 *  Zustellung laufen (WS-Weckruf -> abholen -> entschluesseln, s.
 *  `empfangen.ts`), dieser Moment ist also die fruehest- und
 *  zuverlaessigste Gelegenheit, den Umschlag noch im Postfach zu sehen. */
async function nutzlastDatenBisVorhanden(
  channelId: string,
  timeoutMs = 5_000
): Promise<string[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const gefunden = nutzlastDatenFuerKanal(channelId);
    if (gefunden.length > 0) return gefunden;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

test.describe.serial('E2E-verschluesselte Direktnachrichten (Etappe D2, Nachweis)', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let dmChannelId = '';

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    for (const ctx of [aliceCtx, bobCtx]) {
      // Wie dms.spec.ts: der Changelog-Toast darf keine Klicks abfangen.
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
      await schalterEinschalten(ctx);
      await alsElektronGeraetAusgeben(ctx);
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('beide registrieren sich, werden Freunde, Buendel sind veroeffentlicht', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    const aliceUserId = await currentUserId(alicePage);
    const bobUserId = await currentUserId(bobPage);

    await becomeFriends(alicePage, aliceUserId, bobPage, bobUserId);

    // Sicherstellen, dass BEIDE Geraete ein Ziel abgeben — sonst greift
    // Task 2s Koexistenz-Regel und der Test wuerde unbemerkt den
    // Klartext-Weg pruefen statt des verschluesselten.
    await warteAufSchluesselbuendel(alicePage, aliceUserId);
    await warteAufSchluesselbuendel(bobPage, bobUserId);

    dmChannelId = await createDmChannel(alicePage, bobUserId);
    expect(dmChannelId).toMatch(/^\d+$/);
  });

  test('bob ist schon im Gespraech (abonniert), bevor alice schreibt', async () => {
    // `postfach_neu` ist kanalgebunden (`manager.publish(channel_id, …)`,
    // `routes/postfach.py`) — nur ein auf den Kanal abonnierter Socket
    // bekommt den Weckruf live. Bob muss also VOR dem Senden auf der
    // DM-Seite stehen (WS-Op `subscribe`), genau wie im bestehenden
    // Klartext-Pfad (`dms.spec.ts`).
    await bobPage.goto(`/app/@me/${dmChannelId}`);
    await expect(bobPage.getByTestId('active-channel-name')).toHaveText(ALICE.username, {
      timeout: 10_000
    });
  });

  test('alice schreibt verschluesselt, bob liest den Klartext — UND der Server hat ihn nie gesehen', async () => {
    await alicePage.goto(`/app/@me/${dmChannelId}`);
    const KLARTEXT_1 = 'nur du und ich sollen das lesen koennen';

    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill(KLARTEXT_1);
    await alicePage.getByTestId('message-input').press('Enter');

    // 1. Die eigentliche Behauptung des ganzen Vorhabens, direkt am
    // gespeicherten Byte-Inhalt geprueft, NICHT nur an Zeilenzahlen: der
    // Server sieht den Klartext nie — auch nicht als Base64-verpackten
    // Klartext, was jede reine Zaehl-Pruefung unten anstandslos bestuende.
    // Muss VOR dem Warten auf bobs sichtbare Nachricht laufen, s.
    // `nutzlastDatenBisVorhanden`-Docstring.
    const umschlaege = await nutzlastDatenBisVorhanden(dmChannelId);
    expect(
      umschlaege.length,
      'kein Umschlag im Postfach gefunden — entweder kam er nie an, oder die ' +
        'Quittung war schneller als diese Pruefung (siehe Docstring)'
    ).toBeGreaterThan(0);
    for (const daten of umschlaege) {
      // Roh: eine Verschluesselung, die den Klartext unveraendert mitfuehrt
      // (z. B. angehaengt statt ersetzt), faellt schon hier auf.
      expect(daten).not.toContain(KLARTEXT_1);
      // Dekodiert: der eigentliche Regressionsfall — "Verschluesselung", die
      // zu blossem Base64(Klartext) entartet ist. Node toleriert fehlendes
      // Padding beim Dekodieren (der Krypto-Kern liefert ohnehin unpolstert,
      // s. `krypto/pulse-krypto`-Modul-Docstring in `CLAUDE.md`).
      const dekodiert = Buffer.from(daten, 'base64').toString('utf8');
      expect(dekodiert).not.toContain(KLARTEXT_1);
    }

    // 2. Die Grundbehauptung: bob sieht den Klartext, live per WS.
    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: KLARTEXT_1 })
    ).toBeVisible({ timeout: 10_000 });

    // 3. `chat.messages` bleibt fuer diesen Kanal leer — waere die
    // verschluesselte Zustellung stillschweigend auf den Klartext-Weg
    // zurueckgefallen (Koexistenz-Bug oder Schalter-Patch wirkungslos),
    // stuende hier eine Zeile.
    expect(anzahlKlartextNachrichten(dmChannelId)).toBe(0);

    // Und nach der Quittung (asynchron, s. `empfangen.ts`: erst ablegen,
    // dann quittieren) liegt im Postfach nichts mehr fuer diesen Kanal.
    await expect
      .poll(() => anzahlOffenerZustellungen(dmChannelId), { timeout: 10_000 })
      .toBe(0);
    // Und die Nutzlast selbst faellt mit ihrer letzten Zustellung
    // (`routes/postfach_abholen.py::postfach_quittung`) — keine Leiche.
    expect(anzahlNutzlasten(dmChannelId)).toBe(0);
  });

  test('eine zweite Nachricht in derselben Sitzung kommt ebenfalls an', async () => {
    // Beweist, dass der Ratchet korrekt weiterdreht UND der Sitzungszustand
    // wirklich persistiert wurde (Task 1s zentrale Falle: eine nicht
    // gesicherte Sitzung macht die naechste Nachricht endgueltig unlesbar).
    // Diese zweite Nachricht laeuft ueber eine bereits bestehende Sitzung
    // (`sitzungLaden` findet sie), sendet also art=1 (laufende Nachricht),
    // nicht mehr art=0 (Sitzungsaufbau) wie die erste.
    const KLARTEXT_2 = 'und hier gleich noch eine, in derselben Sitzung';

    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill(KLARTEXT_2);
    await alicePage.getByTestId('message-input').press('Enter');

    await expect(
      bobPage.locator('[data-testid="message-content"]', { hasText: KLARTEXT_2 })
    ).toBeVisible({ timeout: 10_000 });

    expect(anzahlKlartextNachrichten(dmChannelId)).toBe(0);
    await expect
      .poll(() => anzahlOffenerZustellungen(dmChannelId), { timeout: 10_000 })
      .toBe(0);
  });
});
