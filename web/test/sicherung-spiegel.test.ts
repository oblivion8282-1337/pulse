import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	praefixAdapter,
	ordnerAdapter,
	ordnerLeeren,
	pufferSchluessel,
	SicherungsSpiegel,
	geraeteKuerzel,
	schreibrechtHalten,
} from '../src/lib/sicherung/spiegel.ts';
import { erzeugeDek } from '../src/lib/sicherung/krypto.ts';
import { leseSicherungEintrag } from '../src/lib/sicherung/nutzlast.ts';
import { entschlüsseleEintrag } from '../src/lib/sicherung/krypto.ts';
import { speicherAdapter, type AblageAdapter } from '../src/lib/ablage/adapter.ts';
import { leseSegmentKopf } from '../src/lib/ablage/segment.ts';
import { leseRahmenFolge } from '../src/lib/ablage/format.ts';
import {
	ausWire,
	NUTZLAST_FASSUNG,
	type AblageNachricht,
} from '../src/lib/ablage/nutzlast.ts';

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

/** Dieselbe Konstruktion wie `andock.ts::sicherungGrabstein` — der Stein
 *  trägt nur die Id, alles andere ist leer. */
function grabstein(id: string): AblageNachricht {
	return {
		fassung: NUTZLAST_FASSUNG,
		id,
		autor: '',
		inhalt: '',
		zeit: new Date().toISOString(),
		bearbeitet: null,
		antwortAuf: null,
		anhaenge: [],
		geloescht: true,
	};
}

test('schreibrechtHalten (B1) — abgeben beendet den haltenden Callback, die Sperre fällt', async () => {
	let freigegeben = false;
	const recht = schreibrechtHalten(async (halten) => {
		// So nennt die Sperr-API den Callback und hält die Sperre, bis seine
		// Promise endet (z. B. `locks.request(name, callback)`).
		await halten();
		freigegeben = true;
	});
	await recht.bereit;
	assert.equal(freigegeben, false, 'ohne abgeben steht das Halten');
	recht.abgeben();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(freigegeben, true, 'abgeben beendet das Halten — kein Nie-Ende mehr');
});

test('schreibrechtHalten (B1) — abgeben vor dem Erhalt lässt das spätere Halten enden', async () => {
	let gehalten = 0;
	const recht = schreibrechtHalten(async (halten) => {
		await halten();
		gehalten += 1;
	});
	recht.abgeben(); // die Sperre steht noch gar nicht
	await recht.bereit;
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(gehalten, 1, 'kein verwaistes Nie-Ende für den Callback');
});

test('pufferSchluessel (B4) — Stein und Inhalt derselben Id sind zwei Puffer-Zeilen', () => {
	const inhalt = pufferSchluessel('kanal-a', nachricht('100', 'x'));
	const stein = pufferSchluessel('kanal-a', grabstein('100'));
	assert.equal(inhalt, 'kanal-a:100');
	assert.equal(stein, 'kanal-a:100:geloescht');
	assert.notEqual(inhalt, stein, 'koexistieren im Puffer, statt sich zu überschreiben');
	// `pufferWeg` (geraete.ts) löscht über DEMSELben Schlüssel — damit
	// entfernt es beide Varianten. Die IDB-Runde selbst ist Browser-Sache;
	// die Schlüssel-Gleichheit von Legen und Weg ist die tragende Logik.
});

test('ordnerLeeren (B3) — ein Löschfehler stoppt die Runde nicht und wird als Rest gemeldet', async () => {
	const basis = speicherAdapter();
	const ordner = ordnerAdapter(basis, 'kanal-f');
	await ordner.schreibe('a.puls', new Uint8Array([1]));
	await ordner.schreibe('b.puls', new Uint8Array([2]));
	await ordner.schreibe('c.puls', new Uint8Array([3]));
	await basis.schreibe('key.puls', new Uint8Array([9]));
	// Basis-Adapter, dessen zweites lösche wirft (totes Ziel) — dieselbe
	// Ordner-Rechnung wie `sicherungGespraechEntfernen`, das im Node-Läufer
	// selbst nicht ladbar ist (transitiv IndexedDB/Svelte).
	const hakt: AblageAdapter = {
		schreibe: (d, i) => basis.schreibe(d, i),
		lese: (d) => basis.lese(d),
		liste: () => basis.liste(),
		async lösche(d) {
			if (d === 'kanal-f/b.puls') throw new Error('Ziel tot');
			await basis.lösche?.(d);
		},
	};
	await assert.rejects(
		() => ordnerLeeren(ordnerAdapter(hakt, 'kanal-f')),
		/blieben liegen/,
		'der Rest wird nach oben gemeldet statt still geschluckt',
	);
	// Trotz des Fehlers lief die Runde weiter: nur die tote Datei liegt noch.
	assert.deepEqual(
		(await basis.liste()).filter((n) => n.startsWith('kanal-f/')),
		['kanal-f/b.puls'],
	);
	assert.ok((await basis.liste()).includes('key.puls'), 'fremde Dateien bleiben stehen');
});

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

