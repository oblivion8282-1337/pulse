/**
 * Archiv-Krypto (Übergabe 2026-10-04, §5) — die Rechnung hinter dem
 * verschlüsselten DM-Verlauf:
 *
 *   **Konto-Schlüsselpaar** — X25519 (WebCrypto). Der private Schlüssel
 *   liegt beim auth-Dienst ZWEIFACH gewrappt: unter Argon2id(Passwort)
 *   (Klient rechnet, `ableiteKek` aus `sicherung/krypto.ts` — dieselben
 *   Parameter) und unter dem Server-Schrank-Geheimnis (für den Reset-Weg).
 *   Der Public-Key ist öffentlich: DM-Partner wickeln damit.
 *
 *   **Kanal-Schlüssel** — 32 Zufallsbytes je DM. Der Absender wickelt ihn
 *   an den Archiv-Public-Key JEDES Teilnehmers (ephemeral X25519 + HKDF +
 *   AES-GCM, `wickleKanalSchluessel`) und legt die Wraps beim Server ab.
 *   Lesen kann nur, wer den privaten Schlüssel zum eigenen Wrap hat.
 *
 *   **Zeilen** — AES-256-GCM unter dem Kanal-Schlüssel, frische Nonce je
 *   Zeile, Klartext ist JSON `{t: text, a: absenderId}`.
 *
 * Import-frei bis auf hash-wasm (npm-Paket, Node auflöst) — Node-Testläufer-
 * Regel. X25519/HKDF/AES-GCM kommen aus WebCrypto (Browser-Floor: Chromium
 * ≥133, Firefox ≥139, Safari ≥26 — feature-detect läuft über generateKey
 * und scheitert mit klarer Meldung).
 */

import {
	ableiteKek,
	type ArgonParameter,
	ARGON_ZEITEN,
	ARGON_SPEICHER_KIB,
	ARGON_PARALLELITAET
} from '../sicherung/krypto.ts';

export const SALT_LAENGE = 16;
const NONCE_LAENGE = 12;
const SCHLUESSEL_LAENGE = 32;

/** AAD-Domänentrennung — je Verwendung ein eigener String. */
const AAD_KDF_WRAP = 'pulse-archiv-kdf';
const AAD_KANAL_WRAP = 'pulse-archiv-kanal';
const AAD_ZEILE = 'pulse-archiv-zeile';

export class ArchivKryptoFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'ArchivKryptoFehler';
	}
}

function zufall(laenge: number): Uint8Array {
	const bytes = new Uint8Array(laenge);
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
}

/** WebCrypto braucht echte ArrayBuffer, keine Views. */
function eigen(bytes: Uint8Array): Uint8Array {
	return bytes.slice();
}

async function gcm(
	schluessel: Uint8Array,
	nonce: Uint8Array,
	klar: Uint8Array | null,
	aad: string,
	dunkel?: Uint8Array,
): Promise<Uint8Array> {
	const krypto = globalThis.crypto.subtle;
	const ref = await krypto.importKey('raw', eigen(schluessel) as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, [
		klar === null ? 'decrypt' : 'encrypt'
	]);
	const zusatz = new TextEncoder().encode(aad);
	if (klar === null) {
		return new Uint8Array(
			await krypto.decrypt(
				{
					name: 'AES-GCM',
					iv: eigen(nonce) as unknown as ArrayBuffer,
					additionalData: eigen(zusatz) as unknown as ArrayBuffer
				},
				ref,
				eigen(dunkel!) as unknown as ArrayBuffer
			)
		);
	}
	return new Uint8Array(
		await krypto.encrypt(
			{
				name: 'AES-GCM',
				iv: eigen(nonce) as unknown as ArrayBuffer,
				additionalData: eigen(zusatz) as unknown as ArrayBuffer
			},
			ref,
			eigen(klar) as unknown as ArrayBuffer
		)
	);
}

export type ArchivSchluesselPaar = { pubkey: Uint8Array; privkey: Uint8Array };

