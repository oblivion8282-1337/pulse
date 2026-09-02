/**
 * Schneiden, Fortsetzen, Fortschritt (Etappe F).
 *
 * Der mittlere Test ist die Node-Haelfte der dritten Gegenprobe des Auftrags:
 * ein abgebrochener Umzug setzt fort, statt von vorn zu beginnen. Die
 * Server-Haelfte steht in `test_kopplung.py::test_abgebrochener_umzug_setzt_fort`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SAETZE_JE_STUECK,
  fehlendeStuecke,
  fortschritt,
  stueckeSchneiden
} from '../src/lib/kopplung/umzugPlan.ts';

const satz = (n: number) => ({ schluessel: `s${n}` });

test('leerer Verlauf ergibt kein Stueck', () => {
  assert.deepEqual(stueckeSchneiden([], () => 10, 100), []);
});

test('die Byte-Grenze schneidet, bevor sie ueberschritten wird', () => {
  const saetze = [satz(1), satz(2), satz(3), satz(4)];
  // Je 40 Byte, Grenze 100 — es passen zwei je Stueck (80), das dritte
  // spraengte sie (120).
  const stuecke = stueckeSchneiden(saetze, () => 40, 100);
  assert.deepEqual(
    stuecke.map((s) => s.length),
    [2, 2]
  );
});

test('die Satz-Obergrenze schneidet auch bei winzigen Saetzen', () => {
  const saetze = Array.from({ length: SAETZE_JE_STUECK + 3 }, (_, i) => satz(i));
  const stuecke = stueckeSchneiden(saetze, () => 1, 10_000_000);
  assert.deepEqual(
    stuecke.map((s) => s.length),
    [SAETZE_JE_STUECK, 3]
  );
});

test('ein einzelner zu grosser Satz bekommt sein eigenes Stueck statt wegzufallen', () => {
  // Wegzulassen waere der schlimmere Fehler: der Umzug meldete Erfolg und
  // eine Nachricht fehlte (s. Kommentar an `stueckeSchneiden`).
  const stuecke = stueckeSchneiden([satz(1), satz(2)], (s) => (s.schluessel === 's1' ? 500 : 10), 100);
  assert.deepEqual(
    stuecke.map((s) => s.map((x) => x.schluessel)),
    [['s1'], ['s2']]
  );
});

test('kein Satz geht beim Schneiden verloren', () => {
  const saetze = Array.from({ length: 137 }, (_, i) => satz(i));
  const stuecke = stueckeSchneiden(saetze, () => 7, 50);
  assert.deepEqual(stuecke.flat(), saetze);
});

test('fehlende Stuecke: eine Luecke MITTENDRIN wird gefunden', () => {
  // Der eigentliche Punkt der Fortsetzbarkeit. Wer „ab der ersten Luecke"
  // rechnet, schoebe hier 1 bis 4 und damit die schon liegende 3 mit; wer
  // „ab dem hoechsten vorhandenen" rechnet, liesse 1 und 3 ganz aus.
  assert.deepEqual(fehlendeStuecke(5, [0, 2, 4]), [1, 3]);
});

test('fehlende Stuecke: nichts da ergibt alles, alles da ergibt nichts', () => {
  assert.deepEqual(fehlendeStuecke(3, []), [0, 1, 2]);
  assert.deepEqual(fehlendeStuecke(3, [2, 0, 1]), []);
});

test('fehlende Stuecke ignoriert Positionen ausserhalb', () => {
  // Der Server koennte Stuecke einer aelteren, groesseren Einteilung halten.
  assert.deepEqual(fehlendeStuecke(2, [0, 1, 7]), []);
});

test('Fortschritt eines leeren Umzugs ist FERTIG, nicht NaN', () => {
  const f = fortschritt(0, 0);
  assert.equal(f.anteil, 1);
  assert.equal(f.fertig, true);
});

test('Fortschritt rechnet den Anteil und kappt Ausreisser', () => {
  assert.equal(fortschritt(1, 4).anteil, 0.25);
  assert.equal(fortschritt(9, 4).erledigt, 4);
  assert.equal(fortschritt(-3, 4).erledigt, 0);
  assert.equal(fortschritt(3, 4).fertig, false);
});
