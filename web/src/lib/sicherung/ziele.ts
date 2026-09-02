/**
 * Die Ziele der Sicherung — WOHIN der verschlüsselte Container gespiegelt
 * wird. Seit dem Mehr-Ziel-Umbau sind die Ziele UNABHÄNGIG KOMBINIERBAR:
 * ein lokaler Ordner (File-System-Access-Handle, z. B. im Dropbox-/OneDrive-
 * Sync des Nutzers) und/oder Google Drive. Der Container wird in ALLE
 * aktivierten Ziele geschrieben (gleicher DEK, gleicher Inhalt); beim
 * Lesen genügt das erste Ziel, das die Datei liefert — beide Kopien sind
 * inhaltlich Zwillinge, nur die Rahmen-Ids unterscheiden sich je Kopie
 * (der Wiederherstellungs-Leser dedupliziert über die Nachrichten-Ids).
 *
 * Gespeichert wird gerätelokal in `pulse-sicherung` (Store `verbindung`,
 * Schlüssel `'ziele'`). Der Schlüssel `'gdrive'` ist der Bestand aus der
 * Ein-Ziel-Zeit und wird beim ersten Lesen migriert.
 */

import type { AblageAdapter } from '../ablage/adapter.ts';
import { adapterAusVerzeichnis, type AblageVerzeichnis } from '../ablage/syncOrdner.ts';
import { gdriveAdapter, auffrischeZugang, type GdriveAnbindung } from '../ablage/gdrive.ts';
import { ordnerAdapter, ordnerZugriffOk } from './ordner.ts';
import { archivUeberPulse } from '../ablage/archivAdapter.ts';
import { flachAdapter } from './flachPfad.ts';
import { TokenVorrat } from './tokenVorrat.ts';
import { m } from '$lib/paraglide/messages.js';

const DB_NAME = 'pulse-sicherung';
const DB_VERSION = 4; // 4: puffer mit keyPath 'schluessel' neu angelegt (put ohne expliziten Schluessel warf sonst)
const STORE_VERBINDUNG = 'verbindung';
const ZIELE_KEY = 'ziele';
/** Bestand aus der Ein-Ziel-Zeit — wird beim ersten Lesen migriert. */
const VERBINDUNG_KEY_LEGACY = 'gdrive';

export interface SicherungZiele {
	ordner?: { verzeichnis: AblageVerzeichnis };
	/**
	 * Nextcloud über Freigabe-Link — **beschrieben über den Pulse-Server**,
	 * nicht direkt (seit 2026-09-02). Ein Browser darf in eine Nextcloud
	 * nicht schreiben, sie setzt keine CORS-Kopfzeilen; bis dahin lief hier
	 * der direkte WebDAV-Adapter, und der Ordner blieb leer, ohne dass etwas
	 * rot wurde. Die Adresse liegt deshalb beim Server (`/ablage/archiv/
	 * laufwerk`), hier steht nur, DASS ein Ziel besteht: `basis` zur Anzeige,
	 * `verbindungId` für die Ablage-Verbindung, die dieselbe Adresse als
	 * Archiv-Markierung trägt (`SicherungSektion.svelte`).
	 */
	nextcloud?: { basis: string; verbindungId: string };
	gdrive?: {
		kundenId: string;
		kundenGeheimnis?: string;
		weiterleitung: string;
		/** Drive-Ordner als Pfad, z. B. `Pulse-Backup`. */
		ordner: string;
		nachspieleToken: string;
		/** Zugangs-Token aus dem Code-Tausch — kurzlebig, nur für die Einrichtung. */
		zugangsToken?: string;
	};
}

/** Ein Ziel ist da, sobald einer der beiden Zwecke belegt ist. */
export function zieleBesetzt(z: SicherungZiele): boolean {
	return z.ordner !== undefined || z.gdrive !== undefined || z.nextcloud !== undefined;
}

export const STORE_PUFFER = 'puffer';
export const STORE_LESESTAND = 'leserstand';

