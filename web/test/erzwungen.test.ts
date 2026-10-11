import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { erzwungenAus, gleichErzwungen } from '../src/lib/voice/erzwungen.ts';

// Admin-Stumm-/Taubschaltung fuer die native Kanalansicht (voice/erzwungen.ts).

test('kein Override im Kanal: zwei leere Listen', () => {
  assert.deepEqual(erzwungenAus(undefined), { stumm: [], taub: [] });
  assert.deepEqual(erzwungenAus({}), { stumm: [], taub: [] });
});

test('stumm und taub getrennt, beides fuer denselben Nutzer moeglich', () => {
  assert.deepEqual(
    erzwungenAus({
      '30': { muted: true, deafened: false },
      '10': { muted: true, deafened: true },
      '20': { muted: false, deafened: true }
    }),
    { stumm: ['10', '30'], taub: ['10', '20'] }
  );
});

test('ein Eintrag mit beidem false zaehlt nicht mit', () => {
  // Der Store raeumt solche Eintraege ab (`applyOverride`); die Rechnung
  // verlaesst sich nicht darauf.
  assert.deepEqual(erzwungenAus({ '10': { muted: false, deafened: false } }), {
    stumm: [],
    taub: []
  });
});

test('gleich: unabhaengig von der Ankunftsreihenfolge, null ist nie gleich', () => {
  const a = erzwungenAus({ '1': { muted: true, deafened: false }, '2': { muted: true, deafened: false } });
  const b = erzwungenAus({ '2': { muted: true, deafened: false }, '1': { muted: true, deafened: false } });
  assert.equal(gleichErzwungen(a, b), true);
  assert.equal(gleichErzwungen(null, { stumm: [], taub: [] }), false);
  assert.equal(gleichErzwungen(a, { stumm: a.stumm, taub: ['1'] }), false);
  // Ein Komma in der Kennung gibt es nicht (Snowflakes) — die Listen
  // ['1,2'] und ['1','2'] kommen nie zusammen vor.
});
