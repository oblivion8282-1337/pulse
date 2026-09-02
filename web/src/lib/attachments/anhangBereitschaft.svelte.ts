/**
 * Kann dieses Gespräch Anhänge tragen? — der Speicher hinter der Büroklammer
 * (Design §11.2).
 *
 * Seit ein verschlüsselter Anhang im Cloud-Ordner **jedes Beteiligten**
 * landet, hängt der Knopf nicht mehr nur am eigenen Zustand: wer kein
 * Laufwerk verbunden hat, kann die Datei nicht empfangen. §11.2 nimmt die
 * dafür nötige Auskunft über andere Konten ausdrücklich in Kauf — sie sagt,
 * dass jemand kein Archiv verbunden hat, und nichts sonst.
 *
 * **Warum je KANAL und nicht je Konto** (anders als `krypto/schloss.svelte.ts`,
 * dem dieser Speicher sonst nachgebaut ist): in einer Gruppe blockiert ein
 * einzelnes Mitglied alle, die Frage ist also die an die ganze Runde. Der
 * Server kennt die Teilnehmermenge ohnehin und beantwortet sie in einem
 * Aufruf statt in N.
 *
 * **Der Sendezeitpunkt bleibt die Autorität**, wie beim Schloss: was hier
 * steht, ist eine Momentaufnahme vom Betreten des Gesprächs. Verbindet
 * jemand sein Laufwerk, während das Gespräch offen ist, merkt das dieser
 * Speicher nicht — die Verteil-Route weist den Anhang dann trotzdem sauber
 * mit `kein_laufwerk` ab. Der Speicher färbt einen Knopf, mehr nicht.
 */

import { postfachApi } from '$lib/api/postfach';
import { serversStore } from '$lib/api/servers.svelte';
import { E2E_DMS_ENABLED } from '$lib/krypto/schalter';

interface Stand {
	moeglich: boolean;
	ohneLaufwerk: string[];
	maxBytes: number;
}

const stand = $state<Record<string, Stand>>({});

/** Sperre gegen Mehrfachabrufe — dieselbe Aufgabe wie `schlossAbfrage.ts`
 *  (das Kennzeichen hängt an einem `$effect`, der bei jeder gelesenen
 *  Abhängigkeit erneut läuft). Ein FEHLGESCHLAGENER Abruf wird wieder
 *  freigegeben, sonst bliebe der Knopf nach einem Netzwackler die ganze
 *  Sitzung aus. */
const gefragt = new Set<string>();

// DMs sind heute cloud-only — s. `api/keys.ts` Modulkopf.
function cloudRoute(): { serverId?: string } {
	return { serverId: serversStore.cloudId() };
}

export const anhangBereitschaft = {
	/** `undefined`, solange nicht gefragt wurde oder der Abruf noch läuft —
	 *  der Aufrufer zeigt in diesem Zustand keinen Knopf und auch keinen
	 *  Hinweis (s. `anhangKnopfSichtbar.ts`). */
	stand(kanalId: string): Stand | undefined {
		return stand[kanalId];
	},

	moeglich(kanalId: string): boolean | undefined {
		return stand[kanalId]?.moeglich;
	},

	/** Konten ohne Laufwerk — leer, solange die Auskunft fehlt. */
	ohneLaufwerk(kanalId: string): string[] {
		return stand[kanalId]?.ohneLaufwerk ?? [];
	},

	/** Die Grössengrenze dieses Servers, `undefined` ohne Auskunft. */
	maxBytes(kanalId: string): number | undefined {
		return stand[kanalId]?.maxBytes;
	},

	/**
	 * Holt die Auskunft, falls noch nicht geschehen.
	 *
	 * Bei ausgeschaltetem `E2E_DMS_ENABLED` passiert gar nichts: dann läuft
	 * jede DM den Klartext-Weg, der Anhang bleibt bei Pulse, und ein Laufwerk
	 * spielt keine Rolle. Ein Serveraufruf wäre hier reine Last.
	 */
	sicherstellen(kanalId: string): void {
		if (!E2E_DMS_ENABLED || !kanalId || gefragt.has(kanalId)) return;
		gefragt.add(kanalId);
		void (async () => {
			try {
				const antwort = await postfachApi.anhangBereitschaft(kanalId, cloudRoute());
				stand[kanalId] = {
					moeglich: antwort.moeglich,
					ohneLaufwerk: antwort.ohne_laufwerk ?? [],
					maxBytes: antwort.max_bytes
				};
			} catch {
				gefragt.delete(kanalId);
			}
		})();
	},

	/** Abmelden — der nächste Aufruf fragt neu. */
	vergessen(kanalId: string): void {
		gefragt.delete(kanalId);
		delete stand[kanalId];
	}
};
