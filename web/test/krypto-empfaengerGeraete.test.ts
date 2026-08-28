import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  zielgeraeteBerechnen,
  type GeraeteBuendelEintrag
} from '../src/lib/krypto/empfaengerGeraete.ts';

function geraet(pubkey: string): GeraeteBuendelEintrag {
  return {
    device_pubkey: pubkey,
    curve25519: `curve-${pubkey}`,
    signatur: 'sig',
    einmalschluessel: 'einmal',
    rueckfallschluessel: null
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
  // Der Normalfall der Koexistenz-Regel, kein Fehler.
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
