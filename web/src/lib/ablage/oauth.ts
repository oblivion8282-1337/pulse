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

/** Der ROHE Hash, nicht seine Hex-Schreibweise. Hiess bis zum 2026-09-01
 *  `sha256HexAlsBytes` und log damit im Namen: Hex kommt hier nirgends vor.
 *  Der Unterschied ist keine Wortklauberei — die PKCE-S256-Herausforderung
 *  ist `BASE64URL(SHA256(pruefer))`. Waere hier wirklich Hex herausgekommen
 *  und base64-kodiert worden, haette die Gegenstelle jeden Tausch
 *  abgelehnt. */
function sha256Bytes(text: string): Promise<Uint8Array> {
	return globalThis.crypto.subtle
		.digest('SHA-256', new TextEncoder().encode(text) as unknown as ArrayBuffer)
		.then((d) => new Uint8Array(d));
}

/** Prüfener + S256-Herausforderung für einen frischen Autorisierungslauf. */
export async function erzeugePkce(): Promise<Pkce> {
	const zufall = new Uint8Array(32);
	globalThis.crypto.getRandomValues(zufall);
	const pruefer = basis64url(zufall);
	const herausforderung = basis64url(await sha256Bytes(pruefer));
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

/**
 * Endgültig — nicht bloß vorübergehend — ungültiger Zugang: entweder gibt es
 * kein Nachspiel-Token mehr, oder die Auffrischung selbst ist gescheitert,
 * oder der frisch aufgefrischte Zugang wurde vom Anbieter erneut abgelehnt.
 * Die Zustandsanzeige (Aufgabe 5) unterscheidet daran „Anmeldung
 * abgelaufen" von einem gewöhnlichen Übertragungsfehler.
 */
export class AnmeldungAbgelaufenFehler extends Error {
	constructor(grund: string, ursache?: unknown) {
		super(`Anmeldung abgelaufen: ${grund}`);
		this.name = 'AnmeldungAbgelaufenFehler';
		if (ursache !== undefined) this.cause = ursache;
	}
}

/** Der Ausschnitt eines Zugangs, den der Auffrisch-Weg lesen muss. */
export interface AuffrischbarerZugang {
	zugangsToken: string;
	nachspieleToken?: string;
}

/**
 * Baut einen `fetch`-Wrapper, der eine 401-Antwort abfängt: den Zugang
 * genau einmal auffrischen (via `auffrischen`) und den ursprünglichen Aufruf
 * mit dem neuen Token wiederholen. Laufen mehrere Aufrufe gleichzeitig in
 * ein 401, teilen sie sich dieselbe Auffrischung — das laufende Versprechen
 * wird gemerkt, nicht ein zweites Mal gestartet. Ohne dieses Merken würden
 * bei Anbietern mit rotierenden Nachspiel-Tokens beide Aufrufer denselben
 * alten Token einlösen wollen; der zweite bekäme ihn als bereits verbraucht
 * zurück und der Zugang wäre für beide verbrannt.
 *
 * Ist nach der Auffrischung auch der neue Zugang abgelehnt, oder scheitert
 * die Auffrischung selbst, oder fehlt von vornherein ein Nachspiel-Token,
 * wird das NIE stillschweigend verschluckt — es wirft immer einen
 * `AnmeldungAbgelaufenFehler`, den der Aufrufer von einem gewöhnlichen
 * Netzwerk-/Serverfehler unterscheiden kann.
 */
export function erzeugeAuffrischendesHolen(
	basisHolen: typeof fetch,
	aktuellerZugang: () => AuffrischbarerZugang,
	auffrischen: (nachspieleToken: string) => Promise<Zugang>,
	zugangAufgefrischt?: (zugang: Zugang) => void,
): typeof fetch {
	let laufendeAuffrischung: Promise<Zugang> | null = null;

	function mitToken(init: RequestInit | undefined, token: string): RequestInit {
		const kopf = new Headers(init?.headers);
		kopf.set('Authorization', `Bearer ${token}`);
		return { ...init, headers: kopf };
	}

	return async (eingabe, init) => {
		const erstAntwort = await basisHolen(eingabe, init);
		if (erstAntwort.status !== 401) return erstAntwort;

		const { nachspieleToken } = aktuellerZugang();
		if (nachspieleToken === undefined) {
			throw new AnmeldungAbgelaufenFehler('kein Nachspiel-Token vorhanden');
		}

		// `??=` statt eines eigenen Merkers: die Zuweisung passiert synchron im
		// selben Durchlauf, in dem `null` festgestellt wurde (kein `await`
		// dazwischen) — ein zweiter, gleichzeitig ankommender Aufruf sieht die
		// Zuweisung deshalb garantiert, bevor er selbst nachsehen könnte.
		laufendeAuffrischung ??= auffrischen(nachspieleToken)
			.then((neu) => {
				zugangAufgefrischt?.(neu);
				return neu;
			})
			.finally(() => {
				laufendeAuffrischung = null;
			});

		let neuerZugang: Zugang;
		try {
			neuerZugang = await laufendeAuffrischung;
		} catch (fehler) {
			throw new AnmeldungAbgelaufenFehler('Auffrischung scheiterte', fehler);
		}

		const zweiteAntwort = await basisHolen(eingabe, mitToken(init, neuerZugang.zugangsToken));
		if (zweiteAntwort.status === 401) {
			throw new AnmeldungAbgelaufenFehler('Zugang bleibt abgelehnt, auch nach Auffrischung');
		}
		return zweiteAntwort;
	};
}
