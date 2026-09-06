import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	TOKEN_SKEW_SEKUNDEN,
	TokenVorrat,
	type TokenNachschub,
} from '../src/lib/sicherung/tokenVorrat.ts';

/** Zählender Nachschub gegen eine stellbare Uhr. */
function vorratMitUhr(
	bauen: (aufrufe: number) => TokenNachschub | Promise<TokenNachschub>,
): { vorrat: TokenVorrat; aufrufe: () => number; vorrücken: (ms: number) => void } {
	let uhr = 1_000_000;
	let zaehler = 0;
	const vorrat = new TokenVorrat(async () => bauen(++zaehler), () => uhr);
	return {
		vorrat,
		aufrufe: () => zaehler,
		vorrücken: (ms) => {
			uhr += ms;
		},
	};
}

function deferred(): { promise: Promise<void>; loesen: () => void } {
	let loesen!: () => void;
	const promise = new Promise<void>((r) => (loesen = r));
	return { promise, loesen };
}

test('Bestand trägt innerhalb der Laufzeit, nach Laufzeit minus Skew kommt ein neuer Nachschub', async () => {
	const { vorrat, aufrufe, vorrücken } = vorratMitUhr((n) => ({
		zugangsToken: `token-${n}`,
		gueltigSekunden: 3600,
		cachebar: true,
	}));

	assert.equal((await vorrat.holen()).zugangsToken, 'token-1');
	// Auf die Skew-Grenze rücken (eine Millisekunde davor): da trägt der
	// Bestand gerade noch.
	vorrücken((3600 - TOKEN_SKEW_SEKUNDEN) * 1000 - 1);
	assert.equal(vorrat.cachiert(), 'token-1');
	assert.equal((await vorrat.holen()).zugangsToken, 'token-1');
	assert.equal(aufrufe(), 1);
	// Eine Millisekunde hinter der Grenze: neuer Nachschub.
	vorrücken(1);
	assert.equal(vorrat.cachiert(), null);
	assert.equal((await vorrat.holen()).zugangsToken, 'token-2');
	assert.equal(aufrufe(), 2);
});

test('parallele Aufrufe teilen sich EINEN Nachschub (Single-Flight)', async () => {
	let aufrufe = 0;
	const gatter = deferred();
	const vorrat = new TokenVorrat(async () => {
		aufrufe += 1;
		await gatter.promise;
		return { zugangsToken: `token-${aufrufe}`, gueltigSekunden: 3600, cachebar: true };
	});

	const erste = vorrat.holen();
	const zweite = vorrat.holen();
	const dritte = vorrat.holen();
	gatter.loesen();
	const alle = await Promise.all([erste, zweite, dritte]);
	assert.equal(aufrufe, 1);
	assert.deepEqual(
		alle.map((z) => z.zugangsToken),
		['token-1', 'token-1', 'token-1'],
	);
	// Danach trägt der Bestand.
	assert.equal((await vorrat.holen()).zugangsToken, 'token-1');
	assert.equal(aufrufe, 1);
});

test('Fehlschlag wird nicht bestandsfähig — alle Wartenden sehen ihn, der nächste Abruf versucht erneut', async () => {
	let aufrufe = 0;
	const vorrat = new TokenVorrat(async () => {
		aufrufe += 1;
		if (aufrufe === 1) throw new Error('Netz weg');
		return { zugangsToken: 'token-2', gueltigSekunden: 3600, cachebar: true };
	});

	await assert.rejects(() => vorrat.holen(), /Netz weg/);
	assert.equal(vorrat.cachiert(), null);
	assert.equal((await vorrat.holen()).zugangsToken, 'token-2');
	assert.equal(aufrufe, 2);
});

test('ohne gueltigSekunden gilt der Fallback (300 s abzüglich Skew)', async () => {
	const { vorrat, aufrufe, vorrücken } = vorratMitUhr((n) => ({
		zugangsToken: `t${n}`,
		cachebar: true,
	}));

	await vorrat.holen();
	vorrücken((300 - TOKEN_SKEW_SEKUNDEN) * 1000 - 1);
	assert.equal(vorrat.cachiert(), 't1');
	vorrücken(1);
	assert.equal(vorrat.cachiert(), null);
	assert.equal((await vorrat.holen()).zugangsToken, 't2');
	assert.equal(aufrufe(), 2);
});

test('nicht bestandsfähiger Nachschub (Verbindung inzwischen weg) wird nicht gecacht', async () => {
	const { vorrat, aufrufe, vorrücken } = vorratMitUhr((n) => ({
		zugangsToken: `t${n}`,
		gueltigSekunden: 3600,
		cachebar: false,
	}));

	assert.equal((await vorrat.holen()).zugangsToken, 't1');
	assert.equal(vorrat.cachiert(), null);
	vorrücken(1);
	assert.equal((await vorrat.holen()).zugangsToken, 't2');
	assert.equal(aufrufe(), 2);
});

test('leeren() verwirft den Bestand — der nächste Abruf holt neu', async () => {
	const { vorrat, aufrufe } = vorratMitUhr((n) => ({
		zugangsToken: `token-${n}`,
		gueltigSekunden: 3600,
		cachebar: true,
	}));

	await vorrat.holen();
	assert.equal(vorrat.cachiert(), 'token-1');
	vorrat.leeren();
	assert.equal(vorrat.cachiert(), null);
	assert.equal((await vorrat.holen()).zugangsToken, 'token-2');
	assert.equal(aufrufe(), 2);
});
