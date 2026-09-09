/**
 * Landingpage-Logik (`web/static/landing.js`).
 *
 * Die Datei wird direkt importiert — sie hat keine Abhaengigkeiten, keinen
 * erweiterungslosen Import und keine Rune, ist also fuer Nodes eingebauten
 * Laeufer erreichbar (die zwei Fallen stehen in CLAUDE.md unter
 * „pnpm test:unit"). Ihr `init()` faellt beim Import sofort heraus, weil es
 * kein `document` gibt.
 *
 * Geprueft wird die Plattform-Weiche samt der exakten Download-URLs: sie sind
 * eine Kopie aus `web/src/lib/downloads/appDownloads.ts`, und eine
 * auseinandergelaufene Kopie faellt sonst niemandem auf.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  plattformErkennen,
  appLadenZiel,
  spracheErmitteln,
  eingeloggt,
  WINDOWS_INSTALLER_URL,
  MAC_DMG_URL,
  ANDROID_APK_URL,
  LINUX_FLATPAKREF_URL,
  LINUX_INSTALL_COMMAND
} from '../static/landing.js';
import * as quelle from '../src/lib/downloads/appDownloads.ts';

const UA = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  unbekannt: 'Mozilla/5.0 (PlayStation 5 4.03) AppleWebKit/605.1.15'
};

test('plattformErkennen unterscheidet die vier Ziele', () => {
  assert.equal(plattformErkennen(UA.windows, 'Win32'), 'windows');
  assert.equal(plattformErkennen(UA.mac, 'MacIntel'), 'mac');
  assert.equal(plattformErkennen(UA.linux, 'Linux x86_64'), 'linux');
  assert.equal(plattformErkennen(UA.android, 'Linux armv8l'), 'android');
});

test('Android gewinnt gegen das Linux im eigenen User-Agent', () => {
  // Jeder Android-UA enthaelt „Linux" — die Reihenfolge der Pruefungen ist
  // deshalb keine Geschmacksfrage.
  assert.equal(plattformErkennen(UA.android, ''), 'android');
});

test('iOS und iPadOS liefern null — dort gibt es keine App', () => {
  assert.equal(plattformErkennen(UA.iphone, 'iPhone'), null);
  assert.equal(plattformErkennen(UA.ipad, 'iPad'), null);
});

test('unbekannte Plattform liefert null statt einer Vermutung', () => {
  assert.equal(plattformErkennen(UA.unbekannt, ''), null);
  assert.equal(plattformErkennen(undefined, undefined), null);
});

test('appLadenZiel liefert je Plattform die exakte Quelle', () => {
  assert.deepEqual(appLadenZiel('windows'), {
    art: 'download',
    url: 'https://howispulse.com/updates/win/Pulse-Setup-latest.exe'
  });
  assert.deepEqual(appLadenZiel('mac'), {
    art: 'download',
    url: 'https://howispulse.com/downloads/Pulse-latest.dmg'
  });
  assert.deepEqual(appLadenZiel('android'), {
    art: 'download',
    url: 'https://howispulse.com/downloads/pulse-latest.apk'
  });
  assert.deepEqual(appLadenZiel('linux'), {
    art: 'flatpak',
    befehl:
      'flatpak install --from https://howispulse.com/flatpak/com.howispulse.Pulse.flatpakref'
  });
});

test('ohne Plattform wird nicht geraten, sondern zur Liste gescrollt', () => {
  assert.deepEqual(appLadenZiel(null), { art: 'scrollen', ziel: '#plattformen' });
  assert.deepEqual(appLadenZiel('haiku'), { art: 'scrollen', ziel: '#plattformen' });
});

test('die kopierten URL-Konstanten stimmen mit appDownloads.ts ueberein', () => {
  // Echter Abgleich gegen die Quelle — nicht gegen eine dritte, hier
  // hartcodierte Kopie: die bliebe gruen, wenn appDownloads.ts sich aendert
  // und landing.js nicht mitzieht.
  assert.equal(WINDOWS_INSTALLER_URL, quelle.WINDOWS_INSTALLER_URL);
  assert.equal(MAC_DMG_URL, quelle.MAC_DMG_URL);
  assert.equal(ANDROID_APK_URL, quelle.ANDROID_APK_URL);
  assert.equal(LINUX_FLATPAKREF_URL, quelle.LINUX_FLATPAKREF_URL);
  assert.equal(LINUX_INSTALL_COMMAND, quelle.LINUX_INSTALL_COMMAND);
});

test('spracheErmitteln: gespeicherte Wahl gewinnt', () => {
  assert.equal(spracheErmitteln('en', 'de-DE'), 'en');
  assert.equal(spracheErmitteln('de', 'en-US'), 'de');
});

test('spracheErmitteln: sonst deutsch nur bei deutscher Browsersprache', () => {
  assert.equal(spracheErmitteln(null, 'de'), 'de');
  assert.equal(spracheErmitteln(null, 'de-AT'), 'de');
  assert.equal(spracheErmitteln(null, 'DE-CH'), 'de');
  assert.equal(spracheErmitteln(null, 'en-GB'), 'en');
  assert.equal(spracheErmitteln(null, 'fr-FR'), 'en');
  assert.equal(spracheErmitteln(null, undefined), 'en');
});

test('spracheErmitteln ignoriert Muell im Speicher', () => {
  assert.equal(spracheErmitteln('klingon', 'de-DE'), 'de');
});

test('eingeloggt haengt allein am Refresh-Token', () => {
  const mit = { getItem: (k: string) => (k === 'dcc.tokens.refresh' ? 'abc' : null) };
  const ohne = { getItem: () => null };
  const leer = { getItem: () => '' };
  assert.equal(eingeloggt(mit), true);
  assert.equal(eingeloggt(ohne), false);
  assert.equal(eingeloggt(leer), false);
  assert.equal(eingeloggt(null), false);
});

test('eingeloggt faellt bei blockiertem Speicher auf false zurueck', () => {
  const bloeckt = {
    getItem() {
      throw new Error('SecurityError');
    }
  };
  assert.equal(eingeloggt(bloeckt), false);
});
