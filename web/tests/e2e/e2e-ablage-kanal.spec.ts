import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Der Nachweis fuer Aufgabe 6 aus
 * `docs/superpowers/plans/2026-09-01-ablage-e6-kanal-krypto.md`: ein
 * Guild-Kanal mit `ablage=true` traegt verschluesselte Nachrichten ueber das
 * Postfach — und der Server sieht den Klartext nie.
 *
 * Gebaut nach dem Vorbild von `e2e-dm.spec.ts` (dieselbe Struktur, dieselbe
 * DB-Gegenprobe gegen denselben lokalen Postgres-Container), NICHT nach
 * `e2e-dm-hetzner.spec.ts` — dieser Lauf ist ausdruecklich lokal, der
 * Hetzner-Stack wird von mehreren Rechnern geteilt und nachts nicht
 * angefasst.
 *
 * **Zwei Schalter statt einem**, weil Ablage-Kanaele HINTER
 * `ABLAGE_KANAL_ENABLED` liegen (`web/src/lib/featureFlags.ts`), nicht
 * hinter `E2E_DMS_ENABLED` (`web/src/lib/krypto/schalter.ts` — das ist der
 * Schalter fuer Direktnachrichten, ein anderes Feature, s. dessen
 * Modulkopf). Beide bleiben fuer echte Nutzer AUS; hier werden beide ohne
 * Quelltextaenderung ueber die Vite-Dev-Server-Antwort umgeschaltet, exakt
 * wie in der Vorlage.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

const ts = Date.now();
const ALICE = {
  username: `alice_e2eabl_${ts}`,
  email: `alice_e2eabl_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};
const BOB = {
  username: `bob_e2eabl_${ts}`,
  email: `bob_e2eabl_${ts}@dcc-test.example.com`,
  password: 'sup3r-secret-pass'
};

/** Faengt die Vite-Dev-Antwort fuer `featureFlags.ts` ab und dreht
 *  `ABLAGE_KANAL_ENABLED` auf `true` — der Quelltext im Repo bleibt
 *  unangetastet. Muss VOR jeder Navigation im Context stehen, s.
 *  `e2e-dm.spec.ts::schalterEinschalten`. */
async function ablageSchalterEinschalten(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/featureFlags.ts*', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const gepatcht = text.replace('ABLAGE_KANAL_ENABLED = false', 'ABLAGE_KANAL_ENABLED = true');
    if (gepatcht === text) {
      throw new Error(
        'Textmuster "ABLAGE_KANAL_ENABLED = false" nicht in featureFlags.ts gefunden — ' +
          'Datei umbenannt oder Konstante umformuliert?'
      );
    }
    await route.fulfill({ response: antwort, body: gepatcht });
  });
}

/** Taeuscht die Electron-Bruecke vor — Muster wie `e2e-dm.spec.ts`. Fuer
 *  Guild-Kanaele erzwingt die Koexistenz-Regel (anders als bei DMs) KEIN
 *  dauerhaftes Geraet auf beiden Seiten (`gruppengeraete.ts`-Modulkopf: die
 *  Regel gilt nur fuer DMs), der Stub steht trotzdem, weil andere Stellen
 *  der App (`ShortcutHost.svelte`, `TraySync.svelte`, …) optional-chained
 *  danach greifen und `store`/`notify` Pflichtfelder von `PulseApi` sind. */
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

async function apiPost(
  page: Page,
  path: string,
  body: unknown
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ path, body }) => {
      const token = localStorage.getItem('dcc.tokens.access');
      const resp = await fetch(`/api/chat${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      return { status: resp.status, body: await resp.text() };
    },
    { path, body }
  );
}

/** Wie `e2e-dm.spec.ts::becomeFriends` — Kreuz-Anfragen, zweite akzeptiert
 *  automatisch. **Hier NUR als Werkzeug, um einen gefundenen Produktfehler
 *  zu umgehen** (s. Bericht): `schluessel_zugriff.py::darf_schluessel_holen`
 *  erlaubt das Abholen fremder Geraetebuendel nur bei Freundschaft, Blockade
 *  oder einer GEMEINSAMEN PRIVATEN GRUPPE (`teilen_private_gruppe`) — eine
 *  gemeinsame Guild-Mitgliedschaft (erst recht in einem Ablage-Kanal) zaehlt
 *  NICHT. Ohne diesen Umweg bleibt `keys/claim` fuer zwei nicht befreundete
 *  Guild-Mitglieder leer und die Sitzung kann kein Zielgeraet finden. */
async function becomeFriends(pageA: Page, uidA: string, pageB: Page, uidB: string): Promise<void> {
  const send = async (page: Page, targetId: string) => {
    const r = await apiPost(page, '/friend-requests', { target_user_id: targetId });
    if (r.status !== 201) throw new Error(`friend-request failed ${r.status}: ${r.body}`);
  };
  await send(pageA, uidB);
  await send(pageB, uidA);
}

