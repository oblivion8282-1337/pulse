import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  geraeteArt,
  istDiesesGeraet,
  kennungKurz,
  letztesTeilnahmefaehiges
} from '../src/lib/krypto/geraeteAnzeige.ts';

const zeile = (
  device_pubkey: string,
  extra: Partial<{ dauerhaft: boolean; gekoppelt_am: string | null; verfallen: boolean }> = {}
) => ({
  device_pubkey,
  dauerhaft: false,
  gekoppelt_am: null,
  verfallen: false,
  ...extra
});

test('die Art unterscheidet App, gekoppelten Browser und losen Tab', () => {
  assert.equal(geraeteArt(zeile('a', { dauerhaft: true })), 'app');
  assert.equal(geraeteArt(zeile('b', { gekoppelt_am: '2026-08-01T00:00:00Z' })), 'gekoppelt');
  assert.equal(geraeteArt(zeile('c')), 'browser');
});

test('dauerhaft schlaegt gekoppelt', () => {
  // Eine App, die zusaetzlich einmal gekoppelt wurde, bleibt eine App — nur
  // `dauerhaft` entscheidet ueber den Verfall, und die Anzeige darf davon
  // nicht abweichen.
  assert.equal(
    geraeteArt(zeile('a', { dauerhaft: true, gekoppelt_am: '2026-08-01T00:00:00Z' })),
    'app'
  );
});

test('die Kurzkennung ist stabil und in Vierergruppen', () => {
  assert.equal(kennungKurz('abcdefghijklmnopqrstuvwxyz'), 'abcd efgh ijkl');
  // Zweimal dasselbe ergibt dasselbe — sonst taugt sie nicht zum Vergleich
  // von Bildschirm zu Bildschirm.
  assert.equal(kennungKurz('abcdefghijkl'), kennungKurz('abcdefghijkl'));
});

test('eine zu kurze Kennung wird nicht aufgefuellt', () => {
  // Eine erfundene Stelle waere schlimmer als eine fehlende: der Vergleich
  // fiele dann falsch aus statt gar nicht.
  assert.equal(kennungKurz('abcde'), 'abcd e');
  assert.equal(kennungKurz(''), '');
});

test('ohne bekannte eigene Kennung wird KEINE Zeile markiert', () => {
  // Eine falsch markierte Zeile waere schlimmer als gar keine: der Nutzer
  // entfernte dann sein eigenes Geraet im Glauben, es sei ein fremdes.
  assert.equal(istDiesesGeraet('abc', null), false);
  assert.equal(istDiesesGeraet('abc', 'abc'), true);
  assert.equal(istDiesesGeraet('abc', 'abd'), false);
});

test('die Warnung „letztes Geraet" zaehlt nur teilnahmefaehige', () => {
  const app = zeile('app', { dauerhaft: true });
  const tab = zeile('tab');
  const alt = zeile('alt', { gekoppelt_am: '2026-08-01T00:00:00Z', verfallen: true });

  // Ein loser Tab und ein verfallener Browser koennen beide nichts
  // empfangen — beruhigten sie hier, bliebe die Warnung gerade dort aus, wo
  // sie noetig ist.
  assert.equal(letztesTeilnahmefaehiges([app, tab, alt], 'app'), true);
  assert.equal(letztesTeilnahmefaehiges([app, tab, alt], 'tab'), false);

  const zweite = zeile('zweite', { gekoppelt_am: '2026-08-20T00:00:00Z' });
  assert.equal(letztesTeilnahmefaehiges([app, zweite], 'app'), false);
});
