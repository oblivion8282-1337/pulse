// serverAnlage.test.ts — Selbstbedienungs-Anlage (Heim-Server 2026-09-27).
// Reine Helfer: Instanz-Suche in der Liste + Antwort-Klassen des Anlage-
// Endpoints. Der Electron-Netzweg selbst bleibt wie bei provision() ungetestet
// (imports electron), die Entscheidungslogik hier ist der fail-relevante Teil.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aktiveAppHostInstanz, bewerteAnlage } from '../electron/serverAnlage.ts';

test('aktiveAppHostInstanz: findet aktive app_host, ignoriert vps/inaktive', () => {
  const liste = [
    { id: '1', status: 'active', origin: 'vps' }, // falscher Ursprung
    { id: '2', status: 'suspended', origin: 'app_host' }, // nicht aktiv
    { id: '3', status: 'active', origin: 'app_host' }, // Treffer
  ];
  assert.deepEqual(aktiveAppHostInstanz(liste), { id: '3' });
  assert.equal(aktiveAppHostInstanz([]), null);
  assert.equal(aktiveAppHostInstanz(null), null);
  assert.equal(aktiveAppHostInstanz('kein array'), null);
});

test('bewerteAnlage: 201 mit Instanz-Shell → ok', () => {
  assert.deepEqual(bewerteAnlage(201, { instance: { id: '42' }, client_secret: 'x' }), {
    art: 'ok',
    instanzId: '42',
  });
});

test('bewerteAnlage: 409 → Konflikt (Liste neu lesen)', () => {
  assert.deepEqual(bewerteAnlage(409, { detail: 'bereits vorhanden' }), { art: 'konflikt' });
});

test('bewerteAnlage: alles andere ist Fehler — inkl. 201 ohne Shell', () => {
  assert.deepEqual(bewerteAnlage(201, null), { art: 'fehler', status: 201 });
  assert.deepEqual(bewerteAnlage(201, { instance: {} }), { art: 'fehler', status: 201 });
  assert.deepEqual(bewerteAnlage(0, null), { art: 'fehler', status: 0 }); // Transport
  assert.deepEqual(bewerteAnlage(429, { detail: 'rate' }), { art: 'fehler', status: 429 });
});
