/**
 * Tests für den Konsole-Fang (`src/lib/diagnose/konsole.ts`).
 *
 * Die Schwärzung ist die Sicherheits-Kante (Spec §8: nie Tokens): sie muss
 * greifen, BEVOR der Text den Ring erreicht — ein Fehlschlag wäre keine
 * sichtbare Störung, sondern ein stiller Datenabfluss im Bug-Report. Der Rest
 * des Moduls sind dünne Fängen; `textAus` trägt die ganze Logik.
 *
 * Läuft wie app-diagnose.test.ts unter `node --test` ohne Browser — das
 * Modul importiert nur app-diagnose (importfrei) und greift auf window nur
 * in `starteKonsolenFang` zu, die der Test nicht aufruft.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { textAus } from '../src/lib/diagnose/konsole.ts';

describe('diagnose-konsole: textAus', () => {
	it('schwärzt token-artige Query-Werte', () => {
	 const out = textAus([
			'fetch failed',
			'https://example.com/pulse?token=SEHRGEHEIM&x=1'
		]);
		assert.ok(!out.includes('SEHRGEHEIM'), `Token darf nicht enthalten sein: ${out}`);
		assert.ok(out.includes('token=…'), `Stelle muss geschwärzt sein: ${out}`);
	});

	it('schwärtzt Signatur-Parameter (Presigned-URLs)', () => {
		const out = textAus([
			'GET https://localhost:9000/x?X-Amz-Signature=abcdef123&X-Amz-Expires=300'
		]);
		assert.ok(!out.includes('abcdef123'), `Signatur darf nicht enthalten sein: ${out}`);
	});

	it('lässt harmlose URLs unberührt', () => {
		const url = 'https://localhost:5173/sounds/ding.ogg?bandBreite=2';
		assert.equal(textAus([url]), url);
	});

	it('wandelt Error in "Name: Message"', () => {
		assert.equal(
			textAus([new TypeError('Failed to fetch')]),
			'TypeError: Failed to fetch'
		);
	});

	it('kappt lange Texte mit Kennzeichnung', () => {
		const out = textAus(['x'.repeat(1000)]);
		assert.ok(out.length <= 301, `unerwartete Länge ${out.length}`);
		assert.ok(out.endsWith('…'));
	});

	it('serialisiert Objekte, wirft nie', () => {
		const kreis: Record<string, unknown> = {};
		kreis.self = kreis;
		const out = textAus(['kontext', { status: 404 }, kreis]);
		assert.ok(out.includes('kontext'));
		assert.ok(out.includes('404'));
		assert.ok(out.includes('[objekt]'));
	});
});
