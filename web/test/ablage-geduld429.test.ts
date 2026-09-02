import { test } from 'node:test';
import assert from 'node:assert/strict';

import { istRatenbegrenzt, mitGeduldBei429, PAUSEN_MS } from '../src/lib/ablage/geduld429.ts';

function fehler429() {
	return Object.assign(new Error('HTTP 429'), { status: 429 });
}

test('ein Erfolg beim ersten Versuch braucht keine Pause', async () => {
	const pausen: number[] = [];
	const wert = await mitGeduldBei429(async () => 7, async (ms) => void pausen.push(ms));
	assert.equal(wert, 7);
	assert.deepEqual(pausen, []);
});

test('429 wird nach steigenden Pausen wiederholt, bis es klappt', async () => {
	const pausen: number[] = [];
	let versuche = 0;
	const wert = await mitGeduldBei429(
		async () => {
			versuche++;
			if (versuche < 3) throw fehler429();
			return 'ok';
		},
		async (ms) => void pausen.push(ms)
	);
	assert.equal(wert, 'ok');
	assert.deepEqual(pausen, [PAUSEN_MS[0], PAUSEN_MS[1]]);
});

test('nach der letzten Pause wird der 429 weitergereicht', async () => {
	let versuche = 0;
	await assert.rejects(
		mitGeduldBei429(
			async () => {
				versuche++;
				throw fehler429();
			},
			async () => {},
			[1, 2]
		),
		(e: unknown) => istRatenbegrenzt(e)
	);
	assert.equal(versuche, 3);
});

test('andere Fehler werden sofort weitergereicht — keine Pause', async () => {
	const pausen: number[] = [];
	await assert.rejects(
		mitGeduldBei429(
			async () => {
				throw Object.assign(new Error('HTTP 502'), { status: 502 });
			},
			async (ms) => void pausen.push(ms)
		),
		/502/
	);
	assert.deepEqual(pausen, []);
});

test('istRatenbegrenzt erkennt nur status 429', () => {
	assert.equal(istRatenbegrenzt(fehler429()), true);
	assert.equal(istRatenbegrenzt(new Error('x')), false);
	assert.equal(istRatenbegrenzt(null), false);
	assert.equal(istRatenbegrenzt({ status: '429' }), false);
});