async function createGuild(page: Page, name: string): Promise<string> {
  const r = await apiPost(page, '/guilds', { name });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`guilds create failed ${r.status}: ${r.body}`);
  }
  return (JSON.parse(r.body) as { id: string }).id;
}

async function inviteAndJoin(hostPage: Page, guildId: string, joinerPage: Page): Promise<void> {
  const invite = await apiPost(hostPage, `/guilds/${guildId}/invites`, {});
  if (invite.status !== 201) {
    throw new Error(`invite create failed ${invite.status}: ${invite.body}`);
  }
  const code = (JSON.parse(invite.body) as { code: string }).code;
  const accept = await apiPost(joinerPage, `/invites/${code}/accept`, {});
  if (accept.status !== 200 && accept.status !== 201) {
    throw new Error(`invite accept failed ${accept.status}: ${accept.body}`);
  }
}

/** Legt den Ablage-Kanal an (`services/chat-gateway/tests/test_ablage_policy.py`
 *  zeigt denselben Vertrag: `ablage: true` im Erstell-Body). */
async function createAblageChannel(page: Page, guildId: string, name: string): Promise<string> {
  const r = await apiPost(page, `/guilds/${guildId}/channels`, { name, ablage: true });
  if (r.status !== 201) {
    throw new Error(`channel create failed ${r.status}: ${r.body}`);
  }
  const kanal = JSON.parse(r.body) as { id: string; ablage: boolean };
  if (kanal.ablage !== true) {
    throw new Error(`Kanal traegt nicht ablage=true: ${r.body}`);
  }
  return kanal.id;
}

/** Wie `e2e-dm.spec.ts::warteAufSchluesselbuendel` — wartet, bis ein
 *  Geraeteschluesselbuendel fuer `userId` veroeffentlicht ist. Ohne diese
 *  Wartezeit koennte die Gruppensitzung leer bleiben, weil noch kein
 *  Zielgeraet existiert. */
