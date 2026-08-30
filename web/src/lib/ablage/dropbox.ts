/**
 * Dropbox-Anbindung: App-Folder über OAuth-2 mit PKCE (token_access_type
 * offline → Nachspiel-Token). Der App-Ordner ist der Wurzelbereich des
 * Adapters — die Ablage liegt unter /<ordner>/ im App-Ordner und ist nach
 * außen genau so unsichtbar wie der Rest des Ordners.
 *
 * Ehrlich zur ToS-Lage (Analyse Wand 1): das Token bleibt auf dem
 * Owner-Gerät und wird nicht verteilt — genau das verbietet §2.6(c) nicht.
 * Der Transport ist injiziert; geprüft wird gegen einen Mini-Server.
 */

import {
	auffrischeZugang as spieleNach,
	autorisierungsUrl,
	tauscheCodeAus as tausche,
	type Pkce,
	type Zugang,
} from './oauth.ts';
import type { AblageAdapter } from './adapter.ts';

const API = 'https://api.dropboxapi.com';
const INHALT = 'https://content.dropboxapi.com';
const TOKEN_ENDPUNKT = `${API}/oauth2/token`;

export interface DropboxAnbindung {
	kundenId: string;
	/** Nur wenn die Dropbox-App eine Weiterleitung eingetragen hat. */
	weiterleitung?: string;
	holen?: typeof fetch;
}

export interface DropboxVerbindung {
	zugangsToken: string;
	/** Ablage-Ordner im App-Ordner, z. B. Pulse/ablage/kanal-1 */
	ordner: string;
	holen?: typeof fetch;
}

export class DropboxFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'DropboxFehler';
	}
}

export function autorisierungsAdresse(
	anbindung: DropboxAnbindung,
	pkce: Pkce,
	zustand: string,
): string {
	return autorisierungsUrl('https://www.dropbox.com/oauth2/authorize', {
		client_id: anbindung.kundenId,
		response_type: 'code',
		token_access_type: 'offline',
		code_challenge: pkce.herausforderung,
		code_challenge_method: 'S256',
		state: zustand,
		...(anbindung.weiterleitung ? { redirect_uri: anbindung.weiterleitung } : {}),
	});
}

export function tauscheCodeAus(anbindung: DropboxAnbindung, code: string, pkce: Pkce): Promise<Zugang> {
	return tausche(anbindung.holen ?? fetch, TOKEN_ENDPUNKT, {
		code,
		grant_type: 'authorization_code',
		client_id: anbindung.kundenId,
		code_verifier: pkce.pruefer,
		...(anbindung.weiterleitung ? { redirect_uri: anbindung.weiterleitung } : {}),
	});
}

export function auffrischeZugang(
	anbindung: DropboxAnbindung,
	nachspieleToken: string,
): Promise<Zugang> {
	return spieleNach(anbindung.holen ?? fetch, TOKEN_ENDPUNKT, nachspieleToken, {
		client_id: anbindung.kundenId,
	});
}

function apiArg(pfad: string): string {
	return JSON.stringify({ path: pfad, mode: 'overwrite', mute: true });
}

async function fehlermeldung(antwort: Response): Promise<string> {
	const daten = (await antwort.json().catch(() => null)) as Record<string, unknown> | null;
	const zusammenfassung = daten?.error_summary;
	return typeof zusammenfassung === 'string' ? zusammenfassung : `HTTP ${antwort.status}`;
}

function vollerPfad(ordner: string, datei?: string): string {
	return `/${[...ordner.split('/').filter((t) => t !== ''), ...(datei ? [datei] : [])].join('/')}`;
}

export function dropboxAdapter(verbindung: DropboxVerbindung): AblageAdapter {
	const holen = verbindung.holen ?? fetch;
	const kopf = { Authorization: `Bearer ${verbindung.zugangsToken}` };

	return {
		async schreibe(datei, inhalt) {
			const antwort = await holen(`${INHALT}/2/files/upload`, {
				method: 'POST',
				headers: { ...kopf, 'Dropbox-API-Arg': apiArg(vollerPfad(verbindung.ordner, datei)), 'Content-Type': 'application/octet-stream' },
				body: inhalt as unknown as BodyInit,
			});
			if (!antwort.ok) {
				throw new DropboxFehler(`Upload ${datei} scheiterte: ${await fehlermeldung(antwort)}`);
			}
		},

		async lese(datei) {
			const antwort = await holen(`${INHALT}/2/files/download`, {
				method: 'POST',
				headers: { ...kopf, 'Dropbox-API-Arg': JSON.stringify({ path: vollerPfad(verbindung.ordner, datei) }) },
			});
			if (antwort.status === 404) {
				return null;
			}
			if (antwort.status === 409) {
				const zusammenfassung = await fehlermeldung(antwort);
				if (zusammenfassung.includes('not_found')) {
					return null;
				}
				throw new DropboxFehler(`Download ${datei} scheiterte: ${zusammenfassung}`);
			}
			if (!antwort.ok) {
				throw new DropboxFehler(`Download ${datei} scheiterte: HTTP ${antwort.status}`);
			}
			return new Uint8Array(await antwort.arrayBuffer());
		},

		async liste() {
			const namen: string[] = [];
			const ersteAntwort = await holen(`${API}/2/files/list_folder`, {
				method: 'POST',
				headers: { ...kopf, 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: vollerPfad(verbindung.ordner), limit: 500 }),
			});
			if (ersteAntwort.status === 409 && (await fehlermeldung(ersteAntwort)).includes('not_found')) {
				// Der App-Ordner existiert erst seit der Autorisierung, aber
				// Unterordner legt Dropbox erst beim ersten Upload an — ein
				// fehlender Ordner beim Auflisten ist schlicht „leer".
				return [];
			}
			if (!ersteAntwort.ok) {
				throw new DropboxFehler(`Listing scheiterte: ${await fehlermeldung(ersteAntwort)}`);
			}
			type Listenseite = {
				entries: { name: string; '.tag': string }[];
				has_more: boolean;
				cursor: string;
			};
			let schwellen: Listenseite = (await ersteAntwort.json()) as Listenseite;
			namen.push(...schwellen.entries.filter((e) => e['.tag'] === 'file').map((e) => e.name));
			while (schwellen.has_more) {
				schwellen = (await (
					await holen(`${API}/2/files/list_folder/continue`, {
						method: 'POST',
						headers: { ...kopf, 'Content-Type': 'application/json' },
						body: JSON.stringify({ cursor: schwellen.cursor }),
					})
				).json()) as Listenseite;
				namen.push(...schwellen.entries.filter((e) => e['.tag'] === 'file').map((e) => e.name));
			}
			return namen;
		},
	};
}
