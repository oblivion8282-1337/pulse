import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baueAnrufSchluesselNutzlast,
  leseNachrichtNutzlast,
  rahmenAusNutzlast
} from '../src/lib/krypto/nachrichtNutzlast.ts';
import {
  warteAufAnrufSchluessel,
  SCHLUESSEL_WARTEZEIT_MS
} from '../src/lib/anrufe/schluesselWarten.ts';

// exakt 32 Bytes, base64 (wie der Store sie erzeugt und LiveKit erwartet)
const SCHLUESSEL = Buffer.from(new Array(32).fill(0).map((_, i) => i * 7 + 1)).toString('base64');

test('Anruf-Schlüssel-Frame: Roundtrip, Rahmen-Erkennung, fail-closed', () => {
  const bytes = baueAnrufSchluesselNutzlast('1788829404772578317', SCHLUESSEL);
  const gelesen = leseNachrichtNutzlast(bytes);
  assert.equal(gelesen.anrufSchluessel?.anrufId, '1788829404772578317');
  assert.equal(gelesen.anrufSchluessel?.schluessel, SCHLUESSEL);
  assert.equal(gelesen.text, '');
  // Rahmen-Erkennung: derselbe Weg wie Reaktion/Bearbeitung, für DM UND Gruppe.
  const rahmen = rahmenAusNutzlast(gelesen, 'zustell-id', 'kanal-id', 'autor-id');
  assert.deepEqual(rahmen, {
    art: 'anrufSchluessel',
    id: 'zustell-id',
    channelId: 'kanal-id',
    autorId: 'autor-id',
    anrufId: '1788829404772578317',
    schluessel: SCHLUESSEL
  });

  // Fail-closed: fehlende/leere Felder sind KEIN Frame — und fallen als
  // leere Textnachricht nicht in die Anzeige.
  for (const kaputt of [
    { v: 1, text: '', anrufSchluessel: { schluessel: SCHLUESSEL } },
    { v: 1, text: '', anrufSchluessel: { anrufId: '', schluessel: SCHLUESSEL } },
    { v: 1, text: '', anrufSchluessel: { anrufId: 'x' } },
    { v: 1, text: '', anrufSchluessel: { anrufId: 'x', schluessel: '' } },
    { v: 1, text: '', anrufSchluessel: 'trick' },
    { v: 1, text: '' }
  ]) {
    const g = leseNachrichtNutzlast(new TextEncoder().encode(JSON.stringify(kaputt)));
    assert.equal(g.anrufSchluessel, undefined, JSON.stringify(kaputt));
    assert.equal(rahmenAusNutzlast(g, 'id', 'kanal', 'autor'), null);
    assert.equal(g.text, '');
  }
});

test('Warte-Logik: Schlüssel trifft ein → wird geliefert', async () => {
  let jetzt = 0;
  const schlafen = async (ms: number) => {
    jetzt += ms;
  };
  let abfragen = 0;
  const schluessel = await warteAufAnrufSchluessel(() => (++abfragen >= 3 ? SCHLUESSEL : null), {
    jetzt: () => jetzt,
    schlafen
  });
  assert.equal(schluessel, SCHLUESSEL);
  assert.equal(abfragen, 3);
  assert.ok(jetzt < SCHLUESSEL_WARTEZEIT_MS, 'kam vor der Frist an');
});

test('Warte-Logik: Timeout → null (fail-closed), genau bis zur Frist gewartet', async () => {
  let jetzt = 0;
  let schlafRufe = 0;
  const schlafen = async (ms: number) => {
    schlafRufe++;
    jetzt += ms;
  };
  const schluessel = await warteAufAnrufSchluessel(() => null, { jetzt: () => jetzt, schlafen });
  assert.equal(schluessel, null);
  assert.equal(jetzt, SCHLUESSEL_WARTEZEIT_MS);
  assert.equal(schlafRufe, SCHLUESSEL_WARTEZEIT_MS / 100);
});

test('Warte-Logik: leerer String gilt nicht als Schlüssel', async () => {
  let jetzt = 0;
  const schlafen = async (ms: number) => {
    jetzt += ms;
  };
  let abfragen = 0;
  const schluessel = await warteAufAnrufSchluessel(() => (++abfragen >= 2 ? '' : null), {
    jetzt: () => jetzt,
    schlafen
  });
  assert.equal(schluessel, null);
});
