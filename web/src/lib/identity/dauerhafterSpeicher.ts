/**
 * Dauerhaften Speicher beim Browser anfordern.
 *
 * Ohne diese Anforderung liegt IndexedDB im „best effort"-Eimer, den Browser
 * jederzeit leeren dürfen. Dort liegen zwei Dinge, und das zweite ist das
 * schwerere:
 *
 * - `pulse-identity` — das Geräte-Schlüsselpaar (`keypair.svelte.ts`). Ist es
 *   weg, meldet sich das Gerät neu an und veröffentlicht neue Schlüssel. Ein
 *   Schönheitsfehler.
 * - `pulse-verlauf` — der entschlüsselte Nachrichtenverlauf (`schema.ts`,
 *   `Satz.inhalt`) samt entschlüsselten Anhang-Bytes. Ist der weg, ist er
 *   **endgültig** weg: das Postfach löscht die Zustellung serverseitig,
 *   sobald der Klient sie quittiert hat (`krypto/zustellungOeffnen.ts`,
 *   `postfach_pflege.py`). Der Server hält nie Klartext und kann den
 *   Geheimtext nach der Quittung kein zweites Mal ausliefern. Diese lokale
 *   Datenbank ist die einzige Kopie.
 *
 * Das passiert OHNE Zutun des Nutzers: Chrome und Firefox verdrängen bei
 * Speicherdruck, ältester Ursprung zuerst; Safari löscht schreibbaren
 * Speicher nach etwa sieben Tagen ohne Seitenbesuch. Zwei Wochen Urlaub
 * genügen also.
 *
 * **Zeitpunkt: nicht beim Seitenladen, sondern beim ersten Schreiben von
 * etwas, das nicht wiederbeschaffbar ist.** Chrome entscheidet still nach
 * eigenen Heuristiken, **Firefox zeigt eine Nachfrage** — und eine Nachfrage
 * beim anonymen Seitenaufruf wäre unerklärlich, beim Anlegen des
 * Geräteschlüssels oder beim ersten Sichern von Nachrichten nicht.
 *
 * Das Ergebnis wird je Sitzung gemerkt; nach einem „Nein" in Firefox würde
 * sonst jeder weitere Schreibvorgang erneut fragen.
 *
 * Herkunft: übernommen aus `feat/dm-attachment-e2ee` (Juli 2026), dort an den
 * inzwischen abgelösten X25519-Schlüsselbund gebunden. Die Begründung ist
 * hier auf die heutigen zwei Datenbanken neu geschrieben, weil sie sich mit
 * dem Postfach verschärft hat: damals lag der Geheimtext dauerhaft auf dem
 * Server, heute nicht mehr.
 */

export type SpeicherErgebnis =
  /** Speicher ist dauerhaft — schon vorher oder gerade gewährt. */
  | 'dauerhaft'
  /** Der Browser kann es, hat aber abgelehnt (Heuristik oder Nutzer-Nein). */
  | 'abgelehnt'
  /** Der Browser kennt die Schnittstelle nicht. */
  | 'unbekannt';

let gemerkt: Promise<SpeicherErgebnis> | null = null;

async function fragen(): Promise<SpeicherErgebnis> {
	if (typeof navigator === 'undefined' || !navigator.storage?.persist) return 'unbekannt';
	try {
		// Erst nachsehen, ob es schon gilt. Das spart in Firefox die Nachfrage bei
		// jedem Start und ist der einzige Weg, „schon dauerhaft" von „gerade
		// gewährt" zu unterscheiden, ohne erneut zu fragen.
		if (await navigator.storage.persisted?.()) return 'dauerhaft';
		return (await navigator.storage.persist()) ? 'dauerhaft' : 'abgelehnt';
	} catch {
		// Manche Umgebungen werfen, statt abzulehnen (privates Fenster, gesperrter
		// Speicher). Für den Aufrufer ist das dasselbe wie „gibt es hier nicht".
		return 'unbekannt';
	}
}

/**
 * Fordert dauerhaften Speicher an — höchstens einmal je Sitzung.
 *
 * Wirft nie. Der Aufrufer darf das Ergebnis ignorieren: ein „Nein" ändert
 * nichts am Ablauf, es bleibt beim bisherigen Risiko.
 */
export function dauerhaftenSpeicherAnfordern(): Promise<SpeicherErgebnis> {
	gemerkt ??= fragen();
	return gemerkt;
}
