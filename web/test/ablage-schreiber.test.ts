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
import { kodiereRahmen, leseRahmenFolge, TYP_KLARTEXT_JSON } from '../src/lib/ablage/format.ts';
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

describe('Ablage-Schreiber: große Partien', () => {
	it('verteilt einen Übergrößen-Batch auf mehrere Segmente, ohne einen Rahmen zu teilen', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1', 200);
		const partien: AblageEintrag[] = Array.from({ length: 8 }, (_, i) => ({
			id: BigInt(100 + i),
			nutzlast: new TextEncoder().encode('x'.repeat(30)),
			typ: TYP_KLARTEXT_JSON,
		}));

		const ergebnis = await schreiber.festigen(partien);

		// 48 Bytes je Rahmen (18 Kopf + 30 Nutzlast): vier passen unter das
		// Ziel von 200, der fünfte sprengt es — acht Rahmen ergeben also
		// zwei Segmente in EINEM Aufruf.
		const m = schreiber.stand()!;
		assert.equal(m.segmente.length, 2);
		assert.ok(m.segmente.every((s) => s.bytes <= 200 + 60), 'ein Segment sprengt das Ziel deutlich');
		assert.equal(ergebnis?.rahmen, 8);
		assert.equal(m.letzteId, '107');

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n, 103n, 104n, 105n, 106n, 107n],
		);
		assert.deepEqual(verlauf.luecken, []);
	});

	it('gibt einem einzelnen Riesen sein eigenes Segment, statt ihn zu teilen', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1', 100);
		const riese = new TextEncoder().encode('r'.repeat(500));
		await schreiber.festigen([{ id: 100n, nutzlast: riese, typ: TYP_KLARTEXT_JSON }]);
		assert.equal(schreiber.stand()!.segmente.length, 1);
		assert.ok(schreiber.stand()!.segmente[0].bytes > 100);

		// Der nächste Eintrag darf nicht mehr anhängen — das offene Segment
		// liegt über dem Ziel, also rollt es.
		await schreiber.festigen(eintraege(['101', 'klein']));
		const m = schreiber.stand()!;
		assert.equal(m.segmente.length, 2);
		assert.equal(m.letzteId, '101');
	});
});

describe('Ablage-Schreiber: alte Rahmen aus den echten Bytes zählen', () => {
	it('zählt Alt-Rahmen aus den tatsächlich gelesenen Bytes, nicht aus dem gecachten Manifest-Eintrag', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		await schreiber.festigen(eintraege(['100', 'erste'], ['101', 'zweite']));

		// Ein anderer Schreiber hat die Segmentdatei zwischenzeitlich
		// verlängert, ohne dass unser Manifest-Cache (`letzte.rahmen`, noch
		// 2) davon weiß — direkt am Adapter simuliert, das Manifest bleibt
		// unberührt.
		const bisher = ablage.inhalte.get('seg-000000.puls')!;
		const fremderRahmen = kodiereRahmen(102n, new TextEncoder().encode('fremd'), TYP_KLARTEXT_JSON);
		const verlaengert = new Uint8Array(bisher.length + fremderRahmen.length);
		verlaengert.set(bisher, 0);
		verlaengert.set(fremderRahmen, bisher.length);
		await ablage.schreibe('seg-000000.puls', verlaengert);

		await schreiber.festigen(eintraege(['103', 'unsere']));

		// Vier Rahmen: 100/101 (unser Ursprung), 102 (fremd, in den rohen
		// Bytes vorgefunden), 103 (unser neuer Happen) — die Zahl muss aus
		// den tatsächlichen Bytes stammen, nicht aus dem Cache (der noch 2
		// kennt und sonst nur 3 zählen würde).
		const m = schreiber.stand()!;
		assert.equal(m.segmente[0].rahmen, 4);

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n, 103n],
		);
		assert.deepEqual(verlauf.luecken, []);
	});

	it('verwirft einen beschädigten Rahmen-Rest am offenen Segment, statt ihn stehen zu lassen', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		await schreiber.festigen(eintraege(['100', 'erste'], ['101', 'zweite']));

		// Kaputter Rest am Ende der offenen Segmentdatei — anders als beim
		// Absturz-Test oben noch nicht durch bestandAufnehmen() berichtigt,
		// weil dieser Schreiber schon ein offenes Manifest im Speicher hält
		// und direkt in festigen() erneut auf die Datei trifft.
		const bisher = ablage.inhalte.get('seg-000000.puls')!;
		const gekappt = new Uint8Array(bisher.length + 5);
		gekappt.set(bisher, 0);
		gekappt.set([0x50, 0x55, 0x4c], bisher.length); // halber Rahmenkopf
		await ablage.schreibe('seg-000000.puls', gekappt);

		await schreiber.festigen(eintraege(['102', 'dritte']));

		// Der kaputte Rest zählt nicht mit — 2 alte plus 1 neue, nicht 3 —
		// und darf auch nicht als Müll in der Mitte der Datei stehen bleiben.
		const m = schreiber.stand()!;
		assert.equal(m.segmente[0].rahmen, 3);

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n],
		);
		assert.deepEqual(verlauf.luecken, []);
	});
});

