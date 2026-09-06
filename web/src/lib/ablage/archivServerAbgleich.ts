/**
 * Bringt die serverseitig gemerkte Archiv-Adresse auf den Stand, den
 * `archivZiel.ts` ausgerechnet hat — die eine Stelle, die dafür redet.
 *
 * **Warum das nicht in der Komponente steht:** `SpeicherSektion.svelte`
 * liegt hart an der 250-Zeilen-Grenze für Svelte-Komponenten (PLAN.md
 * §12.1), und die Begründungen hier sind nicht kürzbar, ohne dass sie
 * falsch werden.
 *
 * **Der Text bleibt draussen.** Diese Funktion gibt einen Befund zurück,
 * keinen Satz: die Formulierungen stehen im Paraglide-Katalog, und ein
 * Modul, das Meldungstexte erfindet, umgeht ihn.
 */

import { archivLaufwerkSetzen, archivLaufwerkTrennen } from '../api/ablageArchiv';
import type { ArchivZiel } from './archivZiel.ts';

export type ArchivAbgleich =
	/** Der Server hält jetzt genau das, was er halten soll. */
	| { art: 'ok' }
	/** Adresse ist weg, aber der Nutzer wollte etwas anderes: das gewählte
	 *  Laufwerk hat keine Basis-Adresse, die Pulse ansprechen kann. */
	| { art: 'ohne-adresse' }
	/** Der Server hat nicht quittiert — der Stand ist UNBEKANNT, nicht
	 *  hergestellt. Wer daraufhin lokal weiterräumt, verliert die letzte
	 *  Bedienoberfläche für die stehengebliebene Adresse. */
	| { art: 'fehler'; ziel: ArchivZiel['art']; meldung: string };

export async function gleicheArchivAdresseAb(ziel: ArchivZiel): Promise<ArchivAbgleich> {
	try {
		if (ziel.art === 'setzen') await archivLaufwerkSetzen(ziel.adresse);
		else await archivLaufwerkTrennen();
	} catch (e) {
		return {
			art: 'fehler',
			ziel: ziel.art,
			meldung: e instanceof Error ? e.message : String(e)
		};
	}
	return ziel.art === 'entfernen' && ziel.grund === 'ohne-adresse'
		? { art: 'ohne-adresse' }
		: { art: 'ok' };
}
