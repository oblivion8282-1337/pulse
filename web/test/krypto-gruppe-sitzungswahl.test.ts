import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sitzungWaehlen,
  wechselgrund,
  standNachSendung,
  VORGABE_GRENZEN,
  type Gruppenstand
} from '../src/lib/krypto/gruppe/sitzungswahl.ts';

/** Die echte Sitzung ist eine WASM-Klasse; hier zaehlt nur, WELCHES Objekt
 *  gewaehlt wurde — deshalb reicht eine Marke. Die Krypto selbst prueft
 *  `krypto-gruppe-wasm.test.ts` an der echten Kiste. */
let zaehler = 0;
function neueSitzung(): { sitzung: string; sitzungId: string } {
  zaehler += 1;
  return { sitzung: `sitzung-${zaehler}`, sitzungId: `id-${zaehler}` };
}

function stand(ueber: Partial<Gruppenstand<string>> = {}): Gruppenstand<string> {
  return {
    sitzungId: 'id-alt',
    sitzung: 'sitzung-alt',
    mitglieder: ['anna', 'bert'],
    beliefert: ['geraet-anna', 'geraet-bert'],
    nachrichten: 1,
    angelegtAm: 1_000,
    ...ueber
  };
}

test('ohne vorhandene Sitzung entsteht eine neue, und jedes Geraet braucht den Schluessel', () => {
  const wahl = sitzungWaehlen(null, ['anna', 'bert'], ['g1', 'g2'], neueSitzung, 5_000);
  assert.equal(wahl.grund, 'keine');
  assert.deepEqual(wahl.nachzuliefern, ['g1', 'g2']);
  assert.deepEqual(wahl.stand.mitglieder, ['anna', 'bert']);
  assert.equal(wahl.stand.nachrichten, 0);
  assert.equal(wahl.stand.angelegtAm, 5_000);
});

test('gleicher Mitgliederstand -> dieselbe Sitzung laeuft weiter', () => {
  const wahl = sitzungWaehlen(
    stand(),
    // Andere Reihenfolge, gleiche Menge — verglichen wird als Menge.
    ['bert', 'anna'],
    ['geraet-anna', 'geraet-bert'],
    neueSitzung,
    5_000
  );
  assert.equal(wahl.grund, null);
  assert.equal(wahl.stand.sitzung, 'sitzung-alt');
  assert.deepEqual(wahl.nachzuliefern, []);
});

test('ein Abgang erzwingt eine neue Sitzung', () => {
  const wahl = sitzungWaehlen(stand(), ['anna'], ['geraet-anna'], neueSitzung, 5_000);
  assert.equal(wahl.grund, 'mitgliederwechsel');
  assert.notEqual(wahl.stand.sitzung, 'sitzung-alt');
  // Auch die BEREITS belieferten Geraete brauchen den neuen Schluessel.
  assert.deepEqual(wahl.nachzuliefern, ['geraet-anna']);
  assert.deepEqual(wahl.stand.beliefert, []);
});

test('ein Zugang erzwingt ebenfalls eine neue Sitzung', () => {
  const wahl = sitzungWaehlen(
    stand(),
    ['anna', 'bert', 'cara'],
    ['geraet-anna', 'geraet-bert', 'geraet-cara'],
    neueSitzung,
    5_000
  );
  assert.equal(wahl.grund, 'mitgliederwechsel');
  assert.deepEqual(wahl.nachzuliefern, ['geraet-anna', 'geraet-bert', 'geraet-cara']);
});

test('ein neues Geraet eines bestehenden Mitglieds wird nur nachbeliefert', () => {
  const wahl = sitzungWaehlen(
    stand(),
    ['anna', 'bert'],
    ['geraet-anna', 'geraet-bert', 'geraet-bert-zweit'],
    neueSitzung,
    5_000
  );
  assert.equal(wahl.grund, null);
  assert.deepEqual(wahl.nachzuliefern, ['geraet-bert-zweit']);
});

test('ein weggefallenes Geraet ist kein Grund fuer irgendetwas', () => {
  // Ein abgemeldetes Geraet verschwindet aus dem Buendel. Die Person bleibt
  // Mitglied — die Sitzung laeuft weiter, es ist nur nichts nachzuliefern.
  const wahl = sitzungWaehlen(stand(), ['anna', 'bert'], ['geraet-anna'], neueSitzung, 5_000);
  assert.equal(wahl.grund, null);
  assert.deepEqual(wahl.nachzuliefern, []);
});

test('die Nachrichtenzahl wechselt die Sitzung', () => {
  const voll = stand({ nachrichten: VORGABE_GRENZEN.hoechstzahlNachrichten });
  assert.equal(wechselgrund(voll, ['anna', 'bert'], 5_000), 'anzahl');
  const knapp = stand({ nachrichten: VORGABE_GRENZEN.hoechstzahlNachrichten - 1 });
  assert.equal(wechselgrund(knapp, ['anna', 'bert'], 5_000), null);
});

test('das Alter wechselt die Sitzung', () => {
  const alt = stand({ angelegtAm: 0 });
  assert.equal(wechselgrund(alt, ['anna', 'bert'], VORGABE_GRENZEN.hoechstalterMs), 'alter');
  assert.equal(wechselgrund(alt, ['anna', 'bert'], VORGABE_GRENZEN.hoechstalterMs - 1), null);
});

test('der Mitgliederwechsel schlaegt jeden anderen Grund', () => {
  // Reihenfolge der Pruefung ist keine Kosmetik: der Grund wandert in die
  // Diagnose, und „anzahl" statt „mitgliederwechsel" liesse eine Aussperrung
  // wie eine turnusmaessige Rotation aussehen.
  const alt = stand({ angelegtAm: 0, nachrichten: 999 });
  assert.equal(wechselgrund(alt, ['anna'], 10 ** 12), 'mitgliederwechsel');
});

test('standNachSendung zaehlt mit und legt Belieferungen zusammen, ohne Duplikate', () => {
  const neu = standNachSendung(stand(), ['geraet-bert', 'geraet-cara']);
  assert.equal(neu.nachrichten, 2);
  assert.deepEqual(neu.beliefert, ['geraet-anna', 'geraet-bert', 'geraet-cara']);
  // Die Vorlage bleibt unberuehrt — der Aufrufer sichert erst danach.
  assert.equal(stand().nachrichten, 1);
});
