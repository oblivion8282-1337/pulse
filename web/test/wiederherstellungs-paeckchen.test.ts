import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	packePaeckchen,
	öffnePaeckchen,
	WiederherstellungsFehler,
	PAECKCHEN_FASSUNG,
	INHALT_FASSUNG,
	MINDEST_CODE_BYTES,
	type WiederherstellungsInhalt,
} from '../src/lib/krypto/wiederherstellungsPaeckchen.ts';

// Eigene Zufallsbytes statt `wiederherstellungsCode.ts`: das Modul nimmt
// Uint8Array entgegen und soll nicht an das Codeformat gekoppelt sein.
const code = () => globalThis.crypto.getRandomValues(new Uint8Array(16));

const HAUPTSCHLUESSEL_B64 = 'aGF1cHRzY2hsdWVzc2VsLTMyLWJ5dGVzLXRlc3R3ZXJ0';
const FREIGABE_LINK = 'https://cloud.example/public.php/dav/files/AbCdEf123';

function inhalt(): Omit<WiederherstellungsInhalt, 'fassung'> {
	return {
		erstelltAm: '2026-08-31T12:00:00.000Z',
		kontoId: '1234567890',
		verbindungen: [
			{
				id: 'sync-ordner',
				anbieter: 'nextcloud',
				name: 'Nextcloud auf cloud.example',
				konfiguration: { basis: FREIGABE_LINK, benutzer: 'AbCdEf123', passwort: '' },
				hauptschlüsselB64: HAUPTSCHLUESSEL_B64,
				verbundenAm: '2026-08-30T09:00:00.000Z',
			},
		],
	};
}

/** Der `grund` eines geworfenen Fehlers — Prüfhilfe für `assert.rejects`. */
function grundIst(erwartet: string) {
	return (fehler: unknown) => {
		assert.ok(fehler instanceof WiederherstellungsFehler, `kein WiederherstellungsFehler: ${fehler}`);
		assert.equal(fehler.grund, erwartet);
		return true;
	};
}

test('Rundlauf — dasselbe kommt wieder heraus', async () => {
	const c = code();
	const paeckchen = await packePaeckchen(c, inhalt());
	const auf = await öffnePaeckchen(c, paeckchen);

	assert.equal(auf.fassung, INHALT_FASSUNG);
	assert.equal(auf.kontoId, '1234567890');
	assert.equal(auf.verbindungen.length, 1);
	assert.equal(auf.verbindungen[0].hauptschlüsselB64, HAUPTSCHLUESSEL_B64);
	assert.equal(auf.verbindungen[0].konfiguration.basis, FREIGABE_LINK);
	assert.equal(auf.verbindungen[0].anbieter, 'nextcloud');
});

test('das Päckchen trägt weder Schlüssel noch Link im Klartext', async () => {
	const paeckchen = await packePaeckchen(code(), inhalt());
	const text = new TextDecoder().decode(paeckchen);
	assert.ok(!text.includes(HAUPTSCHLUESSEL_B64), 'Hauptschlüssel im Klartext gefunden');
	assert.ok(!text.includes(FREIGABE_LINK), 'Freigabe-Link im Klartext gefunden');
	assert.ok(!text.includes('cloud.example'), 'Ort im Klartext gefunden');
});

test('zweimal derselbe Code ergibt verschiedene Päckchen (frisches Salz, frische IV)', async () => {
	const c = code();
	const a = await packePaeckchen(c, inhalt());
	const b = await packePaeckchen(c, inhalt());
	assert.notDeepEqual(a, b);
	// Beide bleiben mit demselben Code zu öffnen.
	assert.equal((await öffnePaeckchen(c, a)).kontoId, (await öffnePaeckchen(c, b)).kontoId);
});

test('falscher Code — schlägt fehl statt Müll zu liefern', async () => {
	const paeckchen = await packePaeckchen(code(), inhalt());
	await assert.rejects(() => öffnePaeckchen(code(), paeckchen), grundIst('nichtZuOeffnen'));
});

test('ein Code unter der Mindestlänge wird abgewiesen — beim Packen wie beim Öffnen', async () => {
	const kurz = new Uint8Array(MINDEST_CODE_BYTES - 1);
	await assert.rejects(() => packePaeckchen(kurz, inhalt()), grundIst('codeZuKurz'));

	const paeckchen = await packePaeckchen(code(), inhalt());
	await assert.rejects(() => öffnePaeckchen(kurz, paeckchen), grundIst('codeZuKurz'));
});

