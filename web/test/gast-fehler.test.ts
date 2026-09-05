import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gastFehler } from '../src/lib/gast/api.ts';

// Ein Gast sieht nur EINE Seite. Er kann nichts nachschlagen, niemanden fragen
// und nirgendwo anders hinklicken — jeder Fehlschlag muss deshalb zu einem
// Satz werden, der sagt, was jetzt zu tun ist. Diese Abbildung ist die Stelle,
// an der das entschieden wird, und sie ist importfrei genau deswegen testbar.

test('jeder Fehlschlag bekommt einen eigenen Grund', () => {
	assert.equal(gastFehler(404), 'abgelaufen');
	assert.equal(gastFehler(403), 'entfernt');
	assert.equal(gastFehler(409), 'voll');
	assert.equal(gastFehler(425), 'zufrueh');
	assert.equal(gastFehler(429), 'zuviel');
});

test('unbekannte Fehler landen nicht bei einem der bestimmten Gruende', () => {
	// Sonst stuende beim Gast „Der Raum ist voll", wenn in Wahrheit der Server
	// 500 wirft — eine falsche Auskunft ist schlimmer als eine allgemeine.
	for (const status of [400, 401, 500, 502, 503]) {
		assert.equal(gastFehler(status), 'fehler', `Status ${status}`);
	}
});
