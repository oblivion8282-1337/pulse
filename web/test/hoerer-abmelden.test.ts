import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { abmelder, type HoererGriff } from '../src/lib/platform/hoererAbmelden.ts';

// Der Abmelder fuer Capacitor-Hoerer (platform/hoererAbmelden.ts). Anlass:
// `iosAudioSession.ts` rief `griff.then(…)`, aber das rohe Plugin-Objekt der
// iOS-Huelle liefert den Griff SOFORT (native-bridge.js, `cap.addListener`).

/** Ein Griff in der Form, die `native-bridge.js` zurueckgibt: `remove` ist
 *  `async`, der Griff selbst ist kein Promise. */
function brueckenGriff(): { griff: HoererGriff; abgemeldet: () => number } {
  let n = 0;
  return {
    griff: {
      remove: async () => {
        n += 1;
      }
    },
    abgemeldet: () => n
  };
}

const ruhe = () => new Promise((fertig) => setImmediate(fertig));

test('Gegenprobe: der alte Abmelder wirft am Griff der Bruecke', () => {
  const { griff } = brueckenGriff();
  // Genau die Zeile, die bis zum 2026-10-11 in iosAudioSession.ts stand.
  const alt = () =>
    void (griff as unknown as Promise<HoererGriff>).then((h) => h.remove()).catch(() => undefined);
  assert.throws(alt, TypeError);
});

test('Griff der Bruecke (kein Promise): wird abgemeldet', async () => {
  const { griff, abgemeldet } = brueckenGriff();
  abmelder(griff)();
  await ruhe();
  assert.equal(abgemeldet(), 1);
});

test('Promise auf den Griff (registerPlugin): wird abgemeldet', async () => {
  const { griff, abgemeldet } = brueckenGriff();
  abmelder(Promise.resolve(griff))();
  await ruhe();
  assert.equal(abgemeldet(), 1);
});

test('wirft nie — weder bei abgelehnter Anmeldung noch bei scheiterndem remove', async () => {
  const abgelehnt = Promise.reject(new Error('nicht angemeldet'));
  abgelehnt.catch(() => undefined);
  assert.doesNotThrow(abmelder(abgelehnt));
  assert.doesNotThrow(
    abmelder({
      remove: () => {
        throw new Error('weg');
      }
    })
  );
  assert.doesNotThrow(abmelder({ remove: () => Promise.reject(new Error('weg')) }));
  // Eine unbehandelte Ablehnung liesse den Laeufer hier rot werden.
  await ruhe();
});
