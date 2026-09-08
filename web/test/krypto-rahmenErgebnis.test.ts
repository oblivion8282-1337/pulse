import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baueLoeschNutzlast,
  baueReaktionsNutzlast,
  baueBearbeitungsNutzlast,
  leseNachrichtNutzlast,
  rahmenAusNutzlast
} from '../src/lib/krypto/nachrichtNutzlast.ts';

/**
 * Die Frame-Erkennung (`rahmenAusNutzlast`) ist die GEMEINSAME
 * Fallunterscheidung beider Empfangswege — Olm (DMs) und Megolm (private
 * Gruppen, `gruppe/empfangen.ts`). Erkennt sie einen Frame auf dem einen Weg
 * anders als auf dem anderen, sieht die Gegenseite eine Reaktion als leere
 * Nachricht (oder umgekehrt). Der Absender steht bewusst NICHT in der
 * Nutzlast — er wird je Weg ermittelt und nur durchgereicht.
 */

const AUTOR = 'autor-1';
const KANAL = 'kanal-42';
const ZUSTELLUNG = 'zustell-77';

test('Loesch-, Reaktions- und Bearbeitungs-Frames werden erkannt', () => {
  const loeschung = rahmenAusNutzlast(
    leseNachrichtNutzlast(baueLoeschNutzlast('nachricht-9')),
    ZUSTELLUNG,
    KANAL,
    AUTOR
  );
  assert.deepEqual(loeschung, {
    art: 'loeschung',
    id: ZUSTELLUNG,
    channelId: KANAL,
    nachrichtId: 'nachricht-9'
  });

  const reaktion = rahmenAusNutzlast(
    leseNachrichtNutzlast(baueReaktionsNutzlast('nachricht-9', '👍', false)),
    ZUSTELLUNG,
    KANAL,
    AUTOR
  );
  assert.deepEqual(reaktion, {
    art: 'reaktion',
    id: ZUSTELLUNG,
    channelId: KANAL,
    autorId: AUTOR,
    ziel: 'nachricht-9',
    emoji: '👍',
    entfernen: false
  });

  const reaktionZurueck = rahmenAusNutzlast(
    leseNachrichtNutzlast(baueReaktionsNutzlast('nachricht-9', '👍', true)),
    ZUSTELLUNG,
    KANAL,
    AUTOR
  );
  assert.equal(reaktionZurueck?.art, 'reaktion');
  assert.equal(reaktionZurueck.entfernen, true);

  const bearbeitung = rahmenAusNutzlast(
    leseNachrichtNutzlast(baueBearbeitungsNutzlast('nachricht-9', 'Neuer Text')),
    ZUSTELLUNG,
    KANAL,
    AUTOR
  );
  assert.deepEqual(bearbeitung, {
    art: 'bearbeitung',
    id: ZUSTELLUNG,
    channelId: KANAL,
    ziel: 'nachricht-9',
    inhalt: 'Neuer Text'
  });
});

test('Kein Frame: gewoehnliche Nachricht und Loesch-Frame ohne ID fallen durch', () => {
  // Gewoehnliche Nachricht (mit Text und ID) — keine der Frame-Marken gesetzt.
  const nachricht = leseNachrichtNutzlast(
    new TextEncoder().encode(JSON.stringify({ v: 1, text: 'Hallo', id: 'nachricht-9' }))
  );
  assert.equal(rahmenAusNutzlast(nachricht, ZUSTELLUNG, KANAL, AUTOR), null);

  // Fail-closed: `geloescht` ohne ID ist kein Loesch-Frame — er faellt als
  // (leere) Nachricht durch, statt den Grabstein auf eine unbekannte ID zu
  // setzen (dieselbe Regel wie im Olm-Weg vor der Zusammenfassung).
  const kaputt = leseNachrichtNutzlast(
    new TextEncoder().encode(JSON.stringify({ v: 1, text: '', geloescht: true }))
  );
  assert.equal(rahmenAusNutzlast(kaputt, ZUSTELLUNG, KANAL, AUTOR), null);
});
