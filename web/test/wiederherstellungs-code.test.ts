/**
 * Der Wiederherstellungs-Code (E4, Aufgabe 1).
 *
 * Deckt: Zufälligkeit, Bit-Rechnung gegen die Zeichenzahl, ein
 * verwechslungsfreies Alphabet, grosszügige Normalisierung und
 * abgewiesene verstümmelte Eingaben.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  erzeugeCode,
  normalisiere,
  codeBytes,
  CodeFehler,
} from '../src/lib/krypto/wiederherstellungsCode.ts';

describe('erzeugeCode', () => {
  test('zwei Aufrufe liefern verschiedene Codes', () => {
    assert.notEqual(erzeugeCode(), erzeugeCode());
  });

  test('viele Aufrufe sind untereinander alle verschieden', () => {
    const codes = new Set(Array.from({ length: 200 }, () => erzeugeCode()));
    assert.equal(codes.size, 200);
  });

  test('mindestens 128 Bit: 32 Hex-Zeichen ohne Trenner', () => {
    const code = erzeugeCode();
    const ohneTrenner = code.replace(/-/g, '');
    assert.equal(ohneTrenner.length, 32);
    // 32 Hex-Zeichen = 32 * 4 Bit = 128 Bit.
    assert.equal(ohneTrenner.length * 4, 128);
  });

  test('acht Vierergruppen mit Bindestrich', () => {
    const code = erzeugeCode();
    assert.match(code, /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);
  });

  test('das Alphabet enthält kein verwechselbares Zeichen (O, I, l)', () => {
    const code = erzeugeCode();
    assert.equal(code.includes('O'), false);
    assert.equal(code.includes('I'), false);
    assert.equal(code.toLowerCase().includes('l'), false);
  });
});

describe('normalisiere', () => {
  const beispiel = erzeugeCode();

  test('erkennt den Code klein geschrieben', () => {
    assert.equal(normalisiere(beispiel.toLowerCase()), beispiel);
  });

  test('erkennt den Code ohne jeden Bindestrich', () => {
    assert.equal(normalisiere(beispiel.replace(/-/g, '')), beispiel);
  });

  test('erkennt den Code mit zusätzlichen/anders gesetzten Bindestrichen', () => {
    const ohneTrenner = beispiel.replace(/-/g, '');
    const anders = ohneTrenner.match(/.{1,3}/g)!.join('-');
    assert.equal(normalisiere(anders), beispiel);
  });

  test('erkennt den Code mit umgebenden Leerzeichen und Zeilenumbruch', () => {
    assert.equal(normalisiere(`  ${beispiel}\n`), beispiel);
  });

  test('erkennt den Code mit Leerzeichen statt Bindestrichen', () => {
    const mitLeerzeichen = beispiel.replace(/-/g, ' ');
    assert.equal(normalisiere(mitLeerzeichen), beispiel);
  });

  test('weist einen zu kurzen Code ab', () => {
    assert.throws(() => normalisiere('AAAA-BBBB'), CodeFehler);
  });

  test('weist einen zu langen Code ab', () => {
    assert.throws(() => normalisiere(`${beispiel}-AAAA`), CodeFehler);
  });

  test('weist fremde Zeichen ab', () => {
    const mitFremdzeichen = beispiel.replace(/^./, 'Z');
    assert.throws(() => normalisiere(mitFremdzeichen), CodeFehler);
  });

  test('weist eine leere Eingabe ab', () => {
    assert.throws(() => normalisiere(''), CodeFehler);
    assert.throws(() => normalisiere('   '), CodeFehler);
  });
});

describe('codeBytes', () => {
  test('ist umkehrbar konsistent: derselbe Code ergibt dieselben Bytes', () => {
    const code = normalisiere(erzeugeCode());
    assert.deepEqual(codeBytes(code), codeBytes(code));
  });

  test('liefert 16 Bytes (128 Bit)', () => {
    const code = normalisiere(erzeugeCode());
    assert.equal(codeBytes(code).length, 16);
  });

  test('unterschiedliche Codes ergeben unterschiedliche Bytes', () => {
    const a = codeBytes(normalisiere(erzeugeCode()));
    const b = codeBytes(normalisiere(erzeugeCode()));
    assert.notDeepEqual(a, b);
  });
});
