/**
 * Google-Drive-Anbindung mit dem per-Datei-Scope (drive.file): die App sieht
 * nur die Dateien, die sie selbst erzeugt hat — der Scope ist nicht
 * „restricted", also voraussichtlich ohne CASA-Assessment (Konzept §4,
 * vor Umsetzung des echten Klienten nachprüfen). Ordner werden als
 * Drive-Ordner im App-Sichtbereich geführt; Overwrite heißt PATCH auf die
 * bekannte Datei-Id, Neuanlage heißt Multipart-Create.
 */

import {
	auffrischeZugang as spieleNach,
	autorisierungsUrl,
	tauscheCodeAus as tausche,
	type Pkce,
	type Zugang,
} from './oauth.ts';
import type { AblageAdapter } from './adapter.ts';

const TOKEN_ENDPUNKT = 'https://oauth2.googleapis.com/token';
const OMFANG = 'https://www.googleapis.com/auth/drive.file';
const ORDNER_MIME = 'application/vnd.google-apps.folder';

export interface GdriveAnbindung {
	kundenId: string;
	weiterleitung: string;
	holen?: typeof fetch;
}

export interface GdriveVerbindung {
	zugangsToken: string;
	/** Ablage-Ordner als Drive-Pfad im App-Sichtbereich, z. B. Pulse/ablage/kanal-1 */
	ordner: string;
	holen?: typeof fetch;
}

export class GdriveFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'GdriveFehler';
	}
}

export function autorisierungsAdresse(anbindung: GdriveAnbindung, pkce: Pkce, zustand: string): string {
	return autorisierungsUrl('https://accounts.google.com/o/oauth2/v2/auth', {
		client_id: anbindung.kundenId,
		response_type: 'code',
		scope: OMFANG,
		redirect_uri: anbindung.weiterleitung,
		code_challenge: pkce.herausforderung,
		code_challenge_method: 'S256',
		access_type: 'offline',
		state: zustand,
	});
}

export function tauscheCodeAus(anbindung: GdriveAnbindung, code: string, pkce: Pkce): Promise<Zugang> {
	return tausche(anbindung.holen ?? fetch, TOKEN_ENDPUNKT, {
		client_id: anbindung.kundenId,
		grant_type: 'authorization_code',
		code,
		redirect_uri: anbindung.weiterleitung,
		code_verifier: pkce.pruefer,
	});
}

export function auffrischeZugang(anbindung: GdriveAnbindung, nachspieleToken: string): Promise<Zugang> {
	return spieleNach(anbindung.holen ?? fetch, TOKEN_ENDPUNKT, nachspieleToken, {
		client_id: anbindung.kundenId,
	});
}

function verketten(teile: Uint8Array[]): Uint8Array {
	const laenge = teile.reduce((s, t) => s + t.length, 0);
	const ganz = new Uint8Array(laenge);
	let bei = 0;
	for (const teil of teile) {
		ganz.set(teil, bei);
		bei += teil.length;
	}
	return ganz;
}

