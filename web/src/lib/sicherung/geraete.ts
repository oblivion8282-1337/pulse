/**
 * Die gerätelokale Schicht der Sicherung — alles, was NUR auf diesem Gerät
 * liegt und deshalb im Node-Testläufer unprüfbar ist (IndexedDB):
 *
 *   **Verbindung** (DB `pulse-sicherung`, Store `verbindung`) — der
 *   Google-OAuth-Client und der Ablage-Ordner im Drive. Der Refresh-Token
 *   verlässt das Gerät, genau wie beim Verbindungs-Store der Ablage.
 *
 *   **DEK-Zwischenlager** (Identity-IndexedDB, `pulse-identity`) — der
 *   entpackte Datenschlüssel und das Geräte-Kürzel. Ohne dieses Zwischenlager
 *   müsste JEDES Fenster das Sicherungs-Passwort wieder eingeben; gewischt
 *   wird es mit der Abmeldung (auth.svelte.ts), sodass ein fremder Browser
 *   (oder der nächste Nutzer) wieder bei null anfängt.
 *
 *   **Puffer** (DB `pulse-sicherung`, Store `puffer`) — die noch nicht
 *   gespülten Einträge. Ein Absturz zwischen "lokal abgelegt" und
 *   "ins Laufwerk gespiegelt" verliert sonst stille Nachrichten.
 *
 * Ein OAUTH-Rücklauf-Server läuft hier bewusst NICHT: Google-Clients vom
 * Typ Desktop-App wollen einen Loopback-Redirect, den eine Web-Seite nicht
 * anbieten kann. Die Oberfläche öffnet den Konsent-Link und lässt den
 * Nutzer die Rückgabe-URL (bzw. den Code) einfügen — Hilfsbrücke der ersten
 * Etappe; ein Loopback-Zuhörer im Electron-Main ist die spätere Verfeinerung.
 */

import {
	openIdentityDb,
	idbGetIdentity,
	idbPutIdentity,
	idbDeleteIdentity,
} from '../identity/idb-shared.ts';
import type { WarteEintrag } from './spiegel.ts';
import { pufferSchluessel } from './spiegel.ts';
import type { AblageNachricht } from '../ablage/nutzlast.ts';
import type { SicherungLeseStand } from './wiederherstellen.ts';
import { öffneDb, STORE_PUFFER, STORE_LESESTAND } from './ziele.ts';


const DB_NAME = 'pulse-sicherung';
const STORE_VERBINDUNG = 'verbindung';
const VERBINDUNG_KEY = 'gdrive';

/** Keys im Identity-Store (pulse-identity) — gewischt mit der Abmeldung. */
export const IDB_KEY_SICHERUNG_DEK = 'pulse.sicherung-dek';
export const IDB_KEY_SICHERUNG_KUERZEL = 'pulse.sicherung-kuerzel';

/** Dateiname eines Anhang-Bytes-Behälters im Archiv (Klartext-Name, nur Ids). */
export function anhangDateiName(id: string): string {
	return `anhang-${id}.puls`;
}

export interface PufferZeile extends WarteEintrag {
	schluessel: string;
}

// ---------------------------------------------------------------------------
// DEK-Zwischenlager (Identity-IndexedDB)
// ---------------------------------------------------------------------------

async function identityDb(): Promise<IDBDatabase> {
	return openIdentityDb();
}

export async function dekZwischenlagern(dek: Uint8Array, kuerzel: string): Promise<void> {
	const db = await identityDb();
	await idbPutIdentity(db, IDB_KEY_SICHERUNG_DEK, bytesZuB64(dek));
	await idbPutIdentity(db, IDB_KEY_SICHERUNG_KUERZEL, kuerzel);
}

export async function dekAusZwischenlager(): Promise<{ dek: Uint8Array; kuerzel: string } | null> {
	const db = await identityDb();
	const dekB64 = (await idbGetIdentity(db, IDB_KEY_SICHERUNG_DEK)) as string | undefined;
	const kuerzel = (await idbGetIdentity(db, IDB_KEY_SICHERUNG_KUERZEL)) as string | undefined;
	if (typeof dekB64 !== 'string' || typeof kuerzel !== 'string') return null;
	return { dek: b64ZuBytes(dekB64), kuerzel };
}

export async function dekZwischenlagerWischen(): Promise<void> {
	const db = await identityDb();
	await idbDeleteIdentity(db, IDB_KEY_SICHERUNG_DEK);
	await idbDeleteIdentity(db, IDB_KEY_SICHERUNG_KUERZEL);
}

