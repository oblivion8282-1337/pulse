/**
 * Integrationstest für die Ablage-Adapter gegen ECHTE Server — bewusst
 * kein Unit-Test (braucht laufende Gegenstellen, deshalb eigener Aufruf):
 *
 *   pnpm test:ablage-int
 *
 * Erwartete Umgebung (Voreinstellungen passen zum SSH-Tunnel auf den
 * Hetzner-Dev-Stack, siehe infra/dev-remote/README.md):
 *
 *   ABLAGE_INT_S3_WIRT      Default http://127.0.0.1:9100   (Tunnel → minio:9000)
 *   ABLAGE_INT_S3_EIMER     Default pulse-ablage-int
 *   ABLAGE_INT_S3_REGION    Default us-east-1
 *   ABLAGE_INT_S3_SCHLUESSEL / ABLAGE_INT_S3_GEHEIMNIS      (Pflicht)
 *   ABLAGE_INT_DAV_URL      Default http://127.0.0.1:8888/remote.php/dav/files/admin
 *   ABLAGE_INT_DAV_BENUTZER Default admin
 *   ABLAGE_INT_DAV_PASSWORT Default pulse-int-2026
 *
 * Jeder Lauf legt einen frischen Ordner/Präfix an (Zeitstempel) und räumt
 * nichts weg — Wegwerfdaten auf einem Dev-Stack.
 */

import { speicherAdapter } from '../src/lib/ablage/adapter.ts';
import { s3Adapter, signiereAnfrage } from '../src/lib/ablage/s3.ts';
import { webdavAdapter } from '../src/lib/ablage/webdav.ts';
import { AblageSchreiber } from '../src/lib/ablage/schreiber.ts';
import { leseVerlauf } from '../src/lib/ablage/leser.ts';
import { nachziehen } from '../src/lib/ablage/nachzieher.ts';
import { kodiereNachricht, leseNachricht } from '../src/lib/ablage/nutzlast.ts';
import { baueSegmentAusRahmen, segDateiName } from '../src/lib/ablage/segment.ts';
import { TYP_KLARTEXT_JSON } from '../src/lib/ablage/format.ts';
import type { AblageAdapter } from '../src/lib/ablage/adapter.ts';

let fehlgeschlagen = 0;

function pruefe(bezeichnung: string, bedingung: boolean, detail?: string): void {
	if (bedingung) {
		console.log(`  ✔ ${bezeichnung}`);
	} else {
		fehlgeschlagen++;
		console.error(`  ✖ ${bezeichnung}${detail ? ` — ${detail}` : ''}`);
	}
}

function umgebung(name: string, vorgabe?: string): string | null {
	const wert = process.env[name] ?? vorgabe ?? null;
	return wert;
}

