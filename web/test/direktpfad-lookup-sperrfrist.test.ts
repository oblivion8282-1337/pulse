/**
 * Der Telefonbuch-Lookup des Direktpfads lief pro Self-Host-Server alle 60 s
 * erneut ins 404 — auf einem VPS ist er aber ein garantierter Fehlschlag: der
 * `direct-adapter` schläft dort mangels Relay-Token, es entsteht nie ein
 * Eintrag. `fehlenderEintragIstDauerhaft` ist die reine Rechnung dahinter
 * (importfrei, s. CLAUDE.md-Falle zu `pnpm test:unit`).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fehlenderEintragIstDauerhaft } from '../src/lib/direct/policy.ts';

const vps = { isCloud: false, instance_id: '42', origin: 'vps' as const };
const appHost = { isCloud: false, instance_id: '42', origin: 'app_host' as const };
const altEintrag = { isCloud: false, instance_id: '42' };

describe('fehlenderEintragIstDauerhaft', () => {
  test('merkt das 404 eines VPS-Servers dauerhaft', () => {
    assert.equal(fehlenderEintragIstDauerhaft(404, vps), true);
  });

  test('merkt das 404 eines Alt-Eintrags ohne origin ebenfalls dauerhaft', () => {
    // `origin` fehlt heisst "wie bisher" = VPS-Verhalten (s. isDirectOnly).
    assert.equal(fehlenderEintragIstDauerhaft(404, altEintrag), true);
  });

  test('merkt das 404 eines App-Host-Servers NICHT dauerhaft', () => {
    // Dessen Server-App kann nach dem Seitenaufruf starten und sich erstmals
    // eintragen — ein dauerhaftes 404 liesse sie ewig offline aussehen.
    assert.equal(fehlenderEintragIstDauerhaft(404, appHost), false);
  });

  test('merkt andere Fehlerstati nicht dauerhaft', () => {
    // 401 = Cloud-Sitzung noch nicht da, 5xx = Störung: beides sagt nichts
    // über den Eintrag aus.
    assert.equal(fehlenderEintragIstDauerhaft(401, vps), false);
    assert.equal(fehlenderEintragIstDauerhaft(500, vps), false);
    assert.equal(fehlenderEintragIstDauerhaft(503, vps), false);
  });

  test('behandelt einen unbekannten Server wie einen VPS', () => {
    // Kein Eintrag im Server-Store heisst wie ein fehlendes `origin` "wie
    // bisher" (s. isDirectOnly), also VPS-Verhalten: 404 dauerhaft, alles
    // andere kurz.
    assert.equal(fehlenderEintragIstDauerhaft(404, undefined), true);
    assert.equal(fehlenderEintragIstDauerhaft(401, null), false);
  });
});
