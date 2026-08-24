import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  monitorNummer,
  stromPasstZuMonitor,
  zuordneStroeme,
  zuordnungIstEindeutig,
} from '../src/lib/stream/quellenummer.ts';
import { schirmFuerFenster } from '../src/lib/stream/schirmFuerFenster.ts';

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
  assert.equal(
    monitorNummer('Monitor: 0'),
    undefined,
    'die Nummern sind 1-basiert; die 0 ist als „keine Nummer" vergeben',
  );
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

test('die Nummer gewinnt auch ZWISCHEN zwei Stroemen, nicht nur innerhalb eines', () => {
  // Normale Aufstellung: der Besitzer uebertraegt „Dell" nebenher von Hand
  // (Platz 0, nur Name), sein Standplatz-Geraet zeigt DENSELBEN Schirm mit
  // ausdruecklicher Nummer auf Platz 1. Die Liste kommt nach (user, slot)
  // sortiert an — Platz 0 also zuerst.
  const dell = { index: 1, name: 'Dell U2723', primary: true };
  const benq = { index: 2, name: 'BenQ 24', primary: false };
  const vonHand = { slot: 0, label: 'Dell U2723' };
  const vomGeraet = { slot: 1, monitor_index: 1 };
  const geraetePlaetze = new Set([1]);

  const { karte } = zuordneStroeme([vonHand, vomGeraet], [dell, benq], geraetePlaetze);
  assert.equal(
    karte.get(dell.index),
    vomGeraet,
    'der nummerierte Strom sticht den namensgleichen, obwohl der frueher in der Liste steht',
  );

  // Und die Folge davon, die vorher still falsch war: das Fenster von Platz 1
  // findet seinen Bildschirm.
  assert.equal(
    schirmFuerFenster([vonHand, vomGeraet], [dell, benq], geraetePlaetze, 1),
    1,
    'sonst zeigte ein Klick auf „Monitor 1" das von Hand gestartete Fenster',
  );
});

test('ohne Nummer bleibt es bei der Reihenfolge der Liste — der Namenstreffer zaehlt', () => {
  // Gegenprobe zum Fall darueber: traegt KEINER eine Nummer, aendert die neue
  // Vorrunde nichts, und der erste Namenstreffer gewinnt wie bisher.
  const dell = { index: 1, name: 'Dell U2723', primary: true };
  const erster = { slot: 0, label: 'Dell U2723' };
  const zweiter = { slot: 1, label: 'Dell U2723' };
  const { karte } = zuordneStroeme([erster, zweiter], [dell], new Set([0, 1]));
  assert.equal(karte.get(dell.index), erster);
});

test('ohne gemeldete Bildschirmliste greift der Notbehelf AUCH fuer einen nummerierten Strom', () => {
  // `refreshMonitors()` ist beim Anmelden einmal fehlgeschlagen: das Geraet
  // meldet keine Schirme, `monitorListe` erfindet den einen Ersatz-Eintrag mit
  // `index: 0`. Der Strom traegt trotzdem `monitor_index: 1` — eine Nummer,
  // die in dieser Liste gar nicht vorkommen KANN.
  const ersatz = { index: 0, name: 'Hauptbildschirm', primary: true };
  const strom = { slot: 0, monitor_index: 1 };
  const geraetePlaetze = new Set([0]);

  const { karte, geraten } = zuordneStroeme([strom], [ersatz], geraetePlaetze, {
    listeGemeldet: false,
  });
  assert.equal(karte.get(ersatz.index), strom, 'sonst galte der Ersatz-Schirm als frei');
  assert.equal(geraten.has(ersatz.index), true, 'und zwar geraten, nicht getroffen');
  assert.equal(
    zuordnungIstEindeutig([strom], [ersatz], geraetePlaetze, { listeGemeldet: false }),
    false,
    'geraten heisst nicht eindeutig — auch bei einem Strom MIT Nummer',
  );
});

test('mit gemeldeter Liste bleibt ein nummerierter Strom vom Notbehelf ausgeschlossen', () => {
  // Gegenprobe: hier ist die Liste echt, die Nummer zeigt nur auf einen Schirm,
  // den es (nicht mehr) gibt. Dann ist sie eine ausdrueckliche Angabe und darf
  // NICHT auf den Hauptbildschirm umgebogen werden.
  const haupt = { index: 1, name: 'Dell U2723', primary: true };
  const strom = { slot: 0, monitor_index: 7 };
  const geraetePlaetze = new Set([0]);
  const { karte, geraten } = zuordneStroeme([strom], [haupt], geraetePlaetze);
  assert.equal(karte.has(haupt.index), false);
  assert.equal(geraten.size, 0);
});

test('schirmFuerFenster findet den Bildschirm ueber den Sende-Platz DIESES Fensters', () => {
  const links = { index: 1, name: 'Links', primary: true };
  const rechts = { index: 2, name: 'Rechts', primary: false };
  const stromLinks = { slot: 0, monitor_index: 1 };
  const stromRechts = { slot: 1, monitor_index: 2 };
  const geraetePlaetze = new Set([0, 1]);
  assert.equal(
    schirmFuerFenster([stromLinks, stromRechts], [links, rechts], geraetePlaetze, 0),
    1,
  );
  assert.equal(
    schirmFuerFenster([stromLinks, stromRechts], [links, rechts], geraetePlaetze, 1),
    2,
  );
});

test('schirmFuerFenster: kein Treffer fuer einen Platz, der zu keinem Bildschirm gehoert', () => {
  const haupt = { index: 1, name: 'Links', primary: true };
  const strom = { slot: 0, monitor_index: 1 };
  const geraetePlaetze = new Set([0]);
  assert.equal(schirmFuerFenster([strom], [haupt], geraetePlaetze, 99), null);
});

test('schirmFuerFenster ist fail-visible: uneindeutig heisst KEINE Markierung, auch wenn der Platz technisch passt', () => {
  const haupt = { index: 1, name: 'Dell U2723', primary: true };
  // Derselbe Notbehelf-Fall wie oben: geraten, nicht getroffen — der Platz
  // waere zwar der einzig moegliche Treffer, zaehlt hier aber nicht.
  const strom = { slot: 0, label: 'Bildschirmfreigabe' };
  const geraetePlaetze = new Set([0]);
  assert.equal(schirmFuerFenster([strom], [haupt], geraetePlaetze, 0), null);
});

test('schirmFuerFenster: zwei baugleiche Monitore ohne Nummer bleiben unmarkiert', () => {
  const a = { index: 1, name: 'Dell U2723', primary: true };
  const b = { index: 2, name: 'Dell U2723', primary: false };
  const strom = { slot: 0, label: 'Dell U2723' };
  const geraetePlaetze = new Set([0]);
  assert.equal(schirmFuerFenster([strom], [a, b], geraetePlaetze, 0), null);
});
