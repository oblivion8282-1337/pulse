/**
 * App-weites Diagnose-Gedächtnis — der Ringpuffer hinter dem Käfer-Knopf.
 *
 * **Die Lücke, die das schließt:** der Streaming-Diagnosebericht
 * (`stream/diagnose-bericht.ts`) hört nur auf WHEP-Statistiken. Alles andere,
 * was in einer App-Sitzung schiefgeht — Anmelde-Ablehnungen, WS-Abbrüche,
 * gescheiterte API-Aufrufe — wird heute geworfen, sobald die Meldung
 * angezeigt war. Der Fall vom 2026-09-21 (Community-Erstellen meldet
 * „Server nicht erreichbar", das Server-Log zeigt die Anfragen, WEIL sie nie
 * ankamen) ist genau die Klasse, die nur vom Gerät des Nutzers belegbar ist:
 * Ein Server-Log kann keinen Fehler enthalten, der den Server nie erreicht.
 *
 * **Importfrei — und das ist eine Last, kein Zufall.** Dieser Modul wird von
 * `anmelde-fehler.ts`, `server-ticket.ts`, `gateway-connection.ts` und dem
 * Guild-Erstellen importiert; ein Import HIERHIN zurück in eine dieser
 * Dateien (oder in alles, was Stores oder Paraglide zieht) baut einen
 * Import-Zyklus, der erst im Betrieb auffällt. Darum: keine Imports, die
 * Kopf-Daten (Serverliste, UA) kommen als Parameter vom UI hinein.
 *
 * ## Verdichten und Deckel
 *
 * Gleiche Philosophie wie `diagnose-bericht.ts`: gleichartige Ereignisse
 * (Kategorie + Text) innerhalb von 10 s verschmelzen zu einem Eintrag mit
 * `anzahl`; der Ringpuffer hält höchstens 250 Ereignisse bzw. 256 KiB — und
 * die Zahl der Weggeworfenen steht IM BERICHT, denn eine still gekappte
 * Liste liest sich später wie „danach war nichts mehr".
 *
 * ## Einwilligung
 *
 * Automatisch gesendet wird hier NICHTS (das bleibt beim Streaming-Pfad und
 * dessen Schalter). Der Käfer-Knopf schickt nur bei ausdrücklichem Klick —
 * der Klick IST die Einwilligung, deshalb funktioniert der Weg auch im
 * Browser, wo ein abwählbarer Auto-Schalter nie existieren konnte.
 *
 * NIEMALS hier landen (s. Spec §8): Nachrichteninhalte, Token, Hostname-
 * Credentials, `.env`-Werte. Die Aufrufer reichen nur Codes, kurze Texte und
 * Server-IDs durch — hält einer sich nicht daran, ist das ein Review-Kommentar
 * und kein Konfigurationsfall.
 */

/** Ein Ereignis im Ringpuffer. `ts` ist absolute Epoch-ms — der Bericht
 *  rechnet daraus relativ (der Server versteht Sekunden seit Bericht-Beginn;
 *  eine rohe Client-Uhrzeit wäre ohne Zeitzonen-Kontext wertlos). */
export type RingEreignis = {
	ts: number;
	/** Woher: 'anmeldung' | 'sitzung' | 'verbindung' | 'api' | 'stream' | … */
	baustein: string;
	/** Maschinen-Kategorie (§9 des Specs), z. B. `anmeldung_network`. */
	kategorie: string;
	/** Kurzer, fuer Menschen lesbarer Text — Code/Ort, keine Prosa. */
	text: string;
	/** Freie Kontext-Werte (server_id, hostname, status …), keine Secrets. */
	kontext?: Record<string, string | number | boolean>;
};

/** Persistenzform: Ereignisse + Ehrlichkeits-Zähler. */
type RingSpeicher = { ereignisse: RingEreignis[]; verworfen: number };

const LS_KEY = 'pulse.diagnose.ring';
const GESendet_KEY = 'pulse.diagnose.gesendet_am';
const MAX_EREIGNISSE = 250;
const MAX_BYTES = 256 * 1024;
const VERDICHTungsFENSTER_MS = 10_000;
const SEND_DROSSel_MS = 60_000;

let cache: RingSpeicher | null = null;

/** `localStorage` bewacht holen — im Node-Test und in Nicht-Browser-Kontexten
 *  ist es undefined; dann läuft der Puffer nur im Speicher (der Test setzt
 *  einen Fake auf `globalThis.localStorage`). */
function speicher(): Storage | null {
	return typeof localStorage === 'undefined' ? null : localStorage;
}

function laden(): RingSpeicher {
	if (cache) return cache;
	cache = { ereignisse: [], verworfen: 0 };
	try {
		const roh = speicher()?.getItem(LS_KEY);
		if (roh) {
			const parst = JSON.parse(roh) as Partial<RingSpeicher>;
			if (Array.isArray(parst.ereignisse)) cache.ereignisse = parst.ereignisse;
			if (typeof parst.verworfen === 'number') cache.verworfen = parst.verworfen;
		}
	} catch {
		// Kaputter Blob → leer anfangen. Diagnostik darf nie eine App stören.
	}
	return cache;
}

function sichern(ring: RingSpeicher): void {
	try {
		speicher()?.setItem(LS_KEY, JSON.stringify(ring));
	} catch {
		// Quota voll — der Speicher gilt weiter, Persistenz ist best-effort.
	}
}

