import { test } from 'node:test';
import assert from 'node:assert/strict';

// Bughunt-Runde 3, FIX 2: eine einzelne dauerhaft scheiternde Zustellung darf
// nicht mehr jede nachfolgende Zustellung blockieren (das war die VORHERIGE
// Fassung dieser Datei, s. Modulkopf `postfachSchleife.ts`). Geprueft wird
// die importfreie Verarbeitungs-Schleife.
import { verarbeiteMitWiederherstellung } from '../src/lib/krypto/postfachSchleife.ts';

class Wiederherstellbar extends Error {}
class AndererFehler extends Error {}

test('eine wiederherstellbar scheiternde Zustellung wird uebersprungen, die naechste trotzdem versucht', async () => {
  const versucht: number[] = [];
  let wiederherstellungen = 0;

  const ergebnisse = await verarbeiteMitWiederherstellung(
    [1, 2, 3, 4],
    async (n) => {
      versucht.push(n);
      if (n === 2) throw new Wiederherstellbar('Konto/Sitzung nicht sicherbar');
      return n * 10;
    },
    (err) => err instanceof Wiederherstellbar,
    async () => {
      wiederherstellungen++;
    }
  );

  // GEGENPROBE zur alten Abbruch-Fassung: 3 und 4 muessen versucht worden
  // sein, obwohl 2 gescheitert ist — bei der alten `verarbeiteBisAbbruch`
  // war genau das NICHT der Fall (sie brach nach 2 komplett ab).
  assert.deepEqual(versucht, [1, 2, 3, 4]);
  assert.deepEqual(ergebnisse, [10, 30, 40]);
  assert.equal(wiederherstellungen, 1);
});

test('mehrere wiederherstellbare Fehlschlaege rufen die Wiederherstellung mehrfach auf', async () => {
  let wiederherstellungen = 0;
  const ergebnisse = await verarbeiteMitWiederherstellung(
    [1, 2, 3],
    async (n) => {
      if (n !== 3) throw new Wiederherstellbar('kaputt');
      return 'ok';
    },
    (err) => err instanceof Wiederherstellbar,
    async () => {
      wiederherstellungen++;
    }
  );
  assert.deepEqual(ergebnisse, ['ok']);
  assert.equal(wiederherstellungen, 2);
});

test('ein anderer Fehler wird weitergereicht, statt die Zustellung nur zu ueberspringen', async () => {
  await assert.rejects(
    verarbeiteMitWiederherstellung(
      [1, 2],
      async (n) => {
        if (n === 1) throw new AndererFehler('unlesbarer Umschlag');
        return n;
      },
      (err) => err instanceof Wiederherstellbar,
      async () => {}
    ),
    AndererFehler
  );
});

test('ohne Fehler laeuft die gesamte Liste durch, ohne Wiederherstellung', async () => {
  let wiederherstellungen = 0;
  const ergebnisse = await verarbeiteMitWiederherstellung(
    [1, 2, 3],
    async (n) => n * 2,
    () => true,
    async () => {
      wiederherstellungen++;
    }
  );
  assert.deepEqual(ergebnisse, [2, 4, 6]);
  assert.equal(wiederherstellungen, 0);
});
