import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gleicheOeffentlicheIpAb, taugtAlsOeffentlicheIp } from '../../electron/localBackend/oeffentlicheIp.ts';

test('öffentliche Adressen taugen, private und Sonderbereiche nicht', () => {
  assert.equal(taugtAlsOeffentlicheIp('46.128.161.204'), true);
  for (const ip of ['192.168.178.87', '10.0.0.1', '172.17.0.2', '127.0.0.1', '169.254.1.1',
    '100.77.73.26', '0.0.0.0', '256.1.1.1', '1.2.3', '', null, '::1']) {
    assert.equal(taugtAlsOeffentlicheIp(ip), false, String(ip));
  }
  // 172.32.x liegt außerhalb von 172.16/12 und ist öffentlich.
  assert.equal(taugtAlsOeffentlicheIp('172.32.0.1'), true);
});

function deps(ermittelt: string | null, gesetzt: string | null) {
  const gesetzte: string[] = [];
  return {
    gesetzte,
    d: {
      ermittle: async () => ermittelt,
      gesetzte: async () => gesetzt,
      setze: async (ip: string) => { gesetzte.push(ip); },
    },
  };
}

test('IP-Wechsel: neue Adresse wird gesetzt', async () => {
  const { d, gesetzte } = deps('198.51.100.9', '203.0.113.7');
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gesetzt');
  assert.deepEqual(gesetzte, ['198.51.100.9']);
});

test('gleiche Adresse: LiveKit bleibt in Ruhe', async () => {
  const { d, gesetzte } = deps('203.0.113.7', '203.0.113.7');
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gleich');
  assert.deepEqual(gesetzte, []);
});

test('Container lief noch im STUN-Weg (keine node_ip): wird umgestellt', async () => {
  const { d, gesetzte } = deps('203.0.113.7', '');
  assert.equal(await gleicheOeffentlicheIpAb(d), 'gesetzt');
  assert.deepEqual(gesetzte, ['203.0.113.7']);
});

test('Netzstörung oder unlesbarer Stand: nichts anfassen', async () => {
  for (const [ermittelt, gesetzt] of [[null, '203.0.113.7'], ['192.168.1.2', '203.0.113.7'], ['203.0.113.7', null]] as const) {
    const { d, gesetzte } = deps(ermittelt, gesetzt);
    assert.equal(await gleicheOeffentlicheIpAb(d), 'unbekannt');
    assert.deepEqual(gesetzte, []);
  }
});
