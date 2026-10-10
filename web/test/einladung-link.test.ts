import test from 'node:test';
import assert from 'node:assert/strict';
import {
  istGueltigerCode,
  istGueltigerHost,
  zielHost,
  einladungAusUrl,
  ersteEinladungImText,
  mitEinladung,
  ohneEinladung,
  einladungAusParametern,
  klickAbfangen,
  deepLinkWeg,
  deepLinkWiederholung,
  type KlickArt
} from '../src/lib/einladung/einladungsLink.ts';

const CLOUD = 'https://howispulse.com';
const SEITE = 'howispulse.com';

test('Code-Form wie im Desktop-Deep-Link', () => {
  assert.equal(istGueltigerCode('abc12345'), true);
  assert.equal(istGueltigerCode('ab_c-12'), true);
  assert.equal(istGueltigerCode('abc12'), false);
  assert.equal(istGueltigerCode('abc12345.'), false);
  assert.equal(istGueltigerCode('a'.repeat(65)), false);
});

test('Host-Prüfung lehnt ab, woran Browser und Python verschieden lesen', () => {
  assert.equal(istGueltigerHost('pulse.beispiel-verein.de'), true);
  for (const h of [
    'evil.example\\@victim.example',
    'user@pulse.example.de',
    'pulse.example.de:8443',
    'pulse.example.de/pfad',
    '192.168.1.1',
    '0x7f.0.0.1',
    '0177.0.0.1',
    'localhost',
    ''
  ]) {
    assert.equal(istGueltigerHost(h), false, h);
  }
});

test('zielHost: Schreibweisen und Cloud', () => {
  assert.equal(zielHost('HTTPS://Pulse.Example.de/', CLOUD), 'pulse.example.de');
  assert.equal(zielHost('pulse.example.de', CLOUD), 'pulse.example.de');
  assert.equal(zielHost('howispulse.com', CLOUD), null);
  assert.equal(zielHost('https://HowIsPulse.com/', CLOUD), null);
  assert.equal(zielHost(null, CLOUD), null);
  assert.equal(zielHost('', CLOUD), null);
  assert.equal(zielHost('evil.example\\@victim.example', CLOUD), undefined);
});

test('einladungAusUrl: Cloud, Self-Host, host an beliebiger Stelle', () => {
  assert.deepEqual(einladungAusUrl('https://howispulse.com/invite/abc12345', CLOUD, SEITE), {
    code: 'abc12345',
    host: null
  });
  assert.deepEqual(
    einladungAusUrl('https://howispulse.com/invite/abc12345?host=pulse.example.de', CLOUD, SEITE),
    { code: 'abc12345', host: 'pulse.example.de' }
  );
  assert.deepEqual(
    einladungAusUrl('https://howispulse.com/invite/abc12345?ref=x&host=pulse.example.de', CLOUD, SEITE),
    { code: 'abc12345', host: 'pulse.example.de' }
  );
  assert.deepEqual(einladungAusUrl('http://127.0.0.1:5173/invite/abc12345', CLOUD, '127.0.0.1:5173'), {
    code: 'abc12345',
    host: null
  });
  assert.equal(
    einladungAusUrl(
      'https://howispulse.com/invite/abc12345?host=evil.example%5C%40victim.example', CLOUD, SEITE),
    null
  );
  assert.equal(einladungAusUrl('https://howispulse.com/c/designrunde', CLOUD, SEITE), null);
  assert.equal(einladungAusUrl('https://howispulse.com/invite/abc12345/mehr', CLOUD, SEITE), null);
  assert.equal(einladungAusUrl('javascript:alert(1)//invite/abc12345', CLOUD, SEITE), null);
  assert.equal(einladungAusUrl('kein link', CLOUD, SEITE), null);
});

test('einladungAusUrl: fremde /invite/-Links gehören nicht Pulse', () => {
  for (const u of [
    'https://discord.com/invite/python',
    'https://app.revolt.chat/invite/Testers',
    'https://example.org/invite/my-team-2026'
  ]) {
    assert.equal(einladungAusUrl(u, CLOUD, SEITE), null, u);
  }
});

test('einladungAusUrl: der Seiten-Host zählt, mit Port genau', () => {
  assert.deepEqual(
    einladungAusUrl('http://127.0.0.1:5173/invite/abc12345', CLOUD, '127.0.0.1:5173'),
    { code: 'abc12345', host: null }
  );
  assert.equal(einladungAusUrl('http://127.0.0.1:5174/invite/abc12345', CLOUD, '127.0.0.1:5173'), null);
  assert.deepEqual(
    einladungAusUrl('https://HowIsPulse.com/invite/abc12345', 'howispulse.com', '127.0.0.1:5173'),
    { code: 'abc12345', host: null }
  );
});

