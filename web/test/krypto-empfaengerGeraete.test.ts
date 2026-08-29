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
    signatur: 'sig',
    einmalschluessel: 'einmal',
    rueckfallschluessel: null,
    dauerhaft
  };
}

test('die eigenen anderen Geraete sind dabei, das eigene nicht (beide Konten dauerhaft)', () => {
  // Ohne die eigenen anderen Geraete sieht der eigene Desktop nie, was vom
  // Handy geschrieben wurde — und das faellt erst auf, wenn jemand zwei
  // Geraete benutzt. Das EIGENE Geraet gehoert nicht dazu: es hat den
  // Klartext bereits, und eine Sitzung mit sich selbst gibt es nicht.
  const buendel = {
    empfaenger: [geraet('empf-1'), geraet('empf-2')],
    ich: [geraet('mein-handy'), geraet('mein-desktop')]
  };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy', true);

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
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy', true);
  assert.deepEqual(ziel, []);
});

test('beide Konten ohne Geraete ergibt eine leere Liste, kein Fehler', () => {
  const ziel = zielgeraeteBerechnen({}, 'ich', 'empfaenger', 'mein-handy', true);
  assert.deepEqual(ziel, []);
});

test('zwei Geraete des Empfaengers ergeben zwei Zielgeraete (beide dauerhaft)', () => {
  const buendel = { empfaenger: [geraet('a'), geraet('b')] };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy', true);
  assert.equal(ziel.length, 2);
});

// --- Koexistenz-Regel (Spec §3, Bughunt 2026-08-28 FIX 1) ------------------

test('Empfaenger ohne dauerhaftes Geraet -> keine Zielgeraete, obwohl Buendel existieren', () => {
  // Ein Buendel allein reicht nicht mehr: das einzige Empfaenger-Geraet ist
  // ein Browser (nicht dauerhaft) -> bleibt beim Klartext-Weg.
  const buendel = {
    empfaenger: [geraet('empf-browser', false)],
    ich: [geraet('mein-desktop', true)]
  };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy', true);
  assert.deepEqual(ziel, []);
});

test('eigenes Konto ohne dauerhaftes Geraet -> keine Zielgeraete, auch bei dauerhaftem Empfaenger', () => {
  // Das AKTUELLE Geraet ist ein Browser (eigenesGeraetDauerhaft=false), und
  // es gibt kein anderes eigenes Geraet, das dauerhaft waere.
  const buendel = {
    empfaenger: [geraet('empf-desktop', true)],
    ich: [geraet('mein-anderer-browser', false)]
  };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy', false);
  assert.deepEqual(ziel, []);
});

test('eigenes AKTUELLES Geraet ist dauerhaft -> traegt die Kontodauerhaftigkeit allein', () => {
  // `eigenesGeraetDauerhaft=true` kommt vom aktuellen Geraet, das selbst NIE
  // im Buendel steht (wird beim Faechern ausgeschlossen) — ohne den Parameter
  // saehe die Rechnung das eigene Konto faelschlich als nicht dauerhaft an.
  const buendel = { empfaenger: [geraet('empf-desktop', true)] };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-electron', true);
  assert.equal(ziel.length, 1);
});

test('ein einzelnes dauerhaftes Geraet unter mehreren reicht fuer das Konto', () => {
  const buendel = {
    empfaenger: [geraet('empf-browser', false), geraet('empf-electron', true)],
    ich: [geraet('mein-desktop', true)]
  };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy', true);
  // BEIDE Empfaenger-Geraete werden adressiert (auch der Browser) — die
  // Regel entscheidet nur, OB ueberhaupt verschluesselt wird, nicht WELCHE
  // Geraete danach beliefert werden.
  const pubkeys = ziel.map((z) => z.geraet.device_pubkey).sort();
  assert.deepEqual(pubkeys, ['empf-browser', 'empf-electron', 'mein-desktop']);
});

test('fehlendes `dauerhaft`-Feld gilt als NICHT dauerhaft (fail closed)', () => {
  const alteAntwort: GeraeteBuendelEintrag = {
    device_pubkey: 'empf-alt',
    curve25519: 'curve',
    signatur: 'sig',
    einmalschluessel: 'einmal',
    rueckfallschluessel: null
    // kein `dauerhaft` — aeltere/unwissende Serverantwort.
  };
  const buendel = { empfaenger: [alteAntwort] };
  const ziel = zielgeraeteBerechnen(buendel, 'ich', 'empfaenger', 'mein-handy', true);
  assert.deepEqual(ziel, []);
});

test('ein gekoppelter Browser zaehlt wie eine App', () => {
  // Spec §3a, Punkt 2. Ohne diesen Fall verweigerte der Sendeweg genau die
  // Nachricht, die `GET /keys/verschluesselbar` gerade zugesagt hat: der
  // Server zaehlt einen gekoppelten Browser mit, diese Rechnung nicht.
  const ziel = zielgeraeteBerechnen(
    {
      ich: [{ ...geraet('mein-browser', false), gekoppelt: true }],
      du: [{ ...geraet('ihr-browser', false), gekoppelt: true }]
    },
    'ich',
    'du',
    'mein-browser',
    false
  );
  assert.deepEqual(
    ziel.map((z) => z.geraet.device_pubkey),
    ['ihr-browser']
  );
});

test('ein loser Browser-Tab zaehlt weiterhin nicht', () => {
  const ziel = zielgeraeteBerechnen(
    {
      ich: [geraet('mein-tab', false)],
      du: [geraet('ihr-tab', false)]
    },
    'ich',
    'du',
    'mein-tab',
    false
  );
  assert.deepEqual(ziel, []);
});
