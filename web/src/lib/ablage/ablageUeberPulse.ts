/**
 * Ein Adapter, der Schreiben, Lesen und Auflisten über den Pulse-Server
 * führt — der Weg des Besitzer-Geräts beim Festigen.
 *
 * **Das Gegenstück zu `direktMitRueckfall.ts`**, und die beiden ergeben erst
 * zusammen den Entwurf: dort fällt `lese()` auf die Weiterreich-Route
 * zurück, wenn der direkte Weg abprallt — hier geht `schreibe()` gar nicht
 * erst direkt. Denn ein Rückfall setzt voraus, dass man den Fehlschlag
 * bemerkt, und beim Schreiben ist genau das nicht gegeben: der Browser
 * bricht bei fehlender CORS-Freigabe zwar ab, aber die Festigung lief in
 * einer Hintergrundschleife, die den Fehler schluckte. Ergebnis war ein
 * Cloud-Ordner, der leer blieb, ohne dass irgendwo etwas rot wurde.
 *
 * **Warum nicht „direkt versuchen, dann über Pulse"** wie beim Lesen: weil
 * ein halb gelungener Schreibvorgang schlimmer ist als gar keiner. Beim
 * Lesen kostet ein vergeblicher erster Versuch eine Millisekunde; beim
 * Schreiben wüsste man nach einem Abbruch nicht, ob die Gegenstelle die
 * Datei schon angelegt hat. Der Weg über Pulse ist deshalb nicht der
 * Rückfall, sondern der Weg (Entwurf §1, §4.0a).
 *
 * **Auch Lesen und Auflisten gehen hier über den Server**, obwohl der
 * Entwurf Lesen direkt erlaubt. Beim Besitzer-Gerät ist der direkte Weg
 * nämlich derselbe, der beim Schreiben scheitert — dieselbe Cloud, dieselbe
 * fehlende CORS-Freigabe. Ein Versuch über den kurzen Weg kostete hier also
 * nur Zeit und eine rote Zeile in der Konsole. `direktMitRueckfall.ts` bleibt
 * der richtige Weg für LESENDE Mitglieder, die auf eine Cloud treffen können,
 * welche CORS erlaubt.
 *
 * **`lösche()` bleibt beim eingeschlossenen Adapter** — dafür gibt es keine
 * Route, und der Schreibweg braucht es nicht (`schreiber.ts` benutzt
 * `schreibe` und `lese`, `nachzug.ts` zusätzlich `liste`). Wer einen
 * Aufräum-Lauf baut, läuft in dieselbe Wand und braucht dann seine eigene
 * Route; deshalb steht es hier benannt statt zu fehlen.
 */

import type { AblageAdapter } from './adapter.ts';
import { ablageKanalAbruf, ablageKanalListe, ablageKanalSchreiben } from '../api/ablageKanal';

/**
 * Umschliesst `direkt` so, dass alles bis auf `lösche` über die
 * `/channels/<kanalId>/ablage/*`-Routen läuft.
 *
 * Nur der Ersteller des Laufwerks darf dort schreiben — genau das Gerät
 * also, das auch festigt. Ein anderes Mitglied bekäme 403, und das ist
 * richtig so: der Ordner kennt keine Versionen.
 */
export function ueberPulse(direkt: AblageAdapter, kanalId: string): AblageAdapter {
	return {
		schreibe: (datei, inhalt) => ablageKanalSchreiben(kanalId, datei, inhalt),
		lese: (datei) => ablageKanalAbruf(kanalId, datei),
		liste: () => ablageKanalListe(kanalId),
		// Siehe Modulkopf: bewusst der direkte Weg.
		lösche: direkt.lösche ? (datei) => direkt.lösche!(datei) : undefined
	};
}
