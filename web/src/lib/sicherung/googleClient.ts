/**
 * Der Pulse-eigene Google-Client — DER Grund, warum der Nutzer bei der
 * Einrichtung nichts von OAuth-Konfiguration sieht. Die Credentials werden
 * beim BUILD eingesetzt (`VITE_SICHERUNG_GDRIVE_KUNDEN_ID` /
 * `VITE_SICHERUNG_GDRIVE_GEHEIMNIS` für Electron, `VITE_SICHERUNG_GDRIVE_WEB_*`
 * für den Browser); fehlen sie, sagt die Oberfläche das ehrlich, statt
 * einen toten Knopf zu zeigen.
 *
 * Zwei Rücklauf-Wege:
 *   **Electron** — Loopback mit DYNAMISCHEM Port: der Zuhörer sitzt im
 *   Electron-Main (`sicherungRuecklauf.ts`), der Renderer fragt den Port
 *   ab (`sicherung:oauthPort`), baut Anmelde-Adresse und Weiterleitung und
 *   lässt sich die Rückgabe-URL zurückreichen.
 *   **Browser** — `<origin>/sicherung/ruecklauf`, eine Route dieser App.
 *   Der Konsent öffnet in einem neuen Tab, die Rückkehr-Adresse trägt
 *   State + Code in den lokalen Speicher, dieser Fluss pollt und PRÜFT den
 *   State (ein Tab kann nicht für einen anderen Fluss unterschieben).
 *
 * Der Zustandsvergleich (`pruefeRueckgabe`) ist Node-getestet.
 */

import { isElectron } from '../platform/runtime.ts';
import { erzeugePkce, type Pkce } from '../ablage/oauth.ts';
import { autorisierungsAdresse, tauscheCodeAus, type GdriveAnbindung } from '../ablage/gdrive.ts';
type GdriveVerbindungRecord = {
	ziel: 'gdrive';
	kundenId: string;
	kundenGeheimnis?: string;
	weiterleitung: string;
	ordner: string;
	nachspieleToken: string;
	zugangsToken: string;
};

const DESKTOP_KUNDEN_ID = import.meta.env.VITE_SICHERUNG_GDRIVE_KUNDEN_ID ?? '';
const DESKTOP_GEHEIMNIS = import.meta.env.VITE_SICHERUNG_GDRIVE_GEHEIMNIS ?? '';
const WEB_KUNDEN_ID = import.meta.env.VITE_SICHERUNG_GDRIVE_WEB_KUNDEN_ID ?? '';
const WEB_GEHEIMNIS = import.meta.env.VITE_SICHERUNG_GDRIVE_WEB_GEHEIMNIS ?? '';

/** Lokaler Schlüssel des Rückkehr-Tabs → Einstellungssektion (Browser-Weg). */
export const OAUTH_RUECKGABE_SPEICHER = 'pulse.sicherung-oauth-rueckgabe';

/** Ob dieser Build die Sicherung im jeweiligen Kontext anbieten darf. */
export function sicherungClientKonfiguriert(): boolean {
	return isElectron() ? WEB_KUNDEN_ID !== '' || DESKTOP_KUNDEN_ID !== '' : WEB_KUNDEN_ID !== '';
}

function gdriveZiel(weiterleitung: string): {
	ziel: 'gdrive';
	kundenId: string;
	kundenGeheimnis?: string;
	weiterleitung: string;
	ordner: string;
} {
	const kundenId = isElectron() ? DESKTOP_KUNDEN_ID : WEB_KUNDEN_ID;
	const geheimnis = isElectron() ? DESKTOP_GEHEIMNIS : WEB_GEHEIMNIS;
	return {
		ziel: 'gdrive',
		kundenId,
		...(geheimnis !== '' ? { kundenGeheimnis: geheimnis } : {}),
		weiterleitung,
		ordner: 'Pulse-Sicherung',
	};
}

function anbindung(ziel: ReturnType<typeof gdriveZiel>): GdriveAnbindung {
	return {
		kundenId: ziel.kundenId,
		...(ziel.kundenGeheimnis !== undefined ? { kundenGeheimnis: ziel.kundenGeheimnis } : {}),
		weiterleitung: ziel.weiterleitung,
	};
}

