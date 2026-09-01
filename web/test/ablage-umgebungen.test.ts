import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syncOrdnerMoeglich } from '../src/lib/ablage/syncOrdner.ts';
import { anbieterFuerUmgebung } from '../src/lib/ablage/anbieterFuerUmgebung.ts';
import type { AnbieterEintrag } from '../src/lib/ablage/anbieter.ts';

/**
 * Plan Aufgabe 4 (`docs/superpowers/plans/2026-08-31-ablage-e3-persoenliches-
 * archiv.md`): drei Umgebungen, geprueft mit vorgetäuschter
 * Plattform-Erkennung ueber `window`. `syncOrdnerMoeglich()` prueft nur
 * `'showDirectoryPicker' in window` — das trifft fuer Desktop-App (Electron,
 * Chromium-basiert) und Chrome/Edge gleichermassen zu, fuer Firefox/Safari
 * nicht. Der wichtigste Punkt: die Cloud-Anbieter bleiben in JEDER Umgebung
 * in der Liste — nur `sync_ordner` haengt an der Plattform.
 */

const CLOUD_ANBIETER: AnbieterEintrag[] = [
	{ art: 'gdrive', name: 'Google Drive', angeboten: true, fuerKanaele: true }
];
const ANBIETER_MIT_ORDNER: AnbieterEintrag[] = [
	...CLOUD_ANBIETER,
	{ art: 'sync_ordner', name: 'Ordner auf diesem Gerät', angeboten: true, fuerKanaele: false }
];

function fensterStellen(wert: unknown): void {
	Object.defineProperty(globalThis, 'window', {
		value: wert,
		configurable: true,
		writable: true
	});
}

function mitFenster<T>(wert: unknown, aufgabe: () => T): T {
	const echt = (globalThis as { window?: unknown }).window;
	fensterStellen(wert);
	try {
		return aufgabe();
	} finally {
		fensterStellen(echt);
	}
}

test('Desktop-App (Electron, Chromium) — Ordner UND Cloud waehlbar', () => {
	mitFenster({ showDirectoryPicker: () => {}, pulse: { platform: 'electron' } }, () => {
		assert.equal(syncOrdnerMoeglich(), true);
		const anbieter = anbieterFuerUmgebung(ANBIETER_MIT_ORDNER, syncOrdnerMoeglich());
		assert.deepEqual(
			anbieter.map((a) => a.art).sort(),
			['gdrive', 'sync_ordner']
		);
	});
});

test('Chrome/Edge — Ordner UND Cloud waehlbar', () => {
	mitFenster({ showDirectoryPicker: () => {} }, () => {
		assert.equal(syncOrdnerMoeglich(), true);
		const anbieter = anbieterFuerUmgebung(ANBIETER_MIT_ORDNER, syncOrdnerMoeglich());
		assert.deepEqual(
			anbieter.map((a) => a.art).sort(),
			['gdrive', 'sync_ordner']
		);
	});
});

test('Firefox/Safari — Ordner NICHT waehlbar, Cloud bleibt waehlbar, nichts geht sonst verloren', () => {
	mitFenster({}, () => {
		assert.equal(syncOrdnerMoeglich(), false);
		const anbieter = anbieterFuerUmgebung(ANBIETER_MIT_ORDNER, syncOrdnerMoeglich());
		assert.deepEqual(
			anbieter.map((a) => a.art),
			['gdrive']
		);
		// Die Cloud-Liste selbst ist unveraendert — kein Feature wird
		// unterdrueckt, nur der Ordner faellt weg.
		assert.deepEqual(
			anbieterFuerUmgebung(CLOUD_ANBIETER, false).map((a) => a.art),
			CLOUD_ANBIETER.map((a) => a.art)
		);
	});
});
