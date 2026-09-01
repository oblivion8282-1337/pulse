import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bereinigeSegment,
  eindeutigMachen,
  baueKlartextExport,
  type ExportNachricht
} from '../src/lib/ablage/export.ts';

test('bereinigeSegment entschaerft Pfadtrenner — kein Verlassen des Export-Ordners', () => {
  assert.equal(bereinigeSegment('../../etc/passwd', 'x'), '.._.._etc_passwd');
  assert.equal(bereinigeSegment('a/b\\c', 'x'), 'a_b_c');
});

test('bereinigeSegment ersetzt Windows-verbotene Zeichen', () => {
  assert.equal(bereinigeSegment('bild:<>|?"*.png', 'x'), 'bild_______.png');
});

test('bereinigeSegment ersetzt Steuerzeichen', () => {
  const mitSteuerzeichen = 'a' + String.fromCharCode(7) + 'b';
  assert.equal(bereinigeSegment(mitSteuerzeichen, 'x'), 'a_b');
});

test('bereinigeSegment kappt Punkte/Leerzeichen am Ende', () => {
  assert.equal(bereinigeSegment('name...   ', 'x'), 'name');
});

test('bereinigeSegment faengt leere/nur-Punkte Namen ab', () => {
  assert.equal(bereinigeSegment('', 'ersatz'), 'ersatz');
  assert.equal(bereinigeSegment('.', 'ersatz'), 'ersatz');
  assert.equal(bereinigeSegment('..', 'ersatz'), 'ersatz');
  assert.equal(bereinigeSegment(null, 'ersatz'), 'ersatz');
});

test('bereinigeSegment maskiert Windows-reservierte Namen', () => {
  assert.equal(bereinigeSegment('CON', 'x'), '_CON');
  assert.equal(bereinigeSegment('con.txt', 'x'), '_con.txt');
  assert.equal(bereinigeSegment('lpt1', 'x'), '_lpt1');
  // Kein reservierter Name als Teilstring — darf unangetastet bleiben.
  assert.equal(bereinigeSegment('conference.txt', 'x'), 'conference.txt');
});

test('bereinigeSegment kappt sehr lange Namen', () => {
  const lang = 'a'.repeat(500) + '.png';
  const kurz = bereinigeSegment(lang, 'x');
  assert.ok(kurz.length <= 120);
});

test('eindeutigMachen laesst den ersten Namen unangetastet', () => {
  const vergeben = new Set<string>();
  assert.equal(eindeutigMachen('bild.png', vergeben), 'bild.png');
});

test('eindeutigMachen haengt bei Kollision einen Zaehler an, vor der Endung', () => {
  const vergeben = new Set<string>(['bild.png']);
  assert.equal(eindeutigMachen('bild.png', vergeben), 'bild (2).png');
});

test('eindeutigMachen zaehlt weiter, bis ein freier Name gefunden ist', () => {
  const vergeben = new Set<string>(['bild.png', 'bild (2).png', 'bild (3).png']);
  assert.equal(eindeutigMachen('bild.png', vergeben), 'bild (4).png');
});

function nachricht(teil: Partial<ExportNachricht>): ExportNachricht {
  return {
    kanalId: 'k1',
    kanalName: 'Alice',
    nachrichtId: '1',
    autorName: 'Bob',
    inhalt: 'hallo',
    erstelltAm: '2026-08-30T10:00:00Z',
    geloescht: false,
    anhaenge: [],
    ...teil
  };
}

test('baueKlartextExport gruppiert nach Kanal und Tag', () => {
  const ergebnis = baueKlartextExport([
    nachricht({ nachrichtId: '1', erstelltAm: '2026-08-30T10:00:00Z', inhalt: 'eins' }),
    nachricht({ nachrichtId: '2', erstelltAm: '2026-08-31T09:00:00Z', inhalt: 'zwei' }),
    nachricht({
      nachrichtId: '3',
      kanalId: 'k2',
      kanalName: 'Team',
      erstelltAm: '2026-08-30T11:00:00Z',
      inhalt: 'drei'
    })
  ]);

  const pfade = ergebnis.dateien.map((d) => d.pfad).sort();
  assert.deepEqual(pfade, [
    'Alice/2026-08-30.txt',
    'Alice/2026-08-31.txt',
    'Team/2026-08-30.txt',
    'uebersicht.txt'
  ]);

  const tag1 = ergebnis.dateien.find((d) => d.pfad === 'Alice/2026-08-30.txt');
  assert.ok(tag1 && tag1.art === 'text');
  assert.match((tag1 as { inhalt: string }).inhalt, /\[10:00:00\] Bob: eins/);
});

