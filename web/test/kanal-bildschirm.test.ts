/**
 * Die Rechnung „welcher Kanal steht auf dem Schirm".
 *
 * Der Anlass: die Querformat-Regel des Handys prüfte nur, ob der Pfad zu
 * IRGENDEINEM Kanal-Bildschirm gehört, und verglich ihn nie mit dem Kanal, in
 * dem der Stream läuft. Wer aus dem Sprachkanal mit Stream in einen Textkanal
 * wechselte und kippte, verlor Bereichsleiste, Sprach-Dock, Community-Leiste
 * und Kanalliste gleichzeitig. Genau dieser Vergleich steht hier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kanalAusPfad, istAktiverSprachKanal } from '../src/lib/navigation/kanalBildschirm.ts';

test('zerlegt einen Kanal-Pfad in Community und Kanal', () => {
  assert.deepEqual(kanalAusPfad('/app/guilds/12/channels/34'), {
    guildId: '12',
    channelId: '34'
  });
});

test('nachlaufender Schrägstrich ändert nichts', () => {
  assert.deepEqual(kanalAusPfad('/app/guilds/12/channels/34/'), {
    guildId: '12',
    channelId: '34'
  });
});

test('andere Bildschirme sind kein Kanal', () => {
  for (const pfad of [
    '/app/rooms',
    '/app/rooms/12',
    '/app/@me/34',
    '/app/guilds/12',
    // Eine Ebene tiefer ist nicht mehr der Kanal-Bildschirm selbst.
    '/app/guilds/12/channels/34/settings'
  ]) {
    assert.equal(kanalAusPfad(pfad), null, pfad);
  }
});

test('der aktive Sprachkanal wird erkannt', () => {
  assert.equal(istAktiverSprachKanal('/app/guilds/12/channels/34', '34'), true);
});

test('ein ANDERER Kanal zählt nicht — das war der Fehler', () => {
  // Stream läuft in Kanal 34, auf dem Schirm steht Textkanal 99.
  assert.equal(istAktiverSprachKanal('/app/guilds/12/channels/99', '34'), false);
});

test('ohne Sprachkanal ist die Antwort immer nein', () => {
  assert.equal(istAktiverSprachKanal('/app/guilds/12/channels/34', null), false);
  assert.equal(istAktiverSprachKanal('/app/guilds/12/channels/34', undefined), false);
  assert.equal(istAktiverSprachKanal('/app/guilds/12/channels/34', ''), false);
});

test('ausserhalb eines Kanal-Bildschirms ebenfalls nein', () => {
  assert.equal(istAktiverSprachKanal('/app/rooms', '34'), false);
});
