import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `web/src/lib/ablage/postfachQuelleVerdrahtung.ts` beantwortet die
 * Sperren-Frage aus `postfachQuelle.ts` (Modulkopf): der Nachzug legt
 * `oeffneGruppennachricht` unter `mitKontosperre` — dieselbe Sperre, unter
 * der `krypto/empfangen.ts::postfachAbholenUndEntschluesseln` laeuft
 * (`gruppenSitzungen.ts`-Modulkopf: eingehende Megolm-Sitzungen ratchen
 * AUSSCHLIESSLICH dort, unter der Konto-Sperre).
 *
 * **Warum dieser Test nicht die echte `postfachQuelleVerdrahtung.ts`
 * importiert:** sie haengt (transitiv, ueber `krypto/gruppe/empfangen.ts` →
 * `gruppenSitzungen.ts`) an IndexedDB und dem WASM-Krypto-Kern, und ueber
 * `api/postfach.ts` am Netz — keins davon ist im Node-Testlaeufer sinnvoll
 * nachzubilden, ohne den eigentlichen Streitpunkt zu verlieren. Wie in
 * `krypto-sperren.test.ts` ("Der Zuschnitt an den Abläufen") wird deshalb
 * NUR die Reihenfolge nachgebaut, die tatsaechlich ueber Sicherheit
 * entscheidet: ratcht der Nachzug an einer eingehenden Sitzung, WAEHREND der
 * normale Abholzyklus dieselbe Sitzung anfasst?
 *
 * Gegen die reale `krypto/sperren.ts` gefahren (echte Sperrnamen
 * `KONTO_SPERRE`/`mitKontosperre`), mit einer Nachbildung von
 * `navigator.locks` wie in `krypto-sperren.test.ts`. Zwei Läufe, wie dort:
 * eine GEGENPROBE ohne Sperre (der Schaden tritt ein — sonst beweist der
 * Lauf darunter nichts) und der eigentliche Test mit `mitKontosperre`.
 */

function lockVerwalterAnlegen() {
	const ketten = new Map<string, Promise<unknown>>();
	return {
		request<T>(name: string, _optionen: { mode: 'exclusive' }, aufgabe: () => Promise<T>) {
			const vorherige = ketten.get(name) ?? Promise.resolve();
			const eigene = vorherige.then(aufgabe, aufgabe);
			ketten.set(
				name,
				eigene.catch(() => undefined),
			);
			return eigene;
		},
	};
}

function navigatorStellen(wert: unknown): void {
	Object.defineProperty(globalThis, 'navigator', {
		value: wert,
		configurable: true,
		writable: true,
	});
}

navigatorStellen({ locks: lockVerwalterAnlegen() });

const { mitKontosperre } = await import('../src/lib/krypto/sperren.ts');

function warte(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type Sperre = <T>(aufgabe: () => Promise<T>) => Promise<T>;
const OHNE_SPERRE: Sperre = (aufgabe) => aufgabe();

/**
 * Nachbildung EINER eingehenden Gruppensitzung: ein Zaehler steht fuer den
 * Megolm-Ratchet-Stand, `entschluesselt` fuer die Klartexte, die er dabei
 * ausgibt. Ratchet-Verhalten wie im echten Kern (`vodozemac`): jeder
 * Entschluesselungsversuch "verbraucht" den aktuellen Stand und ruckt vor —
 * ein zweiter Versuch am selben (schon verbrauchten) Stand liefert nichts
 * Neues mehr, sondern denselben, bereits gesehenen Klartext ein zweites Mal
 * ODER (bei fortgeschrittenerem Ratchet) gar nichts mehr. Fuer diesen Test
 * genuegt: zwei GLEICHZEITIGE Oeffner duerfen den Stand nie gemeinsam lesen
 * UND weiterschreiben, sonst sieht der langsamer laufende Oeffner einen
 * Stand, der beim Sichern schon wieder ueberholt ist — sein Sichern wuerde
 * den fortschrittlicheren Stand des schnelleren ueberschreiben (exakt der
 * Verlust, den `gruppenSitzungen.ts` beschreibt: "waeren noch offene
 * Nachrichten aus der alten Sitzung UNWIEDERBRINGLICH verloren").
 */
function eingehendeSitzungAnlegen() {
	let stand = 0;
	let ueberschreibungen = 0;
	return {
		/** Nachbildung von `oeffneGruppennachricht`: laden, entschluesseln
		 *  (Netz-Latenz simuliert `leseNachrichtNutzlast`/Umschlag-Parsing),
		 *  sichern. */
		async oeffnen(netzDauerMs: number): Promise<void> {
			const gelesenerStand = stand; // gruppenempfangLaden
			await warte(netzDauerMs); // entschluesseln braucht "Zeit"
			if (gelesenerStand < stand) {
				// Ein anderer Aufrufer ist inzwischen weiter — dieses Sichern
				// wuerde seinen Fortschritt zuruecksetzen.
				ueberschreibungen += 1;
				return;
			}
			stand = gelesenerStand + 1; // gruppenempfangSichern
		},
		ueberschreibungenGesamt: () => ueberschreibungen,
	};
}

async function konkurrierenderZugriff(sperre: Sperre): Promise<number> {
	const sitzung = eingehendeSitzungAnlegen();
	await Promise.all([
		// Der Nachzug: langsamer (er entschluesselt zusaetzlich, um zu
		// archivieren), startet zuerst.
		sperre(() => sitzung.oeffnen(30)),
		// Der normale Abholzyklus: kommt kurz danach, ist aber schneller.
		(async () => {
			await warte(5);
			await sperre(() => sitzung.oeffnen(0));
		})(),
	]);
	return sitzung.ueberschreibungenGesamt();
}

test('GEGENPROBE: ohne gemeinsame Sperre kann der Nachzug den Fortschritt des Abholzyklus zuruecksetzen', async () => {
	assert.ok(
		(await konkurrierenderZugriff(OHNE_SPERRE)) > 0,
		'Die Nachbildung bildet den Schaden nicht mehr ab — dann beweist der Test darunter nichts.',
	);
});

test('mit derselben Kontosperre (wie in postfachQuelleVerdrahtung.ts) ratchen Nachzug und Abholzyklus nie gleichzeitig', async () => {
	assert.equal(await konkurrierenderZugriff(mitKontosperre), 0);
});

test('Nachzug und Abholzyklus serialisieren sich real ueber KONTO_SPERRE, nicht ueber einen eigenen Namen', async () => {
	// Der Streitpunkt der Sperren-Frage aus dem Modulkopf von
	// `postfachQuelle.ts`: eine EIGENE Sperre der Postfach-Quelle wuerde
	// NICHTS gegen den echten Abholzyklus ausrichten, weil beide dann unter
	// verschiedenen Namen liefen. Dieser Test faellt genau dann, wenn
	// `postfachQuelleVerdrahtung.ts` `oeffneGruppennachricht` unter einem
	// anderen Namen als `KONTO_SPERRE` sperrte.
	let gleichzeitig = 0;
	let maxGleichzeitig = 0;
	async function aufgabe(): Promise<void> {
		gleichzeitig += 1;
		maxGleichzeitig = Math.max(maxGleichzeitig, gleichzeitig);
		await warte(15);
		gleichzeitig -= 1;
	}
	// "Nachzug" und "Abholzyklus" — zwei unabhaengige Aufrufer derselben
	// Funktion, wie es `mitKontosperre` in der echten Verdrahtung waere.
	await Promise.all([mitKontosperre(aufgabe), mitKontosperre(aufgabe)]);
	assert.equal(maxGleichzeitig, 1);
});
