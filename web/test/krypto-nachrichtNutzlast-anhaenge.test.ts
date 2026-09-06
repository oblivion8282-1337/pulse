/**
 * Gegenprobe zur Anhang-Erweiterung des Nutzlast-Formats (Etappe E).
 *
 * Zwei Behauptungen stehen hier auf dem Pruefstand, und die zweite ist die
 * riskantere:
 *
 *  1. Anhang-Angaben ueberstehen den Hin- und Rueckweg vollstaendig.
 *  2. **Die Vertraeglichkeit in BEIDE Richtungen.** Eine Nutzlast ohne das
 *     neue Feld muss weiterhin gelesen werden (leicht) — und eine Nutzlast
 *     MIT dem neuen Feld muss von einem Empfaenger, der es nicht kennt,
 *     immer noch als Nachricht gelesen werden (der eigentliche Punkt). Der
 *     alte Leser ist dafuer unten woertlich nachgebaut: er ist die Fassung,
 *     die auf den Geraeten steht, die noch nicht aktualisiert haben, und der
 *     Text darf ihnen nie verlorengehen.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  baueNachrichtNutzlast,
  leseNachrichtNutzlast,
  type AnhangAngabe
} from '../src/lib/krypto/nachrichtNutzlast.ts';

/** Der Leser VOR Etappe E, Zeile fuer Zeile wie er war. Nur er kann die
 *  Frage „bleibt der Text fuer ein aelteres Geraet lesbar?" beantworten. */
function alterLeser(bytes: Uint8Array): { text: string; id: string | null } {
  const roh = new TextDecoder().decode(bytes);
  try {
    const geparst: unknown = JSON.parse(roh);
    if (
      geparst !== null &&
      typeof geparst === 'object' &&
      (geparst as Record<string, unknown>).v === 1 &&
      typeof (geparst as Record<string, unknown>).text === 'string'
    ) {
      const o = geparst as Record<string, unknown>;
      return { text: o.text as string, id: typeof o.id === 'string' ? o.id : null };
    }
  } catch {
    /* Legacy-Klartext */
  }
  return { text: roh, id: null };
}

const BILD: AnhangAngabe = {
  id: '987654321',
  name: 'urlaub.png',
  typ: 'image/png',
  groesse: 204_800,
  schluessel: 'c2NobHVlc3NlbC1kZXItZGF0ZWktMzIteA==',
  breite: 1920,
  hoehe: 1080,
  vorschau: { schluessel: 'dm9yc2NoYXUtc2NobHVlc3NlbC0zMi14eA==', breite: 720, hoehe: 405 }
};

describe('Anhang-Angaben in der Nutzlast', () => {
  test('ueberstehen den Hin- und Rueckweg vollstaendig', () => {
    const gelesen = leseNachrichtNutzlast(
      baueNachrichtNutzlast('schau mal', 'msg-1', null, [BILD])
    );
    assert.equal(gelesen.text, 'schau mal');
    assert.deepEqual(gelesen.anhaenge, [BILD]);
  });

  test('mehrere Anhaenge behalten ihre Reihenfolge', () => {
    const zweiter: AnhangAngabe = { ...BILD, id: '111', name: 'zweites.pdf', vorschau: null };
    const gelesen = leseNachrichtNutzlast(
      baueNachrichtNutzlast('', 'msg-2', null, [BILD, zweiter])
    );
    assert.deepEqual(
      gelesen.anhaenge.map((a) => a.id),
      [BILD.id, zweiter.id]
    );
  });

  test('eine Nutzlast OHNE Anhang-Feld wird weiterhin gelesen', () => {
    const gelesen = leseNachrichtNutzlast(baueNachrichtNutzlast('nur text', 'msg-3', null));
    assert.equal(gelesen.text, 'nur text');
    assert.equal(gelesen.id, 'msg-3');
    assert.deepEqual(gelesen.anhaenge, []);
    // Und das Feld steht auch nicht als leere Liste in den Bytes — eine
    // gewoehnliche Nachricht soll davon nicht groesser werden.
    const roh = new TextDecoder().decode(baueNachrichtNutzlast('nur text', 'msg-3', null));
    assert.ok(!roh.includes('anhaenge'));
  });

  test('roher Legacy-Text (ganz ohne Huelle) bleibt lesbar', () => {
    const gelesen = leseNachrichtNutzlast(new TextEncoder().encode('von ganz frueher'));
    assert.equal(gelesen.text, 'von ganz frueher');
    assert.deepEqual(gelesen.anhaenge, []);
  });

  test('ein Empfaenger, der das Feld NICHT kennt, liest den Text trotzdem', () => {
    // Der Kern der Vertraeglichkeit: haette die Aenderung die Fassungsnummer
    // angehoben, faende der alte Leser hier kein `v === 1` mehr, fiele in
    // seinen Legacy-Zweig und zeigte dem Nutzer das rohe JSON als Nachricht.
    const bytes = baueNachrichtNutzlast('der text muss ankommen', 'msg-4', null, [BILD]);
    const alt = alterLeser(bytes);
    assert.equal(alt.text, 'der text muss ankommen');
    assert.equal(alt.id, 'msg-4');
  });

  test('ein unvollstaendiger Anhang wird verworfen, der Text bleibt', () => {
    // Fail-closed: eine Kachel ohne Schluessel liesse sich nie oeffnen.
    const roh = JSON.stringify({
      v: 1,
      text: 'mit kaputtem anhang',
      id: 'msg-5',
      anhaenge: [{ id: '1', name: 'x', typ: 'image/png', groesse: 10 }, BILD]
    });
    const gelesen = leseNachrichtNutzlast(new TextEncoder().encode(roh));
    assert.equal(gelesen.text, 'mit kaputtem anhang');
    assert.deepEqual(
      gelesen.anhaenge.map((a) => a.id),
      [BILD.id]
    );
  });

  test('eine kaputte Vorschau-Angabe kostet nur die Vorschau, nicht den Anhang', () => {
    const roh = JSON.stringify({
      v: 1,
      text: '',
      id: 'msg-6',
      anhaenge: [{ ...BILD, vorschau: { schluessel: 'x' } }]
    });
    const gelesen = leseNachrichtNutzlast(new TextEncoder().encode(roh));
    assert.equal(gelesen.anhaenge.length, 1);
    assert.equal(gelesen.anhaenge[0].vorschau, null);
  });
});
