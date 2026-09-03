import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gruppengeraeteBerechnen,
  gruppenUmschlaegeBauen,
  inBloecke,
  inEmpfaengerBloecke,
  MAX_UMSCHLAEGE_JE_ANFRAGE,
  type GruppenBuendelEintrag
} from '../src/lib/krypto/gruppe/gruppengeraete.ts';

function geraet(pubkey: string, dauerhaft = true): GruppenBuendelEintrag {
  return {
    device_pubkey: pubkey,
    curve25519: `curve-${pubkey}`,
    einmalschluessel: 'einmal',
    rueckfallschluessel: null,
    dauerhaft
  };
}

test('jedes Geraet jedes Mitglieds, ausser dem eigenen aktuellen', () => {
  const ziel = gruppengeraeteBerechnen(
    {
      anna: [geraet('anna-hier'), geraet('anna-handy')],
      bert: [geraet('bert-1')],
      cara: [geraet('cara-1'), geraet('cara-2')]
    },
    ['anna', 'bert', 'cara'],
    'anna',
    'anna-hier'
  );
  assert.deepEqual(
    ziel.map((z) => z.geraet.device_pubkey),
    ['anna-handy', 'bert-1', 'cara-1', 'cara-2']
  );
  // Das Konto faehrt mit, damit die Aufrufstelle „eigenes anderes Geraet"
  // von „fremdes Geraet" unterscheiden kann.
  assert.equal(ziel[0].userId, 'anna');
  assert.equal(ziel[1].userId, 'bert');
});

test('ein Mitglied ohne Geraete haelt nichts auf', () => {
  const ziel = gruppengeraeteBerechnen(
    { anna: [geraet('anna-hier')], bert: [geraet('bert-1')] },
    ['anna', 'bert', 'ohne-geraet'],
    'anna',
    'anna-hier'
  );
  assert.deepEqual(
    ziel.map((z) => z.geraet.device_pubkey),
    ['bert-1']
  );
});

test('ein Browser-Geraet wird NICHT ausgeschlossen', () => {
  // Anders als bei DMs gibt es keine Koexistenz-Regel: eine Gruppe hat
  // keinen Klartext-Weg, „nicht dauerhaft" heisst hier also nicht
  // „unverschluesselt", sondern „gar nicht" — und zwar fuer alle. Die
  // Spec loest das beim HINZUFUEGEN, nicht hier (s. Modulkopf).
  const ziel = gruppengeraeteBerechnen(
    { anna: [geraet('anna-hier')], bert: [geraet('bert-browser', false)] },
    ['anna', 'bert'],
    'anna',
    'anna-hier'
  );
  assert.deepEqual(
    ziel.map((z) => z.geraet.device_pubkey),
    ['bert-browser']
  );
});

test('Empfaenger werden auf Bloecke der Server-Grenze aufgeteilt', () => {
  // `PostfachNutzlastIn.empfaenger` ist bei 64 gedeckelt — und die Grenze
  // zaehlt GERAETE, nicht Mitglieder: 50 Mitglieder mit je zwei Geraeten
  // sprengen sie.
  const viele = Array.from({ length: 100 }, (_, i) => `g${i}`);
  const bloecke = inEmpfaengerBloecke(viele);
  assert.equal(bloecke.length, 2);
  assert.equal(bloecke[0].length, 64);
  assert.equal(bloecke[1].length, 36);
  assert.deepEqual(bloecke.flat(), viele);
});

test('genau die Grenze ergibt einen Block, kein leeres Anhaengsel', () => {
  assert.equal(inEmpfaengerBloecke(Array.from({ length: 64 }, (_, i) => `g${i}`)).length, 1);
  assert.deepEqual(inEmpfaengerBloecke([]), []);
});

test('Umschlaege werden auf Anfragen aufgeteilt, bevor der Server sie ablehnt', () => {
  // `postfach_max_nutzlasten_je_anfrage` (Vorgabe 100) kippt die GANZE
  // Anfrage mit 400 `zu_viele_nutzlasten`. Eine Verteilrunde erzeugt einen
  // Umschlag je Geraet — schon 35 Mitglieder zu je drei Geraeten reissen die
  // Grenze, und zwar ausgerechnet beim Schluesselwechsel.
  assert.ok(MAX_UMSCHLAEGE_JE_ANFRAGE < 100, 'muss unter der Server-Grenze liegen');
  const umschlaege = Array.from({ length: 105 }, (_, i) => ({ nr: i }));
  const anfragen = inBloecke(umschlaege, MAX_UMSCHLAEGE_JE_ANFRAGE);
  assert.equal(anfragen.length, 2);
  assert.ok(anfragen.every((a) => a.length <= MAX_UMSCHLAEGE_JE_ANFRAGE));
  assert.deepEqual(anfragen.flat(), umschlaege);
});

test('gruppenUmschlaegeBauen markiert JEDEN Umschlag fuers Archiv', () => {
  // Fixwelle 2 R6: markiert war frueher nur der erste Block (Befund I4 — es
  // darf nur EINE Datei im Ordner entstehen). Findet ausgerechnet der keinen
  // zustellbaren Empfaenger, legt der Server fuer ihn keine Nutzlast an und
  // damit auch keine Datei — obwohl die Nachricht ueber die anderen Bloecke
  // unterwegs ist. Die Einmaligkeit entscheidet deshalb jetzt der Server
  // (Dedup ueber `sha256(daten)`), der sieht, welcher Block Empfaenger fand.
  const umschlaege = gruppenUmschlaegeBauen(2, 'geheim', [['a', 'b'], ['c'], ['d']]);
  assert.deepEqual(
    umschlaege.map((u) => u.archiv),
    [true, true, true]
  );
  // Inhalt und Empfaenger bleiben unangetastet.
  assert.deepEqual(umschlaege[0], { art: 2, daten: 'geheim', empfaenger: ['a', 'b'], archiv: true });
  assert.deepEqual(umschlaege[2].empfaenger, ['d']);
});

test('gruppenUmschlaegeBauen ohne Bloecke liefert nichts zu Markierendes', () => {
  assert.deepEqual(gruppenUmschlaegeBauen(2, 'geheim', []), []);
});
