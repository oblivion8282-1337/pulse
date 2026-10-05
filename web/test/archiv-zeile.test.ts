/**
 * Rundtrip der Archiv-Zeile (Gruppen-Erweiterung 2026-10-05): Bauen und
 * Lesen des Klartext-Kerns — Text, Threading, Absender und die
 * Anhang-ANGABEN (die Bytes bleiben Durchlauferhitzer; ein anderes Gerät
 * rendert daraus die Kachel, s. Entscheidung 2026-10-05). Läuft im
 * Node-Testläufer, deshalb importfrei bis auf Typen + die Übersetzer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { baueZeilenKlar, leseZeilenKlar } from '../src/lib/archiv/zeile.ts';
import type { Message } from '../src/lib/api/types';

function nachricht(mit: Partial<Message> = {}): Message {
	return {
		id: '1234567890123',
		channel_id: '999',
		author_id: '42',
		content: 'Hallo Archiv',
		nonce: null,
		reply_to_id: null,
		created_at: '2026-10-05T10:00:00.000Z',
		verschluesselt: true,
		...mit
	};
}

describe('archiv/zeile', () => {
	test('Rundtrip ohne Anhang und ohne Antwort', () => {
		const klar = baueZeilenKlar(nachricht());
		const zurueck = leseZeilenKlar('999', new TextDecoder().decode(klar));
		assert.equal(zurueck.id, '1234567890123');
		assert.equal(zurueck.content, 'Hallo Archiv');
		assert.equal(zurueck.author_id, '42');
		assert.equal(zurueck.created_at, '2026-10-05T10:00:00.000Z');
		assert.equal(zurueck.reply_to_id, null);
		assert.equal(zurueck.attachments, undefined);
	});

	test('Rundtrip mit Antwort und Anhang-Angaben (Schlüssel, Maße, Vorschau, Dauer)', () => {
		const quelle = nachricht({
			reply_to_id: '777',
			attachments: [
				{
					id: 'anhang-1',
					filename: 'foto.jpg',
					mime: 'image/jpeg',
					size: 1234,
					width: 640,
					height: 480,
					thumb_width: 320,
					thumb_height: 240,
					url: '',
					thumb_url: null,
					verschluesselt: true,
					schluessel: 'a2V5MQ==',
					thumb_schluessel: 'a2V5Mg=='
				},
				{
					id: 'anhang-2',
					filename: null,
					mime: null,
					size: 5,
					url: '',
					thumb_url: null,
					verschluesselt: true,
					schluessel: 'a2V5Mw=='
				}
			]
		});
		const zurueck = leseZeilenKlar('999', new TextDecoder().decode(baueZeilenKlar(quelle)));
		assert.equal(zurueck.reply_to_id, '777');
		assert.equal(zurueck.attachments?.length, 2);
		const eins = zurueck.attachments![0];
		assert.equal(eins.id, 'anhang-1');
		assert.equal(eins.filename, 'foto.jpg');
		assert.equal(eins.mime, 'image/jpeg');
		assert.equal(eins.size, 1234);
		assert.equal(eins.width, 640);
		assert.equal(eins.schluessel, 'a2V5MQ==');
		assert.equal(eins.thumb_schluessel, 'a2V5Mg==');
		assert.equal(eins.thumb_width, 320);
		// Ohne Maße/Schlüssel-Abkömmlinge: schlichter Satz, keine Erfindungen.
		const zwei = zurueck.attachments![1];
		assert.equal(zwei.filename, '');
		assert.equal(zwei.mime, 'application/octet-stream');
		assert.equal(zwei.width, null);
	});

	test('Legacy-Zeile ohne anh-Feld bleibt lesbar (Fassung vor 2026-10-05)', () => {
		const zurueck = leseZeilenKlar(
			'999',
			'{"i":"1","t":"alt","a":"42","z":"2026-10-04T00:00:00.000Z","v":2}'
		);
		assert.equal(zurueck.content, 'alt');
		assert.equal(zurueck.attachments, undefined);
	});
});
