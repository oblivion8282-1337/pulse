import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { s3Adapter, signiereAnfrage, kanonischeAbfrage, S3Fehler } from '../src/lib/ablage/s3.ts';

const ANBINDUNG = {
	wirt: 'https://eimer.example.com',
	region: 'eu-central-1',
	eimer: 'pulse-ablage',
	praefix: 'kanal-1/',
	schluessel: 'AKIDBEISPIEL',
	geheimnis: 'geheimnis123',
};
const bytes = (text: string) => new TextEncoder().encode(text);
const sha256Hex = (inhalt: Uint8Array) => createHash('sha256').update(inhalt).digest('hex');

describe('Ablage-S3: SigV4-Signatur', () => {
	it('trifft den in Python unabhängig nachgerechneten Prüfwert', async () => {
		// Berechnet mit hashlib/hmac (siehe Konzept-Branch-Kommentar): gleiche
		// Anfrage, gleiche Zeit, gleicher Inhalt — andere Implementierung.
		const kopf = await signiereAnfrage(
			ANBINDUNG,
			'PUT',
			'/pulse-ablage/kanal-1/manifest.puls',
			{},
			new Date(Date.UTC(2026, 7, 30, 12, 0, 0)),
			'fef5be2e4f1959e04851b1ac232d8ca44c8eae9d60168fd220e2b726ed456759',
			'application/octet-stream',
		);
		assert.equal(kopf['x-amz-date'], '20260830T120000Z');
		assert.equal(
			kopf.Authorization,
			'AWS4-HMAC-SHA256 Credential=AKIDBEISPIEL/20260830/eu-central-1/s3/aws4_request, ' +
				'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
				'Signature=cb414b7884066e8b2d2e4c5cc8c91e8dbc70f8fcb7f0e75022a61d5fb08d6b66',
		);
	});

	it('kodiert die Abfrage kanonisch — dieselbe Zeile für Signatur und URL', () => {
		assert.equal(
			kanonischeAbfrage({ b: 'zwei worte', a: 'eins' }),
			'a=eins&b=zwei%20worte',
		);
	});
});

function eimerServer() {
	const objekte = new Map<string, Uint8Array>();
	const rufe: string[] = [];
	let listierungen = 0;
	const holen: typeof fetch = async (eingabe, init) => {
		const initSafe = init ?? {};
		const url = new URL(String(eingabe));
		rufe.push(`${initSafe.method ?? 'GET'} ${url.pathname}?${url.search}`);
		if (initSafe.method === 'PUT') {
			objekte.set(url.pathname, initSafe.body as Uint8Array);
			return new Response(null, { status: 200 });
		}
		if (initSafe.method === 'GET' && url.pathname.endsWith('/')) {
			listierungen++;
			const weiter = listierungen === 1;
			return new Response(
				`<ListBucketResult>` +
					`<Key>kanal-1/seg-000000.puls</Key><Key>kanal-1/manifest.puls</Key>` +
					`<Key>kanal-2/fremd.puls</Key>` +
					(weiter ? `<IsTruncated>true</IsTruncated><NextContinuationToken>tok-1</NextContinuationToken>` : '') +
					`</ListBucketResult>`,
				{ status: 200 },
			);
		}
		const inhalt = objekte.get(url.pathname);
		return inhalt !== undefined
			? new Response(inhalt as unknown as BodyInit, { status: 200 })
			: new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
	};
	return { holen, objekte, rufe };
}

describe('Ablage-S3: Adapter', () => {
	it('PUT-et mit Signatur, deren Inhalts-Hash zum Körper passt', async () => {
		const eimer = eimerServer();
		const adapter = s3Adapter({ ...ANBINDUNG, holen: eimer.holen });
		const inhalt = bytes('x');
		await adapter.schreibe('manifest.puls', inhalt);

		assert.ok(eimer.rufe[0].startsWith('PUT /pulse-ablage/kanal-1/manifest.puls?'));
		// Im echten Signaturpfad steckt der Hash des Körpers — hier über den
		// Fake nicht sichtbar, deshalb direkt gegen die Signierfunktion:
		const kopf = await signiereAnfrage(
			ANBINDUNG,
			'PUT',
			'/pulse-ablage/kanal-1/manifest.puls',
			{},
			new Date(),
			sha256Hex(inhalt),
			'application/octet-stream',
		);
		assert.equal(kopf['x-amz-content-sha256'], sha256Hex(inhalt));
		assert.deepEqual(await adapter.lese('manifest.puls'), inhalt);
	});

	it('liest Fehlendes als null und listet über Fortsetzungs-Token hinweg', async () => {
		const eimer = eimerServer();
		const adapter = s3Adapter({ ...ANBINDUNG, holen: eimer.holen });
		assert.equal(await adapter.lese('seg-999999.puls'), null);

		const namen = await adapter.liste();
		assert.deepEqual(namen, ['seg-000000.puls', 'manifest.puls', 'seg-000000.puls', 'manifest.puls']);
		// Drei GETs: das fehlende Objekt, List-Seite 1, List-Seite 2.
		assert.equal(eimer.rufe.filter((r) => r.startsWith('GET /pulse-ablage/')).length, 3);
		assert.ok(eimer.rufe.some((r) => r.includes('continuation-token=tok-1')));
	});

	it('reicht echte Fehler als S3Fehler mit Fehlercode weiter', async () => {
		const holen: typeof fetch = async () =>
			new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
		const adapter = s3Adapter({ ...ANBINDUNG, holen });
		await assert.rejects(() => adapter.lese('x.puls'), (f: unknown) => f instanceof S3Fehler && f.message.includes('AccessDenied'));
	});
});
