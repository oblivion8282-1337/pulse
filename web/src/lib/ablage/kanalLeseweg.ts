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
 * **Der Ablage-Hauptschluessel entschluesselt seit dem 2026-09-01 den
 * Behaelter selbst.** Manifest und Segmentdateien liegen weiterhin als
 * Klartext-JSON-Rahmen (`TYP_KLARTEXT_JSON`) VOR dem Schreiben vor — das
 * ist die Payload-Ebene, unveraendert seit `manifest.ts`/`schreiber.ts`.
 * Was neu ist: der Adapter, der die Bytes tatsaechlich aufs Laufwerk legt,
 * ist hier mit `verschluesselnderAdapter` (`kryptoBehaelter.ts`) umschlossen
 * — er verschluesselt beim Schreiben und entschluesselt beim Lesen, `leser.ts`
 * bekommt weiterhin exakt die Klartext-Bytes, die es kennt. Der
 * Hauptschluessel wird deshalb WEITERHIN auch dann verlangt, wenn er nichts
 * zu entschluesseln faende (Design §3.1: „Erst alle drei zusammen ergeben
 * Lesbarkeit") — jetzt zusaetzlich, weil er es im Regelfall tut.
 */

import { leseVerlauf } from './leser.ts';
import { direktMitRueckfallAdapter } from './direktMitRueckfall.ts';
import { verschluesselnderAdapter } from './kryptoBehaelter.ts';
import { webdavAdapter } from './webdav.ts';
import { ablageKanalAbruf } from '../api/ablageKanal';
import { kanalLaufwerkSchluesselLaden } from './kanalLaufwerkSchluessel.ts';
import { tokenAusWebdavBasis } from './freigabeBasisToken.ts';
import { base64ZuBytes } from './syncOrdnerSchluessel.ts';
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
	const roh = direktMitRueckfallAdapter({
		schluessel: `kanal:${kanalId}`,
		direkt,
		ueberPulse: (datei) => ablageKanalAbruf(kanalId, datei, route)
	});
	const adapter = verschluesselnderAdapter(roh, base64ZuBytes(schluessel.hauptschluessel));

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
