/**
 * Die Festigung eines Ablage-Kanals — der Antrieb, den `nachzieher.ts`,
 * `schreiber.ts`, `postfachQuelle.ts` und `kryptoBehaelter.ts` bislang
 * vermissten: alles fertig gebaut, aber niemand rief es produktiv. Läuft auf
 * dem Gerät des Kanal-Erstellers: liest das Postfach über
 * `postfachQuelleFuerKanal` (`postfachQuelleVerdrahtung.ts`), schreibt neue
 * Rahmen in die verschlüsselte Ablage (`AblageSchreiber` + `kryptoBehaelter.ts`).
 *
 * **Nur das Besitzer-Gerät ruft das auf** — dieselbe Erkennung wie bei der
 * Community-Festigung (`festigung.ts`, Modulkopf), nur je Kanal statt je
 * Guild: dieses Gerät hat lokal eine `AblageVerbindung` mit
 * `fuerKanal === kanalId` (`verbindungen.svelte.ts`), gesetzt genau dann,
 * wenn dieses Gerät den Kanalordner verbunden hat
 * (`KanalDateiablageVerbinden.svelte`). Ohne diese Markierung ist der Aufruf
 * ein sofortiger No-Op — kein Netzaufruf, kein Postfach-Zugriff.
 *
 * **Quittiert wird hier NICHT.** `postfachQuelle.ts` (Modulkopf) liest das
 * Postfach rein additiv; die Quittung bleibt beim normalen Empfangsweg
 * (`krypto/empfangen.ts`). Diese Datei rührt das nicht an.
 *
 * **Die Konto-Sperre kommt aus `postfachQuelleFuerKanal` mit** — sie öffnet
 * jede Gruppennachricht bereits unter `mitKontosperre` (s. dort). Diese Datei
 * baut keine eigene Sperre und keinen eigenen Postfach-/Krypto-Zugriff.
 *
 * **Backoff mit Deckel statt Wasserzeichen-Warteschlange**: anders als
 * `archivSchreibweg.ts` (Vorbild für diese Datei) gibt es hier keine
 * Warteschlange einzelner Einträge, die getrennt scheitern oder gelingen
 * könnten — ein Kanal hat genau EIN Ziel (sein Laufwerk), und `nachziehen()`
 * arbeitet den gesamten offenen Postfach-Bestand dieses Kanals in einem
 * Rutsch ab. Ein Fehlschlag betrifft deshalb den ganzen Durchlauf, nicht
 * einen einzelnen Rahmen; der Deckel-Backoff (Muster aus `festigung.ts`)
 * verhindert, dass ein totes Laufwerk bei jedem Timer-Tick erneut angefragt
 * wird.
 *
 * **Ein totes Laufwerk hält den Chat nicht an.** Jeder Fehlschlag (Netz,
 * Laufwerk weg, kaputte Zustellung) landet im Rückgabewert
 * (`KanalFestigungsErgebnis.fehler`), nie als geworfene Ausnahme beim
 * Aufrufer der Schleife.
 */

import { AblageSchreiber } from './schreiber.ts';
import { nachziehen } from './nachzieher.ts';
import { verschluesselnderAdapter } from './kryptoBehaelter.ts';
import { ablageVerbindungen, adapterFür } from './verbindungen.svelte.ts';
import { postfachQuelleFuerKanal } from './postfachQuelleVerdrahtung';
import { base64ZuBytes } from './syncOrdnerSchluessel.ts';

/** Backoff mit Deckel — je Kanal, nur für diesen Prozess (kein Neuladen der
 *  Seite übersteht ihn, s. `festigung.ts`-Modulkopf für dieselbe Abwägung:
 *  unschädlich, weil der nächste periodische Durchlauf ohnehin wieder alles
 *  Offene sieht). */
const MAX_BACKOFF_MS = 5 * 60_000;
const versuche = new Map<string, number>();
const gesperrtBis = new Map<string, number>();

function vermerkeFehlschlag(kanalId: string): void {
	const n = (versuche.get(kanalId) ?? 0) + 1;
	versuche.set(kanalId, n);
	const verzoegerung = Math.min(1_000 * 2 ** n, MAX_BACKOFF_MS);
	gesperrtBis.set(kanalId, Date.now() + verzoegerung);
}

function vermerkeErfolg(kanalId: string): void {
	versuche.delete(kanalId);
	gesperrtBis.delete(kanalId);
}

function istFaellig(kanalId: string): boolean {
	const bis = gesperrtBis.get(kanalId);
	return bis === undefined || bis <= Date.now();
}

export interface KanalFestigungsErgebnis {
	festigt: number;
	/** `null` = kein Fehler (auch dann, wenn dieses Gerät gar nicht der
	 *  Besitzer ist — das ist kein Fehlerfall, s. Modulkopf). */
	fehler: string | null;
}

/**
 * Ein Durchlauf für EINEN Kanal. Ohne lokale Laufwerks-Verbindung für diesen
 * Kanal sofortiger No-Op (kein Netzaufruf) — dieses Gerät ist dann kein
 * Besitzer-Gerät. Während des Deckel-Backoffs nach einem Fehlschlag ebenso
 * ein No-Op, bis die Sperrfrist abgelaufen ist.
 */
export async function festigeKanalEinmal(kanalId: string): Promise<KanalFestigungsErgebnis> {
	if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
	const verbindung = ablageVerbindungen.verbindungFürKanal(kanalId);
	if (!verbindung) return { festigt: 0, fehler: null };
	if (!istFaellig(kanalId)) return { festigt: 0, fehler: null };

	try {
		const hauptschlüssel = base64ZuBytes(verbindung.hauptschlüsselB64);
		const roh = await adapterFür(verbindung);
		const adapter = verschluesselnderAdapter(roh, hauptschlüssel);

		const schreiber = new AblageSchreiber(adapter, kanalId);
		// Den echten Stand laden, BEVOR nachgezogen wird — sonst hielte
		// `nachziehen()` den Kanal für leer und läse das Postfach von vorn,
		// obwohl das Manifest längst weiter ist (`nachzieher.ts` fragt
		// `schreiber.stand()` ab, das ohne diesen Aufruf `null` bliebe).
		await schreiber.bestandAufnehmen();

		const quelle = postfachQuelleFuerKanal(kanalId);
		const bericht = await nachziehen(schreiber, quelle);

		vermerkeErfolg(kanalId);
		return { festigt: bericht.festigt, fehler: null };
	} catch (fehler) {
		vermerkeFehlschlag(kanalId);
		return { festigt: 0, fehler: fehler instanceof Error ? fehler.message : String(fehler) };
	}
}

/** Periodischer Anstoss für eine Kanal-Ansicht (`onMount`/`onDestroy`).
 *  Gibt eine Stopp-Funktion zurück — dasselbe Muster wie
 *  `festigung.ts::starteFestigungsSchleife`. */
export function starteKanalFestigungsSchleife(kanalId: string, intervalMs = 30_000): () => void {
	let gestoppt = false;
	let laufend = false;
	const timer = setInterval(() => {
		if (laufend || gestoppt) return;
		laufend = true;
		void festigeKanalEinmal(kanalId).finally(() => {
			laufend = false;
		});
	}, intervalMs);
	// Sofort einen ersten Durchlauf anstossen, statt bis zum ersten Intervall
	// zu warten — sonst wartet ein frisch verbundener Besitzer bis zu
	// `intervalMs` auf die erste Festigung.
	void festigeKanalEinmal(kanalId);
	return () => {
		gestoppt = true;
		clearInterval(timer);
	};
}
