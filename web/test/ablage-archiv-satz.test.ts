import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  archivSchluessel,
  dekodiereArchivSatz,
  kodiereArchivSatz,
  type ArchivSatz
} from '../src/lib/ablage/archivSatz.ts';

function satz(teil: Partial<ArchivSatz> = {}): ArchivSatz {
  return {
    kanalId: 'kanal-1',
    nachrichtId: '42',
    autorId: 'user-1',
    inhalt: 'hallo',
    erstelltAm: '2026-09-01T10:00:00.000Z',
    bearbeitetAm: null,
    geloescht: false,
    antwortAufId: null,
    kryptoId: null,
    anhaenge: [],
    ...teil
  };
}

test('was hineingeht, kommt wieder heraus', () => {
  // Der eigentliche Vertrag: Hin- und Rückweg sind zwei Hälften desselben
  // Formats. Wer ein Feld hinzufügt und nur eine Hälfte anfasst, faellt hier
  // durch — statt erst, wenn ein Nutzer seinen Verlauf zurueckholt.
  const original = satz({
    bearbeitetAm: '2026-09-01T11:00:00.000Z',
    geloescht: true,
    antwortAufId: '41',
    kryptoId: 'k-7',
    anhaenge: [{ id: 'a1', name: 'bild.png' }]
  });
  assert.deepEqual(dekodiereArchivSatz(kodiereArchivSatz(original)), original);
});

test('der Anhang-Verweis ueberlebt die Runde', () => {
  // Ohne dieses Feld kam eine Bildnachricht als reiner Text zurueck, ohne
  // dass ueberhaupt zu sehen war, dass ein Anhang dazugehoerte.
  const zurueck = dekodiereArchivSatz(
    kodiereArchivSatz(satz({ anhaenge: [{ id: 'a1' }, { id: 'a2' }] }))
  );
  assert.equal(zurueck?.anhaenge.length, 2);
});

test('ein Eintrag ohne Anhang-Feld ist gueltig, nicht kaputt', () => {
  // Bestand von vor dem 2026-09-01. Ein Archiv wird ueber Jahre gelesen.
  const roh = new TextEncoder().encode(
    JSON.stringify({
      kanalId: 'kanal-1',
      nachrichtId: '42',
      autorId: 'user-1',
      inhalt: 'alt',
      erstelltAm: '2026-08-01T00:00:00.000Z'
    })
  );
  const zurueck = dekodiereArchivSatz(roh);
  assert.equal(zurueck?.inhalt, 'alt');
  assert.deepEqual(zurueck?.anhaenge, []);
});

test('fehlende Pflichtfelder werden abgewiesen', () => {
  // Fail-closed wie `verlauf/satz.ts::baueSatz`: ein halber Satz im lokalen
  // Speicher faellt erst Wochen spaeter auf und sieht dann wie Datenverlust
  // aus.
  for (const fehlend of ['kanalId', 'nachrichtId', 'autorId', 'inhalt', 'erstelltAm']) {
    const d = { ...satz() } as Record<string, unknown>;
    delete d[fehlend];
    const roh = new TextEncoder().encode(JSON.stringify(d));
    assert.equal(dekodiereArchivSatz(roh), null, `${fehlend} fehlt -> null`);
  }
});

test('Muell ergibt null statt einer Ausnahme', () => {
  assert.equal(dekodiereArchivSatz(new TextEncoder().encode('kein json')), null);
  assert.equal(dekodiereArchivSatz(new TextEncoder().encode('null')), null);
  assert.equal(dekodiereArchivSatz(new TextEncoder().encode('"text"')), null);
  assert.equal(dekodiereArchivSatz(new Uint8Array([0xff, 0xfe, 0x00])), null);
});

test('falsche Feldtypen fallen auf den Vorgabewert, nicht auf Muell', () => {
  const roh = new TextEncoder().encode(
    JSON.stringify({ ...satz(), bearbeitetAm: 7, kryptoId: {}, anhaenge: 'nein' })
  );
  const zurueck = dekodiereArchivSatz(roh);
  assert.equal(zurueck?.bearbeitetAm, null);
  assert.equal(zurueck?.kryptoId, null);
  assert.deepEqual(zurueck?.anhaenge, []);
});

test('geloescht gilt nur bei echtem true', () => {
  // Ein Grabstein ist eine Aussage, kein Nebenprodukt einer laxen Umwandlung:
  // `"false"` oder `1` duerfen keine Nachricht loeschen.
  for (const wert of ['true', 1, 'false', null]) {
    const roh = new TextEncoder().encode(JSON.stringify({ ...satz(), geloescht: wert }));
    assert.equal(dekodiereArchivSatz(roh)?.geloescht, false, `geloescht=${String(wert)}`);
  }
  assert.equal(dekodiereArchivSatz(kodiereArchivSatz(satz({ geloescht: true })))?.geloescht, true);
});

test('der Archiv-Dateiname ist je Nachricht eindeutig und wiederholbar', () => {
  // Wiederholbar ist der Punkt: derselbe Satz ueberschreibt sich selbst,
  // deshalb darf der Schreibweg jederzeit abbrechen und neu beginnen.
  assert.equal(archivSchluessel('k1', '42'), 'k1:42');
  assert.equal(archivSchluessel('k1', '42'), archivSchluessel('k1', '42'));
  assert.notEqual(archivSchluessel('k1', '42'), archivSchluessel('k2', '42'));
});
