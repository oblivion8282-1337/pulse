import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RemoteEingabe } from '../electron/remoteInputHost.ts';
import { MAX_FRAMES_PRO_NACHRICHT } from '../electron/remoteInput.ts';

/** Mitschreibender Sidecar-Ersatz: haelt jeden Ruf fest und antwortet wie der
 *  echte (`{ok:true}` filtert `SidecarManager.call` bereits heraus). */
function stubRuf(antwort: Record<string, unknown> = { state: 'live', processed: 1 }) {
  const rufe: { slot: number; op: string; params?: unknown }[] = [];
  const ruf = async (slot: number, op: string, params?: unknown) => {
    rufe.push({ slot, op, params });
    return antwort;
  };
  return { rufe, ruf };
}

const MAX_SLOTS = 99;

test('Frames gehen an den Sidecar des gemeinten Platzes, Huelle unveraendert', async () => {
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  const res = await r.frames(1, 'sit-a', ['AAI=', 'AwAB']);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'live');
  assert.deepEqual(rufe, [
    {
      slot: 1,
      op: 'remote_input',
      params: { slot: 1, session_id: 'sit-a', frames: ['AAI=', 'AwAB'] },
    },
  ]);
});

test('ein Platz ausserhalb der Schranke verwirft still und beendet die Sitzung NICHT', async () => {
  // Wire-Spec v2: „Unbekannt" schliesst ausserhalb des Bereichs ein. Bei
  // ok:false liesse der Renderer die Sitzung fallen — ein `slot: 999` genuegte
  // dann, um eine laufende Fernsteuerung abzuwuergen.
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  for (const draussen of [-1, MAX_SLOTS, 999]) {
    const res = await r.frames(draussen, 'sit-a', ['AAI=']);
    assert.equal(res.ok, true, `Platz ${draussen} darf die Sitzung nicht beenden`);
    assert.equal(res.state, 'unknown_slot');
  }
  assert.deepEqual(rufe, [], 'kein einziger Sidecar wurde angefasst');
  assert.deepEqual(r.offen(), [], 'und keiner wurde gemerkt — auch nicht Platz 0');
});

test('ein Platz, der keine ganze Zahl ist, bleibt ein Protokollfehler', async () => {
  // Der kann aus keinem Rennen stammen, nur aus einer missgeformten Nachricht.
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  for (const kaputt of [1.5, '0', null, undefined, NaN]) {
    const res = await r.frames(kaputt, 'sit-a', ['AAI=']);
    assert.equal(res.ok, false, `Platz ${String(kaputt)} haette abgewiesen werden muessen`);
  }
  assert.deepEqual(rufe, []);
});

test('ein Platz ohne laufenden Sidecar startet keinen — er gilt als unbekannt', async () => {
  // Sonst waeren 99 Nachrichten mit verschiedenen Plaetzen 99 Prozesse: `ruf`
  // spawnt lazy, und der frische Sidecar antwortete nur `unknown_slot`.
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS, (slot) => slot === 1);
  const res = await r.frames(3, 'sit-a', ['AAI=']);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'unknown_slot');
  assert.deepEqual(rufe, []);
  assert.equal((await r.frames(1, 'sit-a', ['AAI='])).ok, true, 'der belegte Platz geht durch');
  assert.equal(rufe.length, 1);
});

test('auch beim Verwerfen wird die vorige Sitzung freigegeben', async () => {
  // Sonst bliebe beim vorigen Gegenueber eine Taste gedrueckt, nur weil die
  // erste Nachricht der neuen Sitzung einen Platz nannte, den es nicht gibt.
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  await r.frames(0, 'sit-a', ['x']);
  rufe.length = 0;
  const res = await r.frames(MAX_SLOTS + 5, 'sit-b', ['y']);
  assert.equal(res.state, 'unknown_slot');
  assert.deepEqual(
    rufe.map((c) => ({ slot: c.slot, op: c.op })),
    [{ slot: 0, op: 'remote_input_end' }],
  );
  assert.deepEqual(r.offen(), [], 'die neue Sitzung hat noch keinen Platz');
  assert.equal(r.sitzung, 'sit-b');
});

test('ohne session_id oder brauchbare Frames geht nichts hinaus', async () => {
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  assert.equal((await r.frames(0, '', ['AAI='])).ok, false, 'leere session_id');
  assert.equal((await r.frames(0, 7, ['AAI='])).ok, false, 'session_id als Zahl');
  assert.equal((await r.frames(0, 'sit-a', [])).ok, false, 'leere Liste');
  assert.equal((await r.frames(0, 'sit-a', 'AAI=')).ok, false, 'Frames als Text');
  assert.equal((await r.frames(0, 'sit-a', ['AAI=', 42])).ok, false, 'Zahl in der Liste');
  assert.equal(
    (await r.frames(0, 'sit-a', Array.from({ length: MAX_FRAMES_PRO_NACHRICHT + 1 }, () => 'x')))
      .ok,
    false,
    'ueber der Wire-Grenze',
  );
  assert.deepEqual(rufe, []);
});

test('genau 32 Frames gehen noch durch — die Grenze ist einschliesslich', async () => {
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  const frames = Array.from({ length: MAX_FRAMES_PRO_NACHRICHT }, (_, i) => `f${i}`);
  assert.equal((await r.frames(0, 'sit-a', frames)).ok, true);
  assert.equal(rufe.length, 1);
});

