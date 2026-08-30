import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	GdriveFehler,
	autorisierungsAdresse,
	gdriveAdapter,
	multipartErzeugen,
	type GdriveAnbindung,
} from '../src/lib/ablage/gdrive.ts';

const ANBINDUNG: GdriveAnbindung = {
	kundenId: 'k-g-1',
	weiterleitung: 'http://localhost:7777/ruecklauf',
	holen: async () => new Response('{}'),
};
const bytes = (text: string) => new TextEncoder().encode(text);

describe('Ablage-GDrive: OAuth und Multipart', () => {
	it('fragt den per-Datei-Scope offline-fähig an', () => {
		const url = new URL(autorisierungsAdresse(ANBINDUNG, { pruefer: 'p', herausforderung: 'h' }, 'z'));
		assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
		assert.equal(url.searchParams.get('access_type'), 'offline');
	});

	it('wickelt Metadaten und Inhalt in einen Multipart-Körper', () => {
		const { koerper, grenze } = multipartErzeugen({ name: 'manifest.puls', parents: ['o-1'] }, bytes('x'));
		const text = new TextDecoder().decode(koerper);
		assert.ok(text.startsWith(`--${grenze}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`));
		assert.ok(text.includes('{"name":"manifest.puls","parents":["o-1"]}'));
		assert.ok(text.endsWith(`\r\n--${grenze}--\r\n`));
	});
});

function drive() {
	let zaehler = 0;
	const dateien = new Map<string, { name: string; elternteil: string; ordner: boolean; inhalt: Uint8Array }>();
	const rufe: string[] = [];
	const holen: typeof fetch = async (eingabe, init) => {
		const initSafe = init ?? {};
		const url = new URL(String(eingabe));
		const methode = initSafe.method ?? 'GET';
		rufe.push(`${methode} ${url.pathname}${url.search}`);
		if (methode === 'GET' && url.pathname === '/drive/v3/files') {
			const q = url.searchParams.get('q') ?? '';
			const name = /name = '([^']+)'/.exec(q)?.[1];
			const elternteil = /'([^']+)' in parents/.exec(q)?.[1] ?? 'root';
			const nurOrdner = /mimeType = 'application\/vnd\.google-apps\.folder'/.test(q);
			const treffer = [...dateien.entries()]
				.filter(([, d]) => (name === undefined || d.name === name) && d.elternteil === elternteil && d.ordner === nurOrdner)
				.map(([id, d]) => ({ id, name: d.name }));
			return new Response(JSON.stringify({ files: treffer }), { status: 200 });
		}
		if (methode === 'POST' && url.pathname === '/drive/v3/files') {
			const metadaten = JSON.parse(String(initSafe.body)) as { name: string; parents?: string[]; mimeType: string };
			const id = `id-${++zaehler}`;
			dateien.set(id, {
				name: metadaten.name,
				elternteil: metadaten.parents?.[0] ?? 'root',
				ordner: metadaten.mimeType.includes('google-apps.folder'),
				inhalt: new Uint8Array(0),
			});
			return new Response(JSON.stringify({ id }), { status: 200 });
		}
		if (methode === 'POST' && url.pathname === '/upload/drive/v3/files') {
			const typ = (initSafe.headers as Record<string, string>)['Content-Type'];
			const grenze = /boundary=(.+)$/.exec(typ)![1];
			const text = Buffer.from(initSafe.body as Uint8Array).toString('latin1');
			const metadatenText = /Content-Type: application\/json; charset=UTF-8\r\n\r\n([\s\S]*?)\r\n--/.exec(text)![1];
			const metadaten = JSON.parse(metadatenText) as { name: string; parents: string[] };
			const kopfLaenge = text.indexOf(`Content-Type: application/octet-stream\r\n\r\n`) + 'Content-Type: application/octet-stream\r\n\r\n'.length;
			const schwanzLaenge = `\r\n--${grenze}--\r\n`.length;
			const inhalt = (initSafe.body as Uint8Array).slice(kopfLaenge, (initSafe.body as Uint8Array).length - schwanzLaenge);
			const id = `id-${++zaehler}`;
			dateien.set(id, { name: metadaten.name, elternteil: metadaten.parents[0], ordner: false, inhalt });
			return new Response(JSON.stringify({ id }), { status: 200 });
		}
		if (methode === 'PATCH' && url.pathname.startsWith('/upload/drive/v3/files/')) {
			const id = url.pathname.split('/').pop()!;
			dateien.get(id)!.inhalt = initSafe.body as Uint8Array;
			return new Response('{}', { status: 200 });
		}
		if (methode === 'GET' && url.pathname.startsWith('/drive/v3/files/') && url.searchParams.get('alt') === 'media') {
			const id = url.pathname.split('/').pop()!;
			const datei = dateien.get(id);
			return datei !== undefined
				? new Response(datei.inhalt as unknown as BodyInit, { status: 200 })
				: new Response('fehlt', { status: 404 });
		}
		return new Response('unbekannt', { status: 405 });
	};
	return { holen, dateien, rufe };
}

describe('Ablage-GDrive: Adapter', () => {
	it('baut die Ordnerkette, erzeugt neue Dateien als Multipart und updated bekannte per PATCH', async () => {
		const gd = drive();
		const adapter = gdriveAdapter({ zugangsToken: 't-1', ordner: 'Pulse/ablage/kanal-1', holen: gd.holen });

		await adapter.schreibe('manifest.puls', bytes('erste'));
		const ordnerErzeugt = [...gd.dateien.values()].filter((d) => d.ordner);
		assert.deepEqual(ordnerErzeugt.map((d) => d.name), ['Pulse', 'ablage', 'kanal-1']);
		const manifest = [...gd.dateien.values()].find((d) => d.name === 'manifest.puls')!;
		assert.deepEqual(manifest.inhalt, bytes('erste'));
		const ordnerNachName = new Map(
			[...gd.dateien.entries()].filter(([, d]) => d.ordner).map(([id, d]) => [d.name, id]),
		);
		assert.equal(manifest.elternteil, ordnerNachName.get('kanal-1'));

		await adapter.schreibe('manifest.puls', bytes('zweite'));
		assert.deepEqual(manifest.inhalt, bytes('zweite'));
		assert.ok(gd.rufe.some((r) => r.startsWith('PATCH /upload/drive/v3/files/')));
		assert.equal([...gd.dateien.values()].filter((d) => d.name === 'manifest.puls').length, 1);
	});

	it('liest über die Id, nennt Fehlendes null und listet nur Dateien', async () => {
		const gd = drive();
		const adapter = gdriveAdapter({ zugangsToken: 't-1', ordner: 'kanal-1', holen: gd.holen });
		assert.equal(await adapter.lese('manifest.puls'), null);
		await adapter.schreibe('manifest.puls', bytes('x'));
		await adapter.schreibe('seg-000000.puls', bytes('y'));
		assert.deepEqual(await adapter.lese('manifest.puls'), bytes('x'));
		assert.deepEqual(await adapter.liste(), ['manifest.puls', 'seg-000000.puls']);
	});

	it('wirft echte Fehler als GdriveFehler', async () => {
		const holen: typeof fetch = async () => new Response('kaputt', { status: 500 });
		const adapter = gdriveAdapter({ zugangsToken: 't-1', ordner: 'k', holen });
		await assert.rejects(() => adapter.lese('x.puls'), GdriveFehler);
	});
});
