/**
 * Gegenprobe zu `$lib/anrufe/systemzeileKern.ts` (Anrufe-Epic B).
 *
 * Anlass: nach einem Anruf erschien im Chat keine Zeile — der Nutzer sah
 * nicht, dass/wie lange telefoniert wurde. Die Zeile schreibt der Einleiter-
 * Client als ganz normale Nachricht; der Kern hier entscheidet, OB und WAS.
 * Festgehalten sind genau die Faelle, die die zwei Regeln im Modulkopf
 * erzeugen:
 *
 *  1. Nur der Einleiter (beide Seiten erleben das Ende — sonst stünde die
 *     Zeile doppelt im gemeinsamen Verlauf).
 *  2. Nur bei Ergebnis („aufgelegt“ ohne Dauer ist abgebrochenes Klingeln).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AnrufSystemzeilen, anrufSystemzeile } from '../src/lib/anrufe/systemzeileKern.ts';

describe('anrufSystemzeile — der Einleiter schreibt', () => {
  test('verpasst → Zeile „verpasst“', () => {
    assert.deepEqual(anrufSystemzeile('dm', 'ausgehend', 'verpasst', 0), {
      schluessel: 'verpasst',
      dauerSek: 0
    });
  });

  test('abgelehnt → Zeile „abgelehnt“', () => {
    assert.deepEqual(anrufSystemzeile('dm', 'ausgehend', 'abgelehnt', 0), {
      schluessel: 'abgelehnt',
      dauerSek: 0
    });
  });

  test('aufgelegt mit Dauer → Zeile „dauer“ mit eben dieser', () => {
    assert.deepEqual(anrufSystemzeile('dm', 'ausgehend', 'aufgelegt', 83), {
      schluessel: 'dauer',
      dauerSek: 83
    });
  });
});

describe('anrufSystemzeile — keine Zeile', () => {
  test('abgebrochenes Klingeln: „aufgelegt“ ohne Dauer', () => {
    assert.equal(anrufSystemzeile('dm', 'ausgehend', 'aufgelegt', 0), null);
  });

  test('die Angerufene schreibt nicht — sonst doppelte Zeile', () => {
    assert.equal(anrufSystemzeile('dm', 'eingehend', 'verpasst', 0), null);
    assert.equal(anrufSystemzeile('dm', 'eingehend', 'aufgelegt', 83), null);
  });

  test('Gruppen-Systemzeilen sind ein separates Stück', () => {
    assert.equal(anrufSystemzeile('gruppe', 'ausgehend', 'aufgelegt', 83), null);
  });

  test('unbekannter Grund', () => {
    assert.equal(anrufSystemzeile('dm', 'ausgehend', 'irgendwas', 5), null);
  });
});

// Seit dem 2026-10-11 liegt auch der Merker „schon geschrieben?" hier
// (aus `anruf.svelte.ts` herausgelöst) — und ist damit erst prüfbar.
describe('AnrufSystemzeilen — höchstens eine Zeile je Anruf', () => {
  const dm = { art: 'dm', rolle: 'ausgehend', channel_id: 'k1' };

  function mitSenke() {
    const gesendet: unknown[][] = [];
    const zeilen = new AnrufSystemzeilen();
    zeilen.zielSetzen((...args) => void gesendet.push(args));
    return { zeilen, gesendet };
  }

  test('Ende und lokaler Abbau im Wettlauf: nur die erste Meldung zählt', () => {
    const { zeilen, gesendet } = mitSenke();
    zeilen.hinterlassen(dm, 'aufgelegt', 83);
    zeilen.hinterlassen(dm, 'verpasst', 0);
    assert.deepEqual(gesendet, [['k1', 'dauer', 83]]);
  });

  test('ein neuer Anruf darf wieder schreiben', () => {
    const { zeilen, gesendet } = mitSenke();
    zeilen.hinterlassen(dm, 'verpasst', 0);
    zeilen.neuerAnruf();
    zeilen.hinterlassen(dm, 'abgelehnt', 0);
    assert.deepEqual(gesendet, [
      ['k1', 'verpasst', 0],
      ['k1', 'abgelehnt', 0]
    ]);
  });

  test('keine Zeile vorgesehen: der Anruf bleibt offen für eine spätere', () => {
    const { zeilen, gesendet } = mitSenke();
    zeilen.hinterlassen(dm, 'aufgelegt', 0);
    zeilen.hinterlassen(dm, 'aufgelegt', 12);
    assert.deepEqual(gesendet, [['k1', 'dauer', 12]]);
  });

  test('ohne Senke (vor dem Bootstrap) wird nichts gesendet, aber gemerkt', () => {
    const zeilen = new AnrufSystemzeilen();
    zeilen.hinterlassen(dm, 'verpasst', 0);
    const gesendet: unknown[][] = [];
    zeilen.zielSetzen((...args) => void gesendet.push(args));
    zeilen.hinterlassen(dm, 'verpasst', 0);
    assert.deepEqual(gesendet, []);
  });
});
