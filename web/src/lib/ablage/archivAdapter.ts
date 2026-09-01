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
 * **`lösche` fehlt bewusst, und zwar auf beiden Wegen gleich.** Ein Archiv,
 * aus dem der Server löschen kann, ist kein Archiv — serverseitig gibt es
 * dafür keine Route. Der `DateiSpeicher` kommt ohne aus; wer später ein
 * Aufräumen baut, entscheidet dann bewusst, wer dabei löschen darf.
 */

import type { AblageAdapter } from './adapter.ts';
import { archivAbruf, archivListe, archivSchreiben } from '../api/ablageArchiv';

/** Ob dieser Anbieter aus dem Browser heraus direkt erreichbar ist. */
export function direktErreichbar(anbieter: string): boolean {
	return anbieter === 'sync_ordner';
}

/**
 * Der Adapter, der über die `/ablage/archiv/*`-Routen läuft.
 *
 * Er umschliesst nichts: für eine Cloud gibt es aus dem Browser keinen
 * zweiten Weg, auf den man zurückfallen könnte. Ein Rückfall wäre hier
 * Selbstbetrug — er sähe aus wie Vorsicht und wäre nur ein Umweg über einen
 * Aufruf, von dem wir wissen, dass er scheitert.
 */
export function archivUeberPulse(): AblageAdapter {
	return {
		schreibe: (datei, inhalt) => archivSchreiben(datei, inhalt),
		lese: (datei) => archivAbruf(datei),
		liste: () => archivListe()
	};
}
