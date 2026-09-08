import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { medienNachziehen, zeileAusServerAnhang, type ServerAnhang } from '../src/lib/verlauf/medienNachzug.ts';
import { medienZeilenAusSatz } from '../src/lib/verlauf/schema.ts';

const KONTO = 'konto-1';

/** Druckt eine Snowflake-artige id in eine Server-Zeile (verschlüsselt =
 *  NULL-Metadaten, genau wie `routes/meine_anhaenge.py` sie liefert). */
function zeile(id: string, overrides: Partial<ServerAnhang> = {}): ServerAnhang {
  return {
    id,
    channel_id: '77',
    filename: `bild-${id}.png`,
    mime: 'image/png',
    size: 1000,
    hat_thumb: true,
    erstellt_am: '2026-09-01T10:00:00Z',
    verschluesselt: false,
    laufwerk_verteilt: false,
    ...overrides
  };
}

/** Fake-Server: liefert die VORgesetzte Liste newest-first in Seiten der
 *  Groesse `limit`, merkt sich jeden Abruf mit seinem Cursor. */
function fakeServer(ids: string[], limit: number, abbruchBei?: string) {
  const aufrufe: (string | null)[] = [];
  const abrufen: string[][] = [];
  const abruf = async (before: string | null): Promise<ServerAnhang[]> => {
    aufrufe.push(before);
    if (abbruchBei !== undefined && before !== null && BigInt(before) <= BigInt(abbruchBei)) {
      // Server, der die Zusage bricht und auf der Stelle pedalt — fuer die
      // Cursor-Wache.
      return ids.slice(0, limit).map((id) => zeile(id));
    }
    const seite = ids.filter((id) => before === null || BigInt(id) < BigInt(before)).slice(0, limit);
    abrufen.push(seite);
    return seite.map((id) => zeile(id));
  };
  return { abruf, aufrufe };
}

describe('Medien-Nachzug', () => {
  it('blaettert newest-first mit EXKLUSIVEM Cursor bis zum Anfang durch', async () => {
    const ids = ['105', '104', '103', '102', '101', '100'];
    const server = fakeServer(ids, 2);
    const geschreiben: string[] = [];
    const bericht = await medienNachziehen(server.abruf, {
      kontoId: KONTO,
      limit: 2,
      liegtVor: async () => false,
      schreiben: async (zeilen) => {
        for (const z of zeilen) geschreiben.push(z.id);
      }
    });

    // Cursor = letzte gesehene id; die Seite dahinter beginnt STRENG darunter.
    assert.deepEqual(server.aufrufe, [null, '104', '102', '100']);
    assert.deepEqual(geschreiben, ids);
    assert.equal(bericht.nachgezogen, 6);
    assert.equal(bericht.ueberlappung, false);
    assert.equal(bericht.leergelaufen, true);
  });

  it('bricht am ERSTEN lokal bekannten Anhang ab und holt danach nichts mehr', async () => {
    const ids = ['105', '104', '103', '102', '101', '100'];
    const server = fakeServer(ids, 2);
    const geschreiben: string[] = [];
    const bericht = await medienNachziehen(server.abruf, {
      kontoId: KONTO,
      limit: 2,
      // 103 liegt bereits im Index (Seite 2, zweiter Eintrag)
      liegtVor: async (id) => id === '103',
      schreiben: async (zeilen) => {
        for (const z of zeilen) geschreiben.push(z.id);
      }
    });

    // Seite 1 (105,104) neu; auf Seite 2 ist 103 bekannt — die Überlappung
    // beendet den Lauf, 102 und alles Ältere gilt als lokal vorhanden,
    // Seite 3 wird nie angefragt.
    assert.deepEqual(geschreiben, ['105', '104']);
    assert.equal(server.aufrufe.length, 2);
    assert.equal(bericht.nachgezogen, 2);
    assert.equal(bericht.ueberlappung, true);
    assert.equal(bericht.leergelaufen, false);
  });

  it('hoert auf, wenn der Server seine Cursor-Zusage bricht (Endlos-Schleife)', async () => {
    const server = fakeServer(['105', '104'], 2, '999');
    const bericht = await medienNachziehen(server.abruf, {
      kontoId: KONTO,
      limit: 2,
      liegtVor: async () => false,
      schreiben: async () => {}
    });
    assert.equal(server.aufrufe.length, 2);
    assert.equal(bericht.nachgezogen, 2);
    assert.equal(bericht.leergelaufen, false);
  });

  it('verschluesselte Zeilen mit NULL-Metadaten landen mit kanalId/kontoId im Index', async () => {
    const roh = zeile('500', {
      channel_id: '777',
      filename: null,
      mime: null,
      hat_thumb: false,
      verschluesselt: true,
      laufwerk_verteilt: true
    });
    const zeile_ = zeileAusServerAnhang(roh, KONTO);

    assert.equal(zeile_.id, '500');
    assert.equal(zeile_.kanalId, '777');
    assert.equal(zeile_.kontoId, KONTO);
    // Der Endpunkt liefert nur eigene Uploads — der Autor ist das Konto.
    assert.equal(zeile_.autorId, KONTO);
    assert.equal(zeile_.dateiname, null);
    assert.equal(zeile_.mime, null);
    assert.equal(zeile_.verschluesselt, true);
    // Den Schluessel sieht der Server nie — nur lokale Saetze tragen ihn.
    assert.equal(zeile_.schluessel, null);
    assert.equal(zeile_.laufwerkVerteilt, true);

    // Und derselbe Weg durch die Schleife: die Zeile landet geschrieben.
    const abgeladen: typeof zeile_[] = [];
    const server = fakeServer(['500'], 50);
    await medienNachziehen(server.abruf, {
      kontoId: KONTO,
      liegtVor: async () => false,
      schreiben: async (zeilen) => {
        abgeladen.push(...zeilen);
      }
    });
    assert.equal(abgeladen.length, 1);
    assert.equal(abgeladen[0]!.kontoId, KONTO);
    assert.equal(abgeladen[0]!.kanalId, '77');
  });
});

