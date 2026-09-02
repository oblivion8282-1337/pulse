import { test } from 'node:test';
import assert from 'node:assert/strict';

import { leseSicherungKanalSeite, KANAL_ORDNER_MUSTER } from '../src/lib/sicherung/wiederherstellen.ts';
import { ordnerAdapter, SicherungsSpiegel } from '../src/lib/sicherung/spiegel.ts';
import { erzeugeDek } from '../src/lib/sicherung/krypto.ts';
import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { ausWire, type AblageNachricht } from '../src/lib/ablage/nutzlast.ts';
import type { SicherungEintrag } from '../src/lib/sicherung/nutzlast.ts';
import type { SicherungLeseStaende } from '../src/lib/sicherung/wiederherstellen.ts';

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

/** Spiegelt `anzahl` Nachrichten (Ids 1001… aufsteigend) in den Kanal-Ordner. */
async function ordnerMit(kanalId: string, anzahl: number, dek = erzeugeDek()) {
	const basis = speicherAdapter();
	const spiegel = new SicherungsSpiegel(ordnerAdapter(basis, kanalId), dek, 'dev-aaaa1111-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	const alle: AblageNachricht[] = [];
	for (let i = 1; i <= anzahl; i++) {
		const id = String(1000 + i);
		alle.push(nachricht(id, `nr-${id}`));
	}
	// In Partien über der Spül-Schwelle — es entstehen mehrere Rahmen-Partien,
	// wie im Live-Betrieb.
	spiegel.aufnehmen(kanalId, alle.slice(0, Math.ceil(anzahl / 2)));
	spiegel.aufnehmen(kanalId, alle.slice(Math.ceil(anzahl / 2)));
	await spiegel.jetztSpuelen();
	spiegel.beenden();
	return { basis, dek };
}

test('KANAL_ORDNER_MUSTER — findet Kanal-Ordner in der Wurzel-Listung', () => {
	assert.equal(KANAL_ORDNER_MUSTER.exec('kanal-42/dev-aaaa1111-seg-000007.puls')![1], 'kanal-42');
	// Der Bindestrich zwischen Kürzel und `seg` fehlt je nach Kürzel-Fassung.
	assert.ok(KANAL_ORDNER_MUSTER.test('kanal-42/dev-428822e8seg-000000.puls'));
	assert.equal(KANAL_ORDNER_MUSTER.exec('key.puls'), null);
	assert.equal(KANAL_ORDNER_MUSTER.exec('anhang-123.puls'), null);
	assert.equal(KANAL_ORDNER_MUSTER.exec('kanal-42/dev-aaaa1111-manifest.puls'), null);
});

test('leerer Ordner: keine Einträge, Lesestand unverändert', async () => {
	const dek = erzeugeDek();
	const seite = await leseSicherungKanalSeite(speicherAdapter(), dek, {}, 50);
	assert.deepEqual(seite.eintraege, []);
	assert.deepEqual(seite.lesestand, {});
});

test('Seitenweise rückwärts: 120 Nachrichten in drei Seiten ohne Dublette und Lücke', async () => {
	const kanalId = 'kanal-a';
	const { basis, dek } = await ordnerMit(kanalId, 120);
	const ordner = ordnerAdapter(basis, kanalId);

	const gelesen: SicherungEintrag[] = [];
	let stand: SicherungLeseStaende = {};
	// Eine Seite mehr als nötig — die vierte belegt die Erschöpfung (leer).
	for (let seiteNr = 0; seiteNr < 4; seiteNr++) {
		const seite = await leseSicherungKanalSeite(ordner, dek, stand, 50);
		assert.ok(seite.eintraege.length <= 50, 'Seite hält die Anzahl ein');
		gelesen.push(...seite.eintraege);
		stand = seite.lesestand;
		if (seite.eintraege.length === 0) break;
	}

	assert.equal(gelesen.length, 120, 'alle Nachrichten über drei Seiten');
	// Kein Duplikat.
	assert.equal(new Set(gelesen.map((e) => e.nachricht.id)).size, 120);
	// Erste Seite = die NEUESTEN 50 (größte Ids zuerst), dann die davor,
	// dann der Rest — lückenlos absteigend über die Seiten hinweg.
	assert.deepEqual(
		gelesen.map((e) => Number(e.nachricht.id)),
		Array.from({ length: 120 }, (_, i) => 1120 - i),
	);
});

test('zwei Geräte-Ketten im Ordner: beide gelesen, ohne Dublette, Cursor je Kette', async () => {
	const kanalId = 'kanal-a';
	const basis = speicherAdapter();
	const dek = erzeugeDek();
	const ordner = ordnerAdapter(basis, kanalId);
	// Zwei Geräte spiegeln dasselbe Gespräch — dieselbe Nachricht 100 liegt
	// in BEIDEN Ketten, Gerät 2 hat zusätzlich die 200.
	const eins = new SicherungsSpiegel(ordner, dek, 'dev-aaaa1111-', { verzoegerungMs: 10 });
	const zwei = new SicherungsSpiegel(ordner, dek, 'dev-bbbb2222-', { verzoegerungMs: 10 });
	eins.aufnehmen(kanalId, [nachricht('100', 'erste')]);
	zwei.aufnehmen(kanalId, [nachricht('100', 'erste'), nachricht('200', 'zweite')]);
	await eins.jetztSpuelen();
	await zwei.jetztSpuelen();
	eins.beenden();
	zwei.beenden();

	const erste = await leseSicherungKanalSeite(ordner, dek, {}, 50);
	assert.deepEqual(
		erste.eintraege.map((e) => e.nachricht.inhalt),
		['zweite', 'erste'],
		'neueste zuerst, geräteübergreifend dedupliziert',
	);
	assert.equal(Object.keys(erste.lesestand).length, 2, 'Cursor für beide Ketten');
	const zweite = await leseSicherungKanalSeite(ordner, dek, erste.lesestand, 50);
	assert.deepEqual(zweite.eintraege, [], 'zweiter Lauf: nichts Neues');
});

test('nach einer Seite kommt eine neue Nachricht dazu — der nächste Lauf liefert nur sie', async () => {
	const kanalId = 'kanal-a';
	const basis = speicherAdapter();
	const dek = erzeugeDek();
	const ordner = ordnerAdapter(basis, kanalId);
	const spiegel = new SicherungsSpiegel(ordner, dek, 'dev-aaaa1111-', { verzoegerungMs: 10 });

	spiegel.aufnehmen(kanalId, [nachricht('100', 'erste')]);
	await spiegel.jetztSpuelen();
	const erster = await leseSicherungKanalSeite(ordner, dek, {}, 50);
	assert.deepEqual(erster.eintraege.map((e) => e.nachricht.inhalt), ['erste']);
	const praefix = Object.keys(erster.lesestand)[0]!;
	assert.ok(praefix.startsWith('dev-'), 'Lesestand für die Geräte-Kette');

	// Zweiter Lauf, nichts Neues — leer, ohne dass etwas verloren geht.
	const zweiter = await leseSicherungKanalSeite(ordner, dek, erster.lesestand, 50);
	assert.equal(zweiter.eintraege.length, 0);

	// Neue Nachricht dazwischen: nur sie kommt beim dritten Lauf.
	spiegel.aufnehmen(kanalId, [nachricht('200', 'zweite')]);
	await spiegel.jetztSpuelen();
	const dritter = await leseSicherungKanalSeite(ordner, dek, zweiter.lesestand, 50);
	assert.deepEqual(dritter.eintraege.map((e) => e.nachricht.inhalt), ['zweite']);
	spiegel.beenden();
});

test('beschädigtes Segment — wird übersprungen, Rest der Kette bleibt lesbar', async () => {
	const kanalId = 'kanal-a';
	const { basis, dek } = await ordnerMit(kanalId, 2);
	const ordner = ordnerAdapter(basis, kanalId);
	// Müll im Namensraum desselben Geräts, im Segment DAHINTER (neuer):
	await basis.schreibe('kanal-a/dev-aaaa1111-seg-000009.puls', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));

	const seite = await leseSicherungKanalSeite(ordner, dek, {}, 50);
	assert.deepEqual(
		seite.eintraege.map((e) => e.nachricht.inhalt).sort(),
		['nr-1001', 'nr-1002'],
		'die lesbaren Segmente überleben',
	);
});
