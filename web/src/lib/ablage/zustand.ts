/**
 * Die Einstufung einer Ablage-Verbindung — aus Rohwerten wird EIN Zustand,
 * den die Einstellungs-Zeile anzeigt.
 *
 * Warum das eine eigene, importfreie Datei ist: die Rechnung ist der Teil,
 * der falsch sein kann, und sie soll ohne Browser pruefbar sein (s. CLAUDE.md
 * zur Falle bei `pnpm test:unit`). Die Anzeige daneben ist Geschmack, diese
 * Reihenfolge ist es nicht.
 *
 * **Der eigentliche Zweck ist der haeufigste Dauerfehler dieser Bauart:** ein
 * abgelaufener Zugang, den niemand bemerkt, waehrend seit Tagen nichts mehr
 * gesichert wird. Ohne eine Zeile, die das sagt, faellt es erst auf, wenn
 * jemand seinen Verlauf sucht.
 */

export type VerbindungsZustand =
	/** Alles gesichert, nichts steht an. */
	| 'gut'
	/** Es laeuft, aber es steht noch etwas aus. */
	| 'hinterher'
	/** Der Zugang ist abgelaufen und liess sich nicht auffrischen. */
	| 'anmeldung-abgelaufen'
	/** Ziel nicht erreichbar: Ordner geloescht, Freigabe entzogen. */
	| 'laufwerk-weg'
	/** Der Anbieter meldet zu wenig Platz fuer das, was aussteht. */
	| 'kein-platz';

export interface VerbindungsRohwerte {
	/** Die Auffrischung ist endgueltig gescheitert (`AnmeldungAbgelaufenFehler`). */
	anmeldungAbgelaufen: boolean;
	/** Der Zielordner war beim letzten Versuch nicht da. */
	laufwerkWeg: boolean;
	/** Freier Platz in Bytes — `null`, wenn der Anbieter ihn nicht meldet. */
	freieBytes: number | null;
	/** Was das Sichern des Ausstehenden ungefaehr braucht. */
	benoetigteBytes: number;
	/** Wie viele Eintraege noch nicht gesichert sind. */
	ausstehend: number;
}

/**
 * Die Reihenfolge, und warum sie so ist — das ist der Kern dieser Datei.
 *
 * 1. **`anmeldung-abgelaufen` zuerst**, obwohl `laufwerk-weg` genauso hart
 *    blockiert. Der Grund ist nicht Dringlichkeit, sondern Verlaesslichkeit:
 *    ohne gueltigen Zugang bekommt der Klient auf JEDE Frage eine 401 — auch
 *    auf „gibt es den Ordner noch?". Ein gleichzeitig gemeldetes
 *    `laufwerkWeg` ist dann ein Messwert aus einer Zeit, in der die Anmeldung
 *    noch galt, also womoeglich veraltet. Erst neu anmelden, dann weitersehen.
 * 2. `laufwerk-weg` — ohne Ziel nuetzt der beste Zugang nichts.
 * 3. `kein-platz` — Zugang und Ziel stehen, nur das Schreiben scheitert.
 * 4. `hinterher` — es laeuft, es dauert nur.
 * 5. `gut`.
 *
 * `kein-platz` wird nur gemeldet, wenn der Anbieter den freien Platz
 * wirklich nennt. Aus einem fehlenden Wert „vermutlich voll" zu machen waere
 * eine Warnung, die niemand ueberpruefen kann — und die deshalb bald
 * uebersehen wird.
 */
export function stufeEin(roh: VerbindungsRohwerte): VerbindungsZustand {
	if (roh.anmeldungAbgelaufen) return 'anmeldung-abgelaufen';
	if (roh.laufwerkWeg) return 'laufwerk-weg';
	if (roh.freieBytes !== null && roh.benoetigteBytes > roh.freieBytes) return 'kein-platz';
	if (roh.ausstehend > 0) return 'hinterher';
	return 'gut';
}

/** Braucht dieser Zustand einen Handgriff des Nutzers? */
export function brauchtHandgriff(zustand: VerbindungsZustand): boolean {
	return (
		zustand === 'anmeldung-abgelaufen' ||
		zustand === 'laufwerk-weg' ||
		zustand === 'kein-platz'
	);
}
