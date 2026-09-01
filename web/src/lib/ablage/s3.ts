/**
 * S3-Adapter (path-style, SigV4) — Position B aus der Analyse: ein
 * dedizierter Bucket des Owners (Hetzner, Wasabi, MinIO, eigener S3), nicht
 * das persönliche Konto. Kein OAuth — Zutrittspaar des Buckets, das
 * ausschließlich beim Klienten liegt. Der Bucket ist ersetzbar: ein
 * Missbrauchsfall kostet den Eimer, nicht Mail/Fotos/Identität.
 *
 * Signatur nach AWS SigV4, selbst gerechnet über WebCrypto. Die Test-Fassung
 * der Signatur wurde unabhängig davon in Python nachgerechnet und als
 * Prüfwert festgehalten — siehe ablage-s3.test.ts.
 */

import type { AblageAdapter } from './adapter.ts';
import { bytesZuHex } from './hex.ts';
import { sha256Hex } from './pruefsumme.ts';

export interface S3Anbindung {
	/** Basisadresse ohne Eimer, z. B. https://fsn1.your-objectstorage.com */
	wirt: string;
	region: string;
	eimer: string;
	/** Ablage-Ordner im Eimer mit schließendem Schrägen, z. B. pulse/ablage/kanal-1/ */
	praefix: string;
	schluessel: string;
	geheimnis: string;
	holen?: typeof fetch;
}

export class S3Fehler extends Error {
	constructor(meldung: string) {
		super(meldung);
		this.name = 'S3Fehler';
	}
}

