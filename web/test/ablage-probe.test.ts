import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { speicherAdapter, type AblageAdapter } from '../src/lib/ablage/adapter.ts';
import { probiere } from '../src/lib/ablage/probe.ts';

describe('Verbindungsprobe: guter Fall', () => {
	it('meldet gut, wenn Schreiben/Lesen/Vergleichen/Löschen klappen', async () => {
		const adapter = speicherAdapter();
		const ergebnis = await probiere(adapter);
		assert.deepEqual(ergebnis, { gut: true });
	});

	it('räumt die Probedatei nach einem guten Lauf weg', async () => {
		const adapter = speicherAdapter();
		await probiere(adapter);
		assert.deepEqual(await adapter.liste(), []);
	});

	it('nutzt einen erkennbaren, zufälligen Dateinamen', async () => {
		const adapter = speicherAdapter();
		const gesehene: string[] = [];
		const ursprünglichesSchreibe = adapter.schreibe.bind(adapter);
		adapter.schreibe = async (datei, inhalt) => {
			gesehene.push(datei);
			return ursprünglichesSchreibe(datei, inhalt);
		};
		await probiere(adapter);
		assert.equal(gesehene.length, 1);
		assert.match(gesehene[0], /^pulse-probe-[a-f0-9]+\.tmp$/);
	});

	it('schreibt bei zwei Läufen unterschiedliche Namen (kein fester Kollisionspunkt)', async () => {
		const adapter = speicherAdapter();
		const gesehene: string[] = [];
		const ursprünglichesSchreibe = adapter.schreibe.bind(adapter);
		adapter.schreibe = async (datei, inhalt) => {
			gesehene.push(datei);
			return ursprünglichesSchreibe(datei, inhalt);
		};
		await probiere(adapter);
		await probiere(adapter);
		assert.notEqual(gesehene[0], gesehene[1]);
	});
});

describe('Verbindungsprobe: Fehlschlag je Schritt', () => {
	it('meldet den Schritt "schreiben", wenn schreibe() wirft', async () => {
		const adapter = speicherAdapter();
		adapter.schreibe = async () => {
			throw new Error('Netz weg');
		};
		const ergebnis = await probiere(adapter);
		assert.equal(ergebnis.gut, false);
		if (ergebnis.gut) throw new Error('unerreichbar');
		assert.equal(ergebnis.schritt, 'schreiben');
		assert.match(ergebnis.grund, /Netz weg/);
	});

	it('meldet den Schritt "lesen", wenn lese() wirft', async () => {
		const adapter = speicherAdapter();
		adapter.lese = async () => {
			throw new Error('Zugriff verweigert');
		};
		const ergebnis = await probiere(adapter);
		assert.equal(ergebnis.gut, false);
		if (ergebnis.gut) throw new Error('unerreichbar');
		assert.equal(ergebnis.schritt, 'lesen');
	});

	it('meldet den Schritt "lesen", wenn lese() null liefert (Datei fehlt nach dem Schreiben)', async () => {
		const adapter = speicherAdapter();
		adapter.lese = async () => null;
		const ergebnis = await probiere(adapter);
		assert.equal(ergebnis.gut, false);
		if (ergebnis.gut) throw new Error('unerreichbar');
		assert.equal(ergebnis.schritt, 'lesen');
	});

	it('meldet den Schritt "vergleichen", wenn der Anbieter andere Bytes zurückgibt', async () => {
		const adapter = speicherAdapter();
		const ursprünglichesLese = adapter.lese.bind(adapter);
		adapter.lese = async (datei) => {
			const echt = await ursprünglichesLese(datei);
			if (echt === null) return null;
			// eine Kopie mit verändertem letzten Byte — Länge bleibt gleich,
			// damit ein reiner Längenvergleich den Fehler nicht fände.
			const verändert = echt.slice();
			verändert[verändert.length - 1] = verändert[verändert.length - 1]! ^ 0xff;
			return verändert;
		};
		const ergebnis = await probiere(adapter);
		assert.equal(ergebnis.gut, false);
		if (ergebnis.gut) throw new Error('unerreichbar');
		assert.equal(ergebnis.schritt, 'vergleichen');
	});

	it('meldet den Schritt "loeschen", wenn lösche() wirft', async () => {
		const adapter = speicherAdapter();
		adapter.lösche = async () => {
			throw new Error('kein Recht');
		};
		const ergebnis = await probiere(adapter);
		assert.equal(ergebnis.gut, false);
		if (ergebnis.gut) throw new Error('unerreichbar');
		assert.equal(ergebnis.schritt, 'loeschen');
	});

	it('räumt trotz Fehlschlag beim Vergleichen auf (lösche wird trotzdem versucht)', async () => {
		const adapter = speicherAdapter();
		const ursprünglichesLese = adapter.lese.bind(adapter);
		let geloescht = false;
		adapter.lese = async (datei) => {
			const echt = await ursprünglichesLese(datei);
			if (echt === null) return null;
			return new Uint8Array([...echt, 0]);
		};
		const ursprünglichesLösche = adapter.lösche!.bind(adapter);
		adapter.lösche = async (datei) => {
			geloescht = true;
			return ursprünglichesLösche(datei);
		};
		await probiere(adapter);
		assert.equal(geloescht, true);
	});
});

describe('Verbindungsprobe: Anbieter ohne Löschen', () => {
	function ohneLöschen(): AblageAdapter {
		const basis = speicherAdapter();
		const { lösche, ...rest } = basis;
		return rest;
	}

	it('gilt als NICHT gut — ohne Löschen bleibt die Probedatei sichtbar im Ordner liegen', async () => {
		const adapter = ohneLöschen();
		const ergebnis = await probiere(adapter);
		assert.equal(ergebnis.gut, false);
		if (ergebnis.gut) throw new Error('unerreichbar');
		assert.equal(ergebnis.schritt, 'loeschen');
	});
});

describe('Verbindungsprobe: Aufräumen scheitert eigenständig', () => {
	it('meldet einen eigenen Grund, wenn lösche() nach gutem Vergleich wirft', async () => {
		const adapter = speicherAdapter();
		adapter.lösche = async () => {
			throw new Error('Ordner schreibgeschützt');
		};
		const ergebnis = await probiere(adapter);
		assert.equal(ergebnis.gut, false);
		if (ergebnis.gut) throw new Error('unerreichbar');
		assert.equal(ergebnis.schritt, 'loeschen');
		assert.match(ergebnis.grund, /Ordner schreibgeschützt/);
	});
});
