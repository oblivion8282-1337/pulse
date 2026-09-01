/**
 * Der Leseweg eines Ablage-Kanals fuer ein MITGLIED (Design §4): fuehrt die
 * beiden Enden aus dem Auftrag zusammen.
 *
 * **Ende 1** (`krypto/gruppe/empfangen.ts::verteilschluesselAufnehmen`) legt
 * den ueber das Postfach verteilten Ablage-Hauptschluessel + die
 * Freigabe-Adresse unter `kanalLaufwerkSchluessel.ts` ab, sobald sie
 * ankommen.
 *
 * **Ende 2** (`api/ablageKanal.ts::ablageKanalAbruf`) ist die
 * Weiterreich-Route fuer den Fall, dass der direkte Weg an CORS scheitert
 * (Design §4.2, an einer echten Nextcloud gemessen — `webdav.ts`-Kopf).
 *
 * Diese Datei baut daraus den tatsaechlichen `AblageAdapter`
 * (`direktMitRueckfallAdapter`, direkt = `webdavAdapter` mit der
 * zurueckgewonnenen Freigabe-Basis, s. `freigabeBasisToken.ts`) und liest
 * damit den Verlauf.
 *
 * **Fail-closed** (Auftrag): kennt dieses Geraet den Ablage-Hauptschluessel
 * und die Freigabe-Adresse nicht (noch keine Zustellung angekommen, oder
 * dieser Kanal ist gar kein Ablage-Kanal), gibt `kanalVerlaufLesen` `null`
 * zurueck — genau wie eine Gruppennachricht ohne Sitzung liegen bleibt. Es
 * wird nichts geraten, nichts halb angezeigt.
 *
 * **Was der Ablage-Hauptschluessel hier NICHT tut:** Manifest und
 * Segmentdateien liegen nach dem heutigen Schreiber
 * (`ablage/postfachQuelle.ts`, `ablage/schreiber.ts`) als Klartext-JSON auf
 * dem Laufwerk — dieselbe Rahmen-Form (`TYP_KLARTEXT_JSON`), die auch das
 * persoenliche Archiv schreibt; die container-weite Verschluesselung von
 * Manifest/Verzeichnis/Dateinamen, die `manifest.ts` als „Krypto-Nachzug"
 * ankuendigt, ist noch nicht gebaut. Der Hauptschluessel wird deshalb hier
 * NICHT zum Entschluesseln benutzt (es gaebe nichts Passendes zu
 * entschluesseln) — er wird trotzdem verlangt (Design §3.1: „Erst alle drei
 * zusammen ergeben Lesbarkeit"), damit ein Kanal, dessen Verteilung nur zur
 * Haelfte angekommen ist, als „noch nicht lesbar" gilt statt als lesbar mit
 * einem Loch. Sobald die Container-Verschluesselung existiert, ist dies die
 * Stelle, an der sie einzuhaengen ist.
 */

import { leseVerlauf } from './leser.ts';
import { direktMitRueckfallAdapter } from './direktMitRueckfall.ts';
import { webdavAdapter } from './webdav.ts';
import { ablageKanalAbruf } from '../api/ablageKanal';
import { kanalLaufwerkSchluesselLaden } from './kanalLaufwerkSchluessel.ts';
import { tokenAusWebdavBasis } from './freigabeBasisToken.ts';
import { TYP_KLARTEXT_JSON } from './format.ts';
import { leseNachricht, NutzlastFehler, type AblageNachricht } from './nutzlast.ts';
import type { RequestRoute } from '../api/client';

export interface KanalVerlaufErgebnis {
	nachrichten: AblageNachricht[];
	/** Segment-Luecken (aus `leser.ts`) UND Rahmen, die sich nicht als
	 *  Nachricht lesen liessen (unbekannter Typ, kaputtes JSON) — beides in
	 *  derselben Liste, denn fuer den Nutzer ist beides „hier fehlt etwas". */
	luecken: string[];
}

/**
 * Liest den Verlauf eines Ablage-Kanals fuer das AKTUELLE Geraet. `null`,
 * wenn dieses Geraet den Ablage-Hauptschluessel + die Freigabe-Adresse
 * (noch) nicht kennt — fail-closed, s. Modulkopf.
 */
export async function kanalVerlaufLesen(
	kanalId: string,
	route: RequestRoute = {}
): Promise<KanalVerlaufErgebnis | null> {
	const schluessel = await kanalLaufwerkSchluesselLaden(kanalId);
	if (!schluessel) return null;

	const direkt = webdavAdapter({
		basis: schluessel.freigabeAdresse,
		ordner: '',
		benutzer: tokenAusWebdavBasis(schluessel.freigabeAdresse),
		passwort: ''
	});
	const adapter = direktMitRueckfallAdapter({
		schluessel: `kanal:${kanalId}`,
		direkt,
		ueberPulse: (datei) => ablageKanalAbruf(kanalId, datei, route)
	});

	const verlauf = await leseVerlauf(adapter);
	const nachrichten: AblageNachricht[] = [];
	const luecken = [...verlauf.luecken];
	for (const rahmen of verlauf.rahmen) {
		if (rahmen.typ !== TYP_KLARTEXT_JSON) {
			// Unbekannter/reservierter Typ (z. B. TYP_MEGOLM) — s. `format.ts`:
			// darf den Leser nicht abwerfen, wird als Luecke benannt.
			luecken.push(`Rahmen ${rahmen.eintragsId}: unbekannter Typ ${rahmen.typ}`);
			continue;
		}
		try {
			nachrichten.push(leseNachricht(rahmen.nutzlast));
		} catch (fehler) {
			if (!(fehler instanceof NutzlastFehler)) throw fehler;
			luecken.push(`Rahmen ${rahmen.eintragsId}: ${fehler.message}`);
		}
	}
	return { nachrichten, luecken };
}
