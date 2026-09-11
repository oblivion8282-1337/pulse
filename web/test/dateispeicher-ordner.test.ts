import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DateiSpeicher } from '../src/lib/ablage/dateispeicher.ts';
import { speicherAdapter } from '../src/lib/ablage/adapter.ts';

const SCHLUESSEL = new Uint8Array(32).fill(7);

function speicher(): DateiSpeicher {
	return new DateiSpeicher(speicherAdapter(), 'test', SCHLUESSEL);
}

function inhalt(n: number): Uint8Array {
	return new Uint8Array(n).fill(1);
}

test('ordner anlegen, hineinladen, filtern — und doppelte Namen abweisen', async () => {
	const s = speicher();
	await s.erstelleOrdner('Fotos', '');
	await s.erstelleOrdner('Urlaub', 'Fotos');
	await s.hochladen('katze.png', 'image/png', inhalt(10), '', 'Fotos');

	const wurzel = await s.liste('');
	assert.deepEqual(
		wurzel.filter((e) => e.istOrdner).map((e) => e.name),
		['Fotos']
	);
	const fotos = await s.liste('Fotos');
	assert.deepEqual(
		fotos.map((e) => [e.name, e.istOrdner === true]),
		[
			['Urlaub', true],
			['katze.png', false]
		]
	);

	await assert.rejects(
		() => s.erstelleOrdner('Fotos', ''),
		/existiert in diesem Ordner bereits/
	);
});

test('ordner löschen reißt den unterbaum mit', async () => {
	const s = speicher();
	await s.erstelleOrdner('Fotos', '');
	await s.hochladen('katze.png', 'image/png', inhalt(5), '', 'Fotos');
	await s.erstelleOrdner('Urlaub', 'Fotos');
	await s.hochladen('strand.png', 'image/png', inhalt(5), '', 'Fotos/Urlaub');
	await s.hochladen('notizen.txt', 'text/plain', inhalt(5), '');

	const fotos = (await s.liste('')).find((e) => e.name === 'Fotos');
	await s.löschen(fotos!.id);

	const rest = await s.liste('');
	// Nur die Datei außerhalb des Ordners bleibt — der Unterbaum ist weg,
	// inklusive verschachtelter Ordner.
	assert.deepEqual(rest.map((e) => e.name), ['notizen.txt']);
});

test('dateien in ordnern bleiben herunterladbar (pfad sitzt am eintrag)', async () => {
	const s = speicher();
	await s.erstelleOrdner('Fotos', '');
	const hoch = await s.hochladen('katze.png', 'image/png', inhalt(7), '', 'Fotos');
	const geladen = await s.herunterladen(hoch.id);
	assert.equal(geladen.name, 'katze.png');
	assert.equal(geladen.inhalt.length, 7);
});
