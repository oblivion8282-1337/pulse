/**
 * Die Gesten-Rechnung des PiP-Eckfensters (`src/lib/watch/eckfensterGesten.ts`).
 *
 * **Warum gerade diese Rechnung Tests verdient:** ihre Fehler sehen nicht wie
 * Fehler aus. Zählt ein Zusammenziehen fälschlich als Verschieben, ruckelt das
 * Fenster nur; zählt ein Verschieben als Zusammenziehen, springt es in der
 * Grösse. Beides liest sich als „Touch ist eben ungenau", nicht als falsche
 * Fallunterscheidung — und am Markup ist es gar nicht prüfbar.
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`. Das Modul hat
 * deshalb keinen Laufzeit-Import.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  abstand,
  eckeVon,
  einpassen,
  istDiagonale,
  skalieren,
  MARGIN,
  MIN_H,
  MIN_W
} from '../src/lib/watch/eckfensterGesten.ts';

const KASTEN = { left: 100, top: 100, right: 400, bottom: 300 };

describe('eckeVon', () => {
  it('erkennt alle vier Ecken', () => {
    assert.equal(eckeVon(KASTEN, 105, 105), 'ol');
    assert.equal(eckeVon(KASTEN, 395, 105), 'or');
    assert.equal(eckeVon(KASTEN, 105, 295), 'ul');
    assert.equal(eckeVon(KASTEN, 395, 295), 'ur');
  });

  it('die Mitte ist keine Ecke', () => {
    assert.equal(eckeVon(KASTEN, 250, 200), null);
  });

  it('eine Kantenmitte ist keine Ecke — nur eine der beiden Achsen passt', () => {
    assert.equal(eckeVon(KASTEN, 250, 105), null); // oben mittig
    assert.equal(eckeVon(KASTEN, 105, 200), null); // links mittig
  });
});

describe('istDiagonale', () => {
  it('gegenüberliegende Ecken bilden eine Diagonale', () => {
    assert.equal(istDiagonale('ol', 'ur'), true);
    assert.equal(istDiagonale('or', 'ul'), true);
  });

  it('zwei Ecken derselben Kante NICHT — das ist Verschieben, nicht Skalieren', () => {
    assert.equal(istDiagonale('ol', 'or'), false); // beide oben
    assert.equal(istDiagonale('ol', 'ul'), false); // beide links
  });

  it('dieselbe Ecke zweimal ist keine Diagonale', () => {
    assert.equal(istDiagonale('ol', 'ol'), false);
  });

  it('ein Griff ausserhalb jeder Ecke verhindert das Skalieren', () => {
    assert.equal(istDiagonale('ol', null), false);
    assert.equal(istDiagonale(null, null), false);
  });
});

describe('einpassen', () => {
  const FENSTER = { innerWidth: 1000, innerHeight: 800 };

  it('lässt eine Lage mitten im Bild unverändert', () => {
    assert.deepEqual(einpassen({ top: 300, left: 300 }, { w: 200, h: 150 }, FENSTER), {
      top: 300,
      left: 300
    });
  });

  it('zieht über den Rand hinaus zurück', () => {
    assert.deepEqual(einpassen({ top: -50, left: -50 }, { w: 200, h: 150 }, FENSTER), {
      top: MARGIN,
      left: MARGIN
    });
    assert.deepEqual(einpassen({ top: 9999, left: 9999 }, { w: 200, h: 150 }, FENSTER), {
      top: 800 - 150 - MARGIN,
      left: 1000 - 200 - MARGIN
    });
  });

  it('ein Fenster grösser als der Bildschirm klebt am Rand statt hinauszuwandern', () => {
    assert.deepEqual(einpassen({ top: 500, left: 500 }, { w: 2000, h: 2000 }, FENSTER), {
      top: MARGIN,
      left: MARGIN
    });
  });
});

describe('skalieren', () => {
  const FENSTER = { innerWidth: 1000, innerHeight: 800 };

  it('doppelter Fingerabstand verdoppelt die Grösse', () => {
    assert.deepEqual(skalieren({ w: 300, h: 200 }, 100, 200, FENSTER), { w: 600, h: 400 });
  });

  it('unter die Mindestgrösse geht es nicht', () => {
    const { w, h } = skalieren({ w: 300, h: 200 }, 100, 1, FENSTER);
    assert.equal(w, MIN_W);
    assert.equal(h, MIN_H);
  });

  it('über den Bildschirm hinaus auch nicht', () => {
    const { w, h } = skalieren({ w: 300, h: 200 }, 100, 100_000, FENSTER);
    assert.equal(w, 1000 - 2 * MARGIN);
    assert.equal(h, 800 - 2 * MARGIN);
  });

  it('zwei Finger exakt aufeinander teilen nicht durch null', () => {
    const { w, h } = skalieren({ w: 300, h: 200 }, 0, 0, FENSTER);
    assert.ok(Number.isFinite(w) && Number.isFinite(h));
  });
});

describe('abstand', () => {
  it('rechnet das Dreieck 3-4-5', () => {
    assert.equal(abstand({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  });
});
