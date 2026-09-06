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
import { verlaufAlleLesen, anhangBytesLesen, verlaufPutSaetze, verlaufMarkiereGeloescht, verlaufSatzAnhangIds } from '../verlauf/db.ts';
import { aktuellesKonto } from '../verlauf/konto.ts';
import { sortierSchluessel, zuSatz } from '../verlauf/satz.ts';
import { verschlüsseleEintrag } from './krypto.ts';
import { KANAL_ORDNER_MUSTER, leseSicherungKanalSeite } from './wiederherstellen.ts';
import type { SicherungEintrag } from './nutzlast.ts';
import {
	SicherungsSpiegel,
	aufbauAdapter,
	geraeteKuerzel,
	ordnerAdapter,
	ordnerLeeren,
	schreibrechtHalten,
} from './spiegel.ts';
import {
	adapterLieferant,
	zieleBesetzt,
	zieleLeeren,
	zieleLesen,
} from './ziele.ts';
import {
	anhangDateiName,
	alterAnhangDateiName,
	dekAusZwischenlager,
	lesestandEntfernen,
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
/** Löst das Halten des Web-Lock-Schreibrechts — `sicherungVerwerfen` beendet
 *  damit den haltenden Callback, sonst queue't Logout→Login im selben Tab für
 *  immer hinter dem eigenen Nie-Ende (B1). */
let schreibrechtEnde: (() => void) | null = null;
/** B2: Generation je Kanal — `sicherungGespraechEntfernen` erhöht sie. Ein
 *  Spiegel-Bau, dessen Generation während des Baus wechselt, verfällt (kein
 *  Map-Eintrag, keine Puffer-Nachholung), sonst spült der alte Puffer-
 *  Schnappschuß den frisch geleerten Ordner neu voll. Der Boden steigt mit
 *  jedem Verwerfen, damit auch ein Bau OHNE Map-Eintrag (nie gelöschter
 *  Kanal) beim Logout verfällt und keinen Zombie-Spiegel zurücklässt. */
let generationBoden = 0;
const generationJeKanal = new Map<string, number>();

function kanalGeneration(kanalId: string): number {
	return Math.max(generationBoden, generationJeKanal.get(kanalId) ?? 0);
}

/**
 * Baut den Spiegel EINES Kanals (Ordner-Namensraum, Geräte-Präfix,
 * Puffer-Nachlauf) — ohne Schreibrecht. Liefert null, wenn das Gespräch
 * während des Baus gelöscht wurde (B2).
 */
async function baueSpiegel(
	kanalId: string,
	dek: Uint8Array,
	kuerzel: string,
): Promise<SicherungsSpiegel | null> {
	const generation = kanalGeneration(kanalId);
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
	// B2: NACH dem Puffer-Lesen prüfen — ist die Generation während des Baus
	// gewechselt, hat der Räumer (`sicherungGespraechEntfernen`/
	// `sicherungVerwerfen`) den Map-Eintrag bereits mit entfernt; hier nun
	// weder nachholen noch füttern. Bis zum `aufnehmen` unten liegt kein
	// await mehr, der Schnappschuß kann den geleerten Ordner nicht füllen.
	if (kanalGeneration(kanalId) !== generation) return null;
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
		// Der Request kehrt BEWUSST erst zurück, wenn das Recht abgegeben
		// wird (`sicherungVerwerfen`) oder der Tab endet — der Callback hält
		// das Schreibrecht. Ihn zu awaiten war der stille Hänger: der erste
		// Aufrufer im Tab wartete auf ein Nie-Ende (Frischprofil,
		// 2026-09-01). Gewartet wird nur auf den Abschluss der Übernahme;
		// das Halten selbst läuft feuer-und-vergessen weiter.
		const recht = schreibrechtHalten((halten) =>
			schreiber.request('pulse-sicherung-schreiber', halten).catch(() => {
				// B1: Sperre entzogen (Tab-Ende) — das Halten lebt nicht mehr,
				// also darf auch der gemerkte Stand weg, sonst wartet der
				// nächste Aufrufer auf einen toten Bau.
				schreibrechtEnde = null;
				spiegelBau = null;
			}),
		);
		schreibrechtEnde = recht.abgeben;
		await recht.bereit;
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

/**
 * Spiegelt eine Löschung als Grabstein-Frame in den Kanal-Ordner — der
 * Gegenpol zu `sicherungSpiegeln`: das Archiv soll nicht stärker sein als
 * die App, eine gelöschte Nachricht also auch dort als gelöscht lesbar.
 * Der Stein trägt nur die Id (Inhalt/Autor leer) — der Wiederherstellungs-
 * Leser (`leseSicherungKanalSeite`) erkennt ihn am `geloescht`-Feld und die
 * Andock-Lesewege legen ihn NIE als sichtbaren Satz an. Feuert und vergisst
 * wie der Spiegel-Haken; derselbe Puffer-vor-Spiegel-Weg (Regel 2).
 */
export function sicherungGrabstein(kanalId: string, nachrichtId: string): void {
	if (!SICHERUNG_ENABLED) return;
	void (async () => {
		// Anhänge der gelöschten Nachricht aus ALLEN Zielen entfernen —
		// gelöscht heißt gelöscht: der Klumpen überlebt die Nachricht nicht
		// im Archiv (Lücke 2026-09-02: die Bytes-Datei blieb bislang liegen).
		// Der alte deutsche Dateiname bleibt im Fallback mit drin.
		try {
			const kontoId = aktuellesKonto();
			if (kontoId !== null) {
				const ids = await verlaufSatzAnhangIds(kanalId, nachrichtId, kontoId);
				if (ids.length > 0) {
					const adapter = await adapterLieferant();
					for (const id of ids) {
						await adapter.lösche?.(anhangDateiName(id));
						await adapter.lösche?.(alterAnhangDateiName(id));
					}
				}
			}
		} catch {
			/* kein Ziel bedienbar — die Datei fällt mit dem Verfall des Postfachs */
		}
		const grabstein: AblageNachricht = {
			fassung: NUTZLAST_FASSUNG,
			id: nachrichtId,
			autor: '',
			inhalt: '',
			zeit: new Date().toISOString(),
			bearbeitet: null,
			antwortAuf: null,
			anhaenge: [],
			geloescht: true,
		};
		await pufferLegen(kanalId, [grabstein]);
		const bereit = await spiegelFallsBereit(kanalId);
		bereit?.aufnehmen(kanalId, [grabstein]);
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
		return (await kanalSeiteFüttern(adapter, entpackt.dek, kontoId, kanalId, anzahl)).anzahl;
	} catch {
		return 0;
	}
}

/** Eine Seite (oder mit `anzahl = Infinity` den ganzen Ordner) lesen und in
 *  den lokalen Verlauf legen — die geteilte Rechnung beider Lade-Wege. Der
 *  Rückgabewert reicht die Erschöpfungs-Kennung des Lesers mit durch (B10):
 *  `erschoepft` heißt, der Lauf hat die `anzahl`-Grenze nie erreicht, der
 *  Ordner trägt dahinter nichtsmehr. */
async function kanalSeiteFüttern(
	adapter: AblageAdapter,
	dek: Uint8Array,
	kontoId: string,
	kanalId: string,
	anzahl: number,
): Promise<{ anzahl: number; erschoepft: boolean }> {
	const altStand = await lesestandLesen(kontoId, kanalId);
	const { eintraege, lesestand, erschoepft } = await leseSicherungKanalSeite(
		ordnerAdapter(adapter, kanalId),
		dek,
		altStand,
		anzahl,
	);
	if (eintraege.length === 0) return { anzahl: 0, erschoepft };
	// Grabsteine werden NICHT als sichtbarer Satz angelegt — sie markieren
	// nur einen (etwaigen) lokalen Satz als gelöscht; fehlt er, bleibt es
	// ein stiller No-Op und der Stein allein wandert nicht in den Verlauf.
	// ponytail: kam der Stein auf einer FRÜHEREN Seite als die Nachricht
	// (lesen läuft neu nach alt — selten, aber zwei Geräte-Ketten können
	// beide Reihenfolge liefern), markiert der No-Op nichts und die Seite
	// mit der Nachricht legt sie sichtbar an. Konsequent wäre ein
	// Gelöscht-Merkmal im Lesestand — Upgrade-Pfad dort.
	for (const stein of eintraege) {
		if (stein.nachricht.geloescht !== true) continue;
		await verlaufMarkiereGeloescht(sortierSchluessel(kanalId, stein.nachricht.id), kontoId);
	}
	const sichtbar = eintraege.filter((e) => e.nachricht.geloescht !== true);
	const saetze = eintraegeZuSaetze(sichtbar, kontoId);
	if (saetze.length > 0) await verlaufPutSaetze(saetze);
	// Lesestand erst NACH erfolgreichem Ablegen anheben — ein Fehler mid-run
	// lässt den nächsten Lauf dieselbe Seite noch einmal lesen (Upsert über
	// die Nachrichten-Ids; dem Gerät bereits bekannte Zeilen bleiben
	// unangetastet).
	await lesestandSchreiben(kontoId, kanalId, lesestand);
	return { anzahl: saetze.length, erschoepft };
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
		// B10: der Leser meldet die Erschöpfung selbst (`erschoepft`) — der
		// frühere zweite Lauf (lieferte 0) lud je Kanal-Ordner ALLE Dateien
		// erneut aus dem Drive, nur um sie zu bestätigen. Mit `Infinity`
		// trifft die `anzahl`-Grenze nie zu, ein Lauf ist also stets
		// erschöpft: genau ein Lauf je Ordner, die Schleife bricht sofort.
		for (;;) {
			const seite = await kanalSeiteFüttern(adapter, entpackt.dek, kontoId, kanalId, Infinity);
			gesamt += seite.anzahl;
			if (seite.erschoepft) break;
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
			// Autorenschafts-Regel (2026-09-02): spiegelt wird nur, was DIESES
			// Konto selbst gesendet hat — der Absender ist der natürliche
			// Allein-Schreiber eines Anhangs. Empfängergeräte überspringen;
			// ohne die Regel schrieben beide Geräte desselben Kontos denselben
			// Klumpen und trieben Doppel-Dateien ins Drive.
			if (nachricht.autor !== aktuellesKonto()) continue;
		for (const anhang of nachricht.anhaenge) {
			try {
				// Dedup: Bei mehreren Geräten desselben Kontos hat JEDES die
				// Bytes im Cache — ohne diese Prüfung überschriebe jedes sie
				// mit identischem Inhalt (verschwendeter Upload, kein Verlust).
				if ((await adapter.lese(anhangDateiName(anhang.id))) !== null) continue;
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
	// B8: vor dem Spülen einmal den gerätelokalen Puffer aufnehmen — dort
	// liegen auch die Zeilen ANDERER Tabs, die der Warteschlange nur über
	// diese Runde erreichen (der Abgleich läuft sonst nur in `nachSpuelung`
	// des aktiven Schreibers). Der Duplikatschutz des Spiegels schluckt das
	// Doppelte.
	try {
		for (const zeile of await pufferAlles()) {
			spiegelJeKanal.get(zeile.kanalId)?.aufnehmen(zeile.kanalId, [zeile.nachricht]);
		}
	} catch {
		/* Puffer nicht lesbar — das Spülen des Bestands trotzdem versuchen */
	}
	for (const spiegel of [...spiegelJeKanal.values()]) {
		await spiegel.jetztSpuelen();
	}
}

/**
 * Löscht den Archiv-Ordner EINER Unterhaltung (`<kanalId>/`) — der Gegenpol
 * zum Spiegeln: ist das Gespräch selbst gelöscht (deleteChannel), darf der
 * Sicherungs-Bestand nicht stärker sein als die App. Wirft nie (Regel 1 im
 * Modulkopf); der `adapter`-Parameter ist der Test-Handgriff — der Node-
 * Läufer kann dieses Modul nicht laden (transitiv IndexedDB/Svelte), dort
 * läuft die Ordner-Rechnung über `ordnerLeeren(ordnerAdapter(basis, …))`.
 */
export async function sicherungGespraechEntfernen(
	kanalId: string,
	adapter?: AblageAdapter,
): Promise<void> {
	// Erst den Spiegel stilllegen und aus der Map wischen — sonst spült ein
	// wartender Timer den Puffer NACH dem Leeren in einen frischen Ordner.
	// Die Generation steigt VOR den awaits unten: ein laufender Bau, der
	// danach weiterläuft, verfällt (baueSpiegel setzt weder Map-Eintrag noch
	// Puffer-Nachholung ab — B2).
	generationJeKanal.set(kanalId, kanalGeneration(kanalId) + 1);
	spiegelJeKanal.get(kanalId)?.beenden();
	spiegelJeKanal.delete(kanalId);
	spiegelBauJeKanal.delete(kanalId);
	try {
		const ordner = ordnerAdapter(adapter ?? (await adapterLieferant()), kanalId);
		await ordnerLeeren(ordner);
	} catch {
		/* B3: Ziel tot oder Rest geblieben — Teilerfolg hier still (Regel 1);
		   ordnerLeeren hat trotzdem jede löschbare Datei versucht. */
	}
	// Geräte-Lokales mitlöschen: Lesestand (Fenster für einen Ordner, den es
	// nicht mehr gibt) und Puffer (sonst holt der nächste Spiegel-Bau die
	// Zeilen in einen frisch angelegten Ordner zurück). Jedes Stück für
	// sich — ein Fehlschlag blockt den Rest nicht.
	try {
		const kontoId = aktuellesKonto();
		if (kontoId !== null) await lesestandEntfernen(kontoId, kanalId);
	} catch {
		/* still */
	}
	try {
		const rest = await pufferAlles();
		await pufferWeg(rest.filter((zeile) => zeile.kanalId === kanalId));
	} catch {
		/* still */
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
	// B1: das Schreibrecht wird MIT verworfen — der haltende Callback endet,
	// die Sperre fällt, und Logout→Login im selben Tab queue't nicht mehr
	// für immer hinter dem eigenen Halten.
	schreibrechtEnde?.();
	schreibrechtEnde = null;
	spiegelBau = null;
	// B2: Boden anheben — auch ein Bau ohne Map-Eintrag verfällt jetzt und
	// hinterlässt nach dem Verwerfen keinen Zombie-Spiegel mehr.
	generationBoden += 1;
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
