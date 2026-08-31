/**
 * Das Wiederherstellungs-Päckchen (E4, Aufgabe 2): der verschlüsselte Block, mit dem ein ZWEITES
 * Gerät dasselbe Archiv sieht wie das erste.
 *
 * ## Was hineingehört — am Code nachgesehen, nicht geraten
 *
 * `ablage/verbindungen.svelte.ts::AblageVerbindung` trägt zwei Dinge, die ein frisches Gerät nicht
 * selbst herstellen kann:
 *
 * 1. **`hauptschlüsselB64` — der Ablage-Hauptschlüssel.** 32 Bytes aus `getRandomValues`
 *    (`ablage/syncOrdnerSchluessel.ts`), liegen ausschliesslich in der gerätelokalen IndexedDB
 *    `pulse-ablage-verbindungen` und nirgends sonst; der Modulkopf dort sagt ausdrücklich „Der
 *    Server sieht von diesem Store NICHTS". Mit ihm werden Verzeichnis und Dateikopf jeder Datei
 *    entschlüsselt (`ablage/dateispeicher.ts` → `ablage/dateiablage.ts`). Ohne ihn ist die Ablage
 *    endgültig Chiffrat. Das ist der eigentliche Grund für dieses Päckchen.
 * 2. **`konfiguration` — der Ort samt Zugang.** Endpunkt, Ordner, Eimer, Token, Passwort; bei
 *    Nextcloud ist der Freigabe-Link selbst der Zugang (`ablage/freigabeLink.ts`: „Der Link ist
 *    ein Schlüssel in Textform"). Ohne diese Angaben wüsste das neue Gerät zwar, WIE es
 *    entschlüsselt, aber nicht, WO etwas liegt.
 *
 * `anbieter`, `name` und `verbundenAm` kommen mit, weil `adapterFür()` den Anbieter braucht und
 * der Nutzer die wiederhergestellte Verbindung wiedererkennen soll. `anmeldungAbgelaufen` und
 * `zuletztGesichertAm` bleiben draussen: beides ist Zustand DIESES Geräts, kein Wissen.
 *
 * ## Was ausdrücklich NICHT hineingehört
 *
 * - **Die Geräte-Identität.** Der vodozemac-Account wird mit einem Schlüssel eingefroren, der aus
 *   einem `extractable: false`-Geheimnis abgeleitet wird (`geraeteGeheimnis.ts`,
 *   `pickelschluessel.ts`). Er ist hier nicht nur unerwünscht — er ist technisch nicht auslesbar.
 *   Ein neues Gerät meldet sich selbst an und veröffentlicht eigene Schlüssel.
 * - **Ein Schlüssel für den lokalen Verlauf: es gibt heute keinen.** `verlauf/db.ts` und
 *   `verlauf/verbindung.ts` legen `Satz`-Zeilen unverschlüsselt in der IndexedDB `pulse-verlauf`
 *   ab; in `verlauf/` kommt `crypto` an keiner Stelle vor. Der lokal abgelegte Verlauf braucht
 *   also nichts aus diesem Päckchen — er wird auf dem neuen Gerät aus der Ablage neu aufgebaut,
 *   und dafür genügen Hauptschlüssel und Ort. Auch die Segment- und Manifest-Dateien der Ablage
 *   liegen heute unverschlüsselt (`ablage/segment.ts`, `ablage/format.ts`); je Ablage-Ordner
 *   existiert genau ein Schlüssel, und das ist der Hauptschlüssel oben. **Bringt der
 *   Krypto-Nachzug einen zweiten hervor, gehört er hierher** — das ist der Anlass,
 *   `INHALT_FASSUNG` zu erhöhen.
 *
 * ## Verpacken
 *
 * HKDF-SHA-256 aus den Code-Bytes mit zufälligem Salz, daraus ein AES-256-GCM-Schlüssel. Beides
 * kann WebCrypto von sich aus — keine neue Abhängigkeit, keine Rust-Änderung.
 *
 * **Keine Schlüsselstreckung (Argon2 und Verwandte), und das ist Absicht.** Streckung kauft Zeit
 * gegen das Durchprobieren eines von Menschen GEWÄHLTEN Passworts. Der Code hier wird erzeugt,
 * nicht gewählt, und trägt volle Entropie (`wiederherstellungsCode.ts`: 128 Bit aus
 * `getRandomValues`), und `MINDEST_CODE_BYTES` weist alles Kürzere hier ab, statt der Annahme zu
 * vertrauen. Gegen einen Suchraum dieser Grösse ändert ein Streckungsfaktor nichts, was zählt.
 * Wer hier später „sicherheitshalber" eine KDF-Kiste einzieht, kehrt diese Begründung um und
 * sollte vorher sagen, wogegen sie schützen soll.
 *
 * Format, nach dem Vorbild von `ablage/dateiablage.ts`:
 *
 *   "PWHP" (4) | Fassung (1) | Salz (16) | IV (12) | Geheimtext (AES-256-GCM)
 *
 * Die 33 Kopfbytes gehen als `additionalData` in GCM ein. Der Leser hier weist eine fremde Fassung
 * schon vor dem Entschlüsseln ab; die Bindung wirkt für einen KÜNFTIGEN Leser, der Fassung 2
 * kennt: er kann ein umetikettiertes Fassung-1-Päckchen nicht als Fassung 2 lesen, weil die Marke
 * dann nicht mehr passt.
 *
 * **Nichts Geheimes im Log und in keiner Meldung** — weder Code noch Schlüssel noch Klartext. Die
 * Fehlerwerte tragen deshalb ein `grund`-Feld (Muster: `ablage/segment.ts::SegmentFehler`), an dem
 * die Oberfläche die Fälle unterscheidet, ohne dass irgendwo Inhalt in einen String muss.
 *
 * Importfrei (s. CLAUDE.md zur Falle bei `pnpm test:unit`) — deshalb nimmt das Modul die
 * Code-Bytes als `Uint8Array` entgegen, statt `wiederherstellungsCode.ts` zu importieren. Das ist
 * zugleich die sauberere Naht: das Verpacken kümmert sich nicht darum, woher die Entropie kommt.
 * Base64 für den Transport zum Server ist Sache des Aufrufers; Helfer dafür stehen in
 * `ablage/syncOrdnerSchluessel.ts`.
 */

