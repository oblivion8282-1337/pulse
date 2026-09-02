/**
 * Die Postfach-Quelle des Nachziehers — Phase 2 (verschlüsselt, `Ablage-
 * Kanal` als Megolm-Gruppe). Löst `quelle.ts` (die REST-Fassung) für einen
 * `ablage=true`-Kanal ab; dieselbe Schnittstelle (`NachzieherQuelle`), ein
 * anderes Blättern.
 *
 * **Frage 1 — liefert `POST /postfach/abholen` streng aufsteigend?** Ja, mit
 * Beleg: `routes/postfach_abholen.py::postfach_abholen` sortiert
 * `.order_by(DmZustellung.id)`, und `krypto/postfachSchleife.ts` (Modulkopf)
 * verlässt sich bereits an anderer Stelle auf genau diese Zusage („liefert
 * nach stabiler ID-Reihenfolge (FIFO)"). Anders als beim REST-Weg gibt es
 * dabei aber **gar keinen Cursor**: die Route nimmt weder `after` noch
 * `limit` entgegen und liefert IMMER den ganzen offenen Bestand des
 * Geräts — über alle Kanäle und Umschlagsarten hinweg. Diese Quelle filtert
 * deshalb selbst auf `kanalId`, auf Gruppennachrichten
 * (`ART_GRUPPENNACHRICHT`) und auf „echt hinter `nachId`", statt sich auf
 * einen Server-Cursor zu verlassen, der nicht existiert. Weil Zustellungs-
 * Ids serverseitig eindeutig und aufsteigend sind, ist ein Client-Filter
 * `id > nachId` exakt „streng aufsteigend, exklusiv" — keine Näherung.
 *
 * **Frage 2 — roh oder entschlüsselt ablegen?** Entschlüsselt (Typ
 * `TYP_KLARTEXT_JSON`, wie Phase 1). Das Archiv soll Jahre überleben, und
 * eine Megolm-Sitzung, die bei jedem Mitgliederwechsel rotiert, ist kein
 * Fundament dafür — ein Geheimtext im Archiv wäre ohne genau die rotierten
 * Sitzungen, die ihn einmal geöffnet haben, wertlos. `TYP_MEGOLM` bleibt in
 * `format.ts` reserviert, falls jemand später bewusst roh ablegen will;
 * diese Quelle nutzt ihn nicht.
 *
 * **Kein eigener Netz-/Krypto-Import.** `postfachApi.abholen` und
 * `krypto/gruppe/empfangen.ts::oeffneGruppennachricht` hängen (transitiv)
 * an IndexedDB und dem WASM-Krypto-Kern — Module ohne durchgängige
 * `.ts`-Endungen an ihren Imports, die Node (`pnpm test:unit`) nicht
 * auflöst (CLAUDE.md, „Die Falle"). Diese Datei nimmt beides deshalb als
 * Parameter entgegen (Muster: `quelle.ts::restQuelle`, dort `RestAbruf`) —
 * die Verdrahtung mit den echten Funktionen ist eine Zeile, an der Stelle,
 * die den Ablage-Kanal ans Chat-System hängt (Etappe-Plan, Aufgabe 5).
 *
 * **Öffnen heißt: dieselbe Funktion, die der normale Empfang benutzt —
 * nicht nachgebaut.** Der Aufrufer übergibt `oeffnen` mit exakt der
 * Signatur von `oeffneGruppennachricht`; produktiv ist das genau diese
 * Funktion. Wichtig für den Aufrufer: `gruppenSitzungen.ts` (Modulkopf)
 * hält fest, dass eingehende Megolm-Sitzungen **ausschließlich** im
 * Abholzyklus von `krypto/empfangen.ts` ratchen, unter dessen Konto-Sperre —
 * „wer sie an einer neuen Stelle verändert, bringt eine eigene Sperre mit".
 * Diese Quelle ist genau so eine neue Stelle. Sie bringt selbst keine Sperre
 * mit (sie kennt den Sperr-Mechanismus nicht, ohne den schweren Import-Kegel
 * doch noch hereinzuholen) — der Aufrufer muss `oeffnen` mit derselben
 * Sperre umgeben, sonst ratcht ein zweiter, unsynchronisierter Aufrufer an
 * derselben eingehenden Sitzung vorbei am normalen Empfang.
 *
 * **Quittiert wird hier NICHT.** `abholen` löscht ohnehin nichts (der
 * Server räumt erst auf `POST /postfach/quittung` auf) — diese Quelle liest
 * rein additiv und lässt jede Zustellung unangetastet liegen. Die Quittung
 * bleibt Sache des normalen Empfangswegs (`krypto/empfangen.ts`), der für
 * die Chat-Anzeige ohnehin quittieren muss; ein zweiter, unabhängiger
 * Quittungs-Pfad hier würde nur das Risiko schaffen, eine Zustellung
 * wegzuquittieren, bevor dieser Nachzug sie gesehen hat — und genau das
 * Wasserzeichen-Loch, vor dem `nachzieher.ts` warnt, wäre die Folge.
 *
 * **Eine Zustellung, die sich nicht öffnen lässt, hält den Nachzug an, statt
 * sie zu überspringen.** `oeffnen` liefert `null`, wenn die Sitzung fehlt
 * (Schlüssel noch nicht angekommen) oder der Geheimtext nicht mehr passt.
 * Beide Fälle heilen sich laut `gruppe/empfangen.ts` (Modulkopf) von selbst
 * — durch eine spätere Sendung, die den Schlüssel nachliefert. Ein
 * Überspringen wäre hier die falsche Wahl: das Wasserzeichen rückt mit der
 * höchsten *gelieferten* Id vor (`nachzieher.ts`), und eine übersprungene,
 * noch nicht offene Zustellung läge für immer darunter, sobald eine JÜNGERE
 * erfolgreich geliefert wird. `holen()` bricht deshalb an der ERSTEN
 * unlesbaren Zustellung dieser Runde ab und liefert nur, was VOR ihr schon
 * offen war — der nächste Aufruf (mit demselben Wasserzeichen) versucht sie
 * erneut. Aus Sicht von `nachziehen()` sieht das wie eine kurze Runde aus
 * (`leergelaufen: true`), nicht wie ein Fehler — kein Datenverlust, nur
 * Warten.
 */

