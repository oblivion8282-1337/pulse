import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  auftragLesen,
  buendeln,
  EingabeWeiche,
  erfassungSchalten,
  MAX_FRAMES_PRO_NACHRICHT,
  type RemoteInputNachricht,
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

// ── Reihenfolge: Zuordnung vor dem Aufruf ───────────────────────────────────

/**
 * Ein Aufruf, der sich verhaelt wie der echte Player: er schreibt das erste
 * `player:input` (mit dem Hello) im SELBEN Durchlauf wie seine Antwort.
 *
 * Genau das ist der Kern von Fund 1 — `readline` arbeitet alle Zeilen eines
 * Chunks synchron ab, waehrend eine `await`-Fortsetzung nur ein Microtask ist
 * und erst danach laeuft. Der Rueckruf hier hat deshalb bewusst KEIN `await`
 * vor dem Ereignis.
 */
function rufMitSofortigemHello(
  w: EingabeWeiche,
  playerSession: number,
  slot: number,
  gesehen: RemoteInputNachricht[],
): (params: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (params) => {
    if (params.enabled === true) {
      for (const n of w.verteilen({
        ev: 'player:input',
        session: playerSession,
        slot,
        frames: ['AAI='],
      })) {
        gesehen.push(n);
      }
    }
    return { ok: true, enabled: params.enabled, slot: params.slot };
  };
}

test('das Hello des ersten Einschaltens geht nicht verloren', async () => {
  const w = new EingabeWeiche();
  const gesehen: RemoteInputNachricht[] = [];
  const res = await erfassungSchalten(w, rufMitSofortigemHello(w, 7, 2, gesehen), {
    session: 7,
    enabled: true,
    sessionId: 'sit-a',
    slot: 2,
    pointerLock: false,
  });
  assert.equal(res.ok, true);
  assert.equal(gesehen.length, 1, 'das Hello muss die Weiche passiert haben');
  assert.equal(gesehen[0].session_id, 'sit-a');
  assert.equal(gesehen[0].slot, 2);
  assert.deepEqual(gesehen[0].frames, ['AAI=']);
});

test('auch beim Wechsel der Sitzung ist die Zuordnung rechtzeitig da', async () => {
  // Zweiter Teil derselben Fehlerklasse: nicht nur das erste Einschalten je
  // Fenster, sondern jedes Einschalten mit gewechselter Sitzungskennung.
  const w = new EingabeWeiche();
  const gesehen: RemoteInputNachricht[] = [];
  const auftrag = { session: 7, enabled: true, slot: 0, pointerLock: false };
  await erfassungSchalten(w, rufMitSofortigemHello(w, 7, 0, gesehen), {
    ...auftrag,
    sessionId: 'sit-a',
  });
  await erfassungSchalten(w, rufMitSofortigemHello(w, 7, 0, gesehen), {
    ...auftrag,
    sessionId: 'sit-b',
  });
  assert.deepEqual(
    gesehen.map((n) => n.session_id),
    ['sit-a', 'sit-b'],
  );
});

test('die Kennung der Fernsteuerungs-Sitzung geht an den Player', async () => {
  // Der Player entscheidet daran, ob liegengebliebene Hoch-Ereignisse noch an
  // dasselbe Ziel gehen. Fehlt sie, verwirft er sie — sicher, aber nur, wenn
  // sie bei gleicher Sitzung wirklich ankommt.
  const w = new EingabeWeiche();
  let gesehen: Record<string, unknown> = {};
  await erfassungSchalten(
    w,
    async (params) => {
      gesehen = params;
      return { ok: true };
    },
    { session: 7, enabled: true, sessionId: 'sit-a', slot: 1, pointerLock: false },
  );
  assert.equal(gesehen.remote_session, 'sit-a');
  assert.equal(gesehen.slot, 1);
});

test('beim Ausschalten geht kein Platz an den Player', async () => {
  // Er wuerde dort einen Platz setzen, den hier niemand kennt — und die
  // nachgereichten Hoch-Ereignisse gingen an den falschen Bildschirm.
  const w = new EingabeWeiche();
  let gesehen: Record<string, unknown> = {};
  w.anmelden(7, 'sit-a', 2);
  await erfassungSchalten(
    w,
    async (params) => {
      gesehen = params;
      return { ok: true };
    },
    { session: 7, enabled: false, sessionId: '', slot: 0, pointerLock: false },
  );
  assert.equal(gesehen.enabled, false);
  assert.ok(!('slot' in gesehen), `kein Platz in der Nachricht: ${JSON.stringify(gesehen)}`);
});

