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
}

export class NutzlastFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'NutzlastFehler';
	}
}

/** Übersetzt eine Nachricht vom Wire in die Bestand-Form. */
export function ausWire(m: Message): AblageNachricht {
	return {
		fassung: NUTZLAST_FASSUNG,
		id: m.id,
		autor: m.author_id,
		inhalt: m.content,
		zeit: m.created_at,
		bearbeitet: m.edited_at ?? null,
		antwortAuf: m.reply_to_id ?? null,
		anhaenge: (m.attachments ?? []).map((a) => ({
			id: a.id,
			name: a.filename,
			mime: a.mime,
			groesse: a.size,
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
	const anhaenge = roh.anhaenge.map((a) => {
		const anhang = a as Record<string, unknown>;
		if (typeof anhang.id !== 'string' || typeof anhang.groesse !== 'number') {
			throw new NutzlastFehler('Anhang ohne id oder groesse');
		}
		return {
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
	};
}
