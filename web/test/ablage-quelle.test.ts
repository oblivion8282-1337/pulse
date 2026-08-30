import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { restQuelle, REST_SEITEN_GROESSE } from '../src/lib/ablage/quelle.ts';
import { leseNachricht } from '../src/lib/ablage/nutzlast.ts';
import type { Message } from '../src/lib/api/types.ts';

const ERSTE_ID = 1000n;

function wireNachricht(id: bigint): Message {
	return {
		id: id.toString(),
		channel_id: 'kanal-1',
		author_id: 'nutzer-9',
		content: `Nachricht ${id}`,
		nonce: null,
		reply_to_id: null,
		created_at: '2026-08-30T10:00:00Z',
		deleted_at: null,
	};
}

/** Mini-REST: speichert aufsteigend, antwortet ABSTEIGEND wie der Server —
 *  `after` ausschließlich, `before` ausschließlich, hartes Limit. */
function restServer(bestaende: Message[]) {
	const rufe: { nach: string | null; vor: string | null; limit: number }[] = [];
	const abruf = async (nach: string | null, vor: string | null, limit: number) => {
		rufe.push({ nach, vor, limit });
		return bestaende
			.filter((m) => (nach === null || BigInt(m.id) > BigInt(nach)) && (vor === null || BigInt(m.id) < BigInt(vor)))
			.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
			.slice(0, limit);
	};
	return { abruf, rufe };
}

function luecke(von: bigint, bis: bigint): Message[] {
	const bestaende: Message[] = [];
	for (let id = von; id <= bis; id++) {
		bestaende.push(wireNachricht(id));
	}
	return bestaende;
}

describe('Ablage-Restquelle', () => {
	it('blättert eine große Lücke von unten nach oben zusammen', async () => {
		const rest = restServer(luecke(101n, 350n)); // 250 über dem Wasserzeichen
		const quelle = restQuelle(rest.abruf);

		const partie = await quelle.holen(100n, 200);

		assert.equal(partie.length, 250);
		assert.equal(partie[0].id, 101n);
		assert.equal(partie[partie.length - 1].id, 350n);
		// Drei Server-Seiten: 250 = 100 + 100 + 50.
		assert.equal(rest.rufe.length, 3);
		assert.ok(rest.rufe.every((r) => r.limit === REST_SEITEN_GROESSE));
		assert.equal(rest.rufe[1].vor, '251'); // ältester der ersten (absteigenden) Seite
		assert.equal(rest.rufe[2].vor, '151'); // ältester der zweiten Seite
	});

	it('füttert den Nachzieher komplett durch — Nutzlasten sind echte Nachrichten', async () => {
		const { nachziehen } = await import('../src/lib/ablage/nachzieher.ts');
		const { AblageSchreiber } = await import('../src/lib/ablage/schreiber.ts');
		const { speicherAdapter } = await import('../src/lib/ablage/adapter.ts');
		const { leseVerlauf } = await import('../src/lib/ablage/leser.ts');

		const rest = restServer(luecke(101n, 130n));
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		const bericht = await nachziehen(schreiber, restQuelle(rest.abruf), { limit: 100 });

		assert.equal(bericht.festigt, 30);
		const verlauf = await leseVerlauf(ablage);
		assert.equal(verlauf.rahmen.length, 30);
		const erste = leseNachricht(verlauf.rahmen[0].nutzlast);
		assert.equal(erste.id, '101');
		assert.equal(erste.inhalt, 'Nachricht 101');
	});

	it('wäscht Mitgeschicktes hinter dem Wasserzeichen und Gelöschtes weg', async () => {
		const bestaende = luecke(101n, 105n);
		// Der reale Fehlermodus: eine Quelle mit einschließendem after
		// schickt 100 wieder mit — und ein Soft-Delete leakt durch.
		bestaende.unshift(wireNachricht(100n));
		bestaende.push({ ...wireNachricht(103n), deleted_at: '2026-08-30T12:00:00Z' });
		const rest = restServer(bestaende);
		const quelle = restQuelle(rest.abruf);

		const partie = await quelle.holen(100n, 50);
		assert.deepEqual(
			partie.map((e) => e.id),
			[101n, 102n, 103n, 104n, 105n],
		);
	});

	it('gibt eine leere Lücke ehrlich als leer zurück', async () => {
		const rest = restServer([]);
		const partie = await restQuelle(rest.abruf).holen(500n, 100);
		assert.deepEqual(partie, []);
	});
});