test('beenden ohne vorherige Frames fasst keinen Sidecar an — sonst startete es einen', async () => {
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  const res = await r.beenden();
  assert.equal(res.ok, true);
  assert.deepEqual(rufe, []);
});

test('beenden startet keinen Sidecar fuer einen Platz, dessen Prozess weg ist', async () => {
  // Windows-Respawn-Modell: der Stream endet, der Sidecar-Prozess stirbt —
  // beendet der Host DANACH die Fernsteuerung, darf das Beenden keinen
  // frischen Prozess starten, nur um ihm `released: 0` zu entlocken
  // (Bughunt R2). Dieselbe Zurueckhaltung, die `frames` laengst uebt.
  const { rufe, ruf } = stubRuf();
  const laufend = new Set([0, 2]);
  const r = new RemoteEingabe(ruf, MAX_SLOTS, (slot) => laufend.has(slot));
  await r.frames(0, 'sit-a', ['x']);
  await r.frames(2, 'sit-a', ['y']);
  laufend.delete(0); // Platz 0: Stream (und Prozess) sind inzwischen weg
  rufe.length = 0;
  const res = await r.beenden();
  assert.equal(res.ok, true);
  assert.deepEqual(
    rufe.map((c) => ({ slot: c.slot, op: c.op })),
    [{ slot: 2, op: 'remote_input_end' }],
    'nur der noch laufende Platz wird angefasst',
  );
  assert.deepEqual(r.offen(), [], 'aufgeraeumt ist trotzdem alles');
});

test('beenden trifft JEDEN Platz, der Frames gesehen hat', async () => {
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  await r.frames(0, 'sit-a', ['x']);
  await r.frames(2, 'sit-a', ['y']);
  await r.frames(0, 'sit-a', ['z']);
  assert.deepEqual(r.offen(), [0, 2]);
  rufe.length = 0;
  await r.beenden();
  assert.deepEqual(
    rufe.map((c) => ({ slot: c.slot, op: c.op })),
    [
      { slot: 0, op: 'remote_input_end' },
      { slot: 2, op: 'remote_input_end' },
    ],
  );
  assert.deepEqual(r.offen(), [], 'danach ist nichts mehr offen');
  assert.equal(r.sitzung, null);
});

test('beenden ist idempotent', async () => {
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  await r.frames(0, 'sit-a', ['x']);
  rufe.length = 0;
  await r.beenden();
  await r.beenden();
  assert.equal(rufe.length, 1, 'der zweite Ruf ist folgenlos');
});

test('ein Platz, der beim Freigeben zickt, haelt die anderen nicht auf', async () => {
  const rufe: { slot: number; op: string }[] = [];
  const ruf = async (slot: number, op: string) => {
    rufe.push({ slot, op });
    if (op === 'remote_input_end' && slot === 0) throw new Error('sidecar tot');
    return {};
  };
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  await r.frames(0, 'sit-a', ['x']);
  await r.frames(1, 'sit-a', ['y']);
  rufe.length = 0;
  const res = await r.beenden();
  assert.equal(res.ok, false, 'der Fehlschlag wird gemeldet');
  assert.deepEqual(
    rufe.map((c) => c.slot),
    [0, 1],
    'Platz 1 wurde trotzdem freigegeben',
  );
});

test('Sitzungswechsel gibt die Plaetze der alten Sitzung vorher frei', async () => {
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  await r.frames(0, 'sit-a', ['x']);
  await r.frames(2, 'sit-a', ['y']);
  rufe.length = 0;
  await r.frames(2, 'sit-b', ['z']);
  assert.deepEqual(rufe, [
    { slot: 0, op: 'remote_input_end', params: undefined },
    { slot: 2, op: 'remote_input_end', params: undefined },
    {
      slot: 2,
      op: 'remote_input',
      params: { slot: 2, session_id: 'sit-b', frames: ['z'] },
    },
  ]);
  assert.deepEqual(r.offen(), [2], 'die neue Sitzung faengt bei ihrem Platz an');
  assert.equal(r.sitzung, 'sit-b');
});

test('dieselbe Sitzung loest keine Freigabe aus', async () => {
  const { rufe, ruf } = stubRuf();
  const r = new RemoteEingabe(ruf, MAX_SLOTS);
  await r.frames(0, 'sit-a', ['x']);
  await r.frames(0, 'sit-a', ['y']);
  assert.equal(
    rufe.filter((c) => c.op === 'remote_input_end').length,
    0,
  );
});

test('ein toter Sidecar wird als {ok:false} gemeldet, nicht geworfen', async () => {
  const r = new RemoteEingabe(async () => {
    throw new Error('gsr sidecar exited (code 1)');
  }, MAX_SLOTS);
  const res = await r.frames(0, 'sit-a', ['x']);
  assert.equal(res.ok, false);
  assert.match(String(res.error), /exited/);
  // Der Platz bleibt gemerkt: der Sidecar KANN Frames gesehen haben, bevor er
  // starb — beim Ende trotzdem freigeben zu wollen ist die sichere Seite.
  assert.deepEqual(r.offen(), [0]);
});
