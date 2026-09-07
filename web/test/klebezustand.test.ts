import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	anfangsKlebezustand,
	KLEBE_TOLERANZ_PX,
	nachEigenerFahrt,
	nachNutzergeste,
	nachScroll,
	type Klebezustand
} from '../src/lib/nachrichten/klebezustand.ts';

const VIEWPORT = 800;
const SIZE = 5000;
const ENDE = SIZE - VIEWPORT;

const klebend: Klebezustand = { klebt: true, eigeneFahrt: false };
const geloest: Klebezustand = { klebt: false, eigeneFahrt: false };

test('der Anfangszustand klebt und hat keine Fahrt offen', () => {
	assert.deepEqual(anfangsKlebezustand(), { klebt: true, eigeneFahrt: false });
});

test('vor dem ersten Inhalt (size 0) bleibt der Zustand unverändert', () => {
	assert.deepEqual(nachScroll(klebend, 0, VIEWPORT, 0), klebend);
	assert.deepEqual(nachScroll(geloest, 0, VIEWPORT, 0), geloest);
});

test('Nutzerscroll: innerhalb der Toleranz klebt es, ausserhalb nicht — in BEIDE Richtungen', () => {
	assert.equal(nachScroll(geloest, ENDE, VIEWPORT, SIZE).klebt, true);
	assert.equal(nachScroll(geloest, ENDE - KLEBE_TOLERANZ_PX, VIEWPORT, SIZE).klebt, true);
	assert.equal(nachScroll(klebend, ENDE - KLEBE_TOLERANZ_PX - 1, VIEWPORT, SIZE).klebt, false);
	assert.equal(nachScroll(klebend, 0, VIEWPORT, SIZE).klebt, false);
});

test('der Fehlerfall: ein animierter Rad-Tick nach oben lässt das Kleben NICHT scharf', () => {
	// Rad-Tick (deltaY < 0) → Nutzergeste; danach sechs Zwischenframes à 20 px,
	// die ersten vier liegen noch in der 80-px-Zone. Bis 2026-09-04 setzte der
	// Scroll-Handler dort wieder `klebt = true`, und weil er nie mehr nach
	// false schaltete, blieb es scharf — die nächste Nachricht zog die Ansicht
	// zurück ans Ende (nachgestellt in `tests/e2e/chat-scroll.spec.ts`).
	let z = nachNutzergeste(klebend);
	for (const abstand of [20, 40, 60, 80, 100, 120]) {
		z = nachScroll(z, ENDE - abstand, VIEWPORT, SIZE);
	}
	assert.equal(z.klebt, false);
	assert.equal(z.eigeneFahrt, false);
});

test('eigene Fahrt ans Ende: Zwischenframes lösen das Kleben nicht (der Fall vom 2026-09-04)', () => {
	// `pinToEnd(true)` gleitet ans Ende; jedes Zwischen-Scroll-Ereignis liegt
	// noch nicht dort. Ohne das Fahrt-Merkmal setzte der beidseitige Handler
	// hier false, und eine Nachricht in diesem Fenster fand keinen Pin mehr vor.
	let z = nachEigenerFahrt(klebend);
	assert.equal(z.eigeneFahrt, true);
	for (const offset of [ENDE - 600, ENDE - 300, ENDE - 100]) {
		z = nachScroll(z, offset, VIEWPORT, SIZE);
		assert.equal(z.klebt, true);
		assert.equal(z.eigeneFahrt, true);
	}
});

test('die eigene Fahrt endet, sobald ein Scroll-Ereignis GENAU am Ende liegt', () => {
	let z = nachEigenerFahrt(klebend);
	z = nachScroll(z, ENDE - 40, VIEWPORT, SIZE);
	assert.equal(z.eigeneFahrt, true, 'innerhalb der Toleranz, aber nicht am Ende: Fahrt läuft weiter');
	z = nachScroll(z, ENDE - 0.5, VIEWPORT, SIZE);
	assert.equal(z.eigeneFahrt, false, 'Subpixel-Rest zählt als angekommen');
	assert.equal(z.klebt, true);
	// Danach gilt wieder der Nutzerscroll: ein Ereignis weit oben löst.
	assert.equal(nachScroll(z, 0, VIEWPORT, SIZE).klebt, false);
});

test('eine Nutzergeste bricht die eigene Fahrt ab und löst das Kleben', () => {
	const z = nachNutzergeste(nachEigenerFahrt(klebend));
	assert.deepEqual(z, { klebt: false, eigeneFahrt: false });
});

test('eine eigene Fahrt im gelösten Zustand: Ankommen am Ende klebt wieder', () => {
	// Initial-Load/Kanalwechsel: `scrollToIndex(0)` löst per Scroll-Ereignis,
	// die anschliessende Pflicht-Fahrt ans Ende muss das Kleben wiederherstellen.
	let z = nachScroll(klebend, 0, VIEWPORT, SIZE);
	assert.equal(z.klebt, false);
	z = nachEigenerFahrt(z);
	z = nachScroll(z, ENDE, VIEWPORT, SIZE);
	assert.deepEqual(z, { klebt: true, eigeneFahrt: false });
});

test('Liste kürzer als das Sichtfenster: jedes Scroll-Ereignis gilt als am Ende', () => {
	// virtua meldet size = max(total, viewport) — offset 0 liegt dann am Ende.
	assert.equal(nachScroll(geloest, 0, VIEWPORT, VIEWPORT).klebt, true);
});
