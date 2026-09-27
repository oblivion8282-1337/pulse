import { test } from 'node:test';
import assert from 'node:assert/strict';

import { istInAppZiel } from '../src/lib/notifications/pushZiel.ts';

/**
 * Security-Scan 2026-09-18: Push-`target_url` aus der Server-Payload darf nur
 * als Same-Origin-In-App-Pfad in openWindow()/goto() gelangen — sonst lenkt
 * ein Klick auf die „vertrauenswürdige" Notification auf beliebige URLs.
 * (Spiegel-Inline-Kopie im Service-Worker — synchron halten.)
 */

test('In-App-Pfade werden akzeptiert', () => {
  assert.equal(istInAppZiel('/app'), true);
  assert.equal(istInAppZiel('/app/guilds/1/channels/2'), true);
  assert.equal(istInAppZiel('/app/@me/123'), true);
  assert.equal(istInAppZiel('/app/friends?x=1'), true);
});

test('Externe/protokoll-relative/schema-behaftete Ziele werden abgelehnt', () => {
  assert.equal(istInAppZiel('https://evil.example'), false);
  assert.equal(istInAppZiel('//evil.example'), false);
  assert.equal(istInAppZiel('/\\evil.example'), false); // Backslash = protokoll-relativ
  assert.equal(istInAppZiel('\\/evil.example'), false);
  assert.equal(istInAppZiel('app/guilds'), false); // kein führender /
  assert.equal(istInAppZiel('mailto:x@y.z'), false);
});

test('null/undefined/leer werden abgelehnt (Fallback greift)', () => {
  assert.equal(istInAppZiel(null), false);
  assert.equal(istInAppZiel(undefined), false);
  assert.equal(istInAppZiel(''), false);
});