describe('Ablage-Schreiber: Mehrgeräte-Konflikt beim Manifest', () => {
	it('bricht ab, wenn der abgelegte Manifest-Stand weiter ist als der beim Start bekannte', async () => {
		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, 'kanal-1');
		await schreiber.festigen(eintraege(['100', 'erste']));

		// Ein anderer Schreiber (zweites Gerät) hat inzwischen sein eigenes
		// Manifest abgelegt — hier direkt am Adapter simuliert (Fassungsnummer
		// weitergedreht), ohne dass dieser Schreiber davon erfährt.
		const roh = JSON.parse(new TextDecoder().decode(ablage.inhalte.get(MANIFEST_DATEI)!));
		await ablage.schreibe(
			MANIFEST_DATEI,
			new TextEncoder().encode(JSON.stringify({ ...roh, stand: roh.stand + 1 })),
		);

		await assert.rejects(
			() => schreiber.festigen(eintraege(['101', 'zweite'])),
			/Stand/,
		);
	});

	it('erholt sich nach dem Abbruch über bestandAufnehmen(), ohne den anderen Schreiber zu verlieren', async () => {
		const ablage = speicherAdapter();
		const gemeinsam = new AblageSchreiber(ablage, 'kanal-1');
		await gemeinsam.festigen(eintraege(['100', 'basis']));

		const geraetA = new AblageSchreiber(ablage, 'kanal-1');
		const geraetB = new AblageSchreiber(ablage, 'kanal-1');
		await geraetA.bestandAufnehmen();
		await geraetB.bestandAufnehmen();

		// A festigt zuerst und kommt durch.
		await geraetA.festigen(eintraege(['101', 'von A']));

		// B kennt A's Schreiben nicht — sein Stand ist hinter dem, was jetzt
		// auf dem Adapter liegt.
		await assert.rejects(
			() => geraetB.festigen(eintraege(['102', 'von B'])),
			/Stand/,
		);

		// Erholung: neu aufnehmen und mit einer frischen Id weiterschreiben.
		// B's abgebrochener Versuch hatte die Segmentdatei bereits (nicht
		// destruktiv, siehe Befund 1) um seinen eigenen Rahmen verlängert,
		// bevor der Manifest-Schreib-Konflikt auffiel — bestandAufnehmen()
		// erkennt die davongelaufene Prüfsumme des offenen Segments und
		// berichtigt sie, adoptiert also auch B's Rahmen aus Id 102.
		await geraetB.bestandAufnehmen();
		await geraetB.festigen(eintraege(['103', 'von B, nach Erholung']));

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n, 103n],
		);
		assert.deepEqual(verlauf.luecken, []);
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
