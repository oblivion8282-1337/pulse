import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { AblageSchreiber, type AblageEintrag } from '../src/lib/ablage/schreiber.ts';
import { MANIFEST_DATEI } from '../src/lib/ablage/manifest.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';

const eintraege = (...ids: string[]): AblageEintrag[] =>
	ids.map((id) => ({
		id: BigInt(id),
		nutzlast: new TextEncoder().encode(`Nachricht ${id}`),
	}));

describe('Ablage-Leser', () => {
	it('liest den ganzen Verlauf über gerollte Segmente hinweg', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1', 60);
		await schreiber.festigen(eintraege('100', '101'));
		await schreiber.festigen(eintraege('102'));
		await schreiber.festigen(eintraege('103'));

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n, 103n],
		);
		assert.deepEqual(verlauf.luecken, []);
		// Die Behauptung „über Segmente hinweg“ ist nur ehrlich mit einem echten Roll:
		assert.ok((schreiber.stand()!.segmente.length) >= 2);
	});

	it('nennt das fehlende Manifest als Lücke, statt Rätsel aufzugeben', async () => {
		const ablage = speicherAdapter();
		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(verlauf.rahmen, []);
		assert.equal(verlauf.luecken.length, 1);
		assert.match(verlauf.luecken[0], /Manifest|manifest/);
	});

	it('liefert bei verdächtiger Prüfsumme den lesbaren Anfang und nennt die Lücke', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1', 2000);
		await schreiber.festigen(eintraege('100', '101', '102'));

		const bytes = ablage.inhalte.get('seg-000000.puls')!;
		const verdächtig = new Uint8Array(bytes);
		verdächtig[verdächtig.length - 3] ^= 0xff;
		await ablage.schreibe('seg-000000.puls', verdächtig);

		const verlauf = await leseVerlauf(ablage);
		assert.equal(verlauf.rahmen.length, 3);
		assert.equal(verlauf.luecken.length, 1);
		assert.match(verlauf.luecken[0], /Prüfsumme/);
	});

	it('nimmt ein fehlendes Segment als Lücke, wirft aber nichts weg', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1', 60);
		await schreiber.festigen(eintraege('100', '101'));
		await schreiber.festigen(eintraege('102'));
		ablage.inhalte.delete('seg-000000.puls');

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[102n],
		);
		assert.equal(verlauf.luecken.length, 1);
		assert.match(verlauf.luecken[0], /fehlt/);
	});

	it('findet das Manifest unverändert nach dem Lesen — der Leser schreibt nie', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		await schreiber.festigen(eintraege('100'));
		const vorher = new TextDecoder().decode(ablage.inhalte.get(MANIFEST_DATEI)!);

		await leseVerlauf(ablage);

		assert.equal(new TextDecoder().decode(ablage.inhalte.get(MANIFEST_DATEI)!), vorher);
	});
});
