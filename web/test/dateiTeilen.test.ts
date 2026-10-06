import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dateiNameOderErsatz } from '../src/lib/platform/dateiTeilen.ts';

test('leerer Dateiname fällt auf den Ersatznamen zurück', () => {
	// Ohne download-Namen navigiert der Anker-Klick in die blob:-Adresse
	// (Sicherungs-Schiene im Modulkopf) — der Fallback ist Pflicht.
	assert.equal(dateiNameOderErsatz(''), 'anhang');
});

test('vorhandener Dateiname bleibt unverändert', () => {
	assert.equal(dateiNameOderErsatz('bericht.pdf'), 'bericht.pdf');
});