/** Älteste Hälfte werfen — beim Überschreiten einer der beiden Grenzen. Die
 *  Grenzüberschreitung selbst wird gezählt, nicht verschwiegen. */
function begrenzen(ring: RingSpeicher): void {
	let ueber = ring.ereignisse.length - MAX_EREIGNISSE;
	if (ueber <= 0 && JSON.stringify(ring).length <= MAX_BYTES) return;
	if (ueber <= 0) {
		// Byte-Grenze: Hälfte werfen und neu messen — O(n²) im Worstcase, aber
		// n≤250 und der Pfad tritt im Normalbetrieb nie auf (ponytail: bewusst).
		ueber = Math.ceil(ring.ereignisse.length / 2);
	}
	ring.ereignisse = ring.ereignisse.slice(ueber);
	ring.verworfen += ueber;
}

/** Ein Ereignis aufnehmen. Wirft nie — Diagnostik darf nie zur Störung werden. */
export function melde(
	baustein: string,
	kategorie: string,
	text: string,
	kontext?: Record<string, string | number | boolean>,
): void {
	try {
		const ring = laden();
		ring.ereignisse.push({ ts: Date.now(), baustein, kategorie, text, kontext });
		begrenzen(ring);
		sichern(ring);
	} catch {
		// Absichtlich geschluckt.
	}
}

/** Liest den Puffer (ältester zuerst). Kopie — Aufrufer können nichts kaputt-
 *  machen. */
export function leseRingpuffer(): RingEreignis[] {
	return [...laden().ereignisse];
}

/** Nach erfolgreichem Versand (oder manuell): Puffer leeren — dieselben
 *  Ereignisse nicht doppelt schicken. */
export function leeren(): void {
	cache = { ereignisse: [], verworfen: 0 };
	try {
		speicher()?.removeItem(LS_KEY);
	} catch {
		// egal — der leere Cache gewinnt beim nächsten sichern().
	}
}

/** Berichtform — gespiegelt vom Pydantic-`Bericht` im Endpoint (alles optional
 *  dort, `extra="ignore"`; wir füllen, was wir haben). */
export type AppBericht = {
	kopf: Record<string, unknown>;
	bilanz: Record<string, unknown>;
	ereignisse: { s: number; art: string; anzahl: number; werte?: Record<string, unknown> }[];
	ereignisse_verworfen: number;
	abschluss: Record<string, unknown>;
};

/** Baut den Bericht: verdichtet (gleiche Kategorie + Text ≤10 s → ein Eintrag
 *  mit `anzahl`), rechnet auf relative Sekunden um, kürzt `art` auf die vom
 *  Endpoint verlangten 48 Zeichen. `kopf` kommt vom UI (Serverliste, UA) —
 *  s. Importfrei-Notiz oben. */
export function bericht(kopf: Record<string, unknown>, notiz: string): AppBericht {
	const ring = laden();
	const ereignisse: AppBericht['ereignisse'] = [];
	const basis = ring.ereignisse[0]?.ts ?? Date.now();
	let gruppe: AppBericht['ereignisse'][number] | null = null;
	for (const e of ring.ereignisse) {
		const anhaengend = gruppe !== null && e.ts - basis - gruppe.s * 1000 <= VERDICHTungsFENSTER_MS;
		if (gruppe && anhaengend && gruppe.art === e.kategorie.slice(0, 48)) {
			gruppe.anzahl += 1;
			continue;
		}
		gruppe = {
			s: Math.round(((e.ts - basis) / 1000) * 10) / 10,
			art: e.kategorie.slice(0, 48),
			anzahl: 1,
			werte: { text: e.text, baustein: e.baustein, ...(e.kontext ?? {}) }
		};
		ereignisse.push(gruppe);
	}
	return {
		kopf,
		bilanz: {
			ereignisse_gesamt: ring.ereignisse.length,
			erster: ring.ereignisse[0] ? new Date(ring.ereignisse[0].ts).toISOString() : null,
			letzer: ring.ereignisse.at(-1) ? new Date(ring.ereignisse.at(-1)!.ts).toISOString() : null
		},
		ereignisse,
		ereignisse_verworfen: ring.verworfen,
		abschluss: { notiz }
	};
}

/** Send-Drossel: der Endpoint erlaubt 30/h je IP, und ein Doppelklick-Dop-
 *  pelbericht hilft niemandem. 60 s zwischen zwei manuellen Berichten. */
export function darfJetztSenden(): boolean {
	try {
		const letzte = Number(speicher()?.getItem(GESendet_KEY) ?? 0);
		return !letzte || Date.now() - letzte >= SEND_DROSSel_MS;
	} catch {
		return true;
	}
}

export function merkeUebertragung(): void {
	try {
		speicher()?.setItem(GESendet_KEY, String(Date.now()));
	} catch {
		// best-effort
	}
}

/** Fallback, wenn selbst die Cloud nicht erreichbar ist (§5 des Specs): der
 *  Bericht als Datei — der Nutzer kann ihn klassisch schicken. */
export function speichereAlsDatei(bericht: AppBericht): void {
	const blob = new Blob([JSON.stringify(bericht, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `pulse-diagnose-${new Date().toISOString().slice(0, 19)}.json`;
	a.click();
	// Verzögert revoken (Muster aus instances.ts): synchron würde der Browser
	// den Blob-Download abbrechen, bevor er begonnen hat.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
