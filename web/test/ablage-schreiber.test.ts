import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import {
	AblageSchreiber,
	SEGMENT_BYTE_ZIEL,
	type AblageEintrag,
} from '../src/lib/ablage/schreiber.ts';
import { MANIFEST_DATEI, manifestAusDaten } from '../src/lib/ablage/manifest.ts';
import { baueSegmentAusRahmen, segDateiName } from '../src/lib/ablage/segment.ts';
import { leseRahmenFolge, TYP_KLARTEXT_JSON } from '../src/lib/ablage/format.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';

const eintraege = (...paare: [string, string][]): AblageEintrag[] =>
	paare.map(([id, text]) => ({
		id: BigInt(id),
		nutzlast: new TextEncoder().encode(text),
		typ: TYP_KLARTEXT_JSON,
	}));

describe('Ablage-Schreiber: festigen', () => {
	it('schreibt beim ersten Mal Segment und Manifest, danach wächst das offene Segment', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');

		assert.deepEqual(await schreiber.festigen(eintraege(['100', 'erste'], ['101', 'zweite'])), {
			segmentIndex: 0,
			rahmen: 2,
		});
		assert.deepEqual(await schreiber.festigen(eintraege(['102', 'dritte'])), {
			segmentIndex: 0,
			rahmen: 1,
		});
		assert.deepEqual(
			[...ablage.inhalte.keys()].sort(),
			['manifest.puls', 'seg-000000.puls'],
		);
		const m = schreiber.stand()!;
		assert.equal(m.segmente[0].rahmen, 3);
		assert.equal(m.letzteId, '102');
	});

	it('rollt weiter, sobald das offene Segment über dem Ziel liegt', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1', 200);

		await schreiber.festigen(eintraege(['100', 'a'.repeat(100)]));
		const zweite = await schreiber.festigen(eintraege(['101', 'b'.repeat(100)]));
		assert.equal(zweite?.segmentIndex, 0);
		const dritte = await schreiber.festigen(eintraege(['102', 'c'.repeat(100)]));
		assert.equal(dritte?.segmentIndex, 1);

		const m = schreiber.stand()!;
		assert.deepEqual(
			m.segmente.map((s) => [s.index, s.ersteId, s.letzteId]),
			[[0, '100', '101'], [1, '102', '102']],
		);
	});

	it('will Ids streng hinter dem Ablage-Stand — das Log ist ein Verlauf', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		await schreiber.festigen(eintraege(['100', 'a']));

		await assert.rejects(
			() => schreiber.festigen(eintraege(['100', 'doppelt'])),
			/Ablage-Stand/,
		);
		await assert.rejects(
			() => schreiber.festigen(eintraege(['102', 'c'], ['101', 'b'])),
			/Ablage-Stand/,
		);
		assert.equal(await schreiber.festigen([]), null);
	});
});

describe('Ablage-Schreiber: Abstürze', () => {
	it('adoptiert die verwaiste Segmentdatei, die der Absturz hinter dem Manifest ließ', async () => {
		const ablage = speicherAdapter();
		const erster = new AblageSchreiber(ablage, 'kanal-1');
		await erster.festigen(eintraege(['100', 'a']));

		// Absturz-Simulation: das nächste Segment wurde geschrieben, das
		// Manifest kam nie hinterher.
		await ablage.schreibe(
			segDateiName(1),
			baueSegmentAusRahmen(1, [
				{ typ: TYP_KLARTEXT_JSON, eintragsId: 101n, nutzlast: new TextEncoder().encode('b') },
				{ typ: TYP_KLARTEXT_JSON, eintragsId: 102n, nutzlast: new TextEncoder().encode('c') },
			]),
		);

		const zweiter = new AblageSchreiber(ablage, 'kanal-1');
		const bericht = await zweiter.bestandAufnehmen();
		assert.deepEqual(bericht.adoptiert, ['seg-000001.puls']);
		assert.equal(zweiter.stand()!.letzteId, '102');

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n],
		);
		assert.deepEqual(verlauf.luecken, []);
	});

	it('berichtigt das gekappte offene Segment und schreibt den Müll-Schwanz weg', async () => {
		const ablage = speicherAdapter();
		const erster = new AblageSchreiber(ablage, 'kanal-1');
		await erster.festigen(eintraege(['100', 'a'], ['101', 'b']));

		const ganz = ablage.inhalte.get('seg-000000.puls')!;
		const gekappt = new Uint8Array(ganz.length + 5);
		gekappt.set(ganz, 0);
		gekappt.set([0x50, 0x55, 0x4c], ganz.length); // halber Rahmen
		await ablage.schreibe('seg-000000.puls', gekappt);

		const zweiter = new AblageSchreiber(ablage, 'kanal-1');
		const bericht = await zweiter.bestandAufnehmen();
		assert.deepEqual(bericht.uebersprungen, ['seg-000000.puls (berichtigt)']);
		assert.deepEqual(ablage.inhalte.get('seg-000000.puls'), ganz);
		assert.equal(zweiter.stand()!.letzteId, '101');

		// Und es geht weiter, als wäre nichts gewesen.
		await zweiter.festigen(eintraege(['102', 'c']));
		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n],
		);
		assert.deepEqual(verlauf.luecken, []);
	});

	it('baut das Manifest aus den Segmenten neu, wenn es fehlt', async () => {
		const ablage = speicherAdapter();
		const erster = new AblageSchreiber(ablage, 'kanal-1');
		await erster.festigen(eintraege(['100', 'a']));
		await erster.festigen(eintraege(['101', 'b']));
		ablage.inhalte.delete(MANIFEST_DATEI);

		const zweiter = new AblageSchreiber(ablage, 'kanal-1');
		const bericht = await zweiter.bestandAufnehmen();
		assert.equal(bericht.neuGebaut, true);
		const m = manifestAusDaten(JSON.parse(new TextDecoder().decode(ablage.inhalte.get(MANIFEST_DATEI)!)));
		assert.equal(m.letzteId, '101');
		assert.equal(m.segmente.length, 1);
	});

	it('lässt Kettenbrecher liegen, statt das Manifest an ihnen aufzuhalten', async () => {
		const ablage = speicherAdapter();
		const erster = new AblageSchreiber(ablage, 'kanal-1');
		await erster.festigen(eintraege(['100', 'a']));
		ablage.inhalte.delete(MANIFEST_DATEI);
		await ablage.schreibe(
			segDateiName(7),
			baueSegmentAusRahmen(7, [
				{ typ: TYP_KLARTEXT_JSON, eintragsId: 105n, nutzlast: new TextEncoder().encode('x') },
			]),
		);

		const zweiter = new AblageSchreiber(ablage, 'kanal-1');
		const bericht = await zweiter.bestandAufnehmen();
		assert.deepEqual(bericht.uebersprungen, ['seg-000007.puls']);
		assert.equal(zweiter.stand()!.letzteId, '100');
	});
});

describe('Ablage-Schreiber: Nutzlast bleibt opak', () => {
	it('trägt die Segment-Reihenfolge im Kopf, nicht im Inhalt', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1', 200);
		await schreiber.festigen(eintraege(['9007199254740993', 'jenseits von double'], ['9007199254740994', 'noch eins']));

		const bytes = ablage.inhalte.get('seg-000000.puls')!;
		const { rahmen } = leseRahmenFolge(bytes.slice(9));
		assert.deepEqual(
			rahmen.map((r) => r.eintragsId),
			[9007199254740993n, 9007199254740994n],
		);
		assert.equal(SEGMENT_BYTE_ZIEL, 1024 * 1024);
	});
});
