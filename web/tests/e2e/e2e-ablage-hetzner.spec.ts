/**
 * Der Ablage-Kanal gegen eine ECHTE Nextcloud, auf dem Remote-Dev-Stack.
 *
 * **Warum es diesen Nachweis zusaetzlich zu `e2e-ablage-kanal.spec.ts` gibt.**
 * Jener prueft den Krypto-Weg — verschluesselt senden, entschluesselt lesen,
 * Klartext wird abgewiesen — aber er verbindet **kein Laufwerk**: die Woerter
 * „Laufwerk", „Freigabe" und „Nextcloud" kommen darin nicht vor. Er sagt
 * damit nichts darueber, ob die Bytes je in einer Cloud landen und wie sie
 * dort aussehen. Genau das ist hier der Gegenstand.
 *
 * Lauf (Vite wird vom `webServer`-Block gestartet):
 *
 *   cd web && E2E_PG_VIA_SSH=pulse-hetzner-dev pnpm exec playwright test \
 *     tests/e2e/e2e-ablage-hetzner.spec.ts \
 *     --config=tests/e2e/playwright.hetzner.config.ts
 *
 * **Er braucht einen echten Freigabe-Link mit Schreibrecht.** Ohne
 * `E2E_NEXTCLOUD_KANAL` ueberspringt sich die Datei, statt rot zu werden —
 * ein Nachweis, der ohne fremde Zugangsdaten gar nicht laufen KANN, waere
 * als Dauer-Rot wertlos (CLAUDE.md: „ein dauerhaft roter Test kann keine
 * Regression mehr melden").
 *
 * **Der Link wird nie ausgegeben.** Er ist ein Schluessel in Textform: wer
 * ihn hat, darf in den Ordner schreiben und daraus loeschen. Fehlermeldungen
 * hier nennen deshalb hoechstens den Wirt, nie das Token.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

import {
  DEV,
  DEV2,
  alsElektronGeraetAusgeben,
  login,
  currentUserId,
  warteAufSchluesselbuendel,
  pgQuery
} from './_hetzner-helfer.ts';

const FREIGABE = process.env.E2E_NEXTCLOUD_KANAL ?? '';

/** Kennzeichnet diesen Lauf, damit parallele Laeufe und Altbestand im
 *  gemeinsamen Ordner unterscheidbar bleiben — der Stack und die Nextcloud
 *  werden von mehreren Rechnern benutzt. */
const TAG = `e2e${Date.now().toString(36)}`;

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

async function createGuild(page: Page, name: string): Promise<string> {
  const r = await apiPost(page, '/guilds', { name });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`guilds create failed ${r.status}: ${r.body}`);
  }
  return (JSON.parse(r.body) as { id: string }).id;
}

async function createAblageChannel(page: Page, guildId: string, name: string): Promise<string> {
  const r = await apiPost(page, `/guilds/${guildId}/channels`, { name, ablage: true });
  if (r.status !== 201) throw new Error(`channel create failed ${r.status}: ${r.body}`);
  const kanal = JSON.parse(r.body) as { id: string; ablage: boolean };
  if (kanal.ablage !== true) throw new Error(`Kanal traegt nicht ablage=true: ${r.body}`);
  return kanal.id;
}

async function inviteAndJoin(hostPage: Page, guildId: string, joinerPage: Page): Promise<void> {
  const invite = await apiPost(hostPage, `/guilds/${guildId}/invites`, {});
  if (invite.status !== 201) throw new Error(`invite create failed ${invite.status}`);
  const code = (JSON.parse(invite.body) as { code: string }).code;
  const accept = await apiPost(joinerPage, `/invites/${code}/accept`, {});
  if (accept.status !== 200 && accept.status !== 201) {
    throw new Error(`invite accept failed ${accept.status}: ${accept.body}`);
  }
}

/** Listet den Nextcloud-Ordner ueber denselben DAV-Endpunkt, den auch
 *  `freigabeLink.ts` bildet (`/public.php/dav/files/<token>`) — geprueft
 *  wird, was der Klient wirklich benutzt, nicht ein Nachbau. */
