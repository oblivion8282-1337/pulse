import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	RAHMEN_FASSUNG,
	RAHMEN_KOPF_LAENGE,
	RahmenAbbruch,
	TYP_KLARTEXT_JSON,
	TYP_MEGOLM,
	kodiereRahmen,
	kodiereRahmenFolge,
	leseRahmen,
	leseRahmenFolge,
} from '../src/lib/ablage/format.ts';

const nutzlast = (text: string) => new TextEncoder().encode(text);

describe('Ablage-Rahmen: einbauen und zurücklesen', () => {
	it('trägt Typ, Id und Nutzlast unverändert', () => {
		const id = 7193284571234n;
		const bytes = kodiereRahmen(id, nutzlast('hallo'), TYP_KLARTEXT_JSON);
		assert.equal(bytes.length, RAHMEN_KOPF_LAENGE + 5);
		const gelesen = leseRahmen(bytes);
		assert.equal(gelesen.rahmen.eintragsId, id);
		assert.equal(gelesen.rahmen.typ, TYP_KLARTEXT_JSON);
		assert.equal(new TextDecoder().decode(gelesen.rahmen.nutzlast), 'hallo');
		assert.equal(gelesen.naechster, bytes.length);
	});

	it('trägt u64-Ids bis an die Grenze — Snowflakes liegen jenseits von Number.MAX_SAFE_INTEGER', () => {
		for (const id of [0n, 1n << 63n, (1n << 64n) - 1n]) {
			const gelesen = leseRahmen(kodiereRahmen(id, nutzlast('x')));
			assert.equal(gelesen.rahmen.eintragsId, id);
		}
		assert.throws(() => kodiereRahmen(1n << 64n, nutzlast('x')), RangeError);
	});

	it('kettet Rahmen aneinander und trennt sie beim Lesen wieder', () => {
		const folge = kodiereRahmenFolge([
			{ typ: TYP_KLARTEXT_JSON, eintragsId: 10n, nutzlast: nutzlast('erste') },
			{ typ: TYP_MEGOLM, eintragsId: 11n, nutzlast: nutzlast('zweite') },
		]);
		const { rahmen, abbruch } = leseRahmenFolge(folge);
		assert.equal(abbruch, null);
		assert.deepEqual(
			rahmen.map((r) => [r.eintragsId, r.typ]),
			[[10n, TYP_KLARTEXT_JSON], [11n, TYP_MEGOLM]],
		);
	});

	it('liest fremde Typen als opake Bytes — der Vorblick auf Megolm ist Teil des Formats', () => {
		const bytes = kodiereRahmen(5n, nutzlast('geheim'), 42);
		assert.equal(leseRahmen(bytes).rahmen.typ, 42);
	});
});

describe('Ablage-Rahmen: Befunde statt Stillhalten', () => {
	it('erkennt gekappte Enden und liefert den lesbaren Anfang', () => {
		const folge = kodiereRahmenFolge([
			{ typ: TYP_KLARTEXT_JSON, eintragsId: 1n, nutzlast: nutzlast('ganz') },
			{ typ: TYP_KLARTEXT_JSON, eintragsId: 2n, nutzlast: nutzlast('gekappt') },
		]);
		// 10 Bytes kürzen: vom letzten Rahmen bleiben 15 — weniger als ein Kopf.
		const gekappt = folge.slice(0, folge.length - 10);
		const { rahmen, abbruch } = leseRahmenFolge(gekappt);
		assert.equal(rahmen.length, 1);
		assert.equal(abbruch?.grund, 'abgeschnitten');
		assert.equal(rahmen[0].eintragsId, 1n);

		// Weniger Kürzung: der Kopf des letzten Rahmens ist ganz, die Lüge
		// steht in seiner Längenangabe.
		const gestutzt = folge.slice(0, folge.length - 3);
		const zweiterVersuch = leseRahmenFolge(gestutzt);
		assert.equal(zweiterVersuch.rahmen.length, 1);
		assert.equal(zweiterVersuch.abbruch?.grund, 'unplaessigeLaenge');
	});

	it('weist fremde Kennungen, Fassungen und Längen zurück', () => {
		const gut = kodiereRahmen(1n, nutzlast('x'));
		const fremd = new Uint8Array(gut);
		new DataView(fremd.buffer).setUint32(0, 0x4e4f5045);
		assert.throws(() => leseRahmen(fremd), (f: unknown) => f instanceof RahmenAbbruch && f.grund === 'unbekannteKennung');

		const alt = new Uint8Array(gut);
		new DataView(alt.buffer).setUint8(4, RAHMEN_FASSUNG + 1);
		assert.throws(() => leseRahmen(alt), (f: unknown) => f instanceof RahmenAbbruch && f.grund === 'unbekannteFassung');

		const gelogen = new Uint8Array(gut);
		new DataView(gelogen.buffer).setUint32(14, 5 * 1024 * 1024);
		assert.throws(() => leseRahmen(gelogen), (f: unknown) => f instanceof RahmenAbbruch && f.grund === 'unplaessigeLaenge');
	});

	it('nimmt Restmüll hinter dem letzten Rahmen nicht als Rahmen', () => {
		const folge = kodiereRahmenFolge([
			{ typ: TYP_KLARTEXT_JSON, eintragsId: 1n, nutzlast: nutzlast('soweit klar') },
		]);
		// Genug Müll für einen kompletten Kopf — mit falscher Kennung.
		const muell = new Uint8Array(20).fill(0x5a);
		const mitMuell = new Uint8Array(folge.length + muell.length);
		mitMuell.set(folge, 0);
		mitMuell.set(muell, folge.length);
		const { rahmen, abbruch } = leseRahmenFolge(mitMuell);
		assert.equal(rahmen.length, 1);
		assert.equal(abbruch?.grund, 'unbekannteKennung');
	});
});