test('ersteEinladungImText überspringt fremde Einladungslinks', () => {
  assert.equal(
    ersteEinladungImText(
      'https://discord.com/invite/python und https://howispulse.com/invite/zzz99999',
      CLOUD,
      SEITE
    )?.einladung.code,
    'zzz99999'
  );
  assert.equal(ersteEinladungImText('https://discord.com/invite/python', CLOUD, SEITE), null);
});

test('ersteEinladungImText: Satzzeichen, Klammern, mehrere Links', () => {
  assert.equal(
    ersteEinladungImText('Kommst du? https://howispulse.com/invite/abc12345.', CLOUD, SEITE)?.einladung
      .code,
    'abc12345'
  );
  assert.equal(
    ersteEinladungImText('(https://howispulse.com/invite/abc12345)', CLOUD, SEITE)?.einladung.code,
    'abc12345'
  );
  assert.equal(
    ersteEinladungImText('https://example.org/x https://howispulse.com/invite/zzz99999', CLOUD, SEITE)
      ?.einladung.code,
    'zzz99999'
  );
  assert.equal(
    ersteEinladungImText('  https://howispulse.com/invite/abc12345  ', CLOUD, SEITE)?.roh,
    'https://howispulse.com/invite/abc12345'
  );
  assert.equal(ersteEinladungImText('nur Text', CLOUD, SEITE), null);
});

test('mitEinladung / ohneEinladung lassen den Rest der Adresse stehen', () => {
  assert.equal(
    mitEinladung('/app/guilds/1/channels/2?x=1', { code: 'abc12345', host: null }),
    '/app/guilds/1/channels/2?x=1&einladung=abc12345'
  );
  assert.equal(
    mitEinladung('/app', { code: 'abc12345', host: 'pulse.example.de' }),
    '/app?einladung=abc12345&einladung_host=pulse.example.de'
  );
  assert.equal(ohneEinladung('/app?x=1&einladung=abc12345&einladung_host=a.b'), '/app?x=1');
  assert.equal(ohneEinladung('/app?einladung=abc12345'), '/app');
});

test('einladungAusParametern', () => {
  const p = (s: string) => new URLSearchParams(s);
  assert.equal(einladungAusParametern(p(''), CLOUD), null);
  assert.equal(einladungAusParametern(p('einladung=x'), CLOUD), 'kaputt');
  assert.equal(einladungAusParametern(p('einladung=abc12345&einladung_host=1.2.3.4'), CLOUD), 'kaputt');
  assert.deepEqual(einladungAusParametern(p('einladung=abc12345'), CLOUD), {
    code: 'abc12345',
    host: null
  });
  assert.deepEqual(
    einladungAusParametern(p('einladung=abc12345&einladung_host=howispulse.com'), CLOUD),
    { code: 'abc12345', host: null }
  );
});

test('klickAbfangen: nur der schlichte Linksklick', () => {
  const k = (teil: Partial<KlickArt>): KlickArt => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...teil
  });
  assert.equal(klickAbfangen(k({})), true);
  assert.equal(klickAbfangen(k({ ctrlKey: true })), false);
  assert.equal(klickAbfangen(k({ metaKey: true })), false);
  assert.equal(klickAbfangen(k({ shiftKey: true })), false);
  assert.equal(klickAbfangen(k({ altKey: true })), false);
  assert.equal(klickAbfangen(k({ button: 1 })), false);
  assert.equal(klickAbfangen(k({ defaultPrevented: true })), false);
});

test('deepLinkWeg: Dialog nur auf echten Unterseiten von /app', () => {
  assert.equal(deepLinkWeg('/app/guilds/1/channels/2', true), 'dialog');
  assert.equal(deepLinkWeg('/app/friends', true), 'dialog');
  // genau /app ist ein Durchgangszustand (Weiterleitung verwirft die Query)
  assert.equal(deepLinkWeg('/app', true), 'merken');
  assert.equal(deepLinkWeg('/application', true), 'merken-und-app');
  assert.equal(deepLinkWeg('/invite/abc12345', true), 'merken-und-app');
  assert.equal(deepLinkWeg('/login', false), 'merken');
  assert.equal(deepLinkWeg('/app/friends', false), 'merken');
});

test('Deep-Link-Wiederholung: dieselbe Einladung kurz hintereinander', () => {
  const v = { schluessel: 'abc12345|', zeit: 10_000 };
  assert.equal(deepLinkWiederholung(null, 'abc12345|', 10_000), false);
  assert.equal(deepLinkWiederholung(v, 'abc12345|', 10_500), true);
  assert.equal(deepLinkWiederholung(v, 'abc12345|', 15_000), false);
  assert.equal(deepLinkWiederholung(v, 'xyz98765|', 10_500), false);
  assert.equal(deepLinkWiederholung(v, 'abc12345|', 9_000), false);
});
