import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RENEW_LEAD_MS,
  RENEW_MIN_DELAY_MS,
  RENEW_RETRY_MS,
  erneuerungsAbstandMs,
  wiederholungLohnt,
} from '../src/lib/ws/token-erneuerung.ts';

const JETZT = Date.UTC(2026, 7, 26, 12, 0, 0);
const inSekunden = (ms: number) => (JETZT + ms) / 1000;

test('ohne exp wird nie erneuert — der Server stellt dann auch keinen Wecker', () => {
  assert.equal(erneuerungsAbstandMs(undefined, JETZT), null);
  assert.equal(erneuerungsAbstandMs(null, JETZT), null);
  assert.equal(erneuerungsAbstandMs(Number.NaN, JETZT), null);
});

test('Erneuerung liegt um den Vorlauf vor dem Ablauf', () => {
  // Cloud-Token: 900 s Lebensdauer, Vorlauf 60 s → nach 840 s.
  assert.equal(
    erneuerungsAbstandMs(inSekunden(900_000), JETZT),
    900_000 - RENEW_LEAD_MS
  );
});

test('ein Token im Vorlauf-Fenster wird sofort erneuert, aber nicht im selben Tick', () => {
  // Reconnect mit einem Token, das nur noch 20 s trägt: der berechnete
  // Zeitpunkt liegt in der Vergangenheit. Ein negativer Abstand würde als
  // setTimeout(…, -x) sofort feuern — das ist gewollt, aber der Aufbau der
  // Verbindung soll erst fertig sein.
  assert.equal(erneuerungsAbstandMs(inSekunden(20_000), JETZT), RENEW_MIN_DELAY_MS);
  assert.equal(erneuerungsAbstandMs(inSekunden(-5_000), JETZT), RENEW_MIN_DELAY_MS);
});

test('Wiederholung nur, solange das alte Token die Wartezeit überlebt', () => {
  // Sonst ist der Socket weg, bevor der zweite Versuch ankommt — und ein
  // Versuch ins Leere kostet nur einen weiteren Refresh gegen einen gerade
  // nicht erreichbaren auth-svc.
  assert.equal(wiederholungLohnt(inSekunden(RENEW_RETRY_MS + 1_000), JETZT), true);
  assert.equal(wiederholungLohnt(inSekunden(RENEW_RETRY_MS - 1_000), JETZT), false);
  assert.equal(wiederholungLohnt(inSekunden(-1_000), JETZT), false);
  assert.equal(wiederholungLohnt(undefined, JETZT), false);
});

test('der Vorlauf trägt einen Fehlversuch samt Wiederholung', () => {
  // Sonst wäre die Wiederholung wirkungslos: sie käme erst nach dem Ablauf.
  assert.ok(RENEW_LEAD_MS > RENEW_RETRY_MS + RENEW_MIN_DELAY_MS);
});
