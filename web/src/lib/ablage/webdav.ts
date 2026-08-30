/**
 * WebDAV-Adapter — der Weg zu Nextcloud und jedem anderen DAV-Server.
 * Zugangsdaten (Nextcloud: App-Passwort) leben ausschließlich beim Klienten;
 * die Pulse Cloud sieht sie nie (Konzept §1, Wand 3).
 *
 * Ehrlich zur CORS-Realität: ein Browser unter fremder Origin bekommt von
 * Nextcloud keine CORS-Header (nextcloud/server#3131). Dieser Adapter ist
 * deshalb für die Wege gebaut, auf denen keine fremde Origin mitspielt —
 * die Desktop-App (Main-Prozess) und den Nextcloud-Owner, der seinem DAV
 * eigene CORS-Header verpasst. Für Tests ist der Transport injizierbar;
 * ein echter Server wird hier nicht gemockt, sondern ersetzt.
 */

import type { AblageAdapter } from './adapter.ts';

export interface WebdavAnbindung {
	/** DAV-Wurzel des Benutzers, z. B. https://cloud.example/remote.php/dav/files/lena */
	basis: string;
	/** Ablage-Ordner unter der Wurzel, z. B. Pulse/ablage/kanal-123 */
	ordner: string;
	benutzer: string;
	passwort: string;
	/** Transport — Standard echtes fetch, für Tests ersetzt. */
	holen?: typeof fetch;
}

export class WebdavFehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'WebdavFehler';
	}
}

const DAV_MIME = 'application/xml';

function basis64(text: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** Fügt Basis, Ordner und Dateiname zu einer DAV-URL zusammen — kodiert werden nur die Pfadsegmente. */
export function urlFuer(anbindung: { basis: string; ordner: string }, datei?: string): string {
	const basis = anbindung.basis.replace(/\/+$/, '');
	const stufen = anbindung.ordner
		.split('/')
		.filter((teil) => teil !== '')
		.map((teil) => encodeURIComponent(teil));
	if (datei !== undefined) {
		stufen.push(encodeURIComponent(datei));
	}
	return stufen.length === 0 ? basis : `${basis}/${stufen.join('/')}`;
}

/**
 * Legt den Ablage-Ordner an, Stufe für Stufe. 405 heißt „gibt es schon" und
 * ist keine Nachricht wert — DAV hat kein idempotentes MKCOL.
 */
async function sichereOrdner(anbindung: WebdavAnbindung): Promise<void> {
	const holen = anbindung.holen ?? fetch;
	const stufen = anbindung.ordner.split('/').filter((s) => s !== '');
	let bisher = anbindung.basis.replace(/\/+$/, '');
	for (const stufe of stufen) {
		bisher += '/' + encodeURIComponent(stufe);
		const antwort = await holen(bisher + '/', {
			method: 'MKCOL',
			headers: authKopf(anbindung),
		});
		if (!antwort.ok && antwort.status !== 405) {
			throw new WebdavFehler(`MKCOL ${bisher} scheiterte: ${antwort.status}`);
		}
	}
}

function authKopf(anbindung: WebdavAnbindung): Record<string, string> {
	return { Authorization: `Basic ${basis64(`${anbindung.benutzer}:${anbindung.passwort}`)}` };
}

/**
 * Liest die Dateinamen aus einer DAV-Multistatus-Antwort (Depth 1): der
 * erste Eintrag ist der Ordner selbst, Einträge mit trailing slash sind
 * Unterordner — beide fliegen raus. Hrefs kommen prozentkodiert und mit
 * wechselnden Namensraum-Präfixen (d:, D:, keiner) — beides egal.
 */
export function namenAusMultistatus(xml: string): string[] {
	const namen: string[] = [];
	const antworten: string[] = [];
	const block = /<(?:[dD]:)?response\b[\s\S]*?<\/(?:[dD]:)?response>/g;
	let treffer: RegExpExecArray | null;
	while ((treffer = block.exec(xml)) !== null) {
		antworten.push(treffer[0]);
	}
	for (const eintrag of antworten) {
		const href = /<(?:[dD]:)?href[^>]*>([\s\S]*?)<\/(?:[dD]:)?href>/.exec(eintrag)?.[1];
		if (href === undefined) {
			continue;
		}
		const pfad = decodeURIComponent(href);
		if (pfad.endsWith('/')) {
			continue;
		}
		namen.push(pfad.split('/').pop()!);
	}
	return namen;
}

export function webdavAdapter(anbindung: WebdavAnbindung): AblageAdapter {
	const holen = anbindung.holen ?? fetch;
	let ordnerGesichert: Promise<void> | null = null;
	const ordnerSichern = (): Promise<void> =>
		(ordnerGesichert ??= sichereOrdner(anbindung));

	return {
		async schreibe(datei, inhalt) {
			await ordnerSichern();
			const url = urlFuer(anbindung, datei);
			// DOM-BodyInit verlangt ArrayBufferView<ArrayBuffer>, die Adapter-
			// Schnittstelle trägt Uint8Array<ArrayBufferLike> — der Cast ist
			// zur Laufzeit wirkungslos.
			const daten = inhalt as unknown as BodyInit;
			let antwort = await holen(url, {
				method: 'PUT',
				headers: authKopf(anbindung),
				body: daten,
			});
			if (antwort.status === 409) {
				// Ordner fehlt am Server (frisch geleert, anderer Sync-Stand) —
				// einmal neu sichern und noch einmal versuchen.
				ordnerGesichert = null;
				await ordnerSichern();
				antwort = await holen(url, {
					method: 'PUT',
					headers: authKopf(anbindung),
					body: daten,
				});
			}
			if (!antwort.ok) {
				throw new WebdavFehler(`PUT ${datei} scheiterte: ${antwort.status}`);
			}
		},

		async lese(datei) {
			const antwort = await holen(urlFuer(anbindung, datei), {
				method: 'GET',
				headers: authKopf(anbindung),
			});
			if (antwort.status === 404) {
				return null;
			}
			if (!antwort.ok) {
				throw new WebdavFehler(`GET ${datei} scheiterte: ${antwort.status}`);
			}
			return new Uint8Array(await antwort.arrayBuffer());
		},

		async liste() {
			const antwort = await holen(urlFuer(anbindung) + '/', {
				method: 'PROPFIND',
				headers: { ...authKopf(anbindung), Depth: '1', 'Content-Type': DAV_MIME },
				body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
			});
			if (antwort.status === 404) {
				return [];
			}
			if (!antwort.ok) {
				throw new WebdavFehler(`PROPFIND scheiterte: ${antwort.status}`);
			}
			return namenAusMultistatus(await antwort.text());
		},
	};
}
