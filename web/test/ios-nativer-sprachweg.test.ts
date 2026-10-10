import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  abgleichEntscheiden,
  routeZeigtKanal,
  verbindungAusHuelle
} from '../src/lib/voice/nativAbgleich.ts';
import { userIdFromIdentity } from '../src/lib/voice/identity.ts';

// Bughunt 2026-10-11 — die reinen Entscheidungen des nativen Sprachwegs.

test('G1: das Verbindungswort der Huelle wird mit UND ohne Punkt verstanden', () => {
  // Aeltere Huellen schicken LiveKits `description` (`.connected`), neuere
  // das schlichte Wort. Vorher griff der Vergleich mit `connected` nie.
  assert.equal(verbindungAusHuelle('.connected'), 'connected');
  assert.equal(verbindungAusHuelle('connected'), 'connected');
  assert.equal(verbindungAusHuelle('.reconnecting'), 'reconnecting');
  assert.equal(verbindungAusHuelle('disconnected'), 'disconnected');
  assert.equal(verbindungAusHuelle('.disconnecting'), 'disconnecting');
  assert.equal(verbindungAusHuelle('irgendwas'), null);
  assert.equal(verbindungAusHuelle(''), null);
});

const huelle = { kanalId: '42' };
const resume = { serverId: 'cloud', channelId: '42' };

test('E5: haelt die Huelle keinen Raum, gibt es nichts abzugleichen', () => {
  assert.equal(abgleichEntscheiden({ huelle: null, resume, aktiverServer: 'cloud' }), 'nichts');
  assert.equal(
    abgleichEntscheiden({ huelle: { kanalId: '' }, resume, aktiverServer: 'cloud' }),
    'nichts'
  );
});

test('E5: ein bestaetigter Raum wird uebernommen statt neu betreten', () => {
  assert.equal(abgleichEntscheiden({ huelle, resume, aktiverServer: 'cloud' }), 'uebernehmen');
});

test('E5: ein Raum ohne Beleg wird verlassen, nie unsichtbar weitergefuehrt', () => {
  // Kein Eintrag: geloescht beim Auflegen, Abmelden oder Kontowechsel — der
  // Raum gehoert womoeglich einem anderen Konto.
  assert.equal(abgleichEntscheiden({ huelle, resume: null, aktiverServer: 'cloud' }), 'verlassen');
  // Anderer aktiver Server: andere Token-/Mitgliedschafts-Welt.
  assert.equal(abgleichEntscheiden({ huelle, resume, aktiverServer: 'selfhost-7' }), 'verlassen');
  // Anderer Kanal: der Eintrag beschreibt nicht diesen Raum.
  assert.equal(
    abgleichEntscheiden({ huelle, resume: { ...resume, channelId: '43' }, aktiverServer: 'cloud' }),
    'verlassen'
  );
});

test('M3: die native Ansicht nur auf der Kanal-Route desselben Kanals', () => {
  assert.equal(routeZeigtKanal('/app/guilds/7/channels/42', '42'), true);
  assert.equal(routeZeigtKanal('/app/guilds/7/channels/42/', '42'), true);
  // voice_pull / Wiederaufnehmen: man steht woanders.
  assert.equal(routeZeigtKanal('/app/@me/99', '42'), false);
  assert.equal(routeZeigtKanal('/app/guilds/7/channels/41', '42'), false);
  // Segmentgrenze, und die Rechte-Unterseite ist nicht der Kanal.
  assert.equal(routeZeigtKanal('/app/guilds/7/channels/421', '42'), false);
  assert.equal(routeZeigtKanal('/app/guilds/7/channels/42/permissions', '42'), false);
  assert.equal(routeZeigtKanal('/app/guilds/7/channels/42', ''), false);
});

test('Sitzungs-Zusatz: dieselbe Regel, die die Huelle seit 2026-10-11 nachbaut', () => {
  // `SpracheRaum.nutzerId(aus:)` in `SpracheRaumZustand.swift` folgt genau
  // diesen Faellen; vorher schnitt die Huelle nur `user-` ab und lieferte
  // `123~ab12` als Nutzer-Id.
  assert.equal(userIdFromIdentity('user-123'), '123');
  assert.equal(userIdFromIdentity('user-123~ab12'), '123');
  assert.equal(userIdFromIdentity('user-123~'), null);
  assert.equal(userIdFromIdentity('user-123~XY'), null);
  assert.equal(userIdFromIdentity('gast-5'), null);
  assert.equal(userIdFromIdentity('probe-ios'), null);
});
