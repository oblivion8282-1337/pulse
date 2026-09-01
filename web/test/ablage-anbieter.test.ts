import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	angeboteneAnbieter,
	kanalTaugliche,
	anbieter,
	ANBIETER
} from '../src/lib/ablage/anbieter.ts';

test('angeboten werden genau Google Drive, Nextcloud, Dropbox und der Ordner', () => {
	// Die vier werden NAMENTLICH geprueft, nicht gezaehlt: „genau vier" waere
	// nach dem naechsten Tausch immer noch gruen und haette nichts gemerkt.
	const arten = angeboteneAnbieter()
		.map((a) => a.art)
		.sort();
	assert.deepEqual(arten, ['dropbox', 'gdrive', 'nextcloud', 'sync_ordner']);
});

test('OneDrive und S3 werden nicht angeboten, bleiben aber in der Liste', () => {
	// Entscheidung des Eigentuemers vom 2026-08-31: aus der Oberflaeche raus,
	// die Adapter bleiben im Baum. Beides gehoert geprueft — „geloescht" und
	// „nicht angeboten" sind verschiedene Zustaende.
	const angeboten = angeboteneAnbieter().map((a) => a.art);
	assert.ok(!angeboten.includes('onedrive'));
	assert.ok(!angeboten.includes('s3'));
	assert.ok(anbieter('onedrive') !== undefined, 'OneDrive muss nachschlagbar bleiben');
	assert.ok(anbieter('s3') !== undefined, 'S3 muss nachschlagbar bleiben');
});

test('ein Kanal darf nicht auf einem reinen Ordner liegen', () => {
	// Entwurf §2.2: ein Kanal, dessen Inhalt niemand ausser dem Ersteller
	// erreichen kann, ist fuer die Mitglieder kein Kanal. Der Ordner bleibt
	// trotzdem angeboten — fuer das persoenliche Archiv ist er das Beste.
	const fuerKanaele = kanalTaugliche().map((a) => a.art);
	assert.ok(!fuerKanaele.includes('sync_ordner'));
	assert.deepEqual(fuerKanaele.sort(), ['dropbox', 'gdrive', 'nextcloud']);
});

test('kanalTaugliche ist eine Teilmenge von angeboteneAnbieter', () => {
	// Ein Anbieter, der fuer Kanaele taugt, aber gar nicht angeboten wird,
	// waere eine Auswahl, die niemand treffen kann.
	const angeboten = new Set(angeboteneAnbieter().map((a) => a.art));
	for (const a of kanalTaugliche()) {
		assert.ok(angeboten.has(a.art), `${a.art} ist kanaltauglich, aber nicht angeboten`);
	}
});

test('jede Art kommt genau einmal vor', () => {
	const arten = ANBIETER.map((a) => a.art);
	assert.equal(new Set(arten).size, arten.length, 'doppelte Art in der Liste');
});

test('eine unbekannte Art ergibt undefined statt zu werfen', () => {
	assert.equal(anbieter('mega'), undefined);
	assert.equal(anbieter(''), undefined);
});
