/**
 * Die Verbindungsprobe eines Laufwerks — beim Pulse-Server angefragt.
 *
 * **Warum nicht im Browser.** Die Probe schreibt, und Schreiben aus dem
 * Browser in eine fremde Cloud scheitert an CORS: an einer echten Nextcloud
 * gemessen (2026-09-01) kommt weder auf die Vorabfrage noch auf das echte
 * `PUT` eine `Access-Control-Allow-Origin`-Kopfzeile zurück, obwohl derselbe
 * Aufruf serverseitig mit 201 durchgeht. Der Nutzer las daraufhin „Der Link
 * durfte nicht schreiben" und suchte in seinen Freigabe-Einstellungen nach
 * einem Fehler, den es dort nicht gab.
 *
 * Der Entwurf sah es ohnehin so vor: lesen darf direkt, **schreiben läuft
 * über Pulse** (§1, §4.0a, und `ablage/direktMitRueckfall.ts` sagt es
 * wörtlich). Die alte Klient-Probe hielt sich nicht an die eigene Regel.
 *
 * `ablage/probe.ts` bleibt bestehen und wird weiter geprüft: sie gilt für
 * Adapter, die im Browser wirklich schreiben können — den Sync-Ordner auf
 * diesem Gerät.
 */

import { request } from './client';
import type { ProbeErgebnis, ProbeSchritt } from '$lib/ablage/probe';

interface ProbeAntwort {
	gut: boolean;
	schritt: ProbeSchritt | null;
	grund: string | null;
}

/**
 * Lässt den Server schreiben, lesen, vergleichen und löschen.
 *
 * Ein nicht bestandener Lauf ist kein Fehler, sondern ein Ergebnis
 * (`gut: false`) — geworfen wird nur, wenn die Anfrage selbst scheitert.
 */
export async function pruefeAblageZiel(freigabeAdresse: string): Promise<ProbeErgebnis> {
	const antwort = await request<ProbeAntwort>('/ablage/pruefen', {
		method: 'POST',
		body: { freigabe_adresse: freigabeAdresse }
	});
	if (antwort.gut) return { gut: true };
	return {
		gut: false,
		// Der Server liefert dieselben vier Schritt-Namen; fehlt einer, ist
		// „schreiben" die ehrlichste Annahme — der erste Schritt ist der, an
		// dem ein Laufwerk am häufigsten scheitert.
		schritt: antwort.schritt ?? 'schreiben',
		grund: antwort.grund ?? 'unbekannt'
	};
}
