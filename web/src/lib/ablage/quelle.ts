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
/** Hartes Bremsen gegen Endlosschleifen bei kaputten Gegenstellen. */
const MAX_SEITEN = 200;

export function restQuelle(abruf: RestAbruf): NachzieherQuelle {
	return {
		async holen(nachId, limit) {
			const nach = nachId === null ? null : nachId.toString();
			const seitengroesse = Math.min(limit, REST_SEITEN_GROESSE);
			const gesammelt: Message[] = [];
			let vor: string | null = null;
			for (let seite = 0; seite < MAX_SEITEN; seite++) {
				const ladung = await abruf(nach, vor, seitengroesse);
				if (ladung.length === 0) {
					break;
				}
				gesammelt.push(...ladung);
				if (ladung.length < seitengroesse) {
					break;
				}
				// Absteigende Seite: der letzte Eintrag ist der älteste —
				// die nächste Grenze wandert auf ihn.
				vor = ladung[ladung.length - 1].id;
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
