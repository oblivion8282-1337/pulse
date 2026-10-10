import test from 'node:test';
import assert from 'node:assert/strict';
import { adresseBauen, einladungsLinkBauen } from '../src/lib/guilds/linkBau.ts';
import { beitrittsEingabeZerlegen } from '../src/lib/guilds/beitrittsEingabe.ts';
import { adresseAusUrl, einladungAusUrl, zielHost } from '../src/lib/einladung/einladungsLink.ts';

const CLOUD = 'https://howispulse.com';
const SEITE = 'howispulse.com';
const WOLKE = { isCloud: true, hostname: CLOUD };
const HEIM = { isCloud: false, hostname: 'https://chat.firma.de' };

test('Cloud und kein aktiver Server: Link ohne host', () => {
  assert.equal(einladungsLinkBauen(CLOUD, 'abc12345', WOLKE), 'https://howispulse.com/invite/abc12345');
  assert.equal(einladungsLinkBauen(CLOUD, 'abc12345', undefined), 'https://howispulse.com/invite/abc12345');
  assert.equal(adresseBauen(CLOUD, 'mein-club', WOLKE), 'https://howispulse.com/c/mein-club');
  assert.equal(adresseBauen(CLOUD, 'mein-club', undefined), 'https://howispulse.com/c/mein-club');
});

test('Self-Host: Link auf die Web-App, Server als host ohne Schema', () => {
  assert.equal(
    einladungsLinkBauen(CLOUD, 'abc12345', HEIM),
    'https://howispulse.com/invite/abc12345?host=chat.firma.de'
  );
  assert.equal(
    adresseBauen(CLOUD, 'mein-club', HEIM),
    'https://howispulse.com/c/mein-club?host=chat.firma.de'
  );
  // Ein Hostname ohne Schema ergibt denselben Link.
  assert.equal(
    adresseBauen(CLOUD, 'mein-club', { isCloud: false, hostname: 'chat.firma.de' }),
    'https://howispulse.com/c/mein-club?host=chat.firma.de'
  );
});

test('Gebaute Links liest die Einladungsseite wieder als dasselbe Ziel', () => {
  assert.deepEqual(einladungAusUrl(einladungsLinkBauen(CLOUD, 'abc12345', HEIM), CLOUD, SEITE), {
    code: 'abc12345',
    host: 'chat.firma.de'
  });
  assert.deepEqual(einladungAusUrl(einladungsLinkBauen(CLOUD, 'abc12345', WOLKE), CLOUD, SEITE), {
    code: 'abc12345',
    host: null
  });
  assert.deepEqual(adresseAusUrl(adresseBauen(CLOUD, 'mein-club', HEIM), CLOUD, SEITE), {
    handle: 'mein-club',
    host: 'chat.firma.de'
  });
  assert.deepEqual(adresseAusUrl(adresseBauen(CLOUD, 'mein-club', WOLKE), CLOUD, SEITE), {
    handle: 'mein-club',
    host: null
  });
});

test('Gebaute Links ins Beitrittsfeld kopiert ergeben dasselbe Ziel', () => {
  assert.deepEqual(beitrittsEingabeZerlegen(einladungsLinkBauen(CLOUD, 'abc12345', HEIM), CLOUD), {
    kind: 'invite',
    code: 'abc12345',
    host: 'chat.firma.de'
  });
  assert.deepEqual(beitrittsEingabeZerlegen(adresseBauen(CLOUD, 'mein-club', HEIM), CLOUD), {
    kind: 'public',
    handle: 'mein-club',
    host: 'chat.firma.de'
  });
  assert.deepEqual(beitrittsEingabeZerlegen(adresseBauen(CLOUD, 'mein-club', WOLKE), CLOUD), {
    kind: 'public',
    handle: 'mein-club',
    host: null
  });
  // Der Host aus dem Link besteht die strenge Prüfung beim Beitritt.
  assert.equal(zielHost('chat.firma.de', CLOUD), 'chat.firma.de');
});
