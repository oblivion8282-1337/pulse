/**
 * Die Andock-Schicht zwischen Verlauf und Spiegel — die EINZIGE Stelle, die
 * die Sicherung mit Nachrichten füttert.
 *
 * Verkabelt wird sie in `verlauf/index.ts::verlaufSpeichernPflicht` (und
 * NUR dort): ihre Aufrufer sind ausgerechnet die verschlüsselten Pfade
 * (`krypto/senden.ts`, `krypto/empfangen.ts`, `krypto/gruppe/*`) — der
 * Klartext-Weg läuft über `verlaufSpeichern` und wird bewusst NICHT
 * gesichert, denn den hält der Server ohnehin lesbar. Ein einziger Haken
 * erwischt also genau die Nachrichten, die sonst nirgends als Klartext
 * existieren.
 *
 * Zwei harte Regeln:
 *   1. **Nie werfen.** Die lokale Ablage ist die erste Kopie und fertig,
 *      bevor wir gerufen werden; ein Sicherungs-Fehlschlag (kein Laufwerk,
 *      falscher Modus) darf den Pfad nie stören, der sie trägt.
 *   2. **Puffer vor Spiegel.** Jede Eintragsserie landet ERST in der
 *      gerätelokalen Puffer-IDB (geraete.ts), DANN im Spiegel. Geht der
 *      Absturz dazwischen, überlebt der Eintrag und wandert beim nächsten
 *      Start mit. Erst nach dem erfolgreichen Spülen löscht die
 *      `nachSpuelung`-Rückkehr die Zeilen.
 *
 * **EIN Ordner je Unterhaltung.** Der Container trägt `<kanalId>/`-Ordner
 * mit je einem Geräte-Segment-Log pro Unterhaltung (spiegel.ts::
 * `ordnerAdapter`); der Schlüssel (`key.puls`) bleibt im Wurzel-Ordner.
 * Deshalb hält dieses Modul eine Spiegel-MAP je kanalId statt eines
 * einzelnen Spiegels — Schreibrecht (Web-Locks) und Puffer-Nachlauf bleiben
 * tab-global. Gelesen wird je Kanal-Ordner: seitenweise für die Chat-
 * Ansicht (`sicherungKanalSeiteLaden`), komplett für den Bulk-Weg
 * (`sicherungArchivLaden`).
 *
 * Importfrei-Pflicht gilt hier nicht (läuft nie im Node-Läufer — hängt an
 * `verlauf/index.ts`, das selbst schon IDB-seitig ist), aber die Rechnung
 * bleibt sauber getrennt: der Spiegel weiß nichts von IndexedDB.
 */

import { SICHERUNG_ENABLED } from '../krypto/schalter.ts';
import type { Message } from '../api/types.ts';
import { ausWire, NUTZLAST_FASSUNG, type AblageNachricht } from '../ablage/nutzlast.ts';
import type { AblageAdapter } from '../ablage/adapter.ts';
import { openIdentityDb, idbPutIdentity, idbGetIdentity } from '../identity/idb-shared.ts';
import { verlaufAlleLesen, anhangBytesLesen, verlaufPutSaetze } from '../verlauf/db.ts';
import { aktuellesKonto } from '../verlauf/konto.ts';
import { zuSatz } from '../verlauf/satz.ts';
import { verschlüsseleEintrag } from './krypto.ts';
import { KANAL_ORDNER_MUSTER, leseSicherungKanalSeite } from './wiederherstellen.ts';
import type { SicherungEintrag } from './nutzlast.ts';
import {
	SicherungsSpiegel,
	aufbauAdapter,
	geraeteKuerzel,
	ordnerAdapter,
} from './spiegel.ts';
import {
	adapterLieferant,
	zieleBesetzt,
	zieleLeeren,
	zieleLesen,
} from './ziele.ts';
import {
	anhangDateiName,
	dekAusZwischenlager,
	lesestandLesen,
	lesestandSchreiben,
	pufferAlles,
	pufferLegen,
	pufferWeg,
	pufferWischen,
	dekZwischenlagerWischen,
} from './geraete.ts';