function zufallsHex(laenge: number): string {
	const bytes = new Uint8Array(laenge / 2);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Electron-IPC-Brücke (optional — nur unter Electron vorhanden). */
interface RuecklaufBruecke {
	oauthPort(): Promise<number>;
	oauthStart(adresse: string): Promise<string>;
}

function ruecklaufBruecke(): RuecklaufBruecke | null {
	return (
		(globalThis as { pulse?: { sicherung?: RuecklaufBruecke } }).pulse?.sicherung ?? null
	);
}

/** Rückgabe-URL (Electron) in Code + State zerlegen. */
export function zerlegeRueckgabe(rueckgabe: string): { code: string; state: string } {
	const code = /[?&]code=([^&]+)/.exec(rueckgabe)?.[1];
	const state = /[?&]state=([^&]+)/.exec(rueckgabe)?.[1];
	if (!code || !state) throw new Error('Rückgabe ohne Code oder State');
	return { code: decodeURIComponent(code), state: decodeURIComponent(state) };
}

/** Rückgabe aus der Rückkehr-Route prüfen (Browser-Weg): State muss passen. */
export function pruefeRueckgabe(roh: string, erwarteterState: string): string {
	const geparst = JSON.parse(roh) as { state?: string; code?: string };
	if (geparst.state !== erwarteterState || typeof geparst.code !== 'string') {
		throw new Error('State passt nicht — Rückgabe verworfen.');
	}
	return geparst.code;
}

/**
 * Der komplette Verbindungsfluss: State erzeugen, Konsent öffnen, Rückgabe
 * prüfen, Code gegen den Zugangs-Token tauschen. Liefert die fertige
 * gdrive-Verbindung (ohne `ziel`-Feld — das setzt der Aufrufer).
 */
export async function googleSicherungVerbinden(): Promise<GdriveVerbindungRecord> {
	const bruecke = isElectron() ? ruecklaufBruecke() : null;
	if (isElectron() && !bruecke) {
		throw new Error('Diese Pulse-Version unterstützt die Rückkehr noch nicht.');
	}
	const weiterleitung = isElectron()
		? `http://127.0.0.1:${await bruecke!.oauthPort()}/ruecklauf`
		: `${globalThis.location.origin}/sicherung/ruecklauf`;
	const ziel = gdriveZiel(weiterleitung);
	const pkce: Pkce = await erzeugePkce();
	const zustand = zufallsHex(16);
	const adresse = autorisierungsAdresse(anbindung(ziel), pkce, zustand);

	let code: string;
	if (isElectron()) {
		const rueckgabe = zerlegeRueckgabe(await bruecke!.oauthStart(adresse));
		if (rueckgabe.state !== zustand) {
			throw new Error('OAuth-State passt nicht — Rückgabe verworfen.');
		}
		code = rueckgabe.code;
	} else {
		// Browser: neuer Tab, die Rückkehr-Route legt {state, code} ab, wir warten.
		globalThis.localStorage.removeItem(OAUTH_RUECKGABE_SPEICHER);
		globalThis.open(adresse, '_blank', 'noopener');
		const frist = Date.now() + 5 * 60_000;
		code = await new Promise<string>((resolve, ablehnen) => {
			const uhr = setInterval(() => {
				const roh = globalThis.localStorage.getItem(OAUTH_RUECKGABE_SPEICHER);
				if (roh !== null) {
					clearInterval(uhr);
					globalThis.localStorage.removeItem(OAUTH_RUECKGABE_SPEICHER);
					try {
						resolve(pruefeRueckgabe(roh, zustand));
					} catch (fehler) {
						clearInterval(uhr);
						ablehnen(fehler instanceof Error ? fehler : new Error(String(fehler)));
					}
				} else if (Date.now() > frist) {
					clearInterval(uhr);
					ablehnen(new Error('Zeit abgelaufen — bitte erneut verbinden.'));
				}
			}, 500);
		});
	}

	const zugang = await tauscheCodeAus(anbindung(ziel), code, pkce);
	return {
		...ziel,
		nachspieleToken: zugang.nachspieleToken ?? '',
		zugangsToken: zugang.zugangsToken,
	};
}
