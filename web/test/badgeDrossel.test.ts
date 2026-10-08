import { test } from 'node:test';
import assert from 'node:assert/strict';

import { darfMelden, MINDESTABSTAND_MS } from '../src/lib/platform/badgeDrossel.ts';

test('derselbe Wert wird nicht erneut gemeldet', () => {
	assert.equal(darfMelden({ letzterWert: 3, letzteZeit: 0, bereit: true }, 3, 10_000_000), false);
});

test('die erste Meldung geht sofort raus', () => {
	// Ein frisch gestartetes Gerät darf den Serverstand nicht erst nach der
	// Drosselfrist korrigieren.
	assert.equal(darfMelden({ letzterWert: null, letzteZeit: 0, bereit: true }, 2, 1_000), true);
});

test('alles gelesen schlaegt die Drossel', () => {
	// Die 0 ist die Meldung, auf die es ankommt: die Plakette muss sofort weg.
	assert.equal(darfMelden({ letzterWert: 5, letzteZeit: 9_900, bereit: true }, 0, 10_000), true);
});

test('eine neue Zahl innerhalb der Frist wartet', () => {
	const stand = { letzterWert: 1, letzteZeit: 10_000, bereit: true };
	assert.equal(darfMelden(stand, 2, 10_000 + MINDESTABSTAND_MS - 1), false);
});

test('nach Ablauf der Frist darf die neue Zahl raus', () => {
	const stand = { letzterWert: 1, letzteZeit: 10_000, bereit: true };
	assert.equal(darfMelden(stand, 2, 10_000 + MINDESTABSTAND_MS), true);
});

test('vor der Freigabe wird gar nichts gemeldet', () => {
	// Der Fall vom Geraetetest 08.10.: beim Start ist die Ungelesen-Lage noch
	// nicht geladen, der Klient rechnet 0 — und haette damit die korrekte 3
	// des Servers geloescht. Auch die sonst bevorrechtigte 0 muss hier
	// schweigen.
	const stand = { letzterWert: null, letzteZeit: 0, bereit: false };
	assert.equal(darfMelden(stand, 0, 1_000), false);
	assert.equal(darfMelden(stand, 5, 1_000), false);
});

test('nach der Freigabe gilt die normale Regel wieder', () => {
	const stand = { letzterWert: null, letzteZeit: 0, bereit: true };
	assert.equal(darfMelden(stand, 5, 1_000), true);
});
