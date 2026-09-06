import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { webdavAdapter, namenAusMultistatus, urlFuer, WebdavFehler } from '../src/lib/ablage/webdav.ts';
import { AnmeldungAbgelaufenFehler } from '../src/lib/ablage/oauth.ts';

const BASIS = 'https://cloud.example/remote.php/dav/files/lena';
const ORDNER = 'Pulse/ablage/kanal-1';

const PROPFIND_XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/lena/Pulse/ablage/kanal-1/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/lena/Pulse/ablage/kanal-1/seg-000000.puls</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/lena/Pulse/ablage/kanal-1/kanal%20%28alt%29.puls</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/lena/Pulse/ablage/kanal-1/unterordner/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

/** Ein Mini-DAV-Server: Ordner-Set, Datei-Map, Aufschrieb der Aufrufe. */
function davServer() {
	const dateien = new Map<string, Uint8Array>();
	const ordner = new Set<string>(['/remote.php/dav/files/lena/Pulse/ablage/']);
	const aufrufe: string[] = [];
	const holen: typeof fetch = async (eingabe, init) => {
		const url = new URL(String(eingabe));
		const methode = init?.method ?? 'GET';
		aufrufe.push(`${methode} ${url.pathname}`);
		const kopf = init?.headers as Record<string, string> | undefined;
		if (kopf?.Authorization !== `Basic ${btoa('lena:app-passwort')}`) {
			return new Response('unbekannt', { status: 401 });
		}
		const pfad = url.pathname;
		if (methode === 'PUT') {
			const eltern = pfad.slice(0, pfad.lastIndexOf('/') + 1);
			if (!ordner.has(eltern)) {
				return new Response('kein Ordner', { status: 409 });
			}
			dateien.set(pfad, init!.body as Uint8Array);
			return new Response(null, { status: 201 });
		}
		if (methode === 'MKCOL') {
			if (ordner.has(pfad)) {
				return new Response(null, { status: 405 });
			}
			ordner.add(pfad);
			return new Response(null, { status: 201 });
		}
		if (methode === 'GET') {
			const inhalt = dateien.get(pfad);
			return inhalt !== undefined
				? new Response(inhalt as unknown as BodyInit, { status: 200 })
				: new Response('fehlt', { status: 404 });
		}
		if (methode === 'PROPFIND') {
			if (!ordner.has(pfad.endsWith('/') ? pfad : pfad + '/')) {
				return new Response('fehlt', { status: 404 });
			}
			return new Response(PROPFIND_XML, { status: 207 });
		}
		if (methode === 'DELETE') {
			if (!dateien.has(pfad)) {
				return new Response('fehlt', { status: 404 });
			}
			dateien.delete(pfad);
			return new Response(null, { status: 204 });
		}
		return new Response('unbekannte Methode', { status: 405 });
	};
	return { holen, dateien, aufrufe, ordner };
}

describe('Ablage-WebDAV: URLs', () => {
	it('setzt Basis, Ordner und Datei zusammen — kodiert, ohne Doppel-Schrägen', () => {
		assert.equal(
			urlFuer({ basis: BASIS + '/', ordner: ORDNER }, 'seg-000000.puls'),
			`${BASIS}/Pulse/ablage/kanal-1/seg-000000.puls`,
		);
		assert.equal(
			urlFuer({ basis: BASIS, ordner: 'Pulse/mein Ablage-Ordner' }),
			`${BASIS}/Pulse/mein%20Ablage-Ordner`,
		);
	});
});

describe('Ablage-WebDAV: Multistatus', () => {
	it('liefert Dateinamen dekodiert — ohne den Ordner selbst und ohne Unterordner', () => {
		assert.deepEqual(namenAusMultistatus(PROPFIND_XML), [
			'seg-000000.puls',
			'kanal (alt).puls',
		]);
	});
});

describe('Ablage-WebDAV: Adapter gegen den Mini-Server', () => {
	it('schreibt mit Auth, legt den Ordner selbst an und liest zurück', async () => {
		const server = davServer();
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'lena',
			passwort: 'app-passwort',
			holen: server.holen,
		});
		const inhalt = new TextEncoder().encode('manifest-inhalt');
		await adapter.schreibe('manifest.puls', inhalt);

		assert.ok(server.aufrufe.some((a) => a.startsWith('MKCOL ')));
		assert.ok(server.aufrufe.includes(`PUT ${new URL(BASIS).pathname}/Pulse/ablage/kanal-1/manifest.puls`));
		assert.deepEqual(await adapter.lese('manifest.puls'), inhalt);
		assert.equal(await adapter.lese('seg-000000.puls'), null);
	});

	it('heilt einen 409, indem es den Ordner neu sichert und nochmal versucht', async () => {
		const server = davServer();
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'lena',
			passwort: 'app-passwort',
			holen: server.holen,
		});

		// Erster Schreibvorgang legt den Ordner an und läuft sauber.
		await adapter.schreibe('manifest.puls', new TextEncoder().encode('x'));

		// Der Server verliert den Ordner später (serverseitig geleerte Ablage)
		// — der nächste Schreibvorgang bekommt seinen 409 und heilt sich.
		server.ordner.delete('/remote.php/dav/files/lena/Pulse/ablage/kanal-1/');
		await adapter.schreibe('seg-000000.puls', new TextEncoder().encode('y'));

		assert.deepEqual(await adapter.lese('seg-000000.puls'), new TextEncoder().encode('y'));
		// Drei PUTs: der erste Erfolg, der 409-Versuch, der geheilte Wiederholer.
		const puts = server.aufrufe.filter((a) => a.startsWith('PUT '));
		assert.equal(puts.length, 3);
		const mkcol = server.aufrufe.filter((a) => a.startsWith('MKCOL ') && a.endsWith('kanal-1/'));
		assert.equal(mkcol.length, 2);
	});

	it('listet den Ordner, verzeiht aber auch, dass es ihn noch nicht gibt', async () => {
		const server = davServer();
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: 'Pulse/ablage/kanal-2',
			benutzer: 'lena',
			passwort: 'app-passwort',
			holen: server.holen,
		});
		assert.deepEqual(await adapter.liste(), []);
	});

	it('wirft bei echten Fehlern eine WebdavFehler, bleibt aber bei 404 ruhig', async () => {
		const server = davServer();
		server.dateien.set('/remote.php/dav/files/lena/Pulse/ablage/kanal-1/x.puls', new Uint8Array(1));
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'falsch',
			passwort: 'passwort',
			holen: server.holen,
		});
		// Falsche Zugangsdaten sind ein 401 — und der hat seit dem 2026-09-01
		// einen eigenen Typ, weil ein zurueckgezogener Freigabe-Link genau so
		// aussieht und NICHT als voruebergehender Netzfehler durchgehen darf.
		await assert.rejects(() => adapter.lese('x.puls'), AnmeldungAbgelaufenFehler);
	});
});

