/**
 * Den Verlauf aus dem Archiv zurück auf dieses Gerät holen.
 *
 * **Das fehlende Stück.** Der Wiederherstellungscode brachte bisher nur die
 * VERBINDUNGEN und Schlüssel zurück (`krypto/wiederherstellung.svelte.ts`) —
 * danach stand ein Gerät mit einem geöffneten Archiv da und einem leeren
 * Chat. Der Zweck des Ganzen ist aber genau der Schritt danach: „ich melde
 * mich an einem anderen Rechner an und habe meinen Verlauf wieder".
 *
 * **Warum das hier NICHT `verlaufSpeichern` ruft.** Jene Funktion schreibt
 * nur für Kanäle, die das Gerät bereits kennt (`istLokalerKanal`: DM-Liste,
 * private Gruppen, Ablage-Kanäle). Auf einem frischen Gerät ist diese Liste
 * leer — der zurückgeholte Verlauf wäre stillschweigend verworfen worden,
 * und niemand hätte gesehen, warum. Beim Wiederherstellen ist das ARCHIV
 * die Autorität darüber, welche Kanäle es gibt; deshalb geht dieser Weg
 * direkt auf den Speicher (`verlaufPutSaetze`).
 *
 * **Bestehendes wird nicht überschrieben, sondern ergänzt.** Der
 * Primärschlüssel eines Satzes ist `kanalId + nachrichtId`; ein zweiter
 * Durchlauf legt dieselbe Nachricht also wieder auf sich selbst. Das macht
 * die Wiederherstellung wiederholbar — sie darf abbrechen und neu
 * beginnen, ohne Doppel zu erzeugen.
 *
 * **Fehlerhafte Einträge halten den Lauf nicht an.** Ein Archiv ist über
 * Jahre gewachsen und kann eine unlesbare Datei enthalten. Sie wird gezählt
 * und übersprungen — der Rest kommt zurück. Alles andere hiesse: eine
 * kaputte Datei kostet den ganzen Verlauf.
 */

import { dekodiereArchivSatz } from './archivSatz.ts';
import type { DateiSpeicher } from './verbindungen.svelte';
import { sortierSchluessel } from '../verlauf/satz';
import { verlaufPutSaetze } from '../verlauf/db';
import type { Satz } from '../verlauf/schema';

export interface RueckwegBericht {
	/** Dateien im Archiv, die als Verlaufssatz erkannt wurden. */
	gefunden: number;
	/** Davon erfolgreich in den lokalen Speicher geschrieben. */
	zurueckgeholt: number;
	/** Unlesbare oder unvollständige Einträge — übersprungen, s. Modulkopf. */
	uebersprungen: number;
}

/** Wieviele Sätze in einem Rutsch geschrieben werden. Gross genug, dass ein
 *  grosses Archiv nicht in tausend Transaktionen zerfällt; klein genug, dass
 *  ein Abbruch nicht alles verliert — und dass der Fortschritt zwischendurch
 *  sichtbar werden kann. */
const BUENDEL = 200;

/**
 * Liest alles, was im Archiv als Verlaufssatz liegt, und legt es lokal ab.
 *
 * `kontoId` stempelt jeden Satz auf das angemeldete Konto — ohne diesen
 * Stempel findet ihn kein Lesepfad je wieder (`verlauf/kontoFilter.ts`
 * lehnt einen Satz ohne Konto fail-closed ab). Der Aufrufer übergibt ihn,
 * damit diese Datei nicht selbst am Anmeldezustand hängt.
 *
 * `melde` wird nach jedem Bündel gerufen — ein Archiv mit zehntausend
 * Nachrichten braucht sonst Minuten, in denen die Oberfläche nichts sagen
 * kann.
 */
export async function holeVerlaufAusArchiv(
	speicher: DateiSpeicher,
	kontoId: string,
	melde?: (bericht: RueckwegBericht) => void
): Promise<RueckwegBericht> {
	const bericht: RueckwegBericht = { gefunden: 0, zurueckgeholt: 0, uebersprungen: 0 };
	await speicher.laden();
	const dateien = await speicher.liste();

	let buendel: Satz[] = [];
	const schreibeBuendel = async (): Promise<void> => {
		if (buendel.length === 0) return;
		await verlaufPutSaetze(buendel);
		bericht.zurueckgeholt += buendel.length;
		buendel = [];
		melde?.({ ...bericht });
	};

	for (const datei of dateien) {
		let inhalt: Uint8Array;
		try {
			inhalt = (await speicher.herunterladen(datei.id)).inhalt;
		} catch {
			// Eine Datei, die sich nicht öffnen lässt (falscher Schlüssel,
			// abgebrochener Upload), ist ein übersprungener Eintrag — kein
			// Grund, die übrigen zu verlieren.
			bericht.uebersprungen += 1;
			continue;
		}
		const satz = dekodiereArchivSatz(inhalt);
		if (satz === null) {
			bericht.uebersprungen += 1;
			continue;
		}
		bericht.gefunden += 1;
		buendel.push({
			schluessel: sortierSchluessel(satz.kanalId, satz.nachrichtId),
			kanalId: satz.kanalId,
			nachrichtId: satz.nachrichtId,
			autorId: satz.autorId,
			inhalt: satz.inhalt,
			erstelltAm: satz.erstelltAm,
			bearbeitetAm: satz.bearbeitetAm,
			geloescht: satz.geloescht,
			verschluesselt: true,
			anhaenge: satz.anhaenge,
			antwortAufId: satz.antwortAufId,
			kryptoId: satz.kryptoId,
			kontoId
		});
		if (buendel.length >= BUENDEL) await schreibeBuendel();
	}
	await schreibeBuendel();
	return bericht;
}
