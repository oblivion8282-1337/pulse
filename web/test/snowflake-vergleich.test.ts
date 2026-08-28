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
