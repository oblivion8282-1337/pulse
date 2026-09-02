/**
 * OneDrive-Anbindung über Microsoft Graph mit dem AppFolder-Scope
 * (Files.ReadWrite.AppFolder): die Ablage liegt im unsichtbaren App-Ordner,
 * für den es keine Freigabe-UI und kein Scanning-Problem gibt, das über den
 * Ordner hinausreicht. PKCE als öffentlicher Klient, Nachspiel-Token über
 * offline_access. Einfach-Upload trägt bis 4 MiB — die Segmente liegen weit
 * darunter; größere Anhänge gehen im Krypto-Nachzug über Upload-Sessions.
 */

import {
	auffrischeZugang as spieleNach,
	autorisierungsUrl,
	tauscheCodeAus as tausche,
	type Pkce,
	type Zugang,
} from './oauth.ts';
import type { AblageAdapter } from './adapter.ts';

const TOKEN_ENDPUNKT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const APPWURZEL = 'https://graph.microsoft.com/v1.0/drive/special/approot';
const OMFANG = 'Files.ReadWrite.AppFolder offline_access';
const EINFACH_UPLOAD_MAX = 4 * 1024 * 1024;

export interface OnedriveAnbindung {
	kundenId: string;
	/** Öffentliche Klienten brauchen eine Weiterleitung (z. B. Loopback). */
	weiterleitung: string;
	holen?: typeof fetch;
}

export interface OnedriveVerbindung {
	zugangsToken: string;
	/** Ablage-Ordner im App-Ordner, z. B. Pulse/ablage/kanal-1 */
	ordner: string;
	holen?: typeof fetch;
}

export class OnedriveFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'OnedriveFehler';
	}
}

export function autorisierungsAdresse(
	anbindung: OnedriveAnbindung,
	pkce: Pkce,
	zustand: string,
): string {
	return autorisierungsUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize', {
		client_id: anbindung.kundenId,
		response_type: 'code',
		redirect_uri: anbindung.weiterleitung,
		scope: OMFANG,
		code_challenge: pkce.herausforderung,
		code_challenge_method: 'S256',
		state: zustand,
	});
}

export function tauscheCodeAus(anbindung: OnedriveAnbindung, code: string, pkce: Pkce): Promise<Zugang> {
	return tausche(anbindung.holen ?? fetch, TOKEN_ENDPUNKT, {
		client_id: anbindung.kundenId,
		grant_type: 'authorization_code',
		code,
		redirect_uri: anbindung.weiterleitung,
		code_verifier: pkce.pruefer,
	});
}

export function auffrischeZugang(
	anbindung: OnedriveAnbindung,
	nachspieleToken: string,
): Promise<Zugang> {
	return spieleNach(anbindung.holen ?? fetch, TOKEN_ENDPUNKT, nachspieleToken, {
		client_id: anbindung.kundenId,
	});
}

/** Graph-Pfad unter approot, pro Segment kodiert: /Pulse/ablage → :/Pulse/ablage */
function graphPfad(ordner: string, datei?: string): string {
	const teile = [...ordner.split('/').filter((t) => t !== ''), ...(datei ? [datei] : [])];
	const pfad = teile.map(encodeURIComponent).join('/');
	return pfad === '' ? '' : `:/${pfad}`;
}

async function graphFehler(antwort: Response): Promise<string> {
	const daten = (await antwort.json().catch(() => null)) as Record<string, unknown> | null;
	const mitteilung = (daten?.error as Record<string, unknown> | undefined)?.message;
	return typeof mitteilung === 'string' ? mitteilung : `HTTP ${antwort.status}`;
}

export function onedriveAdapter(verbindung: OnedriveVerbindung): AblageAdapter {
	const holen = verbindung.holen ?? fetch;
	const kopf = { Authorization: `Bearer ${verbindung.zugangsToken}` };

	let ordnerGesichert: Promise<void> | null = null;
	/** Graph erzeugt keine Zwischenordner beim Einfach-Upload — hier passieren sie. */
	const ordnerSichern = (): Promise<void> => {
		ordnerGesichert ??= (async () => {
			const stufen = verbindung.ordner.split('/').filter((t) => t !== '');
			let bisher = '';
			for (const stufe of stufen) {
				const geht = await holen(`${APPWURZEL}${graphPfad(bisher, stufe)}`, { headers: kopf });
				if (geht.status === 404) {
					// Kinder von approot selbst hängen an approot/children — erst
					// Unterordner tragen den Doppelpfad.
					const kinder = bisher === '' ? `${APPWURZEL}/children` : `${APPWURZEL}${graphPfad(bisher)}:/children`;
					const angelegt = await holen(kinder, {
						method: 'POST',
						headers: { ...kopf, 'Content-Type': 'application/json' },
						body: JSON.stringify({ name: stufe, folder: {} }),
					});
					if (!angelegt.ok && angelegt.status !== 409) {
						throw new OnedriveFehler(`Ordner ${bisher}/${stufe} scheiterte: ${await graphFehler(angelegt)}`);
					}
				} else if (!geht.ok) {
					throw new OnedriveFehler(`Ordner-Prüfung ${bisher}/${stufe} scheiterte: ${await graphFehler(geht)}`);
				}
				bisher = bisher === '' ? stufe : `${bisher}/${stufe}`;
			}
		})();
		return ordnerGesichert;
	};

	return {
		async schreibe(datei, inhalt) {
			if (inhalt.length > EINFACH_UPLOAD_MAX) {
				throw new OnedriveFehler(
					`${datei} ist zu groß für den Einfach-Upload (${inhalt.length} Bytes, Grenze 4 MiB) — Upload-Sessions kommen mit dem Krypto-Nachzug`,
				);
			}
			await ordnerSichern();
			const antwort = await holen(`${APPWURZEL}${graphPfad(verbindung.ordner, datei)}:/content`, {
				method: 'PUT',
				headers: kopf,
				body: inhalt as unknown as BodyInit,
			});
			if (!antwort.ok) {
				throw new OnedriveFehler(`Upload ${datei} scheiterte: ${await graphFehler(antwort)}`);
			}
		},

		async lese(datei) {
			const antwort = await holen(`${APPWURZEL}${graphPfad(verbindung.ordner, datei)}:/content`, {
				headers: kopf,
			});
			if (antwort.status === 404) {
				return null;
			}
			if (!antwort.ok) {
				throw new OnedriveFehler(`Download ${datei} scheiterte: ${await graphFehler(antwort)}`);
			}
			return new Uint8Array(await antwort.arrayBuffer());
		},

		async liste() {
			await ordnerSichern();
			const namen: string[] = [];
			let adresse: string | null = `${APPWURZEL}${graphPfad(verbindung.ordner)}:/children`;
			while (adresse !== null) {
				const antwort = await holen(adresse, { headers: kopf });
				if (!antwort.ok) {
					throw new OnedriveFehler(`Listing scheiterte: ${await graphFehler(antwort)}`);
				}
				const seite = (await antwort.json()) as {
					value: { name: string; folder?: unknown }[];
					'@odata.nextLink'?: string;
				};
				namen.push(...seite.value.filter((e) => e.folder === undefined).map((e) => e.name));
				adresse = seite['@odata.nextLink'] ?? null;
			}
			return namen;
		},
	};
}
