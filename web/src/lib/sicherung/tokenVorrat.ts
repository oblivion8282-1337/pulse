/**
 * Der Zugangs-Token-Bestand der Google-Sicherung — Caching je Lebensdauer
 * statt je Aufruf. Vorher machte `adapterLieferant` (geraete.ts) bei JEDEM
 * Aufruf einen Refresh-POST, und `aufbauAdapter` (spiegel.ts) ruft den
 * Lieferanten je OPERATION auf (Segment-Lesen/-Schreiben, Manifest): eine
 * Spülung kostete mehrere Refreshes und öffnete ein Rennfenster beim
 * Zurückschreiben des Nachspiel-Tokens.
 *
 * Reine Rechnung, importfrei — Node-Testläufer-Regel (CLAUDE.md); die
 * IDB-seitige Anbindung liegt bei `geraete.ts`.
 */

/** Sicherheits-Abstand vor dem echten Ablauf: ein Token wird nicht mehr
 *  ausgeliefert, wenn ihn die letzten 60 s Restlaufzeit trennen — eine
 *  laufende Spülung soll ihn nicht unter den Händen sterben lassen. */
export const TOKEN_SKEW_SEKUNDEN = 60;

/** Falls der Anbieter keine Lebensdauer nennt: kurz annehmen statt hoffen. */
export const TOKEN_FALLBACK_SEKUNDEN = 300;

export interface TokenNachschub {
	zugangsToken: string;
	/** Nur gesetzt, wenn der Nachschub den Nachspiel-Token rotiert hat. */
	nachspieleToken?: string;
	/** Lebensdauer des Zugangs-Tokens in Sekunden, wenn der Anbieter sie nennt. */
	gueltigSekunden?: number;
	/** false, wenn die zugrunde liegende Verbindung sich während des Nachschubs
	 *  entfernt oder ersetzt hat — der Token gehört dann zu keiner gespeicherten
	 *  Verbindung mehr (z. B. Abmelde-Wisch) und kommt nicht in den Bestand. */
	cachebar: boolean;
}

export class TokenVorrat {
	private token = '';
	private gueltigBis = 0;
	private lauf: Promise<TokenNachschub> | null = null;
	// Keine Konstruktor-Parameter-Properties: der Node-Testläufer streift nur
	// abziehbare Typen ab und stirbt an code-erzeugender TS-Syntax.
	private readonly nachschub: () => Promise<TokenNachschub>;
	/** Injizierbare Uhr — der Testläufer rückt sie vor, der Betrieb nimmt Date.now(). */
	private readonly jetzt: () => number;

	constructor(nachschub: () => Promise<TokenNachschub>, jetzt: () => number = () => Date.now()) {
		this.nachschub = nachschub;
		this.jetzt = jetzt;
	}

	/** Der bestehende Token, solange er (abzüglich Skew) als gültig gilt. */
	cachiert(): string | null {
		return this.gueltigBis > this.jetzt() ? this.token : null;
	}

	/**
	 * Bestand oder Nachschub. Parallele Aufrufe teilen sich EINEN Nachschub
	 * (Single-Flight über die geteilte Promise) — sonst rotierten zwei
	 * Refreshes denselben Nachspiel-Token gegeneinander. Ein Fehlschlag wird
	 * nicht bestandsfähig; alle Wartenden sehen ihn, der nächste Abruf
	 * versucht es erneut.
	 */
	async holen(): Promise<TokenNachschub> {
		const vorhanden = this.cachiert();
		if (vorhanden !== null) return { zugangsToken: vorhanden, cachebar: true };
		this.lauf ??= this.nachschub().finally(() => {
			this.lauf = null;
		});
		const zugang = await this.lauf;
		if (zugang.cachebar) {
			this.token = zugang.zugangsToken;
			const laufzeitS = zugang.gueltigSekunden ?? TOKEN_FALLBACK_SEKUNDEN;
			this.gueltigBis = this.jetzt() + Math.max(laufzeitS - TOKEN_SKEW_SEKUNDEN, 0) * 1000;
		}
		return zugang;
	}

	/** Verbindung entfernt oder ersetzt — den Bestand verwerfen. */
	leeren(): void {
		this.token = '';
		this.gueltigBis = 0;
	}
}
