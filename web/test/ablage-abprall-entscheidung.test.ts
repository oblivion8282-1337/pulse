import { test } from 'node:test';
import assert from 'node:assert/strict';

import { istAbprall } from '../src/lib/ablage/abprallEntscheidung.ts';

class EchteAntwortFehler extends Error {
	constructor(status: number) {
		super(`scheiterte: ${status}`);
		this.name = 'EchteAntwortFehler';
	}
}

test('ein TypeError (fetch ohne Response — Netz-/CORS-Fehler) gilt als Abprall', () => {
	assert.equal(istAbprall(new TypeError('Failed to fetch')), true);
});

test('eine benannte Fehlerklasse mit echtem Status gilt NICHT als Abprall', () => {
	assert.equal(istAbprall(new EchteAntwortFehler(500)), false);
	assert.equal(istAbprall(new EchteAntwortFehler(401)), false);
});

test('ein gewöhnlicher Error gilt nicht als Abprall', () => {
	assert.equal(istAbprall(new Error('irgendwas')), false);
});

test('Nicht-Fehler-Werte gelten nicht als Abprall', () => {
	assert.equal(istAbprall(null), false);
	assert.equal(istAbprall(undefined), false);
	assert.equal(istAbprall('Failed to fetch'), false);
});
