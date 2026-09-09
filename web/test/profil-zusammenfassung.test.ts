import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profilZusammenfassung } from '../src/lib/devices/profilZusammenfassung.ts';

const basis = {
  quelleName: 'Hauptbildschirm',
  codec: 'h264' as const,
  aufloesung: 'Native',
  aufloesungNativ: 'nativ',
  fps: 30,
  bitrate_kbps: 8000,
  zehn_bit: false,
  hdr: false,
};

test('Vorgabeprofil in einer Zeile', () => {
  assert.equal(
    profilZusammenfassung(basis),
    'Hauptbildschirm · H.264 · nativ · 30 fps · 8000 kbit/s',
  );
});

test('AV1 mit HDR nennt HDR, nicht zusätzlich 10 Bit', () => {
  assert.equal(
    profilZusammenfassung({ ...basis, codec: 'av1', aufloesung: '1440p', zehn_bit: true, hdr: true }),
    'Hauptbildschirm · AV1 · 1440p · 30 fps · 8000 kbit/s · HDR',
  );
});

test('10 Bit ohne HDR wird genannt', () => {
  assert.match(profilZusammenfassung({ ...basis, codec: 'av1', zehn_bit: true }), / · 10 Bit$/);
});
