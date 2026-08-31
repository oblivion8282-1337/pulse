/**
 * Der Archiv-Schreibweg — hängt an `verlaufSpeichernPflicht`
 * (`verlauf/index.ts`), dem Pfad, für den der lokale Speicher die EINZIGE
 * Kopie einer Nachricht ist (Plan-Aufgabe 3, `docs/superpowers/plans/
 * 2026-08-31-ablage-e3-persoenliches-archiv.md`).
 *
 * **Der Browser-Speicher bleibt der schnelle Weg.** Ist eine Ablage-
 * Verbindung als „mein Archiv" markiert (`AblageVerbindung.istArchiv`,
 * `archivMarkierung.ts`), wandert ein frisch abgelegter Satz zusätzlich
 * dorthin — asynchron, ungewartet, nie blockierend. Ist keine Verbindung
 * markiert, tut diese Datei nichts: der Normalfall bleibt unverändert.
 *
 * **Ein Fehlschlag beim Archivieren wirft NIE nach außen** und rührt den
 * lokalen Schreibweg nicht an — er lässt den Eintrag in der Warteschlange
 * liegen (`ausstehend`) und erhöht seinen Backoff (`archivWarteschlangeRechnung.ts`).
 * Ein totes Laufwerk hält den Chat nicht auf.
 *
 * **Nichts verschwindet still.** Anders als der Nachzieher (`nachzieher.ts`)
 * führt diese Warteschlange jeden Eintrag EINZELN bis zum Erfolg — kein
 * Wasserzeichen, das einen übersprungenen Eintrag für immer verlöre (s.
 * Modulkopf von `archivWarteschlangeRechnung.ts`).
 *
 * **Mehrere Tabs** teilen sich die Warteschlange in derselben IndexedDB wie
 * die Identität (`identity/idb-shared.ts`), ohne Sperre: jeder Schritt ist
 * idempotent (derselbe Satz überschreibt sich selbst nicht doppelt, s.
 * Dedupe in `archivSaetzeEinreihen`), und `ablegen()` VEREINIGT den eigenen
 * Stand mit dem bereits abgelegten in EINER Transaktion (`idbUpdateIdentity`)
 * — dasselbe Muster wie beim Medien-Archiv-Vorbild (`archiveQueueStore.ts`,
 * Juli-Zweig), hier neu geschrieben, weil dessen Code am abgelösten Krypto
 * hängt (s. Plan).
 *
 * **Kontowechsel am selben Gerät**: jeder Eintrag trägt `kontoId`
 * (`archivWarteschlangeRechnung.ts`); verarbeitet werden nur Einträge des
 * GERADE angemeldeten Kontos — derselbe Grund wie in `verbindungen.svelte.ts`.
 */
import {
	faelligeZuerst,
	naechsteVerzoegerungMs,
	naechsterWeckzeitpunkt,
	warteschlangeAusRoh,
	type ArchivWarteschlangenEintrag
} from './archivWarteschlangeRechnung.ts';
import { ablageVerbindungen, type DateiSpeicher } from './verbindungen.svelte.ts';
import { aktuellesKonto } from '../verlauf/konto.ts';
import { openIdentityDb, idbGetIdentity, idbUpdateIdentity } from '$lib/identity/idb-shared';

const WARTESCHLANGEN_SCHLUESSEL = 'pulse.ablage.archivWarteschlange';
/** Mime-Marker im Verzeichnis-Eintrag — rein informativ, niemand wertet ihn
 *  serverseitig aus (der Server sieht die Ablage ohnehin nie). */
const MIME_VERLAUFSSATZ = 'application/x-pulse-verlaufssatz';
/** Spätestens so oft nachsehen, auch wenn der nächste Versuch weiter weg
 *  liegt oder noch kein Archiv markiert/angemeldetes Konto bekannt ist —
 *  sonst schliefe die Warteschlange ein, sobald der Wecker einmal auf einen
 *  fernen Backoff-Zeitpunkt gestellt war. */
