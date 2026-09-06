import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archivZiel, direktErreichbar } from '../src/lib/ablage/archivZiel.ts';

// `verbindungen.svelte.ts` und `archivAdapter.ts` sind in Nodes Testlaeufer
// nicht ladbar (Runes bzw. `$lib`-Aliase, CLAUDE.md „Die Falle"). Geprueft
// wird deshalb die reine Rechnung, die `SpeicherSektion.svelte` benutzt.

const wolke = (extra: Record<string, unknown> = {}) => ({
	id: 'w',
	anbieter: 'nextcloud',
	konfiguration: { basis: 'https://wolke.example/dav' },
	...extra
});

test('ohne markiertes Archiv haelt der Server nichts', () => {
	assert.deepEqual(archivZiel([wolke(), { id: 'b', anbieter: 'dropbox' }]), {
		art: 'entfernen',
		grund: 'keins'
	});
});

test('ein markiertes Cloud-Laufwerk gibt seine Basis-Adresse weiter', () => {
	assert.deepEqual(archivZiel([wolke({ istArchiv: true })]), {
		art: 'setzen',
		adresse: 'https://wolke.example/dav'
	});
});

test('ein lokaler Sync-Ordner als Archiv nimmt die Adresse beim Server WEG', () => {
	// Der Fall, den die alte Fassung uebersah: sie kehrte fuer direkt
	// erreichbare Anbieter frueh zurueck und liess eine zuvor gesetzte
	// Cloud-Adresse stehen — der Server haette weiter dorthin geschrieben.
	assert.deepEqual(
		archivZiel([wolke(), { id: 'lokal', anbieter: 'sync_ordner', istArchiv: true }]),
		{ art: 'entfernen', grund: 'lokal' }
	);
});

test('ein Cloud-Laufwerk ohne Basis-Adresse zaehlt als Fehler, nicht als Stillstand', () => {
	assert.deepEqual(archivZiel([{ id: 'd', anbieter: 'dropbox', istArchiv: true }]), {
		art: 'entfernen',
		grund: 'ohne-adresse'
	});
});

test('eine leere Basis-Adresse gilt wie eine fehlende', () => {
	assert.deepEqual(
		archivZiel([{ id: 'w', anbieter: 'nextcloud', istArchiv: true, konfiguration: { basis: '' } }]),
		{ art: 'entfernen', grund: 'ohne-adresse' }
	);
});

test('nur der Sync-Ordner gilt als direkt erreichbar', () => {
	assert.equal(direktErreichbar('sync_ordner'), true);
	for (const anbieter of ['nextcloud', 'dropbox', 'gdrive', 's3', 'onedrive']) {
		assert.equal(direktErreichbar(anbieter), false, anbieter);
	}
});