/** "PWHP" — Pulse Wiederherstellungs-Päckchen. */
export const PAECKCHEN_KENNUNG = 0x50574850;

/**
 * Die Fassung des BEHÄLTERS: wo Salz, IV und Geheimtext liegen und wie abgeleitet wird. Sie muss
 * steigen, sobald sich an dieser Aufteilung oder am Verfahren etwas ändert — ein Päckchen wird
 * Jahre später geöffnet, und ein Leser, der die neue Aufteilung nicht kennt, darf nicht raten.
 */
export const PAECKCHEN_FASSUNG = 1;

/**
 * Die Fassung des INHALTS: die Form des JSON im Geheimtext. Getrennt von der Behälter-Fassung,
 * weil beide sich unabhängig bewegen — ein zusätzliches Feld im JSON ändert nichts daran, wo das
 * Salz liegt.
 */
export const INHALT_FASSUNG = 1;

const SALZ_LAENGE = 16;
const IV_LAENGE = 12;
const KOPF_LAENGE = 4 + 1 + SALZ_LAENGE + IV_LAENGE;
/** Die Marke, die AES-GCM an den Geheimtext hängt. */
const GCM_MARKE_LAENGE = 16;

/**
 * Untergrenze für die Code-Bytes. `wiederherstellungsCode.ts` liefert 16 Bytes (128 Bit); weniger
 * anzunehmen hiesse, die Begründung „keine Streckung nötig" still aufzugeben.
 */
export const MINDEST_CODE_BYTES = 16;

/** Schreibt den Zweck in die Ableitung fest: derselbe Code ergibt nirgends sonst denselben
 *  Schlüssel. */
