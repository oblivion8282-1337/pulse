import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importiert bewusst aus `speicherfehler.ts`, nicht `zustand.svelte.ts`: die
// Rune (`$state`) in Letzterem ist ein Svelte-Compiler-Symbol und existiert
// unter Nodes Testläufer nicht — ein Import würde schon am Modul-Top-Level
// mit „$state is not defined" scheitern. Die geprüfte Rechnung liegt deshalb
// im importfreien Nachbarmodul (s. dessen Kopfkommentar).
import { deuteSpeicherfehler } from '../src/lib/verlauf/speicherfehler.ts';

test('ein privates Fenster ist kein Fehler, sondern eine Lage', () => {
  // Firefox verweigert IndexedDB im privaten Modus mit SecurityError.
  const gedeutet = deuteSpeicherfehler(
    Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' })
  );
  assert.equal(gedeutet.art, 'nicht_verfuegbar');
});

test('Safaris privater Modus meldet InvalidStateError — dieselbe Lage', () => {
  const gedeutet = deuteSpeicherfehler(
    Object.assign(new Error('invalid state'), { name: 'InvalidStateError' })
  );
  assert.equal(gedeutet.art, 'nicht_verfuegbar');
});

test('ein voller Speicher wird als solcher benannt', () => {
  const gedeutet = deuteSpeicherfehler(
    Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
  );
  assert.equal(gedeutet.art, 'voll');
});

test('alles Unbekannte gilt als echter Fehler', () => {
  // fail-loud: was wir nicht einordnen koennen, wird nicht beschoenigt.
  assert.equal(deuteSpeicherfehler(new Error('irgendwas')).art, 'fehler');
});

test('ein Nicht-Error-Wert gilt ebenfalls als echter Fehler', () => {
  assert.equal(deuteSpeicherfehler('kaputt').art, 'fehler');
  assert.equal(deuteSpeicherfehler(undefined).art, 'fehler');
});
