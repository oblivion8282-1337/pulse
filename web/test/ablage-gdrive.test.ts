import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
	GdriveFehler,
	autorisierungsAdresse,
	gdriveAdapter,
	multipartErzeugen,
	type GdriveAnbindung,
	type GdriveVerbindung,
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

function zeitstempel(n: number): string {
	return `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`;
}

function drive() {
	let zaehler = 0;
	const dateien = new Map<
		string,
		{ name: string; elternteil: string; ordner: boolean; inhalt: Uint8Array; modifiedTime: string }
	>();
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
				.map(([id, d]) => ({ id, name: d.name, modifiedTime: d.modifiedTime }));
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
				modifiedTime: zeitstempel(zaehler),
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
			dateien.set(id, {
				name: metadaten.name,
				elternteil: metadaten.parents[0],
				ordner: false,
				inhalt,
				modifiedTime: zeitstempel(zaehler),
			});
			return new Response(JSON.stringify({ id }), { status: 200 });
		}
		if (methode === 'PATCH' && url.pathname.startsWith('/upload/drive/v3/files/')) {
			const id = url.pathname.split('/').pop()!;
			const eintrag = dateien.get(id)!;
			eintrag.inhalt = initSafe.body as Uint8Array;
			eintrag.modifiedTime = zeitstempel(++zaehler);
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

	it('schwenkt beim Anlegen auf Aktualisieren um, wenn zwischen erster Abfrage und Anlegen eine Konkurrenzschreibung auftaucht', async () => {
		// Simuliert den gemeldeten Befund: Gerät A fragt nach `manifest.puls`,
		// bekommt „nicht gefunden" — bevor A daraufhin anlegt, hat Gerät B die
		// Datei bereits erzeugt. Der Fix sieht direkt vor dem Neuanlegen noch
		// einmal nach und muss die von B angelegte Datei per PATCH
		// aktualisieren statt eine zweite Datei gleichen Namens zu erzeugen.
		const gd = drive();
		// Ordnerkette vorab anlegen, damit die Konkurrenzdatei in denselben
		// (bekannten) Ordner gelegt werden kann.
		const verbindung: GdriveVerbindung = { zugangsToken: 't-1', ordner: 'Pulse/ablage/kanal-1', holen: gd.holen };
		await gdriveAdapter(verbindung).schreibe('vorheriges.puls', bytes('egal'));
		const kanalOrdnerId = [...gd.dateien.entries()].find(([, d]) => d.ordner && d.name === 'kanal-1')![0];

		let manifestAbfragen = 0;
		const holenMitRennen: typeof fetch = async (eingabe, init) => {
			const url = new URL(String(eingabe));
			const istManifestSuche =
				(init?.method ?? 'GET') === 'GET' &&
				url.pathname === '/drive/v3/files' &&
				(url.searchParams.get('q') ?? '').includes("name = 'manifest.puls'");
			if (istManifestSuche) {
				manifestAbfragen += 1;
			}
			const antwort = await gd.holen(eingabe, init);
			if (istManifestSuche && manifestAbfragen === 1) {
				// Gerät B legt „dazwischen" an: ERST NACHDEM die Antwort auf die
				// erste Abfrage von A schon berechnet ist (die findet also noch
				// nichts) — die zweite Abfrage (Recheck) sieht die
				// Konkurrenzdatei dann bereits.
				gd.dateien.set('id-konkurrenz', {
					name: 'manifest.puls',
					elternteil: kanalOrdnerId,
					ordner: false,
					inhalt: bytes('von geraet b'),
					modifiedTime: zeitstempel(0),
				});
			}
			return antwort;
		};

		const adapterA = gdriveAdapter({ ...verbindung, holen: holenMitRennen });
		await adapterA.schreibe('manifest.puls', bytes('von geraet a'));

		const manifestDateien = [...gd.dateien.values()].filter((d) => d.name === 'manifest.puls');
		assert.equal(manifestDateien.length, 1, 'es darf keine zweite Datei gleichen Namens entstehen');
		assert.deepEqual(manifestDateien[0].inhalt, bytes('von geraet a'));
		assert.ok(gd.rufe.some((r) => r.startsWith('PATCH /upload/drive/v3/files/id-konkurrenz')));
	});

	it('wählt bei einer bereits bestehenden Namens-Dublette deterministisch die zuletzt geänderte Datei', async () => {
		// Das Restrisiko, das der Recheck NICHT schließt (siehe Kommentar im
		// Adapter): legen zwei Geräte innerhalb der Recheck-Millisekunden
		// gleichzeitig an, liegen danach trotzdem zwei Dateien im Ordner.
		// Ab hier muss jedes Lesen deterministisch dieselbe (die neuere)
		// Datei sehen statt zufällig zwischen beiden zu springen.
		const gd = drive();
		gd.dateien.set('id-alt', {
			name: 'manifest.puls',
			elternteil: 'ordner-1',
			ordner: false,
			inhalt: bytes('alter stand'),
			modifiedTime: zeitstempel(1),
		});
		gd.dateien.set('id-neu', {
			name: 'manifest.puls',
			elternteil: 'ordner-1',
			ordner: false,
			inhalt: bytes('neuer stand'),
			modifiedTime: zeitstempel(2),
		});
		// Ordner 'kanal-x' real über den Adapter anlegen (setzt 'ordner-1' oben
		// als Platzhalter voraus) und die beiden Dubletten dort ablegen, damit
		// der Adapter sie über seinen normalen Auflösungsweg findet.
		const verbindung: GdriveVerbindung = { zugangsToken: 't-1', ordner: 'kanal-x', holen: gd.holen };
		const adapter = gdriveAdapter(verbindung);
		await adapter.liste(); // löst die Ordnerkette 'kanal-x' auf
		const ordnerId = [...gd.dateien.entries()].find(([, d]) => d.ordner && d.name === 'kanal-x')![0];
		gd.dateien.get('id-alt')!.elternteil = ordnerId;
		gd.dateien.get('id-neu')!.elternteil = ordnerId;

		const frischerAdapter = gdriveAdapter(verbindung);
		assert.deepEqual(await frischerAdapter.lese('manifest.puls'), bytes('neuer stand'));
		assert.deepEqual(await frischerAdapter.liste(), ['manifest.puls']);
	});
});
