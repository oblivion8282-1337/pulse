import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buendeln,
  EingabeWeiche,
  MAX_FRAMES_PRO_NACHRICHT,
} from '../electron/remoteInput.ts';

/** So viele Frames, wie es fuer den Test braucht — Inhalt egal, nur Reihenfolge. */
const frames = (n: number): string[] => Array.from({ length: n }, (_, i) => `f${i}`);

test('kurze Listen bleiben eine Nachricht', () => {
  const n = buendeln('sit-1', 0, frames(5));
  assert.equal(n.length, 1);
  assert.deepEqual(n[0], {
    op: 'remote_input',
    session_id: 'sit-1',
    slot: 0,
    frames: ['f0', 'f1', 'f2', 'f3', 'f4'],
  });
});

test('genau 32 Frames bleiben eine Nachricht — die Grenze ist einschliesslich', () => {
  const n = buendeln('sit-1', 0, frames(MAX_FRAMES_PRO_NACHRICHT));
  assert.equal(n.length, 1);
  assert.equal(n[0].frames.length, MAX_FRAMES_PRO_NACHRICHT);
});

test('darueber wird aufgeteilt, keine Nachricht traegt mehr als 32', () => {
  const gesamt = MAX_FRAMES_PRO_NACHRICHT * 3 + 7;
  const n = buendeln('sit-1', 2, frames(gesamt));
  assert.equal(n.length, 4);
  for (const nachricht of n) {
    assert.ok(
      nachricht.frames.length <= MAX_FRAMES_PRO_NACHRICHT,
      `zu viele Frames: ${nachricht.frames.length}`,
    );
    assert.equal(nachricht.slot, 2, 'der Slot gilt fuer jede Teilnachricht');
  }
  assert.equal(n.at(-1)?.frames.length, 7);
});

test('die Reihenfolge bleibt erhalten — ein Klick darf seine Position nicht ueberholen', () => {
  const gesamt = MAX_FRAMES_PRO_NACHRICHT * 2 + 3;
  const n = buendeln('sit-1', 0, frames(gesamt));
  assert.deepEqual(
    n.flatMap((m) => m.frames),
    frames(gesamt),
  );
});

test('eine leere Liste ergibt keine Nachricht', () => {
  assert.deepEqual(buendeln('sit-1', 0, []), []);
});

test('ohne Anmeldung geht nichts heraus', () => {
  const w = new EingabeWeiche();
  assert.deepEqual(w.verteilen({ ev: 'player:input', session: 1, slot: 0, frames: ['AAI='] }), []);
});

test('nach der Anmeldung traegt die Nachricht die Fernsteuerungs-Sitzung', () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-abc', 1);
  const n = w.verteilen({ ev: 'player:input', session: 7, slot: 1, frames: ['AAI=', 'AwAB'] });
  assert.equal(n.length, 1);
  assert.equal(n[0].session_id, 'sit-abc');
  assert.equal(n[0].slot, 1);
  assert.deepEqual(n[0].frames, ['AAI=', 'AwAB']);
});

test('Frames einer fremden Player-Sitzung landen nicht bei der angemeldeten', () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-abc', 0);
  assert.deepEqual(w.verteilen({ session: 8, frames: ['AAI='] }), []);
});

test('nach dem Abmelden geht nichts mehr heraus', () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-abc', 0);
  w.abmelden(7);
  assert.deepEqual(w.angemeldet(), []);
  assert.deepEqual(w.verteilen({ session: 7, frames: ['AAI='] }), []);
});

test('zwei Fenster gleichzeitig bekommen jedes seine eigene Sitzung und ihren Slot', () => {
  const w = new EingabeWeiche();
  w.anmelden(1, 'sit-a', 0);
  w.anmelden(2, 'sit-b', 1);
  assert.equal(w.verteilen({ session: 1, slot: 0, frames: ['x'] })[0].session_id, 'sit-a');
  assert.equal(w.verteilen({ session: 2, slot: 1, frames: ['x'] })[0].session_id, 'sit-b');
});

test('Muell im Ereignis erzeugt keine Nachricht', () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-abc', 0);
  assert.deepEqual(w.verteilen({ frames: ['AAI='] }), [], 'ohne session');
  assert.deepEqual(w.verteilen({ session: '7', frames: ['AAI='] }), [], 'session als Text');
  assert.deepEqual(w.verteilen({ session: 7 }), [], 'ohne frames');
  assert.deepEqual(w.verteilen({ session: 7, frames: 'AAI=' }), [], 'frames als Text');
  assert.deepEqual(w.verteilen({ session: 7, frames: [] }), [], 'leere Liste');
});

test('nur Zeichenketten gehen durch — der Gateway reicht ungeprueft weiter', () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-abc', 0);
  const n = w.verteilen({ session: 7, frames: ['AAI=', 42, null, '', { a: 1 }, 'AwAB'] });
  assert.equal(n.length, 1);
  assert.deepEqual(n[0].frames, ['AAI=', 'AwAB']);
});

/** Kurz warten — die Nachlauf-Frist laeuft ueber echte Timer. */
const warten = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('der Nachlauf vergisst die Zuordnung erst nach seiner Frist', async () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-abc', 0);
  w.abmeldenVerzoegert(7, 20);
  assert.equal(
    w.verteilen({ session: 7, frames: ['x'] }).length,
    1,
    'die nachgereichten Hoch-Ereignisse gehen noch hinaus',
  );
  await warten(40);
  assert.deepEqual(w.angemeldet(), []);
  assert.deepEqual(w.verteilen({ session: 7, frames: ['x'] }), []);
});

test('eine neue Anmeldung raeumt den laufenden Nachlauf ab', async () => {
  // Der Effect der steuernden Seite macht bei jeder Aenderung von Sitzung oder
  // Platz genau diese Abfolge: erst aus (mit Nachlauf), sofort danach wieder
  // an. Raeumt die neue Anmeldung die Frist nicht ab, loescht diese kurz
  // darauf die frische Zuordnung — und es fliesst still gar keine Eingabe mehr.
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-alt', 0);
  w.abmeldenVerzoegert(7, 20);
  w.anmelden(7, 'sit-neu', 1);
  await warten(40);
  const n = w.verteilen({ session: 7, slot: 1, frames: ['x'] });
  assert.equal(n.length, 1, 'die neue Zuordnung hat den Nachlauf ueberlebt');
  assert.equal(n[0].session_id, 'sit-neu');
});

test('sofortiges Abmelden raeumt den Nachlauf mit ab', async () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-alt', 0);
  w.abmeldenVerzoegert(7, 20);
  w.abmelden(7);
  w.anmelden(7, 'sit-neu', 0);
  await warten(40);
  assert.deepEqual(w.angemeldet(), [7]);
});

test('alleAbmelden vergisst jede Zuordnung — der Renderer laedt neu', async () => {
  const w = new EingabeWeiche();
  w.anmelden(1, 'sit-a', 0);
  w.anmelden(2, 'sit-b', 1);
  w.abmeldenVerzoegert(2, 20);
  w.alleAbmelden();
  assert.deepEqual(w.angemeldet(), []);
  w.anmelden(2, 'sit-c', 0);
  await warten(40);
  assert.deepEqual(w.angemeldet(), [2], 'die abgeraeumte Frist schlaegt nicht mehr zu');
});

test('fehlt der Slot im Ereignis, gilt der aus der Anmeldung', () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-abc', 3);
  assert.equal(w.verteilen({ session: 7, frames: ['x'] })[0].slot, 3);
});
