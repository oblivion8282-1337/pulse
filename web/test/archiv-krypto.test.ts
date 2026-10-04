/**
 * Rundtrip-Probe der Archiv-Krypto (Übergabe 2026-10-04, §5): Wickeln und
 * Öffnen von Kanal-Schlüsseln (X25519+HKDF+GCM), Passwort-Wrap des privaten
 * Schlüssels (Argon2id, dieselben Parameter wie der Server beim Reset-Re-Wrap)
 * und Zeilen-Ver- und Entschlüsselung. Importfrei bis auf hash-wasm — läuft
 * im Node-Testläufer gegen WebCrypto.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	erzeugeArchivPaar,
	wickleKanalSchluessel,
	oeffneKanalSchluessel,
	wicklePrivkeyMitPasswort,
	oeffnePrivkeyMitPasswort,
	verschluessleZeile,
	entschluesseleZeile
} from '../src/lib/archiv/krypto.ts';

function text(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function bytesGleich(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.from(a).equals(Buffer.from(b));
}

describe('archiv/krypto — Rundtrips', () => {
	test('Kanal-Schlüssel: Absender wickelt an beide, beide öffnen', async () => {
		const absender = await erzeugeArchivPaar();
		const anna = await erzeugeArchivPaar();
		const ben = await erzeugeArchivPaar();

		const schluessel = text('0123456789abcdef0123456789abcdef'); // 32 Bytes
		const wrapAnna = await wickleKanalSchluessel(schluessel, anna.pubkey);
		const wrapBen = await wickleKanalSchluessel(schluessel, ben.pubkey);

		assert.ok(bytesGleich(await oeffneKanalSchluessel(wrapAnna, anna.privkey, anna.pubkey), schluessel));
		assert.ok(bytesGleich(await oeffneKanalSchluessel(wrapBen, ben.privkey, ben.pubkey), schluessel));
		// Der Absender selbst öffnet auch (er wickelte nie an sich selbst —
		// in der Praxis wickelt er an seinen eigenen Public-Key, hier geprüft).
		const wrapAbsender = await wickleKanalSchluessel(schluessel, absender.pubkey);
		assert.ok(bytesGleich(await oeffneKanalSchluessel(wrapAbsender, absender.privkey, absender.pubkey), schluessel));
	});

	test('Kanal-Schlüssel: der FALSCHE private Schlüssel öffnet nicht', async () => {
		const anna = await erzeugeArchivPaar();
		const fremd = await erzeugeArchivPaar();
		const wrap = await wickleKanalSchluessel(text('k'.repeat(32)), anna.pubkey);
		await assert.rejects(() => oeffneKanalSchluessel(wrap, fremd.privkey, fremd.pubkey));
	});

	test('Passwort-Wrap: richtiges Passwort öffnet, falsches wirft', async () => {
		const paar = await erzeugeArchivPaar();
		const salt = text('0123456789abcdef');
		// Kleine Argon2-Parameter für den Testlauf (Produktvorgaben: t=3, 64 MiB).
		const wrap = await wicklePrivkeyMitPasswort(paar.privkey, 'richtig', salt, {
			zeiten: 1,
			speicherKiB: 8192
		});
		const offen = await oeffnePrivkeyMitPasswort(wrap, 'richtig', salt, {
			zeiten: 1,
			speicherKiB: 8192
		});
		assert.ok(bytesGleich(offen, paar.privkey));
		await assert.rejects(() =>
			oeffnePrivkeyMitPasswort(wrap, 'falsch', salt, { zeiten: 1, speicherKiB: 8192 })
		);
	});

	test('Passwort-Wrap: neues Salt (Passwortwechsel) bleibt öffnbar', async () => {
		const paar = await erzeugeArchivPaar();
		const wrapAlt = await wicklePrivkeyMitPasswort(paar.privkey, 'alt', text('aaaaaaaaaaaaaaaa'), {
			zeiten: 1,
			speicherKiB: 8192
		});
		const wrapNeu = await wicklePrivkeyMitPasswort(paar.privkey, 'neu', text('bbbbbbbbbbbbbbbb'), {
			zeiten: 1,
			speicherKiB: 8192
		});
		assert.ok(
			bytesGleich(
				await oeffnePrivkeyMitPasswort(wrapNeu, 'neu', text('bbbbbbbbbbbbbbbb'), {
					zeiten: 1,
					speicherKiB: 8192
				}),
				paar.privkey
			)
		);
		await assert.rejects(() =>
			oeffnePrivkeyMitPasswort(wrapAlt, 'neu', text('aaaaaaaaaaaaaaaa'), { zeiten: 1, speicherKiB: 8192 })
		);
	});

	test('Zeile: verschlüsseln und entschlüsseln, manipulierte Zeile wirft', async () => {
		const schluessel = text('z'.repeat(32));
		const klar = text('{"i":"abc","t":"Hallo","a":"1"}');
		const dunkel = await verschluessleZeile(schluessel, klar);
		assert.ok(bytesGleich(await entschluesseleZeile(schluessel, dunkel), klar));
		const manipuliert = dunkel.slice();
		manipuliert[manipuliert.length - 1] ^= 1;
		await assert.rejects(() => entschluesseleZeile(schluessel, manipuliert));
		// Fremder Schlüssel liest nichts.
		await assert.rejects(() => entschluesseleZeile(text('q'.repeat(32)), dunkel));
	});
});
