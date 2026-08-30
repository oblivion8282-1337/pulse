/**
 * Das gemeinsame Geschirr für die Ablage-Integrationstests: jeder echte
 * Speicher durchläuft dieselbe Runde — 30 Nachrichten über den Nachzieher
 * festigen (kleine Segmente → mehrere Dateien über das echte Netz), den
 * Verlauf Feld für Feld zurücklesen, eine „Absturz"-Waise adoptieren
 * lassen, das Listing prüfen. Wer hier grün ist, hat den ganzen
 * Schreiber-/Leser-/Nachzugs-Weg über echte Gegenstellen bewiesen.
 */

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { AblageSchreiber } from '../src/lib/ablage/schreiber.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';
import { nachziehen } from '../src/lib/ablage/nachzieher.ts';
import { kodiereNachricht, leseNachricht } from '../src/lib/ablage/nutzlast.ts';
import { baueSegmentAusRahmen, segDateiName } from '../src/lib/ablage/segment.ts';
import { TYP_KLARTEXT_JSON } from '../src/lib/ablage/format.ts';
import type { AblageAdapter } from '../src/lib/ablage/adapter.ts';

export class AblageGeschirr {
	private gruen = 0;
	private rot = 0;

	pruefe(bezeichnung: string, bedingung: boolean, detail?: string): void {
		if (bedingung) {
			this.gruen++;
			console.log(`  ✔ ${bezeichnung}`);
		} else {
			this.rot++;
			console.error(`  ✖ ${bezeichnung}${detail ? ` — ${detail}` : ''}`);
		}
	}

	/** Anzahl roter Prüfungen dieses Geschirrs. */
	fehler(): number {
		return this.rot;
	}

	testNachricht(id: bigint, stempel: string) {
		return {
			fassung: 1,
			id: id.toString(),
			autor: 'int-nutzer',
			inhalt: `Int ${stempel} ${id}`,
			zeit: new Date().toISOString(),
			bearbeitet: null,
			antwortAuf: null,
			anhaenge: [{ id: `a-${id}`, name: 'probe.bin', mime: 'application/octet-stream', groesse: 7 }],
		};
	}

	async rundeAuf(name: string, adapter: AblageAdapter, lauf: string): Promise<void> {
		console.log(`\n== ${name} ==`);
		const festigung = new AblageSchreiber(adapter, 'int-kanal', 1500);
		const eintraege = Array.from({ length: 30 }, (_, i) => {
			const id = 7193284570000n + BigInt(i);
			return { id, nutzlast: kodiereNachricht(this.testNachricht(id, lauf)), typ: TYP_KLARTEXT_JSON };
		});

		const bericht = await nachziehen(festigung, { async holen(nachId, limit) {
			const bei = nachId === null ? 0 : Number(nachId - 7193284570000n) + 1;
			return eintraege.slice(bei, bei + limit);
		} }, { limit: 10 });
		this.pruefe('Nachziehen: 30 festigt', bericht.festigt === 30, `war ${bericht.festigt}`);
		this.pruefe('Manifest: 30 letzteId', festigung.stand()?.letzteId === '7193284570029');
		this.pruefe('Mehrere Segmente', (festigung.stand()?.segmente.length ?? 0) >= 3);

		const verlauf = await leseVerlauf(adapter);
		this.pruefe('Verlauf: 30 Rahmen', verlauf.rahmen.length === 30, `war ${verlauf.rahmen.length}`);
		this.pruefe('Keine Lücken', verlauf.luecken.length === 0, verlauf.luecken.join('; '));
		const inhaltStimmt = verlauf.rahmen.every((r, i) => {
			const n = leseNachricht(r.nutzlast);
			return n.id === eintraege[i].id.toString() && n.inhalt === `Int ${lauf} ${eintraege[i].id}`;
		});
		this.pruefe('Inhalt Feld für Feld', inhaltStimmt);

		// „Absturz": die NÄCHSTE Segmentdatei direkt schreiben, ohne Manifest-
		// Eintrag — der nächste Schreiber muss sie adoptieren. (Ein
		// Kettenbrecher würde korrekt ÜBERSPRUNGEN, nicht adoptiert.)
		const waisenIndex = festigung.stand()!.segmente.length;
		const waise = baueSegmentAusRahmen(waisenIndex, [
			{ typ: TYP_KLARTEXT_JSON, eintragsId: 7193284570100n, nutzlast: kodiereNachricht(this.testNachricht(7193284570100n, lauf)) },
		]);
		await adapter.schreibe(segDateiName(waisenIndex), waise);
		const zweiter = new AblageSchreiber(adapter, 'int-kanal', 1500);
		const nachzug = await zweiter.bestandAufnehmen();
		this.pruefe('Waise adoptiert', nachzug.adoptiert.includes(segDateiName(waisenIndex)), JSON.stringify(nachzug));
		this.pruefe('Manifest: 31 letzteId', zweiter.stand()?.letzteId === '7193284570100');
		const verlauf2 = await leseVerlauf(adapter);
		this.pruefe('Verlauf nach Adoption: 31', verlauf2.rahmen.length === 31, `war ${verlauf2.rahmen.length}`);

		const liste = await adapter.liste();
		this.pruefe('Liste kennt Segmente + Manifest', liste.some((n) => n.startsWith('seg-')) && liste.some((n) => n === 'manifest.puls'), JSON.stringify(liste));
	}
}
