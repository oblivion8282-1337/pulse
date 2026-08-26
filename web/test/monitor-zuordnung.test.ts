/**
 * Welcher Bildschirm zu welchem Stream-Platz gehört.
 *
 * Anlass: ein Nutzer meldete am 2026-08-26, dass Pulse nach der Bildschirm-
 * sperre „die Bildschirme durcheinanderbringt" — zweimal derselbe, einer fehlt.
 * Die Zuordnung war bis dahin ungetestet.
 *
 * Die Wurzel ist damit NICHT behoben: eine Bildschirm-Nummer ist die Position
 * in der Aufzählung des Betriebssystems, und wenn ein Bildschirm herausfällt,
 * rücken die dahinterliegenden auf. Was hier geprüft wird, ist der Teil, den
 * Pulse selbst in der Hand hat — dass eine gemerkte Wahl das Verschwinden
 * überlebt und ein Rückfall nicht stumm bleibt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  nummerAus,
  quelleFuerStart,
  reihenfolge,
  vorgabeFuerPlatz,
  wahlBleibt,
} from '../src/lib/stream/monitorZuordnung.ts';

const DREI = [{ index: 1 }, { index: 2, primary: true }, { index: 3 }];

describe('reihenfolge', () => {
  test('stellt den Hauptbildschirm nach vorn', () => {
    assert.deepEqual(
      reihenfolge(DREI).map((s) => s.index),
      [2, 1, 3]
    );
  });

  test('nimmt ohne Hauptkennzeichnung den ersten', () => {
    assert.deepEqual(
      reihenfolge([{ index: 5 }, { index: 6 }]).map((s) => s.index),
      [5, 6]
    );
  });

  test('kommt mit einer leeren Liste zurecht', () => {
    assert.deepEqual(reihenfolge([]), []);
  });
});

describe('vorgabeFuerPlatz', () => {
  test('gibt jedem Platz einen eigenen Bildschirm', () => {
    assert.equal(vorgabeFuerPlatz(0, DREI), 'Monitor: 2');
    assert.equal(vorgabeFuerPlatz(1, DREI), 'Monitor: 1');
    assert.equal(vorgabeFuerPlatz(2, DREI), 'Monitor: 3');
  });

  test('verteilt reihum, wenn es mehr Plätze als Bildschirme gibt', () => {
    assert.equal(vorgabeFuerPlatz(3, DREI), 'Monitor: 2');
  });

  test('bleibt ohne Bildschirme beim Portal-Wert', () => {
    assert.equal(vorgabeFuerPlatz(0, []), 'portal');
  });
});

describe('wahlBleibt — eine gemerkte Wahl darf nicht verlorengehen', () => {
  test('eine Bildschirm-Wahl bleibt, auch wenn der Bildschirm gerade fehlt', () => {
    // Der Kern der Meldung: die Liste ist beim Aufwachen aus der Sperre
    // unvollständig. Wer hier verwirft, verliert die Wahl endgültig.
    assert.equal(wahlBleibt('Monitor: 3'), true);
  });

  test('der Portal-Wert bleibt', () => {
    assert.equal(wahlBleibt('portal'), true);
  });

  test('eine Fenster-Wahl darf verfallen', () => {
    // Ein geschlossenes Fenster kommt nicht wieder — seine Kennung wird neu
    // vergeben und zeigte sonst irgendwann auf ein fremdes Fenster.
    assert.equal(wahlBleibt('window:4711'), false);
  });
});

describe('quelleFuerStart — Rückfall ohne die Wahl zu verlieren', () => {
  test('nimmt die gewählte Quelle, wenn ihr Bildschirm da ist', () => {
    assert.deepEqual(quelleFuerStart('Monitor: 3', 0, DREI, []), {
      quelle: 'Monitor: 3',
      ausweichend: false,
    });
  });

  test('weicht aus, wenn der gewählte Bildschirm gerade fehlt', () => {
    const nur_zwei = [{ index: 1 }, { index: 2, primary: true }];
    assert.deepEqual(quelleFuerStart('Monitor: 3', 0, nur_zwei, []), {
      quelle: 'Monitor: 2',
      ausweichend: true,
    });
  });

  test('sagt den Rückfall an, statt ihn stumm zu tun', () => {
    // Ohne dieses Kennzeichen sieht der Nutzer einen fremden Bildschirm und
    // hält es für einen Fehler von Pulse. Genau so wurde es gemeldet.
    assert.equal(quelleFuerStart('Monitor: 9', 1, DREI, []).ausweichend, true);
  });

  test('hält eine noch offene Fenster-Wahl', () => {
    assert.deepEqual(quelleFuerStart('window:42', 0, DREI, [42]), {
      quelle: 'window:42',
      ausweichend: false,
    });
  });

  test('weicht bei geschlossenem Fenster auf einen Bildschirm aus', () => {
    assert.deepEqual(quelleFuerStart('window:42', 0, DREI, [7]), {
      quelle: 'Monitor: 2',
      ausweichend: true,
    });
  });

  test('behauptet ohne Bildschirmliste gar nichts', () => {
    // Direkt nach dem Öffnen des Dialogs ist die Liste noch leer, weil der
    // Sidecar nicht geantwortet hat. „Es fehlt etwas" ist dann keine
    // Feststellung, sondern Unwissen — und eine Warnung aus Unwissen ist
    // Rauschen. Der Nutzer sah dabei den rohen Wert „portal" als Ersatznamen.
    assert.deepEqual(quelleFuerStart('Monitor: 2', 0, [], []), {
      quelle: 'portal',
      ausweichend: false,
    });
  });

  test('lässt den Portal-Wert in Ruhe', () => {
    // Linux wählt beim Start im Portal-Dialog; hier gibt es nichts aufzulösen.
    assert.deepEqual(quelleFuerStart('portal', 0, [], []), {
      quelle: 'portal',
      ausweichend: false,
    });
  });
});

describe('nummerAus', () => {
  test('liest die Nummer einer Bildschirm-Quelle', () => {
    assert.equal(nummerAus('Monitor: 12'), 12);
  });

  test('gibt für alles andere undefined', () => {
    for (const quelle of ['portal', 'window:3', 'Monitor: ', 'Monitor: x', '']) {
      assert.equal(nummerAus(quelle), undefined, quelle);
    }
  });
});
