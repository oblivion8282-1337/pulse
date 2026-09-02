/**
 * Das Nutzlast-Schema des Ablage-Logs: was eine Nachricht im Bestand IST,
 * getrennt von der Form, in der sie über die Leitung kommt. Phase 1 schreibt
 * Klartext-JSON (Rahmen-Typ 1); der Krypto-Nachzug behält dieselbe Feldstruktur
 * bei und steckt sie in Megolm-Nutzlasten — wer heute das Schema liest, liest
 * später den entschlüsselten Inhalt.
 *
 * Bewusst NICHT im Schema: die vorsignierten Abruf-Adressen der Anhänge
 * (kurzlebig, gehören nie in einen dauerhaften Bestand) und Reaktionen
 * (veränderlich — das Log ist append-only).
 *
 * Rein rechnerisch und import-frei bis auf den Typ-Import (wird zur
 * Laufzeit weggeblasen) — Node-Testläufer-regel.
 */

import type { Message } from '../api/types.ts';

export const NUTZLAST_FASSUNG = 1;

export interface AblageAnhang {
	id: string;
	name: string | null;
	mime: string | null;
	groesse: number;
}

export interface AblageNachricht {
	fassung: number;
	id: string;
	autor: string;
	inhalt: string;
	/** Zeitpunkt des Sendens, wie der Server ihn nennt (ISO). */
	zeit: string;
	/** Zeitpunkt der letzten Bearbeitung, sonst null. */
	bearbeitet: string | null;
	antwortAuf: string | null;
	anhaenge: AblageAnhang[];
	/** Grabstein: nur bei einem Lösch-Frame `true` (absent = nicht gelöscht).
	 *  Der Stein trägt nur die Id — Inhalt/Autor bleiben leer. Ältere Container
	 *  kennen das Feld nicht; der Parser liest es tolerant. */
	geloescht?: boolean;
}

export class NutzlastFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'NutzlastFehler';
	}
}

/** Übersetzt eine Nachricht vom Wire in die Bestand-Form. Die Anhänge
 *  werden VERBATIM übernommen (statt auf vier Felder verkürzt): bei
 *  verschlüsselten Nachrichten tragen sie den Dateischlüssel, ohne den
 *  kein wiederhergestelltes Gerät den Anhang je wieder öffnen könnte. */
export function ausWire(m: Message): AblageNachricht {
	return {
		fassung: NUTZLAST_FASSUNG,
		id: m.id,
		autor: m.author_id,
		inhalt: m.content,
		zeit: m.created_at,
		bearbeitet: m.edited_at ?? null,
		antwortAuf: m.reply_to_id ?? null,
		anhaenge: (m.attachments ?? []).map(({ url: _url, thumb_url: _thumb, ...dauerhaft }) => ({
			...dauerhaft,
			id: dauerhaft.id,
			name: dauerhaft.filename,
			mime: dauerhaft.mime,
			groesse: dauerhaft.size,
		})),
	};
}

/** Festes Feldfolge — gleiche Nachricht ergibt immer gleiche Bytes. */
export function kodiereNachricht(n: AblageNachricht): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			fassung: n.fassung,
			id: n.id,
			autor: n.autor,
			inhalt: n.inhalt,
			zeit: n.zeit,
			bearbeitet: n.bearbeitet,
			antwortAuf: n.antwortAuf,
			anhaenge: n.anhaenge,
			// Nur der Grabstein trägt das Feld — normaler Bestand bleibt
			// byte-identisch zum Feldstand vor der Grabstein-Erweiterung.
			geloescht: n.geloescht ? true : undefined,
		}),
	);
}

/** Strenger Parse: jede Abweichung vom Schema ist ein Befund. */
export function leseNachricht(bytes: Uint8Array): AblageNachricht {
	const roh = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
	if (roh.fassung !== NUTZLAST_FASSUNG) {
		throw new NutzlastFehler(`Unbekannte Nutzlast-Fassung: ${String(roh.fassung)}`);
	}
	for (const feld of ['id', 'autor', 'inhalt', 'zeit'] as const) {
		if (typeof roh[feld] !== 'string') {
			throw new NutzlastFehler(`${feld} fehlt oder ist kein String`);
		}
	}
	if (roh.bearbeitet !== null && typeof roh.bearbeitet !== 'string') {
		throw new NutzlastFehler('bearbeitet ist weder String noch null');
	}
	if (roh.antwortAuf !== null && typeof roh.antwortAuf !== 'string') {
		throw new NutzlastFehler('antwortAuf ist weder String noch null');
	}
	if (!Array.isArray(roh.anhaenge)) {
		throw new NutzlastFehler('anhaenge ist keine Liste');
	}
	// Tolerant: Feld einfach fehlt in jedem Bestand vor der Grabstein-
	// Erweiterung — nur ein FALSCHER Typ ist ein Befund.
	if (roh.geloescht !== undefined && typeof roh.geloescht !== 'boolean') {
		throw new NutzlastFehler('geloescht ist kein Boolean');
	}
	const anhaenge = roh.anhaenge.map((a) => {
		const anhang = a as Record<string, unknown>;
		if (typeof anhang.id !== 'string' || typeof anhang.groesse !== 'number') {
			throw new NutzlastFehler('Anhang ohne id oder groesse');
		}
		// Verbatim: Fremdfelder (z. B. der Dateischlüssel verschlüsselter
		// Anhänge) bleiben erhalten — das Wiederherstellen braucht sie.
		return {
			...anhang,
			id: anhang.id,
			name: anhang.name === null ? null : String(anhang.name),
			mime: anhang.mime === null ? null : String(anhang.mime),
			groesse: anhang.groesse,
		};
	});
	return {
		fassung: NUTZLAST_FASSUNG,
		id: roh.id as string,
		autor: roh.autor as string,
		inhalt: roh.inhalt as string,
		zeit: roh.zeit as string,
		bearbeitet: roh.bearbeitet as string | null,
		antwortAuf: roh.antwortAuf as string | null,
		anhaenge,
		// Absent bleibt absent (weder `false` noch ein undefined-Schlüssel) —
		// der Rundlauf einer normalen Nachricht ergibt wieder dasselbe Objekt.
		...(roh.geloescht === true ? { geloescht: true } : {}),
	};
}
