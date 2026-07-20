import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FPS_SAMPLE_MS, createNoiseFilter } from '../electron/sidecar-log-noise.ts';

const FPS = '{"ev":"fps","fps":59.99,"uptime_s":12.3}';
const STATE = '{"ev":"state","running":true,"state":"live","uptime_s":0.0}';
const ERROR = '{"ev":"error","message":"av_buffersrc_add_frame_flags failed (rc=-22)"}';

test('fps: erste Zeile durch, Rest der Minute unterdrückt, danach wieder eine', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', FPS, 1_000), false, 'die erste Stichprobe muss durch');
  assert.equal(f('out', FPS, 2_000), true);
  assert.equal(f('out', FPS, 1_000 + FPS_SAMPLE_MS - 1), true, 'knapp vor Ablauf noch stumm');
  assert.equal(f('out', FPS, 1_000 + FPS_SAMPLE_MS), false, 'nach Ablauf wieder eine');
  assert.equal(f('out', FPS, 1_000 + FPS_SAMPLE_MS + 1), true, 'Fenster beginnt neu');
});

test('state öffnet das Fenster erneut — auch ein kurzer Stream belegt Frames', () => {
  const f = createNoiseFilter();
  assert.equal(f('out', FPS, 0), false);
  assert.equal(f('out', FPS, 5_000), true, 'innerhalb der Minute stumm');
  assert.equal(f('out', STATE, 6_000), false, 'state selbst wird nie unterdrückt');
  assert.equal(f('out', FPS, 7_000), false, 'nach dem state-Übergang wieder eine Stichprobe');
});

test('alles außer fps bleibt unangetastet — auch im stdout-Strom', () => {
  const f = createNoiseFilter();
  for (const now of [0, 1, 2, 3]) {
    assert.equal(f('out', ERROR, now), false, 'Fehlerzeilen nie unterdrücken');
    assert.equal(f('out', '{"ev":"log","line":"[stream] Encode-Pfad: VAAPI"}', now), false);
  }
});

test('stderr und lifecycle sind tabu — dort steht FFmpegs Begründung', () => {
  const f = createNoiseFilter();
  // Selbst eine Zeile, die wie fps aussieht, darf auf stderr nicht wegfallen.
  assert.equal(f('err', FPS, 0), false);
  assert.equal(f('err', FPS, 1), false);
  assert.equal(f('lifecycle', FPS, 2), false);
});

test('gemessenes Rauschverhältnis: aus 60 fps/min wird 1', () => {
  const f = createNoiseFilter();
  let durch = 0;
  // Eine Stunde Stream bei 1 fps-Zeile/Sekunde.
  for (let s = 0; s < 3600; s++) if (!f('out', FPS, s * 1_000)) durch++;
  assert.equal(durch, 60, 'genau eine Stichprobe pro Minute');
});