async function nextcloudListe(): Promise<{ name: string; groesse: number }[]> {
  const url = new URL(FREIGABE);
  const token = url.pathname.split('/s/')[1]?.replace(/\/.*$/, '') ?? '';
  const basis = `${url.origin}/public.php/dav/files/${token}`;
  const antwort = await fetch(`${basis}/`, {
    method: 'PROPFIND',
    headers: {
      Depth: '1',
      Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`
    }
  });
  if (!antwort.ok && antwort.status !== 207) {
    throw new Error(`Nextcloud antwortete ${antwort.status} auf ${url.host}`);
  }
  const xml = await antwort.text();
  const eintraege: { name: string; groesse: number }[] = [];
  for (const block of xml.split('<d:response>').slice(1)) {
    const href = /<d:href>(.*?)<\/d:href>/.exec(block)?.[1] ?? '';
    const laenge = /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block)?.[1];
    const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() ?? '');
    if (laenge !== undefined && name) eintraege.push({ name, groesse: Number(laenge) });
  }
  return eintraege;
}

/** Laedt eine Datei aus dem Nextcloud-Ordner als rohe Bytes. */
async function nextcloudBytes(name: string): Promise<Buffer> {
  const url = new URL(FREIGABE);
  const token = url.pathname.split('/s/')[1]?.replace(/\/.*$/, '') ?? '';
  const antwort = await fetch(`${url.origin}/public.php/dav/files/${token}/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` }
  });
  if (!antwort.ok) throw new Error(`GET ${name} → ${antwort.status}`);
  return Buffer.from(await antwort.arrayBuffer());
}

function anzahlKlartextNachrichten(channelId: string): number {
  return Number(pgQuery(`select count(*) from chat.messages where channel_id = ${channelId}`) || '0');
}

test.describe.configure({ mode: 'serial' });

test.describe('Ablage-Kanal auf echter Nextcloud (Hetzner)', () => {
  let devCtx: BrowserContext;
  let devPage: Page;
  let dev2Ctx: BrowserContext;
  let dev2Page: Page;
  let guildId = '';
  let kanalId = '';

  test.skip(
    FREIGABE === '',
    'E2E_NEXTCLOUD_KANAL nicht gesetzt — dieser Nachweis braucht einen echten ' +
      'Freigabe-Link mit Schreibrecht (s. Dateikopf).'
  );

  test.beforeAll(async ({ browser }) => {
    devCtx = await browser.newContext();
    dev2Ctx = await browser.newContext();
    for (const ctx of [devCtx, dev2Ctx]) await alsElektronGeraetAusgeben(ctx);
    devPage = await devCtx.newPage();
    dev2Page = await dev2Ctx.newPage();
  });

  test.afterAll(async () => {
    await devCtx?.close();
    await dev2Ctx?.close();
  });

  test('beide melden sich an, eine Community mit Ablage-Kanal entsteht', async () => {
    await login(devPage, DEV);
    await login(dev2Page, DEV2);
    const devId = await currentUserId(devPage);
    const dev2Id = await currentUserId(dev2Page);
    await warteAufSchluesselbuendel(devPage, devId);
    await warteAufSchluesselbuendel(dev2Page, dev2Id);

    guildId = await createGuild(devPage, `Ablage ${TAG}`);
    kanalId = await createAblageChannel(devPage, guildId, `kanal-${TAG}`);
    await inviteAndJoin(devPage, guildId, dev2Page);
    expect(kanalId).toMatch(/^\d+$/);
  });

  test('der Besitzer haengt seinen Nextcloud-Ordner an den Kanal — ueber die Oberflaeche', async () => {
    // **Der Weg dorthin ist Teil des Nachweises, nicht Beiwerk.** Die
    // Rechte-Seite loest den Kanal ausschliesslich aus dem Klienten-Speicher
    // auf (`guilds.channelsByGuild`) und holt ihn nie selbst. Ein `goto` auf
    // ihre Adresse startet das Dokument neu, der Speicher ist danach leer,
    // und die Seite sagt „Kanal nicht gefunden" — auch fuer den Besitzer,
    // auch bei bestehendem Kanal. Am 2026-09-01 hier gefunden; dieselbe
    // Aufloesung steht schon auf `origin/main`, der Fehler ist also aelter
    // als der Ablage-Zweig, faellt aber erst jetzt auf, weil das
    // Laufwerk-Verbinden auf dieser Seite wohnt.
    //
    // Deshalb wird hier navigiert wie ein Mensch: Kanal oeffnen, im
    // Kontextmenue der Kanalliste auf „Berechtigungen".
    await devPage.goto(`/app/guilds/${guildId}/channels/${kanalId}`);
    await expect(devPage.getByTestId('active-channel-name')).toBeVisible({ timeout: 20_000 });
    await devPage.getByTestId(`channel-${kanalId}`).click({ button: 'right' });
    await devPage.getByTestId(`channel-permissions-${kanalId}`).click();
    await devPage.waitForURL(/\/permissions$/, { timeout: 20_000 });
    // Das Laufwerk sitzt hinter einem eigenen Reiter, den es nur fuer einen
    // Kanal mit `ablage=true` gibt. Sein Erscheinen ist damit schon die
    // erste Aussage dieses Tests: fehlt er, ist der Kanal nicht als
    // Ablage-Kanal angelegt worden.
    await devPage.getByTestId('perm-tab-laufwerk').click();
    await devPage.getByTestId('kanal-ablage-verbinden').click();
    // KEINE Anbieter-Auswahl auf diesem Weg: `AblageLaufwerkAufforderung`
    // zeigt das Nextcloud-Feld sofort (der Auswahl-Dialog
    // `ablage-verbinden-dialog` gehoert zum Einstellungen-Weg). Erst
    // andersherum erwartet und daran gescheitert — die Oberflaeche war
    // richtig, der Test falsch.
    await expect(devPage.getByTestId('nextcloud-link')).toBeVisible({ timeout: 20_000 });
    await devPage.getByTestId('nextcloud-link').fill(FREIGABE);
    await devPage.getByTestId('nextcloud-verbinden').click();

    // Die Fehlerzeile zuerst pruefen: schlaegt das Verbinden fehl, ist ihr
    // Text die einzige Stelle, die den Grund nennt — ohne diesen Zweig
    // liefe der Test in ein nichtssagendes Zeitlimit.
    const fehler = devPage.getByTestId('nextcloud-fehler');
    if (await fehler.isVisible().catch(() => false)) {
      throw new Error(`Verbinden abgewiesen: ${await fehler.innerText()}`);
    }
    await expect(devPage.getByTestId('kanal-ablage-verbunden')).toBeVisible({ timeout: 20_000 });
  });

  test('eine verschluesselte Nachricht landet im Kanal — und der Server sieht keinen Klartext', async () => {
    const KLARTEXT = `nextcloud-nachweis ${TAG}`;

    await dev2Page.goto(`/app/guilds/${guildId}/channels/${kanalId}`);
    await expect(dev2Page.getByTestId('message-input')).toBeVisible({ timeout: 20_000 });

    await devPage.goto(`/app/guilds/${guildId}/channels/${kanalId}`);
    await devPage.getByTestId('message-input').click();
    await devPage.getByTestId('message-input').fill(KLARTEXT);
    await devPage.getByTestId('message-input').press('Enter');

    await expect(
      dev2Page.locator('[data-testid="message-content"]', { hasText: KLARTEXT })
    ).toBeVisible({ timeout: 30_000 });

    expect(
      anzahlKlartextNachrichten(kanalId),
      'in chat.messages darf fuer einen Ablage-Kanal nichts stehen'
    ).toBe(0);
  });

  test('die Bytes liegen in der Nextcloud — und sind dort NICHT lesbar', async () => {
    const KLARTEXT = `nextcloud-nachweis ${TAG}`;

    const dateien = await expect
      .poll(async () => (await nextcloudListe()).filter((d) => d.groesse > 0), {
        timeout: 60_000,
        message: 'im Nextcloud-Ordner ist nach der Festigung keine Datei aufgetaucht'
      })
      .not.toHaveLength(0)
      .then(() => nextcloudListe());

    const roh = Buffer.concat(
      await Promise.all(dateien.filter((d) => d.groesse > 0).map((d) => nextcloudBytes(d.name)))
    );

    // Die eigentliche Zusage: der Ordner gehoert dem Besitzer, aber niemand
    // — auch er nicht — kann den Text darin ohne Schluessel lesen. Geprueft
    // wird der Klartext UND seine Base64-Form: eine reine Suche nach dem
    // Wortlaut bestuende auch ein bloss verpacktes Klartext-Log.
    expect(roh.includes(KLARTEXT), 'Klartext liegt offen in der Nextcloud').toBe(false);
    expect(
      roh.includes(Buffer.from(KLARTEXT).toString('base64')),
      'Klartext liegt base64-verpackt in der Nextcloud'
    ).toBe(false);
  });
});
