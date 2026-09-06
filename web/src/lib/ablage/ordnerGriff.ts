/**
 * Der Verzeichnis-Griff einer Sync-Ordner-Verbindung überlebt einen
 * Neustart — File-System-Access-API, das Handle abgelegt in derselben
 * IndexedDB wie die Identität.
 *
 * Herkunft: `archiveFsa.ts` (Juli-Zweig, damals ein eigenes Medien-Archiv
 * mit GENAU EINEM Handle unter einem festen Schlüssel). Diese Etappe legt
 * kein zweites System an (`docs/superpowers/plans/2026-08-31-ablage-e3-
 * persoenliches-archiv.md`, „Der Zuschnitt hat sich geändert") — ein
 * Sync-Ordner ist eine gewöhnliche `AblageVerbindung`, und es kann mehrere
 * gleichzeitig geben. Der Schlüssel ist deshalb hier pro Verbindung
 * (`griffId` = `AblageVerbindung.konfiguration.griffId`, siehe
 * `verbindungen.svelte.ts::adapterFür`), nicht fest.
 *
 * DERSELBE FALLSTRICK wie im Juli-Zweig: Das Handle überlebt den Neustart,
 * die ERLAUBNIS nicht zwangsläufig — Browser verlangen die File-System-
 * Access-Berechtigung pro Sitzung neu. `griffBerechtigung` fragt das ohne
 * Nutzer-Geste ab (meist `prompt` nach einem Neuladen); nur
 * `griffBerechtigungAnfordern` kann daraus `granted` machen, und das MUSS
 * aus einem Klick heraus laufen, sonst wirft die Plattform `SecurityError`
 * (hier abgefangen, nicht durchgereicht).
 */
import { openIdentityDb, idbGetIdentity, idbPutIdentity, idbDeleteIdentity } from '$lib/identity/idb-shared';
import { griffNutzbar } from './ordnerGriffEntscheidung.ts';
import type { AblageVerzeichnis } from './syncOrdner.ts';

const SCHLÜSSEL_PRÄFIX = 'pulse.syncOrdner.griff.';

/** Aufbauend auf `AblageVerzeichnis` (schmaler eigener Typ, s. Kopf von
 *  `syncOrdner.ts`) statt auf `FileSystemDirectoryHandle` aus lib.dom — genau
 *  das ist der Wert, den `showDirectoryPicker` liefert und `adapterAusVerzeichnis`
 *  erwartet; die Permission-Methoden stehen in keiner der beiden Quellen und
 *  kommen deshalb hier dazu, bewusst schmal gehalten. */
type BerechtigungsModus = { mode?: 'read' | 'readwrite' };
export type Griff = AblageVerzeichnis & {
	name: string;
	queryPermission?: (d?: BerechtigungsModus) => Promise<PermissionState>;
	requestPermission?: (d?: BerechtigungsModus) => Promise<PermissionState>;
};

function schlüsselFür(griffId: string): string {
	return `${SCHLÜSSEL_PRÄFIX}${griffId}`;
}

/** Kein Programmfehler, sondern ein Zustand (`zustand.ts::'laufwerk-weg'`):
 *  entweder gibt es kein gemerktes Handle mehr, oder die Berechtigung dafür
 *  fehlt. Analog zu `oauth.ts::AnmeldungAbgelaufenFehler` — der Aufrufer von
 *  `adapterFür` unterscheidet das von einem gewöhnlichen Adapter-Fehler. */
export class LaufwerkWegFehler extends Error {
	constructor(grund: string) {
		super(`Laufwerk nicht erreichbar: ${grund}`);
		this.name = 'LaufwerkWegFehler';
	}
}

/** Legt das Verzeichnis-Handle unter der Kennung der Verbindung ab.
 *  `false` = nicht abgelegt (IndexedDB nicht erreichbar) — der Aufrufer
 *  darf die Verbindung dann nicht als wiederherstellbar melden. */
export async function legeGriffAb(griffId: string, griff: Griff): Promise<boolean> {
	try {
		const db = await openIdentityDb();
		await idbPutIdentity(db, schlüsselFür(griffId), griff);
		return true;
	} catch {
		return false;
	}
}

/** Holt das gemerkte Handle zurück — `null`, wenn keins liegt oder die
 *  IndexedDB nicht erreichbar ist. */
export async function holeGriff(griffId: string): Promise<Griff | null> {
	try {
		const db = await openIdentityDb();
		return ((await idbGetIdentity(db, schlüsselFür(griffId))) as Griff | undefined) ?? null;
	} catch {
		return null;
	}
}

/** Vergisst das Handle einer getrennten Verbindung. Best effort — schlägt
 *  das Löschen fehl, gibt es beim nächsten Verbinden ohnehin ein neues Handle. */
export async function vergissGriff(griffId: string): Promise<void> {
	try {
		const db = await openIdentityDb();
		await idbDeleteIdentity(db, schlüsselFür(griffId));
	} catch {
		/* nichts abzuräumen, oder die IndexedDB ist weg — beides kein Fehlerfall beim Trennen */
	}
}

/** Schreibrecht ohne Nachfrage prüfen — sicher ohne Klick aufrufbar. */
export async function griffBerechtigung(griff: Griff): Promise<PermissionState> {
	if (!griff.queryPermission) return 'granted'; // ältere Implementierung ohne Permission-API
	try {
		return await griff.queryPermission({ mode: 'readwrite' });
	} catch {
		return 'denied';
	}
}

/** Schreibrecht aktiv anfragen. MUSS aus einem Klick heraus laufen, sonst
 *  wirft die Plattform `SecurityError` — hier abgefangen, Ergebnis `false`. */
export async function griffBerechtigungAnfordern(griff: Griff): Promise<boolean> {
	if (!griff.requestPermission) return false;
	try {
		return (await griff.requestPermission({ mode: 'readwrite' })) === 'granted';
	} catch {
		return false;
	}
}

/**
 * Der Weg, den `adapterFür` beim Start eines Sync-Ordner-Adapters geht:
 * Handle laden, Berechtigung ohne Klick prüfen, bei fehlender Erlaubnis
 * EINMAL aktiv nachfragen (deckt den Fall, dass der Aufruf doch aus einer
 * Nutzer-Geste kommt — z. B. dem „Trennen/Verbinden"-Handgriff in den
 * Einstellungen), sonst als `laufwerk-weg` melden statt abzustürzen.
 */
export async function ladeNutzbarenGriff(griffId: string): Promise<Griff> {
	const griff = await holeGriff(griffId);
	if (!griff) throw new LaufwerkWegFehler('kein Ordner-Griff gemerkt — Ordner erneut wählen.');

	let zustand = await griffBerechtigung(griff);
	if (!griffNutzbar(zustand) && (await griffBerechtigungAnfordern(griff))) {
		zustand = 'granted';
	}
	if (!griffNutzbar(zustand)) {
		throw new LaufwerkWegFehler(`Zugriff auf „${griff.name}" nicht erteilt (${zustand}).`);
	}
	return griff;
}
