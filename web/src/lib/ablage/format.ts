/**
 * Rahmen-Format des Ablage-Logs — die Draufsicht auf eine Datei voller Rahmen.
 *
 * Bewusst rein rechnerisch und import-frei: der Node-Testläufer kann die
 * Datei ohne Auflösung von Nachbar-Imports prüfen, und der spätere
 * Krypto-Nachzug tauscht nur Nutzlasten, nicht dieses Format
 * (Konzept: docs/user-gehostete-kanaele-konzept.md, §6a).
 *
 * Ein Rahmen:
 *
 *   "PULS" (4) | Fassung (1) | Typ (1) | Eintrags-Id (8, big endian)
 *   | Nutzlast-Länge (4, big endian) | Nutzlast
 *
 * Das Typ-Byte macht den Formatbruch überflüssig: Phase 1 schreibt
 * Klartext-JSON (Typ 1), der Krypto-Nachzug schreibt Megolm-Ciphertext
 * (Typ 2). Ein Leser beider Phasen kennt die Nutzlast als opake Bytes und
 * entscheidet anhand des Typs, wer sie öffnen darf. Die Eintrags-Id ist die
 * Snowflake der Nachricht — sie gibt dem Log seine Ordnung, auch wenn das
 * Manifest fehlt und aus den Segmenten neu gebaut werden muss.
 */

export const RAHMEN_KENNUNG = 0x50554c53; // "PULS"
export const RAHMEN_FASSUNG = 1;
export const RAHMEN_KOPF_LAENGE = 18;

/** Nutzlast Klartext-JSON (Phase „Speicher zuerst"). */
export const TYP_KLARTEXT_JSON = 1;
/**
 * Nutzlast Megolm-Geheimtext — **reserviert und absichtlich ungenutzt.**
 *
 * Der Krypto-Nachzug legt seit dem 2026-09-01 den ENTSCHLÜSSELTEN Text ab
 * (`postfachQuelle.ts`, Begründung dort): eine Megolm-Sitzung rotiert bei
 * jedem Mitgliederwechsel, und ein Archiv, das Jahre überleben soll, kann
 * nicht an Schlüsseln hängen, die es dann längst nicht mehr gibt. Der
 * Geheimtext im Archiv wäre ohne genau diese rotierten Sitzungen wertlos.
 *
 * Die Nummer bleibt vergeben, damit sie niemand anders belegt, falls doch
 * einmal roh abgelegt werden soll.
 *
 * **Der Leser wertet den Typ nicht aus** — er reicht ihn durch, und wer die
 * Rahmen verbraucht, entscheidet. Ein unbekannter Typ wirft hier also nicht,
 * er kommt beim Verbraucher an. Das ist Absicht: ein Archiv, das ein
 * spätererer Pulse mit einem neuen Typ geschrieben hat, soll für einen
 * älteren lesbar bleiben, soweit es geht.
 */
export const TYP_MEGOLM = 2;

/** Abweisungswert gegen Müll, der zufällig Kennung und Fassung trifft. */
export const NUTZLAST_MAX_LAENGE = 4 * 1024 * 1024;

export interface Rahmen {
	typ: number;
	eintragsId: bigint;
	nutzlast: Uint8Array;
}

export type RahmenAbbruchGrund =
	| 'abgeschnitten'
	| 'unbekannteKennung'
	| 'unbekannteFassung'
	| 'unplaessigeLaenge';

export class RahmenAbbruch extends Error {
	readonly grund: RahmenAbbruchGrund;
	readonly bei: number;

	constructor(grund: RahmenAbbruchGrund, bei: number) {
		super(`Rahmen abgebrochen bei ${bei}: ${grund}`);
		this.name = 'RahmenAbbruch';
		this.grund = grund;
		this.bei = bei;
	}
}

