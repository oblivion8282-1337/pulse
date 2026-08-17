/**
 * Nimmt die Prüfung des Zeigerbildes genau die Formen an, die der Sidecar
 * schickt?
 *
 * **Der Prüfstein kommt vom SENDER**, nicht von hier:
 * `streaming/zeigerbild-formen.json` hält die Formen fest, die
 * `bildfeld` im Sidecar erzeugt, und dieselbe Datei prüfen auch die beiden
 * Rust-Enden. Der Grund steht ausführlich in der Datei — kurz: am 2026-08-17
 * verlangte [`istBild`] vier Zahlenfelder, die die Kurzform gar nicht hat.
 * Beide Seiten hatten grüne Tests, weil keiner über die Sprachgrenze sah.
 *
 * Ein Test, der sich seine Beispiele selbst ausdenkt, hätte das **nicht**
 * gefangen: wer eine Prüfung testet, schreibt die Fälle aus derselben
 * Vorstellung auf, aus der er die Prüfung geschrieben hat. Die Kurzform wäre
 * darin nicht vorgekommen. Deshalb wird hier gegen fremdes Material geprüft.
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`. Das Modul
 * unter Prüfung importiert bewusst nichts — s. Kopf von
 * `src/lib/remote/zeigerbildPruefung.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { istBild } from '../src/lib/remote/zeigerbildPruefung.ts';

type Form = { _was: string; bild: unknown };

const pruefstein = JSON.parse(
  readFileSync(new URL('../../streaming/zeigerbild-formen.json', import.meta.url), 'utf8'),
) as { formen: Form[] };

describe('istBild gegen den Prüfstein des Senders', () => {
  it('kennt überhaupt Formen — eine leere Datei wäre ein grüner Test ohne Aussage', () => {
    assert.ok(Array.isArray(pruefstein.formen));
    assert.ok(pruefstein.formen.length >= 2, 'mindestens Kurz- und Vollform');
  });

  for (const form of pruefstein.formen) {
    it(`nimmt an: ${form._was.slice(0, 60)}…`, () => {
      assert.equal(istBild(form.bild), true);
    });
  }

  /**
   * Die Kurzform ausdrücklich beim Namen genannt. Der Durchlauf oben deckt sie
   * mit ab, aber wenn jemand sie aus dem Prüfstein entfernt, soll hier ein Test
   * fehlschlagen und nicht bloss einer verschwinden — ein weggefallener Test
   * sieht in der Ausgabe aus wie „alles grün".
   */
  it('nimmt die Kurzform an — nur die Kennung, keine Masse', () => {
    const kurz = pruefstein.formen.find((f) => {
      const b = f.bild as Record<string, unknown>;
      return b && b.daten === undefined;
    });
    assert.ok(kurz, 'der Prüfstein muss eine Kurzform enthalten');
    assert.equal(istBild(kurz.bild), true);
  });
});

describe('istBild ist fail-closed', () => {
  it('weist Fremdmaterial ab', () => {
    for (const schlecht of [
      null,
      undefined,
      42,
      'zeichenkette',
      [],
      {},
      { id: '' },
      { id: 123 },
      { id: 'a'.repeat(65) },
      // Daten ohne Masse — ein halbes Bild, das der Player verwerfen müsste
      { id: 'abc', daten: 'AAAA' },
      { id: 'abc', w: 2, daten: 'AAAA' },
      { id: 'abc', w: 2, h: 2, hx: 0, daten: 'AAAA' },
      // Masse, die keine sind
      { id: 'abc', w: -1, h: 2, hx: 0, hy: 0, daten: 'AAAA' },
      { id: 'abc', w: 1.5, h: 2, hx: 0, hy: 0, daten: 'AAAA' },
      { id: 'abc', w: Number.NaN, h: 2, hx: 0, hy: 0, daten: 'AAAA' },
      { id: 'abc', w: Number.POSITIVE_INFINITY, h: 2, hx: 0, hy: 0, daten: 'AAAA' },
      { id: 'abc', w: 70000, h: 2, hx: 0, hy: 0, daten: 'AAAA' },
      { id: 'abc', w: '2', h: 2, hx: 0, hy: 0, daten: 'AAAA' },
      // Daten, die keine sind
      { id: 'abc', w: 2, h: 2, hx: 0, hy: 0, daten: 123 },
      { id: 'abc', w: 2, h: 2, hx: 0, hy: 0, daten: 'A'.repeat(8193) },
    ]) {
      assert.equal(istBild(schlecht), false, JSON.stringify(schlecht));
    }
  });

  /**
   * Masse OHNE Daten sind erlaubt: der Sender schickt sie so nicht, aber sie
   * sind harmlos — der Player greift dann über die Kennung in seinen Vorrat und
   * sieht die Zahlen gar nicht an. Hier abzuweisen hiesse, eine künftige
   * Erweiterung des Senders zu brechen, ohne dafür etwas zu gewinnen.
   */
  it('lässt Masse ohne Daten durch — harmlos, der Player sieht sie nicht an', () => {
    assert.equal(istBild({ id: 'abc', w: 2, h: 2, hx: 0, hy: 0 }), true);
  });
});