describe('Medien-Index aus Satz (Zweit-Schreibweg von verlaufPutSaetze)', () => {
  const basis = {
    schluessel: '00000000000000000042:00000000000000001000',
    kanalId: '42',
    nachrichtId: '1000',
    autorId: 'nutzer-9',
    inhalt: '',
    erstelltAm: '2026-09-01T10:00:00Z',
    bearbeitetAm: null,
    geloescht: false,
    verschluesselt: true,
    antwortAufId: null,
    kryptoId: null,
    kontoId: KONTO
  };

  it('uebertraegt Anhaenge als Index-Zeilen mit Kanal, Konto, Autor und Schluessel', () => {
    const satz = {
      ...basis,
      anhaenge: [
        {
          id: 'a-1',
          filename: 'geheim.png',
          mime: 'image/png',
          size: 42,
          verschluesselt: true,
          schluessel: 'SCHLUESSEL',
          thumb_schluessel: 'THUMB'
        },
        { id: 'a-2', filename: 'lesbar.pdf', mime: 'application/pdf', size: 7, url: 'https://x', thumb_url: 'https://t' },
        { kaputt: true }, // ohne id — wird fail-closed uebersprungen
        null
      ]
    };
    const zeilen = medienZeilenAusSatz(satz);
    assert.equal(zeilen.length, 2);

    assert.equal(zeilen[0]!.id, 'a-1');
    assert.equal(zeilen[0]!.kanalId, '42');
    assert.equal(zeilen[0]!.kontoId, KONTO);
    assert.equal(zeilen[0]!.autorId, 'nutzer-9');
    assert.equal(zeilen[0]!.erstelltAm, '2026-09-01T10:00:00Z');
    assert.equal(zeilen[0]!.dateiname, 'geheim.png');
    assert.equal(zeilen[0]!.verschluesselt, true);
    assert.equal(zeilen[0]!.hatThumb, true);
    assert.equal(zeilen[0]!.schluessel, 'SCHLUESSEL');

    assert.equal(zeilen[1]!.id, 'a-2');
    assert.equal(zeilen[1]!.verschluesselt, false);
    assert.equal(zeilen[1]!.schluessel, null);
    assert.equal(zeilen[1]!.hatThumb, true);
  });

  it('Grabstein-Saetze liefern keine Index-Zeilen', () => {
    const satz = {
      ...basis,
      geloescht: true,
      anhaenge: [{ id: 'a-1', filename: 'x', mime: 'text/plain', size: 1 }]
    };
    assert.deepEqual(medienZeilenAusSatz(satz), []);
  });
});