// --- Manipulation: jede Stelle des Formats einzeln ------------------------
//
//   "PWHP" (4) | Fassung (1) | Salz (16) | IV (12) | Geheimtext
//
// Die Zahlen stehen hier absichtlich ausgeschrieben statt aus dem Modul
// importiert: eine abgeschriebene Grenze prüft nach einer Formatänderung
// nichts mehr, eine mitwandernde würde die Änderung mitmachen.
const STELLEN: Array<[string, number, string]> = [
	['Kennung', 1, 'fremdeKennung'],
	['Salz', 5, 'nichtZuOeffnen'],
	['IV', 21, 'nichtZuOeffnen'],
	['Geheimtext', 33, 'nichtZuOeffnen'],
];

for (const [was, versatz, grund] of STELLEN) {
	test(`verändertes Päckchen (${was}) schlägt fehl`, async () => {
		const c = code();
		const paeckchen = await packePaeckchen(c, inhalt());
		paeckchen[versatz] ^= 0xff;
		await assert.rejects(() => öffnePaeckchen(c, paeckchen), grundIst(grund));
	});
}

test('verändertes letztes Byte (die GCM-Marke) schlägt fehl', async () => {
	const c = code();
	const paeckchen = await packePaeckchen(c, inhalt());
	paeckchen[paeckchen.length - 1] ^= 0x01;
	await assert.rejects(() => öffnePaeckchen(c, paeckchen), grundIst('nichtZuOeffnen'));
});

test('unbekannte Behälter-Fassung — klare Meldung statt Fehldeutung', async () => {
	const c = code();
	const paeckchen = await packePaeckchen(c, inhalt());
	paeckchen[4] = PAECKCHEN_FASSUNG + 1;
	await assert.rejects(() => öffnePaeckchen(c, paeckchen), (fehler: unknown) => {
		assert.ok(fehler instanceof WiederherstellungsFehler);
		assert.equal(fehler.grund, 'unbekannteBehaelterFassung');
		// Die Meldung nennt beide Fassungen — sonst rät der Nutzer.
		assert.match(fehler.message, new RegExp(String(PAECKCHEN_FASSUNG + 1)));
		assert.match(fehler.message, new RegExp(String(PAECKCHEN_FASSUNG)));
		return true;
	});
});

test('abgeschnittenes Päckchen wirft, statt über den Puffer hinaus zu lesen', async () => {
	const c = code();
	const voll = await packePaeckchen(c, inhalt());

	// Kürzer als Kopf + GCM-Marke: gar nichts zu deuten.
	for (const laenge of [0, 1, 4, 5, 33, 33 + 16]) {
		await assert.rejects(
			() => öffnePaeckchen(c, voll.slice(0, laenge)),
			grundIst('abgeschnitten'),
			`Länge ${laenge}`,
		);
	}

	// Mitten im Geheimtext gekappt: formal vollständig, inhaltlich kaputt —
	// muss als „nicht zu öffnen" herauskommen, nicht als Absturz.
	await assert.rejects(() => öffnePaeckchen(c, voll.slice(0, voll.length - 1)), grundIst('nichtZuOeffnen'));
});

test('ein Päckchen mitten in einem grösseren Puffer wird richtig gelesen', async () => {
	const c = code();
	const paeckchen = await packePaeckchen(c, inhalt());
	const traeger = new Uint8Array(7 + paeckchen.length + 3);
	traeger.set(paeckchen, 7);
	const sicht = traeger.subarray(7, 7 + paeckchen.length);

	const auf = await öffnePaeckchen(c, sicht);
	assert.equal(auf.verbindungen[0].hauptschlüsselB64, HAUPTSCHLUESSEL_B64);
});

// --- Inhalt: was nach erfolgreicher Entschlüsselung noch schiefgehen kann ---

/**
 * Baut ein formal gültiges Päckchen um einen beliebigen Klartext — dieselbe
 * Rechnung wie im Modul, hier nachgebaut, weil `packePaeckchen` die
 * Inhaltsfassung selbst setzt und deshalb keine fremde erzeugen kann.
 */
