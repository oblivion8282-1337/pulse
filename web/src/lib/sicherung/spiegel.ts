/**
 * Der Spiegel — füttert das Sicherungs-Log im Laufwerk des Nutzers mit dem,
 * was lokal angekommen ist. Er selbst verwaltet KEINEN Gerätezustand
 * (Passwort, DEK, Puffer-Datei): das liegt bei `geraete.ts` und der
 * Andock-Schicht. Was er kann, ist die reine Rechnung, und die ist im
 * Node-Testläufer prüfbar.
 *
 * **Ein Bestand je Konto, ein Schreibraum je Gerät.** Der Container im
 * Laufwerk trägt die Dateien ALLER Geräte des Kontos; damit zwei Geräte sich
 * nicht in die Quere schreiben, bekommt jedes einen Präfix-Namensraum
 * (`praefixAdapter`) — ein Gerät überschreibt nur EIGENE Dateien, und das
 * Manifest wird nur als Cache des EIGENEN Namensraums best-effort gepflegt.
 * Wahrheit beim Lesen ist die Dateiliste, nicht das Manifest (s.
 * wiederherstellen.ts) — das Log-Format ist aus Segmenten rekonstruierbar.
 *
 * **Die Rahmen-Ids sind ein gerätelokaler Folgezähler**, nicht die
 * Snowflake der Nachricht: der `AblageSchreiber` verlangt streng
 * aufsteigende Ids, aber Nachrichten verschiedener Kanäle kommen in
 * willkürlicher Reihenfolge an. Die echte Ordnung reist in der Nutzlast
 * (Nachricht-Snowflake); beim Wiederherstellen zählt sie, nicht der Rahmen.
 *
 * Ein `festigen` ist ein Full-Segment-Upload — also geschieht er debounced
 * (`verzoegerungMs`) oder, wenn der Puffer die Schwelle reißt, sofort. Bis
 * dahin bleibt alles im Arbeitsfeld; die dauerhafte Puffer-Datei liegt bei
 * `geraete.ts` (IndexedDB), damit ein Absturz vor dem Spülen nichts verliert.
 */

import type { AblageAdapter } from '../ablage/adapter.ts';
import { AblageSchreiber, type AblageEintrag, type FestigungErgebnis } from '../ablage/schreiber.ts';
import { TYP_SICHERUNG_AES } from '../ablage/format.ts';
import { sha256Hex } from '../ablage/pruefsumme.ts';
import { verschlüsseleEintrag } from './krypto.ts';
import {
	kodiereSicherungEintrag,
	sicherungEintrag,
	type SicherungEintrag,
} from './nutzlast.ts';
import type { AblageNachricht } from '../ablage/nutzlast.ts';

/** Die Schlüssel-Datei des Containers — Klartext-Name, verschlüsselter Inhalt. */
export const SCHLUESSEL_DATEI = 'schluessel.puls';

/** Spülen spätestens nach so vielen Millisekunden — kein Upload je Nachricht. */
export const SPUEL_VERZOEGERUNG_MS = 60_000;
/** … oder sofort, wenn so viele Einträge warten. */
export const SPUEL_SCHWELLE = 50;

/** Sichert-Eintrag im Wartezimmer. */
export interface WarteEintrag {
	kanalId: string;
	nachricht: AblageNachricht;
}

/**
 * Legt jeden Adapter-Aufruf unter einen Namenspräfix — der Namensraum
 * eines Geräts im gemeinsamen Laufwerks-Ordner. `liste()` streift den
 * Präfix wieder ab, damit ein `AblageSchreiber` in seinem Namensraum
 * unmodifiziert arbeiten kann.
 */
export function praefixAdapter(basis: AblageAdapter, praefix: string): AblageAdapter {
	return {
		async schreibe(datei, inhalt) {
			await basis.schreibe(praefix + datei, inhalt);
		},
		async lese(datei) {
			return basis.lese(praefix + datei);
		},
		async liste() {
			const alle = await basis.liste();
			return alle
				.filter((name) => name.startsWith(praefix))
				.map((name) => name.slice(praefix.length));
		},
		async lösche(datei) {
			if (!basis.lösche) return;
			await basis.lösche(praefix + datei);
		},
	};
}

