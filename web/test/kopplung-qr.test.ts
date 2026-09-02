/**
 * QR-Darstellung des Kopplungscodes — Gegenprobe zur Ergaenzung von Etappe F.
 *
 * Geprueft wird die reine Rechnung: aus einem bekannten Code entsteht eine
 * quadratische Matrix erwarteter Groesse, und die SVG-Erzeugung daraus
 * passt zu genau dieser Matrix (Anzahl `<rect>`-Elemente = Anzahl dunkler
 * Module, `viewBox` = Matrixgroesse).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { qrMatrixFuerCode, qrSvgAusMatrix, qrSvgFuerCode } from '../src/lib/kopplung/qr.ts';

const BEKANNTER_CODE = '0123456789ABCDEFGHJK';

test('ein bekannter Code ergibt eine quadratische Matrix erwarteter Groesse', () => {
  const matrix = qrMatrixFuerCode(BEKANNTER_CODE);
  // 20 alphanumerische Zeichen liegen alle in QRs Alphanumerik-Modus und
  // fuellen bei ECC-Stufe M Version 1 (21 Module) nicht aus; mit der
  // 4-Modul-Quiet-Zone (s. qr.ts) macht das 21 + 2*4 = 29.
  assert.equal(matrix.length, 29);
  for (const zeile of matrix) assert.equal(zeile.length, 29);
});

test('zwei verschiedene Codes gleicher Laenge ergeben dieselbe Groesse', () => {
  // Alle Kopplungscodes sind exakt 20 Zeichen aus demselben Alphabet — die
  // QR-Version haengt nur an der Zeichenzahl, nicht am Inhalt. Ein Test mit
  // nur einem Code koennte das nicht von einem Zufallstreffer unterscheiden.
  const a = qrMatrixFuerCode('0123456789ABCDEFGHJK');
  const b = qrMatrixFuerCode('ZYXWVTSRQPNMKJHGFED9');
  assert.equal(a.length, b.length);
});

test('die SVG-Erzeugung passt zur Matrix: viewBox und Anzahl der Module', () => {
  const matrix = qrMatrixFuerCode(BEKANNTER_CODE);
  const svg = qrSvgAusMatrix(matrix, 'Testtitel');

  const groesse = matrix.length;
  assert.match(svg, new RegExp(`viewBox="0 0 ${groesse} ${groesse}"`));

  let dunkleModule = 0;
  for (const zeile of matrix) for (const modul of zeile) if (modul) dunkleModule++;

  const rectTreffer = svg.match(/<rect x="\d+" y="\d+" width="1" height="1"\/>/g) ?? [];
  assert.equal(rectTreffer.length, dunkleModule);
});

test('der Titel landet als <title> UND als aria-label, XML-sicher escaped', () => {
  const svg = qrSvgAusMatrix(qrMatrixFuerCode(BEKANNTER_CODE), 'A & B <C>');
  assert.match(svg, /<title>A &amp; B &lt;C&gt;<\/title>/);
  assert.match(svg, /aria-label="A &amp; B &lt;C&gt;"/);
});

test('qrSvgFuerCode ist die Kurzform aus Matrix + SVG-Erzeugung', () => {
  const direkt = qrSvgAusMatrix(qrMatrixFuerCode(BEKANNTER_CODE), 'Titel');
  const kurzform = qrSvgFuerCode(BEKANNTER_CODE, 'Titel');
  assert.equal(kurzform, direkt);
});
