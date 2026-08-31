/**
 * Der Pulse-eigene Google-Client — DER Grund, warum der Nutzer bei der
 * Einrichtung nichts von OAuth-Konfiguration sieht. Die Credentials werden
 * beim BUILD eingesetzt (`VITE_SICHERUNG_GDRIVE_KUNDEN_ID` /
 * `VITE_SICHERUNG_GDRIVE_GEHEIMNIS`, s. `.env`); fehlen sie, sagt die
 * Oberfläche das ehrlich, statt einen toten Knopf zu zeigen.
 *
 * Zwei Rücklauf-Wege:
 *   **Electron** — Loopback `http://127.0.0.1:9109/ruecklauf`. Google
 *   erlaubt bei Desktop-Clients den Loopback-Port dynamisch; der Zuhörer
 *   sitzt im Electron-Main (`sicherungRuecklauf.ts`) und fängt die
 *   Weiterleitung automatisch ab — der Nutzer sieht nur die Google-Seite.
 *   **Browser** — `<origin>/sicherung/ruecklauf`, eine Route dieser App.
 *   Der Konsent öffnet in einem neuen Tab, die Rückkehr-Adresse trägt den
 *   Code in den lokalen Speicher, die Einstellungssektion liest ihn. Die
 *   Adresse muss im Google-Client je Deployment registriert sein
 *   (`http://localhost:5173` für den Dev-Stack, die produktive Domäne fürs
 *   Web).
 */

import { isElectron } from '../platform/runtime.ts';

/**
 * Zwei Clients, weil Google Typen trennt: Electron fährt den
 * **Desktop-Client** (dynamischer Loopback-Port, kein registrierter Pfad),
 * der Browser fährt den **Web-Client** (registrierte Origin-Redirects).
 * Werte kommen beim Bau herein — fehlt der jeweilige Satz, sagt die
 * Oberfläche das ehrlich, statt eines toten Knopfes.
 */
const DESKTOP_KUNDEN_ID = import.meta.env.VITE_SICHERUNG_GDRIVE_KUNDEN_ID ?? '';
const DESKTOP_GEHEIMNIS = import.meta.env.VITE_SICHERUNG_GDRIVE_GEHEIMNIS ?? '';
const WEB_KUNDEN_ID = import.meta.env.VITE_SICHERUNG_GDRIVE_WEB_KUNDEN_ID ?? '';
const WEB_GEHEIMNIS = import.meta.env.VITE_SICHERUNG_GDRIVE_WEB_GEHEIMNIS ?? '';

/** Lokaler Schlüssel des Rückkehr-Tabs → Einstellungssektion (Browser-Weg). */
export const OAUTH_CODE_SPEICHER = 'pulse.sicherung-oauth-code';

/** Ob dieser Build die Sicherung im jeweiligen Kontext anbieten darf. */
export function sicherungClientKonfiguriert(): boolean {
	return isElectron() ? DESKTOP_KUNDEN_ID !== '' : WEB_KUNDEN_ID !== '';
}

/** Client-Daten für `autorisierungsAdresse`/`tauscheCodeAus`. Die
 *  Weiterleitung setzt der Aufrufer (Electron: dynamischer Port vom Main,
 *  Browser: die Rückkehr-Route dieses Origins). */
export function sicherungClient(): {
	kundenId: string;
	kundenGeheimnis?: string;
} {
	return isElectron()
		? {
				kundenId: DESKTOP_KUNDEN_ID,
				...(DESKTOP_GEHEIMNIS !== '' ? { kundenGeheimnis: DESKTOP_GEHEIMNIS } : {}),
			}
		: {
				kundenId: WEB_KUNDEN_ID,
				...(WEB_GEHEIMNIS !== '' ? { kundenGeheimnis: WEB_GEHEIMNIS } : {}),
			};
}

/**
 * Startet den Konsent-Fluss und liefert die Rückgabe-Adresse mit dem Code.
 * `baueAdresse` bekommt die gültige Weiterleitung und baut daraus die
 * Anmelde-Adresse — bei Electron erst NACH der Port-Abfrage, denn der Port
 * ist dynamisch (zwei Pulse-Instanzen, zwei Ports, kein EADDRINUSE).
 */
export async function konsentStarten(
	baueAdresse: (weiterleitung: string) => Promise<string> | string,
): Promise<string> {
	let weiterleitung: string;
	let adresse: string;
	if (isElectron()) {
		const bruecke = (
			globalThis as {
				pulse?: {
					sicherung?: {
						oauthPort(): Promise<number>;
						oauthStart(a: string): Promise<string>;
					};
				};
			}
		).pulse;
		if (!bruecke?.sicherung?.oauthPort || !bruecke.sicherung.oauthStart) {
			throw new Error('Diese Pulse-Version unterstützt die automatische Rückkehr noch nicht.');
		}
		const port = await bruecke.sicherung.oauthPort();
		weiterleitung = `http://127.0.0.1:${port}/ruecklauf`;
		adresse = await baueAdresse(weiterleitung);
		return bruecke.sicherung.oauthStart(adresse);
	}
	weiterleitung = `${globalThis.location.origin}/sicherung/ruecklauf`;
	adresse = await baueAdresse(weiterleitung);
	// Browser: neuer Tab, die Rückkehr-Route legt den Code ab, wir warten.
	globalThis.localStorage.removeItem(OAUTH_CODE_SPEICHER);
	globalThis.open(adresse, '_blank', 'noopener');
	const frist = Date.now() + 5 * 60_000;
	while (Date.now() < frist) {
		await new Promise((r) => setTimeout(r, 500));
		const code = globalThis.localStorage.getItem(OAUTH_CODE_SPEICHER);
		if (code !== null) {
			globalThis.localStorage.removeItem(OAUTH_CODE_SPEICHER);
			return code;
		}
	}
	throw new Error('Zeit abgelaufen — bitte erneut verbinden.');
}