const LEER_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function hmac(schluessel: Uint8Array, text: string): Promise<Uint8Array<ArrayBuffer>> {
	const krypto = globalThis.crypto.subtle;
	const schluesselRef = await krypto.importKey(
		'raw',
		schluessel as unknown as ArrayBuffer,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return new Uint8Array(await krypto.sign('HMAC', schluesselRef, new TextEncoder().encode(text)));
}

/** URI-Kodierung nach SigV4: strenger als encodeURIComponent, / bleibt. */
function uriKodieren(text: string): string {
	return encodeURIComponent(text).replace(
		/[!'()*]/g,
		(z) => `%${z.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function amzZeit(zeit: Date): { komplett: string; tag: string } {
	const stueck = (zahl: number, laenge: number) => String(zahl).padStart(laenge, '0');
	const komplett =
		`${stueck(zeit.getUTCFullYear(), 4)}${stueck(zeit.getUTCMonth() + 1, 2)}${stueck(zeit.getUTCDate(), 2)}` +
		`T${stueck(zeit.getUTCHours(), 2)}${stueck(zeit.getUTCMinutes(), 2)}${stueck(zeit.getUTCSeconds(), 2)}Z`;
	return { komplett, tag: komplett.slice(0, 8) };
}

/** Kanonische Abfrage-Zeile — dieselbe Kodierung für Signatur und URL. */
export function kanonischeAbfrage(abfrage: Record<string, string>): string {
	return Object.keys(abfrage)
		.sort()
		.map((n) => `${uriKodieren(n)}=${uriKodieren(abfrage[n])}`)
		.join('&');
}

/**
 * Baut die SigV4-Kopfzeilen für eine Anfrage. Kopfzeilen-Fassung bewusst
 * minimal und deterministisch: host, x-amz-content-sha256, x-amz-date — und
 * content-type nur, wenn wirklich ein Körper mitfährt.
 */
export async function signiereAnfrage(
	anbindung: { wirt: string; region: string; schluessel: string; geheimnis: string },
	methode: string,
	pfad: string,
	abfrage: Record<string, string>,
	zeit: Date,
	inhaltHex: string,
	inhaltTyp: string | null,
): Promise<Record<string, string>> {
	const wirt = new URL(anbindung.wirt).host;
	const { komplett, tag } = amzZeit(zeit);

	const kopf: Record<string, string> = {
		host: wirt,
		'x-amz-content-sha256': inhaltHex,
		'x-amz-date': komplett,
		...(inhaltTyp !== null ? { 'content-type': inhaltTyp } : {}),
	};
	const signierte = Object.keys(kopf).sort();
	const kopfZeilen = signierte.map((n) => `${n}:${kopf[n].trim()}\n`).join('');

	const kanonisch = [
		methode,
		pfad.split('/').map(uriKodieren).join('/'),
		kanonischeAbfrage(abfrage),
		kopfZeilen,
		signierte.join(';'),
		inhaltHex,
	].join('\n');

	const kanonischHex = await sha256Hex(new TextEncoder().encode(kanonisch));
	const nachzuSignieren = [
		'AWS4-HMAC-SHA256',
		komplett,
		`${tag}/${anbindung.region}/s3/aws4_request`,
		kanonischHex,
	].join('\n');

	let kette = new TextEncoder().encode(`AWS4${anbindung.geheimnis}`);
	for (const stufe of [tag, anbindung.region, 's3', 'aws4_request', nachzuSignieren]) {
		kette = await hmac(kette, stufe);
	}
	const signatur = bytesZuHex(kette);

	return {
		...kopf,
		Authorization:
			`AWS4-HMAC-SHA256 Credential=${anbindung.schluessel}/${tag}/${anbindung.region}/s3/aws4_request, ` +
			`SignedHeaders=${signierte.join(';')}, Signature=${signatur}`,
	};
}

async function s3Fehler(antwort: Response, was: string): Promise<S3Fehler> {
	const text = await antwort.text().catch(() => '');
	const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
	return new S3Fehler(`${was} scheiterte: HTTP ${antwort.status}${code ? ` (${code})` : ''}`);
}

export function s3Adapter(anbindung: S3Anbindung): AblageAdapter {
	const holen = anbindung.holen ?? fetch;
	const basis = anbindung.wirt.replace(/\/+$/, '');
	const praefix = anbindung.praefix.replace(/[^/]$/, '$&/').replace(/^\/+/, '');

	return {
		async schreibe(datei, inhalt) {
			const pfad = `/${anbindung.eimer}/${praefix}${datei}`;
			const kopf = await signiereAnfrage(
				anbindung,
				'PUT',
				pfad,
				{},
				new Date(),
				await sha256Hex(inhalt),
				'application/octet-stream',
			);
			const antwort = await holen(basis + pfad, {
				method: 'PUT',
				headers: kopf,
				body: inhalt as unknown as BodyInit,
			});
			if (!antwort.ok) {
				throw await s3Fehler(antwort, `PUT ${datei}`);
			}
		},

		async lese(datei) {
			const pfad = `/${anbindung.eimer}/${praefix}${datei}`;
			const kopf = await signiereAnfrage(
				anbindung,
				'GET',
				pfad,
				{},
				new Date(),
				LEER_SHA,
				null,
			);
			const antwort = await holen(basis + pfad, { method: 'GET', headers: kopf });
			if (antwort.status === 404) {
				return null;
			}
			if (!antwort.ok) {
				throw await s3Fehler(antwort, `GET ${datei}`);
			}
			return new Uint8Array(await antwort.arrayBuffer());
		},

		async liste() {
			const namen: string[] = [];
			let weiterToken: string | undefined;
			do {
				const pfad = `/${anbindung.eimer}/`;
				const abfrage: Record<string, string> = {
					'list-type': '2',
					prefix: praefix,
					'max-keys': '1000',
					...(weiterToken !== undefined ? { 'continuation-token': weiterToken } : {}),
				};
				const kopf = await signiereAnfrage(anbindung, 'GET', pfad, abfrage, new Date(), LEER_SHA, null);
				const abfrageZeile = kanonischeAbfrage(abfrage);
				const antwort = await holen(`${basis}${pfad}?${abfrageZeile}`, {
					method: 'GET',
					headers: kopf,
				});
				if (!antwort.ok) {
					throw await s3Fehler(antwort, 'LIST');
				}
				const xml = await antwort.text();
				for (const treffer of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
					const schluesselName = treffer[1]
						.replaceAll('&amp;', '&')
						.replaceAll('&lt;', '<')
						.replaceAll('&gt;', '>');
					if (schluesselName.startsWith(praefix)) {
						namen.push(schluesselName.slice(praefix.length));
					}
				}
				weiterToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
			} while (weiterToken !== undefined);
			return namen;
		},
	};
}
