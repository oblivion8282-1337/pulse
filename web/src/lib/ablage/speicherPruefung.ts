/**
 * Die periodische Zustandsprüfung einer Ablage-Verbindung — herausgelöst aus
 * `SpeicherSektion.svelte`, die sonst über der 250-Zeilen-Grenze für
 * Svelte-Komponenten läge (PLAN.md §12.1). Rein umgezogen, ohne
 * Verhaltensänderung: dieselben drei Ausgänge, dieselbe Merge-Reihenfolge.
 */

import { AnmeldungAbgelaufenFehler } from './oauth.ts';
import { LaufwerkWegFehler } from './ordnerGriff.ts';
import { ablageVerbindungen, adapterFür, type AblageVerbindung } from './verbindungen.svelte.ts';
import type { VerbindungsRohwerte } from './zustand.ts';

/** Anbieter, die sich ohne Nutzer-Geste aus gespeicherten Werten neu
 *  ansprechen lassen.
 *
 *  `sync_ordner` steht seit dem 2026-09-01 mit dabei, obwohl ein
 *  Ordner-Zugriff eine Nutzer-Geste braucht: die BRAUCHT nur das aktive
 *  Nachfragen, nicht das Prüfen. Steht die Berechtigung noch auf
 *  „erteilt", läuft der Zugriff durch; steht sie nach einem Neuladen auf
 *  „nachfragen", meldet der Weg `LaufwerkWegFehler` — und genau das soll
 *  die Zeile zeigen, statt weiter „alles in Ordnung" zu behaupten. */
const PRUEFBARE_ANBIETER = new Set<AblageVerbindung['anbieter']>([
	'dropbox',
	'gdrive',
	'nextcloud',
	'sync_ordner'
]);

export function leereRohwerte(): VerbindungsRohwerte {
	return {
		anmeldungAbgelaufen: false,
		laufwerkWeg: false,
		freieBytes: null,
		benoetigteBytes: 0,
		ausstehend: 0
	};
}

/**
 * Prüft eine Verbindung leichtgewichtig (nur `liste()`, keine Probe — die
 * Probe ist für den Verbinden-Moment, nicht für einen Dauerpoller, der sonst
 * Rechte-Anfragen wie „schreibe/lösche" gegen fremde Konten stellt, ohne dass
 * der Nutzer gerade etwas verbindet).
 *
 * `null` heisst „kein Befund, lass den bisherigen Stand stehen" — für nicht
 * prüfbare Anbieter und für jeden Fehler, der nichts über die Verbindung
 * aussagt (Netz, 500): der ist ein Befund über den Moment, nicht über das
 * Laufwerk.
 */
export async function pruefeZustand(
	v: AblageVerbindung,
	bisher: VerbindungsRohwerte | undefined
): Promise<VerbindungsRohwerte | null> {
	if (!PRUEFBARE_ANBIETER.has(v.anbieter)) return null;
	try {
		const adapter = await adapterFür(v);
		await adapter.liste();
		return { ...leereRohwerte(), ...bisher, anmeldungAbgelaufen: false };
	} catch (fehler) {
		if (fehler instanceof AnmeldungAbgelaufenFehler) {
			await ablageVerbindungen.markiereAnmeldungAbgelaufen(v.id);
			return { ...leereRohwerte(), anmeldungAbgelaufen: true };
		}
		if (fehler instanceof LaufwerkWegFehler) {
			// Nicht in der Verbindung festschreiben: anders als eine abgelaufene
			// Anmeldung ist das oft nur der Zustand DIESER Sitzung — nach einem
			// Neuladen steht die Ordner-Berechtigung auf „nachfragen", und der
			// nächste Klick des Nutzers stellt sie wieder her.
			return { ...leereRohwerte(), laufwerkWeg: true };
		}
		return null;
	}
}