function testNachricht(id: bigint, stempel: string) {
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

/**
 * Das Geschirr, das jeder echte Speicher durchlaufen muss: 30 Nachrichten
 * über den Nachzieher festigen (kleine Segmente → mehrere Dateien über das
 * echte Netz), Verlauf zurücklesen und Feld für Feld vergleichen, dann ein
 * „Absturz" simulieren: eine verwaiste Segmentdatei direkt schreiben und
 * vom nächsten Schreiber adoptieren lassen.
 */
async function rundeAufAdapter(name: string, adapter: AblageAdapter, lauf: string): Promise<void> {
	console.log(`\n== ${name} ==`);
	const stempel = lauf;

	const festigung = new AblageSchreiber(adapter, 'int-kanal', 1500);
	const eintraege = Array.from({ length: 30 }, (_, i) => {
		const id = 7193284570000n + BigInt(i);
		return { id, nutzlast: kodiereNachricht(testNachricht(id, stempel)), typ: TYP_KLARTEXT_JSON };
	});

	const bericht = await nachziehen(festigung, { async holen(nachId, limit) {
		const bei = nachId === null ? 0 : Number(nachId - 7193284570000n) + 1;
		return eintraege.slice(bei, bei + limit);
	} }, { limit: 10 });
	pruefe('Nachziehen: 30 festigt', bericht.festigt === 30, `war ${bericht.festigt}`);
	pruefe('Manifest: 30 letzteId', festigung.stand()?.letzteId === '7193284570029');
	pruefe('Mehrere Segmente', (festigung.stand()?.segmente.length ?? 0) >= 3);

	const verlauf = await leseVerlauf(adapter);
	pruefe('Verlauf: 30 Rahmen', verlauf.rahmen.length === 30, `war ${verlauf.rahmen.length}`);
	pruefe('Keine Lücken', verlauf.luecken.length === 0, verlauf.luecken.join('; '));
	const inhaltStimmt = verlauf.rahmen.every((r, i) => {
		const n = leseNachricht(r.nutzlast);
		return n.id === eintraege[i].id.toString() && n.inhalt === `Int ${stempel} ${eintraege[i].id}`;
	});
	pruefe('Inhalt Feld für Feld', inhaltStimmt);

	// „Absturz": die NÄCHSTE Segmentdatei direkt schreiben, ohne Manifest-
	// Eintrag — der nächste Schreiber muss sie adoptieren und der Verlauf
	// muss vollständig bleiben. (Ein Kettenbrecher wie seg-000099 würde
	// korrekt ÜBERSPRUNGEN, nicht adoptiert.)
	const waisenIndex = festigung.stand()!.segmente.length;
	const waise = baueSegmentAusRahmen(waisenIndex, [
		{ typ: TYP_KLARTEXT_JSON, eintragsId: 7193284570100n, nutzlast: kodiereNachricht(testNachricht(7193284570100n, stempel)) },
	]);
	await adapter.schreibe(segDateiName(waisenIndex), waise);
	const zweiter = new AblageSchreiber(adapter, 'int-kanal', 1500);
	const nachzug = await zweiter.bestandAufnehmen();
	pruefe('Waise adoptiert', nachzug.adoptiert.includes(segDateiName(waisenIndex)), JSON.stringify(nachzug));
	pruefe('Manifest: 31 letzteId', zweiter.stand()?.letzteId === '7193284570100');
	const verlauf2 = await leseVerlauf(adapter);
	pruefe('Verlauf nach Adoption: 31', verlauf2.rahmen.length === 31, `war ${verlauf2.rahmen.length}`);

	const liste = await adapter.liste();
	pruefe('Liste kennt Segmente + Manifest', liste.some((n) => n.startsWith('seg-')) && liste.some((n) => n === 'manifest.puls'), JSON.stringify(liste));
}

async function testeS3(lauf: string): Promise<void> {
	console.log('\n== S3 / MinIO ==');
	const wirt = umgebung('ABLAGE_INT_S3_WIRT', 'http://127.0.0.1:9100');
	const eimer = umgebung('ABLAGE_INT_S3_EIMER', 'pulse-ablage-int');
	const region = umgebung('ABLAGE_INT_S3_REGION', 'us-east-1');
	const schluessel = umgebung('ABLAGE_INT_S3_SCHLUESSEL');
	const geheimnis = umgebung('ABLAGE_INT_S3_GEHEIMNIS');
	if (!schluessel || !geheimnis) {
		console.error('  ✖ S3-Zugang fehlt (ABLAGE_INT_S3_SCHLUESSEL/GEHEIMNIS setzen) — S3 übersprungen');
		fehlgeschlagen++;
		return;
	}

	// Bucket anlegen, falls es ihn nicht gibt (409 = existiert schon).
	const anbindung = { wirt: wirt!, region: region!, schluessel: schluessel!, geheimnis: geheimnis! };
	const bucketKopf = await signiereAnfrage(anbindung, 'PUT', `/${eimer!}`, {}, new Date(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', null);
	const bucketAntwort = await fetch(`${wirt!}/${eimer!}`, { method: 'PUT', headers: bucketKopf });
	pruefe('Bucket bereit', bucketAntwort.ok || bucketAntwort.status === 409, `HTTP ${bucketAntwort.status}`);

	const adapter = s3Adapter({
		wirt: wirt!,
		region: region!,
		eimer: eimer!,
		praefix: `int-${lauf}/`,
		schluessel: schluessel!,
		geheimnis: geheimnis!,
	});
	await rundeAufAdapter('S3: Schreiber/Leser/Nachzug', adapter, lauf);
}

async function testeWebdav(lauf: string): Promise<void> {
	const url = umgebung('ABLAGE_INT_DAV_URL', 'http://127.0.0.1:8888/remote.php/dav/files/admin');
	const benutzer = umgebung('ABLAGE_INT_DAV_BENUTZER', 'admin');
	const passwort = umgebung('ABLAGE_INT_DAV_PASSWORT', 'pulse-int-2026');
	if (!url) {
		console.error('  ✖ WebDAV-Adresse fehlt — WebDAV übersprungen');
		return;
	}
	const adapter = webdavAdapter({
		basis: url!,
		ordner: `Pulse/int-${lauf}/kanal`,
		benutzer: benutzer!,
		passwort: passwort!,
	});
	await rundeAufAdapter('WebDAV/Nextcloud: Schreiber/Leser/Nachzug', adapter, lauf);
}

const lauf = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
try {
	await testeS3(lauf);
} catch (fehler) {
	fehlgeschlagen++;
	console.error(`  ✖ S3-Katastrophe: ${fehler instanceof Error ? fehler.message : fehler}`);
}
try {
	await testeWebdav(lauf);
} catch (fehler) {
	fehlgeschlagen++;
	console.error(`  ✖ WebDAV-Katastrophe: ${fehler instanceof Error ? fehler.message : fehler}`);
}
console.log(fehlgeschlagen === 0 ? '\nALLE INTEGRATIONSPRÜFUNGEN GRÜN' : `\n${fehlgeschlagen} PRÜFUNGEN ROT`);
process.exit(fehlgeschlagen === 0 ? 0 : 1);
