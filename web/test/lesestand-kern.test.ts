import test from 'node:test';
import assert from 'node:assert/strict';
import {
  istGelesenBis,
  vorwaertsMerge,
  lesestandAnker,
  serverStandUeberholt
} from '../src/lib/stores/lesestandKern.ts';

test('vorwaertsMerge nimmt den zeitlich größeren Stand', () => {
  assert.equal(vorwaertsMerge('900000000000000001', '900000000000000002'), '900000000000000002');
  assert.equal(vorwaertsMerge('900000000000000002', '900000000000000001'), '900000000000000002');
  assert.equal(vorwaertsMerge(undefined, '900000000000000001'), '900000000000000001');
  // Stellen-Grenze: 18 Ziffern (künftiger Snowflake) schlagen 17 — der
  // eingebettete-Zeit-Vergleich ordnet das korrekt, ein String-Vergleich täte es nicht.
  assert.equal(vorwaertsMerge('99999999999999999', '100000000000000000'), '100000000000000000');
});

test('istGelesenBis liefert die dreiwertige Antwort', () => {
  assert.equal(istGelesenBis(undefined, '100'), null);
  assert.equal(istGelesenBis('150', '100'), true);
  assert.equal(istGelesenBis('150', '150'), true);
  assert.equal(istGelesenBis('150', '200'), false);
});

// Befund B3 (Testrunde echtes Gerät 2026-09-11): Empfänger kannte die
// Nachricht unter der Zustellungs-ID (Server-Snowflake), der Sender
// vergleicht gegen seine lokale ID — gleiche Nachricht, ~200 ms
// auseinander, Häkchen blieb für immer einfach.
test('lesestandAnker nimmmt die kanonische Absender-ID, sonst die eigene', () => {
  // Empfangene verschlüsselte Nachricht: Zustellungs-ID + mitgekommene
  // Absender-ID (exakte Werte aus dem Befund).
  const empfangen = { id: '91878994424635393', krypto_id: '1789131259499624939' };
  assert.equal(lesestandAnker(empfangen), '1789131259499624939');
  // Eigene Nachricht (Sendegerät) und Klartext-Weg: keine krypto_id.
  assert.equal(lesestandAnker({ id: '1789131259499624939' }), '1789131259499624939');
});

test('Anker auf der kanonischen ID schließt den B3-Kreis', () => {
  const lokaleId = '1789131259499624939';
  const zustellungsId = '91878994424635393';
  // Empfänger anchor't den gemeldeten Lesestand an der kanonischen ID:
  const partnerStand = lesestandAnker({ id: zustellungsId, krypto_id: lokaleId });
  // alt (kaputt): Stand an der Zustellungs-ID, Vergleich gegen die lokale ID
  assert.equal(istGelesenBis(zustellungsId, lokaleId), false);
  // neu: beide Seiten führen dieselbe Kennung → Häkchen kommt zustande
  assert.equal(istGelesenBis(partnerStand, lokaleId), true);
});

test('serverStandUeberholt: kein Serverstand → nichts zu raeumen', () => {
	assert.equal(serverStandUeberholt(undefined, '100'), false);
	assert.equal(serverStandUeberholt(null, '100'), false);
});

test('serverStandUeberholt: ohne eigenen Stand ist nichts belegt', () => {
	// Sieht nach Fremdlesen aus, ist aber der Normalfall nach einem Neuladen:
	// der Serverstand kann ALT sein und unter den lokal gezaehlten Nachrichten
	// liegen. Haette die Regel hier true gesagt, waeren echte Ungelesene beim
	// Oeffnen der App weg — und nichts haette sie wieder hochgezaehlt.
	assert.equal(serverStandUeberholt('100', undefined), false);
	assert.equal(serverStandUeberholt('100', null), false);
});

test('serverStandUeberholt: gleicher Stand ist kein Fremdlesen', () => {
	assert.equal(serverStandUeberholt('100', '100'), false);
});

test('serverStandUeberholt: hoeherer Serverstand ueberholt', () => {
	assert.equal(serverStandUeberholt('101', '100'), true);
});

test('serverStandUeberholt: niedrigerer Serverstand ueberholt nicht', () => {
	// Ein alter Rahmen darf den lokalen Stand nicht nach hinten ziehen.
	assert.equal(serverStandUeberholt('99', '100'), false);
});

test('serverStandUeberholt vergleicht ueber die Stellen-Grenze', () => {
	// 18-stellig > 17-stellig: ein lexikografischer Vergleich sagte hier das
	// Gegenteil (dieselbe Falle wie bei compareSnowflakeId selbst).
	assert.equal(serverStandUeberholt('100000000000000000', '99999999999999999'), true);
});

test('startGelesenBis: eigene letzte Nachricht gilt als gelesen (T13)', async () => {
  const { startGelesenBis } = await import('../src/lib/stores/lesestandKern.ts');
  assert.equal(
    startGelesenBis({
      letzteNachricht: '900000000000000009',
      letzterAutor: '42',
      ich: '42',
      serverStand: '900000000000000001',
      lokalerStand: undefined
    }),
    '900000000000000009'
  );
});

test('startGelesenBis: gar kein Lesestand (frische Installation) gilt als gelesen', async () => {
  const { startGelesenBis } = await import('../src/lib/stores/lesestandKern.ts');
  assert.equal(
    startGelesenBis({
      letzteNachricht: '900000000000000009',
      letzterAutor: '7',
      ich: '42',
      serverStand: null,
      lokalerStand: undefined
    }),
    '900000000000000009'
  );
});

test('startGelesenBis: mit einem Lesestand entscheidet der gewöhnliche Vergleich', async () => {
  const { startGelesenBis } = await import('../src/lib/stores/lesestandKern.ts');
  const grund = { letzteNachricht: '900000000000000009', letzterAutor: '7', ich: '42' };
  assert.equal(startGelesenBis({ ...grund, serverStand: '900000000000000001', lokalerStand: undefined }), null);
  assert.equal(startGelesenBis({ ...grund, serverStand: null, lokalerStand: '900000000000000001' }), null);
  assert.equal(startGelesenBis({ ...grund, letzteNachricht: null, serverStand: null, lokalerStand: undefined }), null);
});
