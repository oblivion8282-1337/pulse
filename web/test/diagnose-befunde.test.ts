/**
 * Die Zuordnung Prüfbefund → Text.
 *
 * **Warum es diesen Test gibt.** Der teuerste Ausgang ist nicht ein
 * ungeschickter Satz, sondern eine LEERE Zeile: der Betreiber sieht dann bei
 * seinem Problem gar nichts, und zwar genau in dem Moment, in dem er die
 * Auskunft am dringendsten braucht. Zwei Wege führen dorthin — ein Schlüssel
 * ohne Text (deshalb der Abgleich gegen beide Sprachdateien) und ein Befund,
 * den der Server neu erfunden hat (deshalb der Rückfall).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SCHRITTE,
  schrittSchluessel,
  befundSchluessel,
  alleSchluessel,
} from '../src/lib/diagnose/befunde.ts';

function texte(datei: string): Record<string, string> {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'messages', datei), 'utf8'));
}

describe('Jeder erzeugbare Schlüssel hat einen Text — in BEIDEN Sprachen', () => {
  for (const datei of ['de.json', 'en.json']) {
    it(datei, () => {
      const vorhanden = texte(datei);
      const fehlend = alleSchluessel().filter((k) => !(k in vorhanden));
      assert.deepEqual(fehlend, [], `ohne Text in ${datei}: ${fehlend.join(', ')}`);
    });
  }

  it('und kein Text ist leer', () => {
    // Ein leerer String zählt als vorhanden, zeigt dem Nutzer aber nichts.
    for (const datei of ['de.json', 'en.json']) {
      const vorhanden = texte(datei);
      for (const k of alleSchluessel()) {
        assert.ok(vorhanden[k]?.trim(), `${k} ist in ${datei} leer`);
      }
    }
  });
});

describe('schrittSchluessel', () => {
  it('kennt jeden Schritt, den der Server liefert', () => {
    for (const s of SCHRITTE) {
      assert.equal(schrittSchluessel(s), `diagnose_schritt_${s}`);
    }
  });

  it('fällt bei einem unbekannten Schritt zurück statt einen Schlüssel zu erfinden', () => {
    // Der Server darf neuer sein als der Client. Ein erfundener Schlüssel
    // erzeugte eine leere Zeile — schlimmer als ein blasser Sammelbegriff.
    assert.equal(schrittSchluessel('irgendwas_neues'), 'diagnose_schritt_unbekannt');
    assert.equal(schrittSchluessel(''), 'diagnose_schritt_unbekannt');
  });
});

describe('befundSchluessel', () => {
  it('schweigt zu gelungenen Schritten', () => {
    // Ein grüner Schritt braucht keine Erklärung; eine wäre nur Lärm.
    assert.equal(befundSchluessel('dns', 'aufgeloest', true), null);
    assert.equal(befundSchluessel('websocket', 'kette_steht', true), null);
  });

  it('trennt denselben Befund nach Schritt', () => {
    // `kein_durchkommen` auf 443 heisst „niemand kommt hinein", auf 3478/udp
    // heisst es „Chat geht, Ton nicht". Ein gemeinsamer Text wäre für beide
    // Fälle falsch.
    assert.equal(
      befundSchluessel('tcp443', 'kein_durchkommen', false),
      'diagnose_befund_tcp443_kein_durchkommen',
    );
    assert.equal(
      befundSchluessel('stun', 'kein_durchkommen', false),
      'diagnose_befund_stun_kein_durchkommen',
    );
  });

  it('fällt bei unbekanntem Befund auf den allgemeinen Satz', () => {
    assert.equal(befundSchluessel('tls', 'ganz_neuer_fall', false), 'diagnose_befund_allgemein');
    assert.equal(befundSchluessel('neuer_schritt', 'irgendwas', false), 'diagnose_befund_allgemein');
  });
});
