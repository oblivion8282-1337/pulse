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
 * ## Verdichten — SCHON BEIM SCHREIBEN
 *
 * Gleichartige Ereignisse (Kategorie + Text) innerhalb von 10 s verschmelzen
 * beim `melde()` zu einem Eintrag mit `anzahl`. Das muss am Schreibpfad
 * passieren und nicht erst im Bericht: ein flappendes Server (Backoff nach
 * jedem erfolgreichen Dial zurückgesetzt) erzeugt 10–15 `ws_closed_1006` pro
 * Minute — ein Berichtzeit-Verdichtung würde die 250er-Grenze mit
 * Wiederholungen fluten und ausgerechnet die seltenen, wertvollen
 * Belege (`fetch_failed`, Anmelde-Ablehnungen) rauswerfen.
 *
 * ## Deckel — mit Neumessung
 *
 * Der Ring hält höchstens 250 Ereignisse bzw. 256 KiB; nach jedem Kappen wird
 * NEU GEMESSEN (While-Schleife), und die Zahl der Weggeworfenen steht IM
 * BERICHT — eine still gekappte Liste liest sich später wie „danach war
 * nichts mehr".
 *
 * ## Multi-Tab
 *
 * Der Ring wird bei jedem `melde()` FRISCH aus dem localStorage gelesen
 * (Modul-Cache nur im Speicher-Fallback ohne localStorage, z. B. Node-Test).
 * Ein Modul-Cache über Tab-Lebenszeit ließe einen zweiten Tab mit seinem
 * veralteten Stand frisch gemeldete Ereignisse und sogar schon gesendete
 * wieder hochschreiben.
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
 * Server-IDs durch — `melde()` kappt den Text zusätzlich hart, damit ein
 * vergessener langer String nicht den Deckel sprengen kann.
 */

/** Ein Ereignis im Ringpuffer. `ts` ist absolute Epoch-ms — der Bericht
 *  rechnet daraus relativ (eine rohe Client-Uhrzeit wäre ohne Zeitzonen-
 *  Kontext wertlos). `anzahl` trägt die schreibseitige Verdichtung. */
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
	/** Wie viele gleichartige Ereignisse hierin verschmolzen sind. */
	anzahl: number;
};

/** Persistenzform: Ereignisse + Ehrlichkeits-Zähler. */
type RingSpeicher = { ereignisse: RingEreignis[]; verworfen: number };

const LS_KEY = 'pulse.diagnose.ring';
const GESendet_KEY = 'pulse.diagnose.gesendet_am';
const MAX_EREIGNISSE = 250;
const MAX_BYTES = 256 * 1024;
const VERDICHTungsFENSTER_MS = 10_000;
const SEND_DROSSel_MS = 60_000;
const TEXT_KAPPUNG = 200;

let fallbackCache: RingSpeicher | null = null;

/** `localStorage` bewacht holen — im Node-Test und in Nicht-Browser-Kontexten
 *  ist es undefined; dann läuft der Puffer im Modul-Cache (der Test setzt
 *  einen Fake auf `globalThis.localStorage`). */
