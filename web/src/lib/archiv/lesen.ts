/**
 * Leseweg des Server-Archivs (Übergabe 2026-10-04, §5): holt verschlüsselte
 * Zeilen beim chat-gateway, öffnet den Kanal-Schlüssel mit dem eigenen
 * Konto-Schlüssel und schreibt die Nachrichten in den LOKALEN Verlauf —
 * derselbe Weg, den die Sicherungs-Spiegelung nimmt (`sicherung/andock`).
 * Ein Gerät ohne lokalen Bestand (Neuinstallation, zweiter Rechner) bekommt
 * so „überall den exakten Verlauf“.
 *
 * Der Lesestand je Kanal ist ein Cursor, der von NEU nach ALT wandert: der
 * Kanalwechsel-Öffner lädt die jüngsten Seiten, jedes Hochscrollen eine
 * weitere ältere — bis eine Seite leer kommt (dann ist das Archiv für
 * diesen Kanal ausgelesen). Neue Nachrichten landen am jungen Ende und
 * berühren den Cursor nicht.
 *
 * Bestandsaufnahme: das Archiv trägt nur, was seit der Einrichtung GESENDET
 * wurde — kein Backfill alter Verläufe, Anhänge sind Platzhalter (§5.4).
 */

import { auth } from '$lib/stores/auth.svelte';
import type { Message } from '$lib/api/types';
import { archivKanalSchluessel, archivSeite, type ArchivZeileFern } from '$lib/api/archiv';
import { kanalSchluesselHolen } from './kanalSchluessel';
import { entschluesseleZeile } from './krypto';
import { archivPaar } from './konto';
import { verlaufSpeichern } from '$lib/verlauf';

const SEITEN_GROESSE = 500;

function vonB64(wert: string): Uint8Array {
	const binär = atob(wert);
	const bytes = new Uint8Array(binär.length);
	for (let i = 0; i < binär.length; i++) bytes[i] = binär.charCodeAt(i);
	return bytes;
}

interface ArchivKlar {
	i: string;
	t: string;
	a: string;
	z: string;
	r?: string;
	v?: number;
}

/** Zeile → Message-Form (lokal verwertbar, dedupet per Id im lokalen Store). */
function zuNachricht(zeile: ArchivZeileFern, inhalt: ArchivKlar): Message {
	return {
		id: inhalt.i,
		channel_id: zeile.channel_id,
		author_id: inhalt.a,
		content: inhalt.t,
		nonce: null,
		reply_to_id: inhalt.r ?? null,
		created_at: inhalt.z,
		verschluesselt: true
	};
}

/** Lesestand je Kanal: ältester schon geholter Zeilen-Id (`null` = Anfang). */
const lesestand = new Map<string, string>();

/**
 * Zieht die nächste(n) Archiv-Seite(n) in den lokalen Verlauf. `maxSeiten`
 * steuert, wie viel auf einmal nachkommt (Öffner: mehrere, Scrollen: eine).
 * Rückgabe: Anzahl neu abgelegter Sätze. Wirft nie — Aufrufer sind
 * fire-and-forget (Kanalwechsel, Hochscrollen).
 */
export async function archivNachziehen(kanalId: string, maxSeiten = 4): Promise<number> {
	try {
		const kontoId = auth.user?.id;
		if (!kontoId) return 0;
		const paar = await archivPaar(kontoId);
		if (!paar) return 0; // Archiv auf diesem Gerät zu — kein lokaler Schaden

		const eigenWrap = await archivKanalSchluessel(kanalId);
		if (!eigenWrap) return 0; // noch nie archiviert
		// Partner-Id nur für die ERSTANLAGE relevant — die lief hier nie (oben
		// wird ohne eigenen Wrap schon ausgestiegen); `null` = kein Fremd-Wrap.
		const kanalSchluessel = await kanalSchluesselHolen(kanalId, paar, '', null);

		let gesamt = 0;
		for (let seite = 0; seite < maxSeiten; seite++) {
			const vorId = lesestand.get(kanalId);
			const zeilen = await archivSeite(kanalId, vorId, SEITEN_GROESSE);
			if (zeilen.length === 0) break;
			const nachrichten: Message[] = [];
			for (const zeile of zeilen) {
				try {
					const klarText = new TextDecoder().decode(
						await entschluesseleZeile(kanalSchluessel, vonB64(zeile.nutzlast_b64))
					);
					nachrichten.push(zuNachricht(zeile, JSON.parse(klarText) as ArchivKlar));
				} catch (e) {
					// Eine unlesbare Zeile (kaputter Wrap, fremde Fassung) blockiert
					// nicht die übrigen — der Rest des Archivs bleibt verwertbar.
					console.info('[archiv] lesen: Zeile unlesbar', (e as Error).message);
				}
			}
			if (nachrichten.length > 0) {
				gesamt += await verlaufSpeichern(kanalId, nachrichten);
			}
			// Server liefert aufsteigend — die ERSTE Id ist die älteste der Seite.
			lesestand.set(kanalId, zeilen[0].id);
			if (zeilen.length < SEITEN_GROESSE) break;
		}
		return gesamt;
	} catch (e) {
		console.warn('[archiv] Nachziehen fehlgeschlagen', e);
		return 0;
	}
}
