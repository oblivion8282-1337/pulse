/**
 * Der Nachzieher — die Fütter-Schleife zwischen einer Nachrichtenquelle und
 * dem Ablage-Schreiber. Er kennt beides nur über ihre Schnittstellen: die
 * Quelle liefert aufsteigende Einträge hinter einem Wasserzeichen, der
 * Schreiber kennt weder REST noch Krypto.
 *
 * Der Krypto-Nachzug tauscht allein die Quelle (Postfach statt
 * `GET /channels/{id}/messages`) — diese Schleife bleibt stehen.
 *
 * Ein Durchlauf läuft leer oder bis zum Rundenzähl; der Dauerpoller ist
 * Sache des Aufrufers. Liefert die Quelle Ids hinter dem Wasserzeichen,
 * wirft `festigen` — absichtlich, denn die Prüfung läuft, bevor etwas
 * geschrieben wird: dann steht auch nichts in der Ablage.
 */

import type { AblageEintrag } from './schreiber.ts';
import type { AblageSchreiber } from './schreiber.ts';

export interface NachzieherQuelle {
	/**
	 * Die nächsten Einträge streng **hinter** `nachId` (ausschließlich),
	 * aufsteigend, höchstens `limit` viele. `nachId === null` heißt: vom Anfang.
	 */
	holen(nachId: bigint | null, limit: number): Promise<AblageEintrag[]>;
}

export interface NachzieherBericht {
	/** Rahmen, die in diesem Durchlauf neu in der Ablage landeten. */
	festigt: number;
	/** Das Wasserzeichen nach dem Durchlauf — null, wenn die Ablage leer ist. */
	wasserzeichen: bigint | null;
	/** true, wenn die Quelle weniger als `limit` lieferte: vorerst leer. */
	leergelaufen: boolean;
}

const STANDARD_LIMIT = 200;
const STANDARD_RUNDEN = 20;

export async function nachziehen(
	schreiber: AblageSchreiber,
	quelle: NachzieherQuelle,
	optionen: { limit?: number; runden?: number } = {},
): Promise<NachzieherBericht> {
	const limit = optionen.limit ?? STANDARD_LIMIT;
	const runden = optionen.runden ?? STANDARD_RUNDEN;

	// Ein aufgenommener, aber leerer Bestand trägt letzteId null — auch dann
	// beginnt der Nachzug am Anfang.
	const letzte = schreiber.stand()?.letzteId;
	const wasserzeichen0 = letzte !== undefined && letzte !== null ? BigInt(letzte) : null;
	let wasserzeichen: bigint | null = wasserzeichen0;
	let festigt = 0;
	let leergelaufen = false;

	for (let runde = 0; runde < runden; runde++) {
		const ladung = await quelle.holen(wasserzeichen, limit);
		if (ladung.length === 0) {
			leergelaufen = true;
			break;
		}
		await schreiber.festigen(ladung);
		festigt += ladung.length;
		wasserzeichen = ladung[ladung.length - 1].id;
		if (ladung.length < limit) {
			leergelaufen = true;
			break;
		}
	}

	return { festigt, wasserzeichen, leergelaufen };
}