async function warteAufSchluesselbuendel(page: Page, userId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const antwort = await apiPost(page, '/keys/claim', { user_ids: [userId] });
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

/** Wie `e2e-dm.spec.ts::pgQuery` — `docker exec` gegen denselben Container,
 *  den `_globalSetup.ts::truncateDb` verwendet, dieselbe `dcc_test`-DB. */
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

/** Holt `daten` aller Nutzlasten eines Kanals — genutzt fuer die eigentliche
 *  Ciphertext-Pruefung, NICHT nur fuer Zeilenzahlen (s. `e2e-dm.spec.ts`). */
function nutzlastDatenFuerKanal(channelId: string): string[] {
  const raw = pgQuery(
    `SELECT string_agg(daten, '|') FROM chat.dm_nutzlasten WHERE channel_id = ${channelId};`
  );
  return raw ? raw.split('|') : [];
}

async function nutzlastDatenBisVorhanden(
  channelId: string,
  timeoutMs = 8_000
): Promise<string[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const gefunden = nutzlastDatenFuerKanal(channelId);
    if (gefunden.length > 0) return gefunden;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

test.describe.serial('E2E-verschluesselter Ablage-Kanal (Etappe E6, Nachweis Aufgabe 6)', () => {
  let aliceCtx: BrowserContext;
  let alicePage: Page;
  let bobCtx: BrowserContext;
  let bobPage: Page;
  let guildId = '';
  let kanalId = '';
  const KANAL_NAME = `ablage-raum-${ts}`;

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    for (const ctx of [aliceCtx, bobCtx]) {
      // Wie e2e-dm.spec.ts: der Changelog-Toast darf keine Klicks abfangen.
      await ctx.route('**/changelog.json', (route) => route.fulfill({ json: { entries: [] } }));
      await ablageSchalterEinschalten(ctx);
      await alsElektronGeraetAusgeben(ctx);
    }
    alicePage = await aliceCtx.newPage();
    bobPage = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test('beide registrieren sich, eine Community, ein Ablage-Kanal, Buendel sind veroeffentlicht', async () => {
    await register(alicePage, ALICE);
    await register(bobPage, BOB);
    const aliceUserId = await currentUserId(alicePage);
    const bobUserId = await currentUserId(bobPage);

    // Umgeht einen gefundenen Produktfehler, s. `becomeFriends`-Docstring
    // und Bericht: `keys/claim` gibt fuer ein nicht befreundetes
    // Guild-Mitglied eine leere Liste zurueck, egal ob ein gemeinsamer
    // Ablage-Kanal besteht.
    await becomeFriends(alicePage, aliceUserId, bobPage, bobUserId);

    guildId = await createGuild(alicePage, `Ablage-Community ${ts}`);
    await inviteAndJoin(alicePage, guildId, bobPage);

    kanalId = await createAblageChannel(alicePage, guildId, KANAL_NAME);
    expect(kanalId).toMatch(/^\d+$/);

    // Sicherstellen, dass BEIDE Geraete ein Ziel abgeben, bevor gesendet
    // wird — sonst waere die Mitgliederliste beim ersten Senden leer.
    await warteAufSchluesselbuendel(alicePage, aliceUserId);
    await warteAufSchluesselbuendel(bobPage, bobUserId);
  });

  test('bob steht schon im Kanal (abonniert), bevor alice schreibt', async () => {
    // `postfach_neu` ist kanalgebunden — nur ein auf den Kanal abonnierter
    // Socket bekommt den Weckruf live (dieselbe Begruendung wie im
    // DM-Nachweis). Bob muss also VOR dem Senden auf der Kanalseite stehen.
    await bobPage.goto(`/app/guilds/${guildId}/channels/${kanalId}`);
    await expect(bobPage.getByTestId('active-channel-name')).toHaveText(KANAL_NAME, {
      timeout: 10_000
    });
  });

  test('alice schreibt verschluesselt in den Ablage-Kanal, bob liest den Klartext — UND der Server hat ihn nie gesehen', async () => {
    await alicePage.goto(`/app/guilds/${guildId}/channels/${kanalId}`);
    const KLARTEXT = 'nur wer im Kanal ist soll das lesen koennen';

    await alicePage.getByTestId('message-input').click();
    await alicePage.getByTestId('message-input').fill(KLARTEXT);
    await alicePage.getByTestId('message-input').press('Enter');

    // 1. Die eigentliche Behauptung, direkt am gespeicherten Byte-Inhalt
    // geprueft, nicht nur an Zeilenzahlen (s. `e2e-dm.spec.ts`-Docstring).
    const umschlaege = await nutzlastDatenBisVorhanden(kanalId);
    expect(
      umschlaege.length,
      'kein Umschlag im Postfach gefunden — entweder kam er nie an, oder die ' +
        'Quittung war schneller als diese Pruefung'
    ).toBeGreaterThan(0);
    for (const daten of umschlaege) {
      expect(daten).not.toContain(KLARTEXT);
      const dekodiert = Buffer.from(daten, 'base64').toString('utf8');
      expect(dekodiert).not.toContain(KLARTEXT);
    }

    // 2. Die Grundbehauptung: bob sieht den Klartext.
    //
    // **Gefundene Rennsituation (kein Fix hier, s. Bericht):** die ERSTE
    // Nachricht einer neuen Megolm-Sitzung liefert der Absender in ZWEI
    // getrennten `POST /postfach`-Aufrufen aus (erst der Verteilschluessel,
    // dann die Nachricht selbst, `kanalSenden.ts`/`gruppenEinliefern.ts`).
    // Jeder Aufruf loest sein EIGENES `postfach_neu`-WS-Ereignis aus.
    //
    // Bis zum 2026-09-01 verschluckte `empfangen.ts` die zweite Weckung, wenn
    // sie waehrend der Abholung der ersten eintraf — die eigentliche
    // Nachricht blieb dann liegen, bis ein Neuverbinden ausloeste. Dieser
    // Test brauchte dafuer ein Seiten-Neuladen als Ruecksicherung.
    //
    // `krypto/postfachNachlauf.ts` merkt die Weckung jetzt vor und laesst
    // den Zyklus danach genau einmal nachlaufen. Die Ruecksicherung ist
    // deshalb entfallen: dass die Nachricht OHNE Neuladen ankommt, ist der
    // eigentliche Nachweis, dass der Fix haelt.
    const nachrichtSichtbar = bobPage.locator('[data-testid="message-content"]', {
      hasText: KLARTEXT
    });
    await expect(nachrichtSichtbar).toBeVisible({ timeout: 15_000 });

    // 3. Die Gegenprobe: `chat.messages` bleibt fuer diesen Kanal leer.
    expect(anzahlKlartextNachrichten(kanalId)).toBe(0);

    // Und nach der Quittung liegt im Postfach nichts mehr fuer diesen Kanal.
    await expect
      .poll(() => anzahlOffenerZustellungen(kanalId), { timeout: 10_000 })
      .toBe(0);
    expect(anzahlNutzlasten(kanalId)).toBe(0);
  });

  test('die Umkehrung: Klartext-Post in denselben Kanal wird abgewiesen', async () => {
    // Derselbe REST-Weg, den ein gewoehnlicher Textkanal nutzt
    // (`chatApi.sendMessage` -> `POST /channels/{id}/messages`) — fuer einen
    // Ablage-Kanal ist er serverseitig gesperrt (B1,
    // `test_ablage_policy.py::test_nachricht_in_ablage_kanal_wird_verworfen`).
    const KLARTEXT_VERBOTEN = 'das sollte der Server nie annehmen';
    const r = await apiPost(alicePage, `/channels/${kanalId}/messages`, {
      content: KLARTEXT_VERBOTEN
    });
    expect(r.status, `erwartet 403, war ${r.status}: ${r.body}`).toBe(403);

    // Und in der Datenbank ist trotz des Versuchs nichts gelandet.
    expect(anzahlKlartextNachrichten(kanalId)).toBe(0);
  });
});
