import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	angeboteneAnbieter,
	kanalTaugliche,
	anbieter,
	ANBIETER
} from '../src/lib/ablage/anbieter.ts';

test('angeboten wird nur noch der Ordner — fremde Anbieter sind geparkt', () => {
	// Entscheidung des Eigentuemers vom 2026-09-11: Pulse vermietet eigenen
	// Speicher (Pulse-Laufwerk), fremde Clouds werden nicht mehr angeboten
	// (`ABLAGE_FREMDE_ANBIETER_ENABLED = false`). Namentlich geprueft, nicht
	// gezaehlt — „genau eins" waere nach dem naechsten Tausch immer noch gruen.
	const arten = angeboteneAnbieter().map((a) => a.art).sort();
	assert.deepEqual(arten, ['sync_ordner']);
});

test('OneDrive und S3 werden nicht angeboten, bleiben aber in der Liste', () => {
	// Entscheidung des Eigentuemers vom 2026-08-31: aus der Oberflaeche raus,
	// die Adapter bleiben im Baum. Beides gehoert geprueft — „geloescht" und
	// „nicht angeboten" sind verschiedene Zustaende. Seit dem 2026-09-11 gilt
	// dasselbe fuer Dropbox, Google Drive und Nextcloud (geparkt, nicht
	// geloescht).
	const angeboten = angeboteneAnbieter().map((a) => a.art);
	for (const fremd of ['onedrive', 's3', 'dropbox', 'gdrive', 'nextcloud'] as const) {
		assert.ok(!angeboten.includes(fremd), `${fremd} soll geparkt sein`);
		assert.ok(anbieter(fremd) !== undefined, `${fremd} muss nachschlagbar bleiben`);
	}
});

test('solange die fremden Anbieter geparkt sind, bleibt kein kanaltauglicher ueber', () => {
	// Entwurf §2.2 bleibt Guinea: ein Kanal auf einem reinen Ordner waere
	// fuer Mitglieder kein Kanal. Und ohne fremde Clouds ist kein Anbieter
	// mehr kanaltauglich — Ablage-Kanaele laufen, sobald sie folgen, ueber das
	// Pulse-Laufwerk, nicht ueber diese Liste.
	const fuerKanaele = kanalTaugliche().map((a) => a.art);
	assert.deepEqual(fuerKanaele, []);
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
