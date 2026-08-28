import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mitSchluesselsperre } from '../src/lib/krypto/sitzungssperre.ts';

function warte(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// FIX 3 (Bughunt 2026-08-28): zwei gleichzeitige Operationen auf demselben
// Sitzungsschluessel duerfen die geladene Sitzung nicht unabhaengig
// voneinander weiterdrehen — sonst gewinnt der letzte Schreiber und der
// andere Ratchet-Schritt ist weg, obwohl sein Umschlag schon zugestellt war.

test('zwei Aufgaben fuer denselben Schluessel laufen nie gleichzeitig', async () => {
  const reihenfolge: string[] = [];
  let gleichzeitig = 0;
  let maxGleichzeitig = 0;

  async function aufgabe(name: string, dauerMs: number): Promise<string> {
    gleichzeitig += 1;
    maxGleichzeitig = Math.max(maxGleichzeitig, gleichzeitig);
    reihenfolge.push(`start:${name}`);
    await warte(dauerMs);
    reihenfolge.push(`ende:${name}`);
    gleichzeitig -= 1;
    return name;
  }

  // 'a' startet zuerst und dauert laenger — ohne echte Sperre wuerde 'b'
  // schon starten, bevor 'a' fertig ist.
  const a = mitSchluesselsperre('geraet-x', () => aufgabe('a', 20));
  const b = mitSchluesselsperre('geraet-x', () => aufgabe('b', 5));

  const ergebnisse = await Promise.all([a, b]);

  assert.deepEqual(ergebnisse, ['a', 'b']);
  assert.equal(maxGleichzeitig, 1);
  assert.deepEqual(reihenfolge, ['start:a', 'ende:a', 'start:b', 'ende:b']);
});

test('verschiedene Schluessel blockieren sich nicht gegenseitig', async () => {
  const reihenfolge: string[] = [];
  async function aufgabe(name: string, dauerMs: number): Promise<void> {
    await warte(dauerMs);
    reihenfolge.push(name);
  }
  // 'langsam' (Schluessel 1) startet zuerst, dauert aber laenger als
  // 'schnell' (Schluessel 2) — nur bei echter Unabhaengigkeit beendet
  // 'schnell' zuerst.
  const langsam = mitSchluesselsperre('1', () => aufgabe('langsam', 30));
  const schnell = mitSchluesselsperre('2', () => aufgabe('schnell', 5));

  await Promise.all([langsam, schnell]);
  assert.deepEqual(reihenfolge, ['schnell', 'langsam']);
});

test('ein Fehlschlag blockiert die naechste Aufgabe fuer denselben Schluessel nicht', async () => {
  const erste = mitSchluesselsperre('geraet-y', async () => {
    throw new Error('kaputt');
  });
  const zweite = mitSchluesselsperre('geraet-y', async () => 'erfolgreich');

  await assert.rejects(erste, /kaputt/);
  assert.equal(await zweite, 'erfolgreich');
});
