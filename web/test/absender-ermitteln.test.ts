/**
 * Wer eine geoeffnete Postfach-Zustellung geschrieben hat.
 *
 * Anlass: Etappe D2 hatte den Absender ausschliesslich vom Kanal-Gegenpart
 * abgeleitet (`directMessages.byId[...].other_user_id`) — bei einer
 * verschluesselten DM liefert der Server denselben Umschlag aber auch an
 * die EIGENEN anderen Geraete des Senders aus (so kommt eine vom Handy
 * gesendete Nachricht auf dem Desktop an), und diese Zustellungen wurden
 * faelschlich dem Gespraechspartner zugeschrieben. `absenderErmitteln`
 * bevorzugt deshalb den vom Server hergeleiteten `absender_user_id` und
 * faellt nur zurueck, wenn der fehlt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { absenderErmitteln } from '../src/lib/krypto/absenderErmitteln.ts';

describe('absenderErmitteln', () => {
  test('nimmt den vom Server gelieferten Absender, auch wenn er das EIGENE Geraet des Empfaengers ist', () => {
    // Der springende Punkt: der Kanal-Gegenpart waere hier "der andere",
    // aber die Zustellung kam vom eigenen Zweitgeraet des Empfaengers.
    assert.equal(absenderErmitteln('eigene-user-id', 'anderer-user-id'), 'eigene-user-id');
  });

  test('nimmt den Server-Absender, wenn kein Kanal-Gegenpart bekannt ist', () => {
    assert.equal(absenderErmitteln('server-absender', undefined), 'server-absender');
  });

  test('faellt auf den Kanal-Gegenpart zurueck, wenn das Sendegeraet sich abgemeldet hat', () => {
    // Server liefert `null`, weil das DeviceKeyBundle beim Abholen schon
    // weg war (Geraet zwischen Einliefern und Abholen deregistriert).
    assert.equal(absenderErmitteln(null, 'anderer-user-id'), 'anderer-user-id');
  });

  test('liefert null, wenn weder Server-Absender noch Kanal-Gegenpart bekannt sind', () => {
    assert.equal(absenderErmitteln(null, undefined), null);
    assert.equal(absenderErmitteln(undefined, undefined), null);
  });
});
