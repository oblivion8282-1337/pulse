import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	SENDUNGEN_BIS_ZUR_FRAGE,
	sollFragen
} from '../src/lib/platform/bewertungRegel.ts';

test('am Anfang wird nicht gefragt', () => {
	// Genau der Moment, in dem ein Nutzer die App noch nicht kennt.
	assert.equal(sollFragen({ gesendet: 0, bereitsGefragt: false }), false);
	assert.equal(sollFragen({ gesendet: 1, bereitsGefragt: false }), false);
});

test('eine Sendung vor der Schwelle reicht noch nicht', () => {
	assert.equal(
		sollFragen({ gesendet: SENDUNGEN_BIS_ZUR_FRAGE - 1, bereitsGefragt: false }),
		false
	);
});

test('ab der Schwelle wird gefragt', () => {
	assert.equal(
		sollFragen({ gesendet: SENDUNGEN_BIS_ZUR_FRAGE, bereitsGefragt: false }),
		true
	);
});

test('zweimal fragen gibt es nicht', () => {
	// iOS zeigt die Frage hoechstens dreimal im Jahr und sagt nicht, ob sie
	// erschienen ist — ein zweiter Versuch verbrennt nur Kontingent.
	assert.equal(
		sollFragen({ gesendet: 9999, bereitsGefragt: true }),
		false
	);
});