describe('Ablage-WebDAV: Löschen', () => {
	it('entfernt die Datei wirklich vom Server', async () => {
		// Der Grund, warum dieser Test existiert: `lösche` ist im
		// Adapter-Vertrag OPTIONAL, und bis zum 2026-08-31 setzte es kein
		// einziger Cloud-Adapter um. `DateiSpeicher.löschen()` entfernte
		// deshalb nur den Verzeichniseintrag, waehrend der verschluesselte
		// Container fuer immer liegen blieb — der Nutzer sah die Datei
		// verschwinden und glaubte, sie sei weg.
		const server = davServer();
		const pfad = '/remote.php/dav/files/lena/Pulse/ablage/kanal-1/x.puls';
		server.dateien.set(pfad, new Uint8Array([1, 2, 3]));
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'lena',
			passwort: 'app-passwort',
			holen: server.holen,
		});
		await adapter.lösche!('x.puls');
		assert.equal(server.dateien.has(pfad), false, 'die Datei muss weg sein');
		assert.ok(server.aufrufe.some((a) => a.startsWith('DELETE ')));
	});

	it('eine schon fehlende Datei ist kein Fehler', async () => {
		// Das Ziel des Aufrufs ist „danach ist sie nicht mehr da". Bei 404
		// trifft das bereits zu — ein Wurf wuerde einen Aufraeumlauf abbrechen,
		// der eigentlich erfolgreich war.
		const server = davServer();
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'lena',
			passwort: 'app-passwort',
			holen: server.holen,
		});
		await adapter.lösche!('gibtsnicht.puls');
	});

	it('ein abgewiesenes Löschen wirft, statt Erfolg vorzutäuschen', async () => {
		const server = davServer();
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'falsch',
			passwort: 'passwort',
			holen: server.holen,
		});
		await assert.rejects(() => adapter.lösche!('x.puls'), AnmeldungAbgelaufenFehler);
	});
});

describe('Ablage-WebDAV: ein toter Zugang ist ein eigener Fall', () => {
	it('ein zurueckgezogener Freigabe-Link (401) wirft AnmeldungAbgelaufenFehler', async () => {
		// Am 2026-09-01 an einer echten Nextcloud gemessen: ein gueltiger Link
		// auf einen LEEREN Ordner antwortet mit 207, ein zurueckgezogener oder
		// falscher mit 401. Ohne diese Unterscheidung sieht ein Widerruf fuer
		// die Zustandsanzeige aus wie ein voruebergehender Netzfehler — sie
		// meldete weiter „alles in Ordnung", waehrend nichts mehr gesichert
		// wird. Und das ist kein Randfall: der Widerruf mit einem Klick ist
		// ausgerechnet der Vorteil, mit dem der Link-Weg beworben wird.
		const server = davServer();
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'widerrufen',
			passwort: '',
			holen: server.holen,
		});
		await assert.rejects(() => adapter.liste(), AnmeldungAbgelaufenFehler);
		await assert.rejects(() => adapter.schreibe('x.puls', new Uint8Array(1)), AnmeldungAbgelaufenFehler);
	});

	it('ein leerer Ordner ist KEIN toter Zugang', async () => {
		// Die Gegenprobe zur Zeile darueber, und die wichtigere Haelfte: wer
		// hier zu scharf prueft, meldet jedem frisch verbundenen Laufwerk
		// „Zugang tot", weil dort naturgemaess noch nichts liegt.
		const server = davServer();
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'lena',
			passwort: 'app-passwort',
			holen: server.holen,
		});
		assert.deepEqual(await adapter.liste(), []);
	});

	it('ein gewoehnlicher Serverfehler bleibt ein gewoehnlicher Fehler', async () => {
		// 500 ist eine Aussage ueber den Moment, nicht ueber den Zugang. Wer
		// ihn als toten Zugang deutet, schickt den Nutzer grundlos zum
		// Neuverbinden.
		const holen: typeof fetch = async () => new Response('kaputt', { status: 500 });
		const adapter = webdavAdapter({
			basis: BASIS,
			ordner: ORDNER,
			benutzer: 'lena',
			passwort: 'app-passwort',
			holen,
		});
		await assert.rejects(() => adapter.liste(), WebdavFehler);
	});
});
