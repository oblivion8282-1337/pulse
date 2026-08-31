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
import { type Zugang } from '../ablage/oauth.ts';
import { gdriveAdapter, auffrischeZugang, type GdriveAnbindung } from '../ablage/gdrive.ts';
import type { AblageAdapter } from '../ablage/adapter.ts';
import type { WarteEintrag } from './spiegel.ts';
import type { AblageNachricht } from '../ablage/nutzlast.ts';

const DB_NAME = 'pulse-sicherung';
const DB_VERSION = 1;
const STORE_VERBINDUNG = 'verbindung';
const STORE_PUFFER = 'puffer';
const VERBINDUNG_KEY = 'gdrive';

/** Keys im Identity-Store (pulse-identity) — gewischt mit der Abmeldung. */
export const IDB_KEY_SICHERUNG_DEK = 'pulse.sicherung-dek';
export const IDB_KEY_SICHERUNG_KUERZEL = 'pulse.sicherung-kuerzel';

export interface SicherungVerbindung {
	kundenId: string;
	/** Google verlangt es auch bei Desktop-Clients (empirisch, s. gdrive.ts). */
	kundenGeheimnis?: string;
	weiterleitung: string;
	/** Drive-Ordner als Pfad, z. B. `Pulse-Sicherung`. */
	ordner: string;
	nachspieleToken: string;
}

export interface PufferZeile extends WarteEintrag {
	schluessel: string;
}

// ---------------------------------------------------------------------------
// Verbindung
// ---------------------------------------------------------------------------

function öffneDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const anfrage = indexedDB.open(DB_NAME, DB_VERSION);
		anfrage.onupgradeneeded = () => {
			const db = anfrage.result;
			if (!db.objectStoreNames.contains(STORE_VERBINDUNG)) db.createObjectStore(STORE_VERBINDUNG);
			if (!db.objectStoreNames.contains(STORE_PUFFER)) {
				db.createObjectStore(STORE_PUFFER, { keyPath: 'schluessel' });
			}
		};
		anfrage.onsuccess = () => resolve(anfrage.result);
		anfrage.onerror = () => reject(anfrage.error);
	});
}

export async function verbindungLesen(): Promise<SicherungVerbindung | null> {
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_VERBINDUNG, 'readonly');
		const anfrage = tx.objectStore(STORE_VERBINDUNG).get(VERBINDUNG_KEY);
		anfrage.onsuccess = () => resolve((anfrage.result as SicherungVerbindung | undefined) ?? null);
		anfrage.onerror = () => reject(anfrage.error);
	});
}

export async function verbindungSchreiben(v: SicherungVerbindung): Promise<void> {
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_VERBINDUNG, 'readwrite');
		tx.objectStore(STORE_VERBINDUNG).put(v, VERBINDUNG_KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function verbindungEntfernen(): Promise<void> {
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_VERBINDUNG, 'readwrite');
		tx.objectStore(STORE_VERBINDUNG).delete(VERBINDUNG_KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Der Google-Client aus der Verbindung — für Konsent-Link und Token-Tausch. */
export function anbindungAusVerbindung(v: SicherungVerbindung): GdriveAnbindung {
	return {
		kundenId: v.kundenId,
		...(v.kundenGeheimnis !== undefined && v.kundenGeheimnis !== ''
			? { kundenGeheimnis: v.kundenGeheimnis }
			: {}),
		weiterleitung: v.weiterleitung,
	};
}

/**
 * Frischer Adapter je Aufruf: der gdrive-Adapter friert den Token beim Bau
 * ein (kopf-Konstante), also wird vor JEDEM Bau ein neuer Zugangs-Token
 * geholt. Ein Aufruf pro Spülung — Google-Quoten dürften das lächeln.
 */
export async function adapterLieferant(): Promise<AblageAdapter> {
	const v = await verbindungLesen();
	if (v === null) throw new Error('Sicherung: keine Verbindung eingerichtet');
	const zugang: Zugang = await auffrischeZugang(anbindungAusVerbindung(v), v.nachspieleToken);
	v.nachspieleToken = zugang.nachspieleToken ?? v.nachspieleToken;
	await verbindungSchreiben(v);
	return gdriveAdapter({ zugangsToken: zugang.zugangsToken, ordner: v.ordner });
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
	const zeilen: PufferZeile[] = nachrichten.map((nachricht) => ({
		schluessel: `${kanalId}:${nachricht.id}`,
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
			store.delete(`${kanalId}:${nachricht.id}`);
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
