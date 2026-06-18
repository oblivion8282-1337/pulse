import { test } from 'node:test';
import assert from 'node:assert/strict';

import { voiceSignalingComponent } from '../../electron/localBackend/components.ts';

test('voiceSignalingComponent: uvicorn-Spec', () => {
  const s = voiceSignalingComponent({}, '/repo', 55547);
  assert.equal(s.name, 'voice-signaling');
  assert.ok(s.command.length > 0);
  assert.ok(s.args.join(' ').includes('dcc_voice_signaling.app:app'));
  assert.ok(s.args.join(' ').includes('55547'));
  assert.ok(s.cwd?.includes('voice-signaling'));
});