/**
 * Baut den Adapter je AUFRUF frisch — der gdrive-Adapter friert den
 * Zugangs-Token beim Bau ein (kopf in gdriveAdapter), ein stundenlang
 * laufender Spiegel braucht also je Operation einen aktuellen. Der
 * Lieferant liefert einen Token mit über 60 s echter Restlaufzeit
 * (Skew im Bestand, tokenVorrat.ts) und wirft eine neue Adapter-Instanz.
 */
export function aufbauAdapter(
	lieferant: () => Promise<AblageAdapter>,
): AblageAdapter {
	return {
		async schreibe(datei, inhalt) {
			await (await lieferant()).schreibe(datei, inhalt);
		},
		async lese(datei) {
			return (await lieferant()).lese(datei);
		},
		async liste() {
			return (await lieferant()).liste();
		},
		async lösche(datei) {
			await (await lieferant()).lösche?.(datei);
		},
	};
}

/**
 * Stabiles Geräte-Kürzel aus einer gerätelokalen Kennung — 8 Hex-Zeichen,
 * Namensraum-Präfix der Segment- und Manifest-Dateien dieses Geräts.
 */
export async function geraeteKuerzel(kennung: string): Promise<string> {
	const hex = await sha256Hex(new TextEncoder().encode(kennung));
	return `dev-${hex.slice(0, 8)}`;
}

/** Zähler der Wartezimmer-Duplikatjagd. */
function pufferSchluessel(kanalId: string, nachricht: AblageNachricht): string {
	return `${kanalId}:${nachricht.id}`;
}

export interface SpiegelOptionen {
	verzoegerungMs?: number;
	schwelle?: number;
	/** Wird nach jedem Spül-Versuch gerufen — mit der gespülten Partie, damit
	 *  die Andock-Schicht ihren Puffer abgleichen kann. Wirft nie. */
	nachSpuelung?: (ergebnis: FestigungErgebnis | null, fehler: unknown, partien: WarteEintrag[]) => void;
}

export class SicherungsSpiegel {
	private readonly basis: AblageAdapter;
	private readonly praefix: string;
	private readonly dek: Uint8Array;
	private readonly schreiber: AblageSchreiber;
	private readonly verzoegerungMs: number;
	private readonly schwelle: number;
	private readonly nachSpuelung?: SpiegelOptionen['nachSpuelung'];

	private warte: WarteEintrag[] = [];
	private warteSchluessel = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private laufend: Promise<void> | null = null;
	private einrichtungSichtbar = false;

	/**
	 * @param praefix Namensraum dieses Geräts (z. B. `dev-1a2b3c4d-`), VOR
	 *                der Übergabe erzeugt (`geraeteKuerzel`).
	 */
	constructor(
		adapter: AblageAdapter,
		dek: Uint8Array,
		praefix: string,
		optionen: SpiegelOptionen = {},
	) {
		this.basis = adapter;
		this.praefix = praefix;
		this.dek = dek;
		this.schreiber = new AblageSchreiber(praefixAdapter(adapter, praefix), 'sicherung');
		this.verzoegerungMs = optionen.verzoegerungMs ?? SPUEL_VERZOEGERUNG_MS;
		this.schwelle = optionen.schwelle ?? SPUEL_SCHWELLE;
		this.nachSpuelung = optionen.nachSpuelung;
	}

	/** So viele Einträge warten auf die nächste Spülung. */
	pufferLaenge(): number {
		return this.warte.length;
	}

	/** Der Namensraum dieses Geräts im Laufwerks-Ordner. */
	namensraum(): string {
		return this.praefix;
	}

