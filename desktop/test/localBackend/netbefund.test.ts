/**
 * Die Deutung eines TLS-Handschlags.
 *
 * **Warum es diesen Test gibt.** Der teuerste Ausgang ist nicht „ungenau",
 * sondern: wir erklären ein Zertifikat für gültig, das der Browser gleich
 * darauf ablehnt. Der Betreiber sucht dann an der Stelle, an der wir grün
 * gemeldet haben — also überall ausser dort, wo der Fehler ist. Der
 * Platzhalter-Vergleich ist dabei die Stelle, an der man das am leichtesten
 * verschenkt (RFC 6125: genau EINE Ebene).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  passtName,
  deuteZertifikat,
  zertifikatsNamen,
  WARNFRIST_MS,
  type Zertifikatslage,
} from '../../electron/localBackend/netbefund.ts';

const JETZT = 1_800_000_000_000;
const lage = (teil: Partial<Zertifikatslage> = {}): Zertifikatslage => ({
  namen: ['chat.firma.de'],
  gueltigBis: JETZT + 90 * 24 * 3600 * 1000,
  fehler: null,
  ...teil,
});

test('passtName — der genaue Name passt, egal wie geschrieben', () => {
  assert.equal(passtName('chat.firma.de', 'chat.firma.de'), true);
  assert.equal(passtName('CHAT.Firma.DE', 'chat.firma.de'), true);
  assert.equal(passtName(' chat.firma.de ', 'chat.firma.de'), true);
});

test('passtName — der Platzhalter deckt GENAU eine Ebene', () => {
  assert.equal(passtName('*.firma.de', 'chat.firma.de'), true);
  // Die drei Fälle, die man zu leicht durchwinkt:
  assert.equal(passtName('*.firma.de', 'firma.de'), false);        // die Wurzel selbst
  assert.equal(passtName('*.firma.de', 'a.chat.firma.de'), false); // zwei Ebenen
  assert.equal(passtName('*.firma.de', 'chat.firmax.de'), false);  // Grenze ohne Punkt
});

test('passtName — ein Platzhalter auf der obersten Ebene deckt nichts', () => {
  // `*.de` wäre ein Zertifikat für das halbe Internet; Aussteller vergeben es
  // nicht, aber ein selbstgebautes kann es tragen.
  assert.equal(passtName('*.de', 'firma.de'), false);
  assert.equal(passtName('*', 'firma.de'), false);
});

test('passtName — leere Angaben passen auf nichts', () => {
  assert.equal(passtName('', 'chat.firma.de'), false);
  assert.equal(passtName('chat.firma.de', ''), false);
});

test('deuteZertifikat — der gute Fall', () => {
  assert.equal(deuteZertifikat('chat.firma.de', lage(), JETZT), 'gueltig');
  assert.equal(deuteZertifikat('chat.firma.de', lage({ namen: ['*.firma.de'] }), JETZT), 'gueltig');
});

test('deuteZertifikat — der falsche Name schlägt den Fehlercode', () => {
  // Node meldet je nach Verbindungsweg mal ALTNAME_INVALID, mal gar nichts
  // (ohne `servername`). Der Namensvergleich ist in beiden Fällen die
  // konkretere Auskunft und muss deshalb zuerst greifen.
  assert.equal(
    deuteZertifikat('chat.firma.de', lage({ namen: ['andere.de'], fehler: null }), JETZT),
    'falscher-name',
  );
  assert.equal(
    deuteZertifikat(
      'chat.firma.de',
      lage({ namen: ['andere.de'], fehler: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
      JETZT,
    ),
    'falscher-name',
  );
});

test('deuteZertifikat — die Fehlercodes mit eigener Handlung', () => {
  const mit = (fehler: string) => deuteZertifikat('chat.firma.de', lage({ fehler }), JETZT);
  assert.equal(mit('CERT_HAS_EXPIRED'), 'abgelaufen');
  assert.equal(mit('DEPTH_ZERO_SELF_SIGNED_CERT'), 'selbstsigniert');
  assert.equal(mit('SELF_SIGNED_CERT_IN_CHAIN'), 'selbstsigniert');
  assert.equal(mit('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'kette-unvollstaendig');
});

test('deuteZertifikat — ein unbekannter Code wird nicht geraten', () => {
  // Lieber zugeben, dass wir ihn nicht kennen, als eine Handlung erfinden.
  assert.equal(deuteZertifikat('chat.firma.de', lage({ fehler: 'IRGENDWAS_NEUES' }), JETZT), 'unbekannter-fehler');
});

test('deuteZertifikat — Ablauf wird auch ohne Fehlercode gesehen', () => {
  // Wer mit `rejectUnauthorized:false` verbindet, bekommt KEINEN Fehlercode —
  // das Ablaufdatum ist dann die einzige Quelle.
  assert.equal(
    deuteZertifikat('chat.firma.de', lage({ gueltigBis: JETZT - 1 }), JETZT),
    'abgelaufen',
  );
  assert.equal(
    deuteZertifikat('chat.firma.de', lage({ gueltigBis: JETZT + WARNFRIST_MS - 1 }), JETZT),
    'laeuft-bald-ab',
  );
  assert.equal(
    deuteZertifikat('chat.firma.de', lage({ gueltigBis: JETZT + WARNFRIST_MS + 1 }), JETZT),
    'gueltig',
  );
});

test('deuteZertifikat — ohne lesbare Namen wird der Namensvergleich übersprungen', () => {
  // Sonst gälte jedes unlesbare Zertifikat als „falscher Name" — eine
  // Diagnose, die es nicht hergibt.
  assert.equal(deuteZertifikat('chat.firma.de', lage({ namen: [] }), JETZT), 'gueltig');
});

test('zertifikatsNamen — CN und SAN, ohne Dubletten und ohne IP-Einträge', () => {
  assert.deepEqual(
    zertifikatsNamen({
      subject: { CN: 'chat.firma.de' },
      subjectaltname: 'DNS:chat.firma.de, DNS:*.firma.de, IP Address:203.0.113.7',
    }),
    ['chat.firma.de', '*.firma.de'],
  );
});

test('zertifikatsNamen — fehlende Felder ergeben eine leere Liste, keinen Absturz', () => {
  assert.deepEqual(zertifikatsNamen({}), []);
  assert.deepEqual(zertifikatsNamen({ subjectaltname: '' }), []);
});
