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

	it('verdichtet gleichartige Ereignisse SCHON BEIM SCHREIBEN (anzahl)', () => {
		// Vier identische Ereignisse → EIN Ring-Eintrag mit anzahl 4: ohne die
		// schreibseitige Verdichtung würde ein flappendes Server (10-15
		// ws_closed/min) den Ring mit Wiederholungen fluten und die seltenen
		// wertvollen Belege verdrängen.
		for (let i = 0; i < 4; i++) {
			melde('anmeldung', 'anmeldung_network', 'network', { server_id: 'a1' });
		}
		melde('api', 'api_fehler_500', 'HTTP 500');
		const ring = leseRingpuffer();
		assert.equal(ring.length, 2);
		assert.equal(ring[0].anzahl, 4);
		const b = bericht({}, '');
		assert.equal(b.ereignisse.length, 2);
		assert.equal(b.ereignisse[0].anzahl, 4);
	});

	it('verschmilzt NICHT über den Text hinweg (zwei Server, gleicher Fehler)', () => {
		melde('anmeldung', 'anmeldung_network', 'network', { server_id: 'a1' });
		melde('anmeldung', 'anmeldung_network', 'network', { server_id: 'b2' });
		const b = bericht({}, '');
		assert.equal(b.ereignisse.length, 2, 'zwei Belege bleiben zwei Belege');
	});

	it('kappt bei 250 und zählt die Verworfenen ehrlich', () => {
		for (let i = 0; i < 260; i++) {
			melde('test', `kategorie_${i}`, `text ${i}`);
		}
		const ring = leseRingpuffer();
		assert.equal(ring.length, 250);
		const b = bericht({}, '');
		assert.equal(b.ereignisse_verworfen, 10);
	});

	it('kappt lange Texte hart am Schreibpfad (Deckel-Schutz)', () => {
		melde('test', 'kat', 'x'.repeat(5000));
		assert.equal(leseRingpuffer()[0].text.length, 200);
	});

	it('wirft keine Einträge aus korruptem Storage — und zählt sie', () => {
		melde('test', 'kat_ok', 'ok');
		// Halb geschriebener Blob / fremdes Schema: Elemente ohne ts/kategorie.
		const roh = JSON.parse(ablage.find((e) => e.key === 'pulse.diagnose.ring')!.value);
		roh.ereignisse.unshift({ kategorie: 42 }, { ts: 'gestern' }, null);
		ablage.find((e) => e.key === 'pulse.diagnose.ring')!.value = JSON.stringify(roh);
		const ring = leseRingpuffer();
		assert.equal(ring.length, 1);
		// bericht() stirbt NICHT an den Leichen — der Kanal muss im Ausnahme-
		// zustand funktionieren:
		const b = bericht({}, '');
		assert.equal(b.ereignisse.length, 1);
		assert.equal(b.ereignisse_verworfen >= 3, true);
	});

	it('kürzt die Kategorie auf 48 Zeichen (Endpoint-Limit)', () => {
		melde('test', 'k'.repeat(80), 'x');
		const b = bericht({}, '');
		assert.equal(b.ereignisse[0].art.length, 48);
	});

	it('trägt die Notiz im Abschluss und den Kopf unverändert', () => {
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

	it('Drossel: in der Zukunft liegender Zeitstempel sperrt nicht (zurückgesprungene Uhr)', () => {
		merkeUebertragung();
		const schluessel = 'pulse.diagnose.gesendet_am';
		ablage.find((e) => e.key === schluessel)!.value = String(Date.now() + 3_600_000);
		assert.equal(darfJetztSenden(), true);
	});

	it('leeren(bisTs) behält Ereignisse, die nach dem Sendezeitpunkt kamen', () => {
		melde('test', 'alt', 'vor dem Versand');
		const sentAt = Date.now();
		// "Während des Fetchs" angekommen: ts > sentAt erzwingen.
		const ring = leseRingpuffer();
		ring.push({
			ts: sentAt + 50,
			baustein: 'verbindung',
			kategorie: 'ws_closed_1006',
			text: 'neu',
			anzahl: 1
		});
		ablage.find((e) => e.key === 'pulse.diagnose.ring')!.value = JSON.stringify({
			ereignisse: ring,
			verworfen: 0
		});
		leeren(sentAt);
		const uebrig = leseRingpuffer();
		assert.equal(uebrig.length, 1);
		assert.equal(uebrig[0].kategorie, 'ws_closed_1006');
	});

	it('überlebt einen Neustart: Persistenz aus dem Fake-Storage', () => {
		melde('api', 'api_fehler_500', 'HTTP 500');
		leeren(); // Cache + Storage weg
		melde('api', 'api_fehler_500', 'HTTP 500'); // frische App, erstes Ereignis
		assert.equal(leseRingpuffer().length, 1);
	});
});
