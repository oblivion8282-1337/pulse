/**
 * App-Hosting: schlafende Server dürfen niemanden ausbremsen (2026-10-03).
 * Zwei reine Kerne davon, hier ohne WebRTC/Stores geladen (node --test):
 *  - deuteTelefonbuch: die konservative Deutung der Anwesenheits-Abfrage —
 *    nur eine positive Cloud-Antwort macht „offline“ (sonst Dial wie bisher).
 *  - aufbauGedeckelt: das Gesamtzeitbudget für EINEN Direkt-Aufbau bzw. das
 *    Entlassen des App-Starts — deckelt die ~11-s-Timeout-Zeremonie.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deuteTelefonbuch } from '../src/lib/direct/policy.ts';
import { aufbauGedeckelt } from '../src/lib/direct/deadline.ts';

describe('deuteTelefonbuch', () => {
  test('404 (kein Eintrag / abgemeldet) → offline', () => {
    assert.equal(deuteTelefonbuch(404, undefined), 'offline');
  });

  test('200 + online:false (Herzschlag zu alt) → offline', () => {
    assert.equal(deuteTelefonbuch(200, false), 'offline');
  });

  test('200 + online:true → online', () => {
    assert.equal(deuteTelefonbuch(200, true), 'online');
  });

  test('401 und 5xx (Deploy-Blip/Netz) → unbekannt, NICHT offline', () => {
    // Ein wacher Server darf durch einen Cloud-Schluckauf nicht blockiert
    // werden — die Weichen dialen dann wie bisher statt abzuschalten.
    assert.equal(deuteTelefonbuch(401, undefined), 'unbekannt');
    assert.equal(deuteTelefonbuch(502, undefined), 'unbekannt');
    assert.equal(deuteTelefonbuch(503, undefined), 'unbekannt');
  });
});

describe('aufbauGedeckelt', () => {
  test('läuft ab, wenn die Schritte nie enden — false nach der Frist', async () => {
    const nieFertig = new Promise<never>(() => {});
    const t0 = Date.now();
    assert.equal(await aufbauGedeckelt(nieFertig, 15), false);
    assert.ok(Date.now() - t0 >= 10, 'Deckel hat vor der Frist entlassen');
  });

  test('erfolgreiche Schritte → true (auch schneller als die Frist)', async () => {
    assert.equal(await aufbauGedeckelt(Promise.resolve('fertig'), 1000), true);
  });

  test('Fehler der Schritte gehen DURCH (Fingerprint-Konflikt bleibt erkennbar)', async () => {
    const schuld = new Error('direct-path fingerprint mismatch');
    await assert.rejects(
      aufbauGedeckelt(Promise.reject(schuld), 1000),
      (e: unknown) => e === schuld,
    );
  });
});
