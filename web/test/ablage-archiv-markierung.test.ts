import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bestimmeArchivWechsel } from '../src/lib/ablage/archivMarkierung.ts';

// `verbindungen.svelte.ts` selbst ist wegen der Svelte-Runes in Nodes
// Testlaeufer nicht direkt ladbar (CLAUDE.md „Die Falle"). Geprueft wird
// deshalb die reine Rechnung, die `AblageVerbindungsStore.setzeArchivMarkierung`
// nutzt.

test('eine Verbindung ohne bisherige Markierung wird zum Archiv, alle anderen bleiben unveraendert', () => {
	const verbindungen = [
		{ id: 'a', istArchiv: false },
		{ id: 'b' },
		{ id: 'c', istArchiv: false }
	];

	const aenderungen = bestimmeArchivWechsel(verbindungen, 'b');

	assert.deepEqual(aenderungen, [{ id: 'b', istArchiv: true }]);
});

test('ein Wechsel setzt die vorige Markierung zurueck — keine zwei Archive gleichzeitig', () => {
	const verbindungen = [
		{ id: 'a', istArchiv: true },
		{ id: 'b', istArchiv: false }
	];

	const aenderungen = bestimmeArchivWechsel(verbindungen, 'b');

	// Beide Aenderungen kommen in EINEM Ergebnis zurueck — der Aufrufer
	// schreibt sie in einer Transaktion (`schreibeMehrere`).
	assert.deepEqual(
		new Set(aenderungen.map((a) => `${a.id}:${a.istArchiv}`)),
		new Set(['a:false', 'b:true'])
	);

	// Angewendet auf die Ausgangsliste darf danach genau EINE Verbindung
	// markiert sein.
	const nachId = new Map(aenderungen.map((a) => [a.id, a.istArchiv]));
	const ergebnis = verbindungen.map((v) => ({ ...v, istArchiv: nachId.get(v.id) ?? v.istArchiv }));
	assert.equal(ergebnis.filter((v) => v.istArchiv).length, 1);
	assert.equal(ergebnis.find((v) => v.istArchiv)?.id, 'b');
});

test('erneutes Waehlen der bereits markierten Verbindung schaltet die Markierung aus — kein Archiv bleibt zurueck', () => {
	const verbindungen = [
		{ id: 'a', istArchiv: true },
		{ id: 'b', istArchiv: false }
	];

	const aenderungen = bestimmeArchivWechsel(verbindungen, 'a');

	assert.deepEqual(aenderungen, [{ id: 'a', istArchiv: false }]);
});

test('eine unbekannte Id ergibt keine Aenderung', () => {
	const verbindungen = [{ id: 'a', istArchiv: true }];

	const aenderungen = bestimmeArchivWechsel(verbindungen, 'unbekannt');

	assert.deepEqual(aenderungen, []);
});

test('ist schon keine Verbindung markiert und wird keine gewaehlt, bleibt alles unveraendert (leere Liste)', () => {
	const aenderungen = bestimmeArchivWechsel([], 'irgendwas');
	assert.deepEqual(aenderungen, []);
});