/** base64url → Bytes (JWK-Feld „d“). */
/** Bytes → base64url (JWK-Felder). */
function bytesZuB64url(bytes: Uint8Array): string {
	let binär = '';
	for (const b of bytes) binär += String.fromCharCode(b);
	return btoa(binär).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlZuBytes(wert: string): Uint8Array {
	const rest = wert.length % 4;
	const basis64 = wert.replace(/-/g, '+').replace(/_/g, '/') + (rest ? '='.repeat(4 - rest) : '');
	const binär = atob(basis64);
	const bytes = new Uint8Array(binär.length);
	for (let i = 0; i < binär.length; i++) bytes[i] = binär.charCodeAt(i);
	return bytes;
}

/** Neues X25519-Paar (roh — der private Schlüssel wird gewrappt). Der
 *  Private kommt über JWK-Export (Feld „d“): Node kann X25519-Privatschlüssel
 *  nicht roh exportieren, JWK können alle. */
export async function erzeugeArchivPaar(): Promise<ArchivSchluesselPaar> {
	const krypto = globalThis.crypto.subtle;
	try {
		const paar = (await krypto.generateKey({ name: 'X25519' }, true, [
			'deriveKey',
			'deriveBits'
		])) as CryptoKeyPair;
		const pub = new Uint8Array(await krypto.exportKey('raw', paar.publicKey));
		const jwk = await krypto.exportKey('jwk', paar.privateKey);
		if (!jwk.d) throw new ArchivKryptoFehler('X25519-JWK ohne privaten Anteil');
		const priv = b64urlZuBytes(jwk.d);
		if (pub.length !== SCHLUESSEL_LAENGE || priv.length !== SCHLUESSEL_LAENGE) {
			throw new ArchivKryptoFehler('X25519-Export hat falsche Länge');
		}
		return { pubkey: pub, privkey: priv };
	} catch (e) {
		if (e instanceof ArchivKryptoFehler) throw e;
		throw new ArchivKryptoFehler('X25519 wird in diesem Browser nicht unterstützt');
	}
}

/** Rohes Schlüsselpaar → X25519-CryptoKey (zum Ableiten). JWK statt raw:
 *  Node importiert private X25519-Schlüssel nur im JWK-Format. */
async function privKeyRef(privkey: Uint8Array, pubkey: Uint8Array): Promise<CryptoKey> {
	return globalThis.crypto.subtle.importKey(
		'jwk',
		{ kty: 'OKP', crv: 'X25519', d: bytesZuB64url(privkey), x: bytesZuB64url(pubkey) },
		{ name: 'X25519' },
		false,
		['deriveKey', 'deriveBits']
	);
}

async function pubKeyRef(pubkey: Uint8Array): Promise<CryptoKey> {
	return globalThis.crypto.subtle.importKey(
		'raw',
		eigen(pubkey) as unknown as ArrayBuffer,
		{ name: 'X25519' },
		false,
		[]
	);
}

/**
 * Wickelt den Kanal-Schlüssel an einen Empfänger-Public-Key:
 * `ephemeralPub(32) | nonce(12) | AES-GCM(Kanal-Schlüssel)`, Schlüssel aus
 * ECDH(ephemeral, Empfänger) via HKDF-SHA256 über beide Public-Keys.
 */
export async function wickleKanalSchluessel(
	kanalSchluessel: Uint8Array,
	empfaengerPubkey: Uint8Array
): Promise<Uint8Array> {
	const krypto = globalThis.crypto.subtle;
	const ephemeral = await erzeugeArchivPaar();
	const abgeleitet = await krypto.deriveBits(
		{ name: 'X25519', public: await pubKeyRef(empfaengerPubkey) },
		await privKeyRef(ephemeral.privkey, ephemeral.pubkey),
		256
	);
	const hkdf = await krypto.importKey('raw', abgeleitet as unknown as ArrayBuffer, 'HKDF', false, [
		'deriveKey'
	]);
	const salt = new Uint8Array(ephemeral.pubkey.length + empfaengerPubkey.length);
	salt.set(ephemeral.pubkey, 0);
	salt.set(empfaengerPubkey, ephemeral.pubkey.length);
	const wickel = await krypto.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: eigen(salt) as unknown as ArrayBuffer,
			info: new TextEncoder().encode(AAD_KANAL_WRAP) as unknown as ArrayBuffer
		},
		hkdf,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt']
	);
	const nonce = zufall(NONCE_LAENGE);
	const info = new TextEncoder().encode(AAD_KANAL_WRAP);
	const dunkel = new Uint8Array(
		await krypto.encrypt(
			{ name: 'AES-GCM', iv: eigen(nonce) as unknown as ArrayBuffer, additionalData: eigen(info) as unknown as ArrayBuffer },
			wickel,
			eigen(kanalSchluessel) as unknown as ArrayBuffer
		)
	);
	const gesamt = new Uint8Array(ephemeral.pubkey.length + nonce.length + dunkel.length);
	gesamt.set(ephemeral.pubkey, 0);
	gesamt.set(nonce, ephemeral.pubkey.length);
	gesamt.set(dunkel, ephemeral.pubkey.length + nonce.length);
	return gesamt;
}

/** Öffnet einen Kanal-Schlüssel-Wrap mit dem eigenen Schlüsselpaar. */
export async function oeffneKanalSchluessel(
	wrap: Uint8Array,
	privkey: Uint8Array,
	meinPubkey: Uint8Array
): Promise<Uint8Array> {
	if (wrap.length <= SCHLUESSEL_LAENGE + NONCE_LAENGE) {
		throw new ArchivKryptoFehler('Kanal-Wrap zu kurz');
	}
	const krypto = globalThis.crypto.subtle;
	const ephPub = wrap.slice(0, SCHLUESSEL_LAENGE);
	const nonce = wrap.slice(SCHLUESSEL_LAENGE, SCHLUESSEL_LAENGE + NONCE_LAENGE);
	const dunkel = wrap.slice(SCHLUESSEL_LAENGE + NONCE_LAENGE);
	const abgeleitet = await krypto.deriveBits(
		{ name: 'X25519', public: await pubKeyRef(ephPub) },
		await privKeyRef(privkey, meinPubkey),
		256
	);
	const hkdf = await krypto.importKey('raw', abgeleitet as unknown as ArrayBuffer, 'HKDF', false, [
		'deriveKey'
	]);
	const salt = new Uint8Array(ephPub.length + meinPubkey.length);
	salt.set(ephPub, 0);
	salt.set(meinPubkey, ephPub.length);
	const wickel = await krypto.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: eigen(salt) as unknown as ArrayBuffer,
			info: new TextEncoder().encode(AAD_KANAL_WRAP) as unknown as ArrayBuffer
		},
		hkdf,
		{ name: 'AES-GCM', length: 256 },
		false,
		['decrypt']
	);
	try {
		return new Uint8Array(
			await krypto.decrypt(
				{
					name: 'AES-GCM',
					iv: eigen(nonce) as unknown as ArrayBuffer,
					additionalData: eigen(new TextEncoder().encode(AAD_KANAL_WRAP)) as unknown as ArrayBuffer
				},
				wickel,
				eigen(dunkel) as unknown as ArrayBuffer
			)
		);
	} catch {
		throw new ArchivKryptoFehler('Kanal-Schlüssel passt nicht zu diesem Konto');
	}
}

