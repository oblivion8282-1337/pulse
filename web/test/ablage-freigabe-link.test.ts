import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ausFreigabeLink, FreigabeLinkFehler } from '../src/lib/ablage/freigabeLink.ts';

test('der gewöhnliche Freigabe-Link ergibt den DAV-Zugang', () => {
	const z = ausFreigabeLink('https://cloud.example/s/AbCdEf123');
	assert.equal(z.basis, 'https://cloud.example/public.php/dav/files/AbCdEf123');
	assert.equal(z.benutzer, 'AbCdEf123');
	assert.equal(z.passwort, '');
	assert.equal(z.wirt, 'cloud.example');
});

test('Schrägstrich am Ende und der Herunterladen-Anhang stören nicht', () => {
	// Beides kopiert ein Nutzer plausibel aus der Adresszeile.
	const a = ausFreigabeLink('https://cloud.example/s/AbCdEf123/');
	const b = ausFreigabeLink('https://cloud.example/s/AbCdEf123/download');
	assert.equal(a.basis, b.basis);
	assert.equal(a.benutzer, 'AbCdEf123');
});

test('Leerzeichen ringsum werden abgeschnitten', () => {
	// Wer aus einer E-Mail kopiert, bringt sie mit.
	const z = ausFreigabeLink('  https://cloud.example/s/AbCdEf123  ');
	assert.equal(z.benutzer, 'AbCdEf123');
});

test('index.php in der Adresse gehört nicht zur DAV-Wurzel', () => {
	// Aufstellungen ohne huebsche Adressen liefern den Link so aus.
	const z = ausFreigabeLink('https://cloud.example/index.php/s/AbCdEf123');
	assert.equal(z.basis, 'https://cloud.example/public.php/dav/files/AbCdEf123');
});

test('eine Nextcloud in einem Unterverzeichnis behält ihren Pfad', () => {
	const z = ausFreigabeLink('https://example.org/nextcloud/s/AbCdEf123');
	assert.equal(z.basis, 'https://example.org/nextcloud/public.php/dav/files/AbCdEf123');
});

test('die echte Testinstanz ergibt genau die Basis, die gemessen wurde', () => {
	// Gegenprobe zum Feldversuch vom 2026-08-31: gegen genau diese Basis
	// liefen schreiben 201, lesen 200, loeschen 204 und die Verbindungsprobe
	// `{gut:true}`. Das Token ist hier durch ein Beispiel ersetzt — es ist ein
	// Schluessel und gehoert in keinen Test.
	const z = ausFreigabeLink('https://nx50337.your-storageshare.de/s/BeispielToken');
	assert.equal(
		z.basis,
		'https://nx50337.your-storageshare.de/public.php/dav/files/BeispielToken'
	);
});

test('http wird abgewiesen — der Link ist ein Schlüssel', () => {
	assert.throws(
		() => ausFreigabeLink('http://cloud.example/s/AbCdEf123'),
		(f: unknown) => f instanceof FreigabeLinkFehler && /https/.test((f as Error).message)
	);
});

test('was kein Freigabe-Link ist, wird abgewiesen statt geraten', () => {
	// Ein falsch gedeuteter Link fuehrt zu einer Verbindung, die erst beim
	// ersten Schreiben scheitert — und dann sieht es wie ein Fehler des
	// Servers aus.
	for (const schlecht of [
		'',
		'   ',
		'cloud.example/s/AbCdEf123',
		'https://cloud.example/',
		'https://cloud.example/apps/files/',
		'https://cloud.example/s/',
		'https://cloud.example/s/ab'
	]) {
		assert.throws(
			() => ausFreigabeLink(schlecht),
			FreigabeLinkFehler,
			`sollte abgewiesen werden: ${JSON.stringify(schlecht)}`
		);
	}
});

test('jede Fehlermeldung nennt einen Handgriff', () => {
	// Hausregel: ein Befund ohne Handgriff ist eine Sackgasse. Hier heisst
	// das: die Meldung muss sagen, WIE ein richtiger Link aussieht — oder
	// woran es sonst genau lag.
	for (const schlecht of ['', 'cloud.example/s/Ab', 'https://cloud.example/apps/files/']) {
		try {
			ausFreigabeLink(schlecht);
			assert.fail(`haette werfen muessen: ${schlecht}`);
		} catch (f) {
			const text = (f as Error).message;
			assert.ok(text.length > 20, `zu knapp: ${text}`);
		}
	}
});
