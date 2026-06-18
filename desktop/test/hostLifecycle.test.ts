import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHostOutcome } from '../electron/hostLifecycle.ts';

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
