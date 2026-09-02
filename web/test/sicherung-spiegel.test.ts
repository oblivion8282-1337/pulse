import { test } from 'node:test';
import assert from 'node:assert/strict';

import { praefixAdapter, ordnerAdapter, SicherungsSpiegel, geraeteKuerzel } from '../src/lib/sicherung/spiegel.ts';
import { erzeugeDek } from '../src/lib/sicherung/krypto.ts';
import { leseSicherungEintrag } from '../src/lib/sicherung/nutzlast.ts';
import { entschlüsseleEintrag } from '../src/lib/sicherung/krypto.ts';
import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { leseSegmentKopf } from '../src/lib/ablage/segment.ts';
import { leseRahmenFolge } from '../src/lib/ablage/format.ts';
import { ausWire, type AblageNachricht } from '../src/lib/ablage/nutzlast.ts';

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

test('praefixAdapter — Namen unter dem Präfix, liste() streift ihn ab', async () => {
	const basis = speicherAdapter();
	const umbaut = praefixAdapter(basis, 'dev-1a2b-');
	await umbaut.schreibe('seg-000000.puls', new Uint8Array([1, 2, 3]));
	await umbaut.schreibe('manifest.puls', new Uint8Array([4]));
	await basis.schreibe('fremd.puls', new Uint8Array([5]));

	assert.deepEqual(await umbaut.liste(), ['seg-000000.puls', 'manifest.puls']);
	assert.deepEqual(await basis.liste().then((l) => l.sort()), [
		'dev-1a2b-manifest.puls',
		'dev-1a2b-seg-000000.puls',
		'fremd.puls',
	]);
	assert.deepEqual(await umbaut.lese('seg-000000.puls'), new Uint8Array([1, 2, 3]));
	assert.equal(await umbaut.lese('fremd.puls'), null);
});

test('ordnerAdapter — Kanal-Ordner als Präfix, Wurzel unberührt', async () => {
	const basis = speicherAdapter();
	const ordner = ordnerAdapter(basis, 'kanal-a');
	await ordner.schreibe('dev-aaaa1111-seg-000000.puls', new Uint8Array([1, 2, 3]));
	await basis.schreibe('key.puls', new Uint8Array([9]));
	// Ein zweiter Kanal, dessen Id denselben Anfang teilt — darf NICHT in
	// die Liste von kanal-a rutschen (der Präfix endet auf `/`).
	const fremd = ordnerAdapter(basis, 'kanal-ab');
	await fremd.schreibe('dev-bbbb2222-seg-000000.puls', new Uint8Array([4]));

	assert.deepEqual(await ordner.liste(), ['dev-aaaa1111-seg-000000.puls']);
	assert.deepEqual(await fremd.liste(), ['dev-bbbb2222-seg-000000.puls']);
	assert.deepEqual(await basis.lese('kanal-a/dev-aaaa1111-seg-000000.puls'), new Uint8Array([1, 2, 3]));
	assert.ok(await basis.lese('key.puls'), 'Schlüssel-Datei bleibt im Wurzel-Ordner');
	assert.equal(await ordner.lese('key.puls'), null);
});

test('geraeteKuerzel — stabil und unterschiedlich je Kennung', async () => {
	assert.equal(await geraeteKuerzel('geraet-x'), await geraeteKuerzel('geraet-x'));
	assert.notEqual(await geraeteKuerzel('geraet-x'), await geraeteKuerzel('geraet-y'));
	assert.match(await geraeteKuerzel('geraet-x'), /^dev-[0-9a-f]{8}$/);
});