import { TYP_KLARTEXT_JSON } from './format.ts';
import { ausWire, kodiereNachricht } from './nutzlast.ts';
import type { NachzieherQuelle } from './nachzieher.ts';
import type { AblageEintrag } from './schreiber.ts';
import type { Message } from '../api/types.ts';
import type { PostfachZustellung } from '../api/postfach.ts';
import { ART_GRUPPENNACHRICHT } from '../krypto/gruppe/gruppenNutzlast.ts';

/** Holt den vollen offenen Postfach-Bestand des genannten Geräts — ohne
 *  Cursor, s. Modulkopf. Produktiv `(k) => postfachApi.abholen({device_pubkey: k}, route)`. */
export type PostfachAbruf = (deviceKennung: string) => Promise<PostfachZustellung[]>;

/** Öffnet eine Gruppennachricht oder liefert `null`, wenn sie liegen bleiben
 *  muss (s. Modulkopf). Produktiv `oeffneGruppennachricht` aus
 *  `krypto/gruppe/empfangen.ts`, unter derselben Sperre wie der normale
 *  Empfang. */
export type ZustellungOeffner = (zustellung: PostfachZustellung) => Promise<Message | null>;

/**
 * Baut eine `NachzieherQuelle` für einen einzelnen Ablage-Kanal.
 *
 * @param kanalId Kanal, dessen Gruppennachrichten archiviert werden — der
 *   Postfach-Bestand trägt alle Kanäle des Geräts durcheinander, s. oben.
 * @param geraeteKennung Liefert die eigene Geräte-Kennung, frisch je Abruf
 *   (wie `krypto/empfangen.ts::postfachZyklus` es hält) — kein einmalig
 *   eingefrorener Wert.
 */
export function postfachQuelle(
	kanalId: string,
	geraeteKennung: () => Promise<string>,
	abholen: PostfachAbruf,
	oeffnen: ZustellungOeffner,
): NachzieherQuelle {
	return {
		async holen(nachId, limit) {
			const kennung = await geraeteKennung();
			const bestand = await abholen(kennung);

			// Server-Reihenfolge ist laut Beleg oben schon aufsteigend — hier
			// zusätzlich sortiert, damit die Zusage nicht stillschweigend
			// vorausgesetzt wird, sondern geprüft ist (dieselbe Vorsicht wie
			// `quelle.ts`, das seine eigene Sortierung ebenfalls nicht dem
			// Server überlässt).
			const kandidaten = bestand
				.filter((z) => z.channel_id === kanalId && z.art === ART_GRUPPENNACHRICHT)
				.map((z) => ({ zustellung: z, id: BigInt(z.id) }))
				.filter(({ id }) => nachId === null || id > nachId)
				.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

			const eintraege: AblageEintrag[] = [];
			for (const { zustellung, id } of kandidaten) {
				if (eintraege.length >= limit) break;
				const nachricht = await oeffnen(zustellung);
				if (nachricht === null) {
					// Anhalten statt überspringen — Begründung im Modulkopf.
					break;
				}
				eintraege.push({
					id,
					typ: TYP_KLARTEXT_JSON,
					nutzlast: kodiereNachricht(ausWire(nachricht)),
				});
			}
			return eintraege;
		},
	};
}