export function öffneDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const anfrage = indexedDB.open(DB_NAME, DB_VERSION);
		anfrage.onupgradeneeded = () => {
			const db = anfrage.result;
			// ALLE Stores dieses Modul-Teams hier anlegen — das ist die EINZIGE
			// Erzeugungsstelle der DB. Ohne puffer/leserstand crasht jedes
			// frische Profil (geraete.ts transaktioniert sie): auf Altgeräten
			// unsichtbar, weil deren DB aus Entwicklungsständen mit Version<2
			// alle Stores schon trug. `geraete.ts` baut seine Version-2-Kon-
			// stante bewusst nicht selbst auf — es öffnet über diese Stelle.
			if (!db.objectStoreNames.contains(STORE_VERBINDUNG)) db.createObjectStore(STORE_VERBINDUNG);
			// Der Puffer MUSS keyPath 'schluessel' tragen: pufferLegen put()'et
			// die Zeile ohne expliziten Schlüssel (PufferZeile.schluessel ist
			// `<kanalId>:<nachrichtId>`, pufferWeg löscht unter genau dem). Ein
			// keyPath-loser Store wirft dort "no key parameter" — still, weil
			// der Spiegel-Fehlerpfad schluckt (Frischprofil-Bug 2026-09-01).
			// Bestehende keyPath-lose Exemplare wandern per Upgrade neu angelegt;
			// der Puffer ist eine Wegwerf-Warteschlange — verlorene Zeilen holt
			// die Erstsicherung aus dem lokalen Verlauf nach.
			if (db.objectStoreNames.contains(STORE_PUFFER)) db.deleteObjectStore(STORE_PUFFER);
			db.createObjectStore(STORE_PUFFER, { keyPath: 'schluessel' });
			if (!db.objectStoreNames.contains(STORE_LESESTAND)) db.createObjectStore(STORE_LESESTAND);
		};
		anfrage.onsuccess = () => resolve(anfrage.result);
		anfrage.onerror = () => reject(anfrage.error);
	});
}

async function hole(key: string): Promise<unknown> {
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_VERBINDUNG, 'readonly');
		const anfrage = tx.objectStore(STORE_VERBINDUNG).get(key);
		anfrage.onsuccess = () => resolve(anfrage.result);
		anfrage.onerror = () => reject(anfrage.error);
	});
}

/**
 * Ein Ziel-Eintrag gilt nur als vorhanden, wenn seine Pflichtfelder stimmen.
 * Der Bestand vor dem Mehr-Ziel-Umbau hatte kein `ziel`-Feld und sein
 * Google-Eintrag kam OHNE `verzeichnis` durch — beides darf nicht als
 * Ordner-Ziel missdeutet werden (Feldbefund 2026-08-31: „queryPermission von
 * undefined").
 */
function sanitisiereZiele(roh: unknown): SicherungZiele {
	const z: SicherungZiele = {};
	if (typeof roh !== 'object' || roh === null) return z;
	const rohObjekt = roh as Record<string, unknown>;

	const g = rohObjekt.gdrive as Record<string, unknown> | undefined;
	if (
		g !== null &&
		typeof g === 'object' &&
		typeof g.kundenId === 'string' && g.kundenId !== '' &&
		typeof g.nachspieleToken === 'string'
	) {
		z.gdrive = {
			kundenId: g.kundenId,
			...(typeof g.kundenGeheimnis === 'string' && g.kundenGeheimnis !== ''
				? { kundenGeheimnis: g.kundenGeheimnis }
				: {}),
			weiterleitung: typeof g.weiterleitung === 'string' ? g.weiterleitung : '',
			ordner: typeof g.ordner === 'string' ? g.ordner : 'Pulse-Backup',
			nachspieleToken: g.nachspieleToken,
			...(typeof g.zugangsToken === 'string' ? { zugangsToken: g.zugangsToken } : {}),
		};
	}

	const nc = rohObjekt.nextcloud as Record<string, unknown> | undefined;
	// Ein Bestand aus der Direkt-Zeit (mit `passwort`) trägt keine
	// `verbindungId` und fällt damit weg — er hat nie geschrieben, es gibt
	// nichts zu erhalten; der Nutzer verbindet Nextcloud einmal neu.
	if (
		nc !== null &&
		typeof nc === 'object' &&
		typeof nc.basis === 'string' && nc.basis !== '' &&
		typeof nc.verbindungId === 'string' && nc.verbindungId !== ''
	) {
		z.nextcloud = { basis: nc.basis, verbindungId: nc.verbindungId };
	}

	const o = rohObjekt.ordner as Record<string, unknown> | undefined;
	if (
		o !== null &&
		typeof o === 'object' &&
		o.verzeichnis !== undefined &&
		o.verzeichnis !== null
	) {
		z.ordner = { verzeichnis: o.verzeichnis as AblageVerzeichnis };
	}
	return z;
}