test('ein gescheitertes Einschalten laesst keine Zuordnung zurueck', async () => {
  const w = new EingabeWeiche();
  const res = await erfassungSchalten(
    w,
    async () => {
      throw new Error('pulse-player wurde beendet');
    },
    { session: 7, enabled: true, sessionId: 'sit-a', slot: 0, pointerLock: false },
  );
  assert.equal(res.ok, false);
  assert.deepEqual(w.angemeldet(), [], 'sonst floessen Frames an eine tote Erfassung');
});

test('auch ein {ok:false} des Players meldet die Zuordnung wieder ab', async () => {
  const w = new EingabeWeiche();
  const res = await erfassungSchalten(w, async () => ({ ok: false, error: 'unbekannte Sitzung' }), {
    session: 7,
    enabled: true,
    sessionId: 'sit-a',
    slot: 0,
    pointerLock: false,
  });
  assert.equal(res.ok, false);
  assert.deepEqual(w.angemeldet(), []);
});

test('nach dem Ausschalten bleibt die Zuordnung im Nachlauf stehen', async () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-a', 2);
  await erfassungSchalten(w, async () => ({ ok: true }), {
    session: 7,
    enabled: false,
    sessionId: '',
    slot: 0,
    pointerLock: false,
  });
  const n = w.verteilen({ session: 7, slot: 2, frames: ['AwAA'] });
  assert.equal(n.length, 1, 'die Hoch-Ereignisse muessen noch hinausgehen');
  assert.equal(n[0].slot, 2, 'und zwar auf ihrem eigenen Platz');
});

// ── Sitzung und Platz sind ein Paar ─────────────────────────────────────────

test('ein abweichender Platz im Ereignis fuehrt nicht zur angemeldeten Sitzung', () => {
  // Der Kern von Fund 2: mit `slot: 0` aus einem Vorgabewert gingen die Frames
  // an einen fremden, laufenden Stream, dessen Sidecar nie ein Hello sah.
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-a', 2);
  assert.deepEqual(w.verteilen({ session: 7, slot: 0, frames: ['AAI='] }), []);
  assert.deepEqual(w.verteilen({ session: 7, slot: 1, frames: ['AAI='] }), []);
  assert.equal(w.verteilen({ session: 7, slot: 2, frames: ['AAI='] }).length, 1);
});

test('der Platz der Nachricht ist immer der angemeldete', () => {
  const w = new EingabeWeiche();
  w.anmelden(7, 'sit-a', 3);
  const n = w.verteilen({ session: 7, slot: 3, frames: ['AAI='] });
  assert.equal(n[0].slot, 3);
});

// ── Auftrag lesen ───────────────────────────────────────────────────────────

test('ohne Sitzung und ohne Kennung wird nicht erfasst', () => {
  assert.deepEqual(auftragLesen({ enabled: true, sessionId: 'a' }), {
    ok: false,
    error: 'session fehlt',
  });
  assert.deepEqual(auftragLesen({ session: 1, enabled: true }), {
    ok: false,
    error: 'sessionId fehlt',
  });
});

test('ein ungueltiger Platz wird abgewiesen statt auf 0 gebogen', () => {
  for (const slot of [-1, 1.5, '2', null]) {
    const gelesen = auftragLesen({ session: 1, enabled: true, sessionId: 'a', slot });
    assert.equal(gelesen.ok, false, `slot=${JSON.stringify(slot)} muss abgewiesen werden`);
  }
});

test('ein fehlender Platz ist der erste Stream — so steht es in der Wire-Spec', () => {
  const gelesen = auftragLesen({ session: 1, enabled: true, sessionId: 'a' });
  if (!gelesen.ok) throw new Error(gelesen.error);
  assert.equal(gelesen.auftrag.slot, 0);
});

test('das Ausschalten braucht keine Sitzungskennung', () => {
  const gelesen = auftragLesen({ session: 1, enabled: false });
  if (!gelesen.ok) throw new Error(gelesen.error);
  assert.equal(gelesen.auftrag.enabled, false);
  assert.equal(gelesen.auftrag.sessionId, '');
});
