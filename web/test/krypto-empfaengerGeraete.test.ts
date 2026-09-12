import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zielgeraeteBerechnen,
  type GeraeteBuendelEintrag
} from '../src/lib/krypto/empfaengerGeraete.ts';

function geraet(pubkey: string, dauerhaft = true): GeraeteBuendelEintrag {
  return {
    device_pubkey: pubkey,
    curve25519: `curve-${pubkey}`,
    einmalschluessel: 'einmal',
    rueckfallschluessel: null,
    dauerhaft
  };
}

test('die eigenen anderen Geraete sind dabei, das eigene nicht', () => {
  // Ohne die eigenen anderen Geraete sieht der eigene Desktop nie, was vom
  // Handy geschrieben wurde — und das faellt erst auf, wenn jemand zwei
  // Geraete benutzt. Das EIGENE Geraet gehoert nicht dazu: es hat den
  // Klartext bereits, und eine Sitzung mit sich selbst gibt es nicht.
  const buendel = {
    empfaenger: [geraet('empf-1'), geraet('empf-2')],
    ich: [geraet('mein-handy'), geraet('mein-desktop')]
  };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy');

  const pubkeys = ziel.map((z) => z.geraet.device_pubkey).sort();
  assert.deepEqual(pubkeys, ['empf-1', 'empf-2', 'mein-desktop']);
  assert.ok(!pubkeys.includes('mein-handy'), 'das eigene aktuelle Geraet darf nicht dabei sein');

  // Konto-Zuordnung stimmt — wichtig fuer die spaetere Empfaenger-Liste im
  // Umschlag.
  const meinDesktop = ziel.find((z) => z.geraet.device_pubkey === 'mein-desktop');
  assert.equal(meinDesktop?.userId, 'ich');
  const empf1 = ziel.find((z) => z.geraet.device_pubkey === 'empf-1');
  assert.equal(empf1?.userId, 'empfaenger');
});

test('ein Konto ganz ohne Geraete ergibt keine Empfaenger', () => {
  // Kein Fehler — der Aufrufer meldet `unverschluesselt` sichtbar.
  const buendel = { ich: [geraet('mein-handy')] };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy');
  assert.deepEqual(ziel, []);
});

test('beide Konten ohne Geraete ergibt eine leere Liste, kein Fehler', () => {
  const ziel = zielgeraeteBerechnen({}, 'ich', 'empfaenger', 'mein-handy');
  assert.deepEqual(ziel, []);
});

test('zwei Geraete des Empfaengers ergeben zwei Zielgeraete', () => {
  const buendel = { empfaenger: [geraet('a'), geraet('b')] };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy');
  assert.equal(ziel.length, 2);
});

// --- Aufhebung der Koexistenz-Regel (2026-09-12) ----------------------------
// Ein Buendel allein reicht SEITDEM: auch Konten ohne haltbares Geraet
// (reiner Browser-Tab) senden und empfangen. Der Datenverlust-Schutz der
// Regel lebt als Warnhinweis weiter (`dmBrowserWarnung.ts`), nicht als
// Sendesperre.

test('Empfaenger mit nur einem Browser-Geraet wird beliefert', () => {
  const buendel = {
    empfaenger: [geraet('empf-browser', false)],
    ich: [geraet('mein-desktop', true)]
  };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-desktop');
  assert.deepEqual(
    ziel.map((z) => z.geraet.device_pubkey),
    ['empf-browser']
  );
});

test('Browser gegen Browser: beide Konten nur lose Tabs, trotzdem Zielgeraete', () => {
  const ziel = zielgeraeteBerechnen(
    {
      ich: [geraet('mein-tab', false)],
      du: [geraet('ihr-tab', false)]
    },
    'ich',
    'du',
    'mein-tab'
  );
  assert.deepEqual(
    ziel.map((z) => z.geraet.device_pubkey),
    ['ihr-tab']
  );
});

test('absendender Browser beliefert auch den eigenen Desktop', () => {
  // Der Absender sitzt im Browser, hat aber noch eine App: die Nachricht
  // muss auch das eigene andere Geraet erreichen (Multi-Geraet-Sync).
  const ziel = zielgeraeteBerechnen(
    {
      ich: [geraet('mein-desktop', true)],
      du: [geraet('ihr-browser', false)]
    },
    'ich',
    'du',
    'mein-browser'
  );
  assert.deepEqual(
    ziel.map((z) => z.geraet.device_pubkey).sort(),
    ['ihr-browser', 'mein-desktop']
  );
});
