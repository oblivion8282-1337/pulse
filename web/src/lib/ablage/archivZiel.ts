/**
 * Was der Pulse-Server als Archiv-Adresse halten soll — die reine Rechnung.
 *
 * **Warum es diese Frage gibt.** Das persönliche Archiv wird lokal markiert,
 * die Adresse liegt aber beim Server: nur er kann in eine fremde Cloud
 * schreiben (CORS, an einer echten Nextcloud gemessen — Begründung im Kopf
 * von `api/ablageArchiv.ts`). Zwei Stände, die auseinanderlaufen können —
 * und am 2026-09-01 auch liefen: das Trennen einer Verbindung war rein
 * lokal, die Adresse blieb serverseitig für immer stehen. Folge, gemessen
 * im Zwei-Browser-Nachweis: `GET /postfach/anhaenge/bereitschaft` meldete
 * weiter „kann empfangen", der Anhang-Knopf blieb beim Gegenüber sichtbar,
 * und die Verteilung hätte in einen Ordner geschrieben, den der Nutzer
 * abgehängt und in seiner Cloud womöglich längst widerrufen hat.
 *
 * Die Rechnung ist deshalb bewusst als EINE Funktion über den GANZEN
 * Verbindungsstand formuliert, nicht als „was tut dieser Klick": jeder
 * Aufrufer stellt damit dieselbe Zusicherung her — der Server hält die
 * Adresse des aktuellen Cloud-Archivs, oder gar keine.
 *
 * **Importfrei** (CLAUDE.md, `pnpm test:unit`): `verbindungen.svelte.ts`
 * legt beim Import Runes an, `archivAdapter.ts` zieht über die API-Schicht
 * `$lib`-Aliase herein — beides reisst Nodes Testläufer ab. Deshalb wohnt
 * `direktErreichbar` seit dem 2026-09-01 hier und wird von `archivAdapter.ts`
 * nur noch weitergereicht; eine zweite Kopie wäre genau die Streuung, vor
 * der CLAUDE.md warnt.
 */

/**
 * Ob dieser Anbieter aus dem Browser heraus direkt erreichbar ist.
 *
 * Nur der Sync-Ordner: er liegt auf dieser Platte, dorthin schreibt der
 * Browser selbst. Jede Cloud ist eine fremde Gegenstelle ohne
 * CORS-Kopfzeilen und braucht den Umweg über Pulse.
 */
export function direktErreichbar(anbieter: string): boolean {
	return anbieter === 'sync_ordner';
}

export interface ArchivSicht {
	id: string;
	anbieter: string;
	istArchiv?: boolean;
	konfiguration?: Record<string, string>;
}

/**
 * `entfernen` trägt seinen Grund mit, weil die Oberfläche zwei davon
 * verschieden behandeln muss: `ohne-adresse` ist ein Fehler des Nutzers
 * (dieses Laufwerk kann Pulse gar nicht ansprechen) und braucht eine
 * sichtbare Zeile, `keins` und `lokal` sind vollkommen normale Zustände.
 */
export type ArchivZiel =
	| { art: 'setzen'; adresse: string }
	| { art: 'entfernen'; grund: 'keins' | 'lokal' | 'ohne-adresse' };

/**
 * Die Adresse, die der Server nach diesem Verbindungsstand halten soll.
 *
 * Drei Wege führen zu „entfernen", und alle drei sind echte Zustände, keine
 * Sonderfälle: gar kein Archiv markiert (`keins`), ein lokaler Ordner als
 * Archiv (`lokal` — dort schreibt der Browser selbst, der Server hat dort
 * nichts zu suchen) und ein Cloud-Laufwerk ohne ansprechbare Basis-Adresse
 * (`ohne-adresse`, z. B. ein OAuth-Anbieter, dessen Zugang Pulse heute
 * nicht verwahrt). Im letzten Fall wird die alte Adresse trotzdem
 * weggeworfen: eine stehengelassene zeigte auf ein Laufwerk, das gar nicht
 * mehr das Archiv ist.
 */
export function archivZiel(verbindungen: readonly ArchivSicht[]): ArchivZiel {
	const archiv = verbindungen.find((v) => v.istArchiv === true);
	if (!archiv) return { art: 'entfernen', grund: 'keins' };
	if (direktErreichbar(archiv.anbieter)) return { art: 'entfernen', grund: 'lokal' };
	const adresse = archiv.konfiguration?.basis ?? '';
	if (!adresse) return { art: 'entfernen', grund: 'ohne-adresse' };
	return { art: 'setzen', adresse };
}
