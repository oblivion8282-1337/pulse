import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStreamLifecycleTracker } from '../electron/sidecar-crash-detector.ts';

const STARTING = { ev: 'state', running: true, state: 'starting' };
const LIVE = { ev: 'state', running: true, state: 'live' };
const FPS = { ev: 'fps', fps: 60, uptime_s: 2 };
const STATE_STOPPED = { ev: 'state', running: false, state: 'stopped' };
const STATE_ERROR = { ev: 'state', running: false, state: 'error' };
const STOPPED = { ev: 'stopped' };
const ERROR = { ev: 'error', message: 'boom' };

test('silent crash mid-stream → synthesise (streamed, no terminal, not our shutdown)', () => {
  const t = createStreamLifecycleTracker();
  t.note(STARTING);
  t.note(LIVE);
  t.note(FPS);
  // Process just dies — no stopped/error ever seen.
  assert.equal(t.shouldSynthesiseStopOnExit(false), true);
});

test('normal stop (sidecar emitted stopped) → do NOT synthesise', () => {
  const t = createStreamLifecycleTracker();
  t.note(LIVE);
  t.note(FPS);
  t.note(STOPPED);
  assert.equal(t.shouldSynthesiseStopOnExit(false), false);
});

test('fatal error path (state:error + error event) → do NOT synthesise', () => {
  const t = createStreamLifecycleTracker();
  t.note(LIVE);
  // worker_finished emits a state event with running:false, then the error.
  t.note(STATE_ERROR);
  t.note(ERROR);
  assert.equal(t.shouldSynthesiseStopOnExit(false), false);
});

test('capture_size_changed emits state:false first → no synth (auto-restart owns it)', () => {
  const t = createStreamLifecycleTracker();
  t.note(LIVE);
  t.note(STATE_STOPPED);
  assert.equal(t.shouldSynthesiseStopOnExit(false), false);
});

test('deliberate shutdown (stop op / EOF / app quit) → never synthesise', () => {
  const t = createStreamLifecycleTracker();
  t.note(LIVE);
  t.note(FPS);
  // Even though the child streamed and reported no end, WE asked it to quit.
  assert.equal(t.shouldSynthesiseStopOnExit(true), false);
});

test('idle sidecar that never streamed (health/list query) → do NOT synthesise', () => {
  const t = createStreamLifecycleTracker();
  // No fps, no state:running — a query-only sidecar exiting is not a crash.
  assert.equal(t.shouldSynthesiseStopOnExit(false), false);
});

test('starting then silent death before any fps → still synthesise', () => {
  const t = createStreamLifecycleTracker();
  // `starting` already means running:true — the encoder was kicked off.
  t.note(STARTING);
  assert.equal(t.shouldSynthesiseStopOnExit(false), true);
});
