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
import { archivAbruf, archivListe, archivLoeschen, archivSchreiben } from '../api/ablageArchiv';
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
export function archivUeberPulse(): AblageAdapter {
	return {
		schreibe: (datei, inhalt) => mitGeduldBei429(() => archivSchreiben(datei, inhalt)),
		lese: (datei) => mitGeduldBei429(() => archivAbruf(datei)),
		liste: () => mitGeduldBei429(() => archivListe()),
		lösche: (datei) => mitGeduldBei429(() => archivLoeschen(datei))
	};
}
