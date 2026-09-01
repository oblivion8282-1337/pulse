import { test } from 'node:test';
import assert from 'node:assert/strict';

// Reine Rechnung fuer die Archiv-Schreib-Warteschlange (Aufgabe 3,
// `docs/superpowers/plans/2026-08-31-ablage-e3-persoenliches-archiv.md`).
// Der Laufzeit-Teil (`archivSchreibweg.ts`) haengt an IndexedDB und an
// `verbindungen.svelte.ts` (Runes) — hier wird ausschliesslich die
// importfreie Rechnung geprueft.
import {
	eintragAusRoh,
	faelligeZuerst,
	istFestgehaengen,
	MAX_VERSUCHE,
	naechsteVerzoegerungMs,
	naechsterWeckzeitpunkt,
	warteschlangeAusRoh,
	type ArchivWarteschlangenEintrag
} from '../src/lib/ablage/archivWarteschlangeRechnung.ts';

function eintrag(
	teil: Partial<ArchivWarteschlangenEintrag> & { nachrichtId: string }
): ArchivWarteschlangenEintrag {
	return {
		schluessel: `kanal-1:${teil.nachrichtId}`,
		kanalId: 'kanal-1',
		autorId: 'user-1',
		inhalt: 'hallo',
		erstelltAm: '2026-09-01T00:00:00.000Z',
		bearbeitetAm: null,
		geloescht: false,
		anhaenge: [],
		antwortAufId: null,
		kryptoId: null,
		kontoId: 'konto-1',
		versuche: 0,
		naechsterVersuchAb: 0,
		...teil
	};
}

test('naechsteVerzoegerungMs waechst und deckelt vor MAX_VERSUCHE', () => {
	const werte = [1, 2, 3, 4, 5, 6, 7].map(naechsteVerzoegerungMs);
	for (let i = 1; i < werte.length; i++) {
		assert.ok(werte[i] >= werte[i - 1], `Versuch ${i + 1} soll nicht kuerzer warten als ${i}`);
	}
	// Deckel greift spaetestens deutlich vor MAX_VERSUCHE.
	assert.equal(werte[werte.length - 1], naechsteVerzoegerungMs(MAX_VERSUCHE - 1));
});

test('ab MAX_VERSUCHE gilt ein Eintrag als festgehaengt und bekommt die langsame Spur', () => {
	assert.equal(istFestgehaengen(eintrag({ nachrichtId: 'a', versuche: MAX_VERSUCHE - 1 })), false);
	assert.equal(istFestgehaengen(eintrag({ nachrichtId: 'a', versuche: MAX_VERSUCHE })), true);
	const langsam = naechsteVerzoegerungMs(MAX_VERSUCHE);
	const schnellster = naechsteVerzoegerungMs(1);
	assert.ok(langsam > schnellster, 'die langsame Spur muss laenger warten als der erste Versuch');
});

test('faelligeZuerst: frische Eintraege vor festgehaengten, unfaellige aussen vor', () => {
	const jetzt = 1_000_000;
	const frisch = eintrag({ nachrichtId: 'frisch', naechsterVersuchAb: jetzt - 1 });
	const nochNicht = eintrag({ nachrichtId: 'spaeter', naechsterVersuchAb: jetzt + 1 });
	const festgehaengt = eintrag({
		nachrichtId: 'fest',
		versuche: MAX_VERSUCHE,
		naechsterVersuchAb: jetzt - 1
	});

	const ergebnis = faelligeZuerst([festgehaengt, nochNicht, frisch], jetzt);

	assert.deepEqual(
		ergebnis.map((e) => e.nachrichtId),
		['frisch', 'fest']
	);
});

test('faelligeZuerst begrenzt festgehaengte Eintraege auf das Budget (Head-of-Line-Schutz)', () => {
	const jetzt = 1_000_000;
	const festgehaengte = Array.from({ length: 10 }, (_, i) =>
		eintrag({ nachrichtId: `fest-${i}`, versuche: MAX_VERSUCHE, naechsterVersuchAb: jetzt - 1 })
	);

	const ergebnis = faelligeZuerst(festgehaengte, jetzt, 3);

	assert.equal(ergebnis.length, 3);
});

test('naechsterWeckzeitpunkt: leere Warteschlange weckt nie, sonst der frueheste Termin', () => {
	assert.equal(naechsterWeckzeitpunkt([]), null);
	const a = eintrag({ nachrichtId: 'a', naechsterVersuchAb: 500 });
	const b = eintrag({ nachrichtId: 'b', naechsterVersuchAb: 100 });
	assert.equal(naechsterWeckzeitpunkt([a, b]), 100);
});

test('eintragAusRoh verwirft fehlende Pflichtfelder statt Muell zu uebernehmen', () => {
	assert.equal(eintragAusRoh(null), null);
	assert.equal(eintragAusRoh({}), null);
	assert.equal(
		eintragAusRoh({
			kanalId: 'k',
			nachrichtId: 'n',
			autorId: 'a',
			inhalt: 'x',
			erstelltAm: '2026-09-01T00:00:00.000Z',
			kontoId: 'konto-1'
			// bearbeitetAm/antwortAufId/kryptoId fehlen -> muessen null-faehig sein
		}),
		null
	);
	const gueltig = eintragAusRoh({
		kanalId: 'k',
		nachrichtId: 'n',
		autorId: 'a',
		inhalt: 'x',
		erstelltAm: '2026-09-01T00:00:00.000Z',
		bearbeitetAm: null,
		antwortAufId: null,
		kryptoId: null,
		kontoId: 'konto-1'
	});
	assert.ok(gueltig);
	assert.equal(gueltig?.schluessel, 'k:n');
});

test('warteschlangeAusRoh dedupliziert nach Schluessel und verwirft nur die kaputten Eintraege', () => {
	const roh = [
		{
			kanalId: 'k',
			nachrichtId: 'n1',
			autorId: 'a',
			inhalt: 'x',
			erstelltAm: '2026-09-01T00:00:00.000Z',
			bearbeitetAm: null,
			antwortAufId: null,
			kryptoId: null,
			kontoId: 'konto-1'
		},
		{ kaputt: true },
		{
			kanalId: 'k',
			nachrichtId: 'n1',
			autorId: 'a',
			inhalt: 'zweite Fassung desselben Schluessels',
			erstelltAm: '2026-09-01T00:00:00.000Z',
			bearbeitetAm: null,
			antwortAufId: null,
			kryptoId: null,
			kontoId: 'konto-1'
		}
	];
	const ergebnis = warteschlangeAusRoh(roh);
	assert.equal(ergebnis.length, 1);
	assert.equal(ergebnis[0].inhalt, 'x');
});

test('warteschlangeAusRoh liefert eine leere Liste fuer nicht-Array-Werte', () => {
	assert.deepEqual(warteschlangeAusRoh(undefined), []);
	assert.deepEqual(warteschlangeAusRoh('kein array'), []);
});
