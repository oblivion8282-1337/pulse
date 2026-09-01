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
 * Importfrei-Pflicht gilt hier nicht (läuft nie im Node-Läufer — hängt an
 * `verlauf/index.ts`, das selbst schon IDB-seitig ist), aber die Rechnung
 * bleibt sauber getrennt: der Spiegel weiß nichts von IndexedDB.
 */

import { SICHERUNG_ENABLED } from '../krypto/schalter.ts';
import type { Message } from '../api/types.ts';
import { ausWire, NUTZLAST_FASSUNG, type AblageNachricht } from '../ablage/nutzlast.ts';
import { openIdentityDb, idbPutIdentity, idbGetIdentity } from '../identity/idb-shared.ts';
import { verlaufAlleLesen, anhangBytesLesen, anhangBytesSichern, verlaufPutSaetze } from '../verlauf/db.ts';
import { aktuellesKonto } from '../verlauf/konto.ts';
import { zuSatz } from '../verlauf/satz.ts';
import { entschlüsseleEintrag, verschlüsseleEintrag } from './krypto.ts';
import { leseSicherungInkrementell } from './wiederherstellen.ts';
import {
	SicherungsSpiegel,
	aufbauAdapter,
	geraeteKuerzel,
	SCHLUESSEL_DATEI,
	type WarteEintrag,
} from './spiegel.ts';
import { öffneSchluesselDatei } from './krypto.ts';
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

let spiegel: SicherungsSpiegel | null = null;
/** Der Bau-Lauf des aktuellen Schreibrecht-Nehmers — Single-Flight für alle
 *  Aufrufer, bis der Spiegel steht (nach `sicherungVerwerfen` wieder null). */
let spiegelBau: Promise<SicherungsSpiegel> | null = null;

/**
 * Ist die Sicherung auf diesem Gerät einsatzbereit (Verbindung + DEK im
 * Zwischenlager)? Der Spiegel wird bei Bedarf lazy hochgezogen; ein
 * Fehlschlag wird gemerkt, damit nicht jede Nachricht einen neuen Versuch
 * kostet.
 */
/** Baut den Spiegel (Namensraum, Puffer-Nachlauf) — ohne Schreibrecht. */
async function baueSpiegel(dek: Uint8Array, kuerzel: string): Promise<void> {
	const praefix = await geraeteKuerzel(kuerzel);
	spiegel = new SicherungsSpiegel(aufbauAdapter(adapterLieferant), dek, praefix, {
		nachSpuelung: (ergebnis, fehler, partien) => {
			if (fehler !== null || ergebnis === null || partien.length === 0) return;
			void pufferWeg(partien).catch(() => {
				/* bleibt in der nächsten `pufferAlles`-Runde hängen — harmlos */
			});
			// Der SCHREIBER bedient alle Tabs: dessen Rest-Puffer (Zeilen
			// anderer Tabs) wird nach jeder Spülung nachgeholt.
			void (async () => {
				const rest = await pufferAlles();
				for (const zeile of rest) spiegel?.aufnehmen(zeile.kanalId, [zeile.nachricht]);
			})().catch(() => {});
		},
	});
	// Überlebte des letzten Absturzes nachholen — sie sind nie gespült.
	const uebrig = await pufferAlles();
	const nachKanal = new Map<string, AblageNachricht[]>();
	for (const zeile of uebrig) {
		const liste = nachKanal.get(zeile.kanalId) ?? [];
		liste.push(zeile.nachricht);
		nachKanal.set(zeile.kanalId, liste);
	}
	for (const [kanalId, liste] of nachKanal) {
		spiegel.aufnehmen(kanalId, liste);
	}
}

