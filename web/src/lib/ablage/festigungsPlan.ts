/**
 * Welche Festigungs-Schleifen sollen laufen — die reine Rechnung.
 *
 * Getrennt vom Verdrahten (`hintergrundFestigung.ts`), damit Nodes
 * eingebauter Testläufer sie prüfen kann: **importfrei**, keine Runen, keine
 * Timer (s. CLAUDE.md zur Falle bei `pnpm test:unit`).
 *
 * **Warum es diese Datei gibt.** Bis zum 2026-09-01 wurde die Festigung
 * eines Ablage-Kanals an genau einer Stelle gestartet: in der Komponente des
 * Laufwerk-Reiters, gestoppt beim Verlassen der Seite. Der Verlauf wanderte
 * damit nur in die Cloud, solange der Besitzer diese Einstellungsseite offen
 * hatte — an einer echten Nextcloud nachgemessen, der Ordner blieb nach
 * einem vollständigen Durchlauf leer. Die Kernzusage der Ablage („dein
 * Verlauf liegt auf deinem Laufwerk") war damit im Alltag nicht eingelöst.
 *
 * Der Hintergrund-Läufer nimmt stattdessen alle Laufwerke des angemeldeten
 * Kontos auf. Diese Datei sagt ihm, was sich seit dem letzten Blick geändert
 * hat — als Mengenvergleich, nicht als „alles neu starten": ein Neustart
 * verwürfe den Fortschritt einer gerade laufenden Festigung.
 */

/** Ein laufendes Ziel. `art` trennt die beiden Schleifen-Arten, die
 *  verschiedene Startfunktionen haben; `id` ist Kanal- bzw. Community-Id. */
export interface FestigungsZiel {
	art: 'kanal' | 'guild';
	id: string;
}

/** Nur die Felder, auf die es hier ankommt — bewusst nicht der volle
 *  `AblageVerbindung`-Typ, sonst bräuchte diese Datei einen Import und wäre
 *  nicht mehr direkt prüfbar. */
export interface VerbindungsAuszug {
	fuerKanal?: string | null;
	fuerGuild?: string | null;
}

export interface FestigungsPlan {
	zuStarten: FestigungsZiel[];
	zuStoppen: FestigungsZiel[];
}

/** Der Schlüssel, unter dem ein Ziel geführt wird. `art` gehört dazu: eine
 *  Kanal-Id und eine Community-Id sind beide Snowflakes und könnten sonst
 *  kollidieren, obwohl sie verschiedene Schleifen meinen. */
export function zielSchluessel(ziel: FestigungsZiel): string {
	return `${ziel.art}:${ziel.id}`;
}

/** Die Ziele, die aus den Verbindungen des Kontos folgen.
 *
 * Eine Verbindung kann beides tragen (ein Laufwerk, das einen Kanal UND eine
 * Community sichert) — dann entstehen zwei Ziele. Doppelte Ids über mehrere
 * Verbindungen hinweg werden zusammengefasst: zwei Verbindungen auf denselben
 * Kanal sind ein Bedienfehler, aber kein Grund, zweimal zu schreiben. */
export function zieleAus(verbindungen: readonly VerbindungsAuszug[]): FestigungsZiel[] {
	const gesehen = new Set<string>();
	const ziele: FestigungsZiel[] = [];
	for (const v of verbindungen) {
		for (const ziel of [
			v.fuerKanal ? ({ art: 'kanal', id: v.fuerKanal } as const) : null,
			v.fuerGuild ? ({ art: 'guild', id: v.fuerGuild } as const) : null
		]) {
			if (!ziel) continue;
			const schluessel = zielSchluessel(ziel);
			if (gesehen.has(schluessel)) continue;
			gesehen.add(schluessel);
			ziele.push(ziel);
		}
	}
	return ziele;
}

/**
 * Was seit dem letzten Blick zu starten und zu stoppen ist.
 *
 * `laufend` sind die Schlüssel der aktuell laufenden Schleifen. Ein Ziel, das
 * in beiden Mengen steht, bleibt **unangetastet** — das ist der eigentliche
 * Zweck: die Alternative („stoppe alles, starte alles neu") würde bei jedem
 * Durchlauf eine gerade laufende Festigung abbrechen und ihren Fortschritt
 * verwerfen.
 */
export function planeFestigung(
	verbindungen: readonly VerbindungsAuszug[],
	laufend: ReadonlySet<string>
): FestigungsPlan {
	const ziele = zieleAus(verbindungen);
	const gewuenscht = new Set(ziele.map(zielSchluessel));

	const zuStarten = ziele.filter((z) => !laufend.has(zielSchluessel(z)));
	const zuStoppen: FestigungsZiel[] = [];
	for (const schluessel of laufend) {
		if (gewuenscht.has(schluessel)) continue;
		const [art, ...rest] = schluessel.split(':');
		// Ein Schlüssel, den diese Datei nicht gebildet hat, wird übergangen
		// statt geraten — der Aufrufer hält die Menge, und ein falsch
		// zerlegter Schlüssel stoppte sonst die falsche Schleife.
		if (art !== 'kanal' && art !== 'guild') continue;
		zuStoppen.push({ art, id: rest.join(':') });
	}
	return { zuStarten, zuStoppen };
}
