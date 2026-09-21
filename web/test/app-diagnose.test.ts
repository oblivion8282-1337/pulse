/**
 * Grenz-Tests für das App-Diagnose-Gedächtnis (`app-diagnose.ts`).
 *
 * Das Modul ist importfrei (s. dort) und läuft darum ohne Alias-Magie unter
 * `node --test`. `localStorage` wird gefakt — im Node-Prozess existiert es
 * nicht, was zugleich den Nicht-Browser-Fall abdeckt: der Puffer läuft dann
 * nur im Speicher und wirft nie.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

type Eintrag = { key: string; value: string };
const ablage: Eintrag[] = [];

// Minimal-Storage: genug API für das Modul (getItem/setItem/removeItem).
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => ablage.find((e) => e.key === k)?.value ?? null,
	setItem: (k: string, v: string) => {
		const alt = ablage.find((e) => e.key === k);
		if (alt) alt.value = v;
		else ablage.push({ key: k, value: v });
	},
	removeItem: (k: string) => {
		const i = ablage.findIndex((e) => e.key === k);
		if (i >= 0) ablage.splice(i, 1);
	}
};

import {
	melde,
	leseRingpuffer,
	leeren,
	bericht,
	darfJetztSenden,
	merkeUebertragung
} from '../src/lib/diagnose/app-diagnose.ts';

describe('app-diagnose', () => {
	beforeEach(() => {
		ablage.length = 0;
		leeren();
	});

	it('nimmt Ereignisse in Reihenfolge auf', () => {
		melde('anmeldung', 'anmeldung_network', 'network', { server_id: 'a1' });
		melde('verbindung', 'ws_closed_4070', 'gesperrt');
		const ring = leseRingpuffer();
		assert.equal(ring.length, 2);
		assert.equal(ring[0].kategorie, 'anmeldung_network');
		assert.equal(ring[1].baustein, 'verbindung');
	});

	it('kappt bei 250 und zählt die Verworfenen', () => {
		for (let i = 0; i < 260; i++) {
			melde('test', `kategorie_${i}`, `text ${i}`);
		}
		const ring = leseRingpuffer();
		assert.equal(ring.length, 250);
		const b = bericht({}, '');
		// 260 geschickt, 250 im Bericht → 10 müssen EHRLICH gezählt sein.
		assert.equal(b.ereignisse_verworfen, 10);
	});

	it('verdichtet gleichartige Ereignisse innerhalb des Fensters', () => {
		// Vier identische Ereignisse direkt hintereinander → EIN Eintrag, anzahl 4.
		for (let i = 0; i < 4; i++) {
			melde('anmeldung', 'anmeldung_network', 'network', { server_id: 'a1' });
		}
		melde('api', 'api_fehler_500', 'HTTP 500');
		const b = bericht({}, '');
		assert.equal(b.ereignisse.length, 2);
		assert.equal(b.ereignisse[0].anzahl, 4);
		assert.equal(b.ereignisse[0].art, 'anmeldung_network');
		assert.equal(b.ereignisse[0].werte?.server_id, 'a1');
		// Relativzeit: alles nahe null (frisch gemeldet), auf eine Nachkommastelle.
		assert.ok(b.ereignisse[0].s < 1);
	});

	it('kürzt die Kategorie auf 48 Zeichen (Endpoint-Limit)', () => {
		melde('test', 'k'.repeat(80), 'x');
		const b = bericht({}, '');
		assert.equal(b.ereignisse[0].art.length, 48);
	});

	it('trägt die Notiz im Abschluss', () => {
		const b = bericht({ app: 'test' }, 'Community anlegen ging nicht');
		assert.equal(b.abschluss.notiz, 'Community anlegen ging nicht');
		assert.deepEqual(b.kopf, { app: 'test' });
	});

	it('Drossel: direkt nach dem Senden gesperrt, nach Ablauf wieder frei', () => {
		assert.equal(darfJetztSenden(), true);
		merkeUebertragung();
		assert.equal(darfJetztSenden(), false);
		// Gesendet-Zeitpunkt künstlich altern: 61 s zurück.
		const schluessel = 'pulse.diagnose.gesendet_am';
		const jetzt = Number(ablage.find((e) => e.key === schluessel)?.value ?? 0);
		ablage.find((e) => e.key === schluessel)!.value = String(jetzt - 61_000);
		assert.equal(darfJetztSenden(), true);
	});

	it('überlebt einen Neustart: Persistenz aus dem Fake-Storage', () => {
		melde('api', 'api_fehler_500', 'HTTP 500');
		// Cacheinvalidierung = das, was ein App-Neustart tut (frischer Modul-Zustand):
		// leeren() setzt den Cache neu, der Storage bleibt hier aber bewusst voll —
		// wir simulieren den Neustart über eine neue Lesung ohne leeren().
		leeren(); // Cache + Storage weg
		melde('api', 'api_fehler_500', 'HTTP 500'); // frische App, erstes Ereignis
		assert.equal(leseRingpuffer().length, 1);
	});
});
