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
import { backoffDeckel } from './backoffDeckel.ts';

/** Backoff mit Deckel — je Kanal, nur für diesen Prozess (kein Neuladen der
 *  Seite übersteht ihn, s. `festigung.ts`-Modulkopf für dieselbe Abwägung:
 *  unschädlich, weil der nächste periodische Durchlauf ohnehin wieder alles
 *  Offene sieht). */
const deckel = backoffDeckel();

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
	if (!deckel.istFaellig(kanalId)) return { festigt: 0, fehler: null };

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

		deckel.vermerkeErfolg(kanalId);
		return { festigt: bericht.festigt, fehler: null };
	} catch (fehler) {
		deckel.vermerkeFehlschlag(kanalId);
		return { festigt: 0, fehler: fehler instanceof Error ? fehler.message : String(fehler) };
	}
}

/**
 * Referenzgezählte laufende Schleifen, EIN Eintrag je Kanal — der Wächter
 * gegen den Mehrgeräte-Konflikt (Modulkopf), nur eine Ebene tiefer: nicht nur
 * zwei GERÄTE dürfen nie gleichzeitig denselben Kanal festigen, auch dieses
 * eine Gerät darf es nur EINMAL tun. Zwei Aufrufstellen brauchen dieselbe
 * Schleife: der App-Start (`+layout.svelte::starteAlleKanalFestigungsSchleifen`,
 * läuft für die gesamte Sitzungsdauer) UND `KanalDateiablageVerbinden.svelte`
 * (läuft nur, solange die Kanal-Einstellungen offen sind). Ohne Zählung würde
 * das Öffnen der Einstellungen eine ZWEITE Schleife neben der vom App-Start
 * starten — zwei Schreiber auf demselben Laufwerk, genau der Konflikt, gegen
 * den `AblageSchreiber` sich wehrt. Mit Zählung erhöht das Öffnen nur die
 * Referenz, und das Schliessen senkt sie wieder — die zugrundeliegende
 * Schleife läuft ungestört weiter, solange irgendeine Referenz sie noch hält.
 */
const aktiveSchleifen = new Map<
	string,
	{ timer: ReturnType<typeof setInterval>; laufend: boolean; referenzen: number }
>();

function stoppeReferenz(kanalId: string): void {
	const eintrag = aktiveSchleifen.get(kanalId);
	if (!eintrag) return;
	eintrag.referenzen -= 1;
	if (eintrag.referenzen <= 0) {
		clearInterval(eintrag.timer);
		aktiveSchleifen.delete(kanalId);
	}
}

/** Periodischer Anstoss für einen Kanal (`onMount`/`onDestroy` ODER den
 *  App-Start). Gibt eine Stopp-Funktion zurück — dasselbe Muster wie
 *  `festigung.ts::starteFestigungsSchleife`, hier zusätzlich referenzgezählt
 *  (s. `aktiveSchleifen` oben): ein zweiter Aufruf für denselben Kanal
 *  startet KEINE zweite Schleife, sondern hängt sich an die bestehende an. */
export function starteKanalFestigungsSchleife(kanalId: string, intervalMs = 30_000): () => void {
	const bestehend = aktiveSchleifen.get(kanalId);
	if (bestehend) {
		bestehend.referenzen += 1;
		return () => stoppeReferenz(kanalId);
	}
	const eintrag = {
		timer: null as unknown as ReturnType<typeof setInterval>,
		laufend: false,
		referenzen: 1,
	};
	eintrag.timer = setInterval(() => {
		if (eintrag.laufend) return;
		eintrag.laufend = true;
		void festigeKanalEinmal(kanalId).finally(() => {
			eintrag.laufend = false;
		});
	}, intervalMs);
	aktiveSchleifen.set(kanalId, eintrag);
	// Sofort einen ersten Durchlauf anstossen, statt bis zum ersten Intervall
	// zu warten — sonst wartet ein frisch verbundener Besitzer bis zu
	// `intervalMs` auf die erste Festigung.
	void festigeKanalEinmal(kanalId);
	return () => stoppeReferenz(kanalId);
}

/**
 * Startet die Festigungsschleife für JEDEN Kanal, den dieses Gerät besitzt
 * (`ablageVerbindungen`, Feld `fuerKanal` — gesetzt genau dann, wenn dieses
 * Gerät den Kanalordner verbunden hat, s. `KanalDateiablageVerbinden.svelte`).
 *
 * **Aufrufstelle: App-Start** (`routes/app/+layout.svelte`), damit die
 * Festigung eines Besitzer-Geräts läuft, ohne dass der Besitzer je die
 * Kanal-Einstellungen öffnet — genau die Lücke, die diese Datei ohne diesen
 * Aufruf hätte (bis dahin startete die Schleife ausschliesslich, solange
 * `KanalDateiablageVerbinden.svelte` gemountet war). Dank der Referenzzählung
 * in `starteKanalFestigungsSchleife` addiert ein späteres Öffnen der
 * Kanal-Einstellungen für denselben Kanal nur eine weitere Referenz, statt
 * eine zweite Schleife zu starten.
 */
export async function starteAlleKanalFestigungsSchleifen(): Promise<() => void> {
	if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
	const stops = ablageVerbindungen.verbindungen
		.filter((v) => !!v.fuerKanal)
		.map((v) => starteKanalFestigungsSchleife(v.fuerKanal as string));
	return () => {
		for (const stop of stops) stop();
	};
}
