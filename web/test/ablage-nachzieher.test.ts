import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { AblageSchreiber, type AblageEintrag } from '../src/lib/ablage/schreiber.ts';
import { nachziehen, type NachzieherQuelle } from '../src/lib/ablage/nachzieher.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';

function quelleAus(
	bestaende: AblageEintrag[],
	fragen: (nachId: bigint | null) => void,
): NachzieherQuelle {
	return {
		async holen(nachId, limit) {
			fragen(nachId);
			return bestaende
				.filter((e) => nachId === null || e.id > nachId)
				.slice(0, limit);
		},
	};
}

const eintraege = (...ids: string[]): AblageEintrag[] =>
	ids.map((id) => ({
		id: BigInt(id),
		nutzlast: new TextEncoder().encode(`Nachricht ${id}`),
	}));

describe('Ablage-Nachzieher', () => {
	it('zieht in Runden nach, bis die Quelle leer ist, und hält das Wasserzeichen fest', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		const gefragt: (bigint | null)[] = [];
		const quelle = quelleAus(
			eintraege('100', '101', '102', '103', '104'),
			(nachId) => gefragt.push(nachId),
		);

		const bericht = await nachziehen(schreiber, quelle, { limit: 2 });

		assert.equal(bericht.festigt, 5);
		assert.equal(bericht.wasserzeichen, 104n);
		assert.equal(bericht.leergelaufen, true);
		// Drei Fragen: Start, nach Runde 1, nach Runde 2. Die dritte Runde
		// liefert nur einen Eintrag und gilt als leer gelaufen — der vierte
		// Abruf passiert erst im nächsten Durchlauf.
		assert.deepEqual(gefragt, [null, 101n, 103n]);

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n, 103n, 104n],
		);
	});

	it('läuft bei erneutem Aufruf ins Leere — das Wasserzeichen ist der Anfang, nicht null', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		const quelle = quelleAus(eintraege('100', '101'), () => {});
		await nachziehen(schreiber, quelle, { limit: 5 });

		const gefragt: (bigint | null)[] = [];
		const bericht = await nachziehen(
			schreiber,
			quelleAus(eintraege('100', '101'), (nachId) => gefragt.push(nachId)),
			{ limit: 5 },
		);

		assert.equal(bericht.festigt, 0);
		assert.deepEqual(gefragt, [101n]);
	});

	it('wirft bei Ids hinter dem Wasserzeichen — und hat dann nichts geschrieben', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		await schreiber.festigen(eintraege('100'));

		// Der reale Fehlermodus: eine Quelle mit einschließendem after
		// liefert 100 wieder mit. Die Prüfung läuft vor dem Schreiben.
		const unhöflich: NachzieherQuelle = {
			async holen(nachId, limit) {
				return nachId === null
					? eintraege('100')
					: eintraege(String(nachId), '101', '102').slice(0, limit);
			},
		};

		const standVorher = JSON.stringify(schreiber.stand());
		await assert.rejects(() => nachziehen(schreiber, unhöflich, { limit: 10 }), /Ablage-Stand/);
		assert.equal(JSON.stringify(schreiber.stand()), standVorher);
	});

	it('berichtet einen leeren Bestand ehrlich: null als Wasserzeichen, leer gelaufen', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		const bericht = await nachziehen(schreiber, quelleAus([], () => {}), { limit: 3 });
		assert.deepEqual(bericht, { festigt: 0, wasserzeichen: null, leergelaufen: true });
	});

	it('nimmt einen aufgenommenen, aber leeren Bestand als frischen Anfang', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		// Absturz-Nachspiel: Bestand aufgenommen, keine Segmente da.
		await schreiber.bestandAufnehmen();
		assert.equal(schreiber.stand()!.letzteId, null);

		const gefragt: (bigint | null)[] = [];
		const bericht = await nachziehen(
			schreiber,
			quelleAus(eintraege('200'), (nachId) => gefragt.push(nachId)),
			{ limit: 3 },
		);
		assert.equal(bericht.festigt, 1);
		assert.deepEqual(gefragt, [null]);
	});
});
