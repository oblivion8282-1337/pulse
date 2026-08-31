/**
 * Die Verdrahtung des Wiederherstellungs-Satzes (E4, Aufgabe 4): Päckchen
 * schnüren, hochladen, holen, öffnen, Verbindungen zurückschreiben. Verbindet
 * `krypto/wiederherstellungsCode.ts` + `krypto/wiederherstellungsPaeckchen.ts`
 * (beide importfrei, s. dort) mit `api/recovery-package.ts` und dem
 * bestehenden Store `ablage/verbindungen.svelte.ts` — NUR benutzt, nicht
 * verändert (dort arbeitet parallel jemand anders, s. Auftrag).
 *
 * Nicht importfrei: braucht `ablageVerbindungen` (Svelte-Runes) und
 * `aktuellesKonto()`. Die Komponenten importieren diese Datei, nicht die
 * beiden reinen Krypto-Module direkt — eine Änderung an deren Namen träfe
 * dann nur eine Stelle.
 */

import { erzeugeCode, normalisiere, codeBytes, CodeFehler } from './wiederherstellungsCode.ts';
import {
	packePaeckchen,
	öffnePaeckchen,
	WiederherstellungsFehler,
	type PaeckchenVerbindung,
} from './wiederherstellungsPaeckchen.ts';
import { bytesZuBase64, base64ZuBytes } from '../ablage/syncOrdnerSchluessel.ts';
import {
	ablageVerbindungen,
	type AblageAnbieterArt,
} from '../ablage/verbindungen.svelte.ts';
import { aktuellesKonto } from '../verlauf/konto.ts';
import { putRecoveryPackage, getRecoveryPackage, istKeinPaeckchenFehler } from '../api/recovery-package';

/**
 * Die drei Fälle, die die Oberfläche beim Einlösen trennen MUSS (Auftrag,
 * Aufgabe 4) — sonst rät der Nutzer, was er falsch gemacht hat:
 *
 * - `codeFalsch`: der Code passt nicht (Tippfehler) ODER das Päckchen ist
 *   beschädigt/aus einer unbekannten Fassung — beides sieht für GCM und für
 *   den Nutzer gleich aus: „dieser Code öffnet dieses Päckchen nicht".
 * - `keinPaeckchen`: kein Päckchen für DIESES Konto — entweder weil der
 *   Server 404 meldet, oder weil das geöffnete Päckchen (defense in depth,
 *   sollte serverseitig nie vorkommen) einer anderen Konto-Id gehört.
 * - `nichtErreichbar`: der Server antwortet nicht — ob überhaupt ein
 *   Päckchen existiert, ist in diesem Moment unbekannt.
 */
export type EinloeseFall = 'codeFalsch' | 'keinPaeckchen' | 'nichtErreichbar';

export class EinloeseFehler extends Error {
	readonly fall: EinloeseFall;
	constructor(fall: EinloeseFall, meldung: string) {
		super(meldung);
		this.name = 'EinloeseFehler';
		this.fall = fall;
	}
}

function pruefeAngemeldet(): string {
	const konto = aktuellesKonto();
	if (!konto) throw new Error('Wiederherstellung braucht ein angemeldetes Konto.');
	return konto;
}

async function sammleVerbindungen(): Promise<PaeckchenVerbindung[]> {
	if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
	return ablageVerbindungen.verbindungen.map((v) => ({
		id: v.id,
		anbieter: v.anbieter,
		name: v.name,
		konfiguration: v.konfiguration,
		hauptschlüsselB64: v.hauptschlüsselB64,
		verbundenAm: v.verbundenAm,
	}));
}

/**
 * Erzeugt einen frischen Code, schnürt daraus das Päckchen und legt es beim
 * Server ab (ersetzt ein vorhandenes — das IST das Erneuern: der alte Code
 * leitet nie wieder denselben Schlüssel ab, sobald `ciphertext` überschrieben
 * ist). Gibt den Code in Anzeigeform zurück — **einmalig**, der Aufrufer
 * zeigt ihn und lässt ihn danach fallen; diese Funktion behält ihn nicht.
 */
export async function erzeugeUndSichere(): Promise<string> {
	const kontoId = pruefeAngemeldet();
	const code = erzeugeCode();
	const bytes = codeBytes(normalisiere(code));
	const verbindungen = await sammleVerbindungen();
	const paeckchen = await packePaeckchen(bytes, {
		erstelltAm: new Date().toISOString(),
		kontoId,
		verbindungen,
	});
	await putRecoveryPackage(bytesZuBase64(paeckchen));
	return code;
}

/**
 * Löst einen vorgelegten Code ein: holt das Päckchen vom Server, öffnet es
 * und schreibt die enthaltenen Verbindungen in den lokalen Store zurück.
 * Wirft immer `EinloeseFehler` mit einem der drei Fälle — nie eine rohe
 * `ApiError`/`WiederherstellungsFehler`, damit die Oberfläche nicht selbst
 * zwischen den Fehlertypen der beiden Schichten unterscheiden muss.
 */
export async function loeseEin(eingabe: string): Promise<{ anzahl: number }> {
	const kontoId = pruefeAngemeldet();

	let bytes: Uint8Array;
	try {
		bytes = codeBytes(normalisiere(eingabe));
	} catch (fehler) {
		if (fehler instanceof CodeFehler) {
			throw new EinloeseFehler('codeFalsch', 'Der Code hat nicht die erwartete Form.');
		}
		throw fehler;
	}

	let paket: Awaited<ReturnType<typeof getRecoveryPackage>>;
	try {
		paket = await getRecoveryPackage();
	} catch (fehler) {
		if (istKeinPaeckchenFehler(fehler)) {
			throw new EinloeseFehler('keinPaeckchen', 'Für dieses Konto liegt kein Wiederherstellungs-Päckchen vor.');
		}
		throw new EinloeseFehler('nichtErreichbar', 'Der Server antwortet gerade nicht — später erneut versuchen.');
	}

	let inhalt;
	try {
		inhalt = await öffnePaeckchen(bytes, base64ZuBytes(paket.ciphertext));
	} catch (fehler) {
		if (fehler instanceof WiederherstellungsFehler) {
			throw new EinloeseFehler('codeFalsch', 'Der Code passt nicht zum abgelegten Päckchen.');
		}
		throw fehler;
	}

	// Defense in depth: die Route ist bereits auf `current.id` gescoped, ein
	// Päckchen eines fremden Kontos sollte hier nie ankommen. Träfe es doch
	// zu, ist das für den Nutzer ununterscheidbar von „kein Päckchen für
	// dieses Konto" — genau das sagt die Meldung.
	if (inhalt.kontoId !== kontoId) {
		throw new EinloeseFehler('keinPaeckchen', 'Das abgelegte Päckchen gehört zu einem anderen Konto.');
	}

	for (const v of inhalt.verbindungen) {
		await ablageVerbindungen.hinzufügen({
			id: v.id,
			anbieter: v.anbieter as AblageAnbieterArt,
			name: v.name,
			konfiguration: v.konfiguration,
			hauptschlüsselB64: v.hauptschlüsselB64,
			verbundenAm: v.verbundenAm,
			kontoId,
		});
	}

	return { anzahl: inhalt.verbindungen.length };
}