/** Ein Spiegel je Unterhaltung — sein Ordner (`<kanalId>/`) im Archiv. */
let spiegelJeKanal = new Map<string, SicherungsSpiegel>();
/** Bau-Läufe je Kanal — zwei gleichzeitige `sicherungSpiegeln` desselben
 *  Kanals dürfen nicht zwei Spiegel bauen (zwei Schreiber auf EINEM
 *  Segment-Namen verlören sich gegenseitig ihre Rahmen). */
const spiegelBauJeKanal = new Map<string, Promise<SicherungsSpiegel | null>>();
/** Der Bau-Lauf des aktuellen Schreibrecht-Nehmers — Single-Flight für alle
 *  Aufrufer, bis das Schreibrecht steht (nach `sicherungVerwerfen` wieder
 *  null). Das Recht gilt für ALLE Kanal-Spiegel des Tabs gleichermaßen. */
let spiegelBau: Promise<void> | null = null;

/**
 * Baut den Spiegel EINES Kanals (Ordner-Namensraum, Geräte-Präfix,
 * Puffer-Nachlauf) — ohne Schreibrecht.
 */
async function baueSpiegel(
	kanalId: string,
	dek: Uint8Array,
	kuerzel: string,
): Promise<SicherungsSpiegel> {
	const praefix = await geraeteKuerzel(kuerzel);
	const spiegel = new SicherungsSpiegel(
		ordnerAdapter(aufbauAdapter(adapterLieferant), kanalId),
		dek,
		praefix,
		{
			nachSpuelung: (ergebnis, fehler, partien) => {
				if (fehler !== null || ergebnis === null || partien.length === 0) return;
				void pufferWeg(partien).catch(() => {
					/* bleibt in der nächsten `pufferAlles`-Runde hängen — harmlos */
				});
				// Der SCHREIBER bedient alle Tabs: dessen Rest-Puffer (Zeilen
				// anderer Tabs und Kanäle) wandert nach jeder Spülung in den
				// je-Kanal-Spiegel, so weit er schon gebaut ist.
				void (async () => {
					const rest = await pufferAlles();
					for (const zeile of rest) {
						spiegelJeKanal.get(zeile.kanalId)?.aufnehmen(zeile.kanalId, [
							zeile.nachricht,
						]);
					}
				})().catch(() => {});
			},
		},
	);
	spiegelJeKanal.set(kanalId, spiegel);
	// Überlebende des letzten Absturzes DIESES Kanals nachholen — sie sind
	// nie gespült. (Fremde Kanäle gehören in DEREN Spiegel: wo eine Zeile
	// liegt, entscheidet der Ordner-Präfix, nicht die Nutzlast — ein Spiegel
	// schreibt ausschließlich in seinen eigenen Kanal-Ordner.)
	const uebrig = (await pufferAlles()).filter((zeile) => zeile.kanalId === kanalId);
	if (uebrig.length > 0) {
		spiegel.aufnehmen(
			kanalId,
			uebrig.map((zeile) => zeile.nachricht),
		);
	}
	return spiegel;
}

/**
 * Ist die Sicherung auf diesem Gerät einsatzbereit (Verbindung + DEK im
 * Zwischenlager)? Der Spiegel des Kanals wird bei Bedarf lazy hochgezogen;
 * ein Fehlschlag wird gemerkt, damit nicht jede Nachricht einen neuen
 * Versuch kostet.
 */
async function spiegelFallsBereit(kanalId: string): Promise<SicherungsSpiegel | null> {
	const da = spiegelJeKanal.get(kanalId);
	if (da !== undefined) return da;
	let bau = spiegelBauJeKanal.get(kanalId);
	if (bau === undefined) {
		bau = baueMitSchreibrecht(kanalId);
		spiegelBauJeKanal.set(kanalId, bau);
		void bau.catch(() => {
			/* Fehlschlag merken: der nächste Aufrufer baut neu */
			spiegelBauJeKanal.delete(kanalId);
		});
	}
	return bau;
}