/** Die aktuellen Ziele — migriert beim ersten Lesen den Ein-Ziel-Bestand. */
export async function zieleLesen(): Promise<SicherungZiele> {
	const db = await öffneDb();
	const neu = await new Promise<SicherungZiele | undefined>((resolve, reject) => {
		const tx = db.transaction(STORE_VERBINDUNG, 'readonly');
		const anfrage = tx.objectStore(STORE_VERBINDUNG).get(ZIELE_KEY);
		anfrage.onsuccess = () => resolve(anfrage.result as SicherungZiele | undefined);
		anfrage.onerror = () => reject(anfrage.error);
	});
	if (neu !== undefined) {
		// Nachsanierung: ein halb migrierter Bestand (z. B. Ordner ohne
		// Verzeichnis) wird still weggekürzt, statt jeden Lauf craschen zu
		// lassen — der Nutzer richtet das fehlende Ziel neu ein.
		const sauber = sanitisiereZiele(neu);
		if (Object.keys(sauber).length !== Object.keys(neu).length) {
			await zieleSchreiben(sauber);
		}
		return sauber;
	}

	// Migration: der alte Schlüssel hielt EINE Verbindung — je nach Zeitalter
	// mit oder ohne `ziel`-Feld. Erkannt wird an den FELDERN, nicht am Etikett.
	const alt = (await hole(VERBINDUNG_KEY_LEGACY)) as Record<string, unknown> | undefined;
	if (alt === undefined || typeof alt !== 'object') return {};

	const migriert: SicherungZiele = {};
	if (typeof alt.kundenId === 'string' && alt.kundenId !== '' && typeof alt.nachspieleToken === 'string') {
		migriert.gdrive = {
			kundenId: alt.kundenId,
			...(typeof alt.kundenGeheimnis === 'string' && alt.kundenGeheimnis !== ''
				? { kundenGeheimnis: alt.kundenGeheimnis }
				: {}),
			weiterleitung: typeof alt.weiterleitung === 'string' ? alt.weiterleitung : '',
			ordner: typeof alt.ordner === 'string' ? alt.ordner : 'Pulse-Backup',
			nachspieleToken: alt.nachspieleToken,
			...(typeof alt.zugangsToken === 'string' ? { zugangsToken: alt.zugangsToken } : {}),
		};
	} else if (alt.verzeichnis !== undefined && alt.verzeichnis !== null) {
		migriert.ordner = { verzeichnis: alt.verzeichnis as AblageVerzeichnis };
	}
	await zieleSchreiben(migriert);
	return migriert;
}

