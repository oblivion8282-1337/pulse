/**
 * Meldet ein Standplatz-Gerät seine Plätze an ALLE seine Server — und nach
 * einem Verbindungsabriss erneut?
 *
 * Zwei Fehler von 2026-08-19, beide in derselben Schleife in
 * `DeviceKiosk.svelte`:
 *
 * 1. Ein Merker für alle Eintragungen und `return` statt `continue`: wer in
 *    der Cloud UND auf einem Self-Host eingetragen war, versorgte nur den
 *    ersten Server; fehlte dem ersten die Verbindung, bekam auch der zweite
 *    nichts.
 * 2. Der Merker überlebte einen Abriss, der Serverzustand nicht
 *    (`device_withdraw` leert die Platzmenge). Das Gerät sendete, galt
 *    serverseitig aber als plattlos.
 *
 * Dazu zwei Prüferbefunde vom selben Tag, die zeigen, dass die reine Rechnung
 * allein nicht reicht:
 *
 * 3. `nachAbriss` gab bei fehlendem Schlüssel DASSELBE Objekt zurück — Svelte 5
 *    invalidiert bei `===` nicht, also war `vergessen()` für genau die Server
 *    ein No-Op, die beim letzten Durchgang unversorgt geblieben waren.
 * 4. Die Verdrahtung in `DeviceKiosk.svelte` warf den Rückgabewert von
 *    `sendDeviceStreams` weg und gab bedingungslos `true` zurück; da
 *    `_sendRaw` nicht wirft, war der `catch`-Zweig toter Code und die hier
 *    geprüfte Zusage („ein Fehlschlag hält die übrigen nicht auf") an der
 *    echten Stelle unbewiesen. Der letzte Block prüft sie am Quelltext.
 *
 * Ausgeführt mit Nodes eingebautem Testläufer: `pnpm test:unit`. Das Modul
 * unter Prüfung importiert bewusst nichts — s. seinen Kopf.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  meldungFaellig,
  meldungenAusfuehren,
  nachAbriss,
  platzSchluessel,
  type MeldeStand,
} from '../src/lib/devices/platzMeldungBuch.ts';

/** Ein Durchgang, der mitschreibt, an wen gemeldet wurde. */
function durchgang(
  stand: MeldeStand,
  serverIds: string[],
  slots: number[],
  ohneVerbindung: string[] = [],
): { stand: MeldeStand; gesendet: string[] } {
  const gesendet: string[] = [];
  const neu = meldungenAusfuehren(stand, serverIds, platzSchluessel(slots), (serverId) => {
    if (ohneVerbindung.includes(serverId)) return false;
    gesendet.push(serverId);
    return true;
  });
  return { stand: neu, gesendet };
}

describe('Platz-Meldung eines Standplatz-Geräts', () => {
  it('versorgt JEDEN eingetragenen Server, nicht nur den ersten', () => {
    const { gesendet } = durchgang({}, ['cloud', 'selbst'], [0]);
    assert.deepEqual(gesendet, ['cloud', 'selbst']);
  });

  it('hält ein Server ohne Verbindung die übrigen nicht auf', () => {
    const { stand, gesendet } = durchgang({}, ['cloud', 'selbst'], [0], ['cloud']);
    assert.deepEqual(gesendet, ['selbst']);
    // Der übersprungene bleibt fällig, der versorgte nicht.
    assert.equal(meldungFaellig(stand, 'cloud', platzSchluessel([0])), true);
    assert.equal(meldungFaellig(stand, 'selbst', platzSchluessel([0])), false);
  });

  it('meldet unveränderte Plätze nicht erneut', () => {
    const erst = durchgang({}, ['cloud'], [0, 1]);
    const zweit = durchgang(erst.stand, ['cloud'], [0, 1]);
    assert.deepEqual(zweit.gesendet, []);
  });

  it('meldet nach einer Änderung der Platzmenge erneut', () => {
    const erst = durchgang({}, ['cloud'], [0]);
    const zweit = durchgang(erst.stand, ['cloud'], [0, 1]);
    assert.deepEqual(zweit.gesendet, ['cloud']);
  });

  it('meldet nach einem Abriss erneut, obwohl sich die Plätze nicht ändern', () => {
    const erst = durchgang({}, ['cloud', 'selbst'], [0]);
    assert.deepEqual(erst.gesendet, ['cloud', 'selbst']);
    // Die Verbindung zu 'cloud' bricht ab und kommt zurück; die
    // Neuanmeldung entwertet den Merker genau dieses Servers.
    const nachher = nachAbriss(erst.stand, 'cloud');
    const zweit = durchgang(nachher, ['cloud', 'selbst'], [0]);
    assert.deepEqual(zweit.gesendet, ['cloud']);
  });

  it('gibt beim Abriss IMMER einen neuen Stand zurück — auch für einen unbekannten Server', () => {
    // Sonst weist `platzMeldung.svelte.ts` dieselbe Referenz zu, Svelte 5
    // invalidiert nicht, und der Effekt läuft nach der Neuanmeldung nicht
    // erneut. Getroffen hätte es genau die Server, die beim letzten Durchgang
    // keine Verbindung hatten — die stehen gar nicht im Merker.
    const stand: MeldeStand = { selbst: platzSchluessel([0]) };
    assert.notEqual(nachAbriss(stand, 'cloud'), stand, 'gleiche Referenz = keine Invalidierung');
    assert.deepEqual(nachAbriss(stand, 'cloud'), stand, 'inhaltlich unverändert');
    assert.notEqual(nachAbriss(stand, 'selbst'), stand);
  });

  it('der Schlüssel hängt an der Menge, nicht an der Reihenfolge', () => {
    assert.equal(platzSchluessel([1, 0]), platzSchluessel([0, 1]));
    assert.notEqual(platzSchluessel([0]), platzSchluessel([0, 1]));
  });
});

describe('Verdrahtung in DeviceKiosk.svelte', () => {
  // Die Komponente ist für Nodes Testläufer nicht importierbar (Svelte-Datei,
  // `$lib`-Aliase). Geprüft wird deshalb der Quelltext auf die eine
  // Eigenschaft, an der die Zusage oben hängt: der Rückgabewert des Sendens
  // muss durchgereicht werden. Wird er wieder weggeworfen, gilt der Merker
  // auch dann als gesetzt, wenn nichts hinausging.
  const quelle = readFileSync(
    join(import.meta.dirname, '..', 'src', 'lib', 'devices', 'components', 'DeviceKiosk.svelte'),
    'utf8',
  ).replace(/\/\/[^\n]*/g, '');

  it('reicht das Ergebnis von sendDeviceStreams durch', () => {
    assert.match(
      quelle,
      /return\s+conn\.sendDeviceStreams\(/,
      'der Rückgabewert von sendDeviceStreams muss der Rückgabewert des Melders sein',
    );
    assert.doesNotMatch(
      quelle,
      /^\s*conn\.sendDeviceStreams\(/m,
      'sendDeviceStreams als Anweisung = Ergebnis weggeworfen (war der Fehler)',
    );
  });

  it('lässt die Rechnung rechnen, statt selbst über den Merker zu entscheiden', () => {
    assert.match(quelle, /platzMeldungen\.ausfuehren\(/);
  });
});