/** Bereitschaft prüfen, Schreibrecht nehmen (Web-Locks), Spiegel bauen. */
async function baueMitSchreibrecht(kanalId: string): Promise<SicherungsSpiegel | null> {
	const [ziele, zwischengelagert] = await Promise.all([
		zieleLesen(),
		dekAusZwischenlager(),
	]);
	if (!zieleBesetzt(ziele) || zwischengelagert === null) return null;
	// Schreibrecht: ZWEI Tabs desselben Profils teilen dieselben
	// Kanal-Ordner — ohne Abstimmung überschriebe der eine dem anderen
	// per PATCH die Segmentdatei (Review 2026-08-31, Befund 4; gegen
	// ZWEITE GERÄTE schützt der Geräte-Präfix je Datei). Die Web-Locks-
	// API reiht den Wunsch in eine WARTESCHLANGE: der zweite Tab wird
	// Schreiber, sobald der erste endet — und bis dahin sichert der
	// aktive Schreiber auch dessen Puffer mit (Nachlauf nach jeder
	// Spülung). Ohne Locks-API (alte Browser) baut der erste Aufrufer
	// direkt. Das Recht wird EINMAL je Tab geholt und gilt für alle
	// Kanal-Spiegel; die bauen danach direkt.
	const schreiber = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
	if (!schreiber) {
		return baueSpiegel(kanalId, zwischengelagert.dek, zwischengelagert.kuerzel);
	}
	spiegelBau ??= (async () => {
		let bauFertig!: () => void;
		const gebaut = new Promise<void>((resolve) => {
			bauFertig = resolve;
		});
		// Der Request kehrt BEWUSST nie zurück — der Callback hält das
		// Schreibrecht bis zum Tab-Ende. Ihn zu awaiten war der stille
		// Hänger: der erste Aufrufer im Tab wartete auf ein Nie-Ende
		// (Frischprofil, 2026-09-01). Gewartet wird nur auf den Abschluss
		// der Übernahme; das Halten selbst läuft feuer-und-vergessen
		// weiter.
		void schreiber
			.request('pulse-sicherung-schreiber', async () => {
				bauFertig();
				await new Promise(() => {
					/* Schreibrecht halten, bis der Tab endet */
				});
			})
			.catch(() => {
				/* Lock entzogen (Tab-Ende) — der nächste Aufrufer baut neu */
			});
		await gebaut;
	})();
	try {
		await spiegelBau;
	} catch (e) {
		spiegelBau = null;
		throw e;
	}
	return baueSpiegel(kanalId, zwischengelagert.dek, zwischengelagert.kuerzel);
}

/**
 * Spiegelt erfolgreich lokal abgelegte Nachrichten in die Sicherung.
 * Feuert und vergisst: eine abgelehnte Promise hier wäre eine unhandled
 * rejection im Weg des Sendens/Empfangens. Einträge, die beim Abbruch des
 * `aufnehmen` verloren gehen könnten, sind zu diesem Zeitpunkt bereits in
 * der Puffer-IDB.
 */
export function sicherungSpiegeln(kanalId: string, nachrichten: Message[]): void {
	if (!SICHERUNG_ENABLED) return;
	void (async () => {
		const ablageNachrichten = nachrichten.map((m) => ausWire(m));
		await pufferLegen(kanalId, ablageNachrichten);
		const bereit = await spiegelFallsBereit(kanalId);
		bereit?.aufnehmen(kanalId, ablageNachrichten);
		// Anhänge VOR dem nächsten Spülen sichern — die Bytes liegen jetzt
		// frisch in der lokalen IDB (Empfang holt sie vor dem Ablegen).
		await sicherungAnhaenge(kanalId, ablageNachrichten);
	})().catch(() => {
		/* Diagnose-frei nach Absicht — s. Regel 1 im Modulkopf. */
	});
}