/** Wrappt den privaten Schlüssel unter Argon2id(Passwort, salt). */
export async function wicklePrivkeyMitPasswort(
	privkey: Uint8Array,
	passwort: string,
	salt: Uint8Array,
	parameter?: Partial<Pick<ArgonParameter, 'zeiten' | 'speicherKiB' | 'parallelitaet'>>
): Promise<Uint8Array> {
	const voll: ArgonParameter = {
		zeiten: parameter?.zeiten ?? ARGON_ZEITEN,
		speicherKiB: parameter?.speicherKiB ?? ARGON_SPEICHER_KIB,
		parallelitaet: parameter?.parallelitaet ?? ARGON_PARALLELITAET,
		salt
	};
	const kek = await ableiteKek(passwort, voll);
	const nonce = zufall(NONCE_LAENGE);
	const dunkel = await gcm(kek, nonce, privkey, AAD_KDF_WRAP);
	const gesamt = new Uint8Array(nonce.length + dunkel.length);
	gesamt.set(nonce, 0);
	gesamt.set(dunkel, nonce.length);
	return gesamt;
}

/** Öffnet den Passwort-Wrap des privaten Schlüssels — wirft bei falschem Passwort. */
export async function oeffnePrivkeyMitPasswort(
	wrap: Uint8Array,
	passwort: string,
	salt: Uint8Array,
	parameter?: Partial<Pick<ArgonParameter, 'zeiten' | 'speicherKiB' | 'parallelitaet'>>
): Promise<Uint8Array> {
	const voll: ArgonParameter = {
		zeiten: parameter?.zeiten ?? ARGON_ZEITEN,
		speicherKiB: parameter?.speicherKiB ?? ARGON_SPEICHER_KIB,
		parallelitaet: parameter?.parallelitaet ?? ARGON_PARALLELITAET,
		salt
	};
	const kek = await ableiteKek(passwort, voll);
	if (wrap.length <= NONCE_LAENGE) throw new ArchivKryptoFehler('Passwort-Wrap zu kurz');
	try {
		return await gcm(kek, wrap.slice(0, NONCE_LAENGE), null, AAD_KDF_WRAP, wrap.slice(NONCE_LAENGE));
	} catch {
		throw new ArchivKryptoFehler('Archiv-Schlüssel öffnet mit diesem Passwort nicht');
	}
}

/** Verschlüsselt eine Archiv-Zeile (Nonce vorn, GCM unter dem Kanal-Schlüssel). */
export async function verschluessleZeile(
	kanalSchluessel: Uint8Array,
	klar: Uint8Array
): Promise<Uint8Array> {
	const nonce = zufall(NONCE_LAENGE);
	const dunkel = await gcm(kanalSchluessel, nonce, klar, AAD_ZEILE);
	const gesamt = new Uint8Array(nonce.length + dunkel.length);
	gesamt.set(nonce, 0);
	gesamt.set(dunkel, nonce.length);
	return gesamt;
}

/** Öffnet eine Archiv-Zeile — wirft bei Manipulation. */
export async function entschluesseleZeile(
	kanalSchluessel: Uint8Array,
	dunkel: Uint8Array
): Promise<Uint8Array> {
	if (dunkel.length <= NONCE_LAENGE) throw new ArchivKryptoFehler('Zeile zu kurz');
	try {
		return await gcm(kanalSchluessel, dunkel.slice(0, NONCE_LAENGE), null, AAD_ZEILE, dunkel.slice(NONCE_LAENGE));
	} catch {
		throw new ArchivKryptoFehler('Archiv-Zeile unlesbar — falscher Kanal-Schlüssel?');
	}
}

/** Re-Wrap nach Passwortwechsel: neues Salt, derselbe privater Schlüssel. */
export async function neuwickelPrivkey(
	privkey: Uint8Array,
	neuesPasswort: string
): Promise<{ salt: Uint8Array; wrap: Uint8Array }> {
	const salt = zufall(SALT_LAENGE);
	return { salt, wrap: await wicklePrivkeyMitPasswort(privkey, neuesPasswort, salt) };
}
