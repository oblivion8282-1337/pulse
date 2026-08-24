import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  monitorNummer,
  stromPasstZuMonitor,
  zuordneStroeme,
  zuordnungIstEindeutig,
} from '../src/lib/stream/settingsCatalog.ts';

test('eine Monitor-Quelle liefert ihre Nummer', () => {
  assert.equal(monitorNummer('Monitor: 3'), 3);
  assert.equal(monitorNummer('Monitor: 1'), 1);
});

test('Rand und Grossschreibung stoeren nicht, ein fehlender Vorsatz schon', () => {
  assert.equal(monitorNummer('  Monitor: 2  '), 2);
  assert.equal(monitorNummer('monitor: 2'), undefined, 'Vorsatz ist gross geschrieben');
});

test('was kein Monitor ist, hat keine Nummer', () => {
  assert.equal(monitorNummer('window:12345'), undefined);
  assert.equal(monitorNummer('portal'), undefined);
  assert.equal(monitorNummer(''), undefined);
  assert.equal(monitorNummer(undefined), undefined);
  assert.equal(monitorNummer(null), undefined);
});

test('Unfug ergibt keine Nummer statt NaN', () => {
  assert.equal(monitorNummer('Monitor: abc'), undefined);
  assert.equal(monitorNummer('Monitor: '), undefined);
  assert.equal(monitorNummer('Monitor: 1.5'), undefined, 'nur ganze Zahlen');
  assert.equal(monitorNummer('Monitor: -1'), undefined, 'keine negativen');
});

test('die Nummer gewinnt gegen den Namen', () => {
  const mon = { index: 2, name: 'Dell U2723', primary: false };
  assert.equal(stromPasstZuMonitor({ monitor_index: 2, label: 'ganz anders' }, mon), true);
  assert.equal(
    stromPasstZuMonitor({ monitor_index: 3, label: 'Dell U2723' }, mon),
    false,
    'traegt der Strom eine Nummer, entscheidet NUR sie',
  );
});

test('ohne Nummer bleibt der Namensvergleich — fuer aeltere Klienten', () => {
  const mon = { index: 2, name: 'Dell U2723', primary: false };
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, mon), true);
  assert.equal(stromPasstZuMonitor({ label: '  dell u2723 ' }, mon), true, 'nachsichtig');
  assert.equal(stromPasstZuMonitor({ label: 'Monitor 2' }, mon), true);
  assert.equal(stromPasstZuMonitor({ label: 'BenQ 24' }, mon), false);
  assert.equal(stromPasstZuMonitor({}, mon), false, 'ohne alles passt nichts');
});

test('zwei baugleiche Monitore: mit Nummer eindeutig, ohne Nummer nicht', () => {
  const a = { index: 1, name: 'Dell U2723', primary: true };
  const b = { index: 2, name: 'Dell U2723', primary: false };
  // Mit Nummer trifft jeder Strom genau einen Schirm.
  assert.equal(stromPasstZuMonitor({ monitor_index: 1 }, a), true);
  assert.equal(stromPasstZuMonitor({ monitor_index: 1 }, b), false);
  // Ohne Nummer passt derselbe Strom auf BEIDE — genau die Mehrdeutigkeit,
  // wegen der die Nummer eingefuehrt wurde.
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, a), true);
  assert.equal(stromPasstZuMonitor({ label: 'Dell U2723' }, b), true);
});

test('Notbehelf fuer den namenlosen Hauptbildschirm ist eine Annahme, keine Feststellung', () => {
  const haupt = { index: 1, name: 'Dell U2723', primary: true };
  // Ein Geraetestrom (sein Slot gehoert dem Geraet) ohne Nummer UND mit
  // einem Namen, der zu keinem gemeldeten Bildschirm passt — z. B. eine
  // Linux-Portal-Aufnahme oder ein Standplatz-Profil auf einer inzwischen
  // verschwundenen Quelle.
  const strom = { slot: 0, label: 'Bildschirmfreigabe' };
  const geraetePlaetze = new Set([0]);

  // zuordneStroeme greift trotzdem zum Notbehelf: der Hauptbildschirm ist
  // frei, also bekommt er den Strom zugeschlagen — GERATEN, nicht getroffen.
  const { karte, geraten } = zuordneStroeme([strom], [haupt], geraetePlaetze);
  assert.equal(karte.get(haupt.index), strom);
  assert.equal(geraten.has(haupt.index), true);

  // Und genau deshalb ist die Zuordnung NICHT eindeutig — auch wenn nur EIN
  // Bildschirm existiert und der Notbehelf ihm den Strom "eindeutig" (das
  // einzig Mögliche) zuschlägt. Null echte Treffer heisst hier GERATEN,
  // nicht sicher — das ist der Fall, den eine reine Treffer-Zaehlung
  // (0 Treffer <= 1) faelschlich als eindeutig durchgehen liesse.
  assert.equal(
    zuordnungIstEindeutig([strom], [haupt], geraetePlaetze),
    false,
    'der Notbehelf ist eine Annahme, keine Feststellung',
  );
});

test('ein echter Treffer bleibt eindeutig — der Notbehelf greift nur, wenn nichts passt', () => {
  const haupt = { index: 1, name: 'Dell U2723', primary: true };
  const strom = { slot: 0, label: 'Dell U2723' };
  const geraetePlaetze = new Set([0]);
  assert.equal(zuordnungIstEindeutig([strom], [haupt], geraetePlaetze), true);
});

test('ein unpassender Strom, der nicht zum Geraet gehoert, loest den Notbehelf gar nicht erst aus', () => {
  const haupt = { index: 1, name: 'Dell U2723', primary: true };
  const strom = { slot: 0, label: 'Bildschirmfreigabe' };
  // Slot 0 gehoert NICHT zum Geraet (leere Plaetze-Liste) — eine von Hand
  // gestartete Uebertragung sagt nichts ueber die Bildschirme des Geraets.
  const geraetePlaetze = new Set<number>();
  const { karte, geraten } = zuordneStroeme([strom], [haupt], geraetePlaetze);
  assert.equal(karte.has(haupt.index), false);
  assert.equal(geraten.size, 0);
  assert.equal(zuordnungIstEindeutig([strom], [haupt], geraetePlaetze), true);
});