const HKDF_INFO = 'pulse-wiederherstellungs-paeckchen-v1';

/** Der Fall, ohne Text — daran unterscheidet die Oberfläche, ohne eine Meldung zu zerlegen. */
export type WiederherstellungsGrund =
	| 'codeZuKurz' | 'abgeschnitten' | 'fremdeKennung' | 'unbekannteBehaelterFassung'
	| 'nichtZuOeffnen' | 'unbekannteInhaltsFassung' | 'unlesbarerInhalt';

export class WiederherstellungsFehler extends Error {
	readonly grund: WiederherstellungsGrund;

	constructor(grund: WiederherstellungsGrund, meldung: string) {
		super(meldung);
		this.name = 'WiederherstellungsFehler';
		this.grund = grund;
	}
}

/**
 * Eine Ablage-Verbindung, wie sie im Päckchen liegt — die Teilmenge von
 * `ablage/verbindungen.svelte.ts::AblageVerbindung`, die ein anderes Gerät braucht. Bewusst hier
 * neu erklärt statt importiert: der Store dort legt beim Import Svelte-Runes an und ist im
 * Node-Testläufer nicht ladbar.
 */
export interface PaeckchenVerbindung {
	id: string;
	anbieter: string;
	name: string;
	/** Ort und Zugang — je Anbieter verschieden, s. `adapterFür()`. */
	konfiguration: Record<string, string>;
	/** Der Ablage-Hauptschlüssel, Base64. Der unwiederbringliche Teil. */
	hauptschlüsselB64: string;
	verbundenAm: string;
}

export interface WiederherstellungsInhalt {
	fassung: number;
	/** Wann das Päckchen geschnürt wurde — für die Oberfläche („zuletzt erneuert am"), nicht für
	 *  eine Entscheidung im Code. */
	erstelltAm: string;
	/** Cloud-User-ID des Kontos, dem das Päckchen gehört. Erlaubt dem Einlöseweg, ein Päckchen
	 *  eines FREMDEN Kontos zu erkennen, statt Verbindungen zu übernehmen, die nicht zu diesem
	 *  Nutzer gehören. */
	kontoId: string;
	verbindungen: PaeckchenVerbindung[];
}

const zufallsBytes = (laenge: number): Uint8Array =>
	globalThis.crypto.getRandomValues(new Uint8Array(laenge));

/**
 * Kopiert die Bytes in einen eigenen Puffer. Das `slice()` ist nicht Zierrat: `bytes.buffer` einer
 * Sicht IN einen grösseren Puffer (`subarray`) wäre der GANZE Puffer, nicht der Ausschnitt —
 * verschlüsselt oder authentifiziert würde dann etwas anderes als gemeint. `öffnePaeckchen`
 * bekommt genau solche Sichten (Prüfstein: „ein Päckchen mitten in einem grösseren Puffer").
 */
const eigen = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

function pruefeCode(codeBytes: Uint8Array): void {
	// Nennt die Grenze, nie den Code.
	if (codeBytes.length < MINDEST_CODE_BYTES) {
		throw new WiederherstellungsFehler(
			'codeZuKurz',
			`Der Wiederherstellungs-Code trägt zu wenig Zufall (mindestens ${MINDEST_CODE_BYTES} Bytes nötig).`,
		);
	}
}

async function schluesselAusCode(
	codeBytes: Uint8Array,
	salz: Uint8Array,
	nutzung: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
	const krypto = globalThis.crypto.subtle;
	// `extractable: false` ist bei HKDF keine Wahl — WebCrypto wirft sonst.
	const roh = await krypto.importKey('raw', eigen(codeBytes), 'HKDF', false, ['deriveKey']);
	const info = eigen(new TextEncoder().encode(HKDF_INFO));
	const ableitung = { name: 'HKDF', hash: 'SHA-256', salt: eigen(salz), info };
	return krypto.deriveKey(ableitung, roh, { name: 'AES-GCM', length: 256 }, false, [nutzung]);
}

