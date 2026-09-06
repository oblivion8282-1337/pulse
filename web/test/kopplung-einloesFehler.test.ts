/**
 * Der Grund einer fehlgeschlagenen Einloesung (Etappe F).
 *
 * Der erste Test ist die Gegenprobe zu einem echten Fehler: die erste Fassung
 * las `fehler.detail` statt `fehler.body.detail` und lieferte deshalb IMMER
 * `unbekannt` — also die einzige Meldung ohne Handgriff (s. Modulkopf von
 * `einloesFehler.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { einloesFehlerAus } from '../src/lib/kopplung/einloesFehler.ts';

/** Wie `ApiError` aus `api/client.ts` aussieht: Rumpf unter `body`. */
const apiFehler = (detail: string) => ({ status: 409, body: { detail } });

test('der Grund kommt aus body.detail, nicht aus detail', () => {
  assert.equal(einloesFehlerAus(apiFehler('kopplung_schon_eingeloest')), 'kopplung_schon_eingeloest');
  // Die falsche Fassung: `detail` direkt am Fehler. Sie darf NICHT gelten —
  // sonst haette der Test die kaputte Variante mit durchgewunken.
  assert.equal(einloesFehlerAus({ detail: 'kopplung_abgelaufen' }), 'unbekannt');
});

test('alle vier Server-Gruende werden erkannt', () => {
  for (const grund of [
    'kopplung_unbekannt',
    'kopplung_schon_eingeloest',
    'kopplung_abgelaufen',
    'kopplung_selbes_geraet'
  ]) {
    assert.equal(einloesFehlerAus(apiFehler(grund)), grund);
  }
});

test('ein unbekannter detail wird nicht stillschweigend zugeordnet', () => {
  assert.equal(einloesFehlerAus(apiFehler('irgendwas_neues')), 'unbekannt');
  assert.equal(einloesFehlerAus(apiFehler('code_ungueltig')), 'unbekannt');
});

test('fehlender Rumpf, Netzwerkfehler und Unsinn ergeben unbekannt statt zu werfen', () => {
  assert.equal(einloesFehlerAus(new Error('offline')), 'unbekannt');
  assert.equal(einloesFehlerAus({ status: 500 }), 'unbekannt');
  assert.equal(einloesFehlerAus(null), 'unbekannt');
  assert.equal(einloesFehlerAus(undefined), 'unbekannt');
});
