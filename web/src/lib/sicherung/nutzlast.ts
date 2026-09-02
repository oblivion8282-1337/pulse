/**
 * Der Sicherungs-Eintrag: was eine Zeile im Sicherungs-Log IST — die
 * verschlüsselte Nutzlast eines Rahmens vom Typ 3 (ablage/format.ts).
 *
 * Zwei Felder, die das Kanal-Ablage-Nutzlast-Schema (ablage/nutzlast.ts)
 * nicht trägt: die **kanalId** — der Sicherungs-Container fasst ALLE
 * verschlüsselten Gespräche des Kontos in EINEN Bestand, deshalb reist der
 * Kanal je Eintrag mit — und die Fassung des Umschlags selbst.
 *
 * Bewusst DRAUSSEN am Rahmen: die Eintrags-Id im Rahmenkopf ist der
 * gerätelokale Folgezähler des Spiegels (spiegel.ts), NICHT die Snowflake
 * der Nachricht — zwei Geräte zählen unabhängig, und die echte Ordnung
 * kommt beim Wiederherstellen aus den Nachricht-Ids der Nutzlasten.
 *
 * Rein rechnerisch, Node-Testläufer-regel.
 */

import { leseNachricht, type AblageNachricht } from '../ablage/nutzlast.ts';

export const SICHERUNG_EINTRAG_FASSUNG = 1;

export interface SicherungEintrag {
	fassung: number;
	kanalId: string;
	nachricht: AblageNachricht;
}

/** Übersetzt eine Nachricht vom Wire in einen Sicherungs-Eintrag. */
export function sicherungEintrag(kanalId: string, nachricht: AblageNachricht): SicherungEintrag {
	return { fassung: SICHERUNG_EINTRAG_FASSUNG, kanalId, nachricht };
}

/** Festes Feldfolge — gleicher Eintrag ergibt immer gleiche Bytes. */
export function kodiereSicherungEintrag(eintrag: SicherungEintrag): Uint8Array {
	const n = eintrag.nachricht;
	return new TextEncoder().encode(
		JSON.stringify({
			fassung: eintrag.fassung,
			kanalId: eintrag.kanalId,
			nachricht: {
				fassung: n.fassung,
				id: n.id,
				autor: n.autor,
				inhalt: n.inhalt,
				zeit: n.zeit,
				bearbeitet: n.bearbeitet,
				antwortAuf: n.antwortAuf,
				anhaenge: n.anhaenge,
				// Grabstein-Markierung reist mit — ohne sie wäre der Stein nach
				// dem Entschlüsseln von einer normalen Nachricht ununterscheidbar.
				geloescht: n.geloescht ? true : undefined,
			},
		}),
	);
}

/** Strenger Parse: jede Abweichung vom Schema ist ein Befund. */
export function leseSicherungEintrag(bytes: Uint8Array): SicherungEintrag {
	const roh = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
	if (roh.fassung !== SICHERUNG_EINTRAG_FASSUNG) {
		throw new Error(`Unbekannte Sicherungs-Eintrag-Fassung: ${String(roh.fassung)}`);
	}
	if (typeof roh.kanalId !== 'string' || roh.kanalId.length === 0) {
		throw new Error('kanalId fehlt oder ist kein String');
	}
	return {
		fassung: SICHERUNG_EINTRAG_FASSUNG,
		kanalId: roh.kanalId,
		nachricht: leseNachricht(new TextEncoder().encode(JSON.stringify(roh.nachricht))),
	};
}