	/**
	 * Nimmt Nachrichten in den Wartezimmer auf — Duplikate (gleicher Kanal,
	 * gleiche Nachricht-Id) wandern nicht doppelt hinein. Wirft nie und
	 * plant die Spülung selbst; ein Fehler beim Verschlüsseln sähe der
	 * Aufrufer als Rejection des sowieso laufenden Spül-Laufs.
	 */
	aufnehmen(kanalId: string, nachrichten: AblageNachricht[]): void {
		for (const nachricht of nachrichten) {
			const schluessel = pufferSchluessel(kanalId, nachricht);
			if (this.warteSchluessel.has(schluessel)) continue;
			this.warteSchluessel.add(schluessel);
			this.warte.push({ kanalId, nachricht });
		}
		if (this.warte.length === 0) return;
		if (this.warte.length >= this.schwelle) {
			void this.spuelen();
			return;
		}
		if (this.timer === null && this.laufend === null) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.spuelen();
			}, this.verzoegerungMs);
		}
	}

	/** Spült jetzt (oder nach Ablauf des Debounce) — „Jetzt sichern"-Knopf. */
	async jetztSpuelen(): Promise<FestigungErgebnis | null> {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		await (this.laufend ?? Promise.resolve());
		await this.spuelen();
		return this.letztesErgebnis;
	}

	/** Stellt das Debounce still (Abmeldung, Testende) — der Puffer bleibt. */
	beenden(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private letztesErgebnis: FestigungErgebnis | null = null;

	/**
	 * Schreibt den Wartezimmer-Inhalt in den eigenen Namensraum. Läuft nur
	 * einmal gleichzeitig; ein Fehlschlag lässt den Puffer unangetastet und
	 * plant eine neue Runde — die Nachrichten fallen nicht vom Tisch.
	 */
	async spuelen(): Promise<FestigungErgebnis | null> {
		if (this.laufend !== null) return this.laufend.then(() => this.letztesErgebnis);
		if (this.warte.length === 0) return null;
		this.laufend = this.spueleEinmal().catch((fehler) => {
			// Neue Runde — auch der Fehler selbst interessiert den Aufrufer.
			if (this.timer === null) {
				this.timer = setTimeout(() => {
					this.timer = null;
					void this.spuelen();
				}, this.verzoegerungMs);
			}
			this.nachSpuelung?.(null, fehler, []);
			return;
		});
		try {
			await this.laufend;
		} finally {
			this.laufend = null;
			// Während des Laufs aufgenommene Einträge hätten keinen Timer —
			// ohne Nachplanung warteten sie bis zum nächsten Ereignis.
			if (this.warte.length > 0 && this.timer === null) {
				this.timer = setTimeout(() => {
					this.timer = null;
					void this.spuelen();
				}, this.verzoegerungMs);
			}
		}
		return this.letztesErgebnis;
	}

	private async spueleEinmal(): Promise<void> {
		const warte = [...this.warte];
		// Aufsteigend nach Nachricht-Id — deterministisch, und der Rahmen-
		// Folgezähler folgt der sinnvollsten Ordnung, die hier zu haben ist.
		warte.sort((a, b) =>
			a.nachricht.id === b.nachricht.id
				? a.kanalId.localeCompare(b.kanalId)
				: (BigInt(a.nachricht.id) < BigInt(b.nachricht.id) ? -1 : 1),
		);

		// Erste Spülung nimmt den eigenen Bestand auf (Adoption verwaister
		// eigener Segmente nach einem Absturz vor dem Manifest-Schreiben).
		if (!this.einrichtungSichtbar) {
			await this.schreiber.bestandAufnehmen();
			this.einrichtungSichtbar = true;
		}

		const eintraege: AblageEintrag[] = [];
		for (const { kanalId, nachricht } of warte) {
			const eintrag: SicherungEintrag = sicherungEintrag(kanalId, nachricht);
			eintraege.push({
				id: this.naechsteId(),
				nutzlast: await verschlüsseleEintrag(this.dek, kodiereSicherungEintrag(eintrag)),
				typ: TYP_SICHERUNG_AES,
			});
		}
		const ergebnis = await this.schreiber.festigen(eintraege);
		// Erst nach erfolgreichem Festigen aus dem Wartezimmer — ein Fehler
		// mittendrin lässt alles stehen (die Ids der abgebrochenen Runde
		// sterben mit dem Lauf, der Zähler zählt neu).
		if (ergebnis !== null) {
			for (const { kanalId, nachricht } of warte) {
				this.warteSchluessel.delete(pufferSchluessel(kanalId, nachricht));
			}
			this.warte = this.warte.filter(
				(w) => !warte.includes(w),
			);
		}
		this.letztesErgebnis = ergebnis;
		this.nachSpuelung?.(ergebnis, null, ergebnis !== null ? warte : []);
	}

	private zaehler = 0n;

	private naechsteId(): bigint {
		// Start hinter dem eigenen Bestand — der Schreiber prüft das beim
		// ersten `festigen` gegen das Manifest; danach zählt der Lauf selbst.
		const stand = this.schreiber.stand();
		const basis = stand?.letzteId !== null && stand?.letzteId !== undefined
			? BigInt(stand.letzteId)
			: 0n;
		if (this.zaehler <= basis) this.zaehler = basis;
		this.zaehler += 1n;
		return this.zaehler;
	}
}
