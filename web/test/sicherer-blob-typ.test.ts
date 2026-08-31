import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sichererBlobTyp,
  NEUTRALER_TYP
} from '../src/lib/krypto/sichererBlobTyp.ts';

test('harmlose Typen bleiben unveraendert', () => {
  assert.equal(sichererBlobTyp('image/png'), 'image/png');
  assert.equal(sichererBlobTyp('application/pdf'), 'application/pdf');
  assert.equal(sichererBlobTyp('video/mp4'), 'video/mp4');
  assert.equal(sichererBlobTyp('text/plain'), 'text/plain');
});

test('SVG bleibt absichtlich stehen — sie wird nur in ein <img> gegeben', () => {
  // Steht hier als Test und nicht nur als Kommentar, damit ein spaeterer
  // "sicherheitshalber mit auf die Liste" auffaellt und begruendet werden
  // muss: das Herunterstufen wuerde die Vorschau kaputtmachen.
  assert.equal(sichererBlobTyp('image/svg+xml'), 'image/svg+xml');
});

test('was ein Browser als Dokument ausfuehren wuerde, wird heruntergestuft', () => {
  assert.equal(sichererBlobTyp('text/html'), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp('application/xhtml+xml'), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp('text/xml'), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp('application/xml'), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp('text/xsl'), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp('application/xslt+xml'), NEUTRALER_TYP);
});

test('Parameter und Grossschreibung heben die Liste nicht aus', () => {
  // Genau daran scheitern solche Listen ueblicherweise: `text/html` steht
  // drauf, `TEXT/HTML; charset=utf-8` rutscht durch.
  assert.equal(sichererBlobTyp('text/html; charset=utf-8'), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp('TEXT/HTML'), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp('  Text/Html ;charset=utf-8'), NEUTRALER_TYP);
});

test('leer, null und undefined ergeben den neutralen Typ', () => {
  assert.equal(sichererBlobTyp(''), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp('   '), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp(null), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp(undefined), NEUTRALER_TYP);
  assert.equal(sichererBlobTyp(';charset=utf-8'), NEUTRALER_TYP);
});
