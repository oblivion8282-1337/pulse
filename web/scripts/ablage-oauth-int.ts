/**
 * OAuth-Integrationstest für die App-Folder-Anbindungen — bewusst NICHT in
 * test:unit, weil er echte Konsent-Seiten und Token-Endpunkte braucht:
 *
 *   ABLAGE_INT_DROPBOX_KUNDEN_ID=<App-Key> pnpm test:ablage-oauth dropbox
 *   ABLAGE_INT_ONEDRIVE_KUNDEN_ID=<Client-ID> pnpm test:ablage-oauth onedrive
 *
 * Ablauf pro Anbieter: Autorisierungs-Adresse aus unserer Anbindung drucken
 * und im Browser öffnen → du stimmst zu → der Redirect auf den Loopback
 * wird hier von einem Mini-Server aufgefangen (state-Prüfung gegen CSRF) →
 * Code-Tausch über die Anbindung → mit dem Zugang dasselbe Festigungs-
 * Geschirr wie bei MinIO/Nextcloud → der Nachspiel-Token landet
 * (chmod 600, gitignored) in .ablage-int/, damit weitere Läufe den
 * AUFFRISCH-Weg prüfen statt wieder den Browser zu bemühen. Tokens werden
 * nirgendwo ausgegeben.
 */

import { createServer } from 'node:http';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AblageGeschirr } from './ablage-geschirr.ts';
import { erzeugePkce, type Zugang } from '../src/lib/ablage/oauth.ts';
import {
	autorisierungsAdresse as dropboxAdresse,
	auffrischeZugang as dropboxNachspiel,
	dropboxAdapter,
	tauscheCodeAus as dropboxTausch,
} from '../src/lib/ablage/dropbox.ts';
import {
	autorisierungsAdresse as onedriveAdresse,
	auffrischeZugang as onedriveNachspiel,
	onedriveAdapter,
	tauscheCodeAus as onedriveTausch,
} from '../src/lib/ablage/onedrive.ts';
import {
	autorisierungsAdresse as gdriveAdresse,
	auffrischeZugang as gdriveNachspiel,
	gdriveAdapter,
	tauscheCodeAus as gdriveTausch,
} from '../src/lib/ablage/gdrive.ts';
import type { AblageAdapter } from '../src/lib/ablage/adapter.ts';

interface AnbieterStecker {
	port: number;
	kundenIdEnv: string;
	tokenDatei: string;
	hinweis: string;
	adresse(kundenId: string, herausforderung: string, zustand: string): Promise<string>;
	tauschen(kundenId: string, code: string, pruefer: string): Promise<Zugang>;
	nachspielen(kundenId: string, nachspieleToken: string): Promise<Zugang>;
	adapter(zugangsToken: string, lauf: string): Promise<AblageAdapter>;
}

const DROPBOX: AnbieterStecker = {
	port: 9107,
	kundenIdEnv: 'ABLAGE_INT_DROPBOX_KUNDEN_ID',
	tokenDatei: 'dropbox.json',
	hinweis:
		'Dropbox-App (dropbox.com/developers/apps): Typ „App folder", Scopes files.content.write/read + files.metadata.read, Redirect http://localhost:9107/ruecklauf',
	adresse: async (kundenId, herausforderung, zustand) =>
		dropboxAdresse({ kundenId, weiterleitung: WEITERLEITUNG_DROPBOX }, { pruefer: '', herausforderung }, zustand),
	tauschen: (kundenId, code, pruefer) =>
		dropboxTausch({ kundenId, weiterleitung: WEITERLEITUNG_DROPBOX }, code, { pruefer, herausforderung: '' }),
	nachspielen: (kundenId, nachspieleToken) => dropboxNachspiel({ kundenId }, nachspieleToken),
	adapter: async (zugangsToken, lauf) => dropboxAdapter({ zugangsToken, ordner: `Pulse/int-${lauf}/kanal` }),
};