async function baueMitInhalt(codeBytes: Uint8Array, klartext: string): Promise<Uint8Array> {
	const salz = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
	const kopf = new Uint8Array(33);
	new DataView(kopf.buffer).setUint32(0, 0x50574850);
	kopf[4] = PAECKCHEN_FASSUNG;
	kopf.set(salz, 5);
	kopf.set(iv, 21);

	const roh = await globalThis.crypto.subtle.importKey(
		'raw',
		codeBytes.slice().buffer as ArrayBuffer,
		'HKDF',
		false,
		['deriveKey'],
	);
	const schluessel = await globalThis.crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: salz.slice().buffer as ArrayBuffer,
			info: new TextEncoder().encode('pulse-wiederherstellungs-paeckchen-v1').buffer as ArrayBuffer,
		},
		roh,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt'],
	);
	const dunkel = new Uint8Array(
		await globalThis.crypto.subtle.encrypt(
			{
				name: 'AES-GCM',
				iv: iv.slice().buffer as ArrayBuffer,
				additionalData: kopf.slice().buffer as ArrayBuffer,
			},
			schluessel,
			new TextEncoder().encode(klartext).buffer as ArrayBuffer,
		),
	);
	const gesamt = new Uint8Array(33 + dunkel.length);
	gesamt.set(kopf, 0);
	gesamt.set(dunkel, 33);
	return gesamt;
}

test('die Nachbau-Hilfe erzeugt ein Päckchen, das das Modul öffnet', async () => {
	// Ohne diese Gegenprobe könnten die drei Tests darunter grün sein, weil der
	// Nachbau falsch ist — und nicht, weil das Modul richtig urteilt.
	const c = code();
	const echt = JSON.stringify({ fassung: INHALT_FASSUNG, ...inhalt() });
	const auf = await öffnePaeckchen(c, await baueMitInhalt(c, echt));
	assert.equal(auf.kontoId, '1234567890');
});

test('neuere Inhaltsfassung wird abgewiesen statt halb gedeutet', async () => {
	const c = code();
	const klartext = JSON.stringify({ ...inhalt(), fassung: INHALT_FASSUNG + 1 });
	const paeckchen = await baueMitInhalt(c, klartext);
	await assert.rejects(() => öffnePaeckchen(c, paeckchen), grundIst('unbekannteInhaltsFassung'));
});

test('unlesbarer Inhalt — kein JSON, falsche Form, kaputte Verbindung', async () => {
	const c = code();
	const faelle = [
		'kein json',
		'42',
		JSON.stringify({ fassung: 1 }),
		JSON.stringify({ fassung: 1, erstelltAm: 'x', kontoId: 'y', verbindungen: {} }),
		JSON.stringify({ fassung: 1, erstelltAm: 'x', kontoId: 'y', verbindungen: [{ id: 'a' }] }),
		JSON.stringify({
			fassung: 1,
			erstelltAm: 'x',
			kontoId: 'y',
			verbindungen: [{ ...inhalt().verbindungen[0], konfiguration: { basis: 7 } }],
		}),
	];
	for (const fall of faelle) {
		await assert.rejects(
			async () => öffnePaeckchen(c, await baueMitInhalt(c, fall)),
			grundIst('unlesbarerInhalt'),
			fall.slice(0, 40),
		);
	}
});

test('keine Fehlermeldung trägt Code, Schlüssel oder Inhalt', async () => {
	const c = code();
	const paeckchen = await packePaeckchen(c, inhalt());
	const codeHex = [...c].map((b) => b.toString(16).padStart(2, '0')).join('');

	const kaputt = paeckchen.slice();
	kaputt[40] ^= 0xff;
	const meldungen: string[] = [];
	for (const versuch of [
		() => öffnePaeckchen(code(), paeckchen),
		() => öffnePaeckchen(c, kaputt),
		() => öffnePaeckchen(c, paeckchen.slice(0, 10)),
		() => packePaeckchen(new Uint8Array(4), inhalt()),
	]) {
		await assert.rejects(versuch, (fehler: unknown) => {
			meldungen.push((fehler as Error).message);
			return true;
		});
	}

	for (const meldung of meldungen) {
		assert.ok(!meldung.includes(codeHex), 'Code in der Meldung');
		assert.ok(!meldung.includes(HAUPTSCHLUESSEL_B64), 'Hauptschlüssel in der Meldung');
		assert.ok(!meldung.includes(FREIGABE_LINK), 'Link in der Meldung');
		assert.ok(!meldung.includes('cloud.example'), 'Ort in der Meldung');
	}
});
