/**
 * Bughunt 2026-08-29, Befund 1: die alte Pruefung hielt eine Position schon
 * fuer „vorhanden", sobald die GESAMTZAHL der Stuecke passte — nicht der
 * Inhalt. Bei einer waehrend der Kopplungsfrist bearbeiteten/geloeschten
 * Nachricht konnte die neue Einteilung zufaellig dieselbe Stueckzahl
 * ergeben, und ein veraltetes Stueck blieb unbemerkt stehen.
 * `vorhandeneNachKennungAbgleich` ersetzt den Zaehlvergleich durch einen
 * Inhaltsabgleich je Position.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vorhandeneNachKennungAbgleich } from '../src/lib/kopplung/kennungAbgleich.ts';

test('eine Position mit passender Kennung gilt als vorhanden', () => {
  const lokal = new Map([[0, 'kennung-a']]);
  const vorhanden = vorhandeneNachKennungAbgleich([0], { '0': 'kennung-a' }, lokal, 1);
  assert.deepEqual(vorhanden, [0]);
});

test('Kernfall des Bughunts: gleiche Stueckzahl, aber veraenderter Inhalt', () => {
  // Die Position ist da (Server meldet sie unter `vorhandene_stuecke`), und
  // die GESAMTZAHL passt zufaellig — trotzdem ist die lokal neu berechnete
  // Kennung eine andere, weil sich der Inhalt (bearbeitete/geloeschte
  // Nachricht) seit dem letzten Lauf geaendert hat. Die alte, rein
  // zaehlbasierte Pruefung haette das NICHT erkannt (s. Modulkopf) — dieser
  // Test waere ohne den Inhaltsabgleich gruen geblieben und haette den
  // Fehler nicht gefangen; mit ihm ist die Position `fehlt`, nicht
  // `vorhanden`.
  const serverKennungen = { '0': 'kennung-alt' };
  const lokal = new Map([[0, 'kennung-neu']]);
  const vorhanden = vorhandeneNachKennungAbgleich([0], serverKennungen, lokal, 1);
  assert.deepEqual(vorhanden, [], 'ein veraendertes Stueck darf nicht als vorhanden gelten');
});

test('eine Position ohne hinterlegte Server-Kennung (aeltere Zeile) gilt als fehlend', () => {
  const vorhanden = vorhandeneNachKennungAbgleich([0], {}, new Map([[0, 'irgendwas']]), 1);
  assert.deepEqual(vorhanden, []);
});

test('Positionen ausserhalb der aktuellen Einteilung werden ignoriert', () => {
  // Der Server koennte Reste einer aelteren, groesseren Einteilung melden.
  const lokal = new Map([[0, 'k0']]);
  const vorhanden = vorhandeneNachKennungAbgleich([0, 7], { '0': 'k0', '7': 'k7' }, lokal, 1);
  assert.deepEqual(vorhanden, [0]);
});

test('mehrere Positionen: nur die inhaltlich passenden bleiben vorhanden', () => {
  const serverKennungen = { '0': 'k0', '1': 'alt-1', '2': 'k2' };
  const lokal = new Map([
    [0, 'k0'],
    [1, 'neu-1'],
    [2, 'k2']
  ]);
  const vorhanden = vorhandeneNachKennungAbgleich([0, 1, 2], serverKennungen, lokal, 3);
  assert.deepEqual(vorhanden, [0, 2]);
});