const ONEDRIVE: AnbieterStecker = {
	port: 9108,
	kundenIdEnv: 'ABLAGE_INT_ONEDRIVE_KUNDEN_ID',
	tokenDatei: 'onedrive.json',
	hinweis:
		'Entra-App-Registrierung: Kontotypen inkl. persönlich, Plattform „Mobil- und Desktopanwendungen" mit http://localhost:9108/ruecklauf, öffentliche Clientflows ja, Graph-Delegiert: Files.ReadWrite.AppFolder + offline_access + User.Read',
	adresse: async (kundenId, herausforderung, zustand) =>
		onedriveAdresse(
			{ kundenId, weiterleitung: `http://localhost:${ONEDRIVE.port}/ruecklauf` },
			{ pruefer: '', herausforderung },
			zustand,
		),
	tauschen: (kundenId, code, pruefer) =>
		onedriveTausch(
			{ kundenId, weiterleitung: `http://localhost:${ONEDRIVE.port}/ruecklauf` },
			code,
			{ pruefer, herausforderung: '' },
		),
	nachspielen: (kundenId, nachspieleToken) =>
		onedriveNachspiel({ kundenId, weiterleitung: `http://localhost:${ONEDRIVE.port}/ruecklauf` }, nachspieleToken),
	adapter: async (zugangsToken, lauf) => onedriveAdapter({ zugangsToken, ordner: `Pulse/int-${lauf}/kanal` }),
};

const GDRIVE: AnbieterStecker = {
	port: 9109,
	kundenIdEnv: 'ABLAGE_INT_GDRIVE_KUNDEN_ID',
	tokenDatei: 'gdrive.json',
	hinweis:
		'Google-Cloud: OAuth-Client Typ „Desktop-App", Consent-Screen Extern im Testmodus mit deinem Konto als Testnutzer, Scope drive.file; Redirect http://localhost:9109/ruecklauf',
	adresse: async (kundenId, herausforderung, zustand) =>
		gdriveAdresse(
			{
				kundenId,
				weiterleitung: `http://localhost:${GDRIVE.port}/ruecklauf`,
				kundenGeheimnis: process.env.ABLAGE_INT_GDRIVE_GEHEIMNIS,
			},
			{ pruefer: '', herausforderung },
			zustand,
		),
	tauschen: (kundenId, code, pruefer) =>
		gdriveTausch(
			{
				kundenId,
				weiterleitung: `http://localhost:${GDRIVE.port}/ruecklauf`,
				kundenGeheimnis: process.env.ABLAGE_INT_GDRIVE_GEHEIMNIS,
			},
			code,
			{ pruefer, herausforderung: '' },
		),
	nachspielen: (kundenId, nachspieleToken) =>
		gdriveNachspiel(
			{
				kundenId,
				weiterleitung: `http://localhost:${GDRIVE.port}/ruecklauf`,
				kundenGeheimnis: process.env.ABLAGE_INT_GDRIVE_GEHEIMNIS,
			},
			nachspieleToken,
		),
	adapter: async (zugangsToken, lauf) => gdriveAdapter({ zugangsToken, ordner: `Pulse/int-${lauf}/kanal` }),
};

const STECKER: Record<string, AnbieterStecker> = {
	dropbox: DROPBOX,
	onedrive: ONEDRIVE,
	gdrive: GDRIVE,
};

const WEITERLEITUNG_DROPBOX = `http://localhost:${DROPBOX.port}/ruecklauf`;

function leseNachspielToken(datei: string): string | null {
	try {
		const roh = JSON.parse(readFileSync(datei, 'utf8')) as { nachspieleToken?: string };
		return roh.nachspieleToken ?? null;
	} catch {
		return null;
	}
}

function speichereNachspiel(datei: string, zugang: Zugang): void {
	if (zugang.nachspieleToken === undefined) {
		return;
	}
	mkdirSync(join(process.cwd(), '.ablage-int'), { recursive: true });
	writeFileSync(datei, JSON.stringify({ nachspieleToken: zugang.nachspieleToken }), { mode: 0o600 });
	try {
		chmodSync(datei, 0o600);
	} catch {
		// chmod ist auf manchen Dateisystemen ohne Wirkung — der mode oben trägt.
	}
}

