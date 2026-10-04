/**
 * Die unterscheidbare Ablauf-Meldung (gerettete Idee, UEBERGABE-MOBILE §5).
 *
 * Kern ist die Ablese-Regel: 410 `anhang_abgelaufen` gilt, 410
 * `anhang_im_laufwerk` (Verweis aufs eigene Archiv, KEIN Fehler) und alles
 * andere nicht. Der erste Test ist die Gegenprobe zu einem echten Fehler:
 * `kopplung-einloesFehler.test.ts` dokumentiert dieselbe Falle — wer
 * `fehler.detail` statt `fehler.body.detail` liest, erkennt nie etwas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  istAnhangAbgelaufenFehler
} from '../src/lib/krypto/anhangAbgelaufen.ts';

/** Wie `ApiError` aus `api/client.ts` aussieht: Rumpf unter `body`. */
const apiFehler = (status: number, detail?: string) => ({
  status,
  body: detail === undefined ? undefined : { detail }
});

test('nur 410 mit detail anhang_abgelaufen gilt', () => {
  assert.ok(istAnhangAbgelaufenFehler(apiFehler(410, 'anhang_abgelaufen')));
});

test('die Laufwerk-410 ist KEIN Ablauf — sie bedeutet: im eigenen Archiv holen', () => {
  assert.ok(!istAnhangAbgelaufenFehler(apiFehler(410, 'anhang_im_laufwerk')));
});

test('generischer 404 und andere Status gelten nicht', () => {
  assert.ok(!istAnhangAbgelaufenFehler(apiFehler(404, 'anhang_nicht_gefunden')));
  assert.ok(!istAnhangAbgelaufenFehler(apiFehler(404)));
});

test('Grund steht unter body.detail, nicht direkt am Fehler', () => {
  // Die kaputte Fassung (detail am Fehler) darf NICHT gelten — sonst haette
  // der Test sie mit durchgewunken.
  assert.ok(!istAnhangAbgelaufenFehler({ status: 410, detail: 'anhang_abgelaufen' }));
});

test('Netzwerkfehler und Unsinn gelten nicht statt zu werfen', () => {
  assert.ok(!istAnhangAbgelaufenFehler(new Error('offline')));
  assert.ok(!istAnhangAbgelaufenFehler(null));
  assert.ok(!istAnhangAbgelaufenFehler(undefined));
});

test('der durchgereichte 410-ApiError erfüllt das Prädikat', () => {
  const fehler = apiFehler(410, 'anhang_abgelaufen');
  assert.ok(istAnhangAbgelaufenFehler(fehler));
  assert.ok(!istAnhangAbgelaufenFehler({ status: 410 }));
});
