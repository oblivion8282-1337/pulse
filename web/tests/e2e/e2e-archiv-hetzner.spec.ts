/**
 * Der Rundweg des persönlichen Archivs, gegen eine ECHTE Nextcloud.
 *
 * **Die Behauptung, die hier geprüft wird**, ist die, für die es das Archiv
 * überhaupt gibt: „Ich melde mich an einem anderen Rechner an und habe
 * meinen Verlauf wieder." Sie war bis zum 2026-09-01 nirgends nachgewiesen —
 * geprüft waren nur die Einzelteile (Code erzeugen und öffnen, Päckchen
 * packen und entpacken, 39 Fälle). Der Weg dazwischen nie.
 *
 * Der Lauf spiegelt genau diesen Weg:
 *   Gerät A: Laufwerk verbinden, als Archiv markieren, eine DM schreiben,
 *            warten bis sie in der Cloud liegt, Code erzeugen.
 *   Gerät B: leerer Browser, dasselbe Konto, Code einlösen — Verlauf da?
 *
 * Lauf (der `webServer`-Block startet Vite selbst):
 *
 *   cd web && E2E_PG_VIA_SSH=pulse-hetzner-dev \
 *     E2E_NEXTCLOUD_ARCHIV=<freigabe-link> \
 *     pnpm exec playwright test tests/e2e/e2e-archiv-hetzner.spec.ts \
 *     --config=tests/e2e/playwright.hetzner.config.ts
 *
 * Ohne `E2E_NEXTCLOUD_ARCHIV` überspringt sich die Datei (Begründung wie in
 * `e2e-ablage-hetzner.spec.ts`: ein Nachweis, der ohne fremde Zugangsdaten
 * gar nicht laufen KANN, wäre als Dauer-Rot wertlos). Der Link wird nie
 * ausgegeben.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

import { DEV, alsElektronGeraetAusgeben, login, currentUserId, pgQuery } from './_hetzner-helfer.ts';

const FREIGABE = process.env.E2E_NEXTCLOUD_ARCHIV ?? '';
const TAG = `arch${Date.now().toString(36)}`;

function davTeile(): { basis: string; kopf: Record<string, string> } {
  const url = new URL(FREIGABE);
  const token = url.pathname.split('/s/')[1]?.replace(/\/.*$/, '') ?? '';
  return {
    basis: `${url.origin}/public.php/dav/files/${token}`,
    kopf: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` }
  };
}

async function nextcloudNamen(): Promise<string[]> {
  const { basis, kopf } = davTeile();
  const antwort = await fetch(`${basis}/`, {
    method: 'PROPFIND',
    headers: { ...kopf, Depth: '1' }
  });
  if (!antwort.ok && antwort.status !== 207) {
    throw new Error(`Nextcloud antwortete ${antwort.status}`);
  }
  const xml = await antwort.text();
  const namen: string[] = [];
  for (const block of xml.split('<d:response>').slice(1)) {
    const href = /<d:href>(.*?)<\/d:href>/.exec(block)?.[1] ?? '';
    const laenge = /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block)?.[1];
    const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() ?? '');
    if (laenge !== undefined && name) namen.push(name);
  }
  return namen;
}

/** Leert den Ordner. Ohne das prüft der Lauf die Überreste seines Vorgängers
 *  — derselbe Fehler, der `e2e-ablage-hetzner.spec.ts` am 2026-09-01 einmal
 *  fälschlich grün werden liess. */
