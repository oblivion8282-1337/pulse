import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	OnedriveFehler,
	autorisierungsAdresse,
	onedriveAdapter,
	type OnedriveAnbindung,
} from '../src/lib/ablage/onedrive.ts';

const ANBINDUNG: OnedriveAnbindung = {
	kundenId: 'k-ms-1',
	weiterleitung: 'http://localhost:7777/ruecklauf',
	holen: async () => new Response('{}'),
};
const bytes = (text: string) => new TextEncoder().encode(text);

describe('Ablage-OneDrive: OAuth', () => {
	it('fragt AppFolder-Scope mit offline_access und PKCE an', () => {
		const url = new URL(
			autorisierungsAdresse(ANBINDUNG, { pruefer: 'p', herausforderung: 'h-1' }, 'z-1'),
		);
		assert.equal(
			url.origin + url.pathname,
			'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
		);
		assert.equal(url.searchParams.get('scope'), 'Files.ReadWrite.AppFolder offline_access');
		assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:7777/ruecklauf');
	});
});

function server(ordnerDa = true) {
	const dateien = new Map<string, Uint8Array>();
	const ordner = new Set<string>(ordnerDa ? ['/drive/special/approot:/Pulse/ablage/kanal-1'] : []);
	const rufe: string[] = [];
	const holen: typeof fetch = async (eingabe, init) => {
		const initSafe = init ?? {};
		const url = String(eingabe);
		const methode = initSafe.method ?? 'GET';
		const pfad = new URL(url).pathname;
		rufe.push(`${methode} ${url}`);
		if (methode === 'PUT') {
			const basisPfad = pfad.replace(/:\/content$/, '');
			const eltern = basisPfad.slice(0, basisPfad.lastIndexOf('/'));
			if (!ordner.has(eltern)) {
				return new Response(JSON.stringify({ error: { message: 'Elternordner fehlt' } }), { status: 404 });
			}
			dateien.set(basisPfad, initSafe.body as Uint8Array);
			return new Response('{"id":"x"}', { status: 201 });
		}
		if (methode === 'POST') {
			const daten = JSON.parse(String(initSafe.body)) as { name: string };
			// Der Doppelpfad endet vor /children auf einem hängenden Doppelpunkt.
			const elternPfad = decodeURIComponent(new URL(url).pathname).replace(/:?\/children$/, '');
			//approot selbst trägt den Doppelpfad erst bei den Kindern.
			const neuerPfad = elternPfad.endsWith('/approot')
				? `${elternPfad}:/${daten.name}`
				: `${elternPfad}/${daten.name}`;
			ordner.add(neuerPfad);
			return new Response('{"id":"neu"}', { status: 201 });
		}
		if (methode === 'GET') {
			if (pfad.endsWith('/naechste-seite')) {
				return new Response(JSON.stringify({ value: [{ name: 'seg-000001.puls' }] }), { status: 200 });
			}
			if (pfad.endsWith('/children')) {
				return new Response(
					JSON.stringify({
						value: [
							{ name: 'seg-000000.puls' },
							{ name: 'unter', folder: {} },
						],
						'@odata.nextLink': 'https://graph.microsoft.com/v1.0/naechste-seite',
					}),
					{ status: 200 },
				);
			}
			const inhalt = dateien.get(pfad.replace(/:\/content$/, ''));
			if (inhalt !== undefined) {
				return new Response(inhalt as unknown as BodyInit, { status: 200 });
			}
			if (ordner.has(pfad)) {
				return new Response('{"folder":{}}', { status: 200 });
			}
			return new Response(JSON.stringify({ error: { message: 'nicht gefunden' } }), { status: 404 });
		}
		return new Response('unbekannt', { status: 405 });
	};
	return { holen, dateien, ordner, rufe };
}

describe('Ablage-OneDrive: Adapter', () => {
	it('legt die Ordnerkette an und lädt in den App-Ordner hoch', async () => {
		const ms = server(false);
		const adapter = onedriveAdapter({
			zugangsToken: 't-1',
			ordner: 'Pulse/ablage/kanal-1',
			holen: ms.holen,
		});
		await adapter.schreibe('manifest.puls', bytes('x'));
		assert.ok(ms.rufe.some((r) => r === 'GET https://graph.microsoft.com/v1.0/drive/special/approot:/Pulse'));
		assert.ok(ms.rufe.includes('POST https://graph.microsoft.com/v1.0/drive/special/approot/children'));
		assert.ok(
			ms.rufe.includes(
				'PUT https://graph.microsoft.com/v1.0/drive/special/approot:/Pulse/ablage/kanal-1/manifest.puls:/content',
			),
		);
		assert.deepEqual(await adapter.lese('manifest.puls'), bytes('x'));
	});

	it('liest fehlende Dateien als null und folgt der nächsten Seite beim Listen', async () => {
		const ms = server();
		const adapter = onedriveAdapter({
			zugangsToken: 't-1',
			ordner: 'Pulse/ablage/kanal-1',
			holen: ms.holen,
		});
		assert.equal(await adapter.lese('seg-999999.puls'), null);
		assert.deepEqual(await adapter.liste(), ['seg-000000.puls', 'seg-000001.puls']);
	});

	it('weist Übergrößen mit Begründung ab, bevor eine Anfrage losgeht', async () => {
		const ms = server();
		const adapter = onedriveAdapter({
			zugangsToken: 't-1',
			ordner: 'k',
			holen: ms.holen,
		});
		await assert.rejects(
			() => adapter.schreibe('gross.puls', new Uint8Array(4 * 1024 * 1024 + 1)),
			OnedriveFehler,
		);
		assert.equal(ms.rufe.length, 0);
	});
});
