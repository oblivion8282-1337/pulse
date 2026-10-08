import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	MAX_SKALA,
	ZOOM_AUS,
	begrenzeSkala,
	begrenzeStand,
	doppeltippStand,
	maxVerschiebung,
	pinchStand
} from '../src/lib/components/lightboxZoom.ts';

test('Skala bleibt zwischen 1 und MAX', () => {
	assert.equal(begrenzeSkala(0.2), 1);
	assert.equal(begrenzeSkala(2.5), 2.5);
	assert.equal(begrenzeSkala(99), MAX_SKALA);
	// Ein NaN aus einer entarteten Geste (beide Finger auf demselben Punkt,
	// Abstand 0 → Division durch 0) darf nicht durchschlagen.
	assert.equal(begrenzeSkala(Number.NaN), 1);
});

test('in Ruhelage ist keine Verschiebung erlaubt', () => {
	assert.equal(maxVerschiebung(1, 800), 0);
	const s = begrenzeStand({ skala: 1, dx: 120, dy: -80 }, 800, 600);
	assert.deepEqual(s, { skala: 1, dx: 0, dy: 0 });
});

test('gezoomt darf genau bis zur Bildkante geschoben werden', () => {
	// Bei 2x ragt das Bild auf jeder Seite um die halbe Kante ueber.
	assert.equal(maxVerschiebung(2, 800), 400);
	const s = begrenzeStand({ skala: 2, dx: 9999, dy: -9999 }, 800, 600);
	assert.deepEqual(s, { skala: 2, dx: 400, dy: -300 });
});

test('Doppeltipp zoomt rein und beim zweiten Mal wieder ganz raus', () => {
	const rein = doppeltippStand(ZOOM_AUS);
	assert.equal(rein.skala, 2);
	// Auch aus 4x heraus: der zweite Doppeltipp muss verlaesslich zurueck,
	// nicht weiter hinein.
	assert.deepEqual(doppeltippStand({ skala: 4, dx: 50, dy: 50 }), ZOOM_AUS);
});

test('Pinch haelt den Punkt zwischen den Fingern fest', () => {
	// Mittelpunkt in der Mitte: keine Verschiebung noetig.
	const mitte = pinchStand({ skala: 1, dx: 0, dy: 0 }, 2, 0, 0);
	assert.deepEqual(mitte, { skala: 2, dx: 0, dy: 0 });
	// Mittelpunkt 100 px rechts der Mitte: beim Verdoppeln muss das Bild um
	// 100 px nach links, damit genau dieser Punkt stehen bleibt.
	const rechts = pinchStand({ skala: 1, dx: 0, dy: 0 }, 2, 100, 0);
	assert.equal(rechts.skala, 2);
	assert.equal(rechts.dx, -100);
});

test('an der Skalen-Grenze wandert die Verschiebung nicht weiter', () => {
	// Faktor 10 auf eine 1 ergibt MAX (4), nicht 10 — und die Verschiebung
	// muss zu den 4 passen, nicht zu den 10.
	const s = pinchStand({ skala: 1, dx: 0, dy: 0 }, 10, 100, 0);
	assert.equal(s.skala, MAX_SKALA);
	assert.equal(s.dx, 100 - 100 * MAX_SKALA);
});
