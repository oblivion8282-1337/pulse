import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidFqdn, parseInviteDeepLink } from '../electron/deeplink.ts';

test('Self-Host-Einladung wie bisher', () => {
  assert.deepEqual(parseInviteDeepLink('pulse://invite?host=pulse.example.de&code=abc12345'), {
    hostname: 'pulse.example.de',
    code: 'abc12345'
  });
});

test('Cloud-Einladung: ohne Host', () => {
  assert.deepEqual(parseInviteDeepLink('pulse://invite?code=abc12345'), {
    hostname: '',
    code: 'abc12345'
  });
});

test('abgewiesen: falscher Host, falscher Code, fremdes Ziel', () => {
  for (const url of [
    'pulse://invite?host=192.168.1.1&code=abc12345',
    'pulse://invite?host=evil.example%5C%40victim.example&code=abc12345',
    'pulse://invite?code=abc',
    'pulse://invite?code=abc12345%20x',
    'pulse://anderes?code=abc12345',
    'https://howispulse.com/invite/abc12345',
    'kein link'
  ]) {
    assert.equal(parseInviteDeepLink(url), null, url);
  }
});

test('isValidFqdn bleibt streng', () => {
  assert.equal(isValidFqdn('pulse.example.de'), true);
  assert.equal(isValidFqdn('0x7f.0.0.1'), false);
});
