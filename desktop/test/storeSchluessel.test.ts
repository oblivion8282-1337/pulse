import { test } from 'node:test';
import assert from 'node:assert/strict';
import { istGeheimerSchluessel, istRendererGesperrt } from '../electron/storeSchluessel.ts';

test('Zugangsdaten je Benutzer-Welt gelten als Geheimnis', () => {
  // Genau dieser Schlüssel fiel vorher durch die exakte Namensliste.
  assert.equal(istGeheimerSchluessel('pulse.host.creds.99084438121484288'), true);
  assert.equal(istGeheimerSchluessel('pulse.host.creds'), true);
  assert.equal(istGeheimerSchluessel('pulse.host.auth'), true);
  assert.equal(istGeheimerSchluessel('custom_servers'), true);
});

test('gewöhnliche Einstellungen bleiben Klartext', () => {
  assert.equal(istGeheimerSchluessel('quitOnClose'), false);
  assert.equal(istGeheimerSchluessel('pulse.host.weltUser'), false);
  // Kein loses Präfix: ein ähnlich benannter Schlüssel ist nicht gemeint.
  assert.equal(istGeheimerSchluessel('pulse.host.credsX'), false);
});

test('der Renderer bekommt keinen pulse.host.*-Schlüssel', () => {
  assert.equal(istRendererGesperrt('pulse.host.creds.99084438121484288'), true);
  assert.equal(istRendererGesperrt('pulse.host.auth'), true);
  assert.equal(istRendererGesperrt('pulse.host.weltUser'), true);
  assert.equal(istRendererGesperrt('uploadDiagnosticLogs'), false);
});
