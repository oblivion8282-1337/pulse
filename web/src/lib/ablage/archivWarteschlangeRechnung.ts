/**
 * Reine Rechnung für die Archiv-Schreib-Warteschlange (Plan-Aufgabe 3,
 * `docs/superpowers/plans/2026-08-31-ablage-e3-persoenliches-archiv.md`):
 * Modell des einzelnen Eintrags, Fälligkeits-Backoff und die Reihenfolge, in
 * der `archivSchreibweg.ts` sie abarbeitet.
 *
 * Importfrei wie `archivMarkierung.ts` und `ordnerGriffEntscheidung.ts` — der
 * Laufzeit-Teil hängt an `verbindungen.svelte.ts` (Runes, IndexedDB), das
 * reisst Nodes eingebauten Testläufer sofort ab (CLAUDE.md „Die Falle"). Was
 * hier falsch sein kann — Backoff-Wachstum, Fälligkeits-Reihenfolge,
 * Deduplizierung eines fremden Bestands — soll ohne Browser prüfbar bleiben.
 *
 * **Bewusst KEIN Wasserzeichen.** Der Nachzieher (`nachzieher.ts`) rückt ein
 * Wasserzeichen vor und verliert damit jeden Eintrag, der dahinter
 * übersprungen wird, für immer (dieselbe Falle traf diesen Zweig bereits
 * zweimal, s. Plan). Diese Warteschlange führt stattdessen jeden Eintrag
 * EINZELN, bis er entweder archiviert ist oder — was hier nie geschieht,
 * anders als beim Medien-Archiv-Vorbild — der Server ihn nicht mehr hat:
 * ein Eintrag verschwindet ausschließlich, wenn `archivSchreibweg.ts` ihn
 * nach einem erfolgreichen Schreiben aktiv entfernt.
 */

export interface ArchivWarteschlangenEintrag {
	/** `${kanalId}:${nachrichtId}` — Dedupe- und Primärschlüssel. */
	schluessel: string;
	kanalId: string;
	nachrichtId: string;
	autorId: string;
	inhalt: string;
	erstelltAm: string;
	bearbeitetAm: string | null;
	geloescht: boolean;
	antwortAufId: string | null;
	kryptoId: string | null;
	/** Die Anhang-Angaben der Nachricht (Kennung, Name, Schlüssel …) — der
	 *  VERWEIS, nicht die Bytes. **Fehlte bis zum 2026-09-01 ganz**: ein
	 *  zurückgeholter Verlauf hätte damit jede Bildnachricht als reinen Text
	 *  wiedergegeben, ohne dass auch nur zu sehen gewesen wäre, dass ein
	 *  Anhang dazugehörte. Alte Einträge ohne das Feld lesen sich als leere
	 *  Liste. */
	anhaenge: unknown[];
	/** Welchem Konto dieser Eintrag gehört — Isolation bei einem Kontowechsel
	 *  am selben Gerät, derselbe Grund wie bei `verbindungen.svelte.ts`. */
	kontoId: string;
	/** Zahl der bisherigen Fehlversuche. */
	versuche: number;
	/** Frühester nächster Versuch (ms seit Epoche). 0 = sofort. */
	naechsterVersuchAb: number;
}

/** Erster Fehlversuch wartet so lange, danach verdoppelnd. */
const BASIS_VERZOEGERUNG_MS = 30_000;
/** Obergrenze der normalen Verdopplung. */
const MAX_VERZOEGERUNG_MS = 30 * 60_000;
/** Ab so vielen Fehlversuchen gilt ein Eintrag als festgehängt: er bleibt in
 *  der Warteschlange (Verwerfen wäre der Kardinalfehler, s. Modulkopf),
 *  wandert aber in die langsame Spur. */
export const MAX_VERSUCHE = 8;
/** Abstand der langsamen Spur. */
const FESTHAENGER_ABSTAND_MS = 6 * 3_600_000;
/** Höchstens so viele festgehängte Einträge je Durchlauf — verhindert, dass
 *  eine Handvoll toter Einträge frische Nachrichten blockiert (Head-of-Line). */
export const FESTHAENGER_BUDGET = 5;

export function istFestgehaengen(eintrag: { versuche: number }): boolean {
	return eintrag.versuche >= MAX_VERSUCHE;
}

