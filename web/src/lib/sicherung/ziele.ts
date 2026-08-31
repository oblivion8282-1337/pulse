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
import { TokenVorrat } from './tokenVorrat.ts';

const DB_NAME = 'pulse-sicherung';
const DB_VERSION = 2;
const STORE_VERBINDUNG = 'verbindung';
const ZIELE_KEY = 'ziele';
/** Bestand aus der Ein-Ziel-Zeit — wird beim ersten Lesen migriert. */
const VERBINDUNG_KEY_LEGACY = 'gdrive';

export interface SicherungZiele {
	ordner?: { verzeichnis: AblageVerzeichnis };
	gdrive?: {
		kundenId: string;
		kundenGeheimnis?: string;
		weiterleitung: string;
		/** Drive-Ordner als Pfad, z. B. `Pulse-Sicherung`. */
		ordner: string;
		nachspieleToken: string;
		/** Zugangs-Token aus dem Code-Tausch — kurzlebig, nur für die Einrichtung. */
		zugangsToken?: string;
	};
}

/** Ein Ziel ist da, sobald einer der beiden Zwecke belegt ist. */
export function zieleBesetzt(z: SicherungZiele): boolean {
	return z.ordner !== undefined || z.gdrive !== undefined;
}

export const STORE_PUFFER = 'puffer';
export const STORE_LESESTAND = 'leserstand';

export function öffneDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const anfrage = indexedDB.open(DB_NAME, DB_VERSION);
		anfrage.onupgradeneeded = () => {
			const db = anfrage.result;
			if (!db.objectStoreNames.contains(STORE_VERBINDUNG)) db.createObjectStore(STORE_VERBINDUNG);
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

/** Die aktuellen Ziele — migriert beim ersten Lesen den Ein-Ziel-Bestand. */
export async function zieleLesen(): Promise<SicherungZiele> {
	const db = await öffneDb();
	const neu = await new Promise<SicherungZiele | undefined>((resolve, reject) => {
		const tx = db.transaction(STORE_VERBINDUNG, 'readonly');
		const anfrage = tx.objectStore(STORE_VERBINDUNG).get(ZIELE_KEY);
		anfrage.onsuccess = () => resolve(anfrage.result as SicherungZiele | undefined);
		anfrage.onerror = () => reject(anfrage.error);
	});
	if (neu !== undefined) return neu;

	// Migration: der alte Schlüssel hielt EINE Verbindung (Union).
	const alt = (await hole(VERBINDUNG_KEY_LEGACY)) as
		| { ziel: 'gdrive'; kundenId: string; kundenGeheimnis?: string; weiterleitung: string; ordner: string; nachspieleToken: string; zugangsToken?: string }
		| { ziel: 'ordner'; verzeichnis: AblageVerzeichnis }
		| undefined;
	if (alt === undefined) return {};
	const migriert: SicherungZiele =
		alt.ziel === 'gdrive'
			? {
					gdrive: {
						kundenId: alt.kundenId,
						...(alt.kundenGeheimnis !== undefined && alt.kundenGeheimnis !== ''
							? { kundenGeheimnis: alt.kundenGeheimnis }
							: {}),
						weiterleitung: alt.weiterleitung,
						ordner: alt.ordner,
						nachspieleToken: alt.nachspieleToken,
						...(alt.zugangsToken !== undefined ? { zugangsToken: alt.zugangsToken } : {}),
					},
				}
			: { ordner: { verzeichnis: alt.verzeichnis } };
	await zieleSchreiben(migriert);
	return migriert;
}

export async function zieleSchreiben(z: SicherungZiele): Promise<void> {
	// Ebene Kopie an der IDB-Grenze: ein $state-Proxy aus der Oberfläche ist
	// nicht strukturell klonbar ("could not be cloned"). Der Ordner-Handle
	// überlebt den Spread als Referenz und ist selbst klonbar.
	const kopie: SicherungZiele = { ...z };
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
export async function zielEntfernen(ziel: 'gdrive' | 'ordner'): Promise<void> {
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
		throw new Error('Google-Verbindung ohne Nachspiel-Token — bitte Verbindung entfernen und neu herstellen.');
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
