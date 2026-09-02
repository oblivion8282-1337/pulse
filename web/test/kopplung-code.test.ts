/**
 * Der Kopplungscode — Erzeugen, Normalisieren, Anzeigen (Etappe F).
 *
 * Geprueft wird vor allem die Normalisierung: sie entscheidet, ob ein
 * eingetippter Code ankommt, und ihr Fehlschlag sieht fuer den Nutzer aus wie
 * ein abgelaufener Code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CODE_LAENGE, codeAnzeigen, codeErzeugen, codeNormalisieren } from '../src/lib/kopplung/code.ts';

test('ein erzeugter Code hat die kanonische Laenge und nur erlaubte Zeichen', () => {
  const code = codeErzeugen();
  assert.equal(code.length, CODE_LAENGE);
  assert.match(code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);
});

test('zwei erzeugte Codes sind verschieden', () => {
  // Kein Zufalls-Test, sondern ein Riegel gegen die naheliegendste
  // Fehlfassung: ein vergessenes `getRandomValues` liefert einen konstanten
  // Code, und der bestuende jeden Laengen- und Alphabet-Test.
  assert.notEqual(codeErzeugen(), codeErzeugen());
});

test('Kleinschreibung, Bindestriche und Leerzeichen werden abgeraeumt', () => {
  const code = codeErzeugen();
  assert.equal(codeNormalisieren(codeAnzeigen(code).toLowerCase()), code);
  assert.equal(codeNormalisieren(` ${codeAnzeigen(code)} `), code);
});

test('die drei Crockford-Verwechslungen werden abgebildet', () => {
  // I und L lesen sich als 1, O als 0 — genau die Zeichen, die im Alphabet
  // fehlen und die ein Mensch trotzdem tippt.
  const getippt = 'OIL00-00000-00000-00000';
  assert.equal(codeNormalisieren(getippt), '01100000000000000000');
});

test('U hat KEINEN Zwilling und macht die Eingabe ungueltig', () => {
  // Die Gegenprobe zum vorigen Test: waere U ebenfalls abgebildet, koennte
  // ein Tippfehler still zu einem anderen gueltigen Code werden.
  assert.equal(codeNormalisieren('UUUUU-UUUUU-UUUUU-UUUUU'), null);
});

test('falsche Laenge ergibt null statt eines Serveraufrufs', () => {
  assert.equal(codeNormalisieren('ABC'), null);
  assert.equal(codeNormalisieren(codeErzeugen() + 'A'), null);
  assert.equal(codeNormalisieren(''), null);
});

test('die Anzeige gruppiert in Vierergruppen à fuenf', () => {
  assert.equal(codeAnzeigen('0123456789ABCDEFGHJK'), '01234-56789-ABCDE-FGHJK');
});

test('Anzeige und Normalisierung sind zueinander invers', () => {
  for (let i = 0; i < 20; i++) {
    const code = codeErzeugen();
    assert.equal(codeNormalisieren(codeAnzeigen(code)), code);
  }
});
