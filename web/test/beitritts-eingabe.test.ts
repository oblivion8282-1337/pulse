import test from 'node:test';
import assert from 'node:assert/strict';
import { beitrittsEingabeZerlegen } from '../src/lib/guilds/beitrittsEingabe.ts';
import { zielHost } from '../src/lib/einladung/einladungsLink.ts';

const CLOUD = 'https://howispulse.com';
const zerlegen = (eingabe: string) => beitrittsEingabeZerlegen(eingabe, CLOUD);

test('Einladungslink und nackter Code', () => {
  assert.deepEqual(zerlegen('https://howispulse.com/invite/abc12345'), {
    kind: 'invite',
    code: 'abc12345',
    host: null
  });
  assert.deepEqual(zerlegen('  abc12345  '), { kind: 'invite', code: 'abc12345', host: null });
  assert.deepEqual(zerlegen('https://howispulse.com/invite/abc12345?x=1&host=chat.firma.de'), {
    kind: 'invite',
    code: 'abc12345',
    host: 'chat.firma.de'
  });
});

test('host= wird dekodiert', () => {
  assert.deepEqual(zerlegen('https://howispulse.com/invite/abc12345?host=chat%2Efirma.de'), {
    kind: 'invite',
    code: 'abc12345',
    host: 'chat.firma.de'
  });
});

test('Kaputtes %-Escape im host: kein Absturz, Rohwert fällt an der Host-Prüfung durch', () => {
  // decodeURIComponent('%zz') wirft URIError; vorher landete dessen Rohtext beim Nutzer.
  const einladung = zerlegen('https://howispulse.com/invite/abc12345?host=%zz');
  assert.deepEqual(einladung, { kind: 'invite', code: 'abc12345', host: '%zz' });
  assert.equal(zielHost('%zz', CLOUD), undefined);

  const adresse = zerlegen('https://howispulse.com/c/mein-club?host=chat%E0%A4%A');
  assert.deepEqual(adresse, { kind: 'public', handle: 'mein-club', host: 'chat%E0%A4%A' });
  assert.equal(zielHost('chat%E0%A4%A', CLOUD), undefined);
});

test('Öffentliche Adresse: Cloud, Self-Host per Link oder host=, nackte Form', () => {
  assert.deepEqual(zerlegen('https://howispulse.com/c/mein-club'), {
    kind: 'public',
    handle: 'mein-club',
    host: null
  });
  assert.deepEqual(zerlegen('https://chat.firma.de/c/mein-club'), {
    kind: 'public',
    handle: 'mein-club',
    host: 'chat.firma.de'
  });
  assert.deepEqual(zerlegen('c/mein-club?host=chat.firma.de'), {
    kind: 'public',
    handle: 'mein-club',
    host: 'chat.firma.de'
  });
  assert.deepEqual(zerlegen('https://howispulse.com/c/Mein-Club'), {
    kind: 'public',
    handle: 'mein-club',
    host: null
  });
});

test('Nackte Hostadresse, aber nicht der Cloud-Host', () => {
  assert.deepEqual(zerlegen('chat.firma.de'), { kind: 'host', host: 'chat.firma.de' });
  assert.deepEqual(zerlegen('https://Chat.Firma.de/'), { kind: 'host', host: 'chat.firma.de' });
  // Die Cloud ist immer schon da — fällt zum Code-Pfad durch und scheitert dort sichtbar.
  assert.equal(zerlegen('https://howispulse.com').kind, 'invite');
});
