/**
 * Der Adapter des persönlichen Archivs — je nach Ziel direkt oder über Pulse.
 *
 * **Die eine Fallunterscheidung, die es hier gibt.** Ein Sync-Ordner liegt
 * auf dieser Platte; dorthin schreibt der Browser selbst, ohne fremden
 * Server, ohne CORS. Eine Cloud dagegen ist eine fremde Gegenstelle, und
 * deren Server setzt keine CORS-Kopfzeilen — der direkte Weg bricht dort ab,
 * bevor ein Byte fliesst (an einer echten Nextcloud gemessen, s.
 * `api/ablageArchiv.ts`).
 *
 * Deshalb: lokaler Ordner direkt, alles andere über den Pulse-Server. Das
 * ist keine Optimierung, sondern der Unterschied zwischen „funktioniert" und
 * „funktioniert nicht".
 *
 * **Der Server sieht nur Chiffrat.** Verschlüsselt wird eine Schicht darüber
 * (`DateiSpeicher` mit dem Hauptschlüssel der Verbindung); dieser Adapter
 * bekommt bereits verschlüsselte Bytes und reicht sie durch.
 *
 * **`lösche` gibt es seit dem 2026-09-02.** Vorher stand hier: „Ein Archiv,
 * aus dem der Server löschen kann, ist kein Archiv." Der Satz hielt nicht,
 * was er behauptete — derselbe Server durfte immer schon überschreiben.
 * Gebraucht wird das Löschen von der Sicherung, die seit diesem Tag über
 * dieselbe Adresse läuft (`sicherung/ziele.ts`): eine gelöschte Nachricht
 * nimmt ihre Anhang-Datei mit, ein entferntes Gespräch seinen Ordner.
 */

import type { AblageAdapter } from './adapter.ts';
import {
	archivAbruf,
	archivLaufwerkSetzen,
	archivListe,
	archivLoeschen,
	archivSchreiben
} from '../api/ablageArchiv';
import { ApiError } from '../api/client';
import { mitGeduldBei429 } from './geduld429.ts';

/**
 * Weitergereicht aus `archivZiel.ts` — die Antwort wird auch dort gebraucht,
 * wo dieses Modul nicht geladen werden kann (Nodes Testläufer stolpert über
 * die `$lib`-Aliase der API-Schicht). Eine Kopie hier wäre eine zweite
 * Wahrheit; der Re-Export hält es bei einer.
 */
export { direktErreichbar } from './archivZiel.ts';

/**
 * Der Adapter, der über die `/ablage/archiv/*`-Routen läuft.
 *
 * Er umschliesst nichts: für eine Cloud gibt es aus dem Browser keinen
 * zweiten Weg, auf den man zurückfallen könnte. Ein Rückfall wäre hier
 * Selbstbetrug — er sähe aus wie Vorsicht und wäre nur ein Umweg über einen
 * Aufruf, von dem wir wissen, dass er scheitert.
 *
 * **Bei 429 wartet er** (`geduld429.ts`): der Server begrenzt je Nutzer und
 * Minute, und die Sicherung schreibt ihre Erstsicherung in einem Schub.
 */
export function archivUeberPulse(adresse?: string): AblageAdapter {
	const heilend = <T>(aufruf: () => Promise<T>) =>
		mitGeduldBei429(() => mitLaufwerkNachtragen(adresse, aufruf));
	return {
		schreibe: (datei, inhalt) => heilend(() => archivSchreiben(datei, inhalt)),
		lese: (datei) => heilend(() => archivAbruf(datei)),
		liste: () => heilend(() => archivListe()),
		lösche: (datei) => heilend(() => archivLoeschen(datei))
	};
}

/** Läuft je Sitzung höchstens einmal — ein Laufwerk, das der Server auch nach
 *  dem Nachtragen nicht kennt, ist ein echter Fehler und keine Lücke. */
let nachgetragen = false;

/**
 * **Trägt das Laufwerk bei der Cloud nach, wenn sie es nicht kennt.**
 *
 * Bis zum 2026-09-03 ging jeder Aufruf der Archiv-Routen an den AKTIVEN
 * Server (`api/ablageArchiv.ts`, dort steht der Grund). Wer sein Archiv mit
 * aktivem Self-Host eingerichtet hat, hat die Freigabe-Adresse damit auf dem
 * Self-Host hinterlegt — die Cloud, die seither zuständig ist, hat sie nie
 * gesehen und antwortet auf alles mit 404 „no archive drive connected".
 * Nachgezählt am Tag der Umstellung: null Einträge in der Cloud-Tabelle,
 * bei laufender Sicherung. Der Klient kennt die Adresse aber (sie steht in
 * seiner Verbindung), also trägt er sie beim ersten 404 selbst nach und
 * wiederholt den Aufruf — statt den Nutzer in die Einstellungen zu schicken,
 * um etwas zu speichern, das er längst gespeichert hat.
 *
 * Ein 404 kann auch „Datei nicht da" heißen (`archivAbruf` liefert dafür
 * `null`, wirft also nicht) — hier landet nur das 404 der Laufwerksprüfung.
 */
async function mitLaufwerkNachtragen<T>(adresse: string | undefined, aufruf: () => Promise<T>) {
	try {
		return await aufruf();
	} catch (e) {
		if (!adresse || nachgetragen || !(e instanceof ApiError) || e.status !== 404) throw e;
		nachgetragen = true;
		await archivLaufwerkSetzen(adresse);
		return await aufruf();
	}
}
