import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	ableiteKek,
	entschlüsseleEintrag,
	erzeugeDek,
	öffneSchluesselDatei,
	SICHERUNG_FASSUNG,
	SICHERUNG_KENNUNG,
	SicherungKryptoFehler,
	verschlüsseleEintrag,
	wickleSchluesselDatei,
} from '../src/lib/sicherung/krypto.ts';
import {
	kodiereSicherungEintrag,
	leseSicherungEintrag,
	sicherungEintrag,
} from '../src/lib/sicherung/nutzlast.ts';
import { ausWire } from '../src/lib/ablage/nutzlast.ts';

/** Kleine Parameter für die Testsuite — 64 MiB × 3 Runden würde sie unnötig quälen. */
const LEICHTE = { zeiten: 1, speicherKiB: 8192, parallelitaet: 1 };

test('ableiteKek — deterministisch, saltabhängig, 32 Bytes', async () => {
	const salt = new Uint8Array(16).fill(7);
	const a = await ableiteKek('richtig', { ...LEICHTE, salt });
	const b = await ableiteKek('richtig', { ...LEICHTE, salt });
	assert.equal(a.length, 32);
	assert.deepEqual(a, b);

	const anderesSalt = await ableiteKek('richtig', { ...LEICHTE, salt: new Uint8Array(16).fill(8) });
	assert.notDeepEqual(a, anderesSalt);
});

test('wickle + öffne — Roundtrip, Parameter kommen aus dem Kopf zurück', async () => {
	const dek = erzeugeDek();
	const datei = await wickleSchluesselDatei(dek, 'kohlenmonoxid-tresor-9', LEICHTE);

	// Kennung und Fassung sind die einzigen klartextigen Stellen.
	const sicht = new DataView(datei.buffer);
	assert.equal(sicht.getUint32(0), SICHERUNG_KENNUNG);
	assert.equal(sicht.getUint8(4), SICHERUNG_FASSUNG);

	const geöffnet = await öffneSchluesselDatei(datei, 'kohlenmonoxid-tresor-9');
	assert.deepEqual(geöffnet.dek, dek);
	assert.equal(geöffnet.parameter.zeiten, LEICHTE.zeiten);
	assert.equal(geöffnet.parameter.speicherKiB, LEICHTE.speicherKiB);
	assert.equal(geöffnet.parameter.parallelitaet, LEICHTE.parallelitaet);
	assert.equal(geöffnet.parameter.salt.length, 16);
});

test('falsches Passwort — Öffnung schlägt fehl, DEK bleibt geheim', async () => {
	const dek = erzeugeDek();
	const datei = await wickleSchluesselDatei(dek, 'richtig', LEICHTE);
	const bytes = new TextDecoder().decode(datei);
	assert.ok(!bytes.includes('richtig'), 'Passwort im Klartext gefunden');
	await assert.rejects(() => öffneSchluesselDatei(datei, 'falsch'), SicherungKryptoFehler);
});

test('manipulierte Schlüssel-Datei — Öffnung schlägt fehl', async () => {
	const datei = await wickleSchluesselDatei(erzeugeDek(), 'richtig', LEICHTE);
	const manipuliert = new Uint8Array(datei);
	manipuliert[manipuliert.length - 1] ^= 0xff;
	await assert.rejects(() => öffneSchluesselDatei(manipuliert, 'richtig'), SicherungKryptoFehler);
});

test('Passwort-Änderung = Re-Wrap — derselbe DEK, Archiv unangetastet', async () => {
	const dek = erzeugeDek();
	const alt = await wickleSchluesselDatei(dek, 'altes-passwort', LEICHTE);
	const neu = await wickleSchluesselDatei(dek, 'neues-passwort', LEICHTE);
	assert.notDeepEqual(alt, neu, 'Re-Wrap muss bytesequenz unterscheiden (neues Salt)');
	assert.deepEqual((await öffneSchluesselDatei(neu, 'neues-passwort')).dek, dek);
});

test('Eintrag: kodieren → verschlüsseln → entschlüsseln → lesen', async () => {
	const dek = erzeugeDek();
	const nachricht = ausWire({
		id: '87877952020160512',
		author_id: '81032295653314560',
		content: 'geheime nachricht',
		created_at: '2026-08-31T12:00:00Z',
		edited_at: null,
		reply_to_id: null,
		attachments: [],
	} as unknown as Parameters<typeof ausWire>[0]);
	const eintrag = sicherungEintrag('87680070507831296', nachricht);

	const dunkel = await verschlüsseleEintrag(dek, kodiereSicherungEintrag(eintrag));
	// Nichts Lesbares darf überleben.
	const text = new TextDecoder().decode(dunkel);
	assert.ok(!text.includes('geheime nachricht'), 'Inhalt im Klartext gefunden');
	assert.ok(!text.includes('87680070507831296'), 'Kanal-Id im Klartext gefunden');

	const klar = await entschlüsseleEintrag(dek, dunkel);
	const gelesen = leseSicherungEintrag(klar);
	assert.equal(gelesen.kanalId, '87680070507831296');
	assert.equal(gelesen.nachricht.inhalt, 'geheime nachricht');
	assert.equal(gelesen.nachricht.id, '87877952020160512');
});

test('manipulierter Eintrag — Entschlüsselung schlägt fehl', async () => {
	const dek = erzeugeDek();
	const dunkel = await verschlüsseleEintrag(dek, new TextEncoder().encode('x'));
	const manipuliert = new Uint8Array(dunkel);
	manipuliert[manipuliert.length - 1] ^= 0xff;
	await assert.rejects(() => entschlüsseleEintrag(dek, manipuliert), SicherungKryptoFehler);
});

test('falscher DEK entschlüsselt fremden Eintrag nicht', async () => {
	const dunkel = await verschlüsseleEintrag(erzeugeDek(), new TextEncoder().encode('x'));
	await assert.rejects(() => entschlüsseleEintrag(erzeugeDek(), dunkel));
});
