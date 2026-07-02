import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHostOutcome, HostLifecycle } from '../electron/hostLifecycle.ts';
import type { HostDeps, HostPhaseEvent } from '../electron/hostLifecycle.ts';

test('reachable → go', () => {
  assert.equal(classifyHostOutcome('reachable', null).outcome, 'go');
});
test('cgnat (reach) → not-possible-here', () => {
  assert.equal(classifyHostOutcome('cgnat', null).outcome, 'not-possible-here');
});
test('unknown → something-paused', () => {
  assert.equal(classifyHostOutcome('unknown', null).outcome, 'something-paused');
});
test('needs-forwarding + mapped → go', () => {
  assert.equal(classifyHostOutcome('needs-forwarding', 'mapped').outcome, 'go');
});
test('needs-forwarding + cgnat(map) → not-possible-here', () => {
  assert.equal(classifyHostOutcome('needs-forwarding', 'cgnat').outcome, 'not-possible-here');
});
test('needs-forwarding + unsupported → needs-your-help', () => {
  assert.equal(classifyHostOutcome('needs-forwarding', 'unsupported').outcome, 'needs-your-help');
});
test('needs-forwarding + partial → needs-your-help', () => {
  assert.equal(classifyHostOutcome('needs-forwarding', 'partial').outcome, 'needs-your-help');
});

// HostLifecycle orchestrator tests

function fakeDeps(over: Partial<HostDeps>): HostDeps {
  return {
    startBackend: async () => {},
    stopBackend: async () => {},
    checkReachability: async () => ({ verdict: 'reachable', publicIp: '203.0.113.7' }),
    mapPorts: async () => ({ verdict: 'mapped', openPorts: [], failedPorts: [] }),
    relayUrl: () => 'https://brave-otter.relay.howispulse.com',
    ...over,
  };
}

async function phasesOf(deps: HostDeps): Promise<string[]> {
  const phases: string[] = [];
  const hl = new HostLifecycle(deps);
  hl.onPhase((e) => phases.push(e.phase));
  await hl.start();
  return phases;
}

test('happy path (reachable) → live', async () => {
  const phases = await phasesOf(fakeDeps({}));
  assert.deepEqual(phases, ['checking-network', 'preparing', 'going-live', 'live']);
});

test('cgnat → not-possible-here, Backend nicht gestartet', async () => {
  let started = false;
  const phases = await phasesOf(fakeDeps({
    checkReachability: async () => ({ verdict: 'cgnat', publicIp: '100.70.0.1' }),
    startBackend: async () => { started = true; },
  }));
  assert.equal(phases.at(-1), 'not-possible-here');
  assert.equal(started, false);
});

test('needs-forwarding + Mapping klappt → live (via opening-door)', async () => {
  const phases = await phasesOf(fakeDeps({
    checkReachability: async () => ({ verdict: 'needs-forwarding', publicIp: '203.0.113.7' }),
    mapPorts: async () => ({ verdict: 'mapped', openPorts: [7882], failedPorts: [] }),
  }));
  assert.deepEqual(phases, ['checking-network', 'opening-door', 'preparing', 'going-live', 'live']);
});

test('needs-forwarding + Mapping scheitert → needs-your-help mit Ports', async () => {
  const events: HostPhaseEvent[] = [];
  const hl = new HostLifecycle(fakeDeps({
    checkReachability: async () => ({ verdict: 'needs-forwarding', publicIp: '203.0.113.7' }),
    mapPorts: async () => ({ verdict: 'unsupported', openPorts: [], failedPorts: [7882, 1936] }),
  }));
  hl.onPhase((e) => events.push(e));
  await hl.start();
  assert.equal(events.at(-1)?.phase, 'needs-your-help');
  assert.deepEqual(events.at(-1)?.detail?.ports, [7882, 1936]);
});

test('Backend-Fehler → something-paused (kein throw)', async () => {
  const phases = await phasesOf(fakeDeps({
    startBackend: async () => { throw new Error('boom'); },
  }));
  assert.equal(phases.at(-1), 'something-paused');
});

test('checkPrereqs needs-windows-setup → eigene Phase, Backend startet NICHT', async () => {
  let backendStarted = false;
  const deps = fakeDeps({
    checkPrereqs: async () => 'needs-windows-setup',
    startBackend: async () => { backendStarted = true; },
  });
  const phases = await phasesOf(deps);
  assert.deepEqual(phases, ['needs-windows-setup']);
  assert.equal(backendStarted, false);
});

test('checkPrereqs ok → normaler Ablauf bis live', async () => {
  const phases = await phasesOf(fakeDeps({ checkPrereqs: async () => 'ok' }));
  assert.ok(phases.includes('live'));
});