async function nextcloudLeeren(): Promise<void> {
  const { basis, kopf } = davTeile();
  for (const name of await nextcloudNamen()) {
    await fetch(`${basis}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: kopf });
  }
}

/** Verbindet das Laufwerk über die Oberfläche und markiert es als Archiv. */
async function archivVerbinden(page: Page): Promise<void> {
  await page.goto('/app/me/storage');
  await expect(page.getByTestId('speicher-sektion')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('speicher-verbinden').click();
  await page.getByTestId('anbieter-nextcloud').click();
  await page.getByTestId('nextcloud-link').fill(FREIGABE);
  await page.getByTestId('nextcloud-verbinden').click();

  const zeile = page.getByTestId('speicher-zeile').first();
  await expect(zeile).toBeVisible({ timeout: 30_000 });

  // Als Archiv markieren — erst damit wandert der Verlauf dorthin.
  await zeile.getByTestId('speicher-archiv-umschalten').click();
  await expect(zeile.getByTestId('speicher-archiv-badge')).toBeVisible({ timeout: 20_000 });

  // Die Fehlerzeile MUSS leer bleiben: schlägt das Hinterlegen der Adresse
  // beim Server fehl, wird nie etwas geschrieben, und ohne diese Prüfung
  // liefe der Test in ein nichtssagendes Zeitlimit (der Schreibweg meldet
  // sich absichtlich nie).
  const fehler = page.getByTestId('archiv-laufwerk-fehler');
  if (await fehler.isVisible().catch(() => false)) {
    throw new Error(`Archiv-Laufwerk abgewiesen: ${await fehler.innerText()}`);
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('Persönliches Archiv: sichern und auf einem leeren Gerät zurückholen', () => {
  let aCtx: BrowserContext;
  let aPage: Page;
  let bCtx: BrowserContext;
  let bPage: Page;
  let dmKanalId = '';
  let code = '';
  const TEXT = `archiv-nachweis ${TAG}`;

  test.skip(FREIGABE === '', 'E2E_NEXTCLOUD_ARCHIV nicht gesetzt — s. Dateikopf.');

  test.beforeAll(async ({ browser }) => {
    aCtx = await browser.newContext();
    await alsElektronGeraetAusgeben(aCtx);
    aPage = await aCtx.newPage();
    await nextcloudLeeren();
  });

  test.afterAll(async () => {
    await aCtx?.close();
    await bCtx?.close();
  });

  test('Gerät A verbindet sein Laufwerk und markiert es als Archiv', async () => {
    await login(aPage, DEV);
    await archivVerbinden(aPage);
  });

  test('eine Direktnachricht entsteht und landet verschluesselt in der Cloud', async () => {
    // An sich selbst gibt es keine DM; genommen wird der erste bestehende
    // Gespraechsfaden des Kontos. Er existiert, weil `e2e-dm-hetzner`
    // denselben Nutzer schon verwendet hat — und wenn nicht, sagt die
    // Meldung das, statt in ein Zeitlimit zu laufen.
    // Die Kanal-Kennung ueber die Schnittstelle holen, nicht ueber einen
    // Klick: der erste Knopf in der Seitenleiste ist „Freunde", kein
    // Gespraech — daran ist dieser Nachweis am 2026-09-01 einmal
    // vorbeigelaufen und in `/app/friends` gelandet.
    const roh = await aPage.evaluate(async () => {
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch('/api/chat/dm-channels', {
        headers: { Authorization: `Bearer ${token}` }
      });
      return { status: r.status, body: await r.text() };
    });
    expect(roh.status, `GET /dm-channels antwortete ${roh.status}`).toBe(200);
    const kanaele = JSON.parse(roh.body) as { id: string }[];
    expect(
      kanaele.length,
      'kein DM-Gespraech fuer dev vorhanden — vorher e2e-dm-hetzner laufen lassen'
    ).toBeGreaterThan(0);
    dmKanalId = kanaele[0].id;

    await aPage.goto(`/app/@me/${dmKanalId}`);
    await expect(aPage.getByTestId('message-input')).toBeVisible({ timeout: 20_000 });

    await aPage.getByTestId('message-input').click();
    await aPage.getByTestId('message-input').fill(TEXT);
    await aPage.getByTestId('message-input').press('Enter');
    await expect(
      aPage.locator('[data-testid="message-content"]', { hasText: TEXT })
    ).toBeVisible({ timeout: 30_000 });

    // Der Schreibweg laeuft asynchron und ungewartet (`archivSchreibweg.ts`)
    // — deshalb gepollt statt einmal nachgesehen.
    await expect
      .poll(async () => (await nextcloudNamen()).length, {
        timeout: 90_000,
        message: 'im Archiv-Ordner ist nichts aufgetaucht'
      })
      .toBeGreaterThan(0);
  });

  test('der Server hat den Klartext nie gesehen, die Cloud auch nicht', async () => {
    expect(
      Number(pgQuery(`select count(*) from chat.messages where channel_id = ${dmKanalId}`) || '0'),
      'in chat.messages darf fuer eine verschluesselte DM nichts stehen'
    ).toBe(0);

    const { basis, kopf } = davTeile();
    const namen = await nextcloudNamen();
    const dateien = new Map<string, Buffer>();
    for (const n of namen) {
      const antwort = await fetch(`${basis}/${encodeURIComponent(n)}`, { headers: kopf });
      dateien.set(n, Buffer.from(await antwort.arrayBuffer()));
    }
    const roh = Buffer.concat([...dateien.values()]);
    expect(roh.includes(TEXT), 'Klartext liegt offen in der Cloud').toBe(false);
    expect(
      roh.includes(Buffer.from(TEXT).toString('base64')),
      'Klartext liegt base64-verpackt in der Cloud'
    ).toBe(false);

    // **Die Kennung der ersten vier Bytes, und zwar je Datei.** „Kein
    // Klartext drin" ist ein zu schwacher Nachweis: er war am 2026-09-01
    // gruen, waehrend in der Cloud gar kein Chiffrat lag, sondern
    // `{"0":80,"1":85,…}` — der `Uint8Array`, den `fetchAuthenticated`
    // durch `JSON.stringify` geschickt hatte. Das ist derselbe Inhalt in
    // Textform: es enthaelt keinen Klartext und ist trotzdem unbrauchbar.
    // Sichtbar wird so ein Schaden nur am Dateianfang.
    for (const [name, inhalt] of dateien) {
      const kennung = inhalt.subarray(0, 4).toString('latin1');
      const erwartet = name === 'verzeichnis.puls' ? 'PUVV' : 'PADF';
      expect(kennung, `${name} beginnt nicht mit der Container-Kennung`).toBe(erwartet);
    }
  });

  test('Gerät A erzeugt einen Wiederherstellungscode', async () => {
    await aPage.goto('/app/me/storage');
    await aPage.getByTestId('wiederherstellung-erzeugen-knopf').click();
    const wert = aPage.getByTestId('wiederherstellung-code-wert');
    await expect(wert).toBeVisible({ timeout: 20_000 });
    code = (await wert.innerText()).trim();
    expect(code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4})+$/);

    // **Die Bestaetigung verlangt EINE Gruppe, nicht den ganzen Code** — die
    // Oberflaeche sagt welche, und der ganze Code wuerde nicht passen. Das
    // ist Absicht: abtippen soll beweisen, dass jemand hingesehen hat, und
    // ein Einfuegen aus der Zwischenablage bewiese nichts. Der Nachweis
    // liest die Nummer deshalb aus der Beschriftung, statt sie festzuschreiben
    // — sonst braeche er, sobald jemand die Pruefgruppe wechselt.
    const beschriftung = await aPage
      .locator('label[for="wiederherstellung-bestaetigung"]')
      .innerText();
    const nummer = Number(/(\d+)/.exec(beschriftung)?.[1]);
    expect(nummer, `Pruefgruppe nicht aus „${beschriftung}" lesbar`).toBeGreaterThan(0);
    await aPage
      .getByTestId('wiederherstellung-bestaetigung-eingabe')
      .fill(code.split('-')[nummer - 1]);
    await aPage.getByTestId('wiederherstellung-code-fertig').click();
  });

  test('Gerät B ist leer — und hat nach dem Einloesen den Verlauf', async ({ browser }) => {
    bCtx = await browser.newContext();
    await alsElektronGeraetAusgeben(bCtx);
    bPage = await bCtx.newPage();
    await login(bPage, DEV);

    // **Erst die Gegenprobe, dass B wirklich leer ist.** Ohne sie koennte
    // dieser Nachweis gruen werden, weil der Verlauf ohnehin vom Server
    // kaeme — und genau das soll er hier nicht.
    await bPage.goto(`/app/@me/${dmKanalId}`);
    await expect(
      bPage.locator('[data-testid="message-content"]', { hasText: TEXT })
    ).toHaveCount(0);

    await bPage.goto('/app/me/storage');
    await bPage.getByTestId('wiederherstellung-einloesen-knopf').click();
    await bPage.getByTestId('wiederherstellung-einloesen-eingabe').fill(code);
    await bPage.getByTestId('wiederherstellung-einloesen-submit').click();

    const fehler = bPage.getByTestId('wiederherstellung-einloesen-fehler');
    if (await fehler.isVisible().catch(() => false)) {
      throw new Error(`Einloesen abgewiesen: ${await fehler.innerText()}`);
    }

    // **Die Meldungen mitlesen, nicht nur das Ergebnis.** Der Verlaufs-Teil
    // kann aus drei Gruenden nichts liefern (kein Archiv, Laufwerk nicht
    // zu oeffnen, nichts drin), und ohne diesen Griff endete der Nachweis in
    // einem nichtssagenden Zeitlimit — am 2026-09-01 dreimal.
    const meldungen: string[] = [];
    await expect
      .poll(
        async () => {
          for (const t of await bPage.locator('[data-sonner-toast]').allInnerTexts()) {
            if (!meldungen.includes(t)) meldungen.push(t);
          }
          return meldungen.some((t) => /zurückgeholt|Archiv|Verlauf/i.test(t));
        },
        { timeout: 60_000, message: 'Gerät B hat zum Verlauf gar nichts gemeldet' }
      )
      .toBe(true);
    const schlecht = meldungen.find((t) => !/Nachrichten zurückgeholt/.test(t) && /Archiv|Verlauf/i.test(t));
    expect(schlecht, `Gerät B meldete: ${meldungen.join(' | ')}`).toBeUndefined();

    // Das ist die Behauptung des ganzen Vorhabens.
    await bPage.goto(`/app/@me/${dmKanalId}`);
    await expect(
      bPage.locator('[data-testid="message-content"]', { hasText: TEXT }),
      'der Verlauf ist auf dem leeren Geraet nicht angekommen'
    ).toBeVisible({ timeout: 30_000 });
  });

  test('Gegenprobe: die Konto-Kennung von A und B ist dieselbe', async () => {
    // Sonst haette der Verlauf zu einem anderen Konto gehoert und waere beim
    // Lesen fail-closed verworfen worden — der vorige Test waere dann aus
    // dem falschen Grund gruen gewesen.
    expect(await currentUserId(bPage)).toBe(await currentUserId(aPage));
  });
});