async function spiegelFallsBereit(): Promise<SicherungsSpiegel | null> {
	if (spiegel !== null) return spiegel;
	const [ziele, zwischengelagert] = await Promise.all([
		zieleLesen(),
		dekAusZwischenlager(),
	]);
	if (!zieleBesetzt(ziele) || zwischengelagert === null) return null;
	// Schreibrecht: ZWEI Tabs desselben Profils teilen dasselbe Kürzel —
	// ohne Abstimmung überschriebe der eine dem anderen per PATCH die
	// Segmentdatei (Review 2026-08-31, Befund 4). Die Web-Locks-API reiht
	// den Wunsch in eine WARTESCHLANGE: der zweite Tab wird Schreiber,
	// sobald der erste endet — und bis dahin sichert der aktive Schreiber
	// auch dessen Puffer mit (Nachlauf nach jeder Spülung). Ohne
	// Locks-API (alte Browser) baut der erste Aufrufer direkt.
	const schreiber = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
	if (!schreiber) {
		await baueSpiegel(zwischengelagert.dek, zwischengelagert.kuerzel);
		return spiegel;
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
		// des Baus; das Halten selbst läuft feuer-und-vergessen weiter.
		void schreiber
			.request('pulse-sicherung-schreiber', async () => {
				await baueSpiegel(zwischengelagert.dek, zwischengelagert.kuerzel);
				bauFertig();
				await new Promise(() => {
					/* Schreibrecht halten, bis der Tab endet */
				});
			})
			.catch(() => {
				/* Lock entzogen (Tab-Ende) — der nächste Aufrufer baut neu */
			});
		await gebaut;
		return spiegel as unknown as SicherungsSpiegel;
	})();
	try {
		return await spiegelBau;
	} catch (e) {
		spiegelBau = null;
		throw e;
	}
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
		const bereit = await spiegelFallsBereit();
		bereit?.aufnehmen(kanalId, ablageNachrichten);
		// Anhänge VOR dem nächsten Spülen sichern — die Bytes liegen jetzt
		// frisch in der lokalen IDB (Empfang holt sie vor dem Ablegen).
		await sicherungAnhaenge(kanalId, ablageNachrichten);
	})().catch(() => {
		/* Diagnose-frei nach Absicht — s. Regel 1 im Modulkopf. */
	});
}

/**
 * Holt den Archiv-Bestand in den lokalen Verlauf. Dedupliziert über die
 * Nachrichten-Ids; dem Gerät bereits bekannte Zeilen bleiben unangetastet.
 * Liefert die Anzahl. Anhang-BYTES lädt sie bewusst NICHT — die holt die
 * Chat-Ansicht lazily aus dem Archiv, wenn eine Kachel gerendert wird
 * (krypto/anhangHolen.ts → archivAnhang), sonst läde der erste Login alles.
 */
export async function sicherungArchivLaden(): Promise<number> {
	const entpackt = await dekAusZwischenlager();
	if (entpackt === null) return 0;
	const kontoId = aktuellesKonto();
	if (kontoId === null) return 0;
	const adapter = await adapterLieferant();
	const altStand = await lesestandLesen(kontoId);
	const { bestand, lesestand } = await leseSicherungInkrementell(adapter, entpackt.dek, altStand);
	const saetze = bestand.eintraege
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
	await verlaufPutSaetze(saetze);
	// Lesestand erst NACH erfolgreichem Ablegen anheben — ein Fehler mid-
	// run lässt den nächsten Lauf dieselben Namensräume komplett lesen.
	await lesestandSchreiben(kontoId, lesestand);
	return saetze.length;
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

/** „Jetzt sichern" der Oberfläche — spült den Puffer, wenn alles bereit steht. */
export async function sicherungJetztSpuelen(): Promise<void> {
	const bereit = await spiegelFallsBereit();
	await bereit?.jetztSpuelen();
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
	const bereit = await spiegelFallsBereit();
	if (bereit === null) throw new Error('Sicherung nicht bereit — erst verbinden und entsperren.');
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

/** Test-Handgriff: den laufenden Spiegel verwerfen (Modulzustand zurück). */
export function sicherungVerwerfen(): void {
	spiegel?.beenden();
	spiegel = null;
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

export { SCHLUESSEL_DATEI };
export type { WarteEintrag };
