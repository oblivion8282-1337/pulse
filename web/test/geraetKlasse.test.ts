/**
 * Gegenprobe zur Geräteklassen-Rechnung (`src/lib/stores/geraetKlasse.ts`).
 *
 * Anlass (2026-09-04): die Oberfläche schaltete an der FENSTERBREITE zwischen
 * Mobile-, Tablet- und Desktop-Anordnung — ein schmal gezogenes Rechnerfenster
 * zeigte plötzlich das Handy-Layout, ein 868px-Fenster das Tablet-Layout. Die
 * Klasse haengt seither am GERAET (Desktop-App / Zeigertyp / kurze Kante).
 * Diese Tests sichern den Vertrag: die drei Klassen schliessen sich aus,
 * decken jeden Fall ab, und die Fensterbreite allein wechselt nie die Klasse.
 *
 * Ausgefuehrt mit Nodes eingebautem Testlaeufer: `pnpm test:unit`.
 * `geraetKlasse.ts` ist deshalb importfrei — die Web-Quellen importieren
 * erweiterungslos, was der Bundler aufloest und Node nicht.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { geraetKlasse, HANDY_KANTE } from '../src/lib/stores/geraetKlasse.ts';

describe('geraetKlasse', () => {
  it('Desktop-App ist immer desktop — egal welcher Zeiger oder whiches Fenster', () => {
    for (const zeigerGrob of [false, true]) {
      for (const kante of [320, 640, 767, 768, 1024, 2160]) {
        assert.equal(geraetKlasse(true, zeigerGrob, kante), 'desktop');
      }
    }
  });

  it('Maus-/Trackpad-Zeiger ist immer desktop — die Fensterbreite entscheidet nie', () => {
    for (const kante of [320, 500, 640, 767, 768, 867, 868, 1023, 1024, 2160]) {
      assert.equal(geraetKlasse(false, false, kante), 'desktop');
    }
  });

  it('Finger + kurze Kante unter der Schwelle ist handy — auch quer', () => {
    // Portrait 390×844 und Querformat 844×390: kurze Kante 390, beides handy.
    assert.equal(geraetKlasse(false, true, Math.min(390, 844)), 'handy');
    assert.equal(geraetKlasse(false, true, Math.min(844, 390)), 'handy');
    assert.equal(geraetKlasse(false, true, 320), 'handy');
    assert.equal(geraetKlasse(false, true, HANDY_KANTE - 1), 'handy');
  });

  it('Finger + kurze Kante ab der Schwelle ist tablet — auch quer', () => {
    assert.equal(geraetKlasse(false, true, Math.min(820, 1180)), 'tablet');
    assert.equal(geraetKlasse(false, true, Math.min(1180, 820)), 'tablet');
    assert.equal(geraetKlasse(false, true, HANDY_KANTE), 'tablet');
    assert.equal(geraetKlasse(false, true, 1024), 'tablet');
  });

  it('Die drei Klassen schliessen sich aus und decken jeden Fall ab (Partition)', () => {
    for (const electron of [false, true]) {
      for (const zeigerGrob of [false, true]) {
        for (const kante of [320, 500, 767, 768, 900, 1024, 1440]) {
          const klasse = geraetKlasse(electron, zeigerGrob, kante);
          assert.ok(['desktop', 'tablet', 'handy'].includes(klasse));
          // Genau eine Klasse — die Typen selbst erzwingen das; hier steht
          // die Gegenprobe als Wertvergleich.
          assert.ok(
            (klasse === 'desktop' ? 1 : 0) +
              (klasse === 'tablet' ? 1 : 0) +
              (klasse === 'handy' ? 1 : 0) ===
              1
          );
        }
      }
    }
  });
});