export async function zieleSchreiben(z: SicherungZiele): Promise<void> {
	// FELD-FÜR-FELD-Kopie an der IDB-Grenze: der $state-Proxy der Sektion
	// wrappt auch verschachtelte Objekte (ordner/gdrive), und ein solcher
	// Proxy ist nicht strukturell klonbar ("could not be cloned"). Der
	// oberflächliche Spread allein hätte den inneren Proxy durchgereicht.
	const kopie: SicherungZiele = {};
	if (z.ordner?.verzeichnis) {
		kopie.ordner = { verzeichnis: z.ordner.verzeichnis };
	}
	if (z.nextcloud?.basis && z.nextcloud.verbindungId) {
		kopie.nextcloud = { basis: z.nextcloud.basis, verbindungId: z.nextcloud.verbindungId };
	}
	if (z.gdrive?.kundenId && z.gdrive.nachspieleToken !== undefined) {
		kopie.gdrive = {
			kundenId: z.gdrive.kundenId,
			...(z.gdrive.kundenGeheimnis !== undefined
				? { kundenGeheimnis: z.gdrive.kundenGeheimnis }
				: {}),
			weiterleitung: z.gdrive.weiterleitung,
			ordner: z.gdrive.ordner,
			nachspieleToken: z.gdrive.nachspieleToken,
			...(z.gdrive.zugangsToken !== undefined
				? { zugangsToken: z.gdrive.zugangsToken }
				: {}),
		};
	}
	const db = await öffneDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_VERBINDUNG, 'readwrite');
		tx.objectStore(STORE_VERBINDUNG).put(kopie, ZIELE_KEY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Alle Ziele entfernen (Google-Verbindung + Ordner-Handle). */
export async function zieleLeeren(): Promise<void> {
	tokenVorrat.leeren();
	const db = await öffneDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_VERBINDUNG, 'readwrite');
		tx.objectStore(STORE_VERBINDUNG).delete(ZIELE_KEY);
		tx.objectStore(STORE_VERBINDUNG).delete(VERBINDUNG_KEY_LEGACY);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Ein einzelnes Ziel entfernen — die anderen bleiben Spiegelziele. */
export async function zielEntfernen(ziel: 'gdrive' | 'ordner' | 'nextcloud'): Promise<void> {
	const z = await zieleLesen();
	if (ziel === 'gdrive') tokenVorrat.leeren();
	delete z[ziel];
	await zieleSchreiben(z);
}

// ---------------------------------------------------------------------------
// Zugangs-Token (nur Google) — ein Nachschub je Token-Lebensdauer
// ---------------------------------------------------------------------------

async function ladeZugang(): Promise<{ zugangsToken: string; gueltigSekunden?: number; cachebar: boolean }> {
	const z = await zieleLesen();
	const g = z.gdrive;
	if (!g) throw new Error('Sicherung: kein Google-Ziel eingerichtet');
	if (g.nachspieleToken === '') {
		throw new Error(m.sicherung_token_fehlt());
	}
	const alt = g.nachspieleToken;
	const zugang = await auffrischeZugang(gdriveAnbindung(g), alt);
	const jetzt = await zieleLesen();
	if (jetzt.gdrive?.nachspieleToken !== alt) {
		return { ...zugang, cachebar: false };
	}
	if (zugang.nachspieleToken !== undefined && zugang.nachspieleToken !== alt) {
		jetzt.gdrive!.nachspieleToken = zugang.nachspieleToken;
		await zieleSchreiben(jetzt);
	}
	return { ...zugang, cachebar: true };
}

const tokenVorrat = new TokenVorrat(ladeZugang);

function gdriveAnbindung(g: NonNullable<SicherungZiele['gdrive']>): GdriveAnbindung {
	return {
		kundenId: g.kundenId,
		...(g.kundenGeheimnis !== undefined && g.kundenGeheimnis !== ''
			? { kundenGeheimnis: g.kundenGeheimnis }
			: {}),
		weiterleitung: g.weiterleitung,
	};
}

/**
 * Adapter für EIN Ziel — oder null, wenn das Ziel gerade nicht bedienbar
 * ist (Ordner-Schreibrecht weg). Wirft nur, wenn ein Fehler echtes
 * Nachfragen verdient; der Fan-out entscheidet dann.
 */
async function zielAdapter(z: SicherungZiele): Promise<AblageAdapter | null> {
	if (z.ordner !== undefined) {
		if (!(await ordnerZugriffOk(z.ordner.verzeichnis))) return null;
		return adapterAusVerzeichnis(z.ordner.verzeichnis);
	}
	if (z.gdrive !== undefined) {
		if (z.gdrive.zugangsToken) {
			// Frisch vom Code-Tausch — verbrauchen, solange er jung ist.
			const token = z.gdrive.zugangsToken;
			delete z.gdrive.zugangsToken;
			await zieleSchreiben(z);
			tokenVorrat.leeren();
			return gdriveAdapter({ zugangsToken: token, ordner: z.gdrive.ordner });
		}
		const token = (await tokenVorrat.holen()).zugangsToken;
		return gdriveAdapter({ zugangsToken: token, ordner: z.gdrive.ordner });
	}
	return null;
}

/**
 * Adapter je Aufruf über ALLE Ziele: schreiben geht in jedes Ziel, lesen
 * bedient sich beim ersten, das die Datei hat. Ein Ziel, das gerade nicht
 * bedienbar ist (Ordner-Schreibrecht, Google-Token-Refresh), fällt still
 * aus der Runde — die anderen sichern weiter, und der Nutzer sieht den
 * Hinweis in der Oberfläche.
 */
export async function adapterLieferant(): Promise<AblageAdapter> {
	const z = await zieleLesen();
	const teile: AblageAdapter[] = [];
	if (z.ordner !== undefined && (await ordnerZugriffOk(z.ordner.verzeichnis))) {
		teile.push(adapterAusVerzeichnis(z.ordner.verzeichnis));
	}
	if (z.gdrive !== undefined) {
		try {
			const token = (await tokenVorrat.holen()).zugangsToken;
			teile.push(gdriveAdapter({ zugangsToken: token, ordner: z.gdrive.ordner }));
		} catch {
			/* Google gerade nicht erreichbar — Ordner sichert weiter */
		}
	}
	if (z.nextcloud !== undefined) {
		// Über den Server, abgeflacht: die Archiv-Routen kennen keine Ordner
		// (Begründung in `flachPfad.ts`).
		teile.push(flachAdapter(archivUeberPulse()));
	}
	if (teile.length === 0) {
		throw new Error('Sicherung: kein Ziel momentan bedienbar');
	}
	return verteilerAdapter(teile);
}

/** Verteilt eine Schreiboperation auf alle Ziele; eines scheitert → Fehler. */
function verteilerAdapter(teile: AblageAdapter[]): AblageAdapter {
	return {
		async schreibe(datei, inhalt) {
			await Promise.all(teile.map((t) => t.schreibe(datei, inhalt)));
		},
		async lese(datei) {
			for (const teil of teile) {
				const inhalt = await teil.lese(datei);
				if (inhalt !== null) return inhalt;
			}
			return null;
		},
		async liste() {
			const mengen = await Promise.all(teile.map((t) => t.liste()));
			return [...new Set(mengen.flat())];
		},
		async lösche(datei) {
			await Promise.all(teile.map((t) => t.lösche?.(datei)));
		},
	};
}