function baueKopf(salz: Uint8Array, iv: Uint8Array): Uint8Array {
	const kopf = new Uint8Array(KOPF_LAENGE);
	const sicht = new DataView(kopf.buffer);
	sicht.setUint32(0, PAECKCHEN_KENNUNG);
	sicht.setUint8(4, PAECKCHEN_FASSUNG);
	kopf.set(salz, 5);
	kopf.set(iv, 5 + SALZ_LAENGE);
	return kopf;
}

// ---------------------------------------------------------------------------

/**
 * Schnürt das Päckchen. `inhalt` kommt ohne `fassung` herein — die setzt diese Funktion, damit
 * kein Aufrufer eine falsche hineinschreiben kann.
 *
 * Erneuern ist derselbe Aufruf mit einem neuen Code: das alte Päckchen lässt sich damit nicht
 * mehr öffnen, weil aus dem alten Code niemals derselbe Schlüssel entsteht.
 */
export async function packePaeckchen(
	codeBytes: Uint8Array,
	inhalt: Omit<WiederherstellungsInhalt, 'fassung'>,
): Promise<Uint8Array> {
	pruefeCode(codeBytes);
	const salz = zufallsBytes(SALZ_LAENGE);
	const iv = zufallsBytes(IV_LAENGE);
	const kopf = baueKopf(salz, iv);

	const klar = new TextEncoder().encode(
		JSON.stringify({ fassung: INHALT_FASSUNG, ...inhalt } satisfies WiederherstellungsInhalt),
	);
	const schluessel = await schluesselAusCode(codeBytes, salz, 'encrypt');
	const gcm = { name: 'AES-GCM', iv: eigen(iv), additionalData: eigen(kopf) };
	const dunkel = new Uint8Array(
		await globalThis.crypto.subtle.encrypt(gcm, schluessel, eigen(klar)),
	);

	const gesamt = new Uint8Array(KOPF_LAENGE + dunkel.length);
	gesamt.set(kopf, 0);
	gesamt.set(dunkel, KOPF_LAENGE);
	return gesamt;
}

/**
 * Öffnet ein Päckchen. Wirft `WiederherstellungsFehler` — nie eine beste Vermutung.
 *
 * **Falscher Code und verändertes Päckchen sehen gleich aus**, und zwar grundsätzlich: GCM prüft
 * die Marke, nicht die Herkunft des Schlüssels. Die Meldung nennt deshalb beide Möglichkeiten,
 * statt eine davon zu behaupten.
 */
export async function öffnePaeckchen(
	codeBytes: Uint8Array,
	paeckchen: Uint8Array,
): Promise<WiederherstellungsInhalt> {
	pruefeCode(codeBytes);

	// Ein leerer Klartext ist kein gültiges JSON, also muss über der Marke mindestens ein Byte
	// stehen. Die Prüfung kommt vor jedem `slice`, damit ein abgeschnittenes Päckchen einen klaren
	// Fehler ergibt statt still kurzer Scheiben, die erst die Entschlüsselung stolpern lassen.
	if (paeckchen.length <= KOPF_LAENGE + GCM_MARKE_LAENGE) {
		throw new WiederherstellungsFehler('abgeschnitten', 'Das Päckchen ist unvollständig.');
	}

	const sicht = new DataView(paeckchen.buffer, paeckchen.byteOffset, paeckchen.byteLength);
	if (sicht.getUint32(0) !== PAECKCHEN_KENNUNG) {
		throw new WiederherstellungsFehler(
			'fremdeKennung',
			'Diese Datei ist kein Pulse-Wiederherstellungs-Päckchen.',
		);
	}
	const fassung = sicht.getUint8(4);
	if (fassung !== PAECKCHEN_FASSUNG) {
		throw new WiederherstellungsFehler(
			'unbekannteBehaelterFassung',
			`Dieses Päckchen ist in Fassung ${fassung} geschrieben, diese Pulse-Fassung kennt ${PAECKCHEN_FASSUNG}.`,
		);
	}

	const salz = paeckchen.slice(5, 5 + SALZ_LAENGE);
	const iv = paeckchen.slice(5 + SALZ_LAENGE, KOPF_LAENGE);
	const kopf = paeckchen.slice(0, KOPF_LAENGE);
	const dunkel = paeckchen.slice(KOPF_LAENGE);

	const schluessel = await schluesselAusCode(codeBytes, salz, 'decrypt');
	const gcm = { name: 'AES-GCM', iv: eigen(iv), additionalData: eigen(kopf) };
	let klar: Uint8Array;
	try {
		klar = new Uint8Array(await globalThis.crypto.subtle.decrypt(gcm, schluessel, eigen(dunkel)));
	} catch {
		// Die verworfene Ausnahme wird bewusst nicht weitergereicht: sie käme aus WebCrypto und
		// trüge zwar nichts Geheimes, aber auch nichts, was dem Nutzer hilft.
		throw new WiederherstellungsFehler(
			'nichtZuOeffnen',
			'Das Päckchen liess sich nicht öffnen — der Code passt nicht, oder das Päckchen wurde verändert.',
		);
	}

	return deuteInhalt(klar);
}

