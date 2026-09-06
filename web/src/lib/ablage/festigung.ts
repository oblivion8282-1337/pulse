/**
 * Die Festigung — Etappe E8, Aufgabe 3. Laeuft auf dem Geraet des
 * Community-Besitzers: holt, was im Zwischenlager liegt, schreibt es ins
 * Laufwerk, quittiert erst DANACH — Reihenfolge ist der ganze Punkt (Auftrag
 * E8: eine Quittung nach fehlgeschlagenem Schreiben waere endgueltiger
 * Verlust, derselbe Fehler wie beim Bughunt 2026-08-28, dieselbe Regel wie
 * `verlaufSpeichernPflicht`).
 *
 * Ein Eintrag je Datei, kein Wasserzeichen (jeder Zwischenlager-Eintrag wird
 * bei jedem Durchlauf erneut versucht, keiner faellt unter den Tisch, weil ein
 * juengerer erfolgreich war), Backoff mit Deckel, Head-of-Line-Schutz (ein
 * haengender Eintrag blockiert die anderen nicht — `Promise.allSettled` statt
 * einer Schleife, die bei der ersten Ablehnung abbricht).
 *
 * **Nur das Besitzer-Geraet ruft das auf.** Es erkennt sich selbst daran,
 * dass es lokal eine `AblageVerbindung` mit `fuerGuild === guildId` hat
 * (`verbindungen.svelte.ts`) — genau die Verbindung, die beim Verbinden des
 * Laufwerks entsteht (`CommunityDateiablage.svelte`). Ein Mitglied ohne diese
 * Markierung ruft `festigeEinmal` nie auf; selbst wenn doch, liefe der Aufruf
 * ins Leere (keine lokale Verbindung -> sofortiger Ruecksprung).
 */

import { öffneDateiContainer } from './dateiablage.ts';
import { ablageVerbindungen } from './verbindungen.svelte.ts';
import { ablageGuildApi } from '../api/ablageGuild.ts';
import { base64ZuBytes } from './syncOrdnerSchluessel.ts';
import { backoffDeckel } from './backoffDeckel.ts';

/** Backoff mit Deckel — je fehlgeschlagenem Versuch eines Eintrags in DIESEM
 *  Prozess (nicht persistiert: ein Neuladen der Seite startet bei 0, das ist
 *  hier unschaedlich, weil der naechste periodische Durchlauf ohnehin wieder
 *  jeden offenen Eintrag sieht — anders als bei Nachrichten gibt es hier
 *  keine Reihenfolge, die ein Ueberholen verbieten wuerde). */
const deckel = backoffDeckel();

async function festigeEinenEintrag(
	guildId: string,
	eintragId: string,
): Promise<void> {
	const verbindung = ablageVerbindungen.verbindungFürGuild(guildId);
	if (!verbindung) return; // dieses Geraet ist nicht der Besitzer — nichts zu tun
	const hauptschlüssel = base64ZuBytes(verbindung.hauptschlüsselB64);

	const { url } = await ablageGuildApi.zwischenlagerDownloadUrl(guildId, eintragId);
	const antwort = await fetch(url);
	if (!antwort.ok) throw new Error(`Zwischenlager-Download fehlgeschlagen: ${antwort.status}`);
	const container = new Uint8Array(await antwort.arrayBuffer());

	// Der Kopf wird kurz entschluesselt, um Name/MIME/Groesse fuer den
	// Verzeichniseintrag zu kennen — der Inhalt bleibt Chiffrat, s. Modulkopf
	// von `dateispeicher.ts::festigeVorverschlüsseltenContainer`.
	const geöffnet = await öffneDateiContainer(hauptschlüssel, container);

	const speicher = await ablageVerbindungen.dateiSpeicherFür(verbindung.id);
	if (!speicher) throw new Error('kein Laufwerks-Zugang auf diesem Geraet');

	// ERST schreiben — s. Modulkopf.
	await speicher.festigeVorverschlüsseltenContainer(eintragId, container, {
		name: geöffnet.kopf.name,
		mime: geöffnet.kopf.mime,
		groesse: geöffnet.kopf.groesse,
		hochgeladenAm: geöffnet.kopf.hochgeladenAm,
		hochgeladenVon: geöffnet.kopf.hochgeladenVon,
	});
	// DANN quittieren.
	await ablageGuildApi.zwischenlagerQuittieren(guildId, eintragId);
}

export interface FestigungsErgebnis {
	erledigt: number;
	fehlgeschlagen: number;
}

/** Ein Durchlauf: alle faelligen Zwischenlager-Eintraege der Community
 *  versuchen. Ohne lokale Laufwerks-Verbindung fuer diese Guild sofortiger
 *  No-Op (kein Netzaufruf) — dieses Geraet ist dann kein Besitzer-Geraet. */
export async function festigeEinmal(guildId: string): Promise<FestigungsErgebnis> {
	if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
	if (!ablageVerbindungen.verbindungFürGuild(guildId)) {
		return { erledigt: 0, fehlgeschlagen: 0 };
	}

	const liste = await ablageGuildApi.zwischenlagerListe(guildId);
	const faellig = liste.filter((e) => deckel.istFaellig(e.id));

	const ergebnisse = await Promise.allSettled(
		faellig.map((e) => festigeEinenEintrag(guildId, e.id)),
	);

	let erledigt = 0;
	let fehlgeschlagen = 0;
	ergebnisse.forEach((ergebnis, i) => {
		const id = faellig[i].id;
		if (ergebnis.status === 'fulfilled') {
			deckel.vermerkeErfolg(id);
			erledigt++;
		} else {
			deckel.vermerkeFehlschlag(id);
			fehlgeschlagen++;
		}
	});
	return { erledigt, fehlgeschlagen };
}

/** Periodischer Anstoss fuer eine Community-Ansicht (`onMount`/`onDestroy`).
 *  Gibt eine Stopp-Funktion zurueck. */
export function starteFestigungsSchleife(guildId: string, intervalMs = 30_000): () => void {
	let gestoppt = false;
	let laufend = false;
	const timer = setInterval(() => {
		if (laufend || gestoppt) return;
		laufend = true;
		void festigeEinmal(guildId).finally(() => {
			laufend = false;
		});
	}, intervalMs);
	// Sofort einen ersten Durchlauf anstossen, statt bis zum ersten Intervall
	// zu warten — sonst wartet ein frisch verbundener Besitzer bis zu
	// `intervalMs` auf die erste Festigung.
	void festigeEinmal(guildId);
	return () => {
		gestoppt = true;
		clearInterval(timer);
	};
}