/** Fängt den Redirect ab und liefert den Code; state wird gegen CSRF geprüft. */
function fangeCode(port: number, erwartetState: string): Promise<string> {
	return new Promise((aufloesen, abbrechen) => {
		const server = createServer((anfrage, antwort) => {
			const adresse = new URL(anfrage.url ?? '/', `http://localhost:${port}`);
			if (adresse.pathname !== '/ruecklauf') {
				antwort.writeHead(404);
				antwort.end();
				return;
			}
			const fehler = adresse.searchParams.get('error');
			if (fehler !== null) {
				antwort.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
				antwort.end(`Zugang verweigert: ${fehler}. Dieses Fenster kann zu.`);
				server.close();
				abbrechen(new Error(`Anbieter lehnte ab: ${fehler} — ${adresse.searchParams.get('error_description') ?? ''}`));
				return;
			}
			if (adresse.searchParams.get('state') !== erwartetState) {
				antwort.writeHead(400);
				antwort.end('state stimmt nicht — abgebrochen.');
				server.close();
				abbrechen(new Error('state-Prüfung fehlgeschlagen (CSRF-Schutz)'));
				return;
			}
			antwort.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			antwort.end('<p>Läuft — dieses Fenster kann geschlossen werden.</p>');
			server.close();
			aufloesen(adresse.searchParams.get('code') ?? '');
		});
		server.on('error', abbrechen);
		server.listen(port, '127.0.0.1');
		setTimeout(() => {
			server.close();
			abbrechen(new Error('Zeit abgelaufen — es kam kein Redirect auf den Loopback'));
		}, 5 * 60 * 1000).unref();
	});
}

async function zugangHolen(stecker: AnbieterStecker, kundenId: string, tokenDatei: string): Promise<Zugang> {
	const nachspiel = leseNachspielToken(tokenDatei);
	if (nachspiel !== null) {
		try {
			const zugang = await stecker.nachspielen(kundenId, nachspiel);
			console.log('  ✔ Zugang über Nachspiel-Token aufgefrischt (Refresh-Weg geprüft)');
			speichereNachspiel(tokenDatei, zugang);
			return zugang;
		} catch (fehler) {
			console.log(`  • Nachspiel-Token verworfen (${fehler instanceof Error ? fehler.message : fehler}) — neuer Autorisierungslauf`);
		}
	}

	const { pruefer, herausforderung } = await erzeugePkce();
	const zustand = `ablage-${Date.now()}`;
	const adresse = await stecker.adresse(kundenId, herausforderung, zustand);
	console.log('\nBrowser öffnet die Zustimmungs-Seite — falls nicht, diese Adresse manuell öffnen:\n');
	console.log(adresse);
	console.log();
	try {
		spawn('xdg-open', [adresse], { detached: true, stdio: 'ignore' }).unref();
	} catch {
		// Kein xdg-open — die Adresse steht oben, kopieren genügt.
	}

	const code = await fangeCode(stecker.port, zustand);
	const zugang = await stecker.tauschen(kundenId, code, pruefer);
	console.log('  ✔ Code-Tausch geglückt (PKCE ohne client_secret)');
	console.log(`  ✔ Nachspiel-Token ${zugang.nachspieleToken === undefined ? 'FEHLT — offline_access/ token_access_type prüfen' : 'vorhanden, für den nächsten Lauf gesichert (Datei, nicht Ausgabe)'}`);
	speichereNachspiel(tokenDatei, zugang);
	return zugang;
}

const anbieterName = process.argv[2] ?? '';
const stecker = STECKER[anbieterName];
if (stecker === undefined) {
	console.error(`Anbieter fehlt oder unbekannt — einer von: ${Object.keys(STECKER).join(', ')}`);
	process.exit(2);
}
const kundenId = process.env[stecker.kundenIdEnv];
if (!kundenId) {
	console.error(`${stecker.kundenIdEnv} fehlt — die Client-ID der App-Registrierung setzen.`);
	process.exit(2);
}

const geschirr = new AblageGeschirr();
try {
	const zugang = await zugangHolen(stecker, kundenId, join(process.cwd(), '.ablage-int', stecker.tokenDatei));
	const lauf = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
	const adapter = await stecker.adapter(zugang.zugangsToken, lauf);
	await geschirr.rundeAuf(`${anbieterName}: Schreiber/Leser/Nachzug`, adapter, lauf);
} catch (fehler) {
	geschirr.pruefe('Durchlauf ohne Katastrophe', false, fehler instanceof Error ? fehler.message : String(fehler));
}
const rot = geschirr.fehler();
console.log(rot === 0 ? `\n${anbieterName.toUpperCase()}-INTEGRATION GRÜN` : `\n${rot} PRÜFUNGEN ROT`);
process.exit(rot === 0 ? 0 : 1);
