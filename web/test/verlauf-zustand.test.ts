import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// ── Hinweis-Latch (2026-09-11) ─────────────────────────────────────────────
// `zustand.svelte.ts` selbst ist im Node-Läufer unerreichbar (`$state`,
// s. Kopfkommentar) — deshalb Quelltext-Gegenproben wie in
// `krypto-postfach-ready.test.ts` für die zwei Eigenschaften, die der
// Reload-Flakkern-Fix verspricht:

test('der Einmal-Latch für den Verlaufs-Hinweis liegt IM Zustand, nicht in der Seite', () => {
  const quelle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/lib/verlauf/zustand.svelte.ts'),
    'utf8'
  );
  assert.match(quelle, /hinweisVerbrauchen\(\): string \| null/);
  assert.match(quelle, /this\.hingewiesen = true/);
});

test('die DM-Seite verbraucht den Hinweis statt einer eigenen Lokal-Variable', () => {
  const seite = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/routes/app/@me/[[dmChannelId]]/+page.svelte'
    ),
    'utf8'
  );
  assert.match(seite, /verlaufZustand\.hinweisVerbrauchen\(\)/);
  // Die alte lokale Merk-Variable wäre das Zeichen des Rückfalls.
  assert.doesNotMatch(seite, /verlaufHinweisGezeigt/);
});

test('erfolgreiche Zugriffe heben einen gemeldeten Fehler wieder auf', () => {
  const quelle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/lib/verlauf/index.ts'),
    'utf8'
  );
  assert.match(quelle, /verlaufZustand\.erholt\(\)/);
});