const MAX_WACHZEIT_MS = 15 * 60_000;
/** Ohne markiertes Archiv oder ohne angemeldetes Konto: trotzdem in diesem
 *  Abstand nachsehen (Selbstheilung, falls der Nutzer später eine Verbindung
 *  markiert bzw. die Anmeldung noch nachträgt). */
const WIEDERVORLAGE_OHNE_ZIEL_MS = 2 * 60_000;

/** Was `verlaufSpeichernPflicht` an dieser Datei übergibt — strukturell der
 *  Ausschnitt des lokalen Satzes (`verlauf/satz.ts`), den diese Datei ohne
 *  Import beschreiben könnte, hier aber bewusst benannt importiert (diese
 *  Datei ist nicht importfrei, s. Modulkopf `archivWarteschlangeRechnung.ts`). */
export interface ArchivierbarerSatz {
	kanalId: string;
	nachrichtId: string;
	autorId: string;
	inhalt: string;
	erstelltAm: string;
	bearbeitetAm: string | null;
	geloescht: boolean;
	antwortAufId: string | null;
	kryptoId: string | null;
	kontoId: string;
}

let warteschlange: ArchivWarteschlangenEintrag[] = [];
/** Geteiltes Versprechen statt Boolean nach dem `await`: sonst laden zwei
 *  Aufrufe im selben Tick beide, und der zweite überschreibt `warteschlange`
 *  mit einem Schnappschuss ohne den frisch eingereihten Eintrag des ersten. */
let ladenVersprechen: Promise<void> | null = null;
let laeuft = false;
let erneutNoetig = false;
/** Schlüssel, die dieser Tab seit dem letzten Ablegen erledigt hat — nur sie
 *  dürfen beim Vereinigen aus dem fremden Stand fallen (s. Modulkopf). */
const entferntSeitLetztemAblegen = new Set<string>();
let weckerTimer: ReturnType<typeof setTimeout> | null = null;
let weckerZeitpunkt = 0;

function laden(): Promise<void> {
	ladenVersprechen ??= (async () => {
		try {
			const db = await openIdentityDb();
			warteschlange = warteschlangeAusRoh(await idbGetIdentity(db, WARTESCHLANGEN_SCHLUESSEL));
		} catch {
			warteschlange = [];
		}
	})();
	return ladenVersprechen;
}

/** Legt die Warteschlange ab, vereinigt mit dem fremden Stand (Mehr-Tab-
 *  Sicherheit, s. Modulkopf). Meldet best effort — ein Fehlschlag hier ist
 *  kein Grund, die Verarbeitung abzubrechen: die Einträge bleiben im
 *  Arbeitsspeicher dieses Tabs gültig und werden beim nächsten Durchlauf
 *  erneut abzulegen versucht. */
async function ablegen(): Promise<void> {
	try {
		const db = await openIdentityDb();
		await idbUpdateIdentity(db, WARTESCHLANGEN_SCHLUESSEL, (roh) => {
			const bestehend = warteschlangeAusRoh(roh);
			const eigene = new Set(warteschlange.map((e) => e.schluessel));
			const fremd = bestehend.filter(
				(e) => !eigene.has(e.schluessel) && !entferntSeitLetztemAblegen.has(e.schluessel)
			);
			return [...fremd, ...warteschlange];
		});
		entferntSeitLetztemAblegen.clear();
	} catch {
		/* best effort, s. oben */
	}
}

function kodiereSatz(eintrag: ArchivWarteschlangenEintrag): Uint8Array {
	const nutzlast = {
		kanalId: eintrag.kanalId,
		nachrichtId: eintrag.nachrichtId,
		autorId: eintrag.autorId,
		inhalt: eintrag.inhalt,
		erstelltAm: eintrag.erstelltAm,
		bearbeitetAm: eintrag.bearbeitetAm,
		geloescht: eintrag.geloescht,
		antwortAufId: eintrag.antwortAufId,
		kryptoId: eintrag.kryptoId
	};
	return new TextEncoder().encode(JSON.stringify(nutzlast));
}

