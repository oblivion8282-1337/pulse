/**
 * Der Krypto-Kern der Sicherung: KEK/DEK-Trennung nach dem Muster der
 * verschlüsselten Dateiablage (ablage/dateiablage.ts), aber mit einem
 * menschlichen Entsperr-Geheimnis statt einem gerätelokalen Hauptschlüssel.
 *
 *   **DEK** — 32 zufällige Bytes, einmal bei der Einrichtung erzeugt. Er
 *   verschlüsselt jeden Sicherungs-Eintrag (Rahmen-Typ 3, lib/sicherung/
 *   nutzlast.ts) und das Gerät hält ihn in der Identity-IndexedDB vor, damit
 *   nicht jede Nachricht den Argon2-Lauf kostet.
 *
 *   **KEK** — Argon2id aus dem Sicherungs-Passwort, Parametern im Kopf von
 *   `key.puls`. Die Passphrase wird NIRGENDS gespeichert — nicht im
 *   Klienten, nicht auf dem Server. Geht sie verloren, ist das Archiv
 *   unwiederbringlich; dieselbe ehrliche Prämisse wie beim Postfach.
 *
 *   `key.puls`:
 *
 *     "PUSI" (4) | Fassung (1) | Argon2-Zeiten (1) | Speicher-KiB (4, BE)
 *     | Parallelität (1) | Salt-Länge (1) | Salt | Nonce (12)
 *     | AES-256-GCM(DEK) mit dem KEK
 *
 *   Nur dieser Kopf ist Klartext — das Salt darf er sein (ohne das Passwort
 *   ist es nutzlos), alles darunter nicht.
 *
 * Passwort-Änderung = nur Re-Wrap: neues Salt, neue Nonce, derselbe DEK —
 * das Archiv im Laufwerk bleibt bytegleich.
 *
 * Import-frei bis auf hash-wasm (npm-Paket, Node auflöst) — Node-Testläufer-regel.
 */

import { argon2id } from 'hash-wasm';

export const SICHERUNG_KENNUNG = 0x50555349; // "PUSI"
export const SICHERUNG_FASSUNG = 1;

export const DEK_LAENGE = 32;
export const SALT_LAENGE = 16;
const NONCE_LAENGE = 12;

/** Vorgaben analog argon2-cffi im Backend (CLAUDE.md: t=3/m=64MiB). */
export const ARGON_ZEITEN = 3;
export const ARGON_SPEICHER_KIB = 64 * 1024;
export const ARGON_PARALLELITAET = 1;

/** Domänentrennung der AES-GCM-Zusatzdaten — ein Schlüssel, zwei Welten. */
const AAD_SCHLUESSEL = 'pulse-sicherung-schluessel';
const AAD_EINTRAG = 'pulse-sicherung-eintrag';

export interface ArgonParameter {
	zeiten: number;
	speicherKiB: number;
	parallelitaet: number;
	salt: Uint8Array;
}

export class SicherungKryptoFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'SicherungKryptoFehler';
	}
}

function zufallsBytes(laenge: number): Uint8Array {
	const bytes = new Uint8Array(laenge);
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
}

/** Eigenständige Kopie — WebCrypto braucht echte ArrayBuffer, keine Views. */
function eigen(bytes: Uint8Array): Uint8Array {
	return bytes.slice();
}

/** Der KEK: Argon2id über das Passwort. Teuer mit Absicht — einmal je Entsperrung. */
export async function ableiteKek(
	passwort: string,
	parameter: ArgonParameter,
): Promise<Uint8Array> {
	return new Uint8Array(
		await argon2id({
			password: passwort,
			salt: eigen(parameter.salt),
			iterations: parameter.zeiten,
			memorySize: parameter.speicherKiB,
			parallelism: parameter.parallelitaet,
			hashLength: DEK_LAENGE,
			outputType: 'binary',
		}),
	);
}

/** Der DEK: zufällig, gerätelokal, verschwindet nicht mit dem Passwort. */
export function erzeugeDek(): Uint8Array {
	return zufallsBytes(DEK_LAENGE);
}

async function gcm(
	schlüssel: Uint8Array,
	nonce: Uint8Array,
	klar: Uint8Array | null,
	zusatz: string,
	dunkel?: Uint8Array,
): Promise<Uint8Array> {
	const krypto = globalThis.crypto.subtle;
	const ref = await krypto.importKey(
		'raw',
		schlüssel as unknown as ArrayBuffer,
		{ name: 'AES-GCM' },
		false,
		[klar === null ? 'decrypt' : 'encrypt'],
	);
	const aad = new TextEncoder().encode(zusatz);
	if (klar === null) {
		return new Uint8Array(
			await krypto.decrypt(
				{ name: 'AES-GCM', iv: eigen(nonce) as unknown as ArrayBuffer, additionalData: eigen(aad) as unknown as ArrayBuffer },
				ref,
				eigen(dunkel!) as unknown as ArrayBuffer,
			),
		);
	}
	return new Uint8Array(
		await krypto.encrypt(
			{ name: 'AES-GCM', iv: eigen(nonce) as unknown as ArrayBuffer, additionalData: eigen(aad) as unknown as ArrayBuffer },
			ref,
			eigen(klar) as unknown as ArrayBuffer,
		),
	);
}

