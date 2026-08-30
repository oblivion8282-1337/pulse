import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	MANIFEST_DATEI,
	ManifestFehler,
	erstelleManifest,
	manifestAusDaten,
	manifestMitSegment,
	verwaisteSegmente,
	type SegmentEintrag,
} from '../src/lib/ablage/manifest.ts';

function eintrag(index: number, ersteId: bigint, letzteId: bigint): SegmentEintrag {
	return {
		index,
		datei: `seg-${String(index).padStart(6, '0')}.puls`,
		rahmen: 2,
		bytes: 100,
		pruefsumme: 'ab'.repeat(32),
		ersteId: ersteId.toString(),
		letzteId: letzteId.toString(),
	};
}

describe('Ablage-Manifest: aufbauen und treiben', () => {
	it('nimmt Segmente in fester Ordnung auf und zählt den Stand hoch', () => {
		let m = erstelleManifest('kanal-1');
		m = manifestMitSegment(m, eintrag(0, 100n, 101n));
		m = manifestMitSegment(m, eintrag(1, 102n, 103n));
		assert.equal(m.stand, 2);
		assert.equal(m.letzteId, '103');
		assert.deepEqual(
			m.segmente.map((s) => s.index),
			[0, 1],
		);
	});

	it('lässt das offene (letzte) Segment wachsen, aber nur mit festem erstem Rahmen', () => {
		let m = erstelleManifest('kanal-1');
		m = manifestMitSegment(m, eintrag(0, 100n, 101n));
		const gewachsen = manifestMitSegment(m, { ...eintrag(0, 100n, 105n), rahmen: 5 });
		assert.equal(gewachsen.letzteId, '105');
		assert.equal(gewachsen.segmente.length, 1);
		assert.throws(
			() => manifestMitSegment(m, eintrag(0, 103n, 105n)),
			ManifestFehler,
		);
	});

	it('weist Sprünge, Rückfälle und das Anfassen geschlossener Segmente ab', () => {
		let m = erstelleManifest('kanal-1');
		m = manifestMitSegment(m, eintrag(0, 100n, 101n));
		m = manifestMitSegment(m, eintrag(1, 102n, 103n));
		assert.throws(() => manifestMitSegment(m, eintrag(3, 104n, 105n)), ManifestFehler);
		assert.throws(() => manifestMitSegment(m, eintrag(2, 103n, 104n)), ManifestFehler);
		assert.throws(() => manifestMitSegment(m, eintrag(0, 100n, 999n)), ManifestFehler);
	});
});

describe('Ablage-Manifest: laden und misstrauen', () => {
	it('rundet durch JSON und zurück', () => {
		let m = erstelleManifest('kanal-1');
		m = manifestMitSegment(m, eintrag(0, 100n, 101n));
		const geladen = manifestAusDaten(JSON.parse(JSON.stringify(m)));
		assert.equal(geladen.kanalId, 'kanal-1');
		assert.equal(geladen.letzteId, '101');
	});

	it('stößt Verletzung der Ordnung beim Laden raus', () => {
		const kaputt = {
			fassung: 1,
			kanalId: 'k',
			stand: 2,
			segmente: [
				{ ...eintrag(0, 100n, 101n) },
				{ ...eintrag(1, 101n, 105n) }, // beginnt vor dem Ende von Segment 0
			],
			letzteId: '105',
		};
		assert.throws(() => manifestAusDaten(kaputt), ManifestFehler);
	});

	it('stößt eine Lüge über letzteId raus', () => {
		const kaputt = {
			fassung: 1,
			kanalId: 'k',
			stand: 1,
			segmente: [{ ...eintrag(0, 100n, 101n) }],
			letzteId: '999',
		};
		assert.throws(() => manifestAusDaten(kaputt), ManifestFehler);
	});
});

describe('Ablage-Manifest: Nachzug', () => {
	it('nennt Segmentdateien, die das Manifest nicht kennt — und nur die', () => {
		const m = manifestMitSegment(erstelleManifest('k'), eintrag(0, 1n, 2n));
		assert.deepEqual(
			verwaisteSegmente(m, [
				'seg-000000.puls',
				'seg-000001.puls',
				'seg-000002.puls',
				MANIFEST_DATEI,
				'notizen.txt',
				'seg-3.puls',
			]),
			['seg-000001.puls', 'seg-000002.puls'],
		);
	});
});