/** Wartezeit nach dem `versuche`-ten Fehlversuch. */
export function naechsteVerzoegerungMs(versuche: number): number {
	if (versuche >= MAX_VERSUCHE) return FESTHAENGER_ABSTAND_MS;
	return Math.min(BASIS_VERZOEGERUNG_MS * 2 ** Math.max(0, versuche - 1), MAX_VERZOEGERUNG_MS);
}

/**
 * Was jetzt drankommt: fällige Einträge, frische vor festgehängten, und von
 * letzteren nur `budget` Stück — ohne diese Reihenfolge hielte ein einzelner
 * kaputter Eintrag am Kopf der Warteschlange jede neue Nachricht auf.
 */
export function faelligeZuerst(
	eintraege: readonly ArchivWarteschlangenEintrag[],
	jetzt: number,
	budget = FESTHAENGER_BUDGET
): ArchivWarteschlangenEintrag[] {
	const faellig = eintraege.filter((e) => e.naechsterVersuchAb <= jetzt);
	const frisch = faellig.filter((e) => !istFestgehaengen(e));
	const festgehaengen = faellig.filter(istFestgehaengen).slice(0, budget);
	return [...frisch, ...festgehaengen];
}

/** Wann sich der nächste Durchlauf lohnt — null, wenn nichts wartet. */
export function naechsterWeckzeitpunkt(
	eintraege: readonly ArchivWarteschlangenEintrag[]
): number | null {
	let min: number | null = null;
	for (const e of eintraege) {
		if (min === null || e.naechsterVersuchAb < min) min = e.naechsterVersuchAb;
	}
	return min;
}

function istString(wert: unknown): wert is string {
	return typeof wert === 'string';
}

function istStringOderNull(wert: unknown): wert is string | null {
	return wert === null || typeof wert === 'string';
}

function endlicheZahl(wert: unknown): number {
	return typeof wert === 'number' && Number.isFinite(wert) ? wert : 0;
}

/** Wandelt einen rohen (aus IndexedDB gelesenen, also nicht vertrauenswürdigen)
 *  Wert in einen Eintrag um — `null` bei fehlendem Pflichtfeld oder falschem
 *  Typ, statt Müll in die Warteschlange zu übernehmen. */
export function eintragAusRoh(roh: unknown): ArchivWarteschlangenEintrag | null {
	if (typeof roh !== 'object' || roh === null) return null;
	const r = roh as Record<string, unknown>;
	if (
		!istString(r.kanalId) ||
		!istString(r.nachrichtId) ||
		!istString(r.autorId) ||
		!istString(r.inhalt) ||
		!istString(r.erstelltAm) ||
		!istString(r.kontoId) ||
		!istStringOderNull(r.bearbeitetAm) ||
		!istStringOderNull(r.antwortAufId) ||
		!istStringOderNull(r.kryptoId)
	) {
		return null;
	}
	return {
		schluessel: `${r.kanalId}:${r.nachrichtId}`,
		// Tolerant statt fail-closed, anders als bei den Pflichtfeldern
		// darüber: ein Bestandseintrag ohne dieses Feld ist kein kaputter
		// Eintrag, sondern ein älterer.
		anhaenge: Array.isArray(r.anhaenge) ? r.anhaenge : [],
		kanalId: r.kanalId,
		nachrichtId: r.nachrichtId,
		autorId: r.autorId,
		inhalt: r.inhalt,
		erstelltAm: r.erstelltAm,
		bearbeitetAm: r.bearbeitetAm,
		geloescht: r.geloescht === true,
		antwortAufId: r.antwortAufId,
		kryptoId: r.kryptoId,
		kontoId: r.kontoId,
		versuche: Math.max(0, Math.trunc(endlicheZahl(r.versuche))),
		naechsterVersuchAb: endlicheZahl(r.naechsterVersuchAb)
	};
}

/** Wie `eintragAusRoh`, aber für eine ganze abgelegte Liste — verwirft
 *  Einzeleinträge statt an ihnen die gesamte Warteschlange zu verlieren, und
 *  dedupliziert nach `schluessel` (der erste Treffer gewinnt). */
export function warteschlangeAusRoh(roh: unknown): ArchivWarteschlangenEintrag[] {
	if (!Array.isArray(roh)) return [];
	const ergebnis: ArchivWarteschlangenEintrag[] = [];
	const gesehen = new Set<string>();
	for (const eintrag of roh) {
		const geparst = eintragAusRoh(eintrag);
		if (!geparst || gesehen.has(geparst.schluessel)) continue;
		gesehen.add(geparst.schluessel);
		ergebnis.push(geparst);
	}
	return ergebnis;
}
