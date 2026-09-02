/**
 * Die Bestätigungsabfrage beim Anzeigen des Wiederherstellungs-Codes (E4,
 * Aufgabe 4): "tippe die dritte Gruppe ab". Reine Rechnung, importfrei.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	gruppen,
	gruppeAn,
	bestaetigungPasst,
} from '../src/lib/krypto/wiederherstellungsBestaetigung.ts';

const CODE = 'AB12-CD34-EF56-7890-A1B2-C3D4-E5F6-7809';

describe('gruppen', () => {
	test('zerlegt die Anzeigeform in ihre acht Vierergruppen', () => {
		assert.deepEqual(gruppen(CODE), ['AB12', 'CD34', 'EF56', '7890', 'A1B2', 'C3D4', 'E5F6', '7809']);
	});

	test('ignoriert umgebenden Leerraum', () => {
		assert.deepEqual(gruppen(`  ${CODE}  `), gruppen(CODE));
	});
});

describe('gruppeAn', () => {
	test('liefert die dritte Gruppe (Index 2)', () => {
		assert.equal(gruppeAn(CODE, 2), 'EF56');
	});

	test('liefert undefined jenseits der letzten Gruppe', () => {
		assert.equal(gruppeAn(CODE, 8), undefined);
	});
});

describe('bestaetigungPasst', () => {
	test('akzeptiert die exakte dritte Gruppe', () => {
		assert.equal(bestaetigungPasst(CODE, 'EF56', 2), true);
	});

	test('ist grosszügig bei Gross-/Kleinschreibung und Leerraum', () => {
		assert.equal(bestaetigungPasst(CODE, '  ef56  ', 2), true);
	});

	test('weist eine falsche Gruppe ab', () => {
		assert.equal(bestaetigungPasst(CODE, 'AB12', 2), false);
	});

	test('weist eine leere Eingabe ab', () => {
		assert.equal(bestaetigungPasst(CODE, '', 2), false);
		assert.equal(bestaetigungPasst(CODE, '   ', 2), false);
	});

	test('weist eine Nachbargruppe ab, auch wenn die Eingabe plausibel aussieht', () => {
		assert.equal(bestaetigungPasst(CODE, 'CD34', 2), false);
		assert.equal(bestaetigungPasst(CODE, '7890', 2), false);
	});
});