/** Wandelt gelesene Sicherungs-Einträge in Verlaufs-Sätze — die geteilte
 *  Rechnung von seitenweisem und Bulk-Laden. Anhang-BYTES bleiben draußen:
 *  die holt die Chat-Ansicht lazily aus dem Archiv, wenn eine Kachel
 *  gerendert wird (krypto/anhangHolen.ts → archivAnhang), sonst läde der
 *  erste Login alles. */
function eintraegeZuSaetze(eintraege: SicherungEintrag[], kontoId: string) {
	return eintraege
		.map((eintrag) =>
			zuSatz(eintrag.kanalId, {
				id: eintrag.nachricht.id,
				author_id: eintrag.nachricht.autor,
				content: eintrag.nachricht.inhalt,
				created_at: eintrag.nachricht.zeit,
				edited_at: eintrag.nachricht.bearbeitet,
				reply_to_id: eintrag.nachricht.antwortAuf,
				attachments: eintrag.nachricht.anhaenge.map((a) => ({
					...(a as unknown as Record<string, unknown>),
					id: a.id,
					filename: (a as unknown as { name?: string | null }).name ?? null,
					mime: a.mime,
					size: a.groesse,
					// Die Sicherung spiegelt nur den E2EE-Weg — jeder
					// restaurierte Anhang ist verschlüsselt-ladbar (Bytes
					// aus dem Archiv, lokal entpackt), auch wenn ältere
					// Container-Rahmen das Feld nicht tragen.
					verschluesselt: true,
				})),
			}, kontoId),
		)
		.filter((satz) => satz !== null);
}

/**
 * Lädt EINE Seite aus dem Archiv-Ordner des Kanals in den lokalen Verlauf —
 * der seitenweise Weg der Chat-Ansicht (Kanal öffnen, Hochscrollen). Der
 * Lesestand wird je Konto+Kanal geführt (geraete.ts); der nächste Aufruf
 * liefert nur noch strikt ältere Nachrichten.
 *
 * **Wirft nie** und liefert 0, wenn die Sicherung nicht bereit ist — der
 * Aufrufer feuert und vergisst, ein totes Ziel darf die Ansicht nie
 * blockieren (Regel 1 im Modulkopf).
 */
export async function sicherungKanalSeiteLaden(kanalId: string, anzahl = 50): Promise<number> {
	try {
		const entpackt = await dekAusZwischenlager();
		if (entpackt === null) return 0;
		const kontoId = aktuellesKonto();
		if (kontoId === null) return 0;
		const adapter = await adapterLieferant();
		return await kanalSeiteFüttern(adapter, entpackt.dek, kontoId, kanalId, anzahl);
	} catch {
		return 0;
	}
}

/** Eine Seite (oder mit `anzahl = Infinity` den ganzen Ordner) lesen und in
 *  den lokalen Verlauf legen — die geteilte Rechnung beider Lade-Wege. */
async function kanalSeiteFüttern(
	adapter: AblageAdapter,
	dek: Uint8Array,
	kontoId: string,
	kanalId: string,
	anzahl: number,
): Promise<number> {
	const altStand = await lesestandLesen(kontoId, kanalId);
	const { eintraege, lesestand } = await leseSicherungKanalSeite(
		ordnerAdapter(adapter, kanalId),
		dek,
		altStand,
		anzahl,
	);
	if (eintraege.length === 0) return 0;
	const saetze = eintraegeZuSaetze(eintraege, kontoId);
	if (saetze.length > 0) await verlaufPutSaetze(saetze);
	// Lesestand erst NACH erfolgreichem Ablegen anheben — ein Fehler mid-run
	// lässt den nächsten Lauf dieselbe Seite noch einmal lesen (Upsert über
	// die Nachrichten-Ids; dem Gerät bereits bekannte Zeilen bleiben
	// unangetastet).
	await lesestandSchreiben(kontoId, kanalId, lesestand);
	return saetze.length;
}

