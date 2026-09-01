/**
 * Anhänge landen im Cloud-Laufwerk JEDES Beteiligten (Entwurf §11).
 *
 * **Warum „kein Klartext gefunden" hier nicht genügt.** Genau diese Prüfung
 * war am 2026-09-01 grün, während in der Cloud JSON-Text statt Chiffrat lag —
 * ein toter Weg besteht sie mühelos. Dieser Nachweis prüft deshalb die
 * Anwesenheit der Bytes, ihre Unlesbarkeit UND dass Pulse seine eigene Kopie
 * wirklich losgelassen hat.
 *
 * Er braucht ZWEI Archiv-Ordner, einen je Konto — sonst liesse sich nicht
 * unterscheiden, ob die Datei beim Empfänger ankam oder nur beim Absender:
 *
 *   E2E_NEXTCLOUD_ARCHIV   → Archiv von `dev`
 *   E2E_NEXTCLOUD_ARCHIV2  → Archiv von `dev2`
 *
 * Fehlt einer, überspringt sich die Datei (Begründung wie bei den
 * Geschwister-Nachweisen: ein Lauf, der ohne fremde Zugangsdaten gar nicht
 * stattfinden KANN, wäre als Dauer-Rot wertlos). Die Links werden nie
 * ausgegeben.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';

import {
  DEV,
  DEV2,
  alsElektronGeraetAusgeben,
  login,
  currentUserId,
  becomeFriends,
  createDmChannel,
  warteAufSchluesselbuendel,
  pgQuery
} from './_hetzner-helfer.ts';

const ARCHIV_A = process.env.E2E_NEXTCLOUD_ARCHIV ?? '';
const ARCHIV_B = process.env.E2E_NEXTCLOUD_ARCHIV2 ?? '';

/** Ein winziges, gültiges PNG (1×1, rot). Klein genug, dass der Lauf nicht an
 *  der Leitung hängt, und trotzdem ein echtes Bild — ein Textschnipsel würde
 *  den Bildpfad gar nicht erst betreten. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const DATEINAME = 'geheimes-bild.png';

function dav(link: string): { basis: string; kopf: Record<string, string> } {
  const url = new URL(link);
  const token = url.pathname.split('/s/')[1]?.replace(/\/.*$/, '') ?? '';
  return {
    basis: `${url.origin}/public.php/dav/files/${token}`,
    kopf: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` }
  };
}

async function namen(link: string): Promise<string[]> {
  const { basis, kopf } = dav(link);
  const antwort = await fetch(`${basis}/`, { method: 'PROPFIND', headers: { ...kopf, Depth: '1' } });
  if (!antwort.ok && antwort.status !== 207) throw new Error(`PROPFIND ${antwort.status}`);
  const xml = await antwort.text();
  const out: string[] = [];
  for (const block of xml.split('<d:response>').slice(1)) {
    const href = /<d:href>(.*?)<\/d:href>/.exec(block)?.[1] ?? '';
    if (!/<d:getcontentlength>/.test(block)) continue;
    const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() ?? '');
    if (name) out.push(name);
  }
  return out;
}

async function bytes(link: string, name: string): Promise<Buffer> {
  const { basis, kopf } = dav(link);
  const antwort = await fetch(`${basis}/${encodeURIComponent(name)}`, { headers: kopf });
  if (!antwort.ok) throw new Error(`GET ${name} → ${antwort.status}`);
  return Buffer.from(await antwort.arrayBuffer());
}

async function leeren(link: string): Promise<void> {
  const { basis, kopf } = dav(link);
  for (const name of await namen(link)) {
    await fetch(`${basis}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: kopf });
  }
}

/** Verbindet ein Laufwerk über die Oberfläche und markiert es als Archiv. */
async function archivVerbinden(page: Page, link: string): Promise<void> {
  await page.goto('/app/me/storage');
  await expect(page.getByTestId('speicher-sektion')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('speicher-verbinden').click();
  await page.getByTestId('anbieter-nextcloud').click();
  await page.getByTestId('nextcloud-link').fill(link);
  await page.getByTestId('nextcloud-verbinden').click();

  // **Erst die Fehlerzeile, dann die Verbindung.** Andersherum lief der
  // Nachweis in ein Zeitlimit und meldete „Element nicht gefunden", während
  // die Oberfläche danebenstand und den Grund nannte. Häufigster Fall: die
  // Ratenbegrenzung der Verbindungsprobe (6/Minute) nach mehreren Läufen
  // kurz hintereinander — das ist kein Produktfehler, aber ohne diesen Griff
  // sieht es wie einer aus.
  const zeile = page.getByTestId('speicher-zeile').first();
  const fehlerZeile = page.getByTestId('nextcloud-fehler');
  await expect
    .poll(
      async () =>
        (await fehlerZeile.isVisible().catch(() => false))
          ? `FEHLER: ${await fehlerZeile.innerText()}`
          : (await zeile.isVisible().catch(() => false))
            ? 'verbunden'
            : 'wartet',
      { timeout: 30_000, message: 'weder Verbindung noch Fehlermeldung erschienen' }
    )
    .toBe('verbunden');
  await zeile.getByTestId('speicher-archiv-umschalten').click();
  await expect(zeile.getByTestId('speicher-archiv-badge')).toBeVisible({ timeout: 20_000 });
  const fehler = page.getByTestId('archiv-laufwerk-fehler');
  if (await fehler.isVisible().catch(() => false)) {
    throw new Error(`Archiv-Laufwerk abgewiesen: ${await fehler.innerText()}`);
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('Anhänge liegen im Laufwerk jedes Beteiligten', () => {
  let aCtx: BrowserContext;
  let aPage: Page;
  let bCtx: BrowserContext;
  let bPage: Page;
  let kanalId = '';
  let anhangId = '';

  test.skip(
    ARCHIV_A === '' || ARCHIV_B === '',
    'E2E_NEXTCLOUD_ARCHIV und E2E_NEXTCLOUD_ARCHIV2 nötig — s. Dateikopf.'
  );

  test.beforeAll(async ({ browser }) => {
    aCtx = await browser.newContext();
    bCtx = await browser.newContext();
    for (const ctx of [aCtx, bCtx]) await alsElektronGeraetAusgeben(ctx);
    aPage = await aCtx.newPage();
    bPage = await bCtx.newPage();
    // **Klient-Fehler weiterreichen.** Ein Fehlschlag im Verfasser landet
    // sonst ausschliesslich in der Browser-Konsole, die kein Lauf zu sehen
    // bekommt — genau die Blindheit, wegen der dieser Nachweis einen Tag
    // lang wie ein Serverproblem aussah.
    for (const [wer, seite] of [
      ['A', aPage],
      ['B', bPage]
    ] as const) {
      seite.on('pageerror', (e) => console.log(`[${wer}:pageerror] ${e.message}`));
      seite.on('console', (n) => {
        if (n.type() === 'error' || n.type() === 'warning') {
          console.log(`[${wer}:${n.type()}] ${n.text().slice(0, 300)}`);
        }
      });
    }
    await leeren(ARCHIV_A);
    await leeren(ARCHIV_B);
  });

  test.afterAll(async () => {
    await aCtx?.close();
    await bCtx?.close();
  });

  test('beide verbinden je ein eigenes Archiv-Laufwerk', async () => {
    await login(aPage, DEV);
    await login(bPage, DEV2);
    const aId = await currentUserId(aPage);
    const bId = await currentUserId(bPage);
    await warteAufSchluesselbuendel(aPage, aId);
    await warteAufSchluesselbuendel(bPage, bId);
    await becomeFriends(aPage, aId, bPage, bId);
    kanalId = await createDmChannel(aPage, bId);

    await archivVerbinden(aPage, ARCHIV_A);
    await archivVerbinden(bPage, ARCHIV_B);

    expect(await namen(ARCHIV_A)).toEqual([]);
    expect(await namen(ARCHIV_B)).toEqual([]);
  });

  test('ohne Laufwerk gibt es keinen Anhang-Knopf — mit Begründung', async () => {
    // **Die Gegenprobe zuerst**, solange sie noch etwas aussagt: dev2 trennt
    // sein Laufwerk, dev darf dann nichts anhängen — und muss erfahren, an
    // wem es liegt. Ein ausgegrauter Knopf ohne Begründung wäre eine
    // Sackgasse.
    await bPage.goto('/app/me/storage');
    await bPage.getByTestId('speicher-zeile').first().getByTestId('speicher-trennen').click();

    await aPage.goto(`/app/@me/${kanalId}`);
    await expect(aPage.getByTestId('message-input')).toBeVisible({ timeout: 20_000 });
    await expect(aPage.getByTestId('attachment-button')).toHaveCount(0);
    const hinweis = aPage.getByTestId('anhang-laufwerk-hinweis');
    await expect(hinweis).toBeVisible({ timeout: 20_000 });

    // **Warten, nicht einmal hinsehen.** Der Name wird nachgeladen
    // (`userCache.queue`, Sammelabruf mit 50 ms Verzoegerung plus Netz); ein
    // sofortiges Ablesen traf am 2026-09-01 zuverlaessig den Zwischenstand
    // und sah aus wie ein Produktfehler. Die Wartezeit ist Teil der Aussage:
    // der Name muss ANKOMMEN, ein dauerhafter Platzhalter waere die
    // Sackgasse, gegen die dieser Hinweis gebaut ist.
    await expect(hinweis, 'der Hinweis muss sagen, WER kein Laufwerk hat').toContainText(
      DEV2.username,
      { timeout: 20_000 }
    );

    // Wieder verbinden — der Knopf muss zurückkommen.
    await archivVerbinden(bPage, ARCHIV_B);
    await aPage.reload();
    await expect(aPage.getByTestId('attachment-button')).toBeVisible({ timeout: 30_000 });
  });

  test('dev schickt ein Bild — es landet in BEIDEN Laufwerken', async () => {
    await aPage.goto(`/app/@me/${kanalId}`);
    await aPage.getByTestId('attachment-file-input').setInputFiles({
      name: DATEINAME,
      mimeType: 'image/png',
      buffer: PNG
    });
    // **Erst den Upload zu Ende laufen lassen, DANN absenden** — und dabei
    // drei Ausgaenge auseinanderhalten. Die erste Fassung dieses Nachweises
    // konnte das nicht und hat deshalb einen echten Fehler eine Nacht lang
    // als „Zeitlimit" getarnt:
    //
    //  1. Sie tippte und drueckte Enter, waehrend der Upload noch lief. Der
    //     Absende-Knopf ist in diesem Zustand ausdruecklich gesperrt
    //     (`sendDisabled` enthaelt `laeuftNoch`) — das Enter war also ein
    //     Nichts, und die Nachricht ging nie raus. Der Kommentar an dieser
    //     Stelle behauptete das Gegenteil.
    //  2. Sie beobachtete nur die Fehlerzeile und den Cloud-Ordner. Wird die
    //     Kachel still abgeraeumt (genau der Fehler vom 2026-09-01: ein
    //     Effekt im Verfasser hing am Kanal-OBJEKT statt an seiner Kennung
    //     und brach jeden laufenden Upload ab), bleiben BEIDE stumm, und der
    //     Lauf laeuft in ein nichtssagendes Zeitlimit.
    //
    // Deshalb: auf einen der drei Ausgaenge warten und den dritten benennen.
    const fehler = aPage.getByTestId('attachment-error-text');
    const kacheln = aPage.getByTestId('attachment-preview');
    await expect(kacheln.first()).toBeVisible({ timeout: 30_000 });
    await aPage.getByTestId('message-input').fill('bild kommt');

    await expect
      .poll(
        async () =>
          (await fehler.isVisible().catch(() => false))
            ? `FEHLER: ${await fehler.innerText()}`
            : (await kacheln.count()) === 0
              ? 'KACHEL VERSCHWUNDEN — der Upload wurde still abgebrochen'
              : (await aPage.getByTestId('message-send').isDisabled().catch(() => true))
                ? 'laeuft'
                : 'fertig',
        { timeout: 90_000, message: 'der Upload kam zu keinem Ende' }
      )
      .toBe('fertig');

    // Jetzt traegt das Enter: der Anhang ist fertig, die Nachricht geht raus.
    // Sie wird gebraucht — ohne sie hat das frische Geraet in Test 6 nichts
    // anzuzeigen.
    await aPage.getByTestId('message-input').press('Enter');
    await expect(kacheln).toHaveCount(0, { timeout: 20_000 });

    for (const [wo, link] of [
      ['Absender', ARCHIV_A],
      ['Empfänger', ARCHIV_B]
    ] as const) {
      await expect
        .poll(async () => (await namen(link)).filter((n) => n.startsWith('anh-')).length, {
          timeout: 90_000,
          message: `im Laufwerk des ${wo} ist kein Anhang aufgetaucht`
        })
        .toBeGreaterThan(0);
    }
    anhangId = (await namen(ARCHIV_A)).find((n) => n.startsWith('anh-')) ?? '';
    expect(anhangId).not.toBe('');
  });

  test('die Bytes in der Cloud sind unlesbar — und verraten Name und Typ nicht', async () => {
    const roh = await bytes(ARCHIV_B, anhangId);
    expect(roh.length, 'die Datei ist leer').toBeGreaterThan(0);

    // Nicht das Bild selbst: ein PNG beginnt mit \x89PNG. Steht das da,
    // liegt der Anhang UNVERSCHLUESSELT in der fremden Cloud.
    expect(
      roh.subarray(0, 4).toString('hex'),
      'in der Cloud liegt ein rohes PNG statt Chiffrat'
    ).not.toBe('89504e47');

    // Und der Server soll Name und Typ nie gesehen haben — sie stehen im
    // verschluesselten Kopf, nicht im Dateinamen.
    expect(roh.includes(DATEINAME), 'der Dateiname liegt offen').toBe(false);
    expect(roh.includes('image/png'), 'der MIME-Typ liegt offen').toBe(false);
    expect(anhangId.includes(DATEINAME), 'der Dateiname steckt im Cloud-Namen').toBe(false);
  });

  test('Pulse hat seine eigene Kopie losgelassen', async () => {
    // **Der Test, der eine tote Verteilung entlarvt.** Antwortet die Route
    // mit 200, wurde nie verteilt — und alles darueber waere ein falsches
    // Positiv gewesen.
    //
    // **Die Marke in der Datenbank traegt die Aussage, nicht der HTTP-Code**,
    // und das ist eine Korrektur an der ersten Fassung. Sie verlangte hier
    // eine 410 — aber `darf_anhang_abrufen` bindet das Abrufrecht an eine
    // OFFENE Zustellung, und der Empfaenger hat den Umschlag laengst
    // quittiert, wenn dieser Test laeuft. Die Route antwortet dann voellig
    // regelkonform mit 404 („keine Zustellung"), noch bevor sie zur
    // 410-Zeile kommt. Ein Nachweis, der genau 410 fordert, misst damit
    // nicht die Verteilung, sondern den Zufall, ob der Empfaenger schon
    // abgeholt hat.
    const kennungFuerDb = anhangId.replace(/^anh-/, '').replace(/(-vs)?\.puls$/, '');
    expect(
      pgQuery(
        `SELECT laufwerk_verteilt_am IS NOT NULL FROM chat.message_attachments ` +
          `WHERE id = ${kennungFuerDb}`
      ),
      'der Server hat die Verteilung nie vermerkt — die eigene Kopie liegt noch da'
    ).toBe('t');
    //
    // **`device_pubkey` gehoert in den Rumpf.** Ohne ihn antwortet die Route
    // mit 422 („Field required") — und 422 ist eben NICHT 410, der Nachweis
    // waere also an seiner eigenen Anfrage gescheitert und haette wie ein
    // Produktfehler ausgesehen. Die Kennung liegt dort, wo der Klient sie
    // selbst herleitet (`krypto/geraeteKennung.ts`): in der
    // Identitaets-Datenbank unter `pulse.krypto-geraetekennung`.
    const kennung = anhangId.replace(/^anh-/, '').replace(/(-vs)?\.puls$/, '');
    const antwort = await bPage.evaluate(async (id) => {
      const geraet = await new Promise<string | undefined>((fertig, kaputt) => {
        const auf = indexedDB.open('pulse-identity');
        auf.onerror = () => kaputt(auf.error);
        auf.onsuccess = () => {
          const anfrage = auf.result
            .transaction('identity', 'readonly')
            .objectStore('identity')
            .get('pulse.krypto-geraetekennung');
          anfrage.onerror = () => kaputt(anfrage.error);
          anfrage.onsuccess = () => fertig(anfrage.result as string | undefined);
        };
      });
      const token = localStorage.getItem('dcc.tokens.access');
      const r = await fetch(`/api/chat/postfach/anhaenge/${id}/abrufadresse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ device_pubkey: geraet })
      });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    }, kennung);
    // Und die Route gibt unter keinen Umstaenden mehr eine Adresse heraus:
    // 410 („liegt in deinem Laufwerk", solange die Zustellung noch offen
    // ist) oder 404 („keine Zustellung mehr") — nie 200.
    expect(
      [404, 410],
      `die Abrufadresse haette nicht antworten duerfen: ${antwort.status} ${antwort.body}`
    ).toContain(antwort.status);
  });

  test('der Empfänger holt das Bild aus seinem Laufwerk, wenn Pulse es nicht mehr hat', async () => {
    // Der eigentliche Zweck: der Anhang ueberlebt Pulse. Getestet wird das,
    // indem dem Empfaenger seine LOKALE Kopie der Bytes weggenommen wird —
    // Pulses eigene ist bereits weg (Test 5), die Zustellung ebenfalls
    // quittiert. Was danach noch erscheint, kann nur aus dem Cloud-Ordner
    // kommen.
    //
    // **Ein frischer Browser-Kontext taugt dafuer NICHT**, obwohl die erste
    // Fassung das versuchte. Ein neuer Kontext ist ein neues GERAET: er legt
    // ein eigenes Schluesselpaar an, bekommt eine eigene Geraetekennung, und
    // der Umschlag zu dieser Nachricht war an das alte Geraet adressiert.
    // Ein solches Geraet sieht das Gespraech ueberhaupt nicht — weder Text
    // noch Anhang —, und zwar voellig regelkonform: der Verlauf einer
    // verschluesselten DM liegt lokal, nicht beim Server. Der Nachweis
    // scheiterte damit an einer Eigenschaft des Entwurfs und sah aus wie ein
    // Fehler im Anhang-Weg. Den Verlauf auf ein zweites Geraet zu bringen,
    // ist der Rueckweg (Code einloesen) und gehoert in seinen eigenen
    // Nachweis.
    // Erst der Nachweis, dass der Empfaenger die Nachricht ueberhaupt hat —
    // sonst kann der Vergleich danach nichts aussagen.
    await bPage.goto(`/app/@me/${kanalId}`);
    await expect(
      bPage.locator('[data-testid="attachment-image"]').first(),
      'der Empfänger hat den Anhang gar nicht erst bekommen'
    ).toBeVisible({ timeout: 60_000 });

    await bPage.evaluate(
      () =>
        new Promise<void>((fertig, kaputt) => {
          const auf = indexedDB.open('pulse-verlauf');
          auf.onerror = () => kaputt(auf.error);
          auf.onsuccess = () => {
            const tx = auf.result.transaction('anhaenge', 'readwrite');
            tx.objectStore('anhaenge').clear();
            tx.oncomplete = () => fertig();
            tx.onerror = () => kaputt(tx.error);
          };
        })
    );
    await bPage.reload();
    await expect(
      bPage.locator('[data-testid="attachment-image"]').first(),
      'ohne lokale Kopie kam das Bild nicht aus dem Laufwerk zurück'
    ).toBeVisible({ timeout: 60_000 });
  });
});