function vermerkeFehlschlag(eintrag: ArchivWarteschlangenEintrag): void {
	eintrag.versuche += 1;
	eintrag.naechsterVersuchAb = Date.now() + naechsteVerzoegerungMs(eintrag.versuche);
}

/**
 * Meldet frisch lokal abgelegte Sätze zum Archivieren an. Nimmt bewusst
 * bereits gebaute Sätze entgegen (kein erneutes Lesen aus der lokalen
 * Datenbank) — der Aufrufer (`verlaufSpeichernPflicht`) hat sie ohnehin
 * gerade im Speicher. Wartet nicht und wirft nie: der Aufrufer sitzt im
 * Rückgabepfad des lokalen Schreibvorgangs (Modulkopf, Regel 2/3).
 */
export function archivSaetzeEinreihen(saetze: readonly ArchivierbarerSatz[]): void {
	if (saetze.length === 0) return;
	void (async () => {
		try {
			await laden();
			const bekannt = new Set(warteschlange.map((e) => e.schluessel));
			let hinzugefuegt = false;
			for (const satz of saetze) {
				const schluessel = `${satz.kanalId}:${satz.nachrichtId}`;
				if (bekannt.has(schluessel)) continue;
				bekannt.add(schluessel);
				warteschlange.push({
					schluessel,
					kanalId: satz.kanalId,
					nachrichtId: satz.nachrichtId,
					autorId: satz.autorId,
					inhalt: satz.inhalt,
					erstelltAm: satz.erstelltAm,
					bearbeitetAm: satz.bearbeitetAm,
					geloescht: satz.geloescht,
					antwortAufId: satz.antwortAufId,
					kryptoId: satz.kryptoId,
					kontoId: satz.kontoId,
					versuche: 0,
					naechsterVersuchAb: 0
				});
				hinzugefuegt = true;
			}
			if (!hinzugefuegt) return;
			await ablegen();
			void arbeiteWarteschlangeAb();
		} catch {
			/* Einreihen ist best effort — der Satz bleibt trotzdem lokal
			 * gespeichert (das hat der Aufrufer bereits erledigt), nur die
			 * zusätzliche Archiv-Kopie unterbleibt in diesem seltenen Fall. */
		}
	})();
}

/** Ein Durchlauf: alle fälligen Einträge des angemeldeten Kontos gegen die
 *  markierte Archiv-Verbindung schreiben. Gibt zurück, ob noch etwas für
 *  dieses Konto aussteht (bestimmt, ob sich ein Wecker lohnt). */
async function versucheEinmal(): Promise<boolean> {
	await laden();
	const konto = aktuellesKonto();
	if (konto === null) return warteschlange.length > 0;

	if (!ablageVerbindungen.geladen) await ablageVerbindungen.laden();
	const archiv = ablageVerbindungen.verbindungen.find((v) => v.istArchiv);
	const meineEintraege = warteschlange.filter((e) => e.kontoId === konto);
	if (archiv === undefined) return meineEintraege.length > 0;

	let speicher: DateiSpeicher | null = null;
	try {
		speicher = await ablageVerbindungen.dateiSpeicherFür(archiv.id);
	} catch {
		speicher = null;
	}

	const faellige = faelligeZuerst(meineEintraege, Date.now());
	if (faellige.length === 0) return meineEintraege.length > 0;

	if (speicher === null) {
		// Verbindung markiert, aber kein Adapter aufbaubar (z. B. Laufwerk weg,
		// Anmeldung abgelaufen) — jeder fällige Eintrag bekommt einen neuen
		// Fehlversuch, statt einzeln denselben Fehler zu wiederholen.
		for (const eintrag of faellige) vermerkeFehlschlag(eintrag);
		await ablegen();
		return true;
	}

	for (const eintrag of faellige) {
		try {
			await speicher.hochladen(eintrag.schluessel, MIME_VERLAUFSSATZ, kodiereSatz(eintrag), konto);
			warteschlange = warteschlange.filter((e) => e.schluessel !== eintrag.schluessel);
			entferntSeitLetztemAblegen.add(eintrag.schluessel);
		} catch {
			vermerkeFehlschlag(eintrag);
		}
	}
	await ablegen();
	return warteschlange.some((e) => e.kontoId === konto);
}