test('baueKlartextExport sortiert Nachrichten eines Tages chronologisch, unabhaengig von der Eingabereihenfolge', () => {
  const ergebnis = baueKlartextExport([
    nachricht({ nachrichtId: '2', erstelltAm: '2026-08-30T12:00:00Z', inhalt: 'spaeter' }),
    nachricht({ nachrichtId: '1', erstelltAm: '2026-08-30T09:00:00Z', inhalt: 'frueher' })
  ]);
  const tag = ergebnis.dateien.find((d) => d.pfad === 'Alice/2026-08-30.txt');
  assert.ok(tag && tag.art === 'text');
  const inhalt = (tag as { inhalt: string }).inhalt;
  assert.ok(inhalt.indexOf('frueher') < inhalt.indexOf('spaeter'));
});

test('baueKlartextExport zeigt geloeschte Nachrichten als Platzhalter, nicht mit Inhalt', () => {
  const ergebnis = baueKlartextExport([
    nachricht({ inhalt: 'geheim', geloescht: true })
  ]);
  const tag = ergebnis.dateien.find((d) => d.pfad === 'Alice/2026-08-30.txt');
  const inhalt = (tag as { inhalt: string }).inhalt;
  assert.ok(!inhalt.includes('geheim'));
  assert.match(inhalt, /\[gelöscht\]/);
});

test('baueKlartextExport listet verfuegbare Anhaenge als eigene Datei', () => {
  const ergebnis = baueKlartextExport([
    nachricht({
      anhaenge: [{ id: 'a1', dateiname: 'urlaub.jpg', verfuegbar: true }]
    })
  ]);
  const anhang = ergebnis.dateien.find((d) => d.art === 'anhang');
  assert.ok(anhang);
  assert.equal(anhang!.pfad, 'Alice/anhaenge/urlaub.jpg');
  assert.equal((anhang as { anhangId: string }).anhangId, 'a1');
  assert.equal(ergebnis.fehlstellen.length, 0);
});

test('baueKlartextExport macht zwei gleichnamige Anhaenge im selben Kanal eindeutig', () => {
  const ergebnis = baueKlartextExport([
    nachricht({
      nachrichtId: '1',
      anhaenge: [{ id: 'a1', dateiname: 'bild.png', verfuegbar: true }]
    }),
    nachricht({
      nachrichtId: '2',
      anhaenge: [{ id: 'a2', dateiname: 'bild.png', verfuegbar: true }]
    })
  ]);
  const pfade = ergebnis.dateien.filter((d) => d.art === 'anhang').map((d) => d.pfad).sort();
  assert.deepEqual(pfade, ['Alice/anhaenge/bild (2).png', 'Alice/anhaenge/bild.png']);
});

test('baueKlartextExport meldet fehlende Anhaenge als Fehlstelle statt sie zu verschweigen', () => {
  const ergebnis = baueKlartextExport([
    nachricht({
      anhaenge: [
        { id: 'a1', dateiname: 'weg.pdf', verfuegbar: false, grund: 'lokal nicht mehr vorhanden' }
      ]
    })
  ]);
  assert.equal(ergebnis.dateien.some((d) => d.art === 'anhang'), false);
  assert.deepEqual(ergebnis.fehlstellen, [
    { kanalName: 'Alice', dateiname: 'weg.pdf', grund: 'lokal nicht mehr vorhanden' }
  ]);
  const uebersicht = ergebnis.dateien.find((d) => d.pfad === 'uebersicht.txt');
  const inhalt = (uebersicht as { inhalt: string }).inhalt;
  assert.match(inhalt, /weg\.pdf/);
  assert.match(inhalt, /lokal nicht mehr vorhanden/);
});

test('baueKlartextExport haelt zwei Kanaele mit gleichem Anzeigenamen auseinander', () => {
  const ergebnis = baueKlartextExport([
    nachricht({ kanalId: 'k1', kanalName: 'Team', nachrichtId: '1' }),
    nachricht({ kanalId: 'k2', kanalName: 'Team', nachrichtId: '2' })
  ]);
  const ordner = new Set(ergebnis.dateien.filter((d) => d.pfad !== 'uebersicht.txt').map((d) => d.pfad.split('/')[0]));
  assert.equal(ordner.size, 2);
});

test('baueKlartextExport ohne Nachrichten liefert nur die Uebersicht', () => {
  const ergebnis = baueKlartextExport([]);
  assert.deepEqual(ergebnis.dateien.map((d) => d.pfad), ['uebersicht.txt']);
  assert.match((ergebnis.dateien[0] as { inhalt: string }).inhalt, /Keine Nachrichten/);
});
