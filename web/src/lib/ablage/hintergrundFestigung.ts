/**
 * Der Hintergrund-Läufer: sichert die Laufwerke des angemeldeten Kontos,
 * unabhängig davon, welche Seite gerade offen ist.
 *
 * **Der Fehler, gegen den er gebaut ist — und was NICHT der Fehler war.**
 * Ein App-weiter Start gab es schon (`starteAlleKanalFestigungsSchleifen`,
 * gerufen im `onMount` von `routes/app/+layout.svelte`). Er sah aber
 * **genau einmal** nach, beim Betreten der App. Ein Laufwerk, das WÄHREND
 * der Sitzung verbunden wird, kannte er deshalb nicht; für dieses eine
 * Laufwerk lief die Festigung nur, solange der Laufwerk-Reiter offen blieb,
 * denn `KanalDateiablageVerbinden.svelte` stoppt seine Schleife beim
 * Verlassen der Seite. An einer echten Nextcloud nachgemessen (2026-09-01):
 * Kanal angelegt, Laufwerk verbunden, verschlüsselte Nachricht zugestellt
 * und gelesen — und der Ordner blieb **leer**. Ein Neuladen der App hätte
 * geholfen, was den Fehler besonders unauffällig macht: wer ihn sucht,
 * lädt neu, und danach funktioniert es.
 *
 * **Communities waren härter betroffen.** Für sie gab es gar keinen
 * App-weiten Start, nur den in `CommunityDateiablage.svelte`. Deshalb
 * behandelt dieser Läufer beide Arten und ersetzt die alte, nur einmal
 * laufende Funktion.
 *
 * **Die Komponenten behalten ihre eigenen Schleifen.** Das ist kein
 * Versehen: `starteKanalFestigungsSchleife` zählt Referenzen, ein zweiter
 * Halter kostet also nichts, und die Ansicht soll unmittelbar nach dem
 * Verbinden loslegen, ohne auf den nächsten Rundgang hier zu warten.
 * (`starteFestigungsSchleife` für Communities zählt NICHT mit — dort laufen
 * kurzzeitig zwei Zeitgeber nebeneinander, wenn die Ansicht offen ist. Das
 * ist verschwenderisch, aber nicht falsch: `festigeEinmal` schützt sich
 * selbst gegen Überlappung. Wer es aufräumt, rüstet dort dieselbe
 * Referenzzählung nach.)
 *
 * **Warum ein Rundgang und keine Reaktivität.** Der Läufer sieht alle 30
 * Sekunden nach, statt am `$state` des Verbindungs-Speichers zu hängen. Eine
 * Rune hier hiesse `.svelte.ts` und damit ein Modul, das Nodes Testläufer
 * nicht mehr anfassen kann; die eigentliche Rechnung liegt deshalb
 * importfrei in `festigungsPlan.ts`, und dieses Modul ist nur noch
 * Verdrahtung. Ein halbminütiger Verzug beim Erkennen eines NEUEN Laufwerks
 * fällt nicht auf — die Ansicht, über die man es verbindet, startet ihre
 * eigene Schleife ohnehin sofort.
 */

import { ablageVerbindungen } from './verbindungen.svelte';
import { starteKanalFestigungsSchleife } from './kanalFestigung.ts';
import { starteFestigungsSchleife } from './festigung.ts';
import { planeFestigung, zielSchluessel, type FestigungsZiel } from './festigungsPlan.ts';

const RUNDGANG_MS = 30_000;

/** Schlüssel -> Stopper der laufenden Schleife. */
const laufend = new Map<string, () => void>();
let rundgang: ReturnType<typeof setInterval> | null = null;

function starte(ziel: FestigungsZiel): void {
	const stopper =
		ziel.art === 'kanal'
			? starteKanalFestigungsSchleife(ziel.id)
			: starteFestigungsSchleife(ziel.id);
	laufend.set(zielSchluessel(ziel), stopper);
}

async function rundgangEinmal(): Promise<void> {
	if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
	const plan = planeFestigung(ablageVerbindungen.verbindungen, new Set(laufend.keys()));
	for (const ziel of plan.zuStoppen) {
		const schluessel = zielSchluessel(ziel);
		laufend.get(schluessel)?.();
		laufend.delete(schluessel);
	}
	for (const ziel of plan.zuStarten) starte(ziel);
}

/**
 * Startet den Läufer. Mehrfaches Rufen ist folgenlos — die App darf ihn
 * anstossen, sooft ein Konto anmeldet, ohne mitzuzählen.
 *
 * Gibt einen Stopper zurück, der alle Schleifen beendet: beim Abmelden muss
 * das passieren, sonst schriebe das Gerät weiter auf ein Laufwerk, dessen
 * Besitzer gerade gegangen ist.
 */
export function starteHintergrundFestigung(): () => void {
	if (rundgang === null) {
		void rundgangEinmal();
		rundgang = setInterval(() => void rundgangEinmal(), RUNDGANG_MS);
	}
	return stoppeHintergrundFestigung;
}

export function stoppeHintergrundFestigung(): void {
	if (rundgang !== null) {
		clearInterval(rundgang);
		rundgang = null;
	}
	for (const stopper of laufend.values()) stopper();
	laufend.clear();
}
