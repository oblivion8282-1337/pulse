import { test } from 'node:test';
import assert from 'node:assert/strict';

import { leseSicherung, SicherungLesefehler } from '../src/lib/sicherung/wiederherstellen.ts';
import { SicherungsSpiegel } from '../src/lib/sicherung/spiegel.ts';
import { erzeugeDek, wickleSchluesselDatei, SicherungKryptoFehler } from '../src/lib/sicherung/krypto.ts';
import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import type { AblageNachricht } from '../src/lib/ablage/nutzlast.ts';
import { ausWire } from '../src/lib/ablage/nutzlast.ts';

function nachricht(id: string, inhalt: string): AblageNachricht {
	return ausWire({
		id,
		author_id: '100',
		content: inhalt,
		created_at: '2026-08-31T12:00:00Z',
		edited_at: null,
		reply_to_id: null,
		attachments: [],
	} as unknown as Parameters<typeof ausWire>[0]);
}

/** Richtet einen Container ein wie die Einrichtung: DEK, Schlüssel-Datei, Spiegel. */
async function containerMit(passwort: string) {
	const basis = speicherAdapter();
	const dek = erzeugeDek();
	await basis.schreibe('schluessel.puls', await wickleSchluesselDatei(dek, passwort, { zeiten: 1, speicherKiB: 8192 }));
	return { basis, dek };
}

test('leer: ohne Schlüssel-Datei ist die Sicherung ein Fehlerfall, kein stiller Bestand', async () => {
	await assert.rejects(
		() => leseSicherung(speicherAdapter(), 'egal'),
		SicherungLesefehler,
	);
});

test('Rundlauf: Spiegel schreibt zwei Geräte, Leser holt alles sortiert und dedupliziert', async () => {
	const { basis, dek } = await containerMit('dasselbe-passwort');
	const eins = new SicherungsSpiegel(basis, dek, 'dev-aaaa1111-', { verzoegerungMs: 10 });
	// Gerät 2 trägt denselben DEK — jedes Gerät entpackt ihn aus derselben
	// `schluessel.puls`, nur die Namensräume (Präfixe) sind getrennt.
	const zwei = new SicherungsSpiegel(basis, dek, 'dev-bbbb2222-', { verzoegerungMs: 10 });

	// Gerät 1 spiegelt die empfangenen Nachrichten, Gerät 2 hat sie AUCH
	// empfangen und spiegelt sie selbst — dieselbe Nachricht zweimal im
	// Container, wie es zwischen echten Geräten geschieht.
	eins.aufnehmen('kanal-a', [nachricht('100', 'erste'), nachricht('300', 'dritte')]);
	zwei.aufnehmen('kanal-a', [nachricht('100', 'erste')]);
	zwei.aufnehmen('kanal-b', [nachricht('200', 'zweite')]);
	await eins.jetztSpuelen();
	await zwei.jetztSpuelen();
	eins.beenden();
	zwei.beenden();

	const bestand = await leseSicherung(basis, 'dasselbe-passwort');
	assert.deepEqual(
		bestand.eintraege.map((e) => `${e.kanalId}/${e.nachricht.inhalt}`),
		['kanal-a/erste', 'kanal-b/zweite', 'kanal-a/dritte'],
		'Empfänger-seitig sortiert, geräteübergreifend dedupliziert',
	);
	assert.deepEqual(bestand.lücken, []);
});

test('falsches Passwort — Lesung schlägt an der Schlüssel-Datei fehl', async () => {
	const { basis } = await containerMit('richtig');
	await assert.rejects(() => leseSicherung(basis, 'falsch'), SicherungKryptoFehler);
});

test('beschädigtes Segment — Befund in lücken, Rest bleibt lesbar', async () => {
	const { basis, dek } = await containerMit('pw');
	const gut = new SicherungsSpiegel(basis, dek, 'dev-cccc3333-', { verzoegerungMs: 10 });
	gut.aufnehmen('kanal-a', [nachricht('100', 'lesbar')]);
	await gut.jetztSpuelen();
	gut.beenden();

	// Ein fremdes "Gerät" mit Müll im Namensraum — Kopf zerstört.
	await basis.schreibe(
		'dev-dddd4444-seg-000000.puls',
		new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
	);

	const bestand = await leseSicherung(basis, 'pw');
	assert.deepEqual(bestand.eintraege.map((e) => e.nachricht.inhalt), ['lesbar']);
	assert.equal(bestand.lücken.length, 1);
	assert.match(bestand.lücken[0]!, /^dev-dddd4444-seg-000000\.puls:/);
});
