import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flachAdapter, flachName, tiefName } from '../src/lib/sicherung/flachPfad.ts';

test('Ordner-Pfad wird flach und wieder tief — verlustfrei', () => {
	const tief = '88625026856656897/dev-1a2b3c4d-seg-000001.puls';
	const flach = flachName(tief);
	assert.equal(flach.includes('/'), false);
	assert.equal(tiefName(flach), tief);
});

test('Namen ohne Ordner bleiben unverändert', () => {
	assert.equal(flachName('key.puls'), 'key.puls');
	assert.equal(tiefName('attachment-42.puls'), 'attachment-42.puls');
});

test('ein Name mit dem Ersatzzeichen wird abgewiesen statt umgedeutet', () => {
	assert.throws(() => flachName('a~b.puls'));
});

test('der Adapter übersetzt in beide Richtungen und reicht lösche durch', async () => {
	const gesehen: string[] = [];
	const inhalt = new Map<string, Uint8Array>();
	const basis = {
		async schreibe(datei: string, bytes: Uint8Array) {
			gesehen.push(`schreibe ${datei}`);
			inhalt.set(datei, bytes);
		},
		async lese(datei: string) {
			gesehen.push(`lese ${datei}`);
			return inhalt.get(datei) ?? null;
		},
		async liste() {
			return [...inhalt.keys()];
		},
		async lösche(datei: string) {
			gesehen.push(`lösche ${datei}`);
			inhalt.delete(datei);
		}
	};
	const a = flachAdapter(basis);
	await a.schreibe('k1/seg-1.puls', new Uint8Array([1]));
	assert.deepEqual(await a.liste(), ['k1/seg-1.puls']);
	assert.deepEqual(await a.lese('k1/seg-1.puls'), new Uint8Array([1]));
	await a.lösche('k1/seg-1.puls');
	assert.deepEqual(await a.liste(), []);
	assert.deepEqual(gesehen, ['schreibe k1~seg-1.puls', 'lese k1~seg-1.puls', 'lösche k1~seg-1.puls']);
});

test('ohne lösche an der Basis ist lösche ein stilles Nichts', async () => {
	const a = flachAdapter({
		async schreibe() {},
		async lese() {
			return null;
		},
		async liste() {
			return ['x~y'];
		}
	});
	await a.lösche('x/y');
	assert.deepEqual(await a.liste(), ['x/y']);
});
