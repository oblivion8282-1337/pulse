import { test } from 'node:test';
import assert from 'node:assert/strict';

import { speicherAdapter, type AblageAdapter } from '../src/lib/ablage/adapter.ts';
import {
	direktMitRueckfallAdapter,
	istAufPulseFestgelegt,
	type RueckfallZiel
} from '../src/lib/ablage/direktMitRueckfall.ts';

const inh = (text: string) => new TextEncoder().encode(text);
const txt = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

class EchteAntwortFehler extends Error {
	constructor(status: number) {
		super(`scheiterte: ${status}`);
		this.name = 'EchteAntwortFehler';
	}
}

type Verhalten = 'ok' | 'abprall' | 'echterFehler';

/** Ein direkter Adapter, dessen `lese()` sich von aussen steuern lässt:
 *  Erfolg, ein Netz-/CORS-Abprall (`TypeError`) oder eine echte Fehlantwort. */
function steuerbarerDirekterAdapter(): AblageAdapter & {
	verhalten: Verhalten;
	leseAufrufe: string[];
} {
	const basis = speicherAdapter();
	let verhalten: Verhalten = 'ok';
	const leseAufrufe: string[] = [];
	return {
		get verhalten() {
			return verhalten;
		},
		set verhalten(wert: Verhalten) {
			verhalten = wert;
		},
		leseAufrufe,
		schreibe: (datei, inhalt) => basis.schreibe(datei, inhalt),
		liste: () => basis.liste(),
		lösche: (datei) => basis.lösche!(datei),
		async lese(datei) {
			leseAufrufe.push(datei);
			if (verhalten === 'abprall') throw new TypeError('Failed to fetch');
			if (verhalten === 'echterFehler') throw new EchteAntwortFehler(500);
			return basis.lese(datei);
		}
	};
}

function bauZiel(
	schluessel: string,
	direkt: AblageAdapter,
	ueberPulse: RueckfallZiel['ueberPulse']
): RueckfallZiel {
	return { schluessel, direkt, ueberPulse };
}

test('ein erfolgreicher direkter Weg benutzt den Umweg über Pulse gar nicht', async () => {
	const direkt = steuerbarerDirekterAdapter();
	await direkt.schreibe('datei.puls', inh('inhalt'));
	let pulseAufrufe = 0;
	const adapter = direktMitRueckfallAdapter(
		bauZiel('kanal:erfolg', direkt, async () => {
			pulseAufrufe++;
			return inh('vom-umweg');
		})
	);

	const ergebnis = await adapter.lese('datei.puls');

	assert.equal(txt(ergebnis), 'inhalt');
	assert.equal(pulseAufrufe, 0);
	assert.equal(istAufPulseFestgelegt('kanal:erfolg'), false);
});

test('ein Netz-/CORS-Abprall landet über den Umweg', async () => {
	const direkt = steuerbarerDirekterAdapter();
	direkt.verhalten = 'abprall';
	let pulseAufrufe = 0;
	const adapter = direktMitRueckfallAdapter(
		bauZiel('kanal:abprall', direkt, async (datei) => {
			pulseAufrufe++;
			return inh(`pulse:${datei}`);
		})
	);

	const ergebnis = await adapter.lese('datei.puls');

	assert.equal(txt(ergebnis), 'pulse:datei.puls');
	assert.equal(pulseAufrufe, 1);
	assert.equal(istAufPulseFestgelegt('kanal:abprall'), true);
});

test('eine 404 (null) ist eine echte Antwort — kein Rückfall', async () => {
	const direkt = steuerbarerDirekterAdapter(); // liefert null für unbekannte Dateien
	let pulseAufrufe = 0;
	const adapter = direktMitRueckfallAdapter(
		bauZiel('kanal:404', direkt, async () => {
			pulseAufrufe++;
			return inh('sollte-nie-kommen');
		})
	);

	const ergebnis = await adapter.lese('gibt-es-nicht.puls');

	assert.equal(ergebnis, null);
	assert.equal(pulseAufrufe, 0);
	assert.equal(istAufPulseFestgelegt('kanal:404'), false);
});

test('eine echte Fehlantwort (kein TypeError) wird weitergeworfen, kein Rückfall', async () => {
	const direkt = steuerbarerDirekterAdapter();
	direkt.verhalten = 'echterFehler';
	let pulseAufrufe = 0;
	const adapter = direktMitRueckfallAdapter(
		bauZiel('kanal:fehler', direkt, async () => {
			pulseAufrufe++;
			return inh('sollte-nie-kommen');
		})
	);

	await assert.rejects(() => adapter.lese('datei.puls'), EchteAntwortFehler);
	assert.equal(pulseAufrufe, 0);
	assert.equal(istAufPulseFestgelegt('kanal:fehler'), false);
});

test('nach einem Abprall wird der direkte Weg für dasselbe Ziel nicht erneut versucht', async () => {
	const direkt = steuerbarerDirekterAdapter();
	direkt.verhalten = 'abprall';
	const adapter = direktMitRueckfallAdapter(
		bauZiel('kanal:merken', direkt, async (datei) => inh(`pulse:${datei}`))
	);

	await adapter.lese('a.puls');
	assert.equal(direkt.leseAufrufe.length, 1);

	// Der direkte Weg würde jetzt sogar wieder klappen — trotzdem wird er
	// für dieses Ziel in dieser Sitzung nicht mehr versucht.
	direkt.verhalten = 'ok';
	await direkt.schreibe('b.puls', inh('würde-jetzt-gehen'));
	const ergebnis = await adapter.lese('b.puls');

	assert.equal(direkt.leseAufrufe.length, 1, 'kein zweiter direkter Versuch');
	assert.equal(txt(ergebnis), 'pulse:b.puls');
});

test('zwei Ziele mit verschiedenem Schlüssel beeinflussen sich nicht gegenseitig', async () => {
	const direktA = steuerbarerDirekterAdapter();
	direktA.verhalten = 'abprall';
	const direktB = steuerbarerDirekterAdapter();
	await direktB.schreibe('x.puls', inh('b-inhalt'));

	const adapterA = direktMitRueckfallAdapter(
		bauZiel('kanal:a', direktA, async () => inh('pulse-a'))
	);
	const adapterB = direktMitRueckfallAdapter(
		bauZiel('kanal:b', direktB, async () => inh('sollte-nie-kommen'))
	);

	await adapterA.lese('x.puls');
	const ergebnisB = await adapterB.lese('x.puls');

	assert.equal(istAufPulseFestgelegt('kanal:a'), true);
	assert.equal(istAufPulseFestgelegt('kanal:b'), false);
	assert.equal(txt(ergebnisB), 'b-inhalt');
	assert.equal(direktB.leseAufrufe.length, 1);
});

test('schreibe/liste/lösche gehen unverändert an den direkten Adapter — kein Rückfall-Bezug', async () => {
	const direkt = steuerbarerDirekterAdapter();
	const adapter = direktMitRueckfallAdapter(
		bauZiel('kanal:schreiben', direkt, async () => {
			throw new Error('darf nie aufgerufen werden');
		})
	);

	await adapter.schreibe('datei.puls', inh('inhalt'));
	assert.deepEqual(await adapter.liste(), ['datei.puls']);
	await adapter.lösche!('datei.puls');
	assert.deepEqual(await adapter.liste(), []);
});
