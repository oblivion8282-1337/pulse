/**
 * Reine Entscheidung: liegt für eine Sync-Ordner-Verbindung ein nutzbarer
 * Zugriff vor, oder muss die Verbindung als `laufwerk-weg` gelten
 * (`lib/ablage/zustand.ts::VerbindungsZustand`)?
 *
 * Getrennt von `ordnerGriff.ts`, weil das dort die IndexedDB-Verkabelung
 * (`identity/idb-shared`, ein aliasierter, erweiterungsloser Import) trägt
 * und deshalb in Nodes eingebautem Testläufer gar nicht ladbar ist (CLAUDE.md
 * „Die Falle"). Diese Datei importiert nichts und ist direkt prüfbar —
 * dasselbe Muster wie `syncOrdnerSchluessel.ts` neben `verbindungen.svelte.ts`.
 */

/** `'kein-griff'`: es liegt gar kein Verzeichnis-Handle in der IndexedDB —
 *  weder verbunden noch je gespeichert. Jeder andere Wert ist der Stand der
 *  File-System-Access-Berechtigung für ein tatsächlich gefundenes Handle. */
export type GriffZustand = PermissionState | 'kein-griff';

/**
 * Nur eine ERTEILTE Berechtigung ist nutzbar. `'prompt'` ist nach einem
 * Neuladen der übliche Ausgangszustand — das Handle selbst überlebt den
 * Neustart (IndexedDB), die Erlaubnis nicht zwangsläufig, weil Browser sie
 * pro Sitzung neu verlangen. `'denied'` und `'kein-griff'` sind für diese
 * Funktion gleichwertig: in beiden Fällen bleibt nur „Ordner erneut wählen".
 */
export function griffNutzbar(zustand: GriffZustand): boolean {
	return zustand === 'granted';
}
