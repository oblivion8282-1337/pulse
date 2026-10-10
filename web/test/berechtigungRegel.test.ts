import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ablehnungMerken,
  SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE,
  vorgehenVorDemDialog,
  type Lage
} from '../src/lib/platform/berechtigungRegel.ts';

const lage = (teil: Partial<Lage> = {}): Lage => ({
  art: 'mikrofon',
  stand: 'offen',
  inHuelle: true,
  schonAbgelehnt: false,
  sendungen: 0,
  ...teil
});

test('im Browser ohne Blatt weiter — dort ist die Erlaubnis jederzeit umkehrbar', () => {
  assert.equal(vorgehenVorDemDialog(lage({ inHuelle: false })), 'weiter');
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mitteilungen', inHuelle: false })), 'weiter');
});

test('erteilt oder verweigert: ohne Blatt weiter, der Dialog erscheint ohnehin nicht mehr', () => {
  assert.equal(vorgehenVorDemDialog(lage({ stand: 'erteilt' })), 'weiter');
  assert.equal(vorgehenVorDemDialog(lage({ stand: 'verweigert' })), 'weiter');
});

test('Mikrofon und Kamera: die Handlung erklaert sich selbst, das Blatt kommt sofort', () => {
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mikrofon', sendungen: 0 })), 'erklaeren');
  assert.equal(vorgehenVorDemDialog(lage({ art: 'kamera', sendungen: 0 })), 'erklaeren');
});

// Die beiden Faelle aus dem Bughunt 2026-10-11 (T6): vorher hiess „keine
// Erklaerung" fuer den Aufrufer „ohne Blatt weiter" — der System-Dialog ging
// auf, obwohl er gar nicht haette erscheinen duerfen. „nicht" ist der einzige
// Ausgang, an dem der Aufrufer KEINEN Dialog stellt.
test('Mitteilungen ohne Anlass: weder Blatt noch System-Dialog', () => {
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mitteilungen', sendungen: 0 })), 'nicht');
  assert.equal(
    vorgehenVorDemDialog(
      lage({ art: 'mitteilungen', sendungen: SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE - 1 })
    ),
    'nicht'
  );
});

test('Mitteilungen nach "spaeter": weder Blatt noch System-Dialog, auch mit Anlass', () => {
  assert.equal(
    vorgehenVorDemDialog(lage({ art: 'mitteilungen', schonAbgelehnt: true, sendungen: 500 })),
    'nicht'
  );
});

test('Mitteilungen mit Anlass: erst das Blatt', () => {
  assert.equal(
    vorgehenVorDemDialog(
      lage({ art: 'mitteilungen', sendungen: SENDUNGEN_BIS_ZUR_MITTEILUNGSFRAGE })
    ),
    'erklaeren'
  );
  // Die Schwelle sperrt nicht nachtraeglich.
  assert.equal(vorgehenVorDemDialog(lage({ art: 'mitteilungen', sendungen: 500 })), 'erklaeren');
});

test('ein alter "spaeter"-Merker bei Kamera sperrt die Handlung nicht', () => {
  // Fuer Kamera und Mikrofon wird „spaeter" nie gemerkt; steht trotzdem einer
  // da, darf er weder das Blatt ueberspringen noch die Kamera verweigern.
  assert.equal(vorgehenVorDemDialog(lage({ art: 'kamera', schonAbgelehnt: true })), 'erklaeren');
});

test('nur ein anlassloses "spaeter" wird dauerhaft gemerkt', () => {
  // Mitteilungen haben keine ausloesende Handlung: "spaeter" heisst "frag mich
  // nicht wieder".
  assert.equal(ablehnungMerken('mitteilungen'), true);
  // Kamera und Mikrofon werden von einer Handlung ausgeloest: "spaeter" bricht
  // die Handlung ab und sagt nichts ueber die naechste. Wuerde man es merken,
  // kaeme beim naechsten Oeffnen der System-Dialog OHNE Erklaerung — genau
  // das, was dieser Punkt verhindern soll.
  assert.equal(ablehnungMerken('kamera'), false);
  assert.equal(ablehnungMerken('mikrofon'), false);
});
