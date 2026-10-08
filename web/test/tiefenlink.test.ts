import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zielPfad } from '../src/lib/platform/tiefenlink.ts';

test('Chat-Adresse wird zum Ziel in der App', () => {
	assert.equal(zielPfad('https://howispulse.com/app/@me/12345'), '/app/@me/12345');
	assert.equal(zielPfad('https://www.howispulse.com/app/rooms/7'), '/app/rooms/7');
});

test('Query und Anker reisen mit', () => {
	assert.equal(
		zielPfad('https://howispulse.com/app/@me/1?ab=2#x'),
		'/app/@me/1?ab=2#x'
	);
});

test('fremde Herkunft wird abgewiesen', () => {
	// Sonst oeffnete ein fremder Link die App an einer Stelle seiner Wahl.
	assert.equal(zielPfad('https://boese.example/app/@me/1'), null);
	// Auch der Trick mit dem Hostnamen als Praefix.
	assert.equal(zielPfad('https://howispulse.com.boese.example/app/@me/1'), null);
});

test('http statt https wird abgewiesen', () => {
	assert.equal(zielPfad('http://howispulse.com/app/@me/1'), null);
});

test('Pfade ausserhalb von /app bleiben dem Browser', () => {
	assert.equal(zielPfad('https://howispulse.com/'), null);
	assert.equal(zielPfad('https://howispulse.com/impressum'), null);
	assert.equal(zielPfad('https://howispulse.com/login'), null);
	// `/appetit` darf nicht als `/app`-Praefix durchrutschen.
	assert.equal(zielPfad('https://howispulse.com/appetit'), null);
});

test('/app selbst ist erlaubt', () => {
	assert.equal(zielPfad('https://howispulse.com/app'), '/app');
});

test('Unsinn gibt null statt zu werfen', () => {
	assert.equal(zielPfad('keine-adresse'), null);
	assert.equal(zielPfad(''), null);
});
