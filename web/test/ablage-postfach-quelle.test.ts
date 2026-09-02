import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { AblageSchreiber } from '../src/lib/ablage/schreiber.ts';
import { nachziehen } from '../src/lib/ablage/nachzieher.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';
import { leseNachricht } from '../src/lib/ablage/nutzlast.ts';
import { TYP_KLARTEXT_JSON } from '../src/lib/ablage/format.ts';
import { postfachQuelle } from '../src/lib/ablage/postfachQuelle.ts';
import { ART_GRUPPENNACHRICHT } from '../src/lib/krypto/gruppe/gruppenNutzlast.ts';
import type { PostfachZustellung } from '../src/lib/api/postfach.ts';
import type { Message } from '../src/lib/api/types.ts';

const KANAL = 'kanal-ablage-1';
const FREMDER_KANAL = 'kanal-anders';
const GERAET = 'geraet-fest-1';

function zustellung(
	id: string,
	overrides: Partial<PostfachZustellung> = {},
): PostfachZustellung {
	return {
		id,
		channel_id: KANAL,
		absender_device_pubkey: 'sender-geraet',
		absender_curve25519: null,
		absender_user_id: 'nutzer-9',
		art: ART_GRUPPENNACHRICHT,
		daten: `geheimtext-${id}`,
		groesse: 12,
		...overrides,
	};
}

/** Fake-Entschlüsselung: jede Zustellung in `offenbar` liefert eine
 *  Klartext-Nachricht zurück, alles andere bleibt liegen (`null`). */
function fakeOeffner(offenbar: Set<string>) {
	const versucht: string[] = [];
	const oeffnen = async (z: PostfachZustellung): Promise<Message | null> => {
		versucht.push(z.id);
		if (!offenbar.has(z.id)) return null;
		return {
			id: z.id,
			channel_id: z.channel_id,
			author_id: z.absender_user_id ?? 'unbekannt',
			content: `Klartext ${z.id}`,
			nonce: null,
			created_at: '2026-09-01T10:00:00Z',
		};
	};
	return { oeffnen, versucht };
}

describe('Ablage-Postfachquelle', () => {
	it('archiviert entschlüsselte Gruppennachrichten des Kanals, aufsteigend hinter dem Wasserzeichen', async () => {
		const bestand = [zustellung('100'), zustellung('101'), zustellung('102')];
		const abholen = async (deviceKennung: string) => {
			assert.equal(deviceKennung, GERAET);
			return bestand;
		};
		const { oeffnen } = fakeOeffner(new Set(['100', '101', '102']));
		const quelle = postfachQuelle(KANAL, async () => GERAET, abholen, oeffnen);

		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, KANAL);
		const bericht = await nachziehen(schreiber, quelle, { limit: 200 });

		assert.equal(bericht.festigt, 3);
		assert.equal(bericht.wasserzeichen, 102n);

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[100n, 101n, 102n],
		);
		assert.ok(verlauf.rahmen.every((r) => r.typ === TYP_KLARTEXT_JSON));
		const inhalte = verlauf.rahmen.map((r) => leseNachricht(r.nutzlast).inhalt);
		assert.deepEqual(inhalte, ['Klartext 100', 'Klartext 101', 'Klartext 102']);
	});

	it('ignoriert Zustellungen aus anderen Kanälen und Nicht-Gruppennachrichten', async () => {
		const bestand = [
			zustellung('50', { channel_id: FREMDER_KANAL }),
			zustellung('51', { art: 0 }), // Sitzungsaufbau, keine Gruppennachricht
			zustellung('52'),
		];
		const { oeffnen, versucht } = fakeOeffner(new Set(['52']));
		const quelle = postfachQuelle(KANAL, async () => GERAET, async () => bestand, oeffnen);

		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, KANAL);
		await nachziehen(schreiber, quelle, { limit: 200 });

		// Nur die passende Zustellung wurde überhaupt zum Öffnen vorgelegt.
		assert.deepEqual(versucht, ['52']);
		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[52n],
		);
	});

	it('hält am ersten nicht öffenbaren Eintrag an, statt ihn zu überspringen', async () => {
		// 200 ist zu diesem Zeitpunkt nicht zu öffnen (Sitzungsschlüssel fehlt
		// noch); 201 wäre lesbar, darf das Wasserzeichen aber NICHT über 200
		// hinausschieben — sonst wäre 200 für immer unter dem Wasserzeichen.
		const bestand = [zustellung('200'), zustellung('201')];
		const { oeffnen } = fakeOeffner(new Set(['201']));
		const quelle = postfachQuelle(KANAL, async () => GERAET, async () => bestand, oeffnen);

		const ablage = speicherAdapter();
		const schreiber = new AblageSchreiber(ablage, KANAL);
		const bericht = await nachziehen(schreiber, quelle, { limit: 200 });

		assert.equal(bericht.festigt, 0);
		assert.equal(bericht.wasserzeichen, null);
		assert.equal(bericht.leergelaufen, true);

		// Ein zweiter Lauf, bei dem sich 200 inzwischen geöffnet hat (der
		// Schlüssel kam nach) — beide werden nachgezogen, keiner fehlt.
		const { oeffnen: oeffnenSpaeter } = fakeOeffner(new Set(['200', '201']));
		const quelleSpaeter = postfachQuelle(
			KANAL,
			async () => GERAET,
			async () => bestand,
			oeffnenSpaeter,
		);
		const berichtSpaeter = await nachziehen(schreiber, quelleSpaeter, { limit: 200 });
		assert.equal(berichtSpaeter.festigt, 2);
		assert.equal(berichtSpaeter.wasserzeichen, 201n);

		const verlauf = await leseVerlauf(ablage);
		assert.deepEqual(
			verlauf.rahmen.map((r) => r.eintragsId),
			[200n, 201n],
		);
	});

	it('respektiert das Limit und bricht die Runde ab, ohne über die Grenze hinaus zu öffnen', async () => {
		const bestand = [zustellung('10'), zustellung('11'), zustellung('12')];
		const { oeffnen, versucht } = fakeOeffner(new Set(['10', '11', '12']));
		const quelle = postfachQuelle(KANAL, async () => GERAET, async () => bestand, oeffnen);

		const eintraege = await quelle.holen(null, 2);
		assert.deepEqual(
			eintraege.map((e) => e.id),
			[10n, 11n],
		);
		assert.deepEqual(versucht, ['10', '11']);
	});
});
