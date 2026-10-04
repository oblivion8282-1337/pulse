/**
 * Der Archiv-Konto-Schlüssel (Übergabe 2026-10-04, §5): Erstanlage beim
 * ersten Login, Entsperrung über das Passwort, Cache in der Identity-
 * IndexedDB — dieselbe Vertrauensstufe wie der lokale Verlauf (C1), der
 * ohnehin jeden Klartext auf diesem Gerät hält.
 *
 * Grenze (bewusst): Nach Seiten-Reload ohne Cache (z. B. DB gelöscht) bleibt
 * das Archiv zu, bis der Nutzer sich neu anmeldet — das Passwort liegt nie
 * im Speicher, außer im Anmelde-Moment. Kein Eingabedialog dafür (Feinschliff).
 */

import {
	archivKontoLesen,
	archivKontoAnlegen,
	archivKontoNeuwickeln
} from '$lib/api/archiv';
import {
	erzeugeArchivPaar,
	wicklePrivkeyMitPasswort,
	oeffnePrivkeyMitPasswort,
	neuwickelPrivkey
} from './krypto';
import { openIdentityDb, idbGetIdentity, idbPutIdentity, idbDeleteIdentity } from '$lib/identity/idb-shared';

const IDB_SCHLUESSEL_VORWARTS = 'archiv-privkey-';
const IDB_SCHLUESSEL_PUB = 'archiv-pubkey-';

/** Entsperrte Schlüssel dieser Sitzung (accountId → Paar). */
const bereithaltend = new Map<string, { pubkey: Uint8Array; privkey: Uint8Array }>();

function zuB64(bytes: Uint8Array): string {
	let binär = '';
	for (const b of bytes) binär += String.fromCharCode(b);
	return btoa(binär);
}

function vonB64(wert: string): Uint8Array {
	const binär = atob(wert);
	const bytes = new Uint8Array(binär.length);
	for (let i = 0; i < binär.length; i++) bytes[i] = binär.charCodeAt(i);
	return bytes;
}

async function cacheSetzen(kontoId: string, paar: { pubkey: Uint8Array; privkey: Uint8Array }): Promise<void> {
	bereithaltend.set(kontoId, paar);
	const db = await openIdentityDb();
	await idbPutIdentity(db, IDB_SCHLUESSEL_VORWARTS + kontoId, zuB64(paar.privkey));
	await idbPutIdentity(db, IDB_SCHLUESSEL_PUB + kontoId, zuB64(paar.pubkey));
}

async function cacheLesen(kontoId: string): Promise<{ pubkey: Uint8Array; privkey: Uint8Array } | null> {
	const ausSitzung = bereithaltend.get(kontoId);
	if (ausSitzung) return ausSitzung;
	const db = await openIdentityDb();
	const priv = await idbGetIdentity(db, IDB_SCHLUESSEL_VORWARTS + kontoId);
	const pub = await idbGetIdentity(db, IDB_SCHLUESSEL_PUB + kontoId);
	if (typeof priv !== 'string' || typeof pub !== 'string') return null;
	const paar = { pubkey: vonB64(pub), privkey: vonB64(priv) };
	bereithaltend.set(kontoId, paar);
	return paar;
}

/** Beim Abmelden: entsperrten Schlüssel vom Gerät werfen. */
export async function archivCacheVerwerfen(kontoId: string): Promise<void> {
	bereithaltend.delete(kontoId);
	try {
		const db = await openIdentityDb();
		await idbDeleteIdentity(db, IDB_SCHLUESSEL_VORWARTS + kontoId);
		await idbDeleteIdentity(db, IDB_SCHLUESSEL_PUB + kontoId);
	} catch {
		/* IndexedDB weg (private mode) — der Sitzungs-Cache ist eh leer. */
	}
}

/**
 * Im Anmelde-Moment (Passwort liegt vor): Erstanlage oder Entsperrung.
 * Wirft NIE — ein Archiv-Problem darf die Anmeldung nicht kippen; der
 * Rückgabewert sagt nur, ob das Archiv bereit ist.
 */
export async function archivBeimLogin(
	kontoId: string,
	passwort: string
): Promise<boolean> {
	try {
		const zeile = await archivKontoLesen();
		if (zeile === null) {
			// Erstanlage: Paar erzeugen, unter dem Passwort wickeln, hochladen.
			// Der Server rechnet den Schrank-Wrap (503, wenn das Geheimnis
			// fehlt — Dev-Fall, dann gibt es dieses Konto-Archiv schlicht nicht).
			const paar = await erzeugeArchivPaar();
			const salt = new Uint8Array(16);
			globalThis.crypto.getRandomValues(salt);
			const wrap = await wicklePrivkeyMitPasswort(paar.privkey, passwort, salt);
			await archivKontoAnlegen({
				pubkey_b64: zuB64(paar.pubkey),
				kdf_salt_b64: zuB64(salt),
				wrap_kdf_b64: zuB64(wrap),
				privkey_b64: zuB64(paar.privkey)
			});
			await cacheSetzen(kontoId, paar);
			return true;
		}
		const paar = {
			pubkey: vonB64(zeile.pubkey_b64),
			privkey: await oeffnePrivkeyMitPasswort(vonB64(zeile.wrap_kdf_b64), passwort, vonB64(zeile.kdf_salt_b64))
		};
		await cacheSetzen(kontoId, paar);
		return true;
	} catch {
		return false;
	}
}

/** Der entsperrete Konto-Schlüssel — `null` heißt „Archiv auf diesem Gerät zu“. */
export async function archivPaar(kontoId: string): Promise<{ pubkey: Uint8Array; privkey: Uint8Array } | null> {
	return cacheLesen(kontoId);
}

/** Passwortwechsel: lokal neu wickeln, hochladen. Ist der Schlüssel nicht
 *  bereit (Cache leer), öffnet der Altpasswort-Weg die Server-Zeile — das
 *  Formular hat beide Passwörter ohnehin in der Hand. */
export async function archivBeimPasswortwechsel(
	kontoId: string,
	altesPasswort: string,
	neuesPasswort: string
): Promise<void> {
	let paar = await cacheLesen(kontoId);
	if (!paar) {
		const zeile = await archivKontoLesen();
		if (!zeile) return; // kein Archiv eingerichtet
		paar = {
			pubkey: vonB64(zeile.pubkey_b64),
			privkey: await oeffnePrivkeyMitPasswort(
				vonB64(zeile.wrap_kdf_b64),
				altesPasswort,
				vonB64(zeile.kdf_salt_b64)
			)
		};
	}
	const { salt, wrap } = await neuwickelPrivkey(paar.privkey, neuesPasswort);
	await archivKontoNeuwickeln({ kdf_salt_b64: zuB64(salt), wrap_kdf_b64: zuB64(wrap) });
	await cacheSetzen(kontoId, paar);
}
