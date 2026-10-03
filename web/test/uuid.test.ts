import test from 'node:test';
import assert from 'node:assert/strict';
import { neueUuid } from '../src/lib/utils/uuid.ts';

test('neueUuid liefert gültige, eindeutige UUIDs v4', () => {
  const a = neueUuid();
  const b = neueUuid();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(b, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test('Fallback greift, wenn crypto.randomUUID fehlt (z. B. http://10.0.2.2 in der Dev-WebView)', () => {
  const nativ = crypto.randomUUID;
  // @ts-expect-error — simuliert fehlende Funktion in Non-Secure-Contexts
  crypto.randomUUID = undefined;
  try {
    assert.equal(typeof neueUuid(), 'string');
    assert.match(neueUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    crypto.randomUUID = nativ;
  }
});