test('B7: Fallback ohne Locks — zwei Tabs am selben Präfix, der Retry adoptiert statt zu wachsen', async () => {
	const basis = speicherAdapter();
	const ordner = ordnerAdapter(basis, 'kanal-a');
	const praefix = 'dev-ffff6666-';
	const dek = erzeugeDek();
	// Zwei Tabs, EIN Gerät → EIN Geräte-Präfix, damit Segmentdatei UND
	// Manifest gemeinsam; ohne Locks-API ohne jede Abstimmung.
	const tabEins = new SicherungsSpiegel(ordner, dek, praefix, { verzoegerungMs: 10, schwelle: 50 });
	const tabZwei = new SicherungsSpiegel(ordner, dek, praefix, { verzoegerungMs: 10, schwelle: 50 });

	tabEins.aufnehmen('kanal-a', [nachricht('100', 'erste')]);
	await tabEins.jetztSpuelen();
	tabZwei.aufnehmen('kanal-a', [nachricht('200', 'fremd')]);
	await tabZwei.jetztSpuelen();

	// Tab eins spült mit VERALTETEM Stand (1 statt 2) in die inzwischen von
	// Tab zwei weitergeschriebene Ablage — ohne Locks der Normalfall. Der
	// erste Versuch schreibt die Partie als Waise ins offene Segment und
	// wirft DANN den Konflikt; die Partie bleibt im Wartezimmer.
	tabEins.aufnehmen('kanal-a', [nachricht('300', 'eigene')]);
	await tabEins.jetztSpuelen();
	assert.equal(tabEins.pufferLaenge(), 1, 'Versuch 1 bleibt am Fremd-Stand hängen');

	// Der Retry nimmt den Bestand neu auf (Adoption der Waise UND der
	// Fremd-Rahmen, `einrichtungSichtbar` im Spül-Fehlerpfad zurückgesetzt)
	// und hängt die Partie EINMAL mit frischer Id dahinter an — statt sie
	// blind je Versuch erneut anzuhängen (ohne Adoption bleibt das eigene
	// Manifest für immer veraltet, die Datei wüchse je Runde).
	assert.ok((await tabEins.jetztSpuelen()) !== null, 'Retry mit Adoption kommt durch');
	assert.equal(tabEins.pufferLaenge(), 0, 'Partie ist abgeflossen');

	const seg = (await ordner.lese(`${praefix}seg-000000.puls`))!;
	const { rahmen } = leseRahmenFolge(seg.slice(9));
	// 4 Rahmen: 100, 200, die Waise 300 und der Retry-Rahmen 300 — die Waise
	// bleibt liegen (der Wiederherstellungs-Leser dedupliziert je
	// Nachrichten-Id), aber die Datei wächst nicht über die eine Partie hinaus.
	assert.equal(rahmen.length, 4, 'ein Anhang je Partie, kein Retry-Wachstum');
	const ids = new Set<string>();
	for (const r of rahmen) {
		const eintrag = leseSicherungEintrag(await entschlüsseleEintrag(dek, r.nutzlast));
		ids.add(eintrag.nachricht.id);
	}
	assert.deepEqual([...ids].sort(), ['100', '200', '300'], 'alle Nachrichten im Log');

	// Und der Kampf bleibt beilegbar: auch der andere Tab gewinnt danach.
	tabZwei.aufnehmen('kanal-a', [nachricht('400', 'noch-fremd')]);
	await tabZwei.jetztSpuelen(); // scheitert am Stand von tabEins
	await tabZwei.jetztSpuelen(); // Retry mit Adoption
	assert.equal(tabZwei.pufferLaenge(), 0, 'auch der zweite Tab kommt danach durch');
	assert.equal(
		leseRahmenFolge(((await ordner.lese(`${praefix}seg-000000.puls`))!).slice(9)).rahmen.length,
		6,
		'100, 200, 300 (Waise + Retry), 400 (Waise + Retry)',
	);
	tabEins.beenden();
	tabZwei.beenden();
});