function weckerLoeschen(): void {
	if (weckerTimer !== null) clearTimeout(weckerTimer);
	weckerTimer = null;
	weckerZeitpunkt = 0;
}

/** Stellt den Wecker auf den frühesten Zeitpunkt, zu dem sich ein weiterer
 *  Durchlauf lohnt. Gibt es überhaupt nichts (mehr) in der Warteschlange,
 *  bleibt er aus. */
function weckerStellen(): void {
	if (typeof window === 'undefined' || warteschlange.length === 0) return;
	const konto = aktuellesKonto();
	const meineEintraege = konto === null ? [] : warteschlange.filter((e) => e.kontoId === konto);
	const anhandBackoff = naechsterWeckzeitpunkt(meineEintraege);
	// Kein Backoff-Ziel bestimmbar (kein Konto bekannt, oder alle Einträge
	// gehören einem anderen/ehemaligen Konto): trotzdem in grobem Abstand
	// nachsehen, sonst schliefe die Warteschlange ein, bis die nächste
	// Nachricht sie zufällig weckt (Modulkopf, Selbstheilung).
	const ziel = anhandBackoff ?? Date.now() + WIEDERVORLAGE_OHNE_ZIEL_MS;
	if (weckerTimer !== null && ziel >= weckerZeitpunkt) return;
	weckerLoeschen();
	weckerZeitpunkt = ziel;
	weckerTimer = setTimeout(
		() => {
			weckerTimer = null;
			void arbeiteWarteschlangeAb();
		},
		Math.min(Math.max(ziel - Date.now(), 1_000), MAX_WACHZEIT_MS)
	);
}

/** Arbeitet die Warteschlange ab. Mehrfachaufrufe laufen nie parallel; ein
 *  Aufruf während eines laufenden Durchlaufs geht nicht verloren, sondern
 *  hängt einen weiteren an. */
export async function arbeiteWarteschlangeAb(): Promise<void> {
	if (laeuft) {
		erneutNoetig = true;
		return;
	}
	laeuft = true;
	try {
		do {
			erneutNoetig = false;
			await versucheEinmal();
		} while (erneutNoetig);
	} finally {
		laeuft = false;
		weckerStellen();
	}
}

/** Setzt den Backoff aller Einträge des angemeldeten Kontos zurück und
 *  arbeitet sofort weiter — für einen künftigen „jetzt erneut versuchen"-
 *  Handgriff (z. B. nachdem der Nutzer den Ordner neu erlaubt hat). Ohne
 *  diesen Weg bliebe ein festgehängter Eintrag bis zu sechs Stunden taub,
 *  obwohl sein Hindernis gerade beseitigt wurde. */
export async function archivWarteschlangeSofortVersuchen(): Promise<void> {
	weckerLoeschen();
	await laden();
	const konto = aktuellesKonto();
	if (konto !== null) {
		for (const eintrag of warteschlange) {
			if (eintrag.kontoId !== konto) continue;
			eintrag.versuche = 0;
			eintrag.naechsterVersuchAb = 0;
		}
		await ablegen();
	}
	await arbeiteWarteschlangeAb();
}

/** Wie viele Sätze des angemeldeten Kontos noch nicht archiviert sind — für
 *  `zustand.ts::VerbindungsRohwerte.ausstehend`. */
export function archivEintraegeAusstehend(): number {
	const konto = aktuellesKonto();
	if (konto === null) return 0;
	return warteschlange.filter((e) => e.kontoId === konto).length;
}

// Beim ersten Import einmal die gemerkte Warteschlange laden und lostreten —
// diese Datei erreicht über `verlauf/index.ts` denselben frühen Zeitpunkt wie
// der Rest der Verlauf-Maschinerie. Fire-and-forget wie überall hier; ist
// noch kein Konto angemeldet, stellt `weckerStellen` trotzdem einen groben
// Wiedervorlage-Wecker (s. oben), sobald die Anmeldung nachkommt.
void arbeiteWarteschlangeAb();
