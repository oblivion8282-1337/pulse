import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	NUTZLAST_FASSUNG,
	NutzlastFehler,
	ausWire,
	kodiereNachricht,
	leseNachricht,
} from '../src/lib/ablage/nutzlast.ts';
import type { Message } from '../src/lib/api/types.ts';

function wireNachricht(übersteuert: Partial<Message> = {}): Message {
	return {
		id: '7193284571234',
		channel_id: 'kanal-1',
		author_id: 'nutzer-9',
		content: 'erste Nachricht',
		nonce: null,
		reply_to_id: null,
		created_at: '2026-08-30T10:00:00Z',
		edited_at: null,
		deleted_at: null,
		...übersteuert,
	};
}

describe('Ablage-Nutzlast: Wire wird Bestand', () => {
	it('trägt die festen Felder und lässt Kurzlebiges weg', () => {
		const nachricht = ausWire(
			wireNachricht({
				reply_to_id: '111',
				edited_at: '2026-08-30T11:00:00Z',
				attachments: [
					{
						id: 'a-1',
						filename: 'foto.png',
						mime: 'image/png',
						size: 42,
						url: 'https://minio.example/vorsigniert?geheim',
						thumb_url: 'https://minio.example/vorsigniert-thumb?geheim',
					},
				],
			}),
		);
		assert.equal(nachricht.autor, 'nutzer-9');
		assert.equal(nachricht.antwortAuf, '111');
		assert.equal(nachricht.bearbeitet, '2026-08-30T11:00:00Z');
		// Verbatim samt Dateischlüssel (verschlüsselte Anhänge brauchen ihn
		// auf dem Wiederherstellungsgerät), aber ohne Vorsignatur-URLs.
		assert.deepEqual(nachricht.anhaenge, [
			{
				id: 'a-1',
				filename: 'foto.png',
				name: 'foto.png',
				mime: 'image/png',
				size: 42,
				groesse: 42,
			},
		]);

		// Vorsignierte Adressen sind kurzlebig und dürfen den dauerhaften
		// Bestand nie erreichen.
		const text = new TextDecoder().decode(kodiereNachricht(nachricht));
		assert.ok(!text.includes('minio.example'));
		assert.ok(!text.includes('url'));
	});

	it('rundet durch Kodieren und Lesen unverändert', () => {
		const nachricht = ausWire(wireNachricht({ content: 'mit Ümläuten ✨' }));
		const gelesen = leseNachricht(kodiereNachricht(nachricht));
		assert.deepEqual(gelesen, nachricht);
	});

	it('stößt fremde Fassungen und unvollständige Sätze raus', () => {
		const fremd = kodiereNachricht({ ...ausWire(wireNachricht()), fassung: 99 });
		assert.throws(() => leseNachricht(fremd), NutzlastFehler);

		const ohneInhalt = new TextEncoder().encode(
			JSON.stringify({ fassung: NUTZLAST_FASSUNG, id: '1', autor: 'x', zeit: 'z' }),
		);
		assert.throws(() => leseNachricht(ohneInhalt), (f: unknown) => f instanceof NutzlastFehler && f.message.includes('inhalt'));

		const ohneAnhangFelder = new TextEncoder().encode(
			JSON.stringify({
				fassung: NUTZLAST_FASSUNG,
				id: '1',
				autor: 'x',
				inhalt: 'y',
				zeit: 'z',
				bearbeitet: null,
				antwortAuf: null,
				anhaenge: [{ name: 'ohne alles' }],
			}),
		);
		assert.throws(() => leseNachricht(ohneAnhangFelder), /groesse/);
	});
});
