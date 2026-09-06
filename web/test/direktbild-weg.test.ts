import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendDeviceWake,
  sendRemoteRequest,
  sendRemoteRespond,
} from '../src/lib/ws/gateway-senders.ts';

/**
 * **Der Drahtvertrag des P2P-Wegs** (Stufe 1, Plan 2026-09-06). Drei Felder
 * entscheiden darüber, ob der Direktmodus überhaupt entsteht — sie hier zu
 * prüfen ist billiger, als einen Zwei-Maschinen-Test an einem falschen
 * Feldnamen scheitern zu lassen.
 */

/** Fängt den Rahmen ab statt ihn zu senden; `true` = Verbindung offen. */
function fänger(): { rahmen: Record<string, unknown> | null; send: (r: unknown) => boolean } {
  const kasten: { rahmen: Record<string, unknown> | null } = { rahmen: null };
  return {
    get rahmen() {
      return kasten.rahmen;
    },
    send: (r: unknown) => {
      kasten.rahmen = r as Record<string, unknown>;
      return true;
    },
  };
}

test('der Weckruf trägt den P2P-Wunsch nur, wenn er gemeint ist', () => {
  const mit = fänger();
  assert.equal(sendDeviceWake(mit.send, '42', undefined, true), true);
  assert.equal(mit.rahmen?.['p2p'], true);

  const ohne = fänger();
  sendDeviceWake(ohne.send, '42');
  // **Das Feld bleibt weg, nicht `false`.** Der Regelweg soll auf dem Draht
  // genauso aussehen wie vor dem P2P-Weg — ein Feld, das immer mitläuft, wäre
  // für ältere Builds und Logs ein Unterschied ohne Grund.
  assert.equal('p2p' in (ohne.rahmen ?? {}), false);
});

test('die Anfrage trägt den P2P-Wunsch zum Host', () => {
  const f = fänger();
  sendRemoteRequest(f.send, 'kanal', '9001', '42', true);
  assert.equal(f.rahmen?.['p2p'], true);
  assert.equal(f.rahmen?.['device_id'], '42');

  const ohne = fänger();
  sendRemoteRequest(ohne.send, 'kanal', '9001');
  assert.equal('p2p' in (ohne.rahmen ?? {}), false);
});

test('die Zusage trägt den Platz des Direktstroms', () => {
  // Ohne Server-Stream gibt es keine Stromliste auf der Steuernden-Seite — der
  // Platz kommt vom Host, in genau dieser Zusage. Die Eingabe-Frames hängen
  // später an dieser Nummer.
  const mit = fänger();
  sendRemoteRespond(mit.send, 'sitzung', true, 2);
  assert.equal(mit.rahmen?.['slot'], 2);

  const ohne = fänger();
  sendRemoteRespond(ohne.send, 'sitzung', true);
  assert.equal('slot' in (ohne.rahmen ?? {}), false);
});
