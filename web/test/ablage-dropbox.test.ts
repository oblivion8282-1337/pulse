import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	DropboxFehler,
	auffrischeZugang,
	autorisierungsAdresse,
	dropboxAdapter,
	tauscheCodeAus,
	type DropboxAnbindung,
} from '../src/lib/ablage/dropbox.ts';

const ANBINDUNG: DropboxAnbindung = { kundenId: 'k-dropbox-1', holen: async () => new Response('{}') };
const bytes = (text: string) => new TextEncoder().encode(text);

describe('Ablage-Dropbox: OAuth', () => {
	it('baut die Autorisierungs-Adresse mit offline-Nachspiel und PKCE', () => {
		const url = autorisierungsAdresse(ANBINDUNG, { pruefer: 'p'.repeat(43), herausforderung: 'h-1' }, 'zustand-9');
		const urlObjekt = new URL(url);
		assert.equal(urlObjekt.origin + urlObjekt.pathname, 'https://www.dropbox.com/oauth2/authorize');
		assert.equal(urlObjekt.searchParams.get('token_access_type'), 'offline');
		assert.equal(urlObjekt.searchParams.get('code_challenge_method'), 'S256');
		assert.equal(urlObjekt.searchParams.get('client_id'), 'k-dropbox-1');
		assert.equal(urlObjekt.searchParams.get('state'), 'zustand-9');
	});

	it('tauscht den Code ohne client_secret aus und spielt nach', async () => {
		const gefangen: string[] = [];
		const anbindung: DropboxAnbindung = {
			kundenId: 'k-dropbox-1',
			holen: async (eingabe, init) => {
				gefangen.push(String(eingabe) + ' ' + String(init?.body));
				return new Response(JSON.stringify({ access_token: 'z', refresh_token: 'n' }), {
					headers: { 'Content-Type': 'application/json' },
				});
			},
		};
		const zugang = await tauscheCodeAus(anbindung, 'der-code', {
			pruefer: 'der-pruefer',
			herausforderung: 'h',
		});
		assert.equal(zugang.nachspieleToken, 'n');
		assert.ok(gefangen[0].includes('oauth2/token'));
		assert.ok(gefangen[0].includes('code_verifier=der-pruefer'));
		assert.ok(!gefangen[0].includes('client_secret'));
		assert.ok((await auffrischeZugang(anbindung, 'n')).zugangsToken === 'z');
		assert.ok(gefangen[1].includes('grant_type=refresh_token'));
	});
});

function server() {
	const dateien = new Map<string, Uint8Array>();
	const rufe: string[] = [];
	const holen: typeof fetch = async (eingabe, init) => {
		const url = String(eingabe);
		const initSafe = init ?? {};
		const kopf = (initSafe.headers ?? {}) as Record<string, string>;
		rufe.push(`${initSafe.method ?? 'GET'} ${url} ${kopf['Dropbox-API-Arg'] ?? ''}`);
		if (url.endsWith('/files/upload')) {
			const arg = JSON.parse(kopf['Dropbox-API-Arg']) as { path: string };
			dateien.set(arg.path, initSafe.body as Uint8Array);
			return new Response(JSON.stringify({ name: arg.path }), { status: 200 });
		}
		if (url.endsWith('/files/download')) {
			const arg = JSON.parse(kopf['Dropbox-API-Arg']) as { path: string };
			const inhalt = dateien.get(arg.path);
			return inhalt !== undefined
				? new Response(inhalt as unknown as BodyInit, { status: 200 })
				: new Response(JSON.stringify({ error_summary: 'path/not_found/.' }), { status: 409 });
		}
		if (url.endsWith('/list_folder')) {
			return new Response(
				JSON.stringify({
					entries: [
						{ '.tag': 'file', name: 'seg-000000.puls' },
						{ '.tag': 'folder', name: 'unter' },
					],
					has_more: true,
					cursor: 'c-1',
				}),
				{ status: 200 },
			);
		}
		if (url.endsWith('/list_folder/continue')) {
			return new Response(
				JSON.stringify({ entries: [{ '.tag': 'file', name: 'manifest.puls' }], has_more: false, cursor: '' }),
				{ status: 200 },
			);
		}
		return new Response('unbekannt', { status: 404 });
	};
	return { holen, dateien, rufe };
}

describe('Ablage-Dropbox: Adapter', () => {
	it('lädt mit Dropbox-API-Arg und Overwrite hoch, Pfad liegt im App-Ordner', async () => {
		const box = server();
		const adapter = dropboxAdapter({ zugangsToken: 't-1', ordner: 'Pulse/ablage/kanal-1', holen: box.holen });
		await adapter.schreibe('manifest.puls', bytes('x'));
		assert.ok(box.rufe[0].includes('/2/files/upload'));
		assert.ok(
			box.rufe[0].includes('"path":"/Pulse/ablage/kanal-1/manifest.puls"') &&
				box.rufe[0].includes('"mode":"overwrite"'),
		);
		assert.deepEqual(await adapter.lese('manifest.puls'), bytes('x'));
	});

	it('liest fehlende Dateien als null — aus der not_found-Begründung im 409', async () => {
		const box = server();
		const adapter = dropboxAdapter({ zugangsToken: 't-1', ordner: 'k', holen: box.holen });
		assert.equal(await adapter.lese('seg-000000.puls'), null);
	});

	it('folgt list_folder/continue bis zum Ende und lässt Ordner weg', async () => {
		const box = server();
		const adapter = dropboxAdapter({ zugangsToken: 't-1', ordner: 'k', holen: box.holen });
		assert.deepEqual(await adapter.liste(), ['seg-000000.puls', 'manifest.puls']);
	});

	it('nimmt fehlende Ordner beim Auflisten als leer — Dropbox antwortet 409 statt 404', async () => {
		const holen: typeof fetch = async () =>
			new Response(JSON.stringify({ error_summary: 'path/not_found/.' }), { status: 409 });
		const adapter = dropboxAdapter({ zugangsToken: 't-1', ordner: 'k', holen });
		assert.deepEqual(await adapter.liste(), []);
	});

	it('reicht echte 409-Fehler als DropboxFehler weiter, nicht als „fehlt“', async () => {
		const holen: typeof fetch = async () =>
			new Response(JSON.stringify({ error_summary: 'path/lookup/insufficient_permissions/.' }), { status: 409 });
		const adapter = dropboxAdapter({ zugangsToken: 't-1', ordner: 'k', holen });
		await assert.rejects(() => adapter.lese('x.puls'), DropboxFehler);
	});
});
