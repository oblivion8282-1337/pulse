import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	bestimmeSyncOrdnerHauptschlüssel,
	bytesZuBase64,
	base64ZuBytes
} from '../src/lib/ablage/syncOrdnerSchluessel.ts';

// `verbindungen.ts` selbst ist wegen der Svelte-Runes (`$state`, sofort
// instanziiert beim Import) in Nodes Testlaeufer nicht direkt ladbar — siehe
// CLAUDE.md „Die Falle". Geprueft wird deshalb die reine Entscheidung, die
// `AblageVerbindungsStore.hauptschlüsselFürSyncOrdner()` nutzt: Store-Anbindung
// und `$state` bleiben dort duenne Verdrahtung ohne eigene Verzweigung.

test('ohne bestehende Verbindung wird der uebergebene Zufallsschluessel als neu gemeldet', () => {
	const zufallsBytes = new Uint8Array(32).fill(7);

	const ergebnis = bestimmeSyncOrdnerHauptschlüssel(undefined, zufallsBytes);

	assert.equal(ergebnis.istNeu, true);
	assert.deepEqual(ergebnis.hauptschlüssel, zufallsBytes);
	assert.equal(base64ZuBytes(ergebnis.hauptschlüsselB64).length, 32);
	assert.deepEqual(base64ZuBytes(ergebnis.hauptschlüsselB64), zufallsBytes);
});

test('eine bestehende Verbindung liefert ihren eigenen Schluessel zurueck, kein zweiter wird erzeugt', () => {
	const bestehenderSchlüssel = new Uint8Array(32).fill(9);
	const bestehend = { hauptschlüsselB64: bytesZuBase64(bestehenderSchlüssel) };
	// Ein zweiter Aufruf haette andere Zufallsbytes zur Hand — die duerfen
	// nicht in das Ergebnis durchsickern, wenn schon eine Verbindung da ist.
	const andereZufallsBytes = new Uint8Array(32).fill(42);

	const ergebnis = bestimmeSyncOrdnerHauptschlüssel(bestehend, andereZufallsBytes);

	assert.equal(ergebnis.istNeu, false);
	assert.deepEqual(ergebnis.hauptschlüssel, bestehenderSchlüssel);
	assert.equal(ergebnis.hauptschlüsselB64, bestehend.hauptschlüsselB64);
});

test('zwei aufeinanderfolgende Aufrufe mit demselben Store-Zustand ergeben denselben Schluessel', () => {
	// Simuliert „erster Aufruf legt an, zweiter findet wieder": nach dem
	// ersten Aufruf traegt der Store die neu erzeugte Verbindung, der zweite
	// Aufruf bekommt sie als `bestehend` uebergeben.
	const ersterZufall = new Uint8Array(32).fill(1);
	const erstesErgebnis = bestimmeSyncOrdnerHauptschlüssel(undefined, ersterZufall);
	assert.equal(erstesErgebnis.istNeu, true);

	const zweiterZufall = new Uint8Array(32).fill(2);
	const zweitesErgebnis = bestimmeSyncOrdnerHauptschlüssel(
		{ hauptschlüsselB64: erstesErgebnis.hauptschlüsselB64 },
		zweiterZufall
	);

	assert.equal(zweitesErgebnis.istNeu, false);
	assert.deepEqual(zweitesErgebnis.hauptschlüssel, ersterZufall);
	assert.notDeepEqual(zweitesErgebnis.hauptschlüssel, zweiterZufall);
});
