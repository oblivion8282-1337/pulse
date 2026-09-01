import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	stufeEin,
	brauchtHandgriff,
	type VerbindungsRohwerte
} from '../src/lib/ablage/zustand.ts';

/** Alles in Ordnung — die Ausgangslage, von der jeder Fall abweicht. */
function heil(): VerbindungsRohwerte {
	return {
		anmeldungAbgelaufen: false,
		laufwerkWeg: false,
		freieBytes: 1_000_000,
		benoetigteBytes: 0,
		ausstehend: 0
	};
}

test('nichts steht an — gut', () => {
	assert.equal(stufeEin(heil()), 'gut');
});

test('etwas steht aus — hinterher', () => {
	assert.equal(stufeEin({ ...heil(), ausstehend: 7 }), 'hinterher');
});

test('zu wenig Platz schlaegt hinterher', () => {
	// Beides trifft zu: es steht etwas aus, UND es passt nicht. Die Anzeige
	// muss das Nennen, was der Nutzer angehen kann.
	const roh = { ...heil(), ausstehend: 7, freieBytes: 100, benoetigteBytes: 500 };
	assert.equal(stufeEin(roh), 'kein-platz');
});

test('meldet der Anbieter keinen freien Platz, wird nichts behauptet', () => {
	// Aus einem fehlenden Wert „vermutlich voll" zu machen waere eine
	// Warnung, die niemand ueberpruefen kann — und die deshalb bald
	// uebersehen wird. Dropbox und Drive melden ihr Kontingent, ein
	// Sync-Ordner nicht.
	const roh = { ...heil(), ausstehend: 7, freieBytes: null, benoetigteBytes: 10 ** 12 };
	assert.equal(stufeEin(roh), 'hinterher');
});

test('genau passend ist kein Platzmangel', () => {
	// Grenzfall: `>` und nicht `>=`. Wer die Grenze auf `>=` setzt, meldet
	// „kein Platz", waehrend es gerade eben reicht.
	const roh = { ...heil(), ausstehend: 1, freieBytes: 500, benoetigteBytes: 500 };
	assert.equal(stufeEin(roh), 'hinterher');
});

test('ein weggefallenes Laufwerk schlaegt Platzmangel', () => {
	const roh = { ...heil(), laufwerkWeg: true, freieBytes: 0, benoetigteBytes: 1, ausstehend: 3 };
	assert.equal(stufeEin(roh), 'laufwerk-weg');
});

test('die abgelaufene Anmeldung schlaegt ALLES — auch ein gemeldetes fehlendes Laufwerk', () => {
	// Das ist die eigentliche Aussage dieser Datei, und sie ist keine
	// Dringlichkeitsfrage, sondern eine der Verlaesslichkeit: ohne gueltigen
	// Zugang bekommt der Klient auf JEDE Frage eine 401, auch auf „gibt es
	// den Ordner noch?". Ein gleichzeitig gemeldetes `laufwerkWeg` stammt
	// dann aus einer Zeit, in der die Anmeldung noch galt — es kann veraltet
	// sein. Erst neu anmelden, dann weitersehen.
	const roh: VerbindungsRohwerte = {
		anmeldungAbgelaufen: true,
		laufwerkWeg: true,
		freieBytes: 0,
		benoetigteBytes: 1,
		ausstehend: 99
	};
	assert.equal(stufeEin(roh), 'anmeldung-abgelaufen');
});

test('nur die drei Zustaende, gegen die man etwas tun kann, verlangen einen Handgriff', () => {
	assert.equal(brauchtHandgriff('anmeldung-abgelaufen'), true);
	assert.equal(brauchtHandgriff('laufwerk-weg'), true);
	assert.equal(brauchtHandgriff('kein-platz'), true);
	// „hinterher" geht von selbst weg — wer den Nutzer hier zum Handeln
	// auffordert, stumpft die Anzeige fuer die Faelle ab, die es ernst meinen.
	assert.equal(brauchtHandgriff('hinterher'), false);
	assert.equal(brauchtHandgriff('gut'), false);
});
