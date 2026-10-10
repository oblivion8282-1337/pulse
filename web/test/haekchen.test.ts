import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haekchenStufe,
  empfaengerZurSendezeit,
  infoJeEmpfaenger,
  type TreppenEingabe
} from '../src/lib/nachrichten/haekchen.ts';
import { zustellstaendeAus } from '../src/lib/krypto/zustellstand.ts';

// Lokale IDs: 13 Ziffern Date.now() + 6 Zufallsstellen (`lokaleNachrichtId`).
const FRUEH = '1760000000000000001';
const ANKER = '1760000000500000001';
const SPAET = '1760000001000000001';

function eingabe(teil: Partial<TreppenEingabe>): TreppenEingabe {
  return {
    vorlaeufig: false,
    nichtZugestellt: false,
    anker: ANKER,
    empfaenger: ['b'],
    gelesen: () => undefined,
    zugestellt: () => undefined,
    blauErlaubt: true,
    ...teil
  };
}

test('Treppe: Uhr, gesendet, zugestellt, gelesen', () => {
  assert.equal(haekchenStufe(eingabe({ vorlaeufig: true })), 'uhr');
  assert.equal(haekchenStufe(eingabe({})), 'gesendet');
  assert.equal(haekchenStufe(eingabe({ zugestellt: () => FRUEH })), 'gesendet');
  assert.equal(haekchenStufe(eingabe({ zugestellt: () => ANKER })), 'zugestellt');
  assert.equal(haekchenStufe(eingabe({ zugestellt: () => SPAET, gelesen: () => SPAET })), 'gelesen');
});

test('neue DM ohne jeden Stand der Gegenseite zeigt trotzdem einen Haken', () => {
  // Bis 2026-10-10 stand hier gar nichts, solange die Gegenstelle den Chat
  // nie geöffnet hatte.
  assert.equal(haekchenStufe(eingabe({})), 'gesendet');
});

test('gelesen schliesst angekommen ein, auch ohne Zustellstand', () => {
  assert.equal(haekchenStufe(eingabe({ gelesen: () => ANKER, blauErlaubt: false })), 'zugestellt');
  assert.equal(haekchenStufe(eingabe({ gelesen: () => ANKER })), 'gelesen');
});

test('abgeschaltete Lesebestätigung zeigt nie Blau', () => {
  assert.equal(
    haekchenStufe(eingabe({ gelesen: () => SPAET, zugestellt: () => SPAET, blauErlaubt: false })),
    'zugestellt'
  );
});

test('Gruppe: Blau erst, wenn ALLE gelesen haben; doppelt grau, wenn alle haben', () => {
  const stand: Record<string, { g?: string; z?: string }> = {
    b: { g: SPAET, z: SPAET },
    c: { z: ANKER }
  };
  const e = eingabe({
    empfaenger: ['b', 'c'],
    gelesen: (k) => stand[k]?.g,
    zugestellt: (k) => stand[k]?.z
  });
  assert.equal(haekchenStufe(e), 'zugestellt');
  stand.c = {};
  assert.equal(haekchenStufe(e), 'gesendet');
  stand.c = { g: ANKER };
  assert.equal(haekchenStufe(e), 'gelesen');
});

test('nicht zugestellt geht vor allem ausser der Uhr', () => {
  assert.equal(haekchenStufe(eingabe({ nichtZugestellt: true, gelesen: () => SPAET })), 'nicht_zugestellt');
  assert.equal(haekchenStufe(eingabe({ nichtZugestellt: true, vorlaeufig: true })), 'uhr');
});

test('ohne Empfänger bleibt es beim einfachen Haken', () => {
  assert.equal(haekchenStufe(eingabe({ empfaenger: [] })), 'gesendet');
});

test('Empfänger zur Sendezeit: wer später beitrat, zählt nicht mit', () => {
  const mitglieder = [
    { user_id: 'ich', beigetreten_am: '2026-10-01T10:00:00Z' },
    { user_id: 'alt', beigetreten_am: '2026-10-01T10:00:00Z' },
    { user_id: 'neu', beigetreten_am: '2026-10-05T10:00:00Z' },
    { user_id: 'kaputt', beigetreten_am: 'unlesbar' }
  ];
  assert.deepEqual(empfaengerZurSendezeit(mitglieder, 'ich', '2026-10-03T12:00:00Z'), ['alt', 'kaputt']);
  assert.deepEqual(empfaengerZurSendezeit(mitglieder, 'ich', '2026-10-06T12:00:00Z'), [
    'alt',
    'neu',
    'kaputt'
  ]);
});

test('Info-Ansicht: gelesen vor angekommen vor ausstehend', () => {
  const stand: Record<string, { g?: string; z?: string }> = {
    a: {},
    b: { z: ANKER },
    c: { g: SPAET },
    d: { z: FRUEH }
  };
  const liste = infoJeEmpfaenger({
    anker: ANKER,
    empfaenger: ['a', 'b', 'c', 'd'],
    gelesen: (k) => stand[k]?.g,
    zugestellt: (k) => stand[k]?.z
  });
  assert.deepEqual(liste, [
    { konto: 'c', status: 'gelesen' },
    { konto: 'b', status: 'zugestellt' },
    { konto: 'a', status: 'ausstehend' },
    { konto: 'd', status: 'ausstehend' }
  ]);
});

test('Zustellstand: je (Kanal, Absender) die jüngste kanonische ID, nur Quittiertes', () => {
  const nachrichten = [
    { id: 'z1', channel_id: 'k1', author_id: 'a', krypto_id: FRUEH },
    { id: 'z2', channel_id: 'k1', author_id: 'a', krypto_id: SPAET },
    { id: 'z3', channel_id: 'k1', author_id: 'b', krypto_id: ANKER },
    { id: 'z4', channel_id: 'k2', author_id: 'a', krypto_id: SPAET },
    { id: 'z5', channel_id: 'k1', author_id: 'ich', krypto_id: SPAET }
  ];
  const quittiert = new Set(['z1', 'z2', 'z3', 'z5']);
  const meldungen = zustellstaendeAus(nachrichten, quittiert, 'ich');
  assert.deepEqual(
    meldungen.sort((x, y) => (x.absender_user_id < y.absender_user_id ? -1 : 1)),
    [
      { channel_id: 'k1', absender_user_id: 'a', zugestellt_bis: SPAET },
      { channel_id: 'k1', absender_user_id: 'b', zugestellt_bis: ANKER }
    ]
  );
});

test('Zustellstand: ohne krypto_id gilt die eigene ID (Klartext-Altbestand)', () => {
  const meldungen = zustellstaendeAus(
    [{ id: FRUEH, channel_id: 'k', author_id: 'a' }],
    new Set([FRUEH]),
    null
  );
  assert.deepEqual(meldungen, [{ channel_id: 'k', absender_user_id: 'a', zugestellt_bis: FRUEH }]);
});
