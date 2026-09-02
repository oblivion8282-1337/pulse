/**
 * Spiegelung auf mehrere Laufwerke (E5, Entwurf §5.3): ein `AblageAdapter`,
 * der mehrere echte Adapter zusammenfasst und so tut, als sei er nur einer —
 * Schreiber, Leser und alles, was `adapter.ts::AblageAdapter` erwartet,
 * bleiben unverändert.
 *
 * Zwei Entscheidungen, hier begründet statt nur behauptet:
 *
 * **Wie wird "hinterher" gemerkt?** Im Arbeitsspeicher, bewusst nicht
 * mitgeschrieben. Das kostet nach einem Neuladen die Markierung — nicht aber
 * die Daten: die Rundenregel (mindestens ein Ziel bestätigt) sorgt dafür,
 * dass in der Zwischenzeit nichts verloren geht, nur ein Ziel hat eine
 * Lücke. Ein frischer Zustand ist deshalb optimistisch "gesund", nicht
 * "hinterher" — die Nachführung selbst haengt daran nicht: sie schaut auf
 * das Laufwerk, nicht auf die Markierung (naechster Punkt), und läuft daher
 * auch dann korrekt, wenn die Markierung nie existiert hat.
 *
 * **Was heisst "nachführen"?** Ein voller Abgleich, kein Nachreichen der
 * einen verpassten Datei. Der Nachrichtenverlauf besteht aus überschriebenen
 * Dateien (Verzeichnis, Manifest) — welche EINE Datei ein hinterhinkendes
 * Ziel verpasst hat, sagt nichts darüber, ob eine spätere Überschreibung
 * derselben Datei ebenfalls verpasst wurde. Der Abgleich vergleicht deshalb
 * die vollständigen Verzeichnisse zweier Ziele über `liste()` + `lese()`
 * (Inhalt, nicht nur Name) und kopiert/löscht, bis beide gleich sind — das
 * ist zugleich der Weg, auf dem eine Löschung ein zurückgefallenes Ziel
 * erreicht, ohne dass gesondert Buch darüber geführt werden muss, WAS
 * gelöscht wurde.
 */

import type { AblageAdapter } from './adapter.ts';

/** Zustand eines einzelnen Spiegel-Ziels — Rohmaterial für die Verbindungsanzeige (E1). */
export interface SpiegelZielZustand {
	/** Position im `ziele`-Array, mit dem der Adapter erzeugt wurde. */
	index: number;
	/** Hat die letzte Schreib-/Löschrunde dieses Ziel bestätigt? */
	gesund: boolean;
	/** Steht ein Abgleich für dieses Ziel noch aus? */
	hinterher: boolean;
}

/** Wirft, wenn eine Runde an JEDEM Ziel scheitert (Regel 5). */
export class SpiegelFehler extends Error {
	constructor(fehlerJeZiel: ReadonlyArray<{ index: number; fehler: unknown }>) {
		const teile = fehlerJeZiel.map(
			({ index, fehler }) => `[${index}] ${fehlerZuText(fehler)}`
		);
		super(`Alle Spiegel-Ziele fehlgeschlagen: ${teile.join('; ')}`);
		this.name = 'SpiegelFehler';
	}
}

function fehlerZuText(fehler: unknown): string {
	return fehler instanceof Error ? fehler.message : String(fehler);
}

function gleicheBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export interface SpiegelAdapter extends AblageAdapter {
	// Der Spiegel bietet `lösche` immer an — er entscheidet selbst je Ziel,
	// ob es dort greift (Ziel unterstützt es) oder als Grabstein liegen
	// bleibt (Ziel unterstützt es nicht), s. `adapter.ts`-Kopfkommentar.
	lösche(datei: string): Promise<void>;
	/** Zustand je Ziel, für die Verbindungsanzeige (E1 / Entwurf §6.2). */
	zustandJeZiel(): SpiegelZielZustand[];
	/**
	 * Erzwingt einen vollen Abgleich aller aktuell hinterherhängenden Ziele
	 * gegen ein gesundes — z. B. nach einem Neuladen, wenn die In-Memory-
	 * Markierung fehlt, aber ein Nutzer auf "jetzt abgleichen" drückt, oder
	 * beim Wiederverbinden eines zuvor abgelaufenen Zugangs. Best-effort:
	 * wirft nicht, ein Ziel ohne erreichbare Quelle bleibt einfach hinterher.
	 */
	gleicheAb(): Promise<void>;
}

/**
 * Baut einen Spiegel-Adapter aus mindestens einem echten Ziel. Mit einem
 * einzigen Ziel verhält er sich wie ein einfacher Durchreicher (kein
 * Abgleich möglich, aber die Rundenregel — alles oder nichts scheitert mit
 * genau diesem einen Ziel — greift unverändert).
 */
