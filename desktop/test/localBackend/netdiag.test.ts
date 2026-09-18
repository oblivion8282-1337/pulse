/**
 * Der SSRF-Adress-Check der Netzdiagnose.
 *
 * **Warum es diesen Test gibt.** `netdiag:check` ist ein IPC-Kanal, über den
 * der Renderer den Hauptprozess zu Verbindungen bewegt — die Adress-Prüfung
 * nach der DNS-Auflösung (resolve-then-check, Security-Scan 2026-09-18) ist
 * die Schranke gegen Rebinding/nip.io. Ein Fehler hier macht den Kanal wieder
 * zur Portscan-Primitive gegen Docker-Bridge, Router und Cloud-Metadaten.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { istPrivateAdresse } from '../../electron/localBackend/netdiag.ts';

test('istPrivateAdresse — private/spezelle v4-Ranges werden erkannt', () => {
  const privat = [
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.5',
    '169.254.169.254', // Link-Local — Cloud-Metadaten-Endpoint
    '127.0.0.1',
    '100.64.0.1', // CGNAT
    '0.0.0.0',
  ];
  for (const ip of privat) assert.equal(istPrivateAdresse(ip), true, ip);
});

test('istPrivateAdresse — öffentliche v4 bleiben erreichbar (Grenzen inklusive)', () => {
  // 172.15/172.32 grenzen an die privaten 172.16/12 — der klassische Off-by-one
  const offen = ['8.8.8.8', '203.0.113.10', '172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1'];
  for (const ip of offen) assert.equal(istPrivateAdresse(ip), false, ip);
});

test('istPrivateAdresse — v6: ULA, Link-Local, Loopback, v4-mapped', () => {
  const privat = ['::1', '::', 'fd00::1', 'fc12:3456::1', 'fe80::1', 'febf::1', '::ffff:10.0.0.1'];
  for (const ip of privat) assert.equal(istPrivateAdresse(ip), true, ip);
  assert.equal(istPrivateAdresse('2606:4700::1111'), false);
  assert.equal(istPrivateAdresse('::ffff:8.8.8.8'), false);
  assert.equal(istPrivateAdresse('fec0::1'), false); // site-local ist GESTRICHEN (RFC 3879) — kein Block nötig
});
