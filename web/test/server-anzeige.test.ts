import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anzeigeName, istSichtbar, type AnzeigeEintrag } from '../src/lib/servers/anzeige.ts';

const heim = (over: Partial<AnzeigeEintrag> = {}): AnzeigeEintrag => ({
  isCloud: false,
  label: 'https://rapid-comet-58ed.relay.unicutmedia.com',
  hostname: 'https://rapid-comet-58ed.relay.unicutmedia.com',
  server_name: null,
  origin: 'app_host',
  ...over,
});

test('Name: Cloud-Name vor ready-Name vor Adresse', () => {
  assert.equal(anzeigeName(heim()), 'https://rapid-comet-58ed.relay.unicutmedia.com');
  assert.equal(anzeigeName(heim({ server_name: 'Alt' })), 'Alt');
  // Der Cloud-Name ist der neueste — er gewinnt gegen einen veralteten ready-Namen.
  assert.equal(anzeigeName(heim({ server_name: 'Alt', anzeigename: 'Michaels Server' })), 'Michaels Server');
  assert.equal(anzeigeName({ ...heim(), isCloud: true, label: 'Pulse Cloud', anzeigename: 'X' }), 'Pulse Cloud');
});

test('gestoppter Heim-Server verschwindet, unbekannter Zustand nicht', () => {
  assert.equal(istSichtbar(heim({ online: false })), false);
  assert.equal(istSichtbar(heim({ online: true })), true);
  assert.equal(istSichtbar(heim({ online: null })), true);
  assert.equal(istSichtbar(heim({ online: undefined })), true);
  // VPS meldet sich nicht beim Telefonbuch — nie ausblenden.
  assert.equal(istSichtbar(heim({ origin: 'vps', online: false })), true);
  assert.equal(istSichtbar({ ...heim({ online: false }), isCloud: true }), true);
});

import { instanzNachzug, type NachzugEintrag } from '../src/lib/servers/instanzNachzug.ts';

test('Nachzug übernimmt Name und Online-Zustand aus der Cloud, sonst nichts zu tun', () => {
  const e: NachzugEintrag = {
    hostname: 'https://a.relay.x', instance_id: '1', label: 'https://a.relay.x',
    notification_mode: 'mentions', origin: 'app_host', role: 'member',
  };
  const inst = { id: '1', notification_mode: 'mentions' as const, origin: 'app_host' as const, role: 'member' as const };
  // Unbekannt bleibt unbekannt — kein Schreibvorgang.
  assert.equal(instanzNachzug(e, inst, 'https://a.relay.x'), null);
  const neu = instanzNachzug(e, { ...inst, anzeigename: 'Michaels Server', online: false }, 'https://a.relay.x');
  assert.equal(neu?.anzeigename, 'Michaels Server');
  assert.equal(neu?.online, false);
  assert.equal(instanzNachzug(neu!, { ...inst, anzeigename: 'Michaels Server', online: false }, 'https://a.relay.x'), null);
});