/**
 * Holt den GESAMTEN Archiv-Bestand in den lokalen Verlauf (Bulk-Weg, Knopf
 * der Sicherungsektion). Läuft je Kanal-Ordner mit demselben Lesestand wie
 * der seitenweise Weg — beide Wege teilen sich den Fortschritt. Anhang-BYTES
 * lädt sie bewusst NICHT (s. `eintraegeZuSaetze`).
 */
export async function sicherungArchivLaden(): Promise<number> {
	const entpackt = await dekAusZwischenlager();
	if (entpackt === null) return 0;
	const kontoId = aktuellesKonto();
	if (kontoId === null) return 0;
	const adapter = await adapterLieferant();
	// EIN Lauf je Kanal-Ordner — ein Ordner existiert, sobald er ein
	// Segment trägt (KANAL_ORDNER_MUSTER über die Wurzel-Listung).
	const kanalIds = new Set<string>();
	for (const name of await adapter.liste()) {
		const treffer = KANAL_ORDNER_MUSTER.exec(name);
		if (treffer !== null) kanalIds.add(treffer[1]!);
	}
	let gesamt = 0;
	for (const kanalId of kanalIds) {
		// Infinity: ein Lauf liest den Ordner vollständig; die zweite Runde
		// (liefert 0) belegt die Erschöpfung und bricht ab.
		for (;;) {
			const seite = await kanalSeiteFüttern(adapter, entpackt.dek, kontoId, kanalId, Infinity);
			if (seite === 0) break;
			gesamt += seite;
		}
	}
	return gesamt;
}

/**
 * Spiegelt die LOKAL vorhandenen Anhang-Bytes der Nachrichten in das
 * Archiv (verschlüsselt mit dem DEK). Die Bytes muss dieses Gerät haben —
 * empfangende Geräte holen sie vor dem Spiegeln, sendende behalten sie im
 * Empfangsfall ihrer Gegenseite. Fehlen sie hier, überspringt der Lauf
 * den Anhang still: die Gegenseite hat dieselben Bytes und spiegelt sie.
 */
export async function sicherungAnhaenge(kanalId: string, nachrichten: AblageNachricht[]): Promise<void> {
	const dek = (await dekAusZwischenlager())?.dek;
	if (dek === undefined) return;
	const adapter = await adapterLieferant();
	for (const nachricht of nachrichten) {
		for (const anhang of nachricht.anhaenge) {
			try {
				const lokal = await anhangBytesLesen(anhang.id);
				if (!lokal) continue;
				const klar = new Uint8Array(await lokal.daten.arrayBuffer());
				await adapter.schreibe(anhangDateiName(anhang.id), await verschlüsseleEintrag(dek, klar));
			} catch {
				/* Anhang überspringen — die Nachricht selbst ist längst gesichert */
			}
		}
	}
}

/** „Jetzt sichern" der Oberfläche — spült ALLE gebauten Kanal-Spiegel. */
export async function sicherungJetztSpuelen(): Promise<void> {
	for (const spiegel of [...spiegelJeKanal.values()]) {
		await spiegel.jetztSpuelen();
	}
}

/**
 * Die ERSTSICHERUNG: spiegelt den bestehenden lokalen Verlauf einmalig in
 * den Container. Ohne sie enthält das Archiv nur Nachrichten, die NACH der
 * Aktivierung eintrafen — der gesamte bisherige Verlauf des Geräts bliebe
 * im Laufwerk unsichtbar. Idempotent in der Wirkung (der Wiederherstellungs-
 * Leser dedupliziert je Kanal+Nachricht-Id), im Container aber eine neue
 * Rahmen-Partie — also bewusst ein Knopf, kein Autolauf.
 *
 * Anhänge wandern in dieser Fassung NICHT mit (nur Metadaten wären da,
 * die Bytes liegen separat) und gelöschte Zeilen bleiben außen vor.
 */
const MERKER_ERSTSICHERUNG = 'pulse.sicherung-erstsicherung-ok';

/** Läuft die Nachhol-Runde schon? Dann ist der Knopf erledigt. */
export async function erstsicherungErledigt(): Promise<boolean> {
	try {
		const db = await openIdentityDb();
		return (await idbGetIdentity(db, MERKER_ERSTSICHERUNG)) === true;
	} catch {
		return false;
	}
}

