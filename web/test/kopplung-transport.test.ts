/**
 * Die Krypto des Verlaufsumzugs (Etappe F).
 *
 * Der wichtigste Test ist der letzte: ein Stueck, das an einer ANDEREN
 * Position eingesetzt wird, laesst sich nicht oeffnen. Ohne die Bindung ueber
 * die zusaetzlichen authentifizierten Daten waere die Reihenfolge des
 * Verlaufs vom Server bestimmbar, obwohl der Inhalt zu bleibt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  base64Aus,
  base64Zu,
  codeHash,
  stueckEntschluesseln,
  stueckVerschluesseln,
  transportSchluessel
} from '../src/lib/kopplung/transport.ts';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

test('codeHash trifft den Wert, den der Server erwartet', async () => {
  // Erzeugt mit demselben Rezept wie ``test_kopplung.py::_code_hash``:
  //   base64url(sha256(b"pulse-kopplung-v1\x00" + code)) ohne Polsterung.
  // Der erwartete Wert ist NICHT aus dieser Datei berechnet, sondern aus
  // Pythons hashlib — ein selbst berechneter Wert pruefte die eigene
  // Kodierung statt der der Gegenseite (s. CLAUDE.md, dieselbe Fehlerklasse
  // wie beim Base64-Padding).
  const hash = await codeHash('0123456789ABCDEFGHJK');
  assert.equal(hash, 'QQo9WODu4pxCfvS44R3rhpMoRfPKtBBqx5zAdd-lBpo');
});

test('verschiedene Codes ergeben verschiedene Hashes', async () => {
  assert.notEqual(await codeHash('AAAAAAAAAAAAAAAAAAAA'), await codeHash('AAAAAAAAAAAAAAAAAAAB'));
});

test('base64 hin und zurueck', () => {
  const bytes = new Uint8Array([0, 1, 250, 255, 7]);
  assert.deepEqual(base64Zu(base64Aus(bytes)), bytes);
  // Ohne Polsterung eingelesen (so kodiert der Rust-Kern, s. CLAUDE.md).
  assert.deepEqual(base64Zu(base64Aus(bytes).replace(/=+$/, '')), bytes);
});

test('ein Stueck laesst sich mit demselben Code wieder oeffnen', async () => {
  const schluessel = await transportSchluessel('0123456789ABCDEFGHJK', '42');
  const daten = await stueckVerschluesseln(schluessel, '42', 3, ENC.encode('{"saetze":[]}'));
  const klar = await stueckEntschluesseln(schluessel, '42', 3, daten);
  assert.equal(DEC.decode(klar), '{"saetze":[]}');
});

test('ein anderer Code oeffnet es nicht', async () => {
  const a = await transportSchluessel('0123456789ABCDEFGHJK', '42');
  const b = await transportSchluessel('0123456789ABCDEFGHJM', '42');
  const daten = await stueckVerschluesseln(a, '42', 0, ENC.encode('geheim'));
  await assert.rejects(() => stueckEntschluesseln(b, '42', 0, daten));
});

test('eine andere Kopplung oeffnet es nicht', async () => {
  // Die Kopplungs-ID steckt im HKDF-`info`: zwei Umzuege desselben Kontos
  // haben verschiedene Schluessel, auch bei gleichem Code.
  const a = await transportSchluessel('0123456789ABCDEFGHJK', '42');
  const b = await transportSchluessel('0123456789ABCDEFGHJK', '43');
  const daten = await stueckVerschluesseln(a, '42', 0, ENC.encode('geheim'));
  await assert.rejects(() => stueckEntschluesseln(b, '43', 0, daten));
});

test('ein Stueck an einer anderen POSITION laesst sich nicht oeffnen', async () => {
  const schluessel = await transportSchluessel('0123456789ABCDEFGHJK', '42');
  const daten = await stueckVerschluesseln(schluessel, '42', 5, ENC.encode('fuenf'));
  await assert.rejects(() => stueckEntschluesseln(schluessel, '42', 6, daten));
});

test('ein veraendertes Stueck kommt NIE als Bytes zurueck', async () => {
  const schluessel = await transportSchluessel('0123456789ABCDEFGHJK', '42');
  const daten = await stueckVerschluesseln(schluessel, '42', 0, ENC.encode('unversehrt'));
  const bytes = base64Zu(daten);
  bytes[bytes.length - 1] ^= 0x01;
  await assert.rejects(() => stueckEntschluesseln(schluessel, '42', 0, base64Aus(bytes)));
});

test('ein zu kurzes Stueck wirft, statt in die Krypto zu laufen', async () => {
  const schluessel = await transportSchluessel('0123456789ABCDEFGHJK', '42');
  await assert.rejects(
    () => stueckEntschluesseln(schluessel, '42', 0, base64Aus(new Uint8Array(4))),
    /zu kurz/
  );
});