// ---------------------------------------------------------------------------
// Puffer
// ---------------------------------------------------------------------------

export async function pufferLegen(
	kanalId: string,
	nachrichten: AblageNachricht[],
): Promise<PufferZeile[]> {
	// B4: derselbe Schlüssel wie die Spiegel-Dedup (`spiegel.ts::
	// pufferSchluessel`) — der Grabstein trägt denselben Marker, sonst
	// überschreiben sich Stein und Inhalt derselben Id im Puffer gegenseitig
	// und ein Absturz dazwischen lässt die Löschung das Archiv nie erreichen.
	const zeilen: PufferZeile[] = nachrichten.map((nachricht) => ({
		schluessel: pufferSchluessel(kanalId, nachricht),
		kanalId,
		nachricht,
	}));
	if (zeilen.length === 0) return zeilen;
	const db = await öffneDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_PUFFER, 'readwrite');
		const store = tx.objectStore(STORE_PUFFER);
		for (const zeile of zeilen) store.put(zeile);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	return zeilen;
}

export async function pufferAlles(): Promise<PufferZeile[]> {
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_PUFFER, 'readonly');
		const anfrage = tx.objectStore(STORE_PUFFER).getAll();
		anfrage.onsuccess = () => resolve(anfrage.result as PufferZeile[]);
		anfrage.onerror = () => reject(anfrage.error);
	});
}

export async function pufferWeg(zeilen: WarteEintrag[]): Promise<void> {
	if (zeilen.length === 0) return;
	const db = await öffneDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_PUFFER, 'readwrite');
		const store = tx.objectStore(STORE_PUFFER);
		for (const { kanalId, nachricht } of zeilen) {
			// B4: derselbe Schlüssel wie `pufferLegen` — nur so trifft das
			// Löschen die Grabstein-Zeile UNTER ihrem Marker.
			store.delete(pufferSchluessel(kanalId, nachricht));
		}
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Der Abmeldeweg räumt hier zusammen mit den Krypto-Geheimnissen auf. */
export async function pufferWischen(): Promise<void> {
	const db = await öffneDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_PUFFER, 'readwrite');
		tx.objectStore(STORE_PUFFER).clear();
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

// ---------------------------------------------------------------------------
// Lesestand: bis wohin hat DIESES Gerät den Archiv-Ordner JESES Kanals schon
// importiert — je Geräte-Kette ein Gelesen-Fenster (Form: wiederherstellen.
// ts::SicherungLeseStand). Schlüssel ist Konto UND Kanal
// (`<kontoId>:<kanalId>`), denn gelesen wird je Kanal-Ordner seitenweise.
// Ohne ihn lud jedes Öffnen desselben Kanals dessen Archiv erneut herunter.
// Der alte Schlüssel ohne Kanal entfällt bewusst — Testbestände sind
// Wegwerf, keine Migration.
// ---------------------------------------------------------------------------

function lesestandSchluessel(kontoId: string, kanalId: string): string {
	return `${kontoId}:${kanalId}`;
}

export async function lesestandLesen(
	kontoId: string,
	kanalId: string,
): Promise<Record<string, SicherungLeseStand>> {
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_LESESTAND, 'readonly');
		const anfrage = tx.objectStore(STORE_LESESTAND).get(lesestandSchluessel(kontoId, kanalId));
		anfrage.onsuccess = () =>
			resolve((anfrage.result as Record<string, SicherungLeseStand> | undefined) ?? {});
		anfrage.onerror = () => reject(anfrage.error);
	});
}

export async function lesestandSchreiben(
	kontoId: string,
	kanalId: string,
	stand: Record<string, SicherungLeseStand>,
): Promise<void> {
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_LESESTAND, 'readwrite');
		tx.objectStore(STORE_LESESTAND).put(stand, lesestandSchluessel(kontoId, kanalId));
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Löscht den Lesestand EINES Kanals — der Gesprächs-Löschlauf
 *  (`andock.ts::sicherungGespraechEntfernen`) wischt ihn mit dem Ordner weg,
 *  sonst läge ein Fenster für einen Ordner vor, den es nicht mehr gibt. */
export async function lesestandEntfernen(kontoId: string, kanalId: string): Promise<void> {
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_LESESTAND, 'readwrite');
		tx.objectStore(STORE_LESESTAND).delete(lesestandSchluessel(kontoId, kanalId));
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

// ---------------------------------------------------------------------------

function bytesZuB64(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function b64ZuBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

// Der Ziel-Adapter gehört zu ziele.ts — Re-Export für bestehende Aufrufer.
export { adapterLieferant } from './ziele.ts';