test('Spiegel end-to-end: aufnehmen → spuelen → verschlüsselte Segmente im Kanal-Ordner', async () => {
	const basis = speicherAdapter();
	const dek = erzeugeDek();
	const praefix = 'dev-aaaa1111-';
	// Der Spiegel arbeitet im Ordner SEINER Unterhaltung — alle Dateinamen
	// landen unter `kanal-a/`, die Log-Engine sieht bloße Namen.
	const spiegel = new SicherungsSpiegel(ordnerAdapter(basis, 'kanal-a'), dek, praefix, {
		verzoegerungMs: 10,
		schwelle: 50,
	});

	spiegel.aufnehmen('kanal-a', [nachricht('200', 'zweite')]);
	spiegel.aufnehmen('kanal-a', [nachricht('100', 'erste')]);
	assert.equal(spiegel.pufferLaenge(), 2);
	const ergebnis = await spiegel.jetztSpuelen();
	assert.ok(ergebnis !== null);
	assert.equal(ergebnis!.rahmen, 2);
	assert.equal(spiegel.pufferLaenge(), 0);

	const dateien = (await basis.liste()).sort();
	assert.ok(dateien.some((n) => n === `kanal-a/${praefix}seg-000000.puls`), 'Segmentdatei fehlt');
	assert.ok(dateien.some((n) => n === `kanal-a/${praefix}manifest.puls`), 'Manifest fehlt');

	// Der Segmentkopf trägt die Index-Nummer 0 — und der Inhalt ist verschlüsselt.
	const seg = (await basis.lese(`kanal-a/${praefix}seg-000000.puls`))!;
	assert.equal(leseSegmentKopf(seg).index, 0);
	const text = new TextDecoder().decode(seg);
	assert.ok(!text.includes('erste') && !text.includes('zweite'), 'Klartext im Segment');
	assert.ok(!text.includes('kanal-a') && !text.includes('kanal-b'), 'Kanal-Id im Klartext');

	// Lesen wie der Wiederherstellungs-Leser: Rahmen → Typ 3 → DEK → Eintrag.
	const { rahmen } = leseRahmenFolge(seg.slice(9));
	assert.equal(rahmen.length, 2);
	const gelesen: string[] = [];
	for (const r of rahmen) {
		const klar = await entschlüsseleEintrag(dek, r.nutzlast);
		const eintrag = leseSicherungEintrag(klar);
		gelesen.push(`${eintrag.kanalId}/${eintrag.nachricht.inhalt}`);
	}
	// Aufsteigend nach Nachricht-Id — die Sortierung des Spuels ist im Log.
	// Beide Nutzlasten tragen die kanalId des Ordners (der Spiegel spiegelt
	// nur SEINE Unterhaltung).
	assert.deepEqual(gelesen, ['kanal-a/erste', 'kanal-a/zweite']);
});

test('Duplikate wandern nur einmal in den Puffer', async () => {
	const spiegel = new SicherungsSpiegel(speicherAdapter(), erzeugeDek(), 'dev-bbbb2222-', {
		verzoegerungMs: 3_600_000,
		schwelle: 50,
	});
	spiegel.aufnehmen('kanal-a', [nachricht('300', 'doppelt')]);
	spiegel.aufnehmen('kanal-a', [nachricht('300', 'doppelt')]);
	spiegel.aufnehmen('kanal-b', [nachricht('300', 'doppelt')]);
	assert.equal(spiegel.pufferLaenge(), 2, 'gleicher Kanal+Id nur einmal, fremder Kanal zählt extra');
	spiegel.beenden();
});

test('zwei Geräte schreiben nebeneinander in denselben Kanal-Ordner', async () => {
	const basis = speicherAdapter();
	const ordner = ordnerAdapter(basis, 'kanal-a');
	const eins = new SicherungsSpiegel(ordner, erzeugeDek(), 'dev-cccc3333-', { verzoegerungMs: 10 });
	const zwei = new SicherungsSpiegel(ordner, erzeugeDek(), 'dev-dddd4444-', { verzoegerungMs: 10 });

	eins.aufnehmen('kanal-a', [nachricht('400', 'von eins')]);
	zwei.aufnehmen('kanal-a', [nachricht('401', 'von zwei')]);
	await eins.jetztSpuelen();
	await zwei.jetztSpuelen();

	const dateien = (await basis.liste()).sort();
	assert.equal(dateien.filter((n) => n === `kanal-a/dev-cccc3333-seg-000000.puls` || n === `kanal-a/dev-cccc3333-manifest.puls`).length, 2);
	assert.equal(dateien.filter((n) => n === `kanal-a/dev-dddd4444-seg-000000.puls` || n === `kanal-a/dev-dddd4444-manifest.puls`).length, 2);
	// Kein Gerät hat die Dateien des anderen angefasst — Namensräume getrennt.
	const fremd = await eins.jetztSpuelen();
	void fremd;
	const nurEins = await basis.lese('kanal-a/dev-cccc3333-manifest.puls');
	const nurZwei = await basis.lese('kanal-a/dev-dddd4444-manifest.puls');
	assert.ok(nurEins !== null && nurZwei !== null);
});

test('Spül-Fehler hält den Puffer und plant neu — nichts fällt vom Tisch', async () => {
	const basis = speicherAdapter();
	let versuch = 0;
	const hakt = {
		async schreibe(datei: string, inhalt: Uint8Array) {
			versuch += 1;
			if (versuch === 1) throw new Error('Laufwerk weg');
			await basis.schreibe(datei, inhalt);
		},
		lese: basis.lese,
		liste: basis.liste,
	};
	const spiegel = new SicherungsSpiegel(hakt, erzeugeDek(), 'dev-eeee5555-', {
		verzoegerungMs: 10,
		schwelle: 50,
	});
	spiegel.aufnehmen('kanal-a', [nachricht('500', 'bleibt stehen')]);
	await spiegel.jetztSpuelen();
	await new Promise((r) => setTimeout(r, 60)); // die Nachplanung läuft
	spiegel.beenden();
	assert.ok(spiegel.pufferLaenge() <= 1, 'Puffer nicht doppelt');
	// Nach dem Fehlversuch muss der zweite Lauf die Nachricht gebracht haben.
	assert.ok(versuch >= 2, 'keine zweite Runde geplant');
});