function speicher(): Storage | null {
	return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Form-Check je Element: ein kaputter/fremdschematischer Eintrag (Version-
 *  Skew, halber Write) wird verworfen und GEZÄHLT — `bericht()` darf niemals
 *  an Daten ersticken, gerade weil der Berichtskanal im Ausnahmezustand
 *  funktionieren muss. */
function istGueltig(e: unknown): e is RingEreignis {
	const kandidat = e as Partial<RingEreignis> | null;
	return (
		typeof kandidat === 'object' &&
		kandidat !== null &&
		typeof kandidat.ts === 'number' &&
		Number.isFinite(kandidat.ts) &&
		typeof kandidat.kategorie === 'string' &&
		typeof kandidat.text === 'string'
	);
}

function laden(): RingSpeicher {
	const storage = speicher();
	if (!storage) {
		// Kein localStorage (Node-Test): Modul-Cache ist die einzige Ablage.
		fallbackCache ??= { ereignisse: [], verworfen: 0 };
		return fallbackCache;
	}
	const ring: RingSpeicher = { ereignisse: [], verworfen: 0 };
	try {
		const roh = storage.getItem(LS_KEY);
		if (roh) {
			const parst = JSON.parse(roh) as Partial<RingSpeicher>;
			if (typeof parst.verworfen === 'number') ring.verworfen = parst.verworfen;
			if (Array.isArray(parst.ereignisse)) {
				for (const e of parst.ereignisse) {
					if (istGueltig(e)) ring.ereignisse.push(e);
					else ring.verworfen += 1;
				}
			}
		}
	} catch {
		// Kaputter Blob → leer anfangen. Diagnostik darf nie eine App stören.
	}
	return ring;
}

function sichern(ring: RingSpeicher, serialisiert?: string): void {
	try {
		storageSet(LS_KEY, serialisiert ?? JSON.stringify(ring));
	} catch {
		// Quota voll — der Speicher gilt weiter, Persistenz ist best-effort.
	}
}

function storageSet(schluessel: string, wert: string): void {
	speicher()?.setItem(schluessel, wert);
}

/** Deckel erzwingen: erst Anzahl, dann Bytes — mit NEUMESSUNG nach jedem
 *  Schnitt (While, terminiert, denn ein Ring ohne Ereignisse ist klein).
 *  DerSerialisiert-String wird vom Aufrufer durchgereicht, damit der Hot-
 *  Pfad (`melde()` bei jedem Anmelde-Fehlversuch) nicht doppelt
 *  stringifiziert. */
function begrenzen(ring: RingSpeicher): string {
	while (true) {
		const serialisiert = JSON.stringify(ring);
		let ueber = ring.ereignisse.length - MAX_EREIGNISSE;
		if (ueber <= 0 && serialisiert.length <= MAX_BYTES) return serialisiert;
		if (ueber <= 0) ueber = Math.ceil(ring.ereignisse.length / 2);
		ring.ereignisse = ring.ereignisse.slice(ueber);
		ring.verworfen += ueber;
	}
}

/** Ein Ereignis aufnehmen. Wirft nie — Diagnostik darf nie zur Störung
 *  werden. Verdichtet schreibseitig: gleichartige (Kategorie + Text)
 *  Ereignisse innerhalb des Fensters erhöhen nur `anzahl` des Gruppenkopfs —
 *  gegen Close-Fluten, die den Ring sonst mit Wiederholungen fluten. */
export function melde(
	baustein: string,
	kategorie: string,
	text: string,
	kontext?: Record<string, string | number | boolean>,
): void {
	try {
		const ring = laden();
		const jetzt = Date.now();
		// Rückwärtsscan begrenzt (letzte 20 genügen — alles Ältere liegt jenseits
		// des Verdichtungsfensters). Verschmolzen wird nur bei gleicher Kategorie,
		// gleichem Text UND gleichem Kontext: zwei Server mit demselben Fehler
		// unterscheiden sich im server_id — sie bleiben zwei Belege, sonst
		// würde der zweite still verschwiegen.
		const kontextSchluessel = kontext ? JSON.stringify(kontext) : '';
		for (let i = ring.ereignisse.length - 1; i >= 0 && i >= ring.ereignisse.length - 20; i--) {
			const e = ring.ereignisse[i];
			if (jetzt - e.ts > VERDICHTungsFENSTER_MS) break;
			const eKontext = e.kontext ? JSON.stringify(e.kontext) : '';
			if (e.kategorie === kategorie && e.text === text && eKontext === kontextSchluessel) {
				e.anzahl += 1;
				sichern(ring, begrenzen(ring));
				return;
			}
		}
		ring.ereignisse.push({
			ts: jetzt,
			baustein,
			kategorie,
			// Kappung hier statt im Bericht: ein vergessener langer String soll
			// den 256-KiB-Deckel nicht sprengen können.
			text: text.slice(0, TEXT_KAPPUNG),
			kontext,
			anzahl: 1
		});
		sichern(ring, begrenzen(ring));
	} catch {
		// Absichtlich geschluckt.
	}
}

/** Liest den Puffer (ältester zuerst). Kopie — Aufrufer können nichts
 *  kaputt-machen. */
export function leseRingpuffer(): RingEreignis[] {
	return [...laden().ereignisse];
}

/** Entfernt genau die Ereignisse bis `bisTs` (Sendezeitpunkt) — alles, was
 *  WÄHREND des Versand-Fetchs neu ankam, bleibt im Ring und geht mit dem
 *  nächsten Bericht raus. Ohne Argument: alles. */
export function leeren(bisTs?: number): void {
	const storage = speicher();
	if (!storage) {
		if (bisTs === undefined) {
			fallbackCache = { ereignisse: [], verworfen: 0 };
		} else if (fallbackCache) {
			const behalten = fallbackCache.ereignisse.filter((e) => e.ts > bisTs);
			fallbackCache.verworfen += fallbackCache.ereignisse.length - behalten.length;
			fallbackCache.ereignisse = behalten;
		}
		return;
	}
	try {
		if (bisTs === undefined) {
			storage.removeItem(LS_KEY);
			return;
		}
		const ring = laden();
		const behalten = ring.ereignisse.filter((e) => e.ts > bisTs);
		ring.verworfen += ring.ereignisse.length - behalten.length;
		ring.ereignisse = behalten;
		storage.setItem(LS_KEY, JSON.stringify(ring));
	} catch {
		// best-effort — der nächste Bericht enthält höchstens Duplikate.
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

/** Baut den Bericht aus dem Ring. Die Verdichtung ist schon beim Schreiben
 *  passiert; hier wird nur relativ gerechnet (nie negativ — eine
 *  zurückgesprungene Systemuhr lässt Ereignisse vor dem Gruppenkopf liegen)
 *  und `art` auf die vom Endpoint verlangten 48 Zeichen gekürzt. `kopf`
 *  kommt vom UI (Serverliste, UA) — s. Importfrei-Notiz oben. */
export function bericht(kopf: Record<string, unknown>, notiz: string): AppBericht {
	const ring = laden();
	const basis = ring.ereignisse[0]?.ts ?? Date.now();
	const ereignisse: AppBericht['ereignisse'] = ring.ereignisse.map((e) => ({
		s: Math.max(0, Math.round(((e.ts - basis) / 1000) * 10) / 10),
		art: e.kategorie.slice(0, 48),
		anzahl: e.anzahl,
		werte: { text: e.text, baustein: e.baustein, ...(e.kontext ?? {}) }
	}));
	return {
		kopf,
		bilanz: {
			ereignisse_gesamt: ring.ereignisse.reduce((summe, e) => summe + e.anzahl, 0),
			erster: ring.ereignisse[0] ? new Date(ring.ereignisse[0].ts).toISOString() : null,
			letzer: ring.ereignisse.at(-1) ? new Date(ring.ereignisse.at(-1)!.ts).toISOString() : null
		},
		ereignisse,
		ereignisse_verworfen: ring.verworfen,
		abschluss: { notiz }
	};
}

/** Send-Drossel: der Endpoint erlaubt 30/h je IP, und ein Doppelklick-Dop-
 *  pelbericht hilft niemandem. 60 s zwischen zwei manuellen Berichten. Ein
 *  in der Zukunft liegender gespeicherter Zeitstempel (zurückgesprungene
 *  Uhr) wird wie „nie gesendet" behandelt — sonst sperrt die Drossel bis
 *  die Wanduhr den alten Stand wieder erreicht. */
export function darfJetztSenden(): boolean {
	try {
		const letzte = Number(speicher()?.getItem(GESendet_KEY) ?? 0);
		if (!letzte) return true;
		const delta = Date.now() - letzte;
		return delta < 0 || delta >= SEND_DROSSel_MS;
	} catch {
		return true;
	}
}

export function merkeUebertragung(): void {
	try {
		storageSet(GESendet_KEY, String(Date.now()));
	} catch {
		// best-effort
	}
}

/** Fallback, wenn selbst die Cloud nicht erreichbar ist (§5 des Specs): der
 *  Bericht als Datei — der Nutzer kann ihn klassisch schicken. Wirft nie. */
export function speichereAlsDatei(berichtObj: AppBericht): void {
	try {
		const blob = new Blob([JSON.stringify(berichtObj, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `pulse-diagnose-${new Date().toISOString().slice(0, 19)}.json`;
		a.click();
		// Verzögert revoken (Muster aus instances.ts): synchron würde der Browser
		// den Blob-Download abbrechen, bevor er begonnen hat.
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	} catch {
		// Auch der Notfallweg darf nicht werfen.
	}
}