/** Packt den DEK in `key.puls` — frisches Salt, frische Nonce, jedes Mal. */
export async function wickleSchluesselDatei(
	dek: Uint8Array,
	passwort: string,
	parameter: Partial<Pick<ArgonParameter, 'zeiten' | 'speicherKiB' | 'parallelitaet'>> = {},
): Promise<Uint8Array> {
	const voll: ArgonParameter = {
		zeiten: parameter.zeiten ?? ARGON_ZEITEN,
		speicherKiB: parameter.speicherKiB ?? ARGON_SPEICHER_KIB,
		parallelitaet: parameter.parallelitaet ?? ARGON_PARALLELITAET,
		salt: zufallsBytes(SALT_LAENGE),
	};
	if (dek.length !== DEK_LAENGE) {
		throw new SicherungKryptoFehler(`DEK hat ${dek.length} statt ${DEK_LAENGE} Bytes`);
	}
	const kek = await ableiteKek(passwort, voll);
	const nonce = zufallsBytes(NONCE_LAENGE);
	const dunkel = await gcm(kek, nonce, dek, AAD_SCHLUESSEL);

	const gesamt = new Uint8Array(12 + SALT_LAENGE + NONCE_LAENGE + dunkel.length);
	const sicht = new DataView(gesamt.buffer);
	sicht.setUint32(0, SICHERUNG_KENNUNG);
	sicht.setUint8(4, SICHERUNG_FASSUNG);
	sicht.setUint8(5, voll.zeiten);
	sicht.setUint32(6, voll.speicherKiB);
	sicht.setUint8(10, voll.parallelitaet);
	sicht.setUint8(11, SALT_LAENGE);
	gesamt.set(voll.salt, 12);
	gesamt.set(nonce, 12 + SALT_LAENGE);
	gesamt.set(dunkel, 12 + SALT_LAENGE + NONCE_LAENGE);
	return gesamt;
}

/** Öffnet `key.puls` — wirft bei falschem Passwort oder Manipulation. */
export async function öffneSchluesselDatei(
	bytes: Uint8Array,
	passwort: string,
): Promise<{ dek: Uint8Array; parameter: ArgonParameter }> {
	if (bytes.length < 12 + SALT_LAENGE + NONCE_LAENGE) {
		throw new SicherungKryptoFehler('Schlüssel-Datei zu kurz');
	}
	const sicht = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (sicht.getUint32(0) !== SICHERUNG_KENNUNG) {
		throw new SicherungKryptoFehler('falsche Kennung');
	}
	if (sicht.getUint8(4) !== SICHERUNG_FASSUNG) {
		throw new SicherungKryptoFehler(`unbekannte Fassung: ${sicht.getUint8(4)}`);
	}
	const parameter: ArgonParameter = {
		zeiten: sicht.getUint8(5),
		speicherKiB: sicht.getUint32(6),
		parallelitaet: sicht.getUint8(10),
		salt: bytes.slice(12, 12 + sicht.getUint8(11)),
	};
	const nonce = bytes.slice(12 + parameter.salt.length, 12 + parameter.salt.length + NONCE_LAENGE);
	const dunkel = bytes.slice(12 + parameter.salt.length + NONCE_LAENGE);
	const kek = await ableiteKek(passwort, parameter);
	let dek: Uint8Array;
	try {
		dek = await gcm(kek, nonce, null, AAD_SCHLUESSEL, dunkel);
	} catch {
		throw new SicherungKryptoFehler('Entschlüsselung fehlgeschlagen — falsches Passwort oder beschädigte Daten');
	}
	return { dek, parameter };
}

/**
 * Verschlüsselt eine Eintrags-Nutzlast (Rahmen-Typ 3): Nonce vorangestellt,
 * AES-256-GCM mit dem DEK. Frische Nonce je Aufruf — nie zweimal dieselbe.
 */
export async function verschlüsseleEintrag(dek: Uint8Array, klar: Uint8Array): Promise<Uint8Array> {
	const nonce = zufallsBytes(NONCE_LAENGE);
	const dunkel = await gcm(dek, nonce, klar, AAD_EINTRAG);
	const gesamt = new Uint8Array(NONCE_LAENGE + dunkel.length);
	gesamt.set(nonce, 0);
	gesamt.set(dunkel, NONCE_LAENGE);
	return gesamt;
}

/** Öffnet eine Eintrags-Nutzlast — wirft bei Manipulation oder falschem DEK. */
export async function entschlüsseleEintrag(dek: Uint8Array, dunkel: Uint8Array): Promise<Uint8Array> {
	if (dunkel.length < NONCE_LAENGE) {
		throw new SicherungKryptoFehler('Eintrag zu kurz');
	}
	try {
		return await gcm(dek, dunkel.slice(0, NONCE_LAENGE), null, AAD_EINTRAG, dunkel.slice(NONCE_LAENGE));
	} catch {
		throw new SicherungKryptoFehler('Entschlüsselung fehlgeschlagen — falscher Schlüssel oder beschädigte Daten');
	}
}
