import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zusammenfuegen } from '../src/lib/verlauf/zusammenfuegen.ts';

type Posten = { id: string; bearbeitetAm: string | null; geloescht: boolean; inhalt: string };

function posten(id: string, inhalt: string, opts: Partial<Posten> = {}): Posten {
  return { id, inhalt, bearbeitetAm: null, geloescht: false, ...opts };
}

test('doppelte Nachrichten erscheinen genau einmal', () => {
  const lokal = [posten('1', 'hallo')];
  const vomServer = [posten('1', 'hallo')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].id, '1');
});

test('der Server gewinnt bei bearbeiteten Nachrichten', () => {
  // Ein Text kann nach dem lokalen Ablegen bearbeitet worden sein. Waere der
  // lokale Stand staerker, zeigte der Klient dauerhaft die alte Fassung —
  // und zwar NUR bei dem, der sie damals empfangen hat.
  const lokal = [posten('1', 'alte fassung')];
  const vomServer = [posten('1', 'neue fassung', { bearbeitetAm: '2026-08-28T10:00:00Z' })];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].inhalt, 'neue fassung');
});

test('ein lokaler Grabstein ueberlebt eine Server-Antwort ohne ihn', () => {
  // Sonst kaeme eine geloeschte Nachricht beim naechsten Nachladen zurueck —
  // der Server liefert geloeschte Nachrichten grundsaetzlich nicht mehr aus,
  // "fehlt beim Server" ist hier also der Regelfall, kein Sonderfall.
  const lokal = [posten('1', 'weg', { geloescht: true })];
  const vomServer: Posten[] = [];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].geloescht, true);
});

test('ein Grabstein bleibt Grabstein, auch wenn der Server die ID noch fuehrt', () => {
  // Randfall der Regel oben: selbst wenn (aus welchem Grund auch immer) der
  // Server noch eine nicht-geloeschte Fassung derselben ID zeigt, gewinnt
  // lokal — der Grabstein ist eine bewusste Nutzeraktion auf DIESEM Geraet.
  const lokal = [posten('1', 'weg', { geloescht: true })];
  const vomServer = [posten('1', 'wieder da')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.equal(ergebnis.length, 1);
  assert.equal(ergebnis[0].geloescht, true);
});

test('die Reihenfolge bleibt die der Nachrichten-IDs', () => {
  const lokal = [posten('20', 'zwanzig'), posten('9', 'neun')];
  const vomServer = [posten('100', 'hundert')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.deepEqual(
    ergebnis.map((p) => p.id),
    ['9', '20', '100']
  );
});

test('eine AELTERE verschluesselte Nachricht sortiert vor einer NEUEREN unverschluesselten', () => {
  // Kern des Bughunt-Fund 1: `krypto/senden.ts::lokaleNachrichtId()` praegt
  // eine FEST 20-stellige ID (13-stelliger Date.now() + 7 Zufallsstellen),
  // eine echte Snowflake hat heute 17 Stellen. Ein reiner GROESSENVERGLEICH
  // der rohen IDs — ob "Laenge zuerst" (der Fehler) oder "auf gemeinsame
  // Breite auffuellen, dann lexikografisch" (die im Bugreport vorgeschlagene
  // Reparatur) — liefert fuer dieses Paar IMMER dasselbe Ergebnis: eine
  // 20-stellige Zahl ist immer groesser als eine 17-stellige, unabhaengig
  // vom Zeitpunkt. Deshalb dekodiert `vergleicheId` stattdessen die
  // eingebettete Unix-Millisekunde aus beiden ID-Schemata (s. Kommentar
  // dort) und vergleicht DIE — das faengt genau diesen Fall auf.
  //
  // Lokale ID: Date.now() = 1700000000000 (2023-11-14) + Zufall "1234567".
  const verschluesseltAelter = posten('1700000000000123456', 'verschluesselt, aelter');
  // Echte Snowflake: 5000 ms nach dem Snowflake-Epoch (2026-01-01 + 5 s) —
  // deutlich SPAETER als die lokale ID oben, obwohl numerisch/laengenmaessig
  // "kleiner". delta_ms(5000) << 22 Bit = 5000 * 4194304 = 20971520000.
  const klartextNeuer = posten('20971520000', 'klartext, neuer');
  const ergebnis = zusammenfuegen([verschluesseltAelter], [klartextNeuer]);
  assert.deepEqual(
    ergebnis.map((p) => p.id),
    ['1700000000000123456', '20971520000']
  );
});

test('ein rein lokaler Posten ohne Server-Gegenstueck bleibt erhalten', () => {
  // Der Server liefert nur ein Fenster (z.B. die neuesten 50) — aeltere
  // lokale Historie darf dadurch nicht verschwinden.
  const lokal = [posten('1', 'alt, nur lokal')];
  const vomServer = [posten('2', 'neu, vom server')];
  const ergebnis = zusammenfuegen(lokal, vomServer);
  assert.deepEqual(
    ergebnis.map((p) => p.id),
    ['1', '2']
  );
});