/** Eine Meldung für alle Formfehler: welches Feld fehlt, ginge den Nutzer nichts an und stünde
 *  der Regel „nichts Geheimes in einer Meldung" gefährlich nahe. */
const unlesbar = () =>
	new WiederherstellungsFehler('unlesbarerInhalt', 'Der Inhalt des Päckchens ist unlesbar.');

/**
 * Prüft den entschlüsselten Klartext auf Form. An dieser Stelle ist der Inhalt bereits als echt
 * erwiesen (GCM); die Prüfungen fangen deshalb keinen Angreifer ab, sondern eine Fassung, die
 * diese hier noch nicht kennt.
 */
function deuteInhalt(klar: Uint8Array): WiederherstellungsInhalt {
	let roh: unknown;
	try {
		roh = JSON.parse(new TextDecoder().decode(klar));
	} catch {
		throw unlesbar();
	}
	if (typeof roh !== 'object' || roh === null) throw unlesbar();
	const daten = roh as Partial<WiederherstellungsInhalt>;

	if (typeof daten.fassung !== 'number' || !Number.isInteger(daten.fassung) || daten.fassung < 1) {
		throw unlesbar();
	}
	if (daten.fassung > INHALT_FASSUNG) {
		// Eine neuere Inhaltsfassung könnte Felder tragen, die hier stumm unter den Tisch fielen —
		// bei einem Archiv-Schlüsselbund ist eine halbe Wiederherstellung schlimmer als eine
		// verweigerte.
		throw new WiederherstellungsFehler(
			'unbekannteInhaltsFassung',
			`Das Päckchen stammt aus einer neueren Pulse-Fassung (Inhalt ${daten.fassung}, hier bekannt ${INHALT_FASSUNG}).`,
		);
	}
	if (
		typeof daten.erstelltAm !== 'string' ||
		typeof daten.kontoId !== 'string' ||
		!Array.isArray(daten.verbindungen) ||
		!daten.verbindungen.every(istVerbindung)
	) {
		throw unlesbar();
	}

	return {
		fassung: daten.fassung,
		erstelltAm: daten.erstelltAm,
		kontoId: daten.kontoId,
		verbindungen: daten.verbindungen,
	};
}

function istVerbindung(wert: unknown): wert is PaeckchenVerbindung {
	if (typeof wert !== 'object' || wert === null) return false;
	const v = wert as Partial<PaeckchenVerbindung>;
	return (
		typeof v.id === 'string' &&
		typeof v.anbieter === 'string' &&
		typeof v.name === 'string' &&
		typeof v.hauptschlüsselB64 === 'string' &&
		typeof v.verbundenAm === 'string' &&
		typeof v.konfiguration === 'object' &&
		v.konfiguration !== null &&
		Object.values(v.konfiguration).every((w) => typeof w === 'string')
	);
}
