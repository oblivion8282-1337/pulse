import { test } from 'node:test';
import assert from 'node:assert/strict';

import { speicherAdapter, type AblageAdapter } from '../src/lib/ablage/adapter.ts';
import { spiegelAdapter, SpiegelFehler } from '../src/lib/ablage/spiegel.ts';

/**
 * Ein Speicher-Adapter, dessen Ausfall sich von aussen an-/abschalten laesst.
 * `basis` liegt offen, damit ein Test Inhalte direkt hineinschreiben kann,
 * ohne den Spiegel selbst zu benutzen (z. B. um zwei Ziele bewusst
 * auseinanderlaufen zu lassen).
 */
function brüchigerAdapter(): AblageAdapter & { kaputt: boolean; basis: AblageAdapter } {
	const basis = speicherAdapter();
	let kaputt = false;
	return {
		basis,
		get kaputt() {
			return kaputt;
		},
		set kaputt(wert: boolean) {
			kaputt = wert;
		},
		async schreibe(datei, inhalt) {
			if (kaputt) throw new Error('Ziel nicht erreichbar');
			return basis.schreibe(datei, inhalt);
		},
		async lese(datei) {
			if (kaputt) throw new Error('Ziel nicht erreichbar');
			return basis.lese(datei);
		},
		async liste() {
			if (kaputt) throw new Error('Ziel nicht erreichbar');
			return basis.liste();
		},
		async lösche(datei) {
			if (kaputt) throw new Error('Ziel nicht erreichbar');
			return basis.lösche!(datei);
		}
	};
}

const inh = (text: string) => new TextEncoder().encode(text);
const txt = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

test('eine Schreibrunde ist erfolgreich, wenn nur ein Ziel bestaetigt', async () => {
	const a = speicherAdapter();
	const b = brüchigerAdapter();
	b.kaputt = true;
	const spiegel = spiegelAdapter([a, b]);

	await spiegel.schreibe('datei.puls', inh('inhalt'));

	assert.equal(txt(await a.lese('datei.puls')), 'inhalt');
	const zustand = spiegel.zustandJeZiel();
	assert.equal(zustand[0].gesund, true);
	assert.equal(zustand[0].hinterher, false);
	assert.equal(zustand[1].gesund, false);
	assert.equal(zustand[1].hinterher, true);
});

test('scheitern alle Ziele, wirft die Runde mit einer Meldung je Ziel', async () => {
	const a = brüchigerAdapter();
	const b = brüchigerAdapter();
	a.kaputt = true;
	b.kaputt = true;
	const spiegel = spiegelAdapter([a, b]);

	await assert.rejects(
		() => spiegel.schreibe('datei.puls', inh('inhalt')),
		(fehler: unknown) => {
			assert.ok(fehler instanceof SpiegelFehler);
			assert.match(fehler.message, /\[0\]/);
			assert.match(fehler.message, /\[1\]/);
			return true;
		}
	);
});

test('Lesen fragt bei Ausfall des ersten Ziels das zweite', async () => {
	const a = brüchigerAdapter();
	const b = brüchigerAdapter();
	const spiegel = spiegelAdapter([a, b]);
	await spiegel.schreibe('datei.puls', inh('inhalt'));

	a.kaputt = true; // a antwortet auf lese() jetzt mit einem Fehler, nicht mit null
	assert.equal(txt(await spiegel.lese('datei.puls')), 'inhalt');
});

test('Lesen bevorzugt das zuletzt bestaetigte (gesunde) Ziel vor einem hinterherhaengenden', async () => {
	const a = speicherAdapter();
	const b = brüchigerAdapter();
	const spiegel = spiegelAdapter([a, b]);

	await spiegel.schreibe('datei.puls', inh('alt'));
	b.kaputt = true;
	await spiegel.schreibe('datei.puls', inh('neu')); // nur a bestaetigt, b faellt zurueck
	// b haette eine neuere Version, koennte man direkt hineinschreiben —
	// das simuliert eine Datei, die woanders aktueller aussieht als sie ist.
	await b.basis.schreibe('datei.puls', inh('taeuschung'));
	b.kaputt = false; // b antwortet wieder, gilt aber noch als hinterher/ungesund

	assert.equal(txt(await spiegel.lese('datei.puls')), 'neu', 'das hinterherhaengende Ziel wurde bevorzugt gelesen');
});

test('ein zurueckgefallenes Ziel wird beim naechsten Erfolg vollstaendig nachgefuehrt', async () => {
	const a = speicherAdapter();
	const b = brüchigerAdapter();
	const spiegel = spiegelAdapter([a, b]);

	// b faellt aus, waehrend mehrere Runden laufen — inklusive einer erneuten
	// Ueberschreibung derselben Datei und einer Loeschung.
	b.kaputt = true;
	await spiegel.schreibe('eins.puls', inh('1'));
	await spiegel.schreibe('zwei.puls', inh('2'));
	await spiegel.schreibe('eins.puls', inh('1-neu')); // ueberschreibt eins.puls erneut
	await spiegel.lösche('zwei.puls'); // b hat zwei.puls nie gesehen, a hat es schon geloescht

	let zustand = spiegel.zustandJeZiel();
	assert.equal(zustand[1].hinterher, true);

	// b kommt zurueck: der naechste erfolgreiche Vorgang stoesst den Abgleich an.
	b.kaputt = false;
	await spiegel.schreibe('drei.puls', inh('3'));

	zustand = spiegel.zustandJeZiel();
	assert.equal(zustand[1].hinterher, false, 'b gilt nach dem Abgleich noch als hinterher');
	assert.equal(txt(await b.lese('eins.puls')), '1-neu', 'b haette die letzte Fassung nachziehen muessen');
	assert.equal(txt(await b.lese('drei.puls')), '3');
	assert.equal(txt(await b.lese('zwei.puls')), null, 'b haette zwei.puls loeschen muessen');

	const bListe = (await b.liste()).sort();
	const aListe = (await a.liste()).sort();
	assert.deepEqual(bListe, aListe, 'b ist nach dem Abgleich nicht identisch mit a');
});

test('lösche greift ueber gleicheAb() auch auf einem Ziel, das beim Loeschen selbst ausfiel', async () => {
	const a = speicherAdapter();
	const b = brüchigerAdapter();
	const spiegel = spiegelAdapter([a, b]);

	await spiegel.schreibe('datei.puls', inh('inhalt'));
	b.kaputt = true;
	await spiegel.lösche('datei.puls'); // nur a bestaetigt, Runde trotzdem erfolgreich
	assert.equal(await a.lese('datei.puls'), null);

	b.kaputt = false;
	await spiegel.gleicheAb();

	assert.equal(txt(await b.lese('datei.puls')), null, 'b haette die Loeschung nachziehen muessen');
});

test('gleicheAb() ohne erreichbare Quelle wirft nicht, laesst das Ziel aber hinterher', async () => {
	const a = brüchigerAdapter();
	const b = brüchigerAdapter();
	const spiegel = spiegelAdapter([a, b]);
	await spiegel.schreibe('datei.puls', inh('inhalt')); // beide gesund

	b.kaputt = true;
	await spiegel.schreibe('datei.puls', inh('neu')); // nur a bestaetigt, b faellt zurueck
	assert.equal(spiegel.zustandJeZiel()[1].hinterher, true);

	a.kaputt = true; // jetzt ist auch die einzige moegliche Quelle nicht erreichbar
	await assert.doesNotReject(() => spiegel.gleicheAb());
	assert.equal(spiegel.zustandJeZiel()[1].hinterher, true, 'ohne Quelle haette b nicht nachgefuehrt werden koennen');
});