export function spiegelAdapter(ziele: readonly AblageAdapter[]): SpiegelAdapter {
	if (ziele.length === 0) {
		throw new SpiegelFehler([]);
	}

	// gesund/hinterher je Index — reiner Arbeitsspeicher, siehe Kopf-Kommentar.
	const gesund: boolean[] = ziele.map(() => true);
	const hinterher: boolean[] = ziele.map(() => false);

	function zustandJeZiel(): SpiegelZielZustand[] {
		return ziele.map((_, index) => ({
			index,
			gesund: gesund[index],
			hinterher: hinterher[index]
		}));
	}

	/** Erstes aktuell gesundes Ziel ausser `ausser` — Quelle für einen Abgleich. */
	function gesundeQuelle(ausser: number): number | null {
		for (let i = 0; i < ziele.length; i++) {
			if (i !== ausser && gesund[i]) return i;
		}
		return null;
	}

	/** Voller Soll-Ist-Abgleich: `ziel` wird inhaltlich wie `quelle`. */
	async function gleicheZielAb(zielIndex: number, quelleIndex: number): Promise<void> {
		const ziel = ziele[zielIndex];
		const quelle = ziele[quelleIndex];

		const [quellListe, zielListe] = await Promise.all([quelle.liste(), ziel.liste()]);
		const quellSet = new Set(quellListe);
		const zielSet = new Set(zielListe);

		for (const datei of quellSet) {
			const quellInhalt = await quelle.lese(datei);
			if (quellInhalt === null) continue; // zwischen liste() und lese() verschwunden
			const zielInhalt = zielSet.has(datei) ? await ziel.lese(datei) : null;
			if (zielInhalt === null || !gleicheBytes(zielInhalt, quellInhalt)) {
				await ziel.schreibe(datei, quellInhalt);
			}
		}

		for (const datei of zielSet) {
			if (!quellSet.has(datei) && ziel.lösche) {
				await ziel.lösche(datei);
			}
		}
	}

	/** Nach einer erfolgreichen Operation: hinterherhängende Ziele nachziehen. */
	async function nachführenWennMöglich(): Promise<void> {
		for (let i = 0; i < ziele.length; i++) {
			if (!hinterher[i]) continue;
			const quelle = gesundeQuelle(i);
			if (quelle === null) continue;
			try {
				await gleicheZielAb(i, quelle);
				hinterher[i] = false;
			} catch {
				// bleibt hinterher — der nächste Erfolg versucht es erneut.
			}
		}
	}

	/**
	 * Führt `op` auf allen Zielen parallel aus, aktualisiert gesund/hinterher
	 * und wendet die Rundenregel an (Regel 1 + 5). `betroffen` wählt, welche
	 * Ziele überhaupt teilnehmen (für `lösche`, wo nicht jedes Ziel die
	 * optionale Methode hat).
	 */
	async function runde(
		betroffen: number[],
		op: (ziel: AblageAdapter) => Promise<void>
	): Promise<void> {
		if (betroffen.length === 0) return; // kein Ziel unterstützt die Operation

		const ergebnisse = await Promise.allSettled(betroffen.map((i) => op(ziele[i])));

		const fehler: Array<{ index: number; fehler: unknown }> = [];
		let erfolge = 0;
		betroffen.forEach((zielIndex, pos) => {
			const ergebnis = ergebnisse[pos];
			if (ergebnis.status === 'fulfilled') {
				erfolge++;
				gesund[zielIndex] = true;
			} else {
				gesund[zielIndex] = false;
				hinterher[zielIndex] = true;
				fehler.push({ index: zielIndex, fehler: ergebnis.reason });
			}
		});

		if (erfolge === 0) {
			throw new SpiegelFehler(fehler);
		}

		await nachführenWennMöglich();
	}

	return {
		zustandJeZiel,

		async gleicheAb() {
			await nachführenWennMöglich();
		},

		async schreibe(datei, inhalt) {
			await runde(
				ziele.map((_, i) => i),
				(ziel) => ziel.schreibe(datei, inhalt)
			);
		},

		async lese(datei) {
			const reihenfolge = [...ziele.keys()].sort((a, b) => Number(gesund[b]) - Number(gesund[a]));
			let letzterFehler: unknown;
			for (const i of reihenfolge) {
				try {
					return await ziele[i].lese(datei);
				} catch (fehler) {
					letzterFehler = fehler;
				}
			}
			throw letzterFehler instanceof Error
				? letzterFehler
				: new SpiegelFehler(ziele.map((_, index) => ({ index, fehler: letzterFehler })));
		},

		async liste() {
			const reihenfolge = [...ziele.keys()].sort((a, b) => Number(gesund[b]) - Number(gesund[a]));
			let letzterFehler: unknown;
			for (const i of reihenfolge) {
				try {
					return await ziele[i].liste();
				} catch (fehler) {
					letzterFehler = fehler;
				}
			}
			throw letzterFehler instanceof Error
				? letzterFehler
				: new SpiegelFehler(ziele.map((_, index) => ({ index, fehler: letzterFehler })));
		},

		async lösche(datei) {
			const betroffen = ziele.map((_, i) => i).filter((i) => typeof ziele[i].lösche === 'function');
			await runde(betroffen, (ziel) => ziel.lösche!(datei));
		}
	};
}
