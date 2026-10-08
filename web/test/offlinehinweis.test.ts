import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  EIGENE_ANZEIGE,
  GEDULD_MS,
  offlineHinweis,
  type Hinweislage
} from '../src/lib/ws/offlinehinweis.ts';

const lage = (teil: Partial<Hinweislage> = {}): Hinweislage => ({
  gewuenscht: true,
  zustand: 'closed',
  netzOnline: true,
  seitMs: 60_000,
  ...teil
});

test('offene Verbindung und Abmeldung zeigen nichts', () => {
  assert.equal(offlineHinweis(lage({ zustand: 'open' })), 'keiner');
  assert.equal(offlineHinweis(lage({ gewuenscht: false })), 'keiner');
});

test('Zustaende mit eigener Anzeige bleiben unangetastet', () => {
  for (const z of EIGENE_ANZEIGE) {
    assert.equal(offlineHinweis(lage({ zustand: z })), 'keiner', z);
    // Auch bei abgeschaltetem Netz: die eigentliche Ursache ist eine andere.
    assert.equal(offlineHinweis(lage({ zustand: z, netzOnline: false })), 'keiner', z);
  }
});

test('kurzer Abriss blitzt nicht auf', () => {
  assert.equal(offlineHinweis(lage({ seitMs: 0 })), 'keiner');
  assert.equal(offlineHinweis(lage({ seitMs: GEDULD_MS - 1 })), 'keiner');
  assert.equal(offlineHinweis(lage({ seitMs: GEDULD_MS })), 'offline');
});

test('sagt das Geraet selbst offline, gilt die Geduld nicht', () => {
  assert.equal(offlineHinweis(lage({ netzOnline: false, seitMs: 0 })), 'offline');
});

test('online ist KEIN Gegenbeweis — ein Hotelnetz ist auch online', () => {
  assert.equal(offlineHinweis(lage({ netzOnline: true, seitMs: 60_000 })), 'offline');
});

test('verbindet und offline sind zwei Aussagen', () => {
  assert.equal(offlineHinweis(lage({ zustand: 'connecting' })), 'verbindet');
  assert.equal(offlineHinweis(lage({ zustand: 'closed' })), 'offline');
  assert.equal(offlineHinweis(lage({ zustand: 'idle' })), 'offline');
});

test('verbindet zaehlt erst nach der Geduld — sonst blitzt es beim Reconnect', () => {
  assert.equal(offlineHinweis(lage({ zustand: 'connecting', seitMs: 500 })), 'keiner');
});

test('die Uhr zaehlt den Abriss, nicht den Zustandswechsel', () => {
  // Rot steht seit 10 s, der Zustand springt auf `connecting`: weil `seitMs`
  // die ganze Abriss-Strecke misst, bleibt der Streifen stehen und wechselt
  // nur die Aussage. Mit einer Uhr am Zustandswechsel waere hier 'keiner'
  // herausgekommen — rot, dann nichts, dann gelb.
  assert.equal(offlineHinweis(lage({ zustand: 'connecting', seitMs: 10_000 })), 'verbindet');
});
