import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aufnahmeDauerRegister,
  audioMimeBereinigen,
  aufnahmeDateiname,
  formatiereDauer,
  naechstesTempo
} from '../src/lib/attachments/aufnahmeKern.ts';

test('audioMimeBereinigen streicht MediaRecorder-Parameter', () => {
  assert.equal(audioMimeBereinigen('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(audioMimeBereinigen('audio/mp4'), 'audio/mp4');
  assert.equal(audioMimeBereinigen(' audio/ogg;codecs=opus '), 'audio/ogg');
});

test('aufnahmeDateiname passt zur Container-Endung', () => {
  assert.equal(aufnahmeDateiname('audio/webm'), 'sprachnachricht.webm');
  assert.equal(aufnahmeDateiname('audio/mp4'), 'sprachnachricht.m4a');
  assert.equal(aufnahmeDateiname('audio/ogg'), 'sprachnachricht.ogg');
});

test('Tempo zyklust 1 → 1.5 → 2 → 1', () => {
  assert.equal(naechstesTempo(1), 1.5);
  assert.equal(naechstesTempo(1.5), 2);
  assert.equal(naechstesTempo(2), 1);
});

test('formatiereDauer zeigt Minuten: Sekunden', () => {
  assert.equal(formatiereDauer(7), '0:07');
  assert.equal(formatiereDauer(65), '1:05');
  assert.equal(formatiereDauer(-3), '0:00');
  assert.equal(formatiereDauer(Infinity), '–:––');
});

test('aufnahmeDauerRegister haengt die Dauer ans File und vergisst sie mit', () => {
  const a = new File([new Uint8Array(1)], 'a.webm', { type: 'audio/webm' });
  const b = new File([new Uint8Array(1)], 'b.webm', { type: 'audio/webm' });
  assert.equal(aufnahmeDauerRegister.get(a), undefined);
  aufnahmeDauerRegister.set(a, 5.2);
  assert.equal(aufnahmeDauerRegister.get(a), 5.2);
  assert.equal(aufnahmeDauerRegister.get(b), undefined);
});
