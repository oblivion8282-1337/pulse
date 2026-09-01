import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import {
	verschluesselnderAdapter,
	BehaelterFehler,
	BEHAELTER_KENNUNG
} from '../src/lib/ablage/kryptoBehaelter.ts';
import { AblageSchreiber, type AblageEintrag } from '../src/lib/ablage/schreiber.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';
import { TYP_KLARTEXT_JSON } from '../src/lib/ablage/format.ts';

const SCHLÜSSEL = globalThis.crypto.getRandomValues(new Uint8Array(32));
const txt = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const eintraege = (...paare: [string, string][]): AblageEintrag[] =>
	paare.map(([id, text]) => ({
		id: BigInt(id),
		nutzlast: new TextEncoder().encode(text),
		typ: TYP_KLARTEXT_JSON
	}));

describe('verschluesselnderAdapter: Roundtrip', () => {
	it('schreibt verschlüsselt, liest denselben Klartext zurück', async () => {
		const roh = speicherAdapter();
		const adapter = verschluesselnderAdapter(roh, SCHLÜSSEL);

		await adapter.schreibe('probe.puls', new TextEncoder().encode('hallo welt'));
		const gelesen = await adapter.lese('probe.puls');
		assert.equal(txt(gelesen!), 'hallo welt');
	});

	it('fehlende Datei bleibt null, ohne Entschlüsselungsversuch', async () => {
		const roh = speicherAdapter();
		const adapter = verschluesselnderAdapter(roh, SCHLÜSSEL);
		assert.equal(await adapter.lese('nichts.puls'), null);
	});

	it('Dateinamen und Grössen bleiben auf dem Rohspeicher lesbar', async () => {
		const roh = speicherAdapter();
		const adapter = verschluesselnderAdapter(roh, SCHLÜSSEL);
		await adapter.schreibe('manifest.puls', new TextEncoder().encode('{"a":1}'));

		assert.deepEqual(await roh.liste(), ['manifest.puls']);
		const rohBytes = roh.inhalte.get('manifest.puls')!;
		assert.ok(rohBytes.length > 0);
		// Kennung des Behälter-Formats steht offen am Anfang — nur der Inhalt
		// dahinter ist Geheimtext.
		const sicht = new DataView(rohBytes.buffer, rohBytes.byteOffset, rohBytes.byteLength);
		assert.equal(sicht.getUint32(0), BEHAELTER_KENNUNG);
	});
});

describe('verschluesselnderAdapter: Fehler sichtbar statt Müll', () => {
	it('falscher Schlüssel schlägt erkennbar fehl', async () => {
		const roh = speicherAdapter();
		const schreibAdapter = verschluesselnderAdapter(roh, SCHLÜSSEL);
		await schreibAdapter.schreibe('probe.puls', new TextEncoder().encode('geheim'));

		const FALSCHER = globalThis.crypto.getRandomValues(new Uint8Array(32));
		const leseAdapter = verschluesselnderAdapter(roh, FALSCHER);
		await assert.rejects(() => leseAdapter.lese('probe.puls'), BehaelterFehler);
	});

	it('ein verändertes Byte im Geheimtext schlägt fehl', async () => {
		const roh = speicherAdapter();
		const adapter = verschluesselnderAdapter(roh, SCHLÜSSEL);
		await adapter.schreibe('probe.puls', new TextEncoder().encode('unangetastet, bitte'));

		const rohBytes = roh.inhalte.get('probe.puls')!;
		const manipuliert = new Uint8Array(rohBytes);
		manipuliert[manipuliert.length - 1] ^= 0xff;
		roh.inhalte.set('probe.puls', manipuliert);

		await assert.rejects(() => adapter.lese('probe.puls'), BehaelterFehler);
	});

	it('vertauschte Dateien (gleicher Schlüssel, falscher Name) schlagen fehl', async () => {
		const roh = speicherAdapter();
		const adapter = verschluesselnderAdapter(roh, SCHLÜSSEL);
		await adapter.schreibe('seg-000000.puls', new TextEncoder().encode('erstes Segment'));
		await adapter.schreibe('seg-000001.puls', new TextEncoder().encode('zweites Segment'));

		// Rohbytes von Segment 1 unter dem Namen von Segment 0 ablegen — die
		// Zusatzdaten (Dateiname) binden den Geheimtext, das muss auffallen.
		await roh.schreibe('seg-000000.puls', roh.inhalte.get('seg-000001.puls')!);
		await assert.rejects(() => adapter.lese('seg-000000.puls'), BehaelterFehler);
	});

	it('ein Behälter im alten Klartext-Format wird als unlesbar gemeldet, nicht als Klartext durchgereicht', async () => {
		const roh = speicherAdapter();
		await roh.schreibe('manifest.puls', new TextEncoder().encode('{"fassung":1,"segmente":[]}'));
		const adapter = verschluesselnderAdapter(roh, SCHLÜSSEL);

		await assert.rejects(
			() => adapter.lese('manifest.puls'),
			(fehler: unknown) => fehler instanceof BehaelterFehler && fehler.grund === 'unbekannteKennung'
		);
	});
});

describe('verschluesselnderAdapter: kein Klartext auf dem darunterliegenden Speicher', () => {
	it('eine auffällige Zeichenfolge im Nachrichtentext taucht in keiner Rohdatei auf', async () => {
		const roh = speicherAdapter();
		const adapter = verschluesselnderAdapter(roh, SCHLÜSSEL);
		const schreiber = new AblageSchreiber(adapter, 'kanal-krypto-test');

		const AUFFAELLIG = 'ZEBRA-STREIFEN-9f3a1c-NIEMALS-IM-KLARTEXT';
		await schreiber.festigen(
			eintraege(['100', JSON.stringify({ text: AUFFAELLIG })])
		);

		// Über der Rohablage darf die Zeichenfolge nirgends auftauchen — weder
		// in den Segment- noch in der Manifestdatei.
		for (const [, bytes] of roh.inhalte) {
			const gesamt = txt(bytes);
			assert.ok(
				!gesamt.includes(AUFFAELLIG),
				`Klartext auf dem Rohspeicher gefunden: ${gesamt}`
			);
		}

		// Über den verschlüsselnden Adapter liest derselbe Verlauf den Klartext
		// unverändert zurück — die Verschlüsselung ist für Schreiber/Leser
		// unsichtbar.
		const verlauf = await leseVerlauf(adapter);
		assert.equal(verlauf.luecken.length, 0);
		assert.equal(verlauf.rahmen.length, 1);
		assert.ok(txt(verlauf.rahmen[0].nutzlast).includes(AUFFAELLIG));
	});

	it('mehrere Segmente + Manifest bleiben roundtrip-fest über Schreiber und Leser', async () => {
		const roh = speicherAdapter();
		const adapter = verschluesselnderAdapter(roh, SCHLÜSSEL);
		const schreiber = new AblageSchreiber(adapter, 'kanal-krypto-test-2', 50);

		await schreiber.festigen(eintraege(['100', 'a'.repeat(60)]));
		await schreiber.festigen(eintraege(['101', 'b'.repeat(60)]));
		await schreiber.festigen(eintraege(['102', 'c'.repeat(60)]));

		const verlauf = await leseVerlauf(adapter);
		assert.equal(verlauf.luecken.length, 0);
		assert.equal(verlauf.rahmen.length, 3);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId.toString()),
			['100', '101', '102']
		);
	});
});