export async function sicherungErstsicherung(): Promise<number> {
	// Bereitschaft einmal vorab prüfen — dieselbe Bedingung, die
	// `spiegelFallsBereit` je Kanal erfüllt; so scheitert der Lauf auch bei
	// leerem Verlauf sichtbar statt still mit 0.
	const [ziele, entpackt] = await Promise.all([zieleLesen(), dekAusZwischenlager()]);
	if (!zieleBesetzt(ziele) || entpackt === null) {
		throw new Error('Sicherung nicht bereit — erst verbinden und entsperren.');
	}
	const kontoId = aktuellesKonto();
	if (kontoId === null) throw new Error('kein angemeldetes Konto');
	const saetze = await verlaufAlleLesen(kontoId);
	const nachKanal = new Map<string, AblageNachricht[]>();
	for (const satz of saetze) {
		if (satz.geloescht) continue;
		const liste = nachKanal.get(satz.kanalId) ?? [];
		liste.push({
			fassung: NUTZLAST_FASSUNG,
			id: satz.nachrichtId,
			autor: satz.autorId,
			inhalt: satz.inhalt,
			zeit: satz.erstelltAm,
			bearbeitet: satz.bearbeitetAm,
			antwortAuf: satz.antwortAufId ?? null,
			// Anhang-Metadaten aus dem lokalen Satz — die BYTES holt
			// `sicherungAnhaenge` aus dem gerätelokalen Bytes-Speicher und
			// legt sie als eigene Dateien ins Archiv. Was das Gerät nicht
			// mehr hält, bleibt außen vor (ehrliche Grenze).
			anhaenge: Array.isArray(satz.anhaenge)
				? (satz.anhaenge as Array<Record<string, unknown>>).map((a) => ({
						...a,
						id: String(a.id),
						name: (a.filename as string | null) ?? null,
						mime: (a.mime as string | null) ?? null,
						groesse: Number(a.size ?? 0),
					}))
				: [],
		});
		nachKanal.set(satz.kanalId, liste);
	}
	let gesamt = 0;
	for (const [kanalId, liste] of nachKanal) {
		// Je Kanal der eigene Spiegel — die Erstsicherung gruppiert weiter
		// nach kanalId und füttert damit genau die Ordner-Struktur.
		const bereit = await spiegelFallsBereit(kanalId);
		if (bereit === null) {
			throw new Error('Sicherung nicht bereit — erst verbinden und entsperren.');
		}
		await pufferLegen(kanalId, liste);
		bereit.aufnehmen(kanalId, liste);
		await sicherungAnhaenge(kanalId, liste);
		gesamt += liste.length;
	}
	try {
		const db = await openIdentityDb();
		await idbPutIdentity(db, MERKER_ERSTSICHERUNG, true);
	} catch {
		/* Merker ist Komfort — das Nachholen schadet nicht */
	}
	return gesamt;
}

/** Test-Handgriff: die laufenden Spiegel verwerfen (Modulzustand zurück). */
export function sicherungVerwerfen(): void {
	for (const spiegel of spiegelJeKanal.values()) spiegel.beenden();
	spiegelJeKanal.clear();
	spiegelBauJeKanal.clear();
	spiegelBau = null;
}

/**
 * Abmeldung/Kontowechsel: was DIESES Gerät über die Sicherung weiß, muss
 * weg — der entpackte DEK, der Google-Refresh-Token, die Verbindung und
 * der Klartext-Puffer. Ohne diesen Lauf könnte der nächste Nutzer des
 * Geräts Archiv und Schlüssel zusammenbringen (Befund 2, Review
 * 2026-08-31). Der Aufrufer ist auth.svelte.ts an beiden Wisch-Stellen.
 */
export async function sicherungBeiAbmeldungWischen(): Promise<void> {
	sicherungVerwerfen();
	await zieleLeeren();
	await dekZwischenlagerWischen();
	await pufferWischen();
}
