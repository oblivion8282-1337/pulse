/**
 * Gemeinsame OAuth-2-Bausteine für die App-Folder-Anbindungen
 * (Dropbox, OneDrive, Google Drive): PKCE, Autorisierungs-URL,
 * Code-Tausch und Token-Auffrischung.
 *
 * Alles ohne client_secret — alle drei Anbieter nehmen PKCE für
 * öffentliche Klienten (Desktop-App). Die Tokens leben ausschließlich
 * beim Owner-Gerät; der Pulse-Server sieht sie nie (Konzept §1).
 * Wer das Fenster aufmacht und den Weiterleitungs-Code einfängt, ist
 * Sache der Plattform (Electron), nicht dieser Bibliothek.
 */

export interface Pkce {
	pruefer: string;
	herausforderung: string;
}

export interface Zugang {
	zugangsToken: string;
	nachspieleToken?: string;
	/** Lebensdauer des Zugangs-Tokens in Sekunden, wenn der Anbieter sie nennt. */
	gueltigSekunden?: number;
}

export class OAuthFehler extends Error {
	readonly fehler: string;
	readonly beschreibung?: string;

	constructor(fehler: string, beschreibung?: string) {
		super(`OAuth abgelehnt: ${fehler}${beschreibung ? ` — ${beschreibung}` : ''}`);
		this.name = 'OAuthFehler';
		this.fehler = fehler;
		this.beschreibung = beschreibung;
	}
}

function basis64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

function sha256HexAlsBytes(text: string): Promise<Uint8Array> {
	return globalThis.crypto.subtle
		.digest('SHA-256', new TextEncoder().encode(text) as unknown as ArrayBuffer)
		.then((d) => new Uint8Array(d));
}

/** Prüfener + S256-Herausforderung für einen frischen Autorisierungslauf. */
export async function erzeugePkce(): Promise<Pkce> {
	const zufall = new Uint8Array(32);
	globalThis.crypto.getRandomValues(zufall);
	const pruefer = basis64url(zufall);
	const herausforderung = basis64url(await sha256HexAlsBytes(pruefer));
	return { pruefer, herausforderung };
}

/** Baut eine Autorisierungs-URL: Basis plus sortierte, kodierte Parameter. */
export function autorisierungsUrl(basis: string, parameter: Record<string, string>): string {
	const abfrage = new URLSearchParams(parameter).toString();
	return `${basis}?${abfrage}`;
}

/**
 * Tauscht einen Weiterleitungs-Code gegen Zugangstokens. Das Formular
 * (code, code_verifier, grant_type, …) legt der Anbindung fest; hier steht
 * nur der Transport und die Fehler-Auspackerei des Anbieters.
 */
export async function tauscheCodeAus(
	holen: typeof fetch,
	endpunkt: string,
	formular: Record<string, string>,
): Promise<Zugang> {
	const antwort = await holen(endpunkt, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(formular).toString(),
	});
	const daten = (await antwort.json().catch(() => null)) as Record<string, unknown> | null;
	if (!antwort.ok || daten === null || typeof daten.access_token !== 'string') {
		throw new OAuthFehler(
			String(daten?.error ?? antwort.status),
			typeof daten?.error_description === 'string' ? daten.error_description : undefined,
		);
	}
	return {
		zugangsToken: daten.access_token,
		nachspieleToken: typeof daten.refresh_token === 'string' ? daten.refresh_token : undefined,
		gueltigSekunden: typeof daten.expires_in === 'number' ? daten.expires_in : undefined,
	};
}

/** Spielt einen abgelaufenen Zugang mit dem Nachspiel-Token nach. */
export async function auffrischeZugang(
	holen: typeof fetch,
	endpunkt: string,
	nachspieleToken: string,
	formular: Record<string, string>,
): Promise<Zugang> {
	return tauscheCodeAus(holen, endpunkt, {
		...formular,
		grant_type: 'refresh_token',
		refresh_token: nachspieleToken,
	});
}
