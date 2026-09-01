/**
 * Der Rückfall-Adapter (Entwurf §4.2): „Der Klient nimmt immer den kurzen
 * Weg und fällt nur bei Bedarf zurück." Ein `AblageAdapter`, der einen
 * echten direkten Adapter (typischerweise `webdavAdapter` mit der eigenen
 * Freigabe-Adresse, s. `webdav.ts`-Kopfkommentar zur gemessenen CORS-Wand)
 * umschliesst und bei `lese()` auf die Weiterreich-Route des Pulse-Servers
 * ausweicht, wenn der direkte Weg abprallt — dasselbe Umschliess-Muster wie
 * `spiegel.ts`, hier für genau einen direkten Weg plus einen Umweg statt für
 * mehrere gleichberechtigte Ziele.
 *
 * **Nur `lese()` fällt zurück.** Schreiben und Löschen bleiben unverändert
 * beim eingeschlossenen Adapter: schreibend läuft der Weg über den Besitzer
 * bzw. über Pulse selbst (§1, §4.0a) — ein schreibender Rückfall wäre ein
 * anderes Feature. Auch `liste()` fällt nicht zurück: die Weiterreich-Route
 * kennt nur `GET` auf einen einzelnen relativen Pfad (`ablage_kanal.py`),
 * kein Verzeichnislisten.
 *
 * **Was zählt als „prallt ab"?** `abprallEntscheidung.ts::istAbprall` — nur
 * ein Netz-/CORS-Fehler (`TypeError` von `fetch()`, ohne Statuscode). Jeder
 * andere Fehlschlag (z. B. `WebdavFehler` bei 401/500) ist eine echte
 * Antwort und wird unverändert weitergeworfen; ein 404 ist bei
 * `AblageAdapter.lese()` ohnehin kein Fehlschlag, sondern `null` — beides
 * löst keinen Rückfall aus.
 *
 * **Gemerkt wird je Ziel, für die Dauer der Sitzung.** Reiner
 * Arbeitsspeicher (Modul-Zustand), bewusst nicht persistiert — derselbe
 * Grund wie bei `spiegel.ts`s Gesund/Hinterher-Markierung: ein Neuladen
 * probiert den direkten Weg noch einmal, was hier sogar erwünscht ist (eine
 * inzwischen gesetzte CORS-Freigabe beim Anbieter soll wieder greifen,
 * sobald die Sitzung neu beginnt). Innerhalb EINER Sitzung legt dagegen
 * bereits der erste Abprall ein Ziel auf den Umweg fest — sonst würde jede
 * weitere Datei erst wieder vergeblich direkt angefragt, bevor sie über
 * Pulse ankommt (Auftrag, Punkt 4). Das ist kein Widerspruch zu „ein
 * einzelner Netzfehler darf nicht dauerhaft festlegen": „dauerhaft" heisst
 * hier über die Sitzung hinaus, und genau das verhindert der reine
 * Arbeitsspeicher — er überlebt weder einen Reload noch eine neue Sitzung.
 */

import type { AblageAdapter } from './adapter.ts';
import { istAbprall } from './abprallEntscheidung.ts';

/** Je Ziel-Schlüssel: wurde in dieser Sitzung schon einmal auf den Umweg
 *  über Pulse umgeschaltet? Modul-weiter Arbeitsspeicher, s. Kopfkommentar. */
const aufPulseFestgelegt = new Set<string>();

/** Für die Verbindungsanzeige/Diagnose: ist dieses Ziel in dieser Sitzung
 *  schon auf den Umweg über Pulse festgelegt? */
export function istAufPulseFestgelegt(schluessel: string): boolean {
	return aufPulseFestgelegt.has(schluessel);
}

export interface RueckfallZiel {
	/** Eindeutige Kennung des Ziels (z. B. `kanal:<id>` oder `guild:<id>`) —
	 *  trennt die Merkung je Ziel; zwei Kanäle dürfen sich nicht gegenseitig
	 *  beeinflussen. */
	schluessel: string;
	/** Der kurze Weg — direkt gegen das Laufwerk. */
	direkt: AblageAdapter;
	/** Der Umweg — die Weiterreich-Route des Pulse-Servers (Design §4.2).
	 *  Signatur wie `AblageAdapter.lese`: `null`, wenn die Datei dort
	 *  wirklich nicht existiert. */
	ueberPulse(datei: string): Promise<Uint8Array | null>;
}

export function direktMitRueckfallAdapter(ziel: RueckfallZiel): AblageAdapter {
	const { schluessel, direkt, ueberPulse } = ziel;

	return {
		schreibe: (datei, inhalt) => direkt.schreibe(datei, inhalt),
		liste: () => direkt.liste(),
		lösche: direkt.lösche ? (datei) => direkt.lösche!(datei) : undefined,

		async lese(datei) {
			if (aufPulseFestgelegt.has(schluessel)) {
				return ueberPulse(datei);
			}
			try {
				return await direkt.lese(datei);
			} catch (fehler) {
				if (!istAbprall(fehler)) throw fehler;
				aufPulseFestgelegt.add(schluessel);
				return ueberPulse(datei);
			}
		}
	};
}
