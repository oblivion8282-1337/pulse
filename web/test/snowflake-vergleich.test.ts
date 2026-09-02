import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareSnowflakeId } from '../src/lib/utils/snowflake.ts';

test('eine AELTERE lokale (20-stellige) ID sortiert vor einer NEUEREN echten Snowflake (17-stellig)', () => {
  // Bughunt Fund 1: `compareSnowflakeId` verglich bisher zuerst nach
  // Dezimal-Laenge. Das ist fuer reine Server-Snowflakes korrekt (dort
  // waechst die Laenge monoton mit der Zeit), aber `krypto/senden.ts::
  // lokaleNachrichtId()` vergibt eine FEST 20-stellige ID (13-stelliger
  // Date.now() + 7 Zufallsstellen) - eine echte Snowflake hat heute nur
  // 17 Stellen. Eine 20-stellige lokale ID wurde deshalb bisher IMMER als
  // groesser (= neuer) einsortiert, unabhaengig vom echten Zeitpunkt.
  //
  // Lokale ID: Date.now() = 1700000000000 (2023-11-14) + Zufall "1234567".
  const lokalAelter = '17000000000001234567';
  // Echte Snowflake: 5000 ms nach dem Snowflake-Epoch (2026-01-01 + 5 s) -
  // deutlich SPAETER als die lokale ID oben, obwohl numerisch/laengenmaessig
  // kleiner (17 vs. 20 Stellen). delta_ms(5000) << 22 Bit = 5000 * 4194304.
  const serverNeuer = String(5000n * 4194304n); // '20971520000'

  // Vorher (laengen-zuerst): lokalAelter (20 Stellen) > serverNeuer (11
  // Stellen) -> compareSnowflakeId liefert > 0, obwohl serverNeuer zeitlich
  // NEUER ist. Das ist der Fehler.
  const ergebnis = compareSnowflakeId(lokalAelter, serverNeuer);
  assert.ok(
    ergebnis < 0,
    `compareSnowflakeId(lokalAelter, serverNeuer) muss < 0 sein (lokalAelter ist zeitlich aelter), war ${ergebnis}`
  );
});

test('zwei echte Snowflakes ueber die 17→18-Stellen-Grenze bleiben korrekt geordnet', () => {
  // Regressionsschutz: die urspruengliche "Laenge zuerst"-Logik wurde genau
  // fuer diesen Fall eingefuehrt (Kommentar in der alten Fassung von
  // `compareSnowflakeId`) - die neue, zeitbasierte Rechnung darf ihn nicht
  // wieder kaputt machen.
  const shift = 22n;
  const zeitA = 23841857910n; // ms seit Epoch -> 17-stellige Snowflake
  const zeitB = 23841857911n; // eine ms spaeter -> 18-stellige Snowflake
  const a = (zeitA << shift).toString();
  const b = (zeitB << shift).toString();
  assert.ok(a.length < b.length, 'Testaufbau: a soll kuerzer als b sein');
  assert.ok(compareSnowflakeId(a, b) < 0, 'die spaetere (laengere) Snowflake muss groesser sein');
});

test('gleiche Laenge, reiner Zeitunterschied bleibt korrekt (bestehendes Verhalten)', () => {
  assert.ok(compareSnowflakeId('86840432528457728', '86840432528457729') < 0);
  assert.ok(compareSnowflakeId('86840432528457729', '86840432528457728') > 0);
  assert.equal(compareSnowflakeId('86840432528457728', '86840432528457728'), 0);
});

test('eine vorlaeufige `tmp-`-ID laesst den Vergleich nicht abstuerzen', () => {
  // Drittes ID-Schema, das der Vergleich bisher nicht kannte:
  // `chat/dmKlartextSenden.ts:38` vergibt fuer die optimistische Kopie einer
  // noch nicht bestaetigten Nachricht `tmp-${nonce}` mit
  // `nonce = n-${Date.now()}-${4 Hexstellen}`. Der Modulkopf von
  // `snowflakeZeit.ts` sprach von genau ZWEI Schemata; auf dieses dritte
  // fiel die Rechnung auf `BigInt(id)` durch und warf
  // `SyntaxError: Cannot convert tmp-n-... to a BigInt`.
  //
  // Beobachtet im Playwright-Lauf vom 2026-08-31 als unbehandelter Fehler,
  // ausgeloest sowohl aus der Community-Kanal-Route als auch aus der
  // DM-Route, jeweils beim Senden.
  const vorlaeufig = 'tmp-n-1788205583767-a820';
  const echt = String(5000n * 4194304n);
  assert.doesNotThrow(() => compareSnowflakeId(vorlaeufig, echt));
  assert.doesNotThrow(() => compareSnowflakeId(echt, vorlaeufig));
  assert.doesNotThrow(() => compareSnowflakeId(vorlaeufig, vorlaeufig));
});

test('eine vorlaeufige ID sortiert nach ihrer eingebetteten Zeit, nicht ans Ende geraten', () => {
  // Die Nonce traegt `Date.now()` an derselben Stelle wie die lokale ID ihre
  // ersten 13 Ziffern — es gibt also eine echte Zeit zu vergleichen, und die
  // ist die richtige Ordnung: die optimistische Kopie steht dort, wo die
  // bestaetigte Nachricht gleich stehen wird.
  const frueh = 'tmp-n-1788205583767-a820';
  const spaet = 'tmp-n-1788205583999-b111';
  assert.ok(compareSnowflakeId(frueh, spaet) < 0, 'frueher gesendet muss vorne stehen');
  assert.ok(compareSnowflakeId(spaet, frueh) > 0);
  assert.equal(compareSnowflakeId(frueh, frueh), 0);
});

test('eine vorlaeufige ID steht hinter einer echten Snowflake derselben Millisekunde', () => {
  // Gleichstand nach Zeit braucht einen Tiebreak, und `BigInt(a)` ist dafuer
  // nicht mehr benutzbar (die vorlaeufige ID ist keine Ziffernfolge). Die
  // optimistische Kopie gehoert hinter die bestaetigte Nachricht: sie ist per
  // Definition das juengere Ereignis, und die Liste ersetzt sie gleich.
  const msSeitEpoche = 5000n;
  const echt = String(msSeitEpoche << 22n);
  const unixMs = 1767225600000n + msSeitEpoche;
  const vorlaeufig = `tmp-n-${unixMs}-a820`;
  assert.ok(compareSnowflakeId(echt, vorlaeufig) < 0, 'die bestaetigte Nachricht steht vorne');
  assert.ok(compareSnowflakeId(vorlaeufig, echt) > 0);
});