/** Multipart/related-Body für den Create-Upload: Metadaten-Teil + Byte-Teil. */
export function multipartErzeugen(metadaten: object, inhalt: Uint8Array): { koerper: Uint8Array; grenze: string } {
	const grenze = `pulse${Math.random().toString(16).slice(2)}`;
	const kopfText =
		`--${grenze}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
		`${JSON.stringify(metadaten)}\r\n` +
		`--${grenze}\r\nContent-Type: application/octet-stream\r\n\r\n`;
	const schwanzText = `\r\n--${grenze}--\r\n`;
	const koerper = verketten([
		new TextEncoder().encode(kopfText),
		inhalt,
		new TextEncoder().encode(schwanzText),
	]);
	return { koerper, grenze };
}

export function gdriveAdapter(verbindung: GdriveVerbindung): AblageAdapter {
	const holen = verbindung.holen ?? fetch;
	const kopf = { Authorization: `Bearer ${verbindung.zugangsToken}` };
	const dateiIdNachName = new Map<string, string>();

	async function abfrage(q: string): Promise<{ id: string; name: string }[]> {
		const adresse = new URL('https://www.googleapis.com/drive/v3/files');
		adresse.searchParams.set('q', q);
		adresse.searchParams.set('fields', 'nextPageToken,files(id,name)');
		adresse.searchParams.set('pageSize', '200');
		const funde: { id: string; name: string }[] = [];
		while (adresse !== null) {
			const antwort = await holen(adresse.toString(), { headers: kopf });
			if (!antwort.ok) {
				throw new GdriveFehler(`Suche scheiterte: HTTP ${antwort.status}`);
			}
			const seite = (await antwort.json()) as {
				files?: { id: string; name: string }[];
				nextPageToken?: string;
			};
			funde.push(...(seite.files ?? []));
			if (seite.nextPageToken === undefined) {
				break;
			}
			adresse.searchParams.set('pageToken', seite.nextPageToken);
		}
		return funde;
	}

	/** Läuft die Ordnerkette entlang, legt fehlende Stufen an und liefert die Id. */
	async function ordnerIdHolen(): Promise<string> {
		let elternteil = 'root';
		for (const stufe of verbindung.ordner.split('/').filter((t) => t !== '')) {
			const da = await abfrage(
				`name = '${stufe}' and '${elternteil}' in parents and mimeType = '${ORDNER_MIME}' and trashed = false`,
			);
			if (da.length > 0) {
				elternteil = da[0].id;
				continue;
			}
			const angelegt = await holen('https://www.googleapis.com/drive/v3/files', {
				method: 'POST',
				headers: { ...kopf, 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: stufe, parents: [elternteil], mimeType: ORDNER_MIME }),
			});
			if (!angelegt.ok) {
				throw new GdriveFehler(`Ordner ${stufe} scheiterte: HTTP ${angelegt.status}`);
			}
			elternteil = ((await angelegt.json()) as { id: string }).id;
		}
		return elternteil;
	}

	let ordnerId: Promise<string> | null = null;
	const ordnerSichern = (): Promise<string> => (ordnerId ??= ordnerIdHolen());

	async function dateiIdHolen(ordner: string, name: string): Promise<string | null> {
		const bekannt = dateiIdNachName.get(name);
		if (bekannt !== undefined) {
			return bekannt;
		}
		const funde = await abfrage(
			`name = '${name}' and '${ordner}' in parents and trashed = false`,
		);
		if (funde.length === 0) {
			return null;
		}
		dateiIdNachName.set(name, funde[0].id);
		return funde[0].id;
	}

	return {
		async schreibe(datei, inhalt) {
			const ordner = await ordnerSichern();
			const bekannt = await dateiIdHolen(ordner, datei);
			if (bekannt !== null) {
				const antwort = await holen(
					`https://www.googleapis.com/upload/drive/v3/files/${bekannt}?uploadType=media`,
					{
						method: 'PATCH',
						headers: { ...kopf, 'Content-Type': 'application/octet-stream' },
						body: inhalt as unknown as BodyInit,
					},
				);
				if (!antwort.ok) {
					throw new GdriveFehler(`Update ${datei} scheiterte: HTTP ${antwort.status}`);
				}
				return;
			}
			const { koerper, grenze } = multipartErzeugen(
				{ name: datei, parents: [ordner] },
				inhalt,
			);
			const antwort = await holen(
				'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
				{
					method: 'POST',
					headers: {
						...kopf,
						'Content-Type': `multipart/related; boundary=${grenze}`,
					},
					body: koerper as unknown as BodyInit,
				},
			);
			if (!antwort.ok) {
				throw new GdriveFehler(`Create ${datei} scheiterte: HTTP ${antwort.status}`);
			}
			dateiIdNachName.set(datei, ((await antwort.json()) as { id: string }).id);
		},

		async lese(datei) {
			const ordner = await ordnerSichern();
			const id = await dateiIdHolen(ordner, datei);
			if (id === null) {
				return null;
			}
			const antwort = await holen(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
				headers: kopf,
			});
			if (antwort.status === 404) {
				dateiIdNachName.delete(datei);
				return null;
			}
			if (!antwort.ok) {
				throw new GdriveFehler(`Download ${datei} scheiterte: HTTP ${antwort.status}`);
			}
			return new Uint8Array(await antwort.arrayBuffer());
		},

		async liste() {
			const ordner = await ordnerSichern();
			const funde = await abfrage(
				`'${ordner}' in parents and mimeType != '${ORDNER_MIME}' and trashed = false`,
			);
			for (const f of funde) {
				dateiIdNachName.set(f.name, f.id);
			}
			return funde.map((f) => f.name);
		},
	};
}
