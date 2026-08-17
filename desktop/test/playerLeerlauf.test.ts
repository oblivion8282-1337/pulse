import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLeerlaufWacht, type Planen } from '../electron/player-leerlauf.ts';

/**
 * Ein Zeitgeber ohne Uhr: die geplante Funktion wird von Hand ausgeloest.
 * Damit prueft der Test die Entscheidung, nicht die Wartezeit — und laeuft
 * ohne `mock.timers` und ohne echte 30 Sekunden.
 */
function handWecker() {
  let geplant: (() => void) | null = null;
  let abbestellt = 0;
  const planen: Planen = (fn) => {
    geplant = fn;
    return () => {
      geplant = null;
      abbestellt += 1;
    };
  };
  return {
    planen,
    /** Laeuft die Frist gerade? */
    get laeuft(): boolean {
      return geplant !== null;
    },
    get abbestellt(): number {
      return abbestellt;
    },
    /** Die Frist ablaufen lassen. */
    ablaufen(): void {
      const fn = geplant;
      geplant = null;
      assert.ok(fn, 'es lief keine Frist');
      fn();
    },
  };
}

test('letztes Fenster zu — der Prozess wird beendet', () => {
  const w = handWecker();
  let beendet = 0;
  const wacht = createLeerlaufWacht(30_000, () => (beendet += 1), w.planen);

  wacht.geoeffnet(1);
  assert.equal(wacht.offen, 1);
  assert.equal(w.laeuft, false, 'mit offenem Fenster laeuft keine Frist');

  wacht.geschlossen(1);
  assert.equal(wacht.offen, 0);
  assert.equal(w.laeuft, true);
  assert.equal(beendet, 0, 'nicht sofort — erst nach der Frist');

  w.ablaufen();
  assert.equal(beendet, 1);
});

test('vorletztes Fenster zu — solange noch eines offen ist, passiert nichts', () => {
  const w = handWecker();
  let beendet = 0;
  const wacht = createLeerlaufWacht(30_000, () => (beendet += 1), w.planen);

  wacht.geoeffnet(1);
  wacht.geoeffnet(2);
  wacht.geschlossen(1);

  assert.equal(wacht.offen, 1);
  assert.equal(w.laeuft, false);
  assert.equal(beendet, 0);
});

test('innerhalb der Frist wieder auf — der Prozess bleibt', () => {
  const w = handWecker();
  let beendet = 0;
  const wacht = createLeerlaufWacht(30_000, () => (beendet += 1), w.planen);

  wacht.geoeffnet(1);
  wacht.geschlossen(1);
  assert.equal(w.laeuft, true);

  wacht.geoeffnet(2);
  assert.equal(w.laeuft, false, 'die Frist ist abbestellt');
  assert.equal(w.abbestellt, 1);
  assert.equal(beendet, 0);
});

test('eine Frist, die schon feuert, prueft noch einmal nach', () => {
  // Der Fall, den das Abbestellen nicht mehr erwischt: der Zeitgeber ist
  // bereits abgelaufen und wartet nur noch auf seinen Platz in der
  // Ereignisschlange, und genau dazwischen geht ein Fenster auf. Deshalb ein
  // Wecker, dessen Abbestellung wirkungslos ist.
  let geplant: (() => void) | null = null;
  const taub: Planen = (fn) => {
    geplant = fn;
    return () => undefined;
  };
  let beendet = 0;
  const wacht = createLeerlaufWacht(30_000, () => (beendet += 1), taub);

  wacht.geoeffnet(1);
  wacht.geschlossen(1);
  wacht.geoeffnet(2);
  assert.ok(geplant, 'die Frist war geplant');
  geplant();

  assert.equal(beendet, 0, 'mit einem offenen Fenster wird nicht beendet');
  assert.equal(wacht.offen, 1);
});

test('dieselbe Nummer zweimal geschlossen stoesst die Frist nicht erneut an', () => {
  // Kommt im Betrieb vor: die App schliesst (`close`-Op) und der Player meldet
  // zusaetzlich `player:state closed`. Ohne die Pruefung beendete die zweite
  // Meldung den Prozess, obwohl noch ein anderes Fenster offen ist.
  const w = handWecker();
  let beendet = 0;
  const wacht = createLeerlaufWacht(30_000, () => (beendet += 1), w.planen);

  wacht.geoeffnet(1);
  wacht.geoeffnet(2);
  wacht.geschlossen(1);
  wacht.geschlossen(1);

  assert.equal(wacht.offen, 1);
  assert.equal(w.laeuft, false);
  assert.equal(beendet, 0);
});

test('zuruecksetzen laesst den Stand fallen und sagt die Frist ab', () => {
  const w = handWecker();
  let beendet = 0;
  const wacht = createLeerlaufWacht(30_000, () => (beendet += 1), w.planen);

  wacht.geoeffnet(1);
  wacht.geschlossen(1);
  assert.equal(w.laeuft, true);

  // Der Prozess ist gestuerzt: seine Fenster gibt es nicht mehr, und der
  // Nachfolger faengt bei null an.
  wacht.zuruecksetzen();
  assert.equal(wacht.offen, 0);
  assert.equal(w.laeuft, false);
  assert.equal(beendet, 0, 'ein gestuerzter Prozess wird nicht noch beendet');
});
