/**
 * Die REST-Quelle des Nachziehers — Phase 1 (Klartext, `messages`-Tabelle).
 * Der Krypto-Nachzug tauscht sie gegen das Postfach; diese Datei wandert
 * dann in den Ruhestand.
 *
 * Ein Haken aus dem Server-Vertrag: `GET /channels/{id}/messages` sortiert
 * IMMER absteigend, auch mit `after` (routes/messages.py:111). Ein
 * Lückennachzug durch eine 500-Nachrichten-Lücke bekäme sonst nur die
 * neuesten 100 und verlöre die Mitte. Diese Quelle blättert die Lücke
 * deshalb selbst durch — `after` plus wanderndem `before` — und liefert
 * das Ganze als EINE aufsteigende Partie. Der Speicherbedarf wächst mit
 * der Lücke; für den Erstdurchlauf eines alten Kanals ist das der Preis
 * der Server-Ordnung, und das Postfach macht ihn später ohnehin hinfällig.
 *
 * **Die Obergrenze `MAX_SEITEN` wirft, statt zu kürzen.** Weil der Lauf von
 * NEU nach ALT geht, wäre das Abgeschnittene ausgerechnet der Teil direkt
 * über dem Wasserzeichen — und der Nachzieher setzt sein Wasserzeichen auf
 * die HÖCHSTE gelieferte Id, womit der übersprungene Block für immer darunter
 * läge. Bis zum 2026-08-31 kam die gekürzte Partie hier als ganz normale
 * Rückgabe heraus; ein zusammenhängender Block fehlte danach still im
 * Archiv, ohne Fehler und ohne Lücken-Eintrag — anders als die
 * Segment-Lücken, die `leser.ts` benennt. Ein Wurf hält das Wasserzeichen
 * stehen; der Preis ist ein Nachzug, der bei einer Lücke jenseits von
 * 20 000 Nachrichten stehen bleibt, statt sie halb zu sichern.
 *
 * Der Anschluss an den echten Klienten (hinter ABLAGE_KANAL_ENABLED) ist
 * eine Zeile:
 *   restQuelle((nach, vor, limit) =>
 *     chatApi.listMessages(kanalId, { after: nach ?? undefined, before: vor ?? undefined, limit }))
 */

import { TYP_KLARTEXT_JSON } from './format.ts';
import { ausWire, kodiereNachricht } from './nutzlast.ts';
import type { NachzieherQuelle } from './nachzieher.ts';
import type { AblageEintrag } from './schreiber.ts';
import type { Message } from '../api/types.ts';

/** Signatur passend zu `chatApi.listMessages` — beide Cursor optional. */
export type RestAbruf = (
	nach: string | null,
	vor: string | null,
	limit: number,
) => Promise<Message[]>;

/** Der Server nimmt höchstens 100 pro Seite (Query-Grenze `le=100`). */
export const REST_SEITEN_GROESSE = 100;
/** Hartes Bremsen gegen Endlosschleifen bei kaputten Gegenstellen.
 *  Exportiert, damit der Test die Grenze nicht abschreiben muss — eine
 *  abgeschriebene Grenze prüft nach der nächsten Änderung nichts mehr. */
export const MAX_SEITEN = 200;

/** Die Lücke war grösser, als der Blätterlauf sie durchmessen kann.
 *
 *  Geworfen statt halb geliefert: der Lauf geht von NEU nach ALT, das
 *  Abgeschnittene liegt also direkt über dem Wasserzeichen — und der
 *  Nachzieher würde sein Wasserzeichen auf die höchste gelieferte Id setzen
 *  (`nachzieher.ts`), womit die übersprungene Mitte für immer darunter läge.
 *  Ein Wurf hält das Wasserzeichen stehen und macht den Fall sichtbar. */
export class LueckeZuGross extends Error {
	constructor(seiten: number) {
		super(
			`Luecke groesser als ${seiten} Seiten a ${REST_SEITEN_GROESSE} — ` +
				`Nachzug angehalten, damit kein Block still uebersprungen wird`,
		);
		this.name = 'LueckeZuGross';
	}
}

export function restQuelle(abruf: RestAbruf): NachzieherQuelle {
	return {
		async holen(nachId, limit) {
			const nach = nachId === null ? null : nachId.toString();
			const seitengroesse = Math.min(limit, REST_SEITEN_GROESSE);
			const gesammelt: Message[] = [];
			let vor: string | null = null;
			let durch = false;
			for (let seite = 0; seite < MAX_SEITEN; seite++) {
				const ladung = await abruf(nach, vor, seitengroesse);
				if (ladung.length === 0) {
					durch = true;
					break;
				}
				gesammelt.push(...ladung);
				if (ladung.length < seitengroesse) {
					durch = true;
					break;
				}
				// Absteigende Seite: der letzte Eintrag ist der älteste —
				// die nächste Grenze wandert auf ihn.
				vor = ladung[ladung.length - 1].id;
			}
			// Die Grenze erreicht, ohne dass eine kurze Seite das Ende angezeigt
			// hätte. Das heisst noch NICHT, dass etwas fehlt: eine Lücke von
			// genau `MAX_SEITEN * REST_SEITEN_GROESSE` füllt die letzte Seite
			// exakt aus und ist trotzdem vollständig geholt. Eine einzige
			// weitere Anfrage klärt das exakt — und nur wenn die etwas
			// zurückgibt, fehlt der ÄLTESTE Teil der Lücke, also genau der, der
			// als Nächstes gefestigt werden müsste. Siehe `LueckeZuGross`.
			if (!durch && (await abruf(nach, vor, seitengroesse)).length > 0) {
				throw new LueckeZuGross(MAX_SEITEN);
			}
			return gesammelt
				.filter((m) => m.deleted_at == null)
				.filter((m) => nachId === null || BigInt(m.id) > nachId)
				.sort((a, b) =>
					BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
				)
				.map((m) => ({
					id: BigInt(m.id),
					nutzlast: kodiereNachricht(ausWire(m)),
					typ: TYP_KLARTEXT_JSON,
				}));
		},
	};
}