export function kodiereRahmen(
	eintragsId: bigint,
	nutzlast: Uint8Array,
	typ: number = TYP_KLARTEXT_JSON,
): Uint8Array {
	if (eintragsId < 0n || eintragsId >= 1n << 64n) {
		throw new RangeError(`Eintrags-Id außerhalb von u64: ${eintragsId}`);
	}
	if (nutzlast.length > NUTZLAST_MAX_LAENGE) {
		throw new RangeError(`Nutzlast zu groß: ${nutzlast.length}`);
	}
	const rahmen = new Uint8Array(RAHMEN_KOPF_LAENGE + nutzlast.length);
	const sicht = new DataView(rahmen.buffer);
	sicht.setUint32(0, RAHMEN_KENNUNG);
	sicht.setUint8(4, RAHMEN_FASSUNG);
	sicht.setUint8(5, typ);
	sicht.setBigUint64(6, eintragsId);
	sicht.setUint32(14, nutzlast.length);
	rahmen.set(nutzlast, RAHMEN_KOPF_LAENGE);
	return rahmen;
}

/** Hängt bereits kodierte Rahmen aneinander — das Nutzlast-Format bleibt opak. */
export function kodiereRahmenFolge(rahmen: Rahmen[]): Uint8Array {
	const teile = rahmen.map((r) =>
		kodiereRahmen(r.eintragsId, r.nutzlast, r.typ),
	);
	const laenge = teile.reduce((summe, t) => summe + t.length, 0);
	const folge = new Uint8Array(laenge);
	let bei = 0;
	for (const teil of teile) {
		folge.set(teil, bei);
		bei += teil.length;
	}
	return folge;
}

/** Liest genau einen Rahmen; wirft `RahmenAbbruch`, wenn Restmüll gelesen würde. */
export function leseRahmen(
	bytes: Uint8Array,
	ab: number = 0,
): { rahmen: Rahmen; naechster: number } {
	if (bytes.length - ab < RAHMEN_KOPF_LAENGE) {
		throw new RahmenAbbruch('abgeschnitten', ab);
	}
	const sicht = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (sicht.getUint32(ab) !== RAHMEN_KENNUNG) {
		throw new RahmenAbbruch('unbekannteKennung', ab);
	}
	const fassung = sicht.getUint8(ab + 4);
	if (fassung !== RAHMEN_FASSUNG) {
		throw new RahmenAbbruch('unbekannteFassung', ab);
	}
	const typ = sicht.getUint8(ab + 5);
	const eintragsId = sicht.getBigUint64(ab + 6);
	const laenge = sicht.getUint32(ab + 14);
	if (laenge > NUTZLAST_MAX_LAENGE || ab + RAHMEN_KOPF_LAENGE + laenge > bytes.length) {
		throw new RahmenAbbruch('unplaessigeLaenge', ab);
	}
	return {
		rahmen: {
			typ,
			eintragsId,
			nutzlast: bytes.slice(ab + RAHMEN_KOPF_LAENGE, ab + RAHMEN_KOPF_LAENGE + laenge),
		},
		naechster: ab + RAHMEN_KOPF_LAENGE + laenge,
	};
}

/**
 * Liest so viele Rahmen wie sauber lesbar. Ein abgebrochenes Ende (gekappte
 * Schreiboperation, ausgetauschte Datei) ist kein Fehler, sondern ein Befund:
 * die Rahmengrenze markiert, wie weit dem Inhalt zu trauen ist.
 */
export function leseRahmenFolge(bytes: Uint8Array): {
	rahmen: Rahmen[];
	abbruch: RahmenAbbruch | null;
} {
	const rahmen: Rahmen[] = [];
	let bei = 0;
	while (bei < bytes.length) {
		try {
			const schritt = leseRahmen(bytes, bei);
			rahmen.push(schritt.rahmen);
			bei = schritt.naechster;
		} catch (abbruch) {
			if (abbruch instanceof RahmenAbbruch) {
				return { rahmen, abbruch };
			}
			throw abbruch;
		}
	}
	return { rahmen, abbruch: null };
}
